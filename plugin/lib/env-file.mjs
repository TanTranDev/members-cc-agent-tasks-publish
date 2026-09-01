// @ts-check
// Nạp `.env` và map `AGENT_TASKS_*` → khoá cấu hình.
//
// `.env` là nguồn cấu hình CHÍNH: một file, gitignore, chứa cả link GitLab lẫn token. Đổi lại
// sự tiện đó, file này phải giữ ba luật:
//
//   1. Parse không đoán bừa. Dòng không hiểu được thì BỎ QUA, không throw — .env do người gõ
//      tay, một dòng lỗi không được làm sập cả server MCP.
//   2. Ép kiểu tường minh. `ttlSec` lọt vào dưới dạng string "900" sẽ làm mọi phép tính TTL
//      sai LẶNG LẼ; số rác thì giữ giá trị cũ + cảnh báo, không bao giờ để thành NaN.
//   3. Biến rỗng = KHÔNG khai. `.env.example` có nhiều dòng để trống; chúng không được biến
//      thành host rỗng rồi báo "đã cấu hình".
//
// Không dùng thư viện dotenv: thêm một dependency chỉ để đọc `key=value` là không đáng, và
// dotenv có vài hành vi (expand biến, override ngầm) mà ở đây ta KHÔNG muốn.

import fs from 'node:fs';

/**
 * Bảng map biến môi trường → khoá cấu hình.
 *
 * `path` khai chỗ đặt trong config; có hai phần tử ⇒ khoá lồng (vd `ingest.brief`).
 * @type {Record<string, {key: string, path: string[], type: 'string'|'int'|'bool'}>}
 */
export const ENV_MAP = Object.freeze({
  AGENT_TASKS_ENABLED: { key: 'enabled', path: ['enabled'], type: 'bool' },
  AGENT_TASKS_GITLAB_HOST: { key: 'gitlabHost', path: ['gitlabHost'], type: 'string' },
  AGENT_TASKS_PROJECT_PATH: { key: 'projectPath', path: ['projectPath'], type: 'string' },
  AGENT_TASKS_CLAIM_REPO_URL: { key: 'claimRepoUrl', path: ['claimRepoUrl'], type: 'string' },
  AGENT_TASKS_PROJECT_KEY: { key: 'projectKey', path: ['projectKey'], type: 'string' },
  AGENT_TASKS_REF_NAMESPACE: { key: 'refNamespace', path: ['refNamespace'], type: 'string' },
  AGENT_TASKS_TTL_SEC: { key: 'ttlSec', path: ['ttlSec'], type: 'int' },
  AGENT_TASKS_HEARTBEAT_SEC: { key: 'heartbeatSec', path: ['heartbeatSec'], type: 'int' },
  AGENT_TASKS_SKEW_SEC: { key: 'skewSec', path: ['skewSec'], type: 'int' },
  AGENT_TASKS_GRACE_SEC: { key: 'graceSec', path: ['graceSec'], type: 'int' },
  AGENT_TASKS_PROGRESS_MIN_INTERVAL_SEC: {
    key: 'progressMinIntervalSec',
    path: ['progressMinIntervalSec'],
    type: 'int',
  },
  AGENT_TASKS_OFFLINE_POLICY: { key: 'offlinePolicy', path: ['offlinePolicy'], type: 'string' },
  AGENT_TASKS_INGEST_BRIEF: { key: 'ingest.brief', path: ['ingest', 'brief'], type: 'bool' },
  AGENT_TASKS_INGEST_SPEC: { key: 'ingest.spec', path: ['ingest', 'spec'], type: 'bool' },
  AGENT_TASKS_INGEST_CHANGELOG: {
    key: 'ingest.changelog',
    path: ['ingest', 'changelog'],
    type: 'bool',
  },
  AGENT_TASKS_INGEST_LEDGER: { key: 'ingest.ledger', path: ['ingest', 'ledger'], type: 'bool' },
  AGENT_TASKS_ATTACH_SPEC: { key: 'attach.spec', path: ['attach', 'spec'], type: 'bool' },
  AGENT_TASKS_ATTACH_LEDGER: { key: 'attach.ledger', path: ['attach', 'ledger'], type: 'bool' },
  AGENT_TASKS_ATTACH_HANDOFF: { key: 'attach.handoff', path: ['attach', 'handoff'], type: 'bool' },
  AGENT_TASKS_ATTACH_API_SPEC: { key: 'attach.apiSpec', path: ['attach', 'apiSpec'], type: 'bool' },
});

/** Tên biến chứa secret — dùng để quyết định có phải cảnh báo gitignore hay không. */
export const SECRET_KEYS = Object.freeze(['GITLAB_TOKEN', 'GITLAB_PRIVATE_TOKEN']);

/**
 * Giá trị NGUYÊN VĂN trong `.env.example`.
 *
 * `tasks-cli init` copy nguyên bản mẫu, nên ngay sau init mọi trường bắt buộc đều "có giá trị"
 * — và nếu không bắt ở đây thì `status` sẽ báo "✓ sẵn sàng" rồi cả hệ thống đi gọi
 * `https://git.example.inc`. Đó là lỗi câm tệ nhất của luồng cài đặt.
 *
 * So khớp CHÍNH XÁC, không dùng pattern kiểu /example/: domain thật của ai đó có thể chứa từ
 * "example", và đoán bừa thì chặn oan cấu hình đúng.
 *
 * ⚠️ Sửa `.env.example` thì phải sửa danh sách này. Test `.env.example không lệch khỏi
 * PLACEHOLDER_VALUES` canh đúng chuyện đó.
 */
export const PLACEHOLDER_VALUES = Object.freeze([
  'https://git.example.inc',
  'grp/agent-backlog',
  'git@git.example.inc:grp/agent-claims.git',
  'glpat-xxxxxxxxxxxxxxxxxxxx',
]);

/**
 * Giá trị này có còn là mẫu chưa điền?
 * @param {unknown} value
 */
export function isPlaceholder(value) {
  return typeof value === 'string' && PLACEHOLDER_VALUES.includes(value.trim());
}

/**
 * Parse nội dung một file `.env`.
 *
 * Cố ý KHÔNG hỗ trợ: nội suy `${VAR}`, value nhiều dòng. Cả hai đều làm token khó debug khi
 * sai, mà không giải quyết vấn đề gì ở đây.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const out = {};

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue; // không có `=`, hoặc `=value` thiếu key

    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();

    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      // Có nháy ⇒ nội dung bên trong là nguyên văn, kể cả dấu #.
      value = value.slice(1, -1);
    } else {
      // Không nháy ⇒ ` #` trở đi là comment cuối dòng.
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }

    out[key] = value;
  }

  return out;
}

/**
 * Đọc file `.env` từ đĩa.
 * @returns {{ok: true, values: Record<string,string>} | {ok: false, error: string} | null} null = không tồn tại
 */
export function readEnvFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    if (e.code === 'ENOENT') return null;
    return { ok: false, error: `không đọc được (${e.message})` };
  }
  return { ok: true, values: parseEnvFile(raw) };
}

/** @param {string} v */
function toBool(v) {
  const s = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return null;
}

/**
 * Áp mọi biến `AGENT_TASKS_*` có mặt trong `env` lên một object cấu hình.
 *
 * Trả về object MỚI — không đột biến `base`, vì `loadConfig` còn dùng `base` để so sánh tầng.
 *
 * @param {Record<string, any>} base
 * @param {Record<string, string|undefined>} env
 * @returns {{config: Record<string, any>, applied: string[], warnings: string[]}}
 */
export function applyEnvOverrides(base, env) {
  const config = { ...base };
  if (base && typeof base.ingest === 'object' && base.ingest) config.ingest = { ...base.ingest };
  if (base && typeof base.attach === 'object' && base.attach) config.attach = { ...base.attach };

  /** @type {string[]} */
  const applied = [];
  /** @type {string[]} */
  const warnings = [];

  for (const [envName, spec] of Object.entries(ENV_MAP)) {
    const raw = env[envName];
    if (raw === undefined || raw === null) continue;
    // Rỗng = chưa điền (dòng để trống trong .env.example). Không phải "đặt về rỗng".
    if (String(raw).trim() === '') continue;

    let value = /** @type {any} */ (String(raw).trim());

    if (spec.type === 'int') {
      const n = Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        warnings.push(
          `${envName}="${value}" không phải số nguyên ≥ 0 — ĐÃ BỎ QUA, giữ giá trị cũ ` +
            `(${spec.key}=${getPath(base, spec.path)}). Sửa lại trong .env rồi chạy lại.`,
        );
        continue;
      }
      value = n;
    } else if (spec.type === 'bool') {
      const b = toBool(value);
      if (b === null) {
        warnings.push(
          `${envName}="${value}" không phải true/false — ĐÃ BỎ QUA, giữ giá trị cũ ` +
            `(${spec.key}=${getPath(base, spec.path)}). Dùng true hoặc false.`,
        );
        continue;
      }
      value = b;
    }

    setPath(config, spec.path, value);
    applied.push(spec.key);
  }

  return { config, applied, warnings };
}

/** @param {Record<string, any>} obj @param {string[]} p */
function getPath(obj, p) {
  let cur = obj;
  for (const seg of p) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** @param {Record<string, any>} obj @param {string[]} p @param {any} value */
function setPath(obj, p, value) {
  let cur = obj;
  for (let i = 0; i < p.length - 1; i++) {
    const seg = p[i];
    if (cur[seg] === null || typeof cur[seg] !== 'object') cur[seg] = {};
    cur = cur[seg];
  }
  cur[p[p.length - 1]] = value;
}
