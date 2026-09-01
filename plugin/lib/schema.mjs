// @ts-check
// Schema work item: nhãn, khối agent-meta, điều kiện chuyển trạng thái.
//
// GITLAB FREE: scoped label (`key::value` loại trừ lẫn nhau) là tính năng Premium. Trên Free
// `key::value` chỉ là một chuỗi thường và GitLab KHÔNG loại trừ gì — hai nhãn `status::ready`
// và `status::claimed` sống chung được. Ta mô phỏng tính loại trừ ở tầng client
// (`exclusiveLabelUpdate`), và chấp nhận rằng đó là mô phỏng chứ không phải bảo đảm: quyền làm
// việc do claim ref quyết định, nhãn chỉ là mặt hiển thị (docs/04 §1).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// v0.2 — BỘ NHÃN 13, xuống từ 44. Đây là chỗ dễ bị "sửa lại cho đủ" nhất, nên lý do ghi ở đây.
//
// Luật phân tuyến đã có từ `docs/06 §2`, và bộ nhãn cũ vi phạm chính nó:
//
//   nhãn  = thứ NGƯỜI phải thấy ngay trên board, HOẶC thứ cần lọc server-side rẻ
//   meta  = mọi thứ còn lại
//   và KHÔNG BAO GIỜ cả hai — "không lưu trùng" (docs/06 §2)
//
// Đo trên bản 0.1.12 trước khi cắt:
//   · 44 nhãn được tạo trên project.
//   · 11 nhãn KHÔNG một đường code nào ghi: `observe::*` (4 — giá trị nằm trong meta),
//     `qc::passed|failed` (2), và 5 cờ `spec-delta`·`reclaimed`·`blocked-by-human`·
//     `ingest-reverted`·`meta-corrupt`.
//   · `qc::todo` được ingest ghi rồi không ai đọc, không ai chuyển ⇒ cả khoá `qc` là ngõ cụt.
//   · `shape`·`role`·`source` được ghi CẢ nhãn CẢ meta — đúng thứ §2 cấm.
//   · Một item do ingest tạo hiện 6 chip, ba trong số đó là từ vựng quy trình
//     (`chot-chia-roi-lam`, `brief-writer`, `source::changelog`) mà người quản lý không xử lý gì.
//
// Sau khi cắt, mỗi nhãn còn lại trả lời ĐÚNG MỘT câu hỏi của người:
//   status::*        — việc đang ở đâu (4 cột của board)
//   care::chat       — việc này CHẶT, đọc kỹ trước khi duyệt
//   gate::green|red  — gate đã chạy, và kết quả
//   needs-advice     — agent bế tắc, chờ người gỡ
//   hotzone          — chạm vùng đắt, phải chạy tuần tự
//   review::required — bắt buộc có bằng chứng review trước khi đóng
//   source-drifted   — nguồn trên đĩa đã đổi sau khi item được tạo
//   debt             — có nợ kỹ thuật khai tường minh
//   spec-changed     — có đổi hành vi quan sát được
//
// VẮNG NHÃN LÀ MỘT GIÁ TRỊ, cố ý:
//   không `care::chat`  ⇒ mức thường      (bỏ `care::thuong`)
//   không `gate::*`     ⇒ gate chưa chạy  (bỏ `gate::pending`)
// Cả hai đều là ca PHỔ BIẾN, nên gắn nhãn cho chúng chỉ tạo nhiễu xám trên ~90% item. Hai chỗ
// đọc giá trị này (`validateComplete`) so bằng `!== 'green'` và `=== 'chat'`, nên vắng nhãn cho
// ra đúng kết quả cũ — không phải sửa cổng nào.
//
// ĐÁNH ĐỔI đã chọn, khai thẳng: `shape`/`role`/`care=thuong`/`source` không còn lọc được
// server-side bằng `GET issues?labels=`. `tasks_list` và `task_claim_next` chuyển sang lọc theo
// meta ở client — description đã nằm trong payload của lệnh list nên KHÔNG tốn thêm request, đổi
// lại phải quét rộng hơn (xem `SCAN_PER_PAGE` ở lib/tools.mjs và vì sao perPage phải nâng).
//
// META_VERSION cố ý GIỮ 1: `tradeoff`/`debt` là trường THÊM, và mọi đường ghi meta đều
// `{...parsed.meta}` trước khi thêm ⇒ server bản cũ đọc item mới vẫn giữ nguyên trường nó không
// biết. Bump lên 2 chỉ tạo ra một lớp item mà bản cũ TỪ CHỐI ghi (xem `writeAgentMeta`), tức là
// tự khoá mình để đổi lấy một sự bảo vệ không cần thiết.
// ⚠️ Cái KHÔNG được META_VERSION bảo vệ: bộ nhãn. Máy còn chạy 0.1.12 sẽ gắn lại
// `shape::`/`role::`/`source::` lên item mới. Đường dọn: `tasks-cli labels --prune`.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const META_VERSION = 1;

// ── Tập giá trị: NHÃN ────────────────────────────────────────────────────────────────────────

export const STATUS = ['ready', 'claimed', 'review', 'blocked'];

/** Chỉ `chat` thành nhãn. Mức thường = VẮNG nhãn. */
export const CARE_LABELED = ['chat'];

/** Chỉ kết quả ĐÃ CÓ thành nhãn. `pending` = VẮNG nhãn. */
export const GATE_LABELED = ['green', 'red'];

/** key → tập giá trị hợp lệ. Chỉ những key ở đây mới là nhãn "loại trừ". */
const SCOPED = { status: STATUS, care: CARE_LABELED, gate: GATE_LABELED };

/**
 * Nhãn cờ độc lập — có thể cùng tồn tại, không loại trừ nhau.
 *
 * Cột "ai ghi" là phần bắt buộc phải biết: nhãn không ai ghi là nhãn chết, và đó chính là lớp lỗi
 * bản 0.1.12 mắc ở 11 nhãn.
 *
 *   needs-advice     ← task_block
 *   source-drifted   ← ingest (WARN_DRIFT)
 *   debt             ← task_complete khi `debt` không rỗng
 *   spec-changed     ← task_complete khi `spec_delta` không rỗng
 *   hotzone          ← NGƯỜI (không tool nào ghi — có chủ đích, xem README)
 *   review::required ← NGƯỜI, hoặc agent khi quyết định vào luồng review
 *
 * ⚠️ `review::required` mang `::` nhưng KHÔNG nằm trong SCOPED ⇒ `parseLabels` xếp nó vào `flags`.
 * Nó trông y hệt một nhãn scoped mà xử lý khác hẳn. Giữ tên vì đã dùng ngoài thực địa; ai đọc
 * `scoped.review` sẽ luôn nhận `undefined` — phải đọc `flags.includes('review::required')`.
 */
export const FLAGS = [
  'needs-advice', 'source-drifted', 'debt', 'spec-changed', 'hotzone', 'review::required',
];

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
export const SOURCE = ['brief', 'spec', 'changelog', 'manual'];
export const GATE = ['pending', 'green', 'red'];
export const OBSERVE = ['l0', 'l1-pending', 'l2', 'l3'];

/**
 * Nhãn đã BỎ ở v0.2 — dùng cho `tasks-cli labels --prune`.
 *
 * Liệt kê tường minh chứ không suy "mọi nhãn không nằm trong bộ mới": suy như thế thì `--prune`
 * sẽ xoá cả nhãn do người trong dự án tự tạo cho việc của họ.
 */
export const RETIRED_LABELS = [
  ...SHAPE.map((v) => `shape::${v}`),
  ...ROLE.map((v) => `role::${v}`),
  ...SOURCE.map((v) => `source::${v}`),
  ...OBSERVE.map((v) => `observe::${v}`),
  'qc::todo', 'qc::passed', 'qc::failed',
  'care::thuong', 'gate::pending',
  'spec-delta', 'reclaimed', 'blocked-by-human', 'ingest-reverted', 'meta-corrupt',
];

const COLORS = {
  'status::ready': '#428BCA', 'status::claimed': '#ED9121',
  'status::review': '#8E44AD', 'status::blocked': '#D9534F',
  'care::chat': '#D9534F',
  'gate::green': '#5CB85C', 'gate::red': '#D9534F',
  'needs-advice': '#ED9121', 'source-drifted': '#ED9121',
  debt: '#8E5A00', 'spec-changed': '#0B5394',
  hotzone: '#AD4363', 'review::required': '#8E44AD',
};
const DEFAULT_COLOR = '#AAAAAA';

/** Mô tả hiện trên GitLab khi hover — chỗ DUY NHẤT người đọc thấy nghĩa của nhãn. */
const DESCRIPTIONS = {
  'status::ready': 'chờ agent lấy',
  'status::claimed': 'đang có người/phiên làm',
  'status::review': 'agent xong phần của nó — CHỜ NGƯỜI duyệt',
  'status::blocked': 'bế tắc — CHỜ NGƯỜI gỡ',
  'care::chat': 'mức CẨN THẬN: chạm thứ đắt / one-way door. Vắng nhãn = mức thường',
  'gate::green': 'gate đã chạy, xanh',
  'gate::red': 'gate đã chạy, ĐỎ. Vắng cả hai nhãn gate = chưa chạy',
  'needs-advice': 'agent bế tắc, cần người gỡ',
  'source-drifted': 'tài liệu nguồn trên đĩa đã đổi sau khi item được tạo',
  debt: 'có nợ kỹ thuật khai tường minh — đọc mục "Nợ để lại" trên item',
  'spec-changed': 'có đổi hành vi quan sát được (spec_delta không rỗng)',
  hotzone: 'chạm vùng đắt — các item này phải chạy TUẦN TỰ. NGƯỜI tự gắn',
  'review::required': 'bắt buộc có bằng chứng review trước khi đóng',
};

/** Dựng một nhãn scoped, chặn giá trị rác ngay tại nguồn. */
export function labelFor(key, value) {
  const allowed = SCOPED[key];
  if (!allowed) {
    throw new Error(`key nhãn không hợp lệ: "${key}" (hợp lệ: ${Object.keys(SCOPED).join(', ')})`);
  }
  if (!allowed.includes(value)) {
    // Nói ra VẮNG NHÃN là hợp lệ, nếu đúng là ca đó. Không nói thì người sửa lỗi sẽ đi thêm
    // `care::thuong` vào SCOPED — tức là quay lại đúng bộ nhãn vừa cắt.
    const hint =
      (key === 'care' && value === 'thuong') || (key === 'gate' && value === 'pending')
        ? ` — "${value}" cố ý KHÔNG có nhãn ở v0.2: vắng nhãn NGHĨA LÀ "${value}". Đừng gắn gì.`
        : '';
    throw new Error(
      `giá trị "${value}" không hợp lệ cho key "${key}" (hợp lệ: ${allowed.join(', ')})${hint}`,
    );
  }
  return `${key}::${value}`;
}

/**
 * Bóc danh sách nhãn của GitLab thành dạng dùng được.
 * `duplicates` là phần riêng của Free tier: nhiều giá trị cùng một key thì phải thấy để dọn.
 *
 * Nhãn đã bỏ (`shape::*`…) đi vào `flags` như mọi chuỗi lạ khác — KHÔNG throw. Item cũ trên
 * project của người ta còn mang chúng, và một lệnh ĐỌC không được chết vì dữ liệu lịch sử.
 */
export function parseLabels(labels = []) {
  /** @type {Record<string,string>} */ const scoped = {};
  /** @type {Record<string,string[]>} */ const seen = {};
  /** @type {string[]} */ const flags = [];

  for (const l of labels) {
    const i = l.indexOf('::');
    const key = i > 0 ? l.slice(0, i) : null;
    if (key && SCOPED[key]) {
      const value = l.slice(i + 2);
      (seen[key] ??= []).push(value);
      scoped[key] = value;
    } else {
      flags.push(l);
    }
  }

  /** @type {Record<string,string[]>} */ const duplicates = {};
  for (const [k, vs] of Object.entries(seen)) if (vs.length > 1) duplicates[k] = vs;

  return { scoped, flags, duplicates, hasDuplicates: Object.keys(duplicates).length > 0 };
}

/**
 * Tính một lượt cập nhật nhãn giữ tính loại trừ cho `key`.
 *
 * Trả về add + remove để gọi trong MỘT request PUT: GitLab áp cả hai cùng lúc nên không có
 * khe giữa "gỡ cái cũ" và "gắn cái mới" — khe đó là chỗ trạng thái biến mất trong chốc lát.
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
 * v0.2: fence JSON nằm trong `<details>` — mặc định GẤP LẠI. Khối này là thứ NGƯỜI không cần
 * đọc, mà trước đây nó chiếm một hộp JSON xám giữa description. Marker vẫn ở NGOÀI `<details>`
 * nên `BLOCK_RE`, `JSON_RE` và `META_START_RE` (desc-block.mjs) không đổi hành vi — đặt marker
 * vào trong sẽ làm `upsertBlock` chèn khối khác vào giữa thẻ HTML.
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

// ───────────────────────── điều kiện complete ─────────────────────────

const SPEC_OPS = ['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED'];
const NO_BEHAVIOR_RE = /không đổi hành vi quan sát được/i;

/**
 * Điều kiện của docs/07 §2.6. Gom TẤT CẢ thiếu sót rồi mới trả — dừng ở cái đầu thì agent
 * phải sửa nhiều vòng, mỗi vòng một lỗi.
 */
export function validateComplete(item, input) {
  const { scoped, flags, duplicates, hasDuplicates } = parseLabels(item.labels ?? []);
  const meta = item.meta ?? {};
  /** @type {string[]} */ const missing = [];

  // 1. CHẶT thì phải khai hazard.
  // Nhãn trùng key phải chặn TRƯỚC mọi cổng khác: trên Free hai giá trị cùng key sống chung
  // được, và `scoped[key]` lấy giá trị CUỐI theo thứ tự alphabet — nên ['care::chat',
  // 'care::thuong'] cho ra `thuong` và cổng hazard tắt im lặng dù care::chat đang có mặt.
  // v0.2 không còn ghi `care::thuong`, nhưng item CŨ vẫn mang nó ⇒ cổng này còn cần.
  if (hasDuplicates) {
    missing.push(
      `Item có nhãn trùng key: ${Object.entries(duplicates)
        .map(([k, v]) => `${k}::{${v.join('|')}}`)
        .join(', ')}. Dọn bằng tasks_doctor rồi complete lại — không đoán giá trị nào đúng.`,
    );
  }

  // Nói rõ ĐƯỜNG NÀO khai được, không chỉ "thiếu hazard". Cổng này từng chặn mọi item care::chat
  // vì chẳng tool nào nhận hazard làm input, và thông báo cũ không hé ra điều đó — agent đọc xong
  // vẫn không biết gọi gì. Từ 0.1.11 có hai đường: tham số `hazard` của task_intake (đúng chỗ, lúc
  // phân loại) hoặc của task_complete (cho item đã tồn tại).
  const chat = scoped.care === 'chat';
  if (chat && !String(meta.hazard ?? '').trim()) {
    missing.push(
      'care::chat nhưng hazard rỗng — truyền tham số `hazard` cho task_complete (một dòng ' +
        '"hazard là <gì>; vỡ thì <hậu quả>"), hoặc khai sẵn từ lúc task_intake. ' +
        'CHẶT mà không nêu hazard là nghi lễ, không phải cẩn thận.',
    );
  }

  // 1b. Đánh đổi — CÙNG MỘT LUẬT với hazard, và chỉ ở hai ca đã CHẮC CHẮN có đánh đổi: việc CHẶT
  // (đã cân nhắc rồi mới dám chạm) và việc bắt buộc review (review là nơi đánh đổi được chốt).
  //
  // Vì sao KHÔNG đòi ở mọi item: bắt khai đánh đổi cho một việc không có đánh đổi thì agent sẽ
  // viết một câu cho đủ thủ tục, và trường này mất giá trị đúng ở chỗ nó đáng giá nhất — bản
  // recap N ngày mà người mới đọc để hiểu vì sao hệ thống thành ra thế này.
  const needsReview = meta.review_required === true || flags.includes('review::required');
  if ((chat || needsReview) && !String(input.tradeoff ?? meta.tradeoff ?? '').trim()) {
    missing.push(
      `thiếu tradeoff — item này ${chat ? 'là care::chat' : 'có review::required'} nên PHẢI khai ` +
        'đã chọn hướng nào, bỏ hướng nào, và đổi lại được gì. Truyền tham số `tradeoff` cho ' +
        'task_complete. Không có đánh đổi nào thì viết đúng thế và nói vì sao (vd "chỉ có một ' +
        'đường đi được vì contract khoá cứng").',
    );
  }

  // 2. spec_delta bắt buộc có mặt, và nếu rỗng thì phải khai lý do.
  const sd = input.spec_delta;
  if (!Array.isArray(sd)) {
    missing.push(
      'thiếu spec_delta — bắt buộc mọi hình dạng. Mảng rỗng [] cũng được, nhưng phải có mặt.',
    );
  } else if (sd.length === 0) {
    if (!NO_BEHAVIOR_RE.test(input.risk_declared ?? '')) {
      missing.push('spec_delta rỗng thì risk_declared phải nói rõ "không đổi hành vi quan sát được".');
    }
  } else {
    for (const d of sd) {
      if (!String(d?.capability ?? '').trim() || !String(d?.requirement ?? '').trim() || !SPEC_OPS.includes(d?.op)) {
        missing.push(
          `spec_delta có mục sai định dạng (cần capability + op ∈ ${SPEC_OPS.join('|')} + requirement): ${JSON.stringify(d)}`,
        );
      }
    }
  }

  // 3. Gate. Cố ý dùng một trường RIÊNG (`gate_waiver`) thay vì dò từ khoá trong risk_declared:
  // soi chuỗi tự do vừa mong manh (agent giải thích đúng mà không dùng từ "gate" sẽ bị chặn oan)
  // vừa dễ lách (viết dài là qua). Trường riêng buộc agent nói ra một cách CÓ CHỦ Ý.
  //
  // v0.2: `gate::pending` không còn là nhãn ⇒ ca "chưa chạy gate" là VẮNG nhãn, và phép so
  // `!== 'green'` cho ra đúng kết quả đó mà không phải sửa gì.
  if (scoped.gate !== 'green' && !(input.gate_waiver ?? '').trim()) {
    missing.push(
      `gate đang "${scoped.gate ?? 'chưa chạy (không có nhãn gate::)'}" — chạy gate rồi đính bằng chứng, ` +
        `hoặc điền gate_waiver nói rõ vì sao lần này không có.`,
    );
  }

  // 4. Review.
  if (needsReview && !String(meta.review_evidence ?? '').trim()) {
    missing.push(
      'review::required nhưng chưa có bằng chứng review (note của code-reviewer hoặc xác nhận của người).',
    );
  }

  // 5. Quan sát L1 — không chặn land, nhưng cấm ghi "done" trơn.
  if (input.observe === 'l1-pending' && !/- \[ \]|checklist|cần nhìn/i.test(input.summary ?? '')) {
    missing.push('observe = l1-pending thì summary phải kèm checklist các điểm cần nhìn (quan sát).');
  }

  // 6. Summary.
  if (!(input.summary ?? '').trim()) missing.push('thiếu summary.');

  return { ok: missing.length === 0, missing };
}
