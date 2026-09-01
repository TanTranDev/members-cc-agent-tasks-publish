// @ts-check
// Recap N ngày: "source đã đổi gì, VÌ SAO, và bài học" — cho người mới vào việc hoặc quay lại
// sau kỳ nghỉ, và cho agent cần nạp bối cảnh dự án trước khi bốc task.
//
// KHÔNG biết GitLab, KHÔNG gọi mạng. Nhận vào danh sách issue đã fetch + ROOT trên đĩa, trả về
// một rollup thuần dữ liệu và một bản markdown. Nhờ vậy test được toàn bộ luật gộp bằng cây thư
// mục tạm, giống lib/doc-sync.mjs.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// BA NGUỒN, và vì sao phải cả ba:
//
//   1. item trên tracker   — chỗ DUY NHẤT có `tradeoff` / `debt` / `spec_delta` máy đọc được.
//                            Nhưng item chỉ tồn tại nếu dự án bật agent-tasks.
//   2. changelog fragment  — `docs/releases/entries/<YYYYMM>/`, nằm trong GIT nên mọi member đều
//                            có, kể cả khi không mở GitLab và kể cả việc làm ad-hoc không có item.
//   3. docs/knowledge/     — "bài học": bug đã fix, sự cố đã gỡ. Cũng trong git.
//
// Một nguồn thiếu KHÔNG được làm recap im lặng ngắn đi: `sources` khai rõ từng nguồn đọc được
// mấy mục hay KHÔNG ĐỌC ĐƯỢC, và `renderRecap` in dòng đó ra.
//
// Lớp lỗi này đã trả giá thật ở một công cụ gộp changelog khác: bản đầu đọc sai thư mục, in
// "0 entry", exit 0 — và người đọc kết luận "kỳ này không có gì xảy ra" trong khi thật ra là
// "tôi đang tìm sai chỗ". Hai câu đó phải KHÔNG BAO GIỜ trông giống nhau.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';

import { parseAgentMeta, parseLabels } from './schema.mjs';
import { parseChangelogFragment } from './ingest/parsers.mjs';

export const DEFAULT_DAYS = 7;
/** Trần cứng: quá 90 ngày thì đây không còn là "recap" mà là báo cáo lịch sử, và tốn nhiều trang API. */
export const MAX_DAYS = 90;

const DAY_MS = 86_400_000;
const str = (v) => String(v ?? '').trim();

/**
 * MỘT luật cho `days`, dùng ở CẢ HAI chỗ cần nó: `buildRecap` (cắt cửa sổ) và handler
 * `tasks_recap` (dựng `updated_after` cho truy vấn). Hai chỗ tự kẹp riêng là một cặp phải đồng bộ
 * bằng tay, và lệch nhau thì truy vấn lấy về một cửa sổ khác cửa sổ được báo cáo — không ai thấy.
 *
 * Luật: không phải số dương ⇒ về mặc định. KHÔNG kẹp `-5` thành `1`: cả hai đều là đoán, nhưng
 * "về mặc định" là một luật nói được thành câu, còn "kẹp vào biên" thì trả lời một câu hỏi khác
 * câu đã hỏi mà không nói gì.
 */
export function normalizeDays(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_DAYS) : DEFAULT_DAYS;
}

/** Cắt một đoạn văn xuôi về ĐỘ DÀI ĐỌC ĐƯỢC, không cắt giữa từ. */
export function clip(text, max = 300) {
  const s = str(text).replace(/\s*\n\s*/g, ' ');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/**
 * Mốc "agent báo xong" của một item.
 *
 * Đọc `meta.history` chứ không `updated_at`: `updated_at` nhảy theo MỌI thao tác (một note, một
 * lần đổi nhãn, một lượt heartbeat ghi nhãn) nên dùng nó thì recap 7 ngày sẽ kể lại cả những
 * việc xong từ tháng trước mà tuần này có ai đó bình luận.
 *
 * Không có mốc nào ⇒ trả `null`, và chỗ gọi phải quyết định chứ không được lặng lẽ lấy `updated_at`.
 */
export function completedAt(meta) {
  const h = Array.isArray(meta?.history) ? meta.history : [];
  const done = h.filter((e) => e?.event === 'completed' && e?.at);
  if (!done.length) return null;
  return done[done.length - 1].at;
}

/**
 * Chuẩn hoá một issue GitLab thành một hàng recap.
 * @param {{iid:number, title?:string, web_url?:string, state?:string, labels?:string[],
 *          description?:string, updated_at?:string, created_at?:string}} issue
 */
export function readItem(issue) {
  const { scoped, flags } = parseLabels(issue.labels ?? []);
  const parsed = parseAgentMeta(issue.description ?? '');
  const meta = parsed.meta ?? {};

  return {
    iid: issue.iid,
    title: str(issue.title),
    url: issue.web_url ?? null,
    state: issue.state ?? null,
    status: scoped.status ?? null,
    care: scoped.care === 'chat' ? 'chat' : 'thuong',
    gate: scoped.gate ?? null,
    flags,
    // Bốn trường này ở v0.2 CHỈ còn trong meta (không còn nhãn) — recap là chỗ tiêu thụ chính
    // của chúng, nên nếu ai đó bỏ chúng khỏi meta thì recap là chỗ vỡ.
    shape: meta.shape ?? null,
    role: meta.role_hint ?? null,
    source: meta.source?.kind ?? null,
    capability: meta.source?.capability ?? null,
    spec_delta: Array.isArray(meta.spec_delta) ? meta.spec_delta : [],
    tradeoff: str(meta.tradeoff),
    debt: str(meta.debt),
    hazard: str(meta.hazard),
    risk: str(meta.risk_declared),
    observe: meta.observe ?? null,
    mr: meta.links?.mr ?? null,
    completed_at: completedAt(meta),
    // Giữ CẢ `updated_at`: nó không dùng để lọc "xong trong kỳ" (xem `completedAt`), nhưng là mốc
    // duy nhất còn lại cho item bị người đóng tay mà agent chưa bao giờ `task_complete`.
    updated_at: issue.updated_at ?? null,
    meta_corrupt: parsed.corrupt,
  };
}

// ───────────────────────── nguồn trên đĩa ─────────────────────────

// Hai dạng: `*_REL` để ghép đường dẫn (theo hệ điều hành), `*_SHOW` để IN RA. Trên Windows
// `path.join` cho ra `docs\releases\entries`, và in nguyên như thế vào một báo cáo markdown thì
// người đọc tưởng đó là một đường dẫn khác với thứ tài liệu nói.
const ENTRIES_REL = path.join('docs', 'releases', 'entries');
const KNOWLEDGE_REL = path.join('docs', 'knowledge');
const ENTRIES_SHOW = 'docs/releases/entries';
const KNOWLEDGE_SHOW = 'docs/knowledge';

const listDirs = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return null;
  }
};
const listMd = (dir) => {
  try {
    return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'));
  } catch {
    return [];
  }
};

/**
 * Changelog fragment trong cửa sổ.
 *
 * `null` ở giá trị trả về nghĩa là KHÔNG ĐỌC ĐƯỢC (không có root, hoặc chưa có thư mục), khác
 * hẳn `[]` = đọc được và không có mục nào.
 * @returns {{entries: object[]|null, dir: string}}
 */
export function readChangelog(root, { sinceDay, untilDay }) {
  if (!root) return { entries: null, dir: ENTRIES_SHOW };
  const base = path.join(root, ENTRIES_REL);
  const months = listDirs(base);
  if (months === null) return { entries: null, dir: ENTRIES_SHOW };

  const out = [];
  for (const m of months) {
    for (const f of listMd(path.join(base, m))) {
      let src = '';
      try {
        src = fs.readFileSync(path.join(base, m, f), 'utf8');
      } catch {
        continue;
      }
      const p = parseChangelogFragment(f, src);
      // Ngày lấy từ frontmatter, rơi về tên file. Không có ngày nào ⇒ BỎ QUA nhưng phải đếm:
      // im lặng bỏ một entry là im lặng bỏ một thay đổi khỏi báo cáo.
      if (!p.date) {
        out.push({ undated: true, file: `${m}/${f}`, title: p.title });
        continue;
      }
      if (p.date < sinceDay || p.date > untilDay) continue;
      out.push({
        undated: false,
        file: `${m}/${f}`,
        date: p.date,
        title: p.title,
        type: p.type,
        scope: p.scope,
        commit: p.commit,
        why: str(p.sections?.['Vì sao']),
        debt: str(p.sections?.['Nợ để lại']),
        changed: str(p.sections?.['Đã đổi gì'] ?? p.sections?.['Đã đổi gì (QC test cái này)']),
      });
    }
  }
  out.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  return { entries: out, dir: ENTRIES_SHOW };
}

/**
 * Tài liệu bài học trong cửa sổ — `docs/knowledge/<domain>/YYYY-MM-DD-<slug>.md`.
 * Ngày nằm trong TÊN FILE theo quy ước, nên lọc được mà không phải mở từng tệp.
 */
export function readKnowledge(root, { sinceDay, untilDay }) {
  if (!root) return { docs: null, dir: KNOWLEDGE_SHOW };
  const base = path.join(root, KNOWLEDGE_REL);
  const domains = listDirs(base);
  if (domains === null) return { docs: null, dir: KNOWLEDGE_SHOW };

  const out = [];
  for (const d of domains) {
    for (const f of listMd(path.join(base, d))) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.md$/);
      if (!m) continue;
      if (m[1] < sinceDay || m[1] > untilDay) continue;
      let title = m[2].replace(/-/g, ' ');
      try {
        const src = fs.readFileSync(path.join(base, d, f), 'utf8');
        title = src.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? title;
      } catch { /* tên file đã đủ dùng */ }
      out.push({ domain: d, date: m[1], title, file: `${d}/${f}` });
    }
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  return { docs: out, dir: KNOWLEDGE_SHOW };
}

// ───────────────────────── gộp ─────────────────────────

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * @param {{issues?: object[], openDebtIssues?: object[]|null, root?: string|null,
 *          days?: number, nowMs?: number}} o
 *   `openDebtIssues` — kết quả truy vấn RIÊNG theo nhãn `debt` + state=opened. Nợ là thứ tích
 *   luỹ: chỉ báo nợ mới ghi trong 7 ngày thì bức tranh nợ luôn nhỏ hơn thực tế. Truyền `null` khi
 *   không truy vấn được để recap nói ra điều đó thay vì báo "không còn nợ nào".
 */
export function buildRecap(o = {}) {
  const nowMs = o.nowMs ?? Date.now();
  const days = normalizeDays(o.days);
  const sinceMs = nowMs - days * DAY_MS;
  const sinceDay = dayOf(sinceMs);
  const untilDay = dayOf(nowMs);

  const rows = (o.issues ?? []).map(readItem);

  // "Xong trong kỳ" neo vào mốc `completed` của agent. Item bị NGƯỜI đóng tay mà agent chưa bao
  // giờ complete (ca thật: việc làm ngoài luồng rồi đóng item) không có mốc đó — bắt nó qua
  // `state === 'closed'` để nó không biến mất khỏi báo cáo.
  const inWindow = (t) => {
    const ms = Date.parse(String(t ?? ''));
    return Number.isFinite(ms) && ms >= sinceMs && ms <= nowMs;
  };

  const done = rows.filter((r) => inWindow(r.completed_at));
  const closedNoMark = rows.filter(
    (r) => r.state === 'closed' && !r.completed_at && inWindow(r.updated_at),
  );

  const inFlight = rows.filter((r) => r.status === 'claimed');
  const waiting = rows.filter((r) => r.status === 'review');
  const blocked = rows.filter((r) => r.status === 'blocked');

  // Đổi hành vi, gộp theo capability — người đọc quan tâm "capability nào động", không phải
  // "item nào động".
  /** @type {Map<string, {capability: string, ops: string[], items: number[]}>} */
  const byCap = new Map();
  for (const r of done) {
    for (const d of r.spec_delta) {
      const cap = str(d?.capability) || '(không khai capability)';
      const e = byCap.get(cap) ?? { capability: cap, ops: [], items: [] };
      e.ops.push(`${d?.op ?? '?'} ${str(d?.requirement) || '(không khai requirement)'}`);
      if (!e.items.includes(r.iid)) e.items.push(r.iid);
      byCap.set(cap, e);
    }
  }

  const tradeoffs = done.filter((r) => r.tradeoff);
  const debtNew = done.filter((r) => r.debt);

  const cl = readChangelog(o.root ?? null, { sinceDay, untilDay });
  const kn = readKnowledge(o.root ?? null, { sinceDay, untilDay });

  const clDated = (cl.entries ?? []).filter((e) => !e.undated);
  const clUndated = (cl.entries ?? []).filter((e) => e.undated);

  // Chỗ KHÔNG có dấu vết. Đây là mục người quản lý cần nhất và là mục dễ bị bỏ nhất, vì nó nói
  // về cái THIẾU — thứ mà một báo cáo "chỉ liệt kê những gì có" không bao giờ hiện ra.
  //
  // "Thiếu đánh đổi" chỉ tính ở item mà đánh đổi CHẮC CHẮN có: đổi hành vi quan sát được, hoặc
  // CHẶT, hoặc bắt buộc review. Tính cả item sửa typo thì mục này luôn đỏ, và một mục luôn đỏ
  // dạy người ta bỏ qua nó — đúng lúc nó có tin thật thì không ai đọc nữa.
  const tradeoffExpected = (r) =>
    r.spec_delta.length > 0 || r.care === 'chat' || r.flags.includes('review::required');

  const silent = {
    done_without_tradeoff: done.filter((r) => tradeoffExpected(r) && !r.tradeoff).map((r) => r.iid),
    // Giữ trong dữ liệu để ai muốn tự tính tỷ lệ thì có, nhưng KHÔNG in ra (xem `renderRecap`):
    // không có dấu hiệu nào phân biệt "quên khai nợ" với "thật sự không nợ gì".
    done_without_debt: done.filter((r) => !r.debt).map((r) => r.iid),
    done_gate_not_green: done.filter((r) => r.gate !== 'green').map((r) => r.iid),
    changelog_without_why: clDated.filter((e) => !e.why).map((e) => e.file),
    changelog_undated: clUndated.map((e) => e.file),
    meta_corrupt: rows.filter((r) => r.meta_corrupt).map((r) => r.iid),
  };

  return {
    window: { days, since: sinceDay, until: untilDay, since_ms: sinceMs, now_ms: nowMs },
    sources: {
      items: rows.length,
      changelog: cl.entries === null ? null : clDated.length,
      knowledge: kn.docs === null ? null : kn.docs.length,
      changelog_dir: cl.dir,
      knowledge_dir: kn.dir,
      open_debt: o.openDebtIssues === null || o.openDebtIssues === undefined ? null : o.openDebtIssues.length,
    },
    done,
    closed_unmarked: closedNoMark,
    behaviour_changes: [...byCap.values()],
    tradeoffs,
    debt_new: debtNew,
    debt_open: (o.openDebtIssues ?? []).map(readItem),
    changelog: clDated,
    knowledge: kn.docs ?? [],
    now: { in_flight: inFlight, waiting, blocked },
    silent,
  };
}

// ───────────────────────── render ─────────────────────────

const LIMIT = 20;
const gateIcon = (g) => (g === 'green' ? '✅' : g === 'red' ? '❌' : '·');

function overflow(list, limit = LIMIT) {
  return list.length > limit ? `\n_… và ${list.length - limit} mục nữa._` : '';
}

const ids = (xs) => (xs.length ? `#${xs.join(' #')}` : '—');

/**
 * Markdown cho NGƯỜI đọc. Thứ tự mục là thứ tự câu hỏi người thật sự hỏi khi quay lại dự án:
 * đã đổi gì → vì sao → còn nợ gì → bài học → giờ đang ở đâu → chỗ nào không có dấu vết.
 */
export function renderRecap(r) {
  const L = [];
  const w = r.window;

  L.push(`# Recap ${w.days} ngày — ${w.since} → ${w.until}`);

  const s = r.sources;
  const say = (n, dir) => (n === null ? `KHÔNG ĐỌC ĐƯỢC (\`${dir}\`)` : `${n}`);
  L.push(
    '',
    `**Nguồn đã đọc**: ${s.items} item tracker · ${say(s.changelog, s.changelog_dir)} changelog fragment · ` +
      `${say(s.knowledge, s.knowledge_dir)} tài liệu bài học` +
      (s.open_debt === null ? ' · nợ còn mở: KHÔNG TRUY VẤN ĐƯỢC' : ` · ${s.open_debt} item còn nhãn \`debt\``),
  );
  if (s.changelog === null || s.knowledge === null) {
    L.push(
      '',
      '> ⚠️ Một nguồn không đọc được. Đây là ĐƯỜNG KHÔNG ĐỌC ĐƯỢC GÌ, **không phải** kết luận ' +
        '"kỳ này không có gì xảy ra". Kiểm lại đường dẫn repo trước khi tin bản recap này.',
    );
  }

  // ── đã land
  L.push('', `## Đã land trong kỳ — ${r.done.length} item`);
  if (!r.done.length) {
    L.push('', '_Không item nào có mốc "agent báo xong" trong cửa sổ này._');
  } else {
    L.push('', '| # | Việc | CẨN | Gate | Đổi hành vi |', '|---|---|---|---|---|');
    for (const it of r.done.slice(0, LIMIT)) {
      const beh = it.spec_delta.length
        ? it.spec_delta.map((d) => `\`${d.capability}\``).filter((v, i, a) => a.indexOf(v) === i).join(' ')
        : '—';
      L.push(
        `| [#${it.iid}](${it.url ?? '#'}) | ${it.title} | ${it.care === 'chat' ? '🔴 CHẶT' : '·'} | ` +
          `${gateIcon(it.gate)} | ${beh} |`,
      );
    }
    L.push(overflow(r.done));
  }

  if (r.closed_unmarked.length) {
    L.push(
      '',
      `⚠️ **${r.closed_unmarked.length} item bị đóng mà agent chưa bao giờ \`task_complete\`** — ` +
        `${ids(r.closed_unmarked.map((x) => x.iid))}. Việc có thể đã làm ngoài luồng: không có ` +
        `spec_delta, không có bằng chứng gate, không có đánh đổi nào được ghi.`,
    );
  }

  // ── vì sao
  L.push('', `## Vì sao — quyết định và đánh đổi đã chốt`);
  if (!r.tradeoffs.length && !r.changelog.some((e) => e.why)) {
    L.push('', '_Không có lời khai đánh đổi nào trong kỳ._');
  } else {
    for (const it of r.tradeoffs.slice(0, LIMIT)) {
      L.push('', `**[#${it.iid}](${it.url ?? '#'}) ${it.title}**`, `> ${clip(it.tradeoff, 500)}`);
      if (it.hazard) L.push(`> ⚠️ hazard: ${clip(it.hazard, 200)}`);
    }
    for (const e of r.changelog.filter((x) => x.why).slice(0, LIMIT)) {
      L.push('', `**${e.date} · ${e.title}** _(changelog \`${e.file}\`)_`, `> ${clip(e.why, 500)}`);
    }
  }

  // ── nợ
  L.push('', '## Nợ kỹ thuật');
  L.push('', `### Ghi mới trong kỳ — ${r.debt_new.length}`);
  if (!r.debt_new.length) {
    L.push('', '_Không item nào khai nợ trong kỳ._');
  } else {
    for (const it of r.debt_new.slice(0, LIMIT)) {
      L.push(`- [#${it.iid}](${it.url ?? '#'}) ${it.title} — ${clip(it.debt, 300)}`);
    }
    L.push(overflow(r.debt_new));
  }
  const clDebt = r.changelog.filter((e) => e.debt && !/^[—-]\s*$/.test(e.debt));
  if (clDebt.length) {
    L.push('', '### Từ changelog fragment');
    for (const e of clDebt.slice(0, LIMIT)) L.push(`- ${e.date} · ${e.title} — ${clip(e.debt, 300)}`);
  }
  if (r.sources.open_debt === null) {
    L.push('', '### Còn mở', '', '_KHÔNG truy vấn được nhãn `debt` — không kết luận được tổng nợ đang mở._');
  } else {
    L.push('', `### Còn mở, mọi thời điểm — ${r.debt_open.length} item mang nhãn \`debt\``);
    for (const it of r.debt_open.slice(0, LIMIT)) {
      L.push(`- [#${it.iid}](${it.url ?? '#'}) ${it.title}${it.debt ? ` — ${clip(it.debt, 200)}` : ''}`);
    }
    L.push(overflow(r.debt_open));
  }

  // ── hành vi
  if (r.behaviour_changes.length) {
    L.push('', '## Hành vi quan sát được đã đổi');
    for (const c of r.behaviour_changes) {
      L.push('', `**\`${c.capability}\`** _(${ids(c.items)})_`);
      for (const op of c.ops.slice(0, 10)) L.push(`- ${op}`);
      if (c.ops.length > 10) L.push(`- _… và ${c.ops.length - 10} mục nữa_`);
    }
  }

  // ── bài học
  L.push('', `## Bài học đã ghi — ${r.knowledge.length}`);
  if (!r.knowledge.length) {
    L.push('', '_Không tài liệu `docs/knowledge/` nào trong kỳ._');
  } else {
    for (const k of r.knowledge.slice(0, LIMIT)) L.push(`- ${k.date} · \`${k.domain}\` — ${k.title}`);
    L.push(overflow(r.knowledge));
  }

  // ── bây giờ
  const n = r.now;
  L.push('', '## Bây giờ đang ở đâu');
  L.push(
    '',
    `- **đang làm** (${n.in_flight.length}): ${ids(n.in_flight.map((x) => x.iid))}`,
    `- **chờ NGƯỜI duyệt** (${n.waiting.length}): ${ids(n.waiting.map((x) => x.iid))}`,
    `- **bế tắc, chờ NGƯỜI gỡ** (${n.blocked.length}): ${ids(n.blocked.map((x) => x.iid))}`,
  );

  // ── chỗ không có dấu vết
  const sl = r.silent;
  const gaps = [];
  if (sl.done_without_tradeoff.length)
    gaps.push(
      `- ${sl.done_without_tradeoff.length} item **đổi hành vi / CHẶT / cần review mà không khai đánh đổi**: ` +
        `${ids(sl.done_without_tradeoff.slice(0, 15))}`,
    );
  if (sl.done_gate_not_green.length)
    gaps.push(`- ${sl.done_gate_not_green.length} item xong mà **gate không xanh**: ${ids(sl.done_gate_not_green.slice(0, 15))}`);
  if (sl.changelog_without_why.length)
    gaps.push(`- ${sl.changelog_without_why.length} changelog fragment **thiếu mục "Vì sao"**: ${sl.changelog_without_why.slice(0, 8).join(', ')}`);
  if (sl.changelog_undated.length)
    gaps.push(`- ${sl.changelog_undated.length} fragment **không có ngày** nên không lọc được vào kỳ nào: ${sl.changelog_undated.slice(0, 8).join(', ')}`);
  if (sl.meta_corrupt.length)
    gaps.push(`- ${sl.meta_corrupt.length} item có **khối agent-meta hỏng** — mọi trường của chúng vắng khỏi báo cáo: ${ids(sl.meta_corrupt)}`);

  L.push('', '## Chỗ KHÔNG có dấu vết');
  L.push('', ...(gaps.length ? gaps : ['_Không thiếu chỗ nào — mọi item xong đều có đánh đổi, gate xanh, và changelog đủ mục._']));

  return L.join('\n');
}
