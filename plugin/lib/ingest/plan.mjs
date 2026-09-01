// @ts-check
// Lập kế hoạch ingest: nguồn → CREATE / SKIP / UPDATE, có khoá idempotency.
//
// Ingest chạy lại là chuyện thường (thêm spec mới, sửa brief). Tạo trùng 126 item thì dọn rất
// đau, nên khoá idempotency ở đây là phần BẮT BUỘC ĐÚNG, không phải tối ưu.

import crypto from 'node:crypto';

import { writeAgentMeta, META_VERSION } from '../schema.mjs';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/**
 * Khoá tự nhiên của một nguồn. Phải ỔN ĐỊNH qua các lần chạy, kể cả khi nội dung đổi.
 * - spec: tên requirement NGUYÊN VĂN là ID duy nhất (docs/03 §2.2) — băm để rút ngắn.
 * - changelog: tên file, vì frontmatter đã trôi qua ba thế hệ (docs/03 §3.4).
 * - brief: tên thư mục.
 */
export function sourceKeyFor(source) {
  switch (source.kind) {
    case 'spec':
      return `spec:${source.capability}:${sha256(source.requirement).slice(0, 16)}`;
    case 'changelog':
      return `changelog:${source.slug}`;
    case 'brief':
      return `brief:${source.slug}`;
    default:
      throw new Error(`nguồn không rõ loại: ${JSON.stringify(source.kind)}`);
  }
}

/** Vân tay nội dung — quyết định SKIP hay UPDATE. */
export const contentHash = (text) => sha256(text).slice(0, 32);

/**
 * So một tập nguồn với các item đã có trên GitLab.
 *
 * Bốn nhánh, và nhánh `claimed` là chỗ dễ bỏ sót nhất: ghi đè description của item ai đó đang
 * làm sẽ xoá mất ngữ cảnh họ đang đọc (docs/02 §5.4 — "ghi đè trạng thái người thật đang sửa").
 *
 * @param {object[]} sources đã parse, mỗi cái có {kind, …, body, title}
 * @param {Map<string, object>} existing khoá → item GitLab {iid, labels, state, meta}
 */
export function planIngest(sources, existing) {
  /** @type {object[]} */ const plan = [];

  for (const s of sources) {
    const key = sourceKeyFor(s);
    const hash = contentHash(s.body);
    const item = existing.get(key);

    if (!item) {
      plan.push({ action: 'CREATE', key, hash, source: s });
      continue;
    }
    if (item.meta?.source?.hash === hash) {
      plan.push({ action: 'SKIP', key, hash, iid: item.iid, source: s });
      continue;
    }

    const status = (item.labels ?? []).find((l) => l.startsWith('status::'))?.slice(8);
    if (status === 'claimed') {
      // KHÔNG ghi đè. Ai đó đang đọc chính description này.
      plan.push({
        action: 'WARN_DRIFT',
        key, hash, iid: item.iid, source: s,
        note:
          `Nguồn đã đổi nhưng item #${item.iid} đang có người giữ (status::claimed) — ` +
          `không ghi đè. Gắn nhãn source-drifted và ghi note để chủ claim tự quyết.`,
      });
      continue;
    }
    if (item.state === 'closed') {
      plan.push({
        action: 'CREATE_SUPERSEDING',
        key: `${key}:${hash.slice(0, 8)}`, hash, supersedes: item.iid, source: s,
        note: `Item #${item.iid} đã đóng mà nguồn đổi ⇒ tạo item mới, liên kết tới cái cũ.`,
      });
      continue;
    }
    plan.push({ action: 'UPDATE', key, hash, iid: item.iid, source: s });
  }

  const counts = plan.reduce((a, p) => ({ ...a, [p.action]: (a[p.action] ?? 0) + 1 }), {});
  return { plan, counts };
}

/** Gom nợ metadata của cả lô — để ingest xuất báo cáo thay vì im lặng bỏ qua. */
export function collectDebt(sources) {
  return sources
    .filter((s) => s.debt?.length)
    .map((s) => ({ key: sourceKeyFor(s), debt: s.debt }));
}

/** Dựng description hoàn chỉnh (phần người + khối agent-meta) cho một nguồn. */
export function renderItem(source, { runId } = {}) {
  const meta = {
    v: META_VERSION,
    source: {
      kind: source.kind,
      path: source.path ?? null,
      hash: contentHash(source.body),
      ...(source.kind === 'spec'
        ? { capability: source.capability, requirement: source.requirement }
        : { slug: source.slug }),
    },
    shape: source.shape ?? null,
    care: source.care ?? null,
    hazard: null,
    role_hint: source.roleHint ?? null,
    acceptance: source.acceptance ?? [],
    spec_delta: [],
    risk_declared: null,
    review_required: false,
    observe: 'l0',
    ingest_run: runId ?? null,
    links: source.links ?? {},
    history: [],
  };

  return {
    title: source.title,
    description: writeAgentMeta(source.humanBody ?? source.body, meta),
    labels: source.labels ?? [],
    closeAfterCreate: source.kind === 'changelog',
    meta,
  };
}
