// @ts-check
// Đồng bộ bản plugin ĐÃ CÀI với thư mục nguồn trong repo.
//
// ★ Vì sao cần cả một module cho việc này: hai nửa của plugin cập nhật theo HAI cơ chế khác nhau,
// và cái thứ hai im lặng.
//
//   • MCP server (`server.mjs`, `lib/`) chạy THẲNG từ repo — sửa xong chỉ cần restart Claude Code.
//   • Skill (`plugin/skills/*/SKILL.md`) được COPY vào
//     `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, và `claude plugin update` so
//     **VERSION** chứ không so nội dung. Version không đổi ⇒ lệnh báo "already at the latest
//     version" rồi KHÔNG làm gì. Đo được: sửa task-setup/SKILL.md, chạy update, cache vẫn giữ
//     nguyên bản cũ; bump 0.1.0 → 0.1.1 rồi update mới sinh thư mục cache mới.
//
// Nên luật ở đây là: bump version KHI VÀ CHỈ KHI nội dung skill thật sự khác bản trong cache.
// Bump vô điều kiện thì mỗi lần chạy lại đẻ thêm một thư mục cache; không bump thì sửa xong không
// có tác dụng. Cả hai đều hỏng theo kiểu khó thấy.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Tăng số cuối của một version dạng `x.y.z`. Không phải semver đầy đủ — chỉ cần đủ để cache đổi. */
export function bumpPatch(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? '').trim());
  if (!m) return null;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/**
 * Vân tay nội dung của một cây thư mục: đường dẫn tương đối + nội dung file, sắp xếp ổn định.
 *
 * Sắp xếp là bắt buộc: `readdirSync` không hứa thứ tự giữa các hệ tệp, nên thiếu `sort()` thì hai
 * cây GIỐNG HỆT nhau có thể ra hai hash khác nhau — và hệ quả là bump version mỗi lần chạy.
 *
 * @returns {string|null} null nếu thư mục không tồn tại
 */
export function hashTree(dir) {
  /** @type {string[]} */
  const parts = [];

  /** @param {string} cur */
  const walk = (cur) => {
    /** @type {fs.Dirent[]} */
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(cur, e.name);
      if (e.isDirectory()) {
        walk(abs);
      } else if (e.isFile()) {
        parts.push(path.relative(dir, abs));
        try {
          parts.push(fs.readFileSync(abs, 'utf8'));
        } catch {
          // File không đọc được vẫn phải đổi hash, nếu không nó bị coi như "y hệt bản cũ".
          parts.push('\0KHONG-DOC-DUOC');
        }
      }
    }
  };

  try {
    if (!fs.statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  walk(dir);
  return crypto.createHash('sha1').update(parts.join('\0')).digest('hex');
}

/**
 * Quyết định cần làm gì để bản đã cài khớp với repo.
 *
 * @param {{sourceDir: string, cacheDir: string|null, version: string}} o
 *   `sourceDir` — `plugin/` trong repo. `cacheDir` — thư mục bản đã cài, null nếu chưa cài.
 * @returns {{action: 'chua-cai'|'da-dong-bo'|'can-bump', nextVersion?: string, why: string}}
 */
export function planSync({ sourceDir, cacheDir, version }) {
  const src = hashTree(sourceDir);
  if (src === null) {
    return { action: 'chua-cai', why: `không đọc được thư mục nguồn ${sourceDir}` };
  }
  if (!cacheDir) {
    return { action: 'chua-cai', why: 'plugin chưa được cài trên máy này' };
  }

  const cached = hashTree(cacheDir);
  if (cached === null) {
    return {
      action: 'chua-cai',
      why: `bản đã cài khai ở ${cacheDir} nhưng thư mục đó không còn`,
    };
  }
  if (cached === src) {
    return { action: 'da-dong-bo', why: 'nội dung plugin trùng khớp bản đã cài' };
  }

  const next = bumpPatch(version);
  if (!next) {
    return {
      action: 'can-bump',
      why: `version "${version}" không phải dạng x.y.z — sửa tay trong plugin.json rồi chạy lại`,
    };
  }
  return { action: 'can-bump', nextVersion: next, why: 'nội dung plugin đã khác bản đã cài' };
}

/**
 * Các thư mục version CŨ nằm cạnh bản đang dùng — rác do chính việc bump sinh ra.
 *
 * Mỗi lần `plugin:sync` chạy là thêm một thư mục cache; không dọn thì sau vài chục lần sửa skill,
 * `~/.claude/plugins/cache/` phình ra toàn bản chết.
 *
 * ⚠️ Hai rào an toàn, vì hàm này dùng để XOÁ:
 *   1. chỉ nhận thư mục tên đúng dạng `x.y.z` — không đụng thứ gì khác lỡ nằm trong đó;
 *   2. gọi bên xoá phải tự kiểm đường dẫn nằm trong cache của Claude Code (xem bin/plugin-sync).
 *
 * @param {string} parentDir thư mục chứa các bản version
 * @param {string} keepVersion version đang dùng — KHÔNG bao giờ nằm trong kết quả
 * @returns {string[]} đường dẫn tuyệt đối các bản cũ
 */
export function staleVersionDirs(parentDir, keepVersion) {
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+$/.test(e.name) && e.name !== keepVersion)
    .map((e) => path.join(parentDir, e.name));
}

/**
 * Đọc bản ghi cài đặt của Claude Code để biết plugin đang nằm ở đâu.
 * Không có file / sai định dạng ⇒ trả null, KHÔNG ném: máy chưa cài plugin là ca hợp lệ.
 *
 * @returns {{installPath: string, version: string}|null}
 */
export function readInstalled(installedFile, pluginId) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(installedFile, 'utf8'));
  } catch {
    return null;
  }
  // Cấu trúc từng thay đổi giữa các bản Claude Code: có bản để phẳng ở gốc, có bản bọc trong
  // `plugins`. Dò cả hai thay vì khoá cứng một chỗ rồi im lặng trả "chưa cài".
  const table = raw?.plugins ?? raw;
  const entry = table?.[pluginId];
  const rec = Array.isArray(entry) ? entry[0] : entry;
  if (!rec?.installPath) return null;
  return { installPath: rec.installPath, version: rec.version ?? '?' };
}
