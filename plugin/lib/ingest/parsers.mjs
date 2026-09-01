// @ts-check
// Parser ba nguồn tài liệu → dữ liệu để dựng work item.
//
// Nguyên tắc chung: KHOAN DUNG khi đọc, NGHIÊM khi báo. Không nuốt im lặng thứ mình không hiểu —
// mọi chỗ thiếu đều đi vào `debt[]` để ingest xuất báo cáo, vì đó thường là lần đầu tiên khoản
// nợ metadata của repo được máy nhìn thấy (docs/08 §6).

const SHAPE_MAP = {
  'LÀM THẲNG': 'lam-thang',
  'CHIA RỒI LÀM': 'chia-roi-lam',
  'CHỐT RỒI LÀM': 'chot-roi-lam',
  'CHỐT, CHIA, RỒI LÀM': 'chot-chia-roi-lam',
  'CHỐT-CHIA': 'chot-chia-roi-lam',
  SPIKE: 'spike',
};

/** Bóc frontmatter YAML tối giản (key: value một dòng). Đủ cho các khuôn đang có. */
function frontmatter(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: src };

  /** @type {Record<string,string>} */ const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    data[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { data, body: src.slice(m[0].length) };
}

/** Cắt thân markdown thành các section theo heading ## hoặc ### (cả hai đều đang được dùng). */
function sectionsOf(body) {
  /** @type {Record<string,string>} */ const out = {};
  const re = /^#{2,3}\s+(.+?)\s*$/gm;
  const marks = [...body.matchAll(re)];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index + marks[i][0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : body.length;
    out[marks[i][1].trim()] = body.slice(start, end).trim();
  }
  return out;
}

// ───────────────────────── spec ─────────────────────────

/**
 * Parse `specs/<capability>/spec.md` theo đúng luật của spec-check.
 * Khoá tham chiếu của một requirement là NGUYÊN VĂN heading — giữ nguyên dấu và chữ hoa.
 */
export function parseSpecFile(capability, src) {
  /** @type {string[]} */ const errors = [];
  const purpose = (src.match(/^##\s+Purpose\s*$([\s\S]*?)(?=^##\s|$(?![\s\S]))/m)?.[1] ?? '').trim();

  // Bắt heading requirement ở MỌI level để phát hiện được cái sai level, thay vì lặng lẽ bỏ qua.
  const heads = [...src.matchAll(/^(#{1,6})\s+Requirement:\s*(.*?)\s*$/gm)];
  for (const h of heads) {
    if (h[1] !== '###') {
      errors.push(`heading "Requirement: ${h[2]}" sai level (${h[1]}) — phải đúng ba dấu ###`);
    }
  }

  /** @type {{capability: string, requirement: string, statement: string, scenarios: object[]}[]} */
  const requirements = [];

  const valid = heads.filter((h) => h[1] === '###');
  for (let i = 0; i < valid.length; i++) {
    const name = valid[i][2];
    const start = valid[i].index + valid[i][0].length;
    // Kết thúc ở requirement kế tiếp (bất kể level) hoặc heading ## khác.
    const nextHead = heads.find((h) => h.index > valid[i].index);
    const nextH2 = [...src.matchAll(/^##\s+(?!#)/gm)].find((m) => m.index > valid[i].index);
    const end = Math.min(nextHead?.index ?? src.length, nextH2?.index ?? src.length);
    const block = src.slice(start, end);

    if (!name) errors.push('có heading Requirement: nhưng trống tên');

    const statement = block.split(/^####\s/m)[0].trim();
    if (!/\b(SHALL|MUST)\b/.test(statement)) {
      errors.push(`requirement "${name}" thiếu SHALL/MUST trong phát biểu`);
    }

    const scenarios = [];
    for (const s of block.matchAll(/^####\s+Scenario:\s*(.*?)\s*$([\s\S]*?)(?=^####\s|$(?![\s\S]))/gm)) {
      const when = s[2].match(/^-\s*\*\*WHEN\*\*\s*(.+)$/m)?.[1]?.trim() ?? null;
      const then = s[2].match(/^-\s*\*\*THEN\*\*\s*(.+)$/m)?.[1]?.trim() ?? null;
      if (!when) errors.push(`scenario "${s[1]}" (${name}) thiếu WHEN`);
      if (!then) errors.push(`scenario "${s[1]}" (${name}) thiếu THEN`);
      scenarios.push({ name: s[1], when, then, raw: s[0].trim() });
    }
    if (scenarios.length === 0) {
      errors.push(`requirement "${name}" không có scenario nào (luật spec-check: cần ≥ 1)`);
    }

    requirements.push({ capability, requirement: name, statement, scenarios });
  }

  return { capability, purpose, requirements, errors, raw: src };
}

// ───────────────────────── changelog ─────────────────────────

/**
 * Parse một fragment changelog. Bốn thế hệ frontmatter đang cùng tồn tại trong repo, và không
 * script nào từng parse chúng — nên trường ổn định nhất là TÊN FILE, và mọi thứ khác là
 * best-effort có ghi nợ.
 */
export function parseChangelogFragment(filename, src) {
  /** @type {string[]} */ const debt = [];
  const { data, body } = frontmatter(src);
  const pick = (...keys) => keys.map((k) => data[k]).find((v) => v != null && v !== '');

  const nameMatch = filename.match(/^(\d{4})(\d{2})(\d{2})-(\d{6})-(.+)\.md$/);
  const dateFromName = nameMatch ? `${nameMatch[1]}-${nameMatch[2]}-${nameMatch[3]}` : null;
  const slugFromName = nameMatch ? nameMatch[5] : filename.replace(/\.md$/, '');

  if (Object.keys(data).length === 0) debt.push('không có frontmatter — mọi trường suy từ tên file');

  const rawDate = pick('date', 'ngày');
  const date = (rawDate ? String(rawDate).slice(0, 10) : null) ?? dateFromName;
  if (!rawDate) debt.push('thiếu trường ngày/date');

  const title =
    pick('title') ??
    body.match(/^#\s+(.+)$/m)?.[1]?.trim() ??
    slugFromName.replace(/-/g, ' ');
  if (!pick('title')) debt.push('thiếu trường title — dùng heading hoặc slug thay thế');

  // Hình dạng + mức cẩn thận: có thể ở `hình dạng`/`cẩn thận`, hoặc gộp trong `tier`.
  let shape = null;
  let care = null;

  const shapeRaw = pick('hình dạng');
  if (shapeRaw) shape = SHAPE_MAP[shapeRaw.toUpperCase()] ?? null;

  const careRaw = pick('cẩn thận');
  if (careRaw) care = /CHẶT/i.test(careRaw) ? 'chat' : 'thuong';

  const tier = pick('tier');
  if (tier) {
    const [shapePart, carePart] = tier.split('+').map((s) => s.trim());
    shape ??= SHAPE_MAP[String(shapePart).toUpperCase()] ?? null;
    if (carePart) care ??= /CHẶT/i.test(carePart) ? 'chat' : 'thuong';
    if (!shape) {
      // Thang S/F/M/L cũ đã bỏ — KHÔNG map bừa sang mô hình hai trục.
      debt.push(`tier "${tier}" thuộc thang đã bỏ, không map được hình dạng`);
    }
  }
  if (!shape && !tier) debt.push('không có trường hình dạng');

  return {
    slug: pick('slug') ?? slugFromName,
    title,
    date,
    type: pick('type', 'loại') ?? null,
    scope: pick('scope', 'phạm vi') ?? null,
    commit: pick('commit', 'commits') ?? null,
    pending: pick('pending') ?? null,
    shape,
    care,
    sections: sectionsOf(body),
    debt,
    raw: src,
  };
}

// ───────────────────────── brief ─────────────────────────

/** Tách "Tiêu chí hoàn thành" từ ba khuôn đang tồn tại: danh sách số, checkbox, bảng ca. */
function extractAcceptance(block) {
  if (!block) return [];
  const out = [];

  // checkbox `- [ ]`, gộp dòng tiếp nối thụt đầu dòng
  const cb = [...block.matchAll(/^-\s*\[[ xX]\]\s*([\s\S]*?)(?=^-\s*\[[ xX]\]|\n\s*\n|$(?![\s\S]))/gm)];
  if (cb.length) return cb.map((m) => m[1].replace(/\s+/g, ' ').trim());

  // danh sách số `1.`
  const num = [...block.matchAll(/^\d+\.\s*([\s\S]*?)(?=^\d+\.\s|\n\s*\n|$(?![\s\S]))/gm)];
  if (num.length) return num.map((m) => m[1].replace(/\s+/g, ' ').trim());

  // bảng markdown — bỏ header và dòng phân cách
  const rows = block
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('|') && !/^\|[\s:|-]+\|$/.test(l.trim()));
  if (rows.length > 1) {
    for (const r of rows.slice(1)) {
      const cells = r.split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.length) out.push(cells.join(' — '));
    }
  }
  return out;
}

/** Parse `docs-raw/<slug>/brief.md`. Format tự do, không validator nào — nên rất khoan dung. */
export function parseBriefFile(slug, src) {
  /** @type {string[]} */ const debt = [];
  const sections = sectionsOf(src);
  const find = (...names) => names.map((n) => sections[n]).find(Boolean) ?? null;

  const goal = find('Mục tiêu');
  if (!goal) debt.push('không có mục "Mục tiêu"');

  const scope = find('Phạm vi');
  if (!scope) debt.push('không có mục "Phạm vi"');

  const accBlock = find('Tiêu chí hoàn thành', 'Tiêu chí nghiệm thu', 'Nghiệm thu');
  const acceptance = extractAcceptance(accBlock);
  if (!acceptance.length) {
    debt.push('không tách được "Tiêu chí hoàn thành" ⇒ acceptance rỗng, QC không biết test gì');
  }

  return {
    slug,
    title: src.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? slug,
    goal,
    scope,
    constraints: find('Ràng buộc'),
    backend: find('Backend', 'Không đụng backend'),
    acceptance,
    sections,
    debt,
    raw: src,
  };
}
