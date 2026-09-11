// @ts-check
// Cấu hình nhiều tầng, dưới đè lên trên:
//
//   DEFAULTS
//     ← ~/.agent-tasks/config.json        (CẤP MÁY — bản cũ; v0.3 chỉ còn nên giữ token ở ~/.agent-tasks/.env)
//     ← .claude/agent-tasks.config.json   (bản cũ, vẫn đọc — nhưng .claude/ hay là symlink dùng chung)
//     ← agent-tasks.config.json Ở ROOT    ★ v0.3: CẤU HÌNH CỦA DỰ ÁN, commit được, cả team dùng chung.
//                                          Khoá chính: boardUrl (project GitLab chứa issue board),
//                                          claimRepoUrl, ttl. KHÔNG token.
//     ← <git-dir>/agent-tasks-local.json  (tuỳ chọn, không commit — override một clone)
//     ← ~/.agent-tasks/.env               (CẤP MÁY — GITLAB_TOKEN dùng chung)
//     ← .env ở root dự án                 (tuỳ chọn — override một dự án)
//     ← <git-dir>/agent-tasks.env         (tuỳ chọn — override + token của RIÊNG clone này)
//     ← biến môi trường thật              (cao nhất — để override tạm một lệnh)
//          ↓
//     DERIVE từ git remote — điền khoá CÒN TRỐNG sau khi đã áp hết các tầng trên
//
// ★ v0.3 (docs/11 §C5): cấu hình SỐNG TRONG REPO — `agent-tasks.config.json` ở root, commit được.
// Vì sao không để ở cấp máy: mỗi người cài lại phải khai lại, và hai máy lệch nhau là lệch im lặng
// (claim ở hai claim-repo khác nhau = hết chống trùng). File trong repo thì cả team đọc CÙNG một
// bản. Token là thứ duy nhất KHÔNG vào repo — nó ở `~/.agent-tasks/.env` hoặc `<git-dir>/agent-tasks.env`.
//
// `boardUrl` là cách khai "board nằm ở project nào" bằng MỘT URL người copy từ trình duyệt
// (`https://git.x/grp/backlog`). Nó suy ra `gitlabHost` + `projectPath`; khai hai khoá kia tường
// minh vẫn thắng. Không khai gì ⇒ vẫn đọc từ git remote như trước (fallback, không phải mặc định
// được khuyến khích: board thường KHÔNG nằm ở repo code).
//
// ⚠️ Derive là FALLBACK CUỐI, KHÔNG phải một tầng. Đặt nó vào bất kỳ vị trí nào trong chuỗi tầng
// cũng sai một chiều: trước tầng dự án thì cấp máy không override được; sau thì nó đè cả khai
// tường minh. Ngữ nghĩa đúng là "không ai khai thì đọc từ remote".
//
// Ba luật cứng của file này:
//   1. TOKEN không bao giờ đến từ file ĐƯỢC COMMIT. `.env` là ngoại lệ hợp lệ vì nó gitignore —
//      và ta KIỂM chuyện đó: `.env` có token mà không được gitignore ⇒ cảnh báo to.
//      Token trong hai file JSON thì vẫn bị loại bỏ + cảnh báo như trước.
//      (docs/02 §5.3 — gần nửa MCP server production để secret trong file không mã hoá)
//   2. Không im lặng. Thiếu tiền đề nào cũng phải nói ra thiếu gì + sửa thế nào.
//      Không có đường "bỏ qua trong im lặng": mọi lượt nhường đường phải kèm lý do đọc được.
//   3. Fail-closed. File hỏng ⇒ coi như CHƯA cấu hình, không chạy tiếp với cấu hình nửa vời.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readEnvFile, applyEnvOverrides, ENV_MAP, SECRET_KEYS, isPlaceholder } from './env-file.mjs';
import { readRemote, parseRemoteUrl } from './git-remote.mjs';

/** Giá trị mặc định. Số TTL/heartbeat lấy từ docs/05 §6. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  gitlabHost: null,
  projectPath: null,
  /** v0.3: URL project GitLab chứa issue board. Suy ra gitlabHost + projectPath khi hai khoá đó trống. */
  boardUrl: null,
  claimRepoUrl: null,
  /** "auto" ⇒ derive từ projectPath. Hoặc một chuỗi tường minh. */
  projectKey: 'auto',
  refNamespace: 'refs/claims',
  ttlSec: 1800,
  heartbeatSec: 600,
  skewSec: 60,
  graceSec: 120,
  /** Bao lâu mới cho ghi tiến độ lên cùng một item (chống spam comment). */
  progressMinIntervalSec: 300,
  /** acquire khi không với tới claim-repo: fail-closed = KHÔNG claim. */
  offlinePolicy: 'fail-closed',
  /** Nguồn nào được đưa lên GitLab. ledger tắt mặc định (chứa đường dẫn local). */
  ingest: { brief: true, spec: true, changelog: true, ledger: false },
  /**
   * Nguồn nào được ĐÍNH vào work item khi xong task.
   * Tách khỏi `ingest` để hai luồng không kéo nhau: tắt ingest brief không có nghĩa là tắt
   * đính ledger.
   */
  attach: { spec: true, ledger: true, handoff: true, apiSpec: true },
  /** Điền bởi `tasks-cli probe`. null = chưa dò. */
  capabilities: null,
});

const PROJECT_REL = path.join('.claude', 'agent-tasks.config.json');
/** v0.3: file cấu hình CHÍNH của dự án, ở root repo, commit được. */
export const REPO_CONFIG_BASENAME = 'agent-tasks.config.json';
const LOCAL_BASENAME = 'agent-tasks-local.json';
const ENV_BASENAME = '.env';

/**
 * `.env` của RIÊNG một clone, đặt trong `<git-dir>/`.
 *
 * Vì sao không dùng `.env` ở root dự án cho việc này:
 *   • `.env` root thường đã là của ỨNG DỤNG (Flutter/Node/…) với hàng chục dòng không liên quan.
 *     Trộn token của agent-tasks vào đó là ép hai vòng đời khác nhau dùng chung một file.
 *   • `.env` root chỉ an toàn khi được gitignore — phải KIỂM (envIsGitignored). File trong
 *     `<git-dir>/` thì git không có đường nào track, nên an toàn theo cấu trúc chứ không nhờ
 *     kỷ luật của người dùng.
 *
 * Vì sao không dùng `.claude/agent-tasks.config.json`: `.claude/` rất hay là SYMLINK dùng chung
 * giữa nhiều dự án (một bộ agent/hook/settings cho cả nhóm repo). Đặt `projectPath` ở đó thì N
 * dự án đọc chung một giá trị và work item bay nhầm backlog. Xem cảnh báo `claudeDirIsShared`.
 */
export const CLONE_ENV_BASENAME = 'agent-tasks.env';
/** Thư mục cấu hình cấp máy — chứa thứ dùng chung cho mọi dự án. */
const MACHINE_DIRNAME = '.agent-tasks';

/**
 * Thư mục cấu hình cấp máy.
 *
 * `AGENT_TASKS_HOME` là BẮT BUỘC phải hỗ trợ, không phải tiện lợi: thiếu nó thì test đọc — và có
 * thể ghi vào — `~/.agent-tasks/` thật của người chạy test, nên kết quả khác nhau giữa hai máy và
 * một lần `setup` trong test có thể phá cấu hình thật của họ.
 */
export function machineDir(env) {
  const home = env?.AGENT_TASKS_HOME || os.homedir();
  return path.join(home, MACHINE_DIRNAME);
}

/** Khoá suy được từ git remote. Thứ tự không quan trọng, nhưng tập thì có. */
const DERIVABLE = Object.freeze(['gitlabHost', 'projectPath']);

/**
 * Hostname để SO SÁNH hai địa chỉ (bỏ scheme, đường dẫn, và **port**).
 *
 * ⚠️ Bỏ port là bắt buộc, không phải làm cho gọn. Remote SSH cho host không port (`git.inc`), còn
 * `gitlabHost` có thể có port (`https://git.inc:8443`) — cùng một máy. So cả port thì mọi instance
 * chạy port lạ đều bị cảnh báo "host lệch" sai. Cảnh báo đó dành cho ca hai host THẬT SỰ khác nhau
 * (github.com vs git.inc), và một cảnh báo sai thường xuyên sẽ bị bỏ qua cả khi nó đúng.
 *
 * Chỉ dùng để so sánh — `gitlabHost` thật vẫn giữ port vì API cần nó.
 */
function hostOf(urlish) {
  return String(urlish ?? '')
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .toLowerCase();
}
/** Trường bắt buộc để coi là "đã cấu hình". */
const REQUIRED = ['gitlabHost', 'projectPath', 'claimRepoUrl'];

/**
 * `.env` có được .gitignore che không?
 *
 * Kiểm bằng cách đọc `.gitignore` chứ không gọi `git check-ignore`: hàm này chạy trong đường
 * nạp cấu hình của MCP server, không được spawn tiến trình con. Chỉ khớp mẫu thẳng — đủ để bắt
 * lỗi thật (quên hẳn dòng `.env`), và khi không chắc thì trả `true` để KHÔNG cảnh báo sai.
 *
 * @param {string} root
 * @returns {boolean}
 */
function envIsGitignored(root) {
  for (const name of ['.gitignore', path.join('.git', 'info', 'exclude')]) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(root, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const p = line.trim();
      if (!p || p.startsWith('#')) continue;
      // Cố ý KHÔNG nhận `.env.*` — mẫu đó che `.env.local` nhưng KHÔNG che `.env`.
      if (['.env', '.env*', '*.env', '/.env'].includes(p)) return true;
    }
  }
  return false;
}

/**
 * `.claude/` của repo này có phải symlink dùng chung với dự án khác không?
 *
 * Ca thật gặp phải: nhiều repo cùng trỏ `.claude` sang một thư mục chung để dùng chung
 * agent/hook/settings. Tiện cho những thứ KHÔNG phụ thuộc repo — nhưng
 * `.claude/agent-tasks.config.json` thì phụ thuộc, và hậu quả im lặng: N dự án đọc chung một
 * `projectPath`, work item ghi nhầm backlog, claim ghi nhầm `projectKey`.
 *
 * Chỉ gọi khi file cấu hình dự án THẬT SỰ được nạp — không ai đặt file thì không có gì để cảnh báo.
 * Không bao giờ throw: đây là đường nạp cấu hình của MCP server.
 *
 * @param {string} root
 * @returns {{shared: false} | {shared: true, target: string, others: string[]}}
 */
export function claudeDirIsShared(root) {
  const link = path.join(root, '.claude');
  let target;
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return { shared: false };
    target = fs.realpathSync(link);
  } catch {
    return { shared: false };
  }

  // Symlink trỏ vào trong chính repo là chuyện nội bộ của repo đó — không phải dùng chung.
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return { shared: false };
  }
  if (target === realRoot || target.startsWith(realRoot + path.sep)) return { shared: false };

  // Ai còn trỏ vào cùng chỗ? Quét ĐÚNG MỘT cấp thư mục anh em — đủ để bắt kiểu bố trí
  // `~/Desktop/nexa/<mỗi repo một thư mục>`, và không đi sâu để khỏi tốn I/O.
  /** @type {string[]} */
  const others = [];
  try {
    const parent = path.dirname(realRoot);
    for (const name of fs.readdirSync(parent)) {
      const sibling = path.join(parent, name);
      if (sibling === realRoot) continue;
      try {
        const sl = path.join(sibling, '.claude');
        if (!fs.lstatSync(sl).isSymbolicLink()) continue;
        if (fs.realpathSync(sl) === target) others.push(name);
      } catch {
        /* thư mục anh em không đọc được — bỏ qua, đây chỉ là phần liệt kê cho dễ hiểu */
      }
    }
  } catch {
    /* không đọc được thư mục cha: vẫn cảnh báo, chỉ là không kèm được danh sách */
  }

  return { shared: true, target, others };
}

/**
 * Đi ngược từ `start` lên tới thư mục chứa `.git`.
 * @returns {{root: string|null, gitDir: string|null}}
 */
export function findRepoRoot(start) {
  let dir;
  try {
    dir = fs.realpathSync(start);
  } catch {
    return { root: null, gitDir: null };
  }

  for (;;) {
    const dotGit = path.join(dir, '.git');
    let st = null;
    try {
      st = fs.lstatSync(dotGit);
    } catch {
      /* không có, đi tiếp lên trên */
    }

    if (st) {
      if (st.isDirectory()) return { root: dir, gitDir: dotGit };
      if (st.isFile()) {
        // worktree / submodule: `.git` là file chứa "gitdir: <đường dẫn>"
        const m = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
        if (m) {
          const g = m[1].trim();
          return { root: dir, gitDir: path.isAbsolute(g) ? g : path.resolve(dir, g) };
        }
        // File .git dị dạng — vẫn nhận root, nhưng không có gitDir để đặt file local.
        return { root: dir, gitDir: null };
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) return { root: null, gitDir: null };
    dir = parent;
  }
}

/**
 * Đọc một file JSON.
 * @returns {{ok: true, value: object} | {ok: false, error: string} | null} null = không tồn tại
 */
function readJsonFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null;
    return { ok: false, error: `không đọc được (${/** @type {Error} */ (err).message})` };
  }
  try {
    const value = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'nội dung không phải một object JSON' };
    }
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: `JSON không hợp lệ (${/** @type {Error} */ (err).message})` };
  }
}

/**
 * Giá trị trông như một placeholder CHƯA ĐƯỢC GIÃN: `${GITLAB_TOKEN}`, `$GITLAB_TOKEN`.
 *
 * ⚠️ Đo được trên máy thật (2026-08-13): manifest plugin khai
 * `env: { GITLAB_TOKEN: "${GITLAB_TOKEN}" }`, và khi shell KHÔNG có biến đó, Claude Code truyền
 * xuống **nguyên văn chuỗi `${GITLAB_TOKEN}`** — không phải chuỗi rỗng như từng giả định. Chuỗi
 * ấy không rỗng nên nó THẮNG token thật ở mọi tầng file, và mọi lời gọi GitLab trả 401.
 *
 * Triệu chứng cực kỳ khó lần: `status` báo "✓ sẵn sàng", CLI chạy tay thì tốt (shell không có
 * biến), chỉ tool gọi qua plugin mới 401.
 */
const ENV_PLACEHOLDER_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$|^\$[A-Za-z_][A-Za-z0-9_]*$/;

export function looksUnexpanded(value) {
  return ENV_PLACEHOLDER_RE.test(String(value ?? '').trim());
}

/**
 * Bỏ các khoá không có giá trị thật: undefined, null, chuỗi rỗng, hoặc placeholder chưa giãn.
 *
 * Chuỗi RỖNG phải bị coi là "chưa đặt", không phải "đặt về rỗng" — nếu rỗng được tính là đã đặt,
 * nó đè mất token thật trong `.env` và triệu chứng là "đặt token đúng rồi mà vẫn báo thiếu token".
 *
 * Placeholder chưa giãn cùng một lớp lỗi, nhưng tệ hơn: nó KHÔNG rỗng nên lọt qua mọi phép kiểm
 * "có giá trị chưa", đi thẳng tới GitLab và trả 401 (xem ENV_PLACEHOLDER_RE).
 *
 * @param {Record<string, string|undefined>} obj
 * @returns {Record<string, string>}
 */
function stripUndefined(obj) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v === undefined || v === null) continue;
    if (String(v).trim() === '') continue;
    if (looksUnexpanded(v)) continue;
    out[k] = String(v);
  }
  return out;
}

/**
 * Đổi tên trường cấu hình → tên BIẾN trong .env, để câu báo lỗi nói đúng thứ người ta phải gõ.
 * @param {string[]} keys
 */
function envNamesFor(keys) {
  return keys
    .map((k) => Object.keys(ENV_MAP).find((e) => ENV_MAP[e].key === k) ?? k)
    .join(', ');
}

/** Derive projectKey từ projectPath khi khai "auto". */
export function deriveProjectKey(projectPath) {
  if (!projectPath) return null;
  return String(projectPath)
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean)
    .join('-')
    .replace(/[^A-Za-z0-9._-]/g, '-');
}

/**
 * Nạp cấu hình đã merge.
 * @param {{cwd?: string, env?: Record<string, string|undefined>}} [opts]
 */
export function loadConfig(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  /** @type {string[]} */
  const warnings = [];
  /** @type {{layer: string, path: string|null, loaded: boolean}[]} */
  const sources = [{ layer: 'defaults', path: null, loaded: true }];

  const { root, gitDir } = findRepoRoot(cwd);
  if (!root) {
    warnings.push(
      `Không tìm thấy .git khi đi ngược từ ${cwd} — không xác định được root dự án. ` +
        `Chạy lại từ bên trong một git repo, hoặc truyền cwd đúng.`,
    );
  }

  /** @type {Record<string, any>} */
  let merged = { ...DEFAULTS, ingest: { ...DEFAULTS.ingest }, attach: { ...DEFAULTS.attach } };
  let hardFail = false;

  /** Áp một tầng lên `merged`. */
  const applyLayer = (layer, file) => {
    if (!file) {
      sources.push({ layer, path: null, loaded: false });
      return;
    }
    const res = readJsonFile(file);
    if (res === null) {
      sources.push({ layer, path: file, loaded: false });
      return;
    }
    if (!res.ok) {
      // Fail-closed + nêu đích danh file. Đây là chỗ dễ trở thành lỗi câm nhất.
      warnings.push(
        `Bỏ qua ${path.basename(file)}: ${res.error}. Đường dẫn: ${file}. ` +
          `Sửa file rồi chạy lại; trong lúc đó cấu hình coi như CHƯA hợp lệ.`,
      );
      sources.push({ layer, path: file, loaded: false });
      hardFail = true;
      return;
    }

    const value = { ...res.value };
    if ('token' in value || 'gitlabToken' in value || 'privateToken' in value) {
      warnings.push(
        `${path.basename(file)} có chứa token — ĐÃ BỎ QUA. Token chỉ được đọc từ biến môi ` +
          `trường GITLAB_TOKEN, không bao giờ từ file (file có thể bị commit). Hãy xoá nó khỏi ${file}.`,
      );
      delete value.token;
      delete value.gitlabToken;
      delete value.privateToken;
    }
    if (value.ingest && typeof value.ingest === 'object') {
      value.ingest = { ...merged.ingest, ...value.ingest };
    }
    if (value.attach && typeof value.attach === 'object') {
      value.attach = { ...merged.attach, ...value.attach };
    }
    merged = { ...merged, ...value };
    sources.push({ layer, path: file, loaded: true });
  };

  const mDir = machineDir(env);
  applyLayer('machine', path.join(mDir, 'config.json'));

  const projectFile = root ? path.join(root, PROJECT_REL) : null;
  applyLayer('project', projectFile);
  // Cảnh báo CHỈ khi file kia thật sự được nạp: `.claude` là symlink dùng chung thì tự nó không
  // sai, chỉ sai khi có người đặt cấu hình PHỤ THUỘC DỰ ÁN vào đó.
  if (projectFile && root && sources[sources.length - 1].loaded) {
    const shared = claudeDirIsShared(root);
    if (shared.shared) {
      warnings.push(
        `⚠️ ${PROJECT_REL} nằm trong một .claude/ DÙNG CHUNG (symlink → ${shared.target})` +
          (shared.others.length
            ? `, chia sẻ với: ${shared.others.join(', ')}`
            : '') +
          `. Mọi dự án dùng chung thư mục đó sẽ đọc CÙNG một projectPath ⇒ work item ghi nhầm ` +
          `backlog, claim nhầm projectKey. Chuyển các khoá phụ thuộc dự án sang ` +
          `<git-dir>/${CLONE_ENV_BASENAME} (chạy \`tasks-cli init --local\`).`,
      );
    }
  }

  // ★ v0.3 — tầng CỦA DỰ ÁN, thắng cấp máy và thắng `.claude/`. Đây là file tài liệu hướng người
  // dùng tới; hai tầng trên chỉ còn để không vỡ bản cũ.
  applyLayer('repo', root ? path.join(root, REPO_CONFIG_BASENAME) : null);

  applyLayer('local', gitDir ? path.join(gitDir, LOCAL_BASENAME) : null);

  /**
   * Nạp một tầng `.env`. Ba tầng dùng chung đúng một luật đọc + một luật fail-closed; chúng chỉ
   * khác nhau ở phép KIỂM AN TOÀN sau khi đọc, nên phần đó truyền vào qua `onLoaded`.
   *
   * @param {string} layer
   * @param {string|null} file
   * @param {(values: Record<string, string>) => void} [onLoaded]
   * @returns {Record<string, string>}
   */
  const loadEnvLayer = (layer, file, onLoaded) => {
    if (!file) {
      sources.push({ layer, path: null, loaded: false });
      return {};
    }
    const res = readEnvFile(file);
    if (res === null) {
      sources.push({ layer, path: file, loaded: false });
      return {};
    }
    if (!res.ok) {
      warnings.push(
        `Bỏ qua ${path.basename(file)}: ${res.error}. Đường dẫn: ${file}. ` +
          `Sửa quyền đọc rồi chạy lại; trong lúc đó cấu hình coi như CHƯA hợp lệ.`,
      );
      sources.push({ layer, path: file, loaded: false });
      hardFail = true;
      return {};
    }
    sources.push({ layer, path: file, loaded: true });

    // ⚠️ BỎ khoá có giá trị rỗng, đúng luật 3 của env-file.mjs ("biến rỗng = KHÔNG khai").
    // Không strip thì một dòng `GITLAB_TOKEN=` để trống — thứ mà `init` sinh ra để người dùng
    // điền vào — sẽ ĐÈ CHẾT token của tầng dưới, và triệu chứng là "chưa có GITLAB_TOKEN" ngay
    // sau khi vừa cấu hình xong. Luật này đã áp cho biến shell (xem stripUndefined) nhưng trước
    // đây quên áp cho tầng file.
    const values = stripUndefined(res.values);
    onLoaded?.(values);
    return values;
  };

  /** File chứa token mà quyền rộng ⇒ người dùng khác trên máy đọc được. */
  const warnIfLooseMode = (file, values) => {
    if (!SECRET_KEYS.some((k) => values[k])) return;
    let mode = null;
    try {
      mode = fs.statSync(file).mode & 0o777;
    } catch {
      /* đọc được nội dung mà không stat được là ca lạ — bỏ qua phần kiểm quyền */
    }
    if (mode !== null && (mode & 0o077) !== 0) {
      warnings.push(
        `⚠️ ${file} có chứa token nhưng quyền là ${mode.toString(8)} — người dùng khác ` +
          `trên máy đọc được. Sửa: chmod 600 ${file}`,
      );
    }
  };

  // ── Tầng .env CẤP MÁY ────────────────────────────────────────────────────
  // Token dùng chung cho mọi dự án, khai một lần. `.env` của dự án thắng nó (M5).
  const machineEnvFile = path.join(mDir, ENV_BASENAME);
  const fromMachineEnv = loadEnvLayer('machine-env', machineEnvFile, (values) =>
    // File này nằm trong HOME — quyền rộng là cả máy đọc được.
    warnIfLooseMode(machineEnvFile, values),
  );

  // ── Tầng .env của DỰ ÁN ──────────────────────────────────────────────────
  // Biến môi trường THẬT thắng file (quy ước dotenv): file là cấu hình thường trực, shell là
  // override tạm cho một lệnh. Đảo lại thì không ai override được bằng dòng lệnh.
  const envFile = root ? path.join(root, ENV_BASENAME) : null;
  const fromEnvFile = loadEnvLayer('env', envFile, (values) => {
    // Token trong .env là HỢP LỆ — nhưng chỉ khi .env thật sự được gitignore.
    if (SECRET_KEYS.some((k) => values[k]) && root && !envIsGitignored(root)) {
      warnings.push(
        `⚠️ ${ENV_BASENAME} có chứa token NHƯNG không thấy nó trong .gitignore — nguy cơ commit ` +
          `secret lên GitLab. Thêm dòng \`.env\` vào .gitignore ngay. Đường dẫn: ${envFile}`,
      );
    }
  });

  // ── Tầng .env của RIÊNG CLONE ────────────────────────────────────────────
  // Thắng `.env` của dự án vì cụ thể hơn: một dự án có nhiều clone, và `.env` ở root thường là
  // file của ỨNG DỤNG mà cả team dùng chung nội dung. Đây là chỗ để "máy tôi, clone này" —
  // token riêng, backlog riêng, claim-repo riêng — mà không đụng vào file nào của dự án.
  //
  // Không kiểm gitignore: file nằm trong `<git-dir>/`, git không có đường nào track nó. An toàn
  // theo CẤU TRÚC, không nhờ kỷ luật người dùng — đó chính là lý do tầng này tồn tại.
  const cloneEnvFile = gitDir ? path.join(gitDir, CLONE_ENV_BASENAME) : null;
  const fromCloneEnv = loadEnvLayer('clone-env', cloneEnvFile, (values) =>
    warnIfLooseMode(/** @type {string} */ (cloneEnvFile), values),
  );

  /** env đã merge: cấp máy làm nền, .env dự án đè, .env clone đè tiếp, biến shell cao nhất. */
  const effectiveEnv = {
    ...fromMachineEnv,
    ...fromEnvFile,
    ...fromCloneEnv,
    ...stripUndefined(env),
  };

  const envApplied = applyEnvOverrides(merged, effectiveEnv);
  merged = envApplied.config;
  warnings.push(...envApplied.warnings);

  // ── boardUrl → gitlabHost + projectPath (v0.3) ─────────────────────────────
  // Một URL người copy từ trình duyệt, thay cho hai khoá phải gõ đúng. Chỉ điền khoá CÒN TRỐNG:
  // ai khai gitlabHost/projectPath tường minh thì vẫn thắng.
  if (merged.boardUrl) {
    // URL copy từ trình duyệt hay kèm đuôi `/-/boards/42`, `/-/issues`: `/-/` là ranh giới GitLab đặt
    // giữa project path và trang. Cắt ở đó, không thì projectPath mang rác và mọi lời gọi API 404.
    const cleaned = String(merged.boardUrl).replace(/\/-\/.*$/, '').replace(/[?#].*$/, '');
    const b = parseRemoteUrl(cleaned);
    if (!b) {
      warnings.push(
        `boardUrl "${merged.boardUrl}" không nhận dạng được — cần dạng https://<host>/<group>/<project>. ` +
          'Bỏ qua khoá này.',
      );
      hardFail = true;
    } else {
      const scheme = /^http:\/\//i.test(String(merged.boardUrl)) ? 'http' : 'https';
      /** @type {string[]} */ const filled = [];
      if (!merged.gitlabHost) {
        merged.gitlabHost = `${scheme}://${b.host}`;
        filled.push('gitlabHost');
      }
      if (!merged.projectPath) {
        merged.projectPath = b.projectPath;
        filled.push('projectPath');
      }
      sources.push({ layer: 'boardUrl', path: null, loaded: true, filled });
      // Khai cả boardUrl lẫn projectPath mà hai cái nói hai project khác nhau ⇒ nói ra: một trong hai
      // là thừa hoặc sai, và work item sẽ đi vào project mà người đọc file không ngờ tới.
      if (!filled.includes('projectPath') && merged.projectPath !== b.projectPath) {
        warnings.push(
          `⚠️ boardUrl trỏ tới "${b.projectPath}" nhưng projectPath khai là "${merged.projectPath}" — ` +
            'projectPath THẮNG. Bỏ một trong hai để khỏi lệch.',
        );
      }
    }
  }

  // ── DERIVE từ git remote — FALLBACK CUỐI, không phải một tầng ─────────────
  // Chỉ điền khoá CÒN TRỐNG sau khi đã áp hết mọi tầng, nên mọi khai tường minh đều thắng.
  const missingDerivable = DERIVABLE.filter((k) => !merged[k]);
  if (missingDerivable.length && gitDir) {
    const rem = readRemote({ gitDir, remoteName: merged.remoteName || undefined });
    if (rem.ok) {
      /** @type {string[]} */ const filled = [];
      // Scheme cho host suy từ remote: https. Instance chạy http thì khai gitlabHost tường minh —
      // derive chỉ điền chỗ trống nên khai là thắng.
      const derived = { gitlabHost: `https://${rem.host}`, projectPath: rem.projectPath };
      for (const k of missingDerivable) {
        merged[k] = derived[k];
        filled.push(k);
      }
      warnings.push(...rem.warnings);
      sources.push({
        layer: 'git-remote',
        path: path.join(gitDir, 'config'),
        loaded: true,
        filled,
        remote: rem.remote,
      });

      // ── Host lệch: chỉ cảnh báo được MỘT chiều, và đó là giới hạn thật ───
      //
      // Chiều BẮT ĐƯỢC — `projectPath` derive + `gitlabHost` khai tường minh: hai host so được với
      // nhau, khác nhau thì path của remote gần chắc chắn không tồn tại trên host đã khai (404,
      // trông như "sai project path").
      //
      // Chiều KHÔNG bắt được — `projectPath` khai + `gitlabHost` derive: rủi ro có thật và còn tệ
      // hơn (gọi API của host trong remote, vd github.com, với project path của một GitLab nội bộ),
      // nhưng **không có gì để so**: `gitlabHost` lúc đó CHÍNH LÀ host của remote, nên phép so luôn
      // bằng. Và cảnh báo vô điều kiện ở chiều này sẽ sai thường xuyên — "khai projectPath riêng,
      // để host tự suy" là ca HỢP LỆ và phổ biến (repo tắt Issues ⇒ backlog ở project khác cùng
      // GitLab). Dương tính giả thường xuyên thì sẽ bị bỏ qua cả khi nó đúng.
      // ⇒ Chỗ bắt đúng của chiều đó là `verify`: nó gọi API thật và 404/401 sẽ nói ra. `status` in
      //   rõ giá trị nào derive nên vẫn truy được nguyên nhân.
      if (filled.includes('projectPath') && !filled.includes('gitlabHost')) {
        const declared = hostOf(merged.gitlabHost);
        if (declared && declared !== hostOf(rem.host)) {
          warnings.push(
            `⚠️ HOST LỆCH: projectPath "${rem.projectPath}" suy từ remote "${rem.remote}" ở ` +
              `${rem.host}, nhưng gitlabHost đang khai là ${declared}. Project đó có thể không tồn ` +
              `tại trên ${declared}. Khai AGENT_TASKS_PROJECT_PATH tường minh nếu hai host khác nhau ` +
              `thật (vd code ở GitHub, work item ở GitLab).`,
          );
        }
      }
    } else {
      sources.push({ layer: 'git-remote', path: path.join(gitDir, 'config'), loaded: false, filled: [] });
      // Không derive được là lý do CHÍNH khiến một dự án chưa cấu hình xong ⇒ phải nói ra, kèm
      // đúng việc phải làm. Đây không phải lỗi nếu người ta đã khai tường minh.
      warnings.push(`Không suy được ${missingDerivable.join(', ')} từ git remote: ${rem.reason}`);
    }
  }

  if (merged.projectKey === 'auto') {
    merged.projectKey = deriveProjectKey(merged.projectPath);
  }

  let token = effectiveEnv.GITLAB_TOKEN || effectiveEnv.GITLAB_PRIVATE_TOKEN || null;
  if (isPlaceholder(token)) {
    // Token mẫu KHÔNG phải token. Nhận nó là sẽ đi gọi GitLab rồi ăn 401 khó hiểu.
    warnings.push(
      `GITLAB_TOKEN trong ${ENV_BASENAME} vẫn là giá trị mẫu ("${token}") — chưa phải token thật. ` +
        'Tạo Group Access Token (scope api) ở group chứa cả backlog và claim-repo, rồi dán vào.',
    );
    token = null;
  } else if (!token) {
    warnings.push(
      'Chưa có GITLAB_TOKEN — mọi thao tác chạm GitLab sẽ thất bại. Tạo Group Access Token ' +
        `(scope api) rồi đặt \`GITLAB_TOKEN=…\` vào ${machineEnvFile} (dùng chung cả máy: ` +
        `\`tasks-cli setup\`), hoặc vào ${CLONE_ENV_BASENAME} của riêng clone này ` +
        `(\`tasks-cli init --local\`).`,
    );
  }

  // R6 — biến shell đè MỌI dự án. Không đảo quy ước dotenv (shell là đường override tạm một lệnh),
  // nhưng phải nói ra: một `export GITLAB_TOKEN=` cho dự án A sẽ làm dự án B dùng sai token, và
  // triệu chứng là 401 gần như không truy được về nguyên nhân này.
  // ⚠️ KHÔNG in giá trị token ở bất kỳ nhánh nào dưới đây.
  // Bỏ qua trong im lặng là fail-safe, nhưng người dùng vẫn phải biết để sửa manifest — nếu không
  // họ sẽ tưởng token cấp máy đang được dùng vì "may mà nó chạy", rồi lại vấp ở máy khác.
  for (const k of SECRET_KEYS) {
    if (looksUnexpanded(env?.[k])) {
      warnings.push(
        `⚠️ ${k} nhận được nguyên văn "${env[k]}" — một placeholder CHƯA ĐƯỢC GIÃN, không phải ` +
          `token. ĐÃ BỎ QUA (nếu nhận, mọi lời gọi GitLab sẽ trả 401 trong khi status vẫn báo ` +
          `sẵn sàng). Nguồn thường gặp: manifest plugin khai env: { ${k}: "\${${k}}" }. Bỏ hẳn ` +
          `khối env đó đi — server tự đọc ${machineEnvFile}.`,
      );
    }
  }

  const shellToken = stripUndefined(env).GITLAB_TOKEN || stripUndefined(env).GITLAB_PRIVATE_TOKEN;
  const tokenOf = (o) => o.GITLAB_TOKEN || o.GITLAB_PRIVATE_TOKEN;
  // So với token của tầng FILE cao nhất đang có: đó mới là cái mà biến shell vừa đè mất.
  const fileToken = tokenOf(fromCloneEnv) || tokenOf(fromEnvFile) || tokenOf(fromMachineEnv);
  const fileTokenAt = tokenOf(fromCloneEnv)
    ? cloneEnvFile
    : tokenOf(fromEnvFile)
      ? envFile
      : machineEnvFile;
  if (shellToken && fileToken && shellToken !== fileToken) {
    warnings.push(
      `⚠️ GITLAB_TOKEN đang lấy từ BIẾN SHELL, khác token trong ${fileTokenAt}. Biến shell đè ` +
        `MỌI dự án trên máy — nếu bạn export nó cho một dự án khác thì dự án này đang dùng sai ` +
        `token. Bỏ export đi, hoặc đặt token riêng vào ${CLONE_ENV_BASENAME} của clone này.`,
    );
  }

  // Heartbeat phải kịp gia hạn trước khi TTL hết. Bằng hoặc lớn hơn ttl ⇒ claim CHẮC CHẮN chết
  // giữa lúc đang làm, và triệu chứng ("task tự nhiên mất") không hề chỉ về cấu hình.
  if (Number(merged.heartbeatSec) >= Number(merged.ttlSec)) {
    warnings.push(
      `heartbeatSec (${merged.heartbeatSec}s) >= ttlSec (${merged.ttlSec}s) — claim sẽ hết hạn ` +
        `TRƯỚC khi được gia hạn, agent mất việc giữa lúc đang làm. Đặt heartbeatSec ≈ ttlSec/3.`,
    );
  }

  const missing = REQUIRED.filter((k) => !merged[k]);
  /** Trường có giá trị, nhưng giá trị đó là mẫu copy từ .env.example. */
  const placeholders = REQUIRED.filter((k) => merged[k] && isPlaceholder(merged[k]));
  const disabled = merged.enabled === false;

  const configured =
    !hardFail && !disabled && missing.length === 0 && placeholders.length === 0 && Boolean(root);
  let reason = null;
  if (disabled) {
    reason =
      'agent-tasks đang bị tắt cho clone này (enabled=false). Bật lại bằng ' +
      '`AGENT_TASKS_ENABLED=true` trong .env.';
  } else if (hardFail) {
    reason = 'Có file cấu hình hỏng — xem warnings. Fail-closed: coi như chưa cấu hình.';
  } else if (!root) {
    reason = 'Không xác định được root dự án (không tìm thấy .git).';
  } else if (missing.length) {
    // Chia theo NƠI PHẢI SỬA, không chỉ theo tên trường. `claimRepoUrl` là thứ dùng chung cả máy
    // nên chỗ sửa là `tasks-cli setup`; còn `projectPath`/`gitlabHost` thì bình thường được suy từ
    // git remote, nên thiếu chúng nghĩa là derive trượt — chỉ sang warning để biết trượt vì sao.
    const MACHINE_KEYS = ['claimRepoUrl'];
    const needMachine = missing.filter((k) => MACHINE_KEYS.includes(k));
    const needProject = missing.filter((k) => !MACHINE_KEYS.includes(k));

    const parts = [`Thiếu ${missing.join(', ')} — chưa cấu hình.`];
    const repoFile = root ? path.join(root, REPO_CONFIG_BASENAME) : REPO_CONFIG_BASENAME;
    if (needMachine.length) {
      parts.push(
        `${needMachine.join(', ')} khai trong ${repoFile} (chạy \`tasks-cli init\` để sinh file; ` +
          `commit cho cả team). Bản cũ để ở ${path.join(mDir, 'config.json')} vẫn được đọc.`,
      );
    }
    if (needProject.length) {
      parts.push(
        `${needProject.join(', ')} suy từ \`boardUrl\` trong ${repoFile} (URL project GitLab chứa ` +
          `issue board), hoặc từ git remote của dự án — xem warnings để biết vì sao không suy được.`,
      );
    }
    parts.push('Trong lúc chưa cấu hình, mọi tool sẽ báo lỗi có hướng dẫn thay vì hoạt động sai.');
    reason = parts.join(' ');
  } else if (placeholders.length) {
    reason =
      `Cấu hình vẫn còn GIÁ TRỊ MẪU ở ${placeholders.join(', ')} — chưa điền giá trị thật. ` +
      `Sửa trong ${root ? path.join(root, REPO_CONFIG_BASENAME) : REPO_CONFIG_BASENAME} ` +
      `(hoặc biến ${envNamesFor(placeholders)}) thành giá trị GitLab của bạn. Đây là bản mẫu do ` +
      `\`tasks-cli init\`/\`setup\` sinh ra, không phải cấu hình.`;
  }

  delete merged.token;

  return {
    configured,
    reason,
    missing,
    /** Trường còn nguyên giá trị mẫu từ .env.example — `verify` in ra để chỉ chỗ phải sửa. */
    placeholders,
    warnings,
    sources,
    root,
    gitDir,
    token,
    config: merged,
    /** env đã merge (.env + shell) — runtime dùng để lấy identity. */
    env: effectiveEnv,
    /** Những khoá cấu hình đến từ tầng env — `status` in ra để truy vết. */
    envApplied: envApplied.applied,
  };
}
