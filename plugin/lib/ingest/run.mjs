// @ts-check
// Quét repo → nguồn đã parse → kế hoạch ingest → (tuỳ chọn) ghi thật lên GitLab.

import fs from 'node:fs';
import path from 'node:path';

import { parseSpecFile, parseChangelogFragment, parseBriefFile } from './parsers.mjs';
import { planIngest, collectDebt, renderItem, sourceKeyFor, contentHash } from './plan.mjs';
import { parseAgentMeta, labelFor } from '../schema.mjs';

const listDirs = (p) => (fs.existsSync(p) ? fs.readdirSync(p) : []);

/** Quét `specs/` — một work item cho mỗi REQUIREMENT (docs/08 §3.1). */
export function collectSpecSources(root) {
  const dir = path.join(root, 'specs');
  const out = [];
  for (const cap of listDirs(dir)) {
    const file = path.join(dir, cap, 'spec.md');
    if (!fs.existsSync(file)) continue;

    const parsed = parseSpecFile(cap, fs.readFileSync(file, 'utf8'));
    for (const req of parsed.requirements) {
      const scenarios = req.scenarios
        .map((s, i) => `${i + 1}. **${s.name}**\n   - WHEN ${s.when ?? '?'}\n   - THEN ${s.then ?? '?'}`)
        .join('\n');

      out.push({
        kind: 'spec',
        capability: cap,
        requirement: req.requirement,
        path: `specs/${cap}/spec.md`,
        title: `[spec] ${cap} — ${req.requirement}`,
        body: `${req.statement}\n${scenarios}`,
        humanBody:
          `## Yêu cầu\n\nRequirement \`${req.requirement}\` của capability \`${cap}\`.\n\n` +
          `> ${req.statement.replace(/\n/g, '\n> ')}\n\n` +
          `### Scenario cần thoả\n\n${scenarios}\n\n` +
          `---\n📎 Nguồn: \`specs/${cap}/spec.md\``,
        acceptance: req.scenarios.map((s) => `${s.name}: WHEN ${s.when} THEN ${s.then}`),
        // v0.2: chỉ `status` còn là nhãn. `source`/`qc`/`gate::pending` đã nghỉ — `source.kind`
        // nằm trong agent-meta (renderItem ghi), `qc` là ngõ cụt, và `gate::pending` = VẮNG nhãn.
        labels: [labelFor('status', 'ready')],
        debt: parsed.errors,
      });
    }
  }
  return out;
}

/** Quét changelog — item TẠO RA ĐÃ ĐÓNG (việc đã xong, không phải việc phải làm). */
export function collectChangelogSources(root) {
  const base = path.join(root, 'docs', 'releases', 'entries');
  const out = [];
  for (const month of listDirs(base)) {
    const dir = path.join(base, month);
    if (!fs.statSync(dir).isDirectory()) continue;

    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      const parsed = parseChangelogFragment(f, fs.readFileSync(path.join(dir, f), 'utf8'));
      const qc = parsed.sections['Đã đổi gì (QC test cái này)'] ?? '';
      const how = parsed.sections['Cách kiểm chứng'] ?? '';

      out.push({
        kind: 'changelog',
        slug: parsed.slug,
        path: `docs/releases/entries/${month}/${f}`,
        title: `[đã xong] ${parsed.title}`,
        body: parsed.raw,
        humanBody:
          `## Đã đổi gì (QC test cái này)\n\n${qc || '_không ghi_'}\n\n` +
          `## Cách kiểm chứng\n\n${how || '_không ghi_'}\n\n` +
          `---\n📎 Nguồn: \`docs/releases/entries/${month}/${f}\` · ngày ${parsed.date}`,
        shape: parsed.shape,
        care: parsed.care,
        // Item từ changelog là việc ĐÃ XONG (tạo ra đã đóng) nên không có `status`. `shape` đi
        // vào agent-meta; chỉ `care::chat` còn là nhãn, và mức thường = VẮNG nhãn.
        labels: parsed.care === 'chat' ? [labelFor('care', 'chat')] : [],
        debt: parsed.debt,
      });
    }
  }
  return out;
}

/** Quét `docs-raw/` — một item cho mỗi brief. */
export function collectBriefSources(root) {
  const base = path.join(root, 'docs-raw');
  const out = [];
  for (const slug of listDirs(base)) {
    const file = path.join(base, slug, 'brief.md');
    if (!fs.existsSync(file)) continue;

    const parsed = parseBriefFile(slug, fs.readFileSync(file, 'utf8'));
    const acc = parsed.acceptance.map((a) => `- [ ] ${a}`).join('\n');

    out.push({
      kind: 'brief',
      slug,
      path: `docs-raw/${slug}/brief.md`,
      title: `[brief] ${parsed.title}`,
      body: parsed.raw,
      humanBody:
        `## Mục tiêu\n\n${parsed.goal ?? '_không ghi_'}\n\n` +
        (parsed.scope ? `## Phạm vi\n\n${parsed.scope}\n\n` : '') +
        (parsed.constraints ? `## Ràng buộc\n\n${parsed.constraints}\n\n` : '') +
        `## Tiêu chí hoàn thành\n\n${acc || '_không tách được — xem toàn văn bên dưới_'}\n\n` +
        `<details><summary>Toàn văn brief</summary>\n\n${parsed.raw}\n\n</details>`,
      acceptance: parsed.acceptance,
      labels: [labelFor('status', 'ready')],
      debt: parsed.debt,
    });
  }
  return out;
}

/** Đọc các item đã có trên GitLab, lập bảng khoá → item để so idempotency. */
export async function fetchExisting(gitlab) {
  const issues = await gitlab.listAllIssues({ state: 'all', perPage: 100 });
  const map = new Map();
  for (const i of issues) {
    const meta = parseAgentMeta(i.description ?? '').meta;
    if (!meta?.source) continue;
    try {
      const key = sourceKeyFor({
        kind: meta.source.kind,
        capability: meta.source.capability,
        requirement: meta.source.requirement,
        slug: meta.source.slug,
      });
      map.set(key, { iid: i.iid, labels: i.labels, state: i.state, meta });
    } catch {
      /* meta không đủ để dựng khoá — bỏ qua, item này sẽ được coi là chưa tồn tại */
    }
  }
  return map;
}

/**
 * Chạy ingest.
 * `dryRun` mặc định TRUE ở tầng tool; ở đây phải truyền tường minh để không ai vô tình ghi thật.
 */
export function createIngestRunner({ root, gitlab, config, now = () => Date.now() }) {
  return {
    async run({ sources: which, dryRun = true } = {}) {
      const enabled = which?.length ? which : Object.entries(config.ingest ?? {}).filter(([, v]) => v).map(([k]) => k);

      /** @type {object[]} */ let sources = [];
      if (enabled.includes('spec')) sources = sources.concat(collectSpecSources(root));
      if (enabled.includes('changelog')) sources = sources.concat(collectChangelogSources(root));
      if (enabled.includes('brief')) sources = sources.concat(collectBriefSources(root));

      const existing = await fetchExisting(gitlab);
      const { plan, counts } = planIngest(sources, existing);
      const debt = collectDebt(sources);
      const runId = `ingest-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`;

      if (dryRun) {
        return { dryRun: true, runId, enabled, counts, debt, total: sources.length, plan: plan.map(summarize) };
      }

      const applied = [];
      for (const p of plan) {
        if (p.action === 'SKIP') continue;

        if (p.action === 'WARN_DRIFT') {
          await gitlab.createNote(p.iid, `⚠️ Nguồn \`${p.source.path}\` đã đổi trong lúc item đang được giữ. Không ghi đè — chủ claim tự quyết.`);
          await gitlab.updateIssue(p.iid, { add_labels: 'source-drifted' });
          applied.push({ action: p.action, iid: p.iid });
          continue;
        }

        const rendered = renderItem(p.source, { runId });
        if (p.action === 'UPDATE') {
          await gitlab.updateIssue(p.iid, { title: rendered.title, description: rendered.description });
          applied.push({ action: 'UPDATE', iid: p.iid });
          continue;
        }

        const created = await gitlab.createIssue({
          title: rendered.title, description: rendered.description, labels: rendered.labels,
        });
        // GitLab không cho tạo issue ở trạng thái closed trong một request ⇒ đóng ở bước hai.
        if (rendered.closeAfterCreate) await gitlab.closeIssue(created.iid);
        if (p.supersedes) {
          await gitlab.createNote(created.iid, `🔗 Thay cho #${p.supersedes} (nguồn đã đổi sau khi item cũ đóng).`);
        }
        applied.push({ action: p.action, iid: created.iid });
      }

      return { dryRun: false, runId, enabled, counts, debt, total: sources.length, applied };
    },
  };
}

const summarize = (p) => ({
  action: p.action,
  key: p.key,
  iid: p.iid ?? null,
  title: p.source.title,
  ...(p.note ? { note: p.note } : {}),
});

export { contentHash };
