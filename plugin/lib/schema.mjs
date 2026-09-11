// @ts-check
// Schema work item: nhãn, khối agent-meta, điều kiện chuyển trạng thái.
//
// GITLAB FREE: scoped label (`key::value` loại trừ lẫn nhau) là tính năng Premium. Trên Free
// `key::value` chỉ là một chuỗi thường và GitLab KHÔNG loại trừ gì — hai nhãn `status::backlog`
// và `status::working` sống chung được. Ta mô phỏng tính loại trừ ở tầng client
// (`exclusiveLabelUpdate`), và chấp nhận rằng đó là mô phỏng chứ không phải bảo đảm: quyền làm
// việc do claim ref quyết định, nhãn chỉ là mặt hiển thị (docs/04 §1).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// v0.3 — BỘ NHÃN 10, HUMAN-FIRST (docs/11 §C1). Đây là chỗ dễ bị "sửa lại cho đủ" nhất, nên lý
// do ghi ở đây.
//
// Luật phân tuyến: một nhãn tồn tại khi và chỉ khi nó là MỘT CỘT trên board, hoặc MỘT HÀNH ĐỘNG
// mà người nhìn thấy phải làm. Mọi thứ agent cần để định tuyến (shape, role, source, gate, observe)
// nằm trong `agent-meta`, không bao giờ ở cả hai chỗ ("không lưu trùng", docs/06 §2).
//
// Vì sao v0.2 (13 nhãn) vẫn chưa đủ: người quản lý board đọc `care::chat`, `gate::green`,
// `spec-changed`, `needs-advice` và phải DỊCH trong đầu — đó là từ vựng của quy trình, không phải
// của việc. `debt` thì gắn lên MỌI task có khai nợ, nên gần task nào cũng mang, mất nghĩa.
//
//   status::backlog         cột Backlog — chưa ai nhận
//   status::working         cột Working — đang có agent làm (ai làm: khối "Đang làm" trên item)
//   status::needs-you       cột Needs you — NGƯỜI phải làm gì đó: trả lời, quyết định, gỡ, sửa CI
//   status::in-review       cột In review — người QC theo khối "Cách kiểm" trên item
//   status::ready-to-merge  cột Ready to merge — QC đạt, người merge/rebase (hoặc bảo agent làm rồi đóng)
//   careful                 đọc kỹ trước khi duyệt: việc chạm thứ đắt (thay `care::chat`)
//   hotzone                 không chạy song song các item này (NGƯỜI gắn)
//   review::required        đòi bằng chứng review trước khi đóng (NGƯỜI gắn)
//   source-drifted          tài liệu nguồn đã đổi sau khi item được tạo (ingest gắn)
//   debt                    ITEM NÀY LÀ MỘT KHOẢN NỢ cần trả — gắn lên issue nợ do task_complete
//                           tạo ra, KHÔNG còn gắn lên task sinh nợ
//
// Bỏ ở v0.3, và vì sao:
//   gate::green|red   kết quả gate nằm trong khối "Kết quả" và `agent-meta.gate`; người QC đọc ở đó
//   needs-advice      trùng nghĩa với status::needs-you
//   spec-changed      recap đọc `meta.spec_delta`, không cần nhãn; người QC đọc khối "Kết quả"
//   care::chat        đổi tên `careful` — chữ "chặt" là từ vựng quy trình, không phải của việc
//
// ĐỌC ITEM CŨ: `parseLabels` ánh xạ nhãn v0.2 sang v0.3 (ready→backlog, claimed→working,
// blocked→needs-you, review→in-review, care::chat→careful) để mọi tool chạy được giữa lúc
// chuyển đổi. Dọn thật bằng `tasks-cli labels --migrate --apply`.
//
// META_VERSION cố ý GIỮ 1: các trường v0.3 (`qc`, `who`, `needs`, `gate`, `links.debt_issues`) là
// trường THÊM, mọi đường ghi đều `{...parsed.meta}` trước khi thêm ⇒ server cũ đọc item mới vẫn
// giữ nguyên trường nó không biết.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const META_VERSION = 1;

// ── Tập giá trị: NHÃN ────────────────────────────────────────────────────────────────────────

/** Năm cột của board, theo đúng thứ tự trái → phải. */
export const STATUS = ['backlog', 'working', 'needs-you', 'in-review', 'ready-to-merge'];

/** Tên cột hiện cho người — dùng khi in ra board/CLI. */
export const STATUS_HUMAN = Object.freeze({
  backlog: 'Backlog',
  working: 'Working',
  'needs-you': 'Needs you',
  'in-review': 'In review',
  'ready-to-merge': 'Ready to merge',
});

/** Giá trị status của v0.2 → v0.3. Chỉ dùng để ĐỌC item cũ và để `--migrate`. */
export const LEGACY_STATUS = Object.freeze({
  ready: 'backlog',
  claimed: 'working',
  blocked: 'needs-you',
  review: 'in-review',
});

/** Nhãn "việc chạm thứ đắt". Meta vẫn ghi `care: 'chat'`; chỉ TÊN NHÃN đổi cho người đọc. */
export const CAREFUL_LABEL = 'careful';
/** Tên cũ của `careful` — đọc được, không ghi nữa. */
const LEGACY_CAREFUL_LABEL = 'care::chat';

/** key → tập giá trị hợp lệ. Chỉ những key ở đây mới là nhãn "loại trừ". */
const SCOPED = { status: STATUS };

/**
 * Nhãn cờ độc lập — có thể cùng tồn tại, không loại trừ nhau.
 *
 * Cột "ai ghi" là phần bắt buộc phải biết: nhãn không ai ghi là nhãn chết.
 *
 *   careful          ← task_intake / ingest khi care = chat
 *   debt             ← task_complete, lên ISSUE NỢ mới tạo (không lên task gốc)
 *   source-drifted   ← ingest (WARN_DRIFT)
 *   hotzone          ← NGƯỜI
 *   review::required ← NGƯỜI, hoặc agent khi quyết định vào luồng review
 *
 * ⚠️ `review::required` mang `::` nhưng KHÔNG nằm trong SCOPED ⇒ `parseLabels` xếp nó vào `flags`.
 * Giữ tên vì đã dùng ngoài thực địa; đọc bằng `flags.includes('review::required')`.
 */
export const FLAGS = [CAREFUL_LABEL, 'debt', 'source-drifted', 'hotzone', 'review::required'];

// ── Tập giá trị: CHỈ TRONG META (không phải nhãn) ────────────────────────────────────────────
//
// Vẫn là enum được kiểm — chỉ là kiểm ở tầng input/meta chứ không sinh nhãn. `tool-defs.mjs`
// import từ đây thay vì tự khai lại: hai bản sao của một enum là cặp phải đồng bộ bằng tay.

export const SHAPE = ['lam-thang', 'chia-roi-lam', 'chot-roi-lam', 'chot-chia-roi-lam', 'spike'];
export const CARE = ['thuong', 'chat'];
export const ROLE = [
  'implementer', 'debugger', 'planner', 'code-reviewer', 'verifier',
  'changelog-writer', 'troubleshoot-writer', 'brief-writer', 'explorer', 'advisor',
];
export const SOURCE = ['brief', 'spec', 'changelog', 'manual', 'debt'];
export const GATE = ['pending', 'green', 'red'];
/** Chỉ còn để ĐỌC item cũ; v0.3 không nhận `observe` làm input nữa (thay bằng `qc`). */
export const OBSERVE = ['l0', 'l1-pending', 'l2', 'l3'];

/** Lý do một item nằm ở cột Needs you — để người (và Orchestrator) biết phải làm gì. */
export const NEEDS_KIND = ['question', 'decision', 'blocked', 'ci-failed', 'changes-requested'];

/**
 * Nhãn đã BỎ — dùng cho `tasks-cli labels --prune`.
 *
 * Liệt kê tường minh chứ không suy "mọi nhãn không nằm trong bộ mới": suy như thế thì `--prune`
 * sẽ xoá cả nhãn do người trong dự án tự tạo cho việc của họ.
 */
export const RETIRED_LABELS = [
  // v0.1 → v0.2
  ...SHAPE.map((v) => `shape::${v}`),
  ...ROLE.map((v) => `role::${v}`),
  ...['brief', 'spec', 'changelog', 'manual'].map((v) => `source::${v}`),
  ...OBSERVE.map((v) => `observe::${v}`),
  'qc::todo', 'qc::passed', 'qc::failed',
  'care::thuong', 'gate::pending',
  'spec-delta', 'reclaimed', 'blocked-by-human', 'ingest-reverted', 'meta-corrupt',
  // v0.2 → v0.3
  ...Object.keys(LEGACY_STATUS).map((v) => `status::${v}`),
  LEGACY_CAREFUL_LABEL, 'gate::green', 'gate::red', 'needs-advice', 'spec-changed',
];

const COLORS = {
  'status::backlog': '#6699CC',
  'status::working': '#ED9121',
  'status::needs-you': '#D9534F',
  'status::in-review': '#8E44AD',
  'status::ready-to-merge': '#5CB85C',
  [CAREFUL_LABEL]: '#C0392B',
  hotzone: '#AD4363',
  'review::required': '#8E44AD',
  'source-drifted': '#ED9121',
  debt: '#8E5A00',
};
const DEFAULT_COLOR = '#AAAAAA';

/** Mô tả hiện trên GitLab khi hover — chỗ DUY NHẤT người đọc thấy nghĩa của nhãn. */
const DESCRIPTIONS = {
  'status::backlog': 'Backlog — chưa ai nhận. Agent sẽ tự bóc, hoặc bạn giao cho một agent cụ thể',
  'status::working': 'Working — đang có agent làm. Ai làm: đọc khối "Đang làm" trên item',
  'status::needs-you': 'Needs you — BẠN phải làm gì đó: trả lời / quyết định / gỡ / sửa CI. Đọc khối "Cần bạn"',
  'status::in-review': 'In review — agent xong, BẠN kiểm theo khối "Cách kiểm" rồi kéo sang Ready to merge',
  'status::ready-to-merge': 'Ready to merge — QC đạt. Bạn merge/rebase, hoặc bảo agent làm rồi đóng',
  [CAREFUL_LABEL]: 'Việc chạm thứ đắt (one-way door) — đọc kỹ hơn trước khi duyệt',
  hotzone: 'Chạm vùng đắt — các item này phải chạy TUẦN TỰ. Người tự gắn',
  'review::required': 'Bắt buộc có bằng chứng review trước khi đóng',
  'source-drifted': 'Tài liệu nguồn trên đĩa đã đổi sau khi item được tạo — đối chiếu lại',
  debt: 'Item này là một KHOẢN NỢ kỹ thuật cần trả — do task_complete của một task khác tạo ra',
};

/** Dựng một nhãn scoped, chặn giá trị rác ngay tại nguồn. */
export function labelFor(key, value) {
  const allowed = SCOPED[key];
  if (!allowed) {
    throw new Error(`key nhãn không hợp lệ: "${key}" (hợp lệ: ${Object.keys(SCOPED).join(', ')})`);
  }
  if (!allowed.includes(value)) {
    // Nói ra tên MỚI nếu đây là tên cũ, để người sửa lỗi không đi thêm lại giá trị v0.2 vào STATUS.
    const renamed = key === 'status' ? LEGACY_STATUS[value] : null;
    const hint = renamed
      ? ` — "${value}" là tên v0.2, từ v0.3 gọi là "${renamed}".`
      : '';
    throw new Error(
      `giá trị "${value}" không hợp lệ cho key "${key}" (hợp lệ: ${allowed.join(', ')})${hint}`,
    );
  }
  return `${key}::${value}`;
}

/**
 * Bóc danh sách nhãn của GitLab thành dạng dùng được.
 *
 * `duplicates` là phần riêng của Free tier: nhiều giá trị cùng một key thì phải thấy để dọn.
 * `legacy` liệt kê nhãn v0.2 còn trên item — đã được ÁNH XẠ vào `scoped`/`flags` để tool chạy
 * được, nhưng `--migrate` cần biết để dọn.
 *
 * Nhãn đã bỏ hẳn (`shape::*`…) đi vào `flags` như mọi chuỗi lạ khác — KHÔNG throw. Item cũ trên
 * project của người ta còn mang chúng, và một lệnh ĐỌC không được chết vì dữ liệu lịch sử.
 */
export function parseLabels(labels = []) {
  /** @type {Record<string,string>} */ const scoped = {};
  /** @type {Record<string,string[]>} */ const seen = {};
  /** @type {string[]} */ const flags = [];
  /** @type {string[]} */ const legacy = [];

  for (const l of labels) {
    if (l === LEGACY_CAREFUL_LABEL) {
      legacy.push(l);
      if (!flags.includes(CAREFUL_LABEL)) flags.push(CAREFUL_LABEL);
      continue;
    }
    const i = l.indexOf('::');
    const key = i > 0 ? l.slice(0, i) : null;
    if (key && SCOPED[key]) {
      let value = l.slice(i + 2);
      if (key === 'status' && LEGACY_STATUS[value]) {
        legacy.push(l);
        value = LEGACY_STATUS[value];
      }
      (seen[key] ??= []).push(value);
      scoped[key] = value;
    } else {
      flags.push(l);
    }
  }

  /** @type {Record<string,string[]>} */ const duplicates = {};
  for (const [k, vs] of Object.entries(seen)) {
    // Hai nhãn cũ/mới của CÙNG một trạng thái (vd `status::ready` + `status::backlog`) không phải
    // xung đột — chỉ là chưa dọn. Chỉ tính trùng khi các GIÁ TRỊ đã chuẩn hoá khác nhau.
    const distinct = [...new Set(vs)];
    if (distinct.length > 1) duplicates[k] = distinct;
  }

  return { scoped, flags, duplicates, hasDuplicates: Object.keys(duplicates).length > 0, legacy };
}

/**
 * Kế hoạch dọn nhãn v0.2 trên MỘT item: gỡ tên cũ, gắn tên mới tương đương.
 * Chỉ tính toán, không gọi mạng — `tasks-cli labels --migrate` mới ghi.
 *
 * @param {string[]} labels
 * @returns {{add: string[], remove: string[], noop: boolean}}
 */
export function migrationPlan(labels = []) {
  /** @type {string[]} */ const add = [];
  /** @type {string[]} */ const remove = [];
  const has = (l) => labels.includes(l);
  const want = (l) => {
    if (!has(l) && !add.includes(l)) add.push(l);
  };

  for (const l of labels) {
    if (l === LEGACY_CAREFUL_LABEL) {
      remove.push(l);
      want(CAREFUL_LABEL);
      continue;
    }
    const m = /^status::(.+)$/.exec(l);
    if (m && LEGACY_STATUS[m[1]]) {
      remove.push(l);
      // Đã có nhãn v0.3 nào cho status thì KHÔNG gắn thêm — người có thể đã kéo card đi chỗ khác.
      const hasNew = labels.some((x) => STATUS.some((s) => x === `status::${s}`));
      if (!hasNew) want(`status::${LEGACY_STATUS[m[1]]}`);
      continue;
    }
    // Ba nhãn bỏ hẳn: gỡ, không thay.
    if (l === 'needs-advice' || l === 'spec-changed' || l === 'gate::green' || l === 'gate::red') {
      remove.push(l);
    }
  }
  return { add, remove, noop: add.length === 0 && remove.length === 0 };
}

/**
 * Tính một lượt cập nhật nhãn giữ tính loại trừ cho `key`.
 *
 * Trả về add + remove để gọi trong MỘT request PUT: GitLab áp cả hai cùng lúc nên không có
 * khe giữa "gỡ cái cũ" và "gắn cái mới" — khe đó là chỗ trạng thái biến mất trong chốc lát.
 *
 * Nhãn v0.2 cùng key (`status::ready`…) cũng bị gỡ ở đây: đổi trạng thái là lúc rẻ nhất để dọn.
 */
export function exclusiveLabelUpdate(currentLabels, key, value) {
  const next = labelFor(key, value);
  const prefix = `${key}::`;
  const olds = currentLabels.filter((l) => l.startsWith(prefix) && l !== next);
  const already = currentLabels.includes(next);

  if (already && olds.length === 0) return { add: [], remove: [], noop: true };
  return { add: already ? [] : [next], remove: olds, noop: false };
}

/** Danh sách nhãn cần tạo trên project, kèm màu + mô tả người đọc được. */
export function labelDefinitions() {
  /** @type {{name: string, color: string, description: string}[]} */
  const out = [];
  for (const [key, values] of Object.entries(SCOPED)) {
    for (const v of values) {
      const name = `${key}::${v}`;
      out.push({
        name,
        color: COLORS[name] ?? DEFAULT_COLOR,
        description: DESCRIPTIONS[name] ?? `${key} = ${v}`,
      });
    }
  }
  for (const f of FLAGS) {
    out.push({
      name: f,
      color: COLORS[f] ?? DEFAULT_COLOR,
      description: DESCRIPTIONS[f] ?? `cờ ${f}`,
    });
  }
  return out;
}

// ───────────────────────── khối agent-meta ─────────────────────────

const START = '<!-- agent-meta:start — KHỐI MÁY ĐỌC. Sửa tay có thể làm agent hiểu sai. -->';
const END = '<!-- agent-meta:end -->';
// Bắt cả biến thể marker rút gọn để không vỡ khi ai đó gõ tay.
const BLOCK_RE = /\n*<!--\s*agent-meta:start[\s\S]*?<!--\s*agent-meta:end\s*-->/;
const JSON_RE = /```agent-meta\s*\n([\s\S]*?)\n```/;

/**
 * Tách phần người viết khỏi khối máy đọc.
 * JSON hỏng ⇒ `corrupt: true` và `meta: null` — KHÔNG ném lỗi, vì description hỏng không được
 * làm chết cả luồng đọc item.
 */
export function parseAgentMeta(description = '') {
  const block = description.match(BLOCK_RE);
  if (!block) return { meta: null, corrupt: false, tooNew: false, human: description };

  const human = description.slice(0, block.index);
  const inner = block[0].match(JSON_RE);
  if (!inner) return { meta: null, corrupt: true, tooNew: false, human };

  try {
    const meta = JSON.parse(inner[1]);
    const tooNew = Number(meta?.v) > META_VERSION;
    return { meta, corrupt: false, tooNew, human };
  } catch {
    return { meta: null, corrupt: true, tooNew: false, human };
  }
}

/**
 * Ghi khối meta, chỉ thay phần giữa hai marker.
 *
 * Từ chối ghi đè khi dữ liệu trên item có `v` mới hơn bản mình biết: hai máy chạy phiên bản
 * plugin khác nhau là chuyện sẽ xảy ra, và ghi đè im lặng ở đó là mất dữ liệu.
 *
 * Fence JSON nằm trong `<details>` — mặc định GẤP LẠI. Khối này là thứ NGƯỜI không cần đọc.
 * Marker vẫn ở NGOÀI `<details>` nên `BLOCK_RE`, `JSON_RE` và `META_START_RE` (desc-block.mjs)
 * không đổi hành vi — đặt marker vào trong sẽ làm `upsertBlock` chèn khối khác vào giữa thẻ HTML.
 */
export function writeAgentMeta(description = '', meta = {}) {
  const parsed = parseAgentMeta(description);
  if (parsed.tooNew) {
    throw new Error(
      `Khối agent-meta trên item ở phiên bản v${parsed.meta?.v}, cao hơn bản server hiểu ` +
        `(v${META_VERSION}). Không ghi đè để tránh mất dữ liệu — hãy nâng cấp agent-tasks.`,
    );
  }

  const body =
    `${START}\n` +
    '<details><summary>agent-meta — khối máy đọc (bấm để mở)</summary>\n\n' +
    `\`\`\`agent-meta\n${JSON.stringify(meta, null, 2)}\n\`\`\`\n\n` +
    `</details>\n${END}`;
  return `${parsed.human.trimEnd()}\n\n${body}\n`;
}

// ───────────────────────── đọc thuộc tính của item ─────────────────────────

/** Item có phải việc "chạm thứ đắt"? Đọc CẢ nhãn (mới + cũ) lẫn meta — cái nào nói có là có. */
export function isCareful(item) {
  const { flags } = parseLabels(item.labels ?? []);
  return flags.includes(CAREFUL_LABEL) || item.meta?.care === 'chat';
}

/**
 * Trạng thái gate của item: `'green'` | `'red'` | `null` (chưa chạy).
 *
 * v0.3 lưu ở `meta.gate.status` (task_attach_docs ghi). Item cũ còn nhãn `gate::*` thì vẫn đọc
 * được — nhãn đó đã nghỉ nhưng dữ liệu lịch sử không được biến thành "chưa chạy".
 */
export function gateStatusOf(item) {
  const fromMeta = item.meta?.gate?.status;
  if (fromMeta === 'green' || fromMeta === 'red') return fromMeta;
  const labels = item.labels ?? [];
  if (labels.includes('gate::green')) return 'green';
  if (labels.includes('gate::red')) return 'red';
  return null;
}

/**
 * Chuẩn hoá `debt` từ input: nhận mảng `{title, detail}`, mảng chuỗi, hoặc một chuỗi (bản cũ).
 * Trả `[]` khi không có gì. Không kiểm hợp lệ ở đây — `validateComplete` làm.
 * @returns {{title: string, detail: string|null}[]}
 */
export function normalizeDebt(debt) {
  if (debt == null) return [];
  const list = Array.isArray(debt) ? debt : [debt];
  /** @type {{title: string, detail: string|null}[]} */ const out = [];
  for (const d of list) {
    if (d == null) continue;
    if (typeof d === 'string') {
      const t = d.trim();
      if (t) out.push({ title: t, detail: null });
      continue;
    }
    if (typeof d === 'object') {
      const title = String(d.title ?? '').trim();
      const detail = String(d.detail ?? '').trim() || null;
      if (title || detail) out.push({ title, detail });
    }
  }
  return out;
}

// ───────────────────────── điều kiện complete ─────────────────────────

const SPEC_OPS = ['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED'];

/** Danh sách chuỗi không rỗng, mỗi chuỗi đã trim. */
function cleanList(v) {
  if (!Array.isArray(v)) return null;
  return v.map((x) => String(x ?? '').trim()).filter(Boolean);
}

/**
 * Điều kiện của `task_complete` (docs/11 §C3). Gom TẤT CẢ thiếu sót rồi mới trả — dừng ở cái đầu
 * thì agent phải sửa nhiều vòng, mỗi vòng một lỗi.
 *
 * Thứ người QC cần nhất đứng đầu: HƯỚNG DẪN KIỂM. Mọi cổng khác chỉ áp khi item thật sự có tính
 * chất đó (careful / review::required), để không bắt agent viết cho đủ nghi thức.
 */
export function validateComplete(item, input) {
  const { flags, duplicates, hasDuplicates } = parseLabels(item.labels ?? []);
  const meta = item.meta ?? {};
  /** @type {string[]} */ const missing = [];

  // 0. Nhãn trùng key phải chặn TRƯỚC mọi cổng khác: trên Free hai giá trị cùng key sống chung được,
  // và không đoán được cái nào đúng.
  if (hasDuplicates) {
    missing.push(
      `Item có nhãn trùng key: ${Object.entries(duplicates)
        .map(([k, v]) => `${k}::{${v.join('|')}}`)
        .join(', ')}. Dọn bằng \`tasks-cli labels --migrate --apply\` (hoặc gỡ tay nhãn sai trên GitLab) rồi complete lại — không đoán giá trị nào đúng.`,
    );
  }

  // 1. HƯỚNG DẪN QC — điều kiện quan trọng nhất của v0.3. Người duyệt phải biết bấm ở đâu, thấy gì.
  const steps = cleanList(input.qc_steps);
  const notManual = String(input.qc_not_manual ?? '').trim();
  const evidence = String(input.qc_evidence ?? '').trim();
  const gate = gateStatusOf(item);

  if (!steps?.length && !notManual) {
    missing.push(
      'thiếu hướng dẫn QC — truyền `qc_steps` (mỗi bước một dòng: LÀM GÌ → THẤY GÌ, kèm dữ liệu ' +
        'mẫu / màn hình / endpoint nếu có). Chỉ khi việc này KHÔNG THỂ kiểm tay thì thay bằng ' +
        '`qc_not_manual` (vì sao không kiểm tay được) + `qc_evidence` (bằng chứng máy: test nào, ' +
        'lệnh nào, kết quả gì).',
    );
  } else if (steps?.length) {
    const tooShort = steps.filter((s) => s.length < 8);
    if (tooShort.length) {
      missing.push(
        `qc_steps có bước quá ngắn để kiểm được: ${tooShort.map((s) => `"${s}"`).join(', ')}. ` +
          'Mỗi bước phải nói LÀM GÌ và THẤY GÌ.',
      );
    }
  } else if (notManual && gate !== 'green' && !evidence) {
    missing.push(
      'khai qc_not_manual (không kiểm tay được) thì PHẢI có bằng chứng máy: gate xanh (đính ledger ' +
        'qua task_attach_docs) hoặc `qc_evidence` nói rõ test/lệnh nào đã chạy và kết quả.',
    );
  }

  // 2. Việc chạm thứ đắt ⇒ phải nêu hazard: CHẶT mà không nói canh cái gì là nghi lễ.
  const careful = flags.includes(CAREFUL_LABEL) || meta.care === 'chat';
  if (careful && !String(meta.hazard ?? '').trim()) {
    missing.push(
      'item có nhãn `careful` nhưng hazard rỗng — truyền tham số `hazard` cho task_complete (một ' +
        'dòng "hazard là <gì>; vỡ thì <hậu quả>"), hoặc khai sẵn từ lúc task_intake.',
    );
  }

  // 3. Đánh đổi — chỉ ở hai ca CHẮC CHẮN có đánh đổi: việc chạm thứ đắt, và việc bắt buộc review.
  // Bắt khai ở mọi item thì agent viết một câu cho đủ thủ tục, và trường này mất giá trị đúng ở
  // chỗ nó đáng giá nhất — bản recap N ngày.
  const needsReview = meta.review_required === true || flags.includes('review::required');
  if ((careful || needsReview) && !String(input.tradeoff ?? meta.tradeoff ?? '').trim()) {
    missing.push(
      `thiếu tradeoff — item này ${careful ? 'có nhãn careful' : 'có review::required'} nên PHẢI khai ` +
        'đã chọn hướng nào, bỏ hướng nào, và đổi lại được gì. Truyền tham số `tradeoff`. Không có ' +
        'đánh đổi nào thì viết đúng thế và nói vì sao.',
    );
  }

  // 4. spec_delta KHÔNG bắt buộc từ v0.3, nhưng có thì phải đúng dạng.
  const sd = input.spec_delta;
  if (sd != null) {
    if (!Array.isArray(sd)) {
      missing.push('spec_delta phải là mảng {capability, op, requirement} (hoặc bỏ trống).');
    } else {
      for (const d of sd) {
        if (!String(d?.capability ?? '').trim() || !String(d?.requirement ?? '').trim() || !SPEC_OPS.includes(d?.op)) {
          missing.push(
            `spec_delta có mục sai định dạng (cần capability + op ∈ ${SPEC_OPS.join('|')} + requirement): ${JSON.stringify(d)}`,
          );
        }
      }
    }
  }

  // 5. Review.
  if (needsReview && !String(meta.review_evidence ?? '').trim()) {
    missing.push(
      'review::required nhưng chưa có bằng chứng review — truyền `review_evidence` (note của ' +
        'code-reviewer hoặc xác nhận của người).',
    );
  }

  // 6. Nợ: mỗi khoản phải có title, vì nó sẽ thành MỘT ISSUE trong Backlog.
  for (const d of normalizeDebt(input.debt)) {
    if (!d.title) {
      missing.push(
        `debt có khoản không có title: ${JSON.stringify(d)}. Mỗi khoản nợ thành một issue riêng ` +
          'nên cần title đọc được như một việc phải làm.',
      );
    }
  }

  // 7. Summary.
  if (!String(input.summary ?? '').trim()) missing.push('thiếu summary.');

  return { ok: missing.length === 0, missing };
}
