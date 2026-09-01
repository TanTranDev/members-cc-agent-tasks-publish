// @ts-check
// Chèn/thay một khối được đánh dấu bằng hai HTML comment trong một chuỗi markdown.
//
// Tổng quát hoá kỹ thuật đã chạy trong lib/schema.mjs (writeAgentMeta): thay ĐÚNG phần giữa hai
// marker, không chạm gì khác. Khác một điểm quan trọng: khối này dành cho NGƯỜI đọc nên phải nằm
// TRƯỚC khối agent-meta, và phải giữ nguyên khối đó.
//
// Luật cứng: không chắc thì THROW. Description là nội dung do người viết; đoán sai một lần là xoá
// mất công của họ. Fail-closed ở đây đắt hơn nhiều so với bắt agent sửa tay.
//
// ⚠️ Ba lỗi MẤT DỮ LIỆU mà bản đầu của file này mắc phải (review lô 1 tái hiện được cả ba). Ai
// sửa file này phải hiểu cả ba trước khi đổi gì:
//
//   1. `body` mang chuỗi giống marker. renderDocsBlock nhúng nguyên văn dòng lệnh từ ledger, và
//      một ledger có `grep -c "<!-- agent-tasks:docs:end -->"` sẽ đặt marker đóng GIẢ vào giữa
//      khối. Lần ghi sau chỉ thay tới marker giả, để lại đuôi khối cũ ⇒ description phình vô hạn.
//      ⇒ Chữa bằng `sanitizeBody`: vô hiệu hoá mọi `<!--` trong body.
//
//   2. Bất đồng matcher với schema.mjs. Ở đó BLOCK_RE dùng `\s*` để KHOAN DUNG với marker gõ tay
//      (`<!--agent-meta:start-->` không dấu cách vẫn đọc được). Bản đầu ở đây so chuỗi cứng nên
//      không thấy biến thể rút gọn ⇒ chèn khối docs SAU khối meta ⇒ writeAgentMeta cắt bỏ mọi thứ
//      sau meta ⇒ khối docs bị xoá sạch trong khi tool báo thành công.
//      ⇒ Chữa bằng META_START_RE, cùng độ khoan dung với schema.mjs.
//
//   3. Nhiều hơn một cặp marker. Người dán ví dụ tài liệu lên trên khối thật ⇒ bản đầu ghi vào
//      cặp ĐẦU, để khối thật phía dưới đóng băng với link cũ ⇒ QC đọc bản không bao giờ cập nhật.
//      ⇒ Chữa bằng đếm marker và THROW khi ≠ 1 cặp.

/** Marker của khối tài liệu đính kèm. */
export const DOCS_MARKER = 'agent-tasks:docs';

/** Brief của luồng vào (lô 2). Khối riêng để cập nhật brief không đụng khối tài liệu. */
export const BRIEF_MARKER = 'agent-tasks:brief';

/**
 * Khối "Kết quả" — bản NGƯỜI ĐỌC của một item đã xong (v0.2).
 *
 * Vì sao phải có, dù mọi trường đã nằm trong agent-meta: người audit không đọc JSON, và bốn tệp
 * `.md` đính kèm thì GitLab KHÔNG render (click là tải raw — xem `renderDocsBlock`). Nên đường
 * đọc của người trước v0.2 là: mở item, thấy một hộp JSON và bốn link tải file. Khối này là chỗ
 * duy nhất trả lời "đã đổi gì · vì sao · còn nợ gì" mà không phải tải gì cả.
 *
 * Khối RIÊNG chứ không nhồi vào khối docs: hai khối được ghi ở hai lệnh khác nhau
 * (`task_attach_docs` vs `task_complete`), và gộp thì lệnh sau phải dựng lại nội dung lệnh trước.
 */
export const OUTCOME_MARKER = 'agent-tasks:outcome';

/**
 * Nhận diện marker mở của khối agent-meta.
 * PHẢI khoan dung ngang BLOCK_RE trong lib/schema.mjs — xem lỗi #2 ở đầu file.
 */
const META_START_RE = /<!--\s*agent-meta:start/;

const startOf = (marker) => `<!-- ${marker}:start -->`;
const endOf = (marker) => `<!-- ${marker}:end -->`;

/** Đếm số lần một chuỗi con xuất hiện. */
function countOf(haystack, needle) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * Vô hiệu hoá mọi chuỗi mở HTML-comment trong nội dung khối.
 *
 * Dùng HTML entity: markdown render lại thành `<!--` cho người đọc, nhưng phép so chuỗi không còn
 * khớp nên nội dung không thể giả làm marker. Không mất thông tin, và không phải từ chối một
 * ledger vô tội chỉ vì nó nhắc tới marker.
 */
function sanitizeBody(body) {
  return String(body).replaceAll('<!--', '&lt;!--');
}

/**
 * Định vị khối. Trả null khi không có khối nào; throw khi có nhưng không dùng được.
 * @returns {{start: number, end: number, inner: string} | null}
 */
function locate(text, marker) {
  const s = String(text);
  const startTag = startOf(marker);
  const endTag = endOf(marker);

  const nStart = countOf(s, startTag);
  const nEnd = countOf(s, endTag);

  if (nStart === 0 && nEnd === 0) return null;

  // Nhiều hơn một cặp ⇒ không có cách nào biết cặp nào là "thật". Đoán là đóng băng một khối.
  if (nStart > 1 || nEnd > 1) {
    throw new Error(
      `Khối "${marker}" xuất hiện ${Math.max(nStart, nEnd)} lần trong description ` +
        `(${nStart} marker mở, ${nEnd} marker đóng) — KHÔNG ghi vì không biết cặp nào là thật, ` +
        `và ghi sai cặp sẽ để lại một khối đóng băng mà người đọc tưởng là mới. ` +
        `Sửa tay description trên GitLab, giữ lại đúng MỘT cặp marker, rồi chạy lại.`,
    );
  }

  const start = s.indexOf(startTag);
  const end = s.indexOf(endTag);

  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `Khối "${marker}" có marker hỏng trong description: ` +
        `${start === -1 ? 'thiếu marker mở' : end === -1 ? 'thiếu marker đóng' : 'marker đóng đứng trước marker mở'}. ` +
        `KHÔNG ghi để tránh xoá nội dung do người viết. Sửa tay description trên GitLab — ` +
        `thêm lại "${start === -1 ? startTag : endTag}" cho đúng cặp — rồi chạy lại.`,
    );
  }

  return {
    start,
    end: end + endTag.length,
    inner: s.slice(start + startTag.length, end).replace(/^\n/, '').replace(/\n$/, ''),
  };
}

/** Có khối này chưa? Marker hỏng hoặc trùng lặp ⇒ throw. */
export function hasBlock(text, marker) {
  return locate(text, marker) !== null;
}

/** Đọc nội dung khối. Không có ⇒ null. Marker hỏng hoặc trùng lặp ⇒ throw. */
export function readBlock(text, marker) {
  return locate(text, marker)?.inner ?? null;
}

/**
 * Chèn khối mới hoặc thay khối cũ. Trả chuỗi MỚI, không đột biến đầu vào.
 *
 * Chèn mới thì đặt ở cuối phần người viết nhưng **TRƯỚC** khối agent-meta nếu có — vì
 * `writeAgentMeta` cắt bỏ mọi thứ nằm sau khối meta (xem lỗi #2 ở đầu file).
 */
export function upsertBlock(text, marker, body) {
  const s = String(text ?? '');
  const block = `${startOf(marker)}\n${sanitizeBody(body)}\n${endOf(marker)}`;
  const found = locate(s, marker);

  if (found) {
    return s.slice(0, found.start) + block + s.slice(found.end);
  }

  const metaAt = s.search(META_START_RE);
  if (metaAt !== -1) {
    return `${s.slice(0, metaAt).trimEnd()}\n\n${block}\n\n${s.slice(metaAt)}`;
  }
  return s.trim() ? `${s.trimEnd()}\n\n${block}\n` : `${block}\n`;
}
