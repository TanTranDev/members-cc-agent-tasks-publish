// @ts-check
// GitLab REST v4 client — mỏng, chỉ những endpoint dự án này thật sự dùng.
//
// Vì sao REST chứ không GraphQL: xem docs/01 §1.5. Tóm tắt — REST đủ cho CRUD + polling, ổn
// định hơn, và không dính trần complexity 200 mà self-managed không chỉnh được. GraphQL chỉ
// cần khi dùng Status widget / Custom Fields, mà cả hai đều là Premium nên không áp dụng ở đây.
//
// Điểm riêng của FREE TIER nằm ở `setExclusiveLabel`: scoped label không loại trừ nên phải mô
// phỏng ở client. Xem lib/schema.mjs.

import { exclusiveLabelUpdate, parseLabels } from './schema.mjs';

const MAX_PER_PAGE = 100;
const MAX_RETRIES = 3;
const DEFAULT_MAX_PAGES = 50;

class GitLabError extends Error {
  /** @param {{status: number, kind: string, body?: unknown}} info */
  constructor(message, { status, kind, body }) {
    super(message);
    this.status = status;
    this.kind = kind;
    this.body = body;
  }
}

/** HTTP status → loại lỗi mà lớp trên map sang thông điệp cho agent. */
function kindOf(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server';
  return 'client';
}

export function createGitLabClient({
  host,
  projectPath,
  token,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  maxPages = DEFAULT_MAX_PAGES,
}) {
  const apiRoot = String(host).replace(/\/+$/, '');
  const base = `${apiRoot}/api/v4`;
  const proj = encodeURIComponent(projectPath);

  /**
   * Vòng gửi-và-thử-lại dùng chung cho CẢ BA đường ra: REST JSON, multipart upload, GraphQL.
   * Chỉ retry 429 và 5xx — 4xx khác là lỗi của phía ta, thử lại vô ích.
   *
   * `initFactory` là HÀM chứ không phải object, và đó là điểm quan trọng: body của FormData chỉ
   * đọc được MỘT lần, nên mỗi lần thử phải dựng lại. Truyền sẵn một object là bug chỉ hiện ra ở
   * lần retry đầu tiên — nghĩa là chỉ hiện khi đang có sự cố.
   *
   * @param {string} url
   * @param {() => RequestInit} initFactory
   * @param {string} label  Mô tả lời gọi, đi vào message lỗi.
   * @param {(status: number) => string} [hintFor]  Gợi ý thêm theo status.
   */
  async function sendWithRetry(url, initFactory, label, hintFor = () => '') {
    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await fetchImpl(url, initFactory());
      if (res.ok) return res;

      const kind = kindOf(res.status);
      const payload = await res.json().catch(() => ({}));
      lastErr = new GitLabError(
        `GitLab ${label} → ${res.status}` +
          (payload?.message ? ` (${JSON.stringify(payload.message)})` : '') +
          hintFor(res.status),
        { status: res.status, kind, body: payload },
      );

      if (kind !== 'rate-limited' && kind !== 'server') throw lastErr;
      if (attempt === MAX_RETRIES) break;

      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 500);
    }
    throw lastErr;
  }

  /** Đọc JSON của một phản hồi đã ok. 204 là hợp lệ và KHÔNG có body. */
  async function readJson(res, label) {
    if (res.status === 204) return null;
    try {
      return await res.json();
    } catch (err) {
      // Proxy/SSO chèn trang HTML là ca thật. SyntaxError thô không nói được gì cho agent.
      throw new GitLabError(
        `GitLab ${label} → ${res.status} nhưng không đọc được phản hồi JSON ` +
          `(${/** @type {Error} */ (err).message}). Thường là proxy/SSO chèn trang HTML vào giữa — ` +
          `kiểm AGENT_TASKS_GITLAB_HOST có trỏ đúng API không.`,
        { status: res.status, kind: 'server' },
      );
    }
  }

  async function request(method, pathname, { query, body } = {}) {
    const url = new URL(`${base}${pathname}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    const label = `${method} ${pathname}`;
    const res = await sendWithRetry(
      url.toString(),
      () => ({
        method,
        // Token đi ở HEADER, không bao giờ ở URL — URL lọt vào log proxy và history.
        headers: {
          'PRIVATE-TOKEN': token ?? '',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      label,
    );
    return { data: await readJson(res, label), headers: res.headers };
  }

  const issuesPath = `/projects/${proj}/issues`;

  /** Chuẩn hoá query cho list. */
  const listQuery = (o = {}) => ({
    labels: Array.isArray(o.labels) ? o.labels.join(',') : o.labels,
    state: o.state,
    updated_after: o.updatedAfter,
    search: o.search,
    per_page: Math.min(Number(o.perPage) || 20, MAX_PER_PAGE),
    page: o.page,
    order_by: o.orderBy,
    sort: o.sort,
  });

  return {
    /**
     * Upload một file lên project, trả về link markdown dùng được trong description/comment.
     *
     * GitLab KHÔNG có "trường attachment" cho work item — cơ chế thật là upload vào project rồi
     * chèn link markdown vào text. Endpoint này có ở tier Free, self-managed.
     *
     * ⚠️ Không dùng `request()` như các method khác: `request()` đặt `Content-Type:
     * application/json`, còn multipart phải để runtime tự đặt để có `boundary`. Tự đặt là 400.
     *
     * @param {{filename: string, content: string}} arg
     * @returns {Promise<{id: number|null, url: string, markdown: string, full_path: string|null}>}
     */
    async uploadFile({ filename, content }) {
      // Kiểm trước khi chạm mạng: hai lỗi này biết chắc sẽ sai, gọi đi là tốn một round-trip
      // và nhận lại một message của GitLab khó hiểu hơn.
      if (!filename || !String(filename).trim()) {
        throw new GitLabError('uploadFile: filename rỗng — phải có tên file để đặt trên GitLab.', {
          kind: 'bad-request',
        });
      }
      if (!content || !String(content).length) {
        throw new GitLabError(
          `uploadFile: nội dung rỗng cho "${filename}" — GitLab từ chối file rỗng. ` +
            `Kiểm lại file nguồn trên đĩa.`,
          { kind: 'bad-request' },
        );
      }

      const url = `${base}/projects/${proj}/uploads`;
      const label = `POST /uploads (${filename})`;

      // Retry 429/5xx như mọi lời gọi khác của client này. Bản đầu gọi fetch MỘT lần, nên một 429
      // duy nhất làm chết cả lượt đính tài liệu và để lại upload mồ côi trên project.
      const res = await sendWithRetry(
        url,
        () => ({
          method: 'POST',
          // Token ở HEADER, không bao giờ ở URL. KHÔNG đặt Content-Type — multipart cần boundary
          // do runtime sinh.
          headers: { 'PRIVATE-TOKEN': token ?? '' },
          // FormData dựng LẠI mỗi lần thử: body của lần trước đã bị tiêu thụ.
          body: (() => {
            const form = new FormData();
            form.append(
              'file',
              new Blob([String(content)], { type: 'text/markdown' }),
              String(filename),
            );
            return form;
          })(),
        }),
        label,
        (status) =>
          status === 413
            ? ` File quá lớn so với giới hạn của instance — kiểm "Maximum attachment size" trong Admin Area.`
            : status === 404
              ? ` Kiểm AGENT_TASKS_PROJECT_PATH và quyền của token (cần scope api).`
              : '',
      );

      const data = await readJson(res, label);
      if (!data?.url || !data?.markdown) {
        throw new GitLabError(
          `GitLab ${label} → ${res.status} nhưng phản hồi thiếu "url"/"markdown" ` +
            `(nhận: ${JSON.stringify(data).slice(0, 200)}). Không ghi link để tránh đặt ` +
            `"undefined" vào description. Kiểm phiên bản GitLab của instance.`,
          { status: res.status, kind: 'server', body: data },
        );
      }

      return {
        id: data.id ?? null,
        url: data.url,
        markdown: data.markdown,
        full_path: data.full_path ?? null,
      };
    },

    /**
     * ── Ba method dưới đây chỉ `lib/probe.mjs` dùng ────────────────────────
     * Chúng ở đây thay vì trong probe.mjs để probe không phải tự dựng lại vòng retry và quy ước
     * header — đúng lý do uploadFile cũng nằm ở file này.
     */

    /**
     * Version + edition của instance.
     *
     * ⚠️ `enterprise: true` nghĩa là bản EE, KHÔNG nói lên tier Free/Premium/Ultimate — EE chạy
     * không license vẫn là Free. Chỉ chiều phủ định là chắc: CE thì không thể có tính năng trả tiền.
     */
    async metadata() {
      return (await request('GET', '/metadata')).data;
    },

    /**
     * Một truy vấn GraphQL.
     *
     * ⚠️ KHÔNG throw khi GraphQL trả `errors`: endpoint này trả HTTP 200 kèm errors, và chính nội
     * dung errors là thứ probe cần đọc ("field not found" ⇒ Epic API đã bị xoá). Throw đi là mất
     * đúng cái thông tin đang đi tìm. Lỗi HTTP thật (4xx/5xx) thì vẫn throw như mọi lời gọi khác.
     *
     * @returns {Promise<{ok: true, status: number, data: object|null, errors: object[]|null}>}
     */
    async graphql(query, variables) {
      // GraphQL KHÔNG nằm dưới /api/v4 — dùng apiRoot, không dùng base.
      const label = 'POST /api/graphql';
      const res = await sendWithRetry(
        `${apiRoot}/api/graphql`,
        () => ({
          method: 'POST',
          headers: { 'PRIVATE-TOKEN': token ?? '', 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables }),
        }),
        label,
        (status) =>
          status === 404
            ? ' Instance có thể đã tắt GraphQL — không dò được năng lực bằng đường này.'
            : '',
      );
      const payload = await readJson(res, label);
      return {
        ok: true,
        status: res.status,
        data: payload?.data ?? null,
        errors: Array.isArray(payload?.errors) && payload.errors.length ? payload.errors : null,
      };
    },

    /**
     * Instance có bật rate limit không — đọc từ header của một lời gọi rẻ nhất.
     * Không bật thì header vắng mặt, đó là kết quả HỢP LỆ chứ không phải lỗi.
     */
    async rateLimit() {
      const res = await request('GET', '/projects', { query: { per_page: 1, membership: true } });
      const h = res.headers;
      const get = (name) => h.get(name) ?? h.get(name.toLowerCase()) ?? null;
      const limit = get('RateLimit-Limit');
      return {
        enabled: Boolean(limit),
        limit,
        remaining: get('RateLimit-Remaining'),
        observed_on: 'GET /projects',
      };
    },

    /**
     * Token này là ai? Dùng để xác nhận token sống trước khi ghi bất cứ thứ gì.
     *
     * Group/Project Access Token cũng trả về một "user" (bot user) — nên đây là phép thử đúng
     * cho cả PAT lẫn group token.
     */
    async whoami() {
      return (await request('GET', '/user')).data;
    },

    /**
     * Metadata project backlog. Xác nhận ba điều một lượt: project tồn tại, token thấy được nó,
     * và Issues có bật (`issues_enabled`) — thiếu cái cuối thì mọi thao tác task sẽ chết sau này
     * với lỗi 404 khó hiểu.
     */
    async getProject() {
      return (await request('GET', `/projects/${proj}`)).data;
    },

    async getIssue(iid) {
      return (await request('GET', `${issuesPath}/${iid}`)).data;
    },

    async listIssues(opts = {}) {
      return (await request('GET', issuesPath, { query: listQuery(opts) })).data;
    },

    /**
     * Đi hết các trang. CÓ TRẦN `maxPages`: server trả `x-next-page` mãi (lỗi hoặc cố ý) thì
     * vòng lặp không được phép chạy vô hạn.
     */
    async listAllIssues(opts = {}) {
      const out = [];
      let page = 1;
      for (let i = 0; i < maxPages; i++) {
        const res = await request('GET', issuesPath, { query: { ...listQuery(opts), page } });
        out.push(...res.data);
        const next = res.headers.get('x-next-page');
        if (!next) break;
        page = Number(next);
      }
      return out;
    },

    async createIssue({ title, description, labels = [], assigneeId, milestoneId }) {
      return (
        await request('POST', issuesPath, {
          body: {
            title,
            description,
            labels: labels.join(','),
            assignee_id: assigneeId,
            milestone_id: milestoneId,
          },
        })
      ).data;
    },

    async updateIssue(iid, patch) {
      return (await request('PUT', `${issuesPath}/${iid}`, { body: patch })).data;
    },

    async closeIssue(iid) {
      return (await request('PUT', `${issuesPath}/${iid}`, { body: { state_event: 'close' } })).data;
    },

    async createNote(iid, bodyText) {
      return (await request('POST', `${issuesPath}/${iid}/notes`, { body: { body: bodyText } })).data;
    },

    async listNotes(iid, { perPage = 20 } = {}) {
      return (await request('GET', `${issuesPath}/${iid}/notes`, { query: { per_page: perPage } })).data;
    },

    async listLabels() {
      return (await request('GET', `/projects/${proj}/labels`, { query: { per_page: MAX_PER_PAGE } })).data;
    },

    /** Tạo nhãn. Đã tồn tại (409) là kết quả HỢP LỆ, không phải lỗi — ingest chạy lại được. */
    async createLabel({ name, color, description }) {
      try {
        const data = (
          await request('POST', `/projects/${proj}/labels`, { body: { name, color, description } })
        ).data;
        return { ...data, existed: false };
      } catch (err) {
        if (/** @type {any} */ (err)?.kind === 'conflict') return { name, existed: true };
        throw err;
      }
    },

    /**
     * Xoá một nhãn khỏi project. Dùng để `probe` dọn nhãn thử của chính nó.
     *
     * ⚠️ Tên nhãn PHẢI encode: nhãn scoped chứa `::`, để nguyên thì `:` biến thành phân đoạn
     * đường dẫn khác và GitLab trả 404 — trông như "nhãn không tồn tại" trong khi nó vẫn còn đó.
     */
    async deleteLabel(name) {
      await request('DELETE', `/projects/${proj}/labels/${encodeURIComponent(name)}`);
      return { name, deleted: true };
    },

    /**
     * ★ FREE TIER: đặt một giá trị cho `key`, loại bỏ mọi giá trị cũ cùng key.
     *
     * Trên Premium, scoped label tự làm việc này. Trên Free thì không, nên:
     *   1. một PUT mang CẢ remove_labels lẫn add_labels — GitLab áp cùng lúc, không có khe;
     *   2. đọc kết quả trả về, nếu vẫn còn nhiều giá trị cùng key thì dọn thêm một lượt.
     * Bước 2 là chỗ khác biệt thật giữa Free và Premium, và là lý do hàm này tồn tại.
     */
    async setExclusiveLabel(iid, key, value, opts = {}) {
      const current = await this.getIssue(iid);
      const plan = exclusiveLabelUpdate(current.labels ?? [], key, value);
      // Nhãn cờ cần gỡ CÙNG lượt với việc đổi status. Đi kèm ở đây chứ không PUT
      // riêng, vì cùng lý do đã nêu trên: một request thì không có khe giữa hai
      // trạng thái. `stale` chỉ chứa cờ đang THỰC SỰ có mặt, nên không gửi rác.
      const stale = (opts.alsoRemove ?? []).filter((l) => (current.labels ?? []).includes(l));
      if (plan.noop && stale.length === 0) return current;

      let updated = await this.updateIssue(iid, {
        add_labels: plan.add.join(','),
        remove_labels: [...plan.remove, ...stale].join(','),
      });

      const { duplicates } = parseLabels(updated.labels ?? []);
      if (duplicates[key]?.length > 1) {
        const stale = (updated.labels ?? []).filter(
          (l) => l.startsWith(`${key}::`) && l !== `${key}::${value}`,
        );
        updated = await this.updateIssue(iid, { remove_labels: stale.join(',') });
      }
      return updated;
    },
  };
}
