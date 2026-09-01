// @ts-check
// Dò trùng cho luồng vào: tách từ khoá đặc trưng, xếp ứng viên thành BẬC RỜI RẠC.
// Thuần hàm — không mạng, không filesystem. Xem spec §7.1b và D12.
//
// Vì sao bậc chứ không phải điểm số: bậc GIẢI THÍCH ĐƯỢC. Agent trình bày lại cho người thành
// "khớp CAO vì cùng capability dang-nhap và trùng 2 từ khoá: reconnect, ws" — còn "0.87" thì không
// ai kiểm được, và nó tạo ảo giác về độ chính xác mà dữ liệu không hề có.
//
// ⚠️ Luật của file này: BẬC LÀ ĐỂ LỌC. Mỗi lần định nới điều kiện cho một bậc, hỏi lại "bậc này còn
// loại được gì không". Bậc bắt mọi thứ thì không ai đọc nó nữa, và luồng vào quay về đúng tình trạng
// nó định chữa.

import { parseAgentMeta } from './schema.mjs';

/** Bậc từ mạnh đến yếu. Thứ tự này là hợp đồng — tool đọc `top_tier` để quyết định. */
export const TIERS = Object.freeze(['EXACT', 'CAO', 'VỪA', 'THẤP']);

/**
 * Stopword: từ xuất hiện trong hầu hết brief nên không phân biệt được việc nào với việc nào.
 *
 * Có cả động từ hành động (`sửa`, `thêm`, `fix`, `add`) và danh từ chung (`lỗi`, `bug`, `task`):
 * "sửa lỗi hiển thị avatar" thì phần mang thông tin là `hien thi` và `avatar`, không phải `sua loi`.
 *
 * ⚠️ Phải phủ cả các từ 2 ký tự — vì ngưỡng độ dài là 2 chứ không phải 3 (xem `keywords`).
 * Viết ở dạng ĐÃ BỎ DẤU, vì `keywords` so sau khi normalize.
 *
 * ⚠️ **Bỏ dấu gây đụng độ thật**, và ba chỗ dưới đây đã cố ý KHÔNG cho vào danh sách vì nghĩa
 * mang thông tin thắng nghĩa stopword:
 *   - `dang` — "đang" là stopword, nhưng **"đăng"** (đăng nhập / đăng ký) là từ khoá domain hay
 *     gặp nhất của dự án này. Bỏ nó thì "Đăng nhập bằng OTP" chỉ còn `nhap, otp`.
 *   - `tai`  — "tại" là stopword, nhưng **"tải"** (tải file, tải lại) thì không.
 *   - `ma`   — "mà" là stopword, nhưng **"mã"** (mã OTP, mã lỗi) thì không.
 * Đổi lại ta nhận thêm chút nhiễu từ "đang/tại/mà" — đó là đánh đổi có ý thức, không phải bỏ sót.
 */
const STOPWORDS = new Set([
  // ── tiếng Việt ──
  'va', 'la', 'cua', 'cho', 'cac', 'nhung', 'mot', 'khi', 'thi', 'neu', 'de', 'duoc', 'co',
  'khong', 'nay', 'do', 'trong', 'ra', 'vao', 'voi', 'tu', 'da', 'se', 'bi', 'lam',
  'them', 'sua', 'loi', 'task', 'moi', 'can', 'phai', 'nen', 'roi', 'luon', 'cai',
  'viec', 'hay', 'bang', 'theo', 've', 'den', 'boi', 'nhu', 'con',
  'chi', 'cung', 'van', 'chua', 'dan', 'gi', 'ai', 'no', 'ta', 'ho', 'toi', 'ban', 'anh',
  // ── tiếng Anh ──
  'the', 'and', 'or', 'for', 'to', 'in', 'on', 'of', 'with', 'is', 'are', 'be', 'was', 'were',
  'an', 'at', 'by', 'as', 'it', 'do', 'we', 'if', 'so', 'that', 'this', 'not', 'but', 'can',
  'should', 'will', 'add', 'fix', 'new', 'update', 'remove', 'support', 'feature', 'bug',
  'issue', 'error', 'when', 'then', 'from', 'into', 'make', 'use', 'using', 'need', 'want',
]);

/** Hạ chữ thường + bỏ dấu tiếng Việt. `đ` không phải dấu tổ hợp nên phải xử riêng. */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replaceAll('đ', 'd')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Từ khoá đặc trưng của một đoạn văn bản.
 *
 * Ngưỡng **2 ký tự**, không phải 3 như spec §7.1b viết ban đầu: luật ≥3 loại mất `WS` — đúng cái
 * ví dụ minh hoạ của chính spec ("trùng 2 từ khoá: reconnect, WS"). Acronym 2 ký tự (`WS`, `QC`,
 * `UI`, `DB`) là loại từ khoá đặc trưng NHẤT trong domain này (D19).
 *
 * @returns {string[]} đã normalize, dedupe, giữ thứ tự xuất hiện
 */
export function keywords(text) {
  const raw = String(text ?? '').match(/[\p{L}\p{N}]+/gu) ?? [];
  /** @type {string[]} */ const out = [];
  const seen = new Set();

  for (const tok of raw) {
    const n = normalize(tok);
    if (n.length < 2) continue;
    if (STOPWORDS.has(n)) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Slug ổn định để làm khoá bền `brief:<slug>`.
 * @returns {string|null} null khi không còn ký tự dùng được — KHÔNG trả chuỗi rỗng
 */
export function slugify(text) {
  const s = normalize(text)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    // Cắt xong có thể để lại gạch cuối — `them-ws-` là một slug khác `them-ws`, và khoá bền thì
    // không được phụ thuộc chỗ dao cắt rơi vào.
    .replace(/-+$/g, '');

  // Chuỗi rỗng làm khoá bền sẽ thành `brief:` — khớp MỌI item không có slug. Một khoá "bền" khớp
  // mọi thứ tệ hơn không có khoá.
  return s || null;
}

/**
 * Nhãn mở đầu người ta hay gõ trước nội dung thật, ở dạng ĐÃ BỎ DẤU.
 *
 * So sau khi normalize chứ không viết regex có dấu: `m[oơ]?i` KHÔNG khớp "mới", vì `ớ` là U+1EDB
 * chứ không phải `ơ` + dấu rời. Đó là ca đã sai một lần ở đây.
 */
const TITLE_PREFIXES = new Set(['task moi', 'task', 'new task', 'task new', 'yeu cau moi', 'bug']);

/**
 * Title từ brief: dòng đầu, bỏ heading markdown và nhãn mở đầu kiểu "Task mới:".
 * @returns {string|null}
 */
export function titleFromBrief(brief) {
  const first = String(brief ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return null;

  let t = first.replace(/^#{1,6}\s*/, '').trim();

  // Chỉ cắt khi phần trước dấu hai chấm ĐÚNG là một nhãn mở đầu — "WS: reconnect" phải giữ nguyên.
  const m = t.match(/^([^:\-–]{1,20})[:\-–]\s*(\S.*)$/u);
  if (m && TITLE_PREFIXES.has(normalize(m[1]).trim())) t = m[2].trim();

  return t ? t.slice(0, 120) : null;
}

/** Giao của hai tập từ khoá, giữ thứ tự của `a`. */
function overlap(a, b) {
  const set = new Set(b);
  return a.filter((k) => set.has(k));
}

/**
 * Xếp bậc một item so với yêu cầu đang xét.
 *
 * @param {{slug: string|null, capability: string|null, keywords: string[]}} query
 * @param {{iid: number, title?: string|null, description?: string|null, state?: string,
 *          labels?: string[], web_url?: string}} it
 * @returns {{iid: number, tier: string, signals: string[], closed: boolean,
 *            meta_corrupt: boolean, title: string|null, state: string, web_url: string|null}}
 */
export function rankItem(query, it) {
  const parsed = parseAgentMeta(it?.description ?? '');
  const src = parsed.meta?.source;
  // `source` có thể là chuỗi hoặc null trong dữ liệu cũ — chỉ đọc field khi nó thật là object.
  const srcObj = src && typeof src === 'object' ? src : {};

  const base = {
    iid: it?.iid,
    closed: it?.state === 'closed',
    meta_corrupt: parsed.corrupt === true,
    /**
     * Item này đã qua agent-tasks chưa?
     *
     * Cần vì backlog là Issues của chính repo code (spec M2), nên ứng viên có thể là issue do NGƯỜI
     * viết. Không lọc bỏ chúng (M7) — người báo bug rồi agent định làm bug đó thì đó ĐÚNG là trùng —
     * nhưng phải nói ra để agent biết có thể cần đọc/hỏi trước.
     *
     * ⚠️ `corrupt` cũng tính là ĐÃ qua agent-tasks. Item có khối agent-meta nhưng JSON hỏng thì
     * `parsed.meta` là null — lấy riêng nó làm điều kiện sẽ dán nhãn "issue do NGƯỜI tạo" lên đúng
     * item của chính hệ thống, tức nói sai. Meta hỏng đã có `meta_corrupt` báo riêng.
     */
    managed: parsed.meta != null || parsed.corrupt === true,
    title: it?.title ?? null,
    state: it?.state ?? 'opened',
    web_url: it?.web_url ?? null,
  };

  // ── EXACT: khoá bền. Không đoán, không xếp hạng.
  if (query.slug && srcObj.slug === query.slug) {
    return {
      ...base,
      tier: 'EXACT',
      signals: [`khoá bền khớp: brief:${query.slug}`],
    };
  }

  /** @type {string[]} */ const signals = [];
  const qk = query.keywords ?? [];

  const sameCapability = Boolean(query.capability) && srcObj.capability === query.capability;
  if (sameCapability) signals.push(`cùng capability: ${query.capability}`);

  const titleHits = overlap(qk, keywords(it?.title));
  if (titleHits.length) {
    signals.push(`trùng ${titleHits.length} từ khoá trong title: ${titleHits.join(', ')}`);
  }

  if (sameCapability || titleHits.length >= 2) return { ...base, tier: 'CAO', signals };

  // Chỉ so với phần NGƯỜI viết: khối agent-meta chứa hash/url/đường dẫn, trùng ở đó không nói lên
  // hai việc giống nhau.
  const descHits = overlap(qk, keywords(parsed.human ?? it?.description));
  if (titleHits.length === 1 || descHits.length >= 2) {
    if (descHits.length >= 2 && titleHits.length !== 1) {
      signals.push(`trùng ${descHits.length} từ khoá trong description: ${descHits.join(', ')}`);
    }
    return { ...base, tier: 'VỪA', signals };
  }

  return { ...base, tier: 'THẤP', signals };
}

/**
 * Xếp bậc cả danh sách, dedupe theo `iid`, nhóm lại để tool quyết định.
 *
 * `THẤP` chỉ được ĐẾM chứ không liệt kê (§7.1b): nó gồm mọi thứ GitLab `search` trả về mà không có
 * tín hiệu nào khác, nên liệt kê ra chỉ làm loãng đúng phần agent cần đọc.
 */
export function rankCandidates(query, items) {
  /** @type {Map<number, object>} */ const byIid = new Map();
  for (const it of items ?? []) {
    if (!it || byIid.has(it.iid)) continue;
    byIid.set(it.iid, rankItem(query, it));
  }

  const all = [...byIid.values()].sort(
    (a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || a.iid - b.iid,
  );

  const of = (tier) => all.filter((c) => c.tier === tier);
  // EXACT đã đóng KHÔNG chặn tạo mới (D17: việc tái phát là việc mới) — nhưng phải nêu ra.
  const exact = of('EXACT').filter((c) => !c.closed);
  const exactClosed = of('EXACT').filter((c) => c.closed);
  const high = of('CAO');
  const medium = of('VỪA');
  const low = of('THẤP');

  return {
    all,
    exact,
    exact_closed: exactClosed,
    high,
    medium,
    low_count: low.length,
    /** Chỉ những cái đáng đọc: VỪA trở lên. */
    listed: [...exact, ...exactClosed, ...high, ...medium],
    top_tier: all.length ? all[0].tier : null,
  };
}
