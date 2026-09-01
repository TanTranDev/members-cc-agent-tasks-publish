// @ts-check
// Đọc ledger `docs/wip/<lô>/verify.md` thành khối bằng chứng gắn được vào work item.
//
// Vì sao đọc file thay vì để agent gõ: gõ tay là nguồn của hai lỗi kinh niên — chép sai số, và
// chụp HEAD/DIRTY sai thứ tự (trước khi tree ngừng đổi) làm ledger tự vỡ ở vai đến sau.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Các mục ledger bắt buộc.
 *
 * Ba mục này là hợp đồng với quy trình gọi tool, không phải sở thích định dạng: `RISK (khai)` là
 * lời khai rủi ro, `SPEC` nói hành vi quan sát được có đổi hay không, `SPAWN` ghi đã giao cho vai
 * nào. Thiếu mục nào thì `task_attach_docs` trả về ở `ledger_missing[]` — NHẮC, không chặn.
 */
const REQUIRED_SECTIONS = ['RISK (khai)', 'SPEC', 'SPAWN'];

/** Tìm verify.md mới nhất trong docs/wip/. */
export function findLatestLedger(root) {
  const wip = path.join(root, 'docs', 'wip');
  if (!fs.existsSync(wip)) return null;

  const candidates = [];
  for (const d of fs.readdirSync(wip)) {
    const f = path.join(wip, d, 'verify.md');
    if (fs.existsSync(f)) candidates.push({ file: f, mtime: fs.statSync(f).mtimeMs });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].file;
}

/**
 * Bóc phần máy-đọc của ledger.
 * @returns {{ok: true, head: string|null, dirty: string|null, commands: object[],
 *            gateStatus: string, missing: string[], markdown: string}
 *          | {ok: false, message: string}}
 */
export function parseLedger(text, sourcePath = '') {
  const head = text.match(/^HEAD:\s*([0-9a-f]{7,40})/m)?.[1] ?? null;
  const dirty = text.match(/^DIRTY:\s*([0-9a-f]{7,40})/m)?.[1] ?? null;

  /** @type {{cmd: string, exit: number}[]} */ const commands = [];
  for (const m of text.matchAll(/^-\s+(.+?)\s+→\s+exit\s+(\d+)/gm)) {
    commands.push({ cmd: m[1].trim(), exit: Number(m[2]) });
  }

  const missing = REQUIRED_SECTIONS.filter((s) => !text.includes(s));
  if (!head && !dirty && commands.length === 0) {
    return {
      ok: false,
      message:
        `Không tìm thấy phần máy-đọc trong ledger${sourcePath ? ` (${sourcePath})` : ''}. ` +
        `Cần ít nhất một dòng HEAD:/DIRTY: hoặc một dòng "- <lệnh> → exit <n>". ` +
        `Chạy gate rồi ghi ledger trước khi đính bằng chứng.`,
    };
  }

  const gateStatus =
    commands.length === 0 ? 'pending' : commands.every((c) => c.exit === 0) ? 'green' : 'red';

  const markdown =
    `### 🔬 Bằng chứng gate\n\n` +
    `- HEAD: \`${head ?? '(không có)'}\`\n` +
    `- DIRTY: \`${dirty ?? '(không có)'}\`\n\n` +
    (commands.length
      ? commands.map((c) => `- \`${c.cmd}\` → exit ${c.exit}${c.exit === 0 ? ' ✅' : ' ❌'}`).join('\n')
      : '_không có lệnh gate nào được ghi_') +
    (missing.length ? `\n\n⚠️ Ledger thiếu mục: ${missing.join(', ')}` : '') +
    (sourcePath ? `\n\n_nguồn: ${sourcePath}_` : '');

  return { ok: true, head, dirty, commands, gateStatus, missing, markdown };
}

/** Bọc thành dependency cho tool layer. */
export function createEvidenceReader(root) {
  return {
    read(ledgerPath) {
      const file = ledgerPath ? path.resolve(root, ledgerPath) : findLatestLedger(root);
      if (!file) {
        return {
          ok: false,
          message:
            `Không tìm thấy ledger nào trong ${path.join(root, 'docs/wip')}. ` +
            `Chạy gate và ghi verify.md trước, hoặc truyền ledger_path tường minh.`,
        };
      }
      if (!fs.existsSync(file)) {
        return { ok: false, message: `Không có file ${file}. Kiểm lại đường dẫn.` };
      }
      return parseLedger(fs.readFileSync(file, 'utf8'), path.relative(root, file));
    },
  };
}

/** Chống spam comment: một item chỉ được ghi tiến độ mỗi `minIntervalSec`. */
export function createRateLimiter(minIntervalSec) {
  const last = new Map();
  return {
    check(key, nowMs) {
      const prev = last.get(key);
      if (prev === undefined) return { allowed: true };
      const sinceSec = (nowMs - prev) / 1000;
      return sinceSec >= minIntervalSec
        ? { allowed: true }
        : { allowed: false, sinceSec, minIntervalSec };
    },
    mark(key, nowMs) { last.set(key, nowMs); },
  };
}
