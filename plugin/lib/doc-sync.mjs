// @ts-check
// Dò 4 nguồn tài liệu trên đĩa, chuẩn hoá tên theo mapping, đọc nội dung + hash.
//
// KHÔNG biết GitLab, KHÔNG gọi mạng. Nhờ vậy test được toàn bộ luật dò bằng cây thư mục tạm.
//
// Hai luật:
//   1. Không suy được nguồn nào ⇒ đưa vào `skipped` kèm lý do đọc được, KHÔNG throw. Nhiều task
//      thật sự không có spec (không đổi hành vi quan sát được) hay không có tài liệu API.
//      Nhưng nguồn khai TƯỜNG MINH mà không tồn tại thì vào `errors` — đó là agent gõ sai.
//   2. Mỗi nguồn phải khai ĐỘ TIN CẬY. Chỉ `mtime` là 'weak': đó là chỗ hai phiên chạy song song
//      tranh nhau "lô mới nhất", và là chỗ duy nhất đáng bắt agent xác nhận.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Vân tay nội dung — quyết định SKIP hay upload lại. Cùng độ dài với ingest/plan.mjs. */
export const contentHash = (text) => sha256(text).slice(0, 32);

/** Tên biến cờ tương ứng mỗi nguồn, để câu skip nêu đích danh. */
const FLAG_ENV = {
  spec: 'AGENT_TASKS_ATTACH_SPEC',
  ledger: 'AGENT_TASKS_ATTACH_LEDGER',
  handoff: 'AGENT_TASKS_ATTACH_HANDOFF',
  api_spec: 'AGENT_TASKS_ATTACH_API_SPEC',
};

/** Khoá cờ trong config (camelCase) theo kind. */
const FLAG_KEY = { spec: 'spec', ledger: 'ledger', handoff: 'handoff', api_spec: 'apiSpec' };

/**
 * Sinh tên đích cho tài liệu API, BẢO ĐẢM không đè nhau.
 *
 * Một file ⇒ tên gọn `api-spec.md` đúng mapping. Nhiều file ⇒ thêm hậu tố.
 *
 * ⚠️ Nhận ĐƯỜNG DẪN, không phải basename. Bản đầu chỉ dùng basename nên hai file
 * `docs-raw/a/api.md` và `docs-raw/b/api.md` cùng ra `api-spec-api.md` — đè nhau, và vì khoá meta
 * cũng theo tên nên mỗi lần gọi lại upload thêm một bản (tái hiện: 3 lần gọi ⇒ 4 upload).
 * Trùng basename thì thêm tên thư mục cha; vẫn trùng thì thêm số thứ tự.
 *
 * @param {string[]} paths đường dẫn (tương đối hoặc tuyệt đối)
 * @returns {string[]} cùng thứ tự với `paths`
 */
export function normalizeApiSpecNames(paths) {
  if (paths.length === 0) return [];
  if (paths.length === 1) return ['api-spec.md'];

  const stem = (p) => path.basename(String(p)).replace(/\.md$/i, '');
  const parent = (p) => path.basename(path.dirname(String(p)));

  const counts = new Map();
  for (const p of paths) counts.set(stem(p), (counts.get(stem(p)) ?? 0) + 1);

  /** @type {Set<string>} */ const used = new Set();
  return paths.map((p) => {
    let base = counts.get(stem(p)) > 1 ? `${parent(p)}-${stem(p)}` : stem(p);
    let name = `api-spec-${base}.md`;
    let n = 2;
    while (used.has(name)) name = `api-spec-${base}-${n++}.md`;
    used.add(name);
    return name;
  });
}

/**
 * Đọc file. Lỗi thì trả nguyên `err.code` để chỗ gọi nói được nguyên nhân.
 *
 * KHÔNG được nuốt lỗi: `catch {}` trống ở đây từng làm ba chỗ khác báo "không có file" trong khi
 * thật ra là EACCES/EISDIR — người đọc kết luận sai và không ai đi sửa quyền.
 * @returns {{ok: true, text: string} | {ok: false, code: string, message: string}}
 */
function readFileSafe(abs) {
  try {
    return { ok: true, text: fs.readFileSync(abs, 'utf8') };
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    return { ok: false, code: e.code ?? 'UNKNOWN', message: e.message };
  }
}

/** Gợi ý cách sửa theo mã lỗi hệ thống — luật "message phải nói bước tiếp theo". */
function hintFor(code) {
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return 'Không có quyền đọc — kiểm quyền file/thư mục (chmod/chown) rồi gọi lại.';
    case 'EISDIR':
      return 'Đường dẫn là THƯ MỤC, không phải file — trỏ tới đúng file .md rồi gọi lại.';
    case 'ENOTDIR':
      return 'Một đoạn giữa đường dẫn là FILE chứ không phải thư mục — kiểm lại cấu trúc thư mục.';
    case 'ELOOP':
      return 'Symlink lặp vòng — sửa symlink rồi gọi lại.';
    case 'ENOENT':
      return 'Không tồn tại — kiểm lại đường dẫn rồi gọi lại.';
    default:
      return 'Kiểm lại đường dẫn và quyền truy cập rồi gọi lại.';
  }
}

/**
 * Giải đường dẫn về tuyệt đối và bảo đảm nó nằm TRONG root.
 *
 * Dùng `realpathSync` chứ không chỉ so chuỗi: so chuỗi để symlink thoát ra ngoài root đi qua được
 * — đã tái hiện. Với đường dẫn chưa tồn tại thì realpath thư mục cha (file chưa có vẫn phải nằm
 * trong root).
 *
 * @returns {{ok: true, abs: string} | {ok: false, reason: string}}
 */
function resolveInRoot(root, rel) {
  let base;
  try {
    base = fs.realpathSync(path.resolve(root));
  } catch {
    base = path.resolve(root);
  }

  const naive = path.resolve(base, rel);
  const inside = (p) => p === base || p.startsWith(base + path.sep);

  if (!inside(naive)) {
    return { ok: false, reason: `đường dẫn nằm ngoài root dự án — từ chối đọc. Dùng đường dẫn tương đối trong repo rồi gọi lại.` };
  }

  // realpath để bắt symlink. File chưa tồn tại ⇒ realpath thư mục cha.
  let real;
  try {
    real = fs.realpathSync(naive);
  } catch {
    try {
      real = path.join(fs.realpathSync(path.dirname(naive)), path.basename(naive));
    } catch {
      // Cả thư mục cha cũng không giải được ⇒ coi như chưa tồn tại, để chỗ gọi báo ENOENT.
      return { ok: true, abs: naive };
    }
  }

  if (!inside(real)) {
    return {
      ok: false,
      reason:
        `đường dẫn trỏ ra NGOÀI root qua symlink (thật là ${real}) — từ chối đọc. ` +
        `Nội dung ngoài repo không được đưa lên GitLab. Bỏ symlink hoặc trỏ vào file trong repo.`,
    };
  }
  return { ok: true, abs: real };
}

/**
 * Một đoạn tên thư mục hợp lệ (capability, slug).
 *
 * Chúng đến từ `agent-meta` trong description GitLab — nội dung mà chính repo này gọi là UNTRUSTED
 * (xem `wrapUntrusted`). Chỉ cho phép MỘT đoạn tên, không `/`, không `..`: ghép thẳng vào
 * `path.join` từng làm agent đọc được file ngoài repo rồi upload lên GitLab.
 */
function isSafeSegment(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..';
}

/** Tìm file mới nhất theo mtime. Lỗi stat được BÁO LẠI, không nuốt. */
function newestOf(files) {
  let best = null;
  /** @type {{path: string, code: string}[]} */
  const unreadable = [];
  for (const f of files) {
    let st;
    try {
      st = fs.statSync(f);
    } catch (err) {
      unreadable.push({ path: f, code: /** @type {NodeJS.ErrnoException} */ (err).code ?? 'UNKNOWN' });
      continue;
    }
    if (!best || st.mtimeMs > best.mtime) best = { file: f, mtime: st.mtimeMs };
  }
  return { file: best?.file ?? null, unreadable };
}

/**
 * Mọi `docs/wip/<lô>/verify.md`, đã lọc bỏ đường dẫn thoát root.
 * @returns {{files: string[], problems: string[]}}
 */
function allLedgers(root) {
  const wip = path.join(root, 'docs', 'wip');
  /** @type {string[]} */ const files = [];
  /** @type {string[]} */ const problems = [];

  if (!fs.existsSync(wip)) return { files, problems };

  let dirs;
  try {
    dirs = fs.readdirSync(wip);
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    problems.push(`không đọc được docs/wip/ (${e.code}). ${hintFor(e.code ?? '')}`);
    return { files, problems };
  }

  for (const d of dirs) {
    const res = resolveInRoot(root, path.join('docs', 'wip', d, 'verify.md'));
    if (!res.ok) {
      problems.push(`bỏ qua docs/wip/${d}/verify.md: ${res.reason}`);
      continue;
    }
    if (fs.existsSync(res.abs)) files.push(res.abs);
  }
  return { files, problems };
}

/**
 * Mọi `docs/releases/entries/<YYYYMM>/<file>.md`, đã lọc bỏ đường dẫn thoát root.
 * @returns {{files: string[], problems: string[]}}
 */
function allHandoffs(root) {
  const base = path.join(root, 'docs', 'releases', 'entries');
  /** @type {string[]} */ const files = [];
  /** @type {string[]} */ const problems = [];

  if (!fs.existsSync(base)) return { files, problems };

  let months;
  try {
    months = fs.readdirSync(base);
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    problems.push(`không đọc được docs/releases/entries/ (${e.code}). ${hintFor(e.code ?? '')}`);
    return { files, problems };
  }

  for (const ym of months) {
    const dir = path.join(base, ym);
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (err) {
      const e = /** @type {NodeJS.ErrnoException} */ (err);
      // KHÔNG im lặng: một fragment ghi lạc vào entries/ (thiếu tầng YYYYMM) làm readdir ném
      // ENOTDIR, và bản đầu `continue` khiến cả thư mục biến mất khỏi kết quả.
      problems.push(
        `bỏ qua docs/releases/entries/${ym} (${e.code}). ` +
          (e.code === 'ENOTDIR'
            ? `Đây là FILE, không phải thư mục <YYYYMM> — fragment phải nằm trong entries/<YYYYMM>/.`
            : hintFor(e.code ?? '')),
      );
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.md')) continue;
      const res = resolveInRoot(root, path.join('docs', 'releases', 'entries', ym, f));
      if (!res.ok) {
        problems.push(`bỏ qua entries/${ym}/${f}: ${res.reason}`);
        continue;
      }
      files.push(res.abs);
    }
  }
  return { files, problems };
}

/**
 * Dò toàn bộ tài liệu cho một work item.
 *
 * @param {{
 *   root: string,
 *   flags: {spec?: boolean, ledger?: boolean, handoff?: boolean, apiSpec?: boolean},
 *   explicit?: {spec?: string, ledger?: string, handoff?: string, api_spec?: string[]},
 *   meta?: {source?: {kind?: string, capability?: string, slug?: string}} | null,
 *   specDelta?: {capability?: string}[] | null,
 * }} arg
 * @returns {{docs: object[], skipped: {kind: string, reason: string}[],
 *            errors: {kind: string, path: string, reason: string}[], hasWeak: boolean}}
 */
export function discoverDocs({ root, flags = {}, explicit = {}, meta = null, specDelta = null }) {
  /** @type {object[]} */ const docs = [];
  /** @type {{kind: string, reason: string}[]} */ const skipped = [];
  /** @type {{kind: string, path: string, reason: string, declared: boolean}[]} */ const errors = [];

  // Đường dẫn trả về phải tương đối so với root ĐÃ realpath: `resolveInRoot` trả về đường dẫn
  // thật, nên so với root chưa giải symlink sẽ ra đường dẫn dài vô nghĩa (macOS: /tmp →
  // /private/tmp).
  let realRoot;
  try {
    realRoot = fs.realpathSync(path.resolve(root));
  } catch {
    realRoot = path.resolve(root);
  }

  const enabled = (kind) => flags[FLAG_KEY[kind]] !== false;

  /**
   * Thêm một tài liệu đã xác định được đường dẫn tuyệt đối (đã qua resolveInRoot).
   *
   * `declared` phân biệt nguồn agent TỰ KHAI với nguồn ta SUY RA. Quan trọng vì `tools.mjs` chặn
   * cứng khi lỗi ở nguồn khai (agent gõ sai, sửa được) nhưng không nên chặn cả lượt vì một file
   * suy ra không đọc được — agent chưa từng gõ tên nó.
   */
  const push = (kind, abs, name, confidence, reason, declared) => {
    const res = readFileSafe(abs);
    const rel = path.relative(realRoot, abs);
    if (!res.ok) {
      errors.push({
        kind,
        path: rel,
        reason: `không đọc được (${res.code}). ${hintFor(res.code)}`,
        declared,
      });
      return;
    }
    // File rỗng bắt NGAY ở đây, không để tới lúc uploadFile: GitLab từ chối file rỗng, và nếu để
    // nó lọt xuống thì một `touch verify.md` placeholder sẽ chặn việc đính MỌI tài liệu khác,
    // sau khi đã upload mất vài file thành mồ côi.
    if (res.text.length === 0) {
      errors.push({
        kind,
        path: rel,
        reason: 'file RỖNG (0 byte) — GitLab từ chối file rỗng. Ghi nội dung vào rồi gọi lại.',
        declared,
      });
      return;
    }
    docs.push({
      kind,
      name,
      path: rel,
      confidence,
      reason,
      declared,
      content: res.text,
      hash: contentHash(res.text),
    });
  };

  /** Xử một nguồn khai tường minh. @returns {boolean} đã xử xong chưa */
  const tryExplicit = (kind, rel, name) => {
    if (rel === undefined || rel === null) return false;
    if (String(rel).trim() === '') {
      // Phần tử rỗng trong api_spec[] từng biến mất hoàn toàn: không vào docs, không vào skipped,
      // không vào errors — và còn làm lệch việc đặt tên vì nó vẫn được đếm.
      errors.push({
        kind,
        path: '(rỗng)',
        reason: 'đường dẫn rỗng trong lời gọi — bỏ phần tử rỗng khỏi danh sách rồi gọi lại.',
        declared: true,
      });
      return true;
    }
    const res = resolveInRoot(root, String(rel));
    if (!res.ok) {
      errors.push({ kind, path: String(rel), reason: res.reason, declared: true });
      return true;
    }
    if (!fs.existsSync(res.abs)) {
      errors.push({
        kind,
        path: String(rel),
        reason: 'file không tồn tại. Kiểm lại đường dẫn rồi gọi lại',
        declared: true,
      });
      return true;
    }
    push(kind, res.abs, name, 'strong', 'khai tường minh trong lời gọi', true);
    return true;
  };

  // ── spec ────────────────────────────────────────────────────────────────
  if (!enabled('spec')) {
    skipped.push({ kind: 'spec', reason: `bỏ qua vì ${FLAG_ENV.spec}=false` });
  } else if (!tryExplicit('spec', explicit.spec, 'spec.md')) {
    const fromMeta = meta?.source?.capability ?? null;
    const fromDelta = Array.isArray(specDelta) ? (specDelta.find((d) => d?.capability)?.capability ?? null) : null;
    const cap = fromMeta ?? fromDelta;

    if (!cap) {
      skipped.push({
        kind: 'spec',
        reason:
          'không xác định được capability (không có trong agent-meta.source, không có spec_delta, ' +
          'không khai tường minh). Task không đổi hành vi quan sát được thì đúng là không có spec để đính.',
      });
    } else if (!isSafeSegment(cap)) {
      // capability đến từ description GitLab — UNTRUSTED. Ghép thẳng vào path.join từng cho phép
      // đọc file ngoài repo rồi upload lên GitLab.
      skipped.push({
        kind: 'spec',
        reason:
          `capability "${cap}" không phải một tên thư mục hợp lệ (chỉ cho A-Z a-z 0-9 . _ -) — ` +
          `từ chối dùng để ghép đường dẫn. Sửa agent-meta trên item, hoặc khai spec tường minh.`,
      });
    } else {
      const res = resolveInRoot(root, path.join('specs', cap, 'spec.md'));
      if (!res.ok) {
        skipped.push({ kind: 'spec', reason: `specs/${cap}/spec.md: ${res.reason}` });
      } else if (!fs.existsSync(res.abs)) {
        skipped.push({ kind: 'spec', reason: `suy ra capability "${cap}" nhưng không có specs/${cap}/spec.md` });
      } else {
        push(
          'spec',
          res.abs,
          'spec.md',
          'strong',
          fromMeta ? `capability "${cap}" từ agent-meta.source` : `capability "${cap}" từ spec_delta`,
          false,
        );
      }
    }
  }

  // ── ledger ──────────────────────────────────────────────────────────────
  if (!enabled('ledger')) {
    skipped.push({ kind: 'ledger', reason: `bỏ qua vì ${FLAG_ENV.ledger}=false` });
  } else if (!tryExplicit('ledger', explicit.ledger, 'ledger.md')) {
    const { files, problems } = allLedgers(root);
    for (const p of problems) skipped.push({ kind: 'ledger', reason: p });

    const { file, unreadable } = newestOf(files);
    for (const u of unreadable) {
      skipped.push({
        kind: 'ledger',
        reason: `không stat được ${path.relative(realRoot, u.path)} (${u.code}). ${hintFor(u.code)}`,
      });
    }

    if (!file) {
      skipped.push({
        kind: 'ledger',
        reason:
          problems.length || unreadable.length
            ? 'không chọn được ledger nào ĐỌC ĐƯỢC trong docs/wip/ — xem các dòng ledger khác ở đây.'
            : 'không tìm thấy docs/wip/<lô>/verify.md nào. Chạy gate và ghi ledger trước, hoặc khai ledger tường minh.',
      });
    } else {
      push(
        'ledger',
        file,
        'ledger.md',
        // Suy đoán YẾU NHẤT: hai phiên song song sẽ tranh nhau "lô mới nhất".
        'weak',
        'lô có mtime mới nhất trong docs/wip/ — PHỎNG ĐOÁN. Khai ledger tường minh để chắc chắn',
        false,
      );
    }
  }

  // ── handoff QC ──────────────────────────────────────────────────────────
  if (!enabled('handoff')) {
    skipped.push({ kind: 'handoff', reason: `bỏ qua vì ${FLAG_ENV.handoff}=false` });
  } else if (!tryExplicit('handoff', explicit.handoff, 'handoff-qc.md')) {
    const slug = meta?.source?.slug ?? null;
    const { files, problems } = allHandoffs(root);
    for (const p of problems) skipped.push({ kind: 'handoff', reason: p });

    // Có slug ⇒ khớp theo TÊN FILE, suy đoán MẠNH. §6.2b nói mtime chỉ dành cho ledger, và lý do
    // rất thực: fragment mới nhất có thể là của task KHÁC, nên xác nhận ledger sẽ vô tình xác
    // nhận luôn một handoff sai.
    const bySlug = slug && isSafeSegment(slug) ? files.filter((f) => path.basename(f).includes(slug)) : [];

    if (bySlug.length) {
      const { file } = newestOf(bySlug);
      if (file) {
        push('handoff', file, 'handoff-qc.md', 'strong', `fragment có tên chứa slug "${slug}"`, false);
      }
    } else if (!files.length) {
      skipped.push({
        kind: 'handoff',
        reason:
          problems.length
            ? 'không chọn được fragment nào ĐỌC ĐƯỢC — xem các dòng handoff khác ở đây.'
            : 'không tìm thấy docs/releases/entries/<YYYYMM>/*.md nào — changelog fragment chưa được viết?',
      });
    } else {
      skipped.push({
        kind: 'handoff',
        reason:
          (slug
            ? `có ${files.length} fragment nhưng không cái nào có tên chứa slug "${slug}"`
            : `có ${files.length} fragment nhưng không biết cái nào thuộc task này (agent-meta không có slug)`) +
          ` — KHÔNG đoán bằng "mới nhất" vì fragment mới nhất có thể của task khác. ` +
          `Khai handoff tường minh nếu muốn đính.`,
      });
    }
  }

  // ── api spec ────────────────────────────────────────────────────────────
  if (!enabled('api_spec')) {
    skipped.push({ kind: 'api_spec', reason: `bỏ qua vì ${FLAG_ENV.api_spec}=false` });
  } else if (Array.isArray(explicit.api_spec) && explicit.api_spec.length) {
    const names = normalizeApiSpecNames(explicit.api_spec.map(String));
    explicit.api_spec.forEach((rel, i) => tryExplicit('api_spec', rel, names[i]));
  } else {
    const slug = meta?.source?.slug ?? null;
    if (!slug) {
      skipped.push({
        kind: 'api_spec',
        reason:
          'không xác định được thư mục docs-raw/<task>/ (không có slug trong agent-meta.source, ' +
          'không khai tường minh). Nhiều task không có tài liệu API.',
      });
    } else if (!isSafeSegment(slug)) {
      skipped.push({
        kind: 'api_spec',
        reason:
          `slug "${slug}" không phải một tên thư mục hợp lệ (chỉ cho A-Z a-z 0-9 . _ -) — ` +
          `từ chối dùng để ghép đường dẫn. Sửa agent-meta trên item, hoặc khai api_spec tường minh.`,
      });
    } else {
      const dirRes = resolveInRoot(root, path.join('docs-raw', slug));
      if (!dirRes.ok) {
        skipped.push({ kind: 'api_spec', reason: `docs-raw/${slug}/: ${dirRes.reason}` });
      } else {
        let entries = null;
        let readErr = null;
        try {
          entries = fs.readdirSync(dirRes.abs);
        } catch (err) {
          readErr = /** @type {NodeJS.ErrnoException} */ (err);
        }

        if (readErr) {
          // Bản đầu nuốt lỗi này rồi báo "không có file .md nào ngoài brief.md" — một câu SAI SỰ
          // THẬT khi nguyên nhân là EACCES. Người đọc kết luận task không có tài liệu API và
          // không ai đi sửa quyền.
          skipped.push({
            kind: 'api_spec',
            reason:
              readErr.code === 'ENOENT'
                ? `không có thư mục docs-raw/${slug}/`
                : `không đọc được docs-raw/${slug}/ (${readErr.code}). ${hintFor(readErr.code ?? '')}`,
          });
        } else {
          const files = entries.filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'brief.md').sort();
          if (!files.length) {
            skipped.push({ kind: 'api_spec', reason: `docs-raw/${slug}/ không có file .md nào ngoài brief.md` });
          } else {
            const rels = files.map((f) => path.join('docs-raw', slug, f));
            const names = normalizeApiSpecNames(rels);
            rels.forEach((rel, i) => {
              const res = resolveInRoot(root, rel);
              if (!res.ok) {
                skipped.push({ kind: 'api_spec', reason: `${rel}: ${res.reason}` });
                return;
              }
              push('api_spec', res.abs, names[i], 'strong', `mọi .md trong docs-raw/${slug}/ trừ brief.md`, false);
            });
          }
        }
      }
    }
  }

  return {
    docs,
    skipped,
    errors,
    hasWeak: docs.some((d) => d.confidence === 'weak'),
    /** Lỗi ở nguồn agent TỰ KHAI — đây mới là loại đáng chặn cứng cả lượt. */
    hasDeclaredError: errors.some((e) => e.declared),
  };
}
