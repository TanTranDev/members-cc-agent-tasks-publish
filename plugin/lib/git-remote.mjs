// @ts-check
// Đọc remote GitLab từ `.git/config` để suy ra `gitlabHost` + `projectPath` (spec M2, M3).
//
// ⚠️ KHÔNG spawn `git`. Module này chạy trong đường nạp cấu hình của MCP server, và chỗ đó không
// được tạo tiến trình con — cùng lý do `envIsGitignored` trong config.mjs đọc `.gitignore` thay vì
// gọi `git check-ignore`. Đổi lại ta phải tự parse INI, nhưng chỉ cần đúng hai thứ:
// section `[remote "<tên>"]` và khoá `url`.
//
// ⚠️ LUẬT BẢO MẬT CỦA FILE NÀY: URL remote CÓ THỂ CHỨA TOKEN
// (`https://oauth2:glpat-xxx@host/grp/p.git` là cách clone bằng PAT). Phần userinfo phải bị bỏ
// NGAY khi parse và không bao giờ được đưa vào giá trị trả về, warning, hay message lỗi. Cùng luật
// với "token đi ở header, không bao giờ ở URL" của gitlab.mjs — URL lọt vào log là token lọt theo.

import fs from 'node:fs';
import path from 'node:path';

/** `git@host:grp/duan-a.git` — dạng SCP, KHÔNG parse được bằng `new URL()` vì không có scheme. */
const SCP_RE = /^(?:([^@/]+)@)?([^@/:]+):(?!\/)(.+)$/;

/**
 * Phần trước dấu `:` có trông như một hostname thật không?
 *
 * ⚠️ Cần vì dạng SCP quá rộng — `<gì đó>:<gì đó>` khớp cả hai ca KHÔNG phải remote GitLab:
 *
 *   • `C:\Users\ton\repo.git` — đường dẫn Windows, git coi là repo LOCAL. Không chặn thì suy ra
 *     `gitlabHost = https://C` và mọi lời gọi API đi vào một host tên "C".
 *   • `gl:grp/duan-a.git` — bí danh do `url."git@git.inc:".insteadOf = gl:` trong `~/.gitconfig`.
 *     Ta cố ý chỉ đọc `.git/config` nên KHÔNG thấy khai báo đó, và sẽ suy ra host "gl".
 *
 * Cả hai đều fail-closed tốt hơn là đoán: hostname thật gần như luôn có dấu `.` (FQDN), hoặc là
 * `localhost`, hoặc là IPv4. Không khớp thì trả null và để người ta khai tường minh.
 */
function looksLikeHost(h) {
  const s = String(h ?? '');
  if (s.length < 2) return false; // ổ đĩa Windows một ký tự
  return s.includes('.') || s.toLowerCase() === 'localhost';
}

/** Bỏ `.git` cuối và `/` đầu. Subgroup lồng nhau giữ nguyên — GitLab hỗ trợ. */
function normalizePath(raw) {
  const p = String(raw ?? '')
    .replace(/^\/+/, '')
    .replace(/\.git\/*$/, '')
    .replace(/\/+$/, '');
  return p || null;
}

/**
 * URL remote → `{host, projectPath}`.
 *
 * @param {string|null|undefined} url
 * @returns {{host: string, projectPath: string}|null} null = không nhận dạng được
 */
export function parseRemoteUrl(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return null;

  // ── Dạng có scheme: dùng URL parser, nhưng chỉ lấy host/pathname.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    const scheme = u.protocol.replace(':', '').toLowerCase();
    if (!['http', 'https', 'ssh', 'git'].includes(scheme)) return null;

    const projectPath = normalizePath(u.pathname);
    if (!projectPath) return null;

    // Port của SSH là port SSH, KHÔNG phải port API — giữ nó lại thì mọi lời gọi API đi vào cổng
    // ssh và ăn ECONNREFUSED, trông như "GitLab chết" chứ không như "cấu hình sai".
    // Port của HTTP/HTTPS thì đúng là port API, phải giữ.
    const keepPort = (scheme === 'http' || scheme === 'https') && u.port;
    // `u.hostname` KHÔNG chứa userinfo — đó là chỗ token nằm, và ta không đọc `u.username`/
    // `u.password` ở bất cứ đâu trong file này.
    const host = keepPort ? `${u.hostname}:${u.port}` : u.hostname;
    if (!host) return null;
    return { host, projectPath };
  }

  // ── Dạng SCP: `[user@]host:path`
  const m = raw.match(SCP_RE);
  if (!m) return null;
  const host = m[2];
  // Dạng SCP quá rộng nên phải kiểm host có thật là host — xem `looksLikeHost`.
  if (!looksLikeHost(host)) return null;
  const projectPath = normalizePath(m[3]);
  if (!host || !projectPath) return null;
  // m[1] là phần user (có thể là token khi ai đó dán PAT vào) — cố ý KHÔNG dùng.
  return { host, projectPath };
}

/**
 * Nơi chứa `config` thật.
 *
 * Trong worktree, `<gitDir>/config` KHÔNG có remote — remote nằm ở config của repo chính, và đường
 * tới đó ghi trong `<gitDir>/commondir`. Không theo commondir thì MỌI worktree đều báo "không có
 * remote", mà worktree là cách repo này khuyến khích làm việc (skill using-git-worktrees).
 *
 * @param {string} gitDir
 * @returns {string} thư mục chứa `config`
 */
function commonDirOf(gitDir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
  } catch {
    return gitDir; // không phải worktree — đường thường
  }
  if (!raw) return gitDir;
  return path.isAbsolute(raw) ? raw : path.resolve(gitDir, raw);
}

/**
 * Parse `.git/config` đủ để lấy `[remote "<tên>"] url`.
 *
 * @param {string} text
 * @returns {Record<string, string>} tên remote → url
 */
function parseRemotes(text) {
  /** @type {Record<string, string>} */ const out = {};
  /** @type {string|null} */ let current = null;

  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || s.startsWith(';')) continue;

    if (s.startsWith('[')) {
      // Chỉ nhận `[remote "tên"]`. Section khác (`[lfs]`, `[http]`) cũng có khoá `url` — nhận nhầm
      // là lấy URL của LFS làm địa chỉ project.
      const sec = s.match(/^\[remote\s+"([^"]+)"\]$/);
      current = sec ? sec[1] : null;
      continue;
    }

    if (!current) continue;
    const kv = s.match(/^url\s*=\s*(.+)$/i);
    if (kv) out[current] = kv[1].trim();
  }
  return out;
}

/**
 * Đọc remote của một repo.
 *
 * @param {{gitDir: string|null|undefined, remoteName?: string}} arg
 * @returns {{ok: true, host: string, projectPath: string, remote: string, warnings: string[]}
 *          | {ok: false, reason: string}}
 */
export function readRemote({ gitDir, remoteName } = /** @type {any} */ ({})) {
  if (!gitDir) {
    return {
      ok: false,
      reason:
        'Không xác định được thư mục .git nên không đọc được remote. Chạy lệnh từ bên trong một git ' +
        'repo, hoặc khai AGENT_TASKS_PROJECT_PATH tường minh.',
    };
  }

  const dir = commonDirOf(gitDir);
  const file = path.join(dir, 'config');

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    // Ba loại lỗi, ba message — gộp lại thì người đọc không biết đi sửa quyền hay đi tạo remote.
    if (code === 'ENOENT') {
      return {
        ok: false,
        reason:
          `Không có ${file} — thư mục .git chưa có file config. Kiểm lại đây có phải một git repo ` +
          `hoàn chỉnh, hoặc khai AGENT_TASKS_PROJECT_PATH tường minh.`,
      };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return {
        ok: false,
        reason:
          `Không đọc được ${file} (${code}) — thiếu quyền đọc. Sửa quyền file, hoặc khai ` +
          `AGENT_TASKS_PROJECT_PATH tường minh để khỏi cần đọc nó.`,
      };
    }
    return {
      ok: false,
      reason:
        `Không đọc được ${file} (${/** @type {Error} */ (err).message}). Khai ` +
        `AGENT_TASKS_PROJECT_PATH tường minh nếu không sửa được.`,
    };
  }

  const remotes = parseRemotes(text);
  const names = Object.keys(remotes);

  if (!names.length) {
    return {
      ok: false,
      reason:
        `Không tìm thấy remote nào trong ${file}. Repo này chưa có remote (hoặc file không đúng ` +
        `định dạng git-config). Thêm remote bằng \`git remote add origin <url>\`, hoặc khai ` +
        `AGENT_TASKS_PROJECT_PATH tường minh.`,
    };
  }

  /** @type {string[]} */ const warnings = [];
  /** @type {string} */ let pick;

  if (remoteName) {
    if (!remotes[remoteName]) {
      return {
        ok: false,
        reason:
          `Không có remote tên "${remoteName}" trong ${file} (đang có: ${names.join(', ')}). ` +
          `Sửa remoteName trong cấu hình, hoặc khai AGENT_TASKS_PROJECT_PATH tường minh.`,
      };
    }
    pick = remoteName;
  } else if (remotes.origin) {
    pick = 'origin';
  } else if (names.length === 1) {
    pick = names[0];
    warnings.push(
      `Không có remote "origin" — đã dùng remote "${pick}" để suy ra project. Đặt remoteName ` +
        `trong cấu hình nếu muốn dùng remote khác.`,
    );
  } else {
    // Đoán bừa ở đây là trỏ work item vào backlog của DỰ ÁN KHÁC. Fail-closed.
    return {
      ok: false,
      reason:
        `Có ${names.length} remote (${names.join(', ')}) nhưng không có "origin" — không đoán được ` +
        `dùng cái nào. Đặt remoteName trong cấu hình, hoặc khai AGENT_TASKS_PROJECT_PATH tường minh.`,
    };
  }

  const parsed = parseRemoteUrl(remotes[pick]);
  if (!parsed) {
    // ⚠️ KHÔNG in URL ra: nó có thể chứa token.
    return {
      ok: false,
      reason:
        `URL của remote "${pick}" không phải dạng nhận dạng được (cần SSH, HTTPS, hoặc ` +
        `git@host:path). Kiểm \`git remote -v\`, hoặc khai AGENT_TASKS_PROJECT_PATH tường minh.`,
    };
  }

  return { ok: true, host: parsed.host, projectPath: parsed.projectPath, remote: pick, warnings };
}
