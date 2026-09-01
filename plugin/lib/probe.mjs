// @ts-check
// Dò năng lực một GitLab instance: version, edition, tier, scoped label, work items GraphQL.
// Giải quyết giả định G1 của dự án (docs/01 §9, docs/07 §3). Chạy MỘT LẦN lúc cài đặt.
//
// ⚠️ Đây là tool DUY NHẤT ghi lên GitLab chỉ để dò. Ba luật riêng của file này:
//
//   1. KHÔNG BAO GIỜ kết luận từ dữ liệu vô nghĩa. Dò không được ⇒ `null` + một dòng trong
//      `unverified`, không được là `false`. Một `scoped_labels: false` sai làm cả server mô phỏng
//      scoped label vĩnh viễn trên instance vốn hỗ trợ sẵn — và không ai nghĩ tới việc dò lại.
//
//   2. Ghi thì phải DỌN, dọn không được thì phải NÓI RA. Rác để lại nằm ở `leftovers` kèm chỗ đi
//      xoá tay. Im lặng để lại hai nhãn `probe-scope::*` trong danh sách nhãn project là kiểu bẩn
//      mà về sau không ai biết từ đâu ra.
//
//   3. Suy ra ≠ đo được. Cái nào suy ra thì ghi vào `inferred` để người đọc phân biệt được.

import fs from 'node:fs';
import path from 'node:path';

/** Key của nhãn dùng cho phép thử tier. Chỉ tồn tại trong lúc dò rồi bị xoá. */
export const PROBE_LABEL_KEY = 'probe-scope';

/** Tầng cấu hình per-clone, không commit — đúng chỗ cho capabilities của một instance. */
export const LOCAL_BASENAME = 'agent-tasks-local.json';

const A = `${PROBE_LABEL_KEY}::a`;
const B = `${PROBE_LABEL_KEY}::b`;

/**
 * Ba câu hỏi trong MỘT round-trip.
 *
 * Dùng `__type` (introspection) thay vì truy vấn dữ liệu thật: không cần một WorkItem id có sẵn,
 * không đọc nội dung của ai, và không ghi gì. Đổi lại, instance nào tắt introspection thì cả ba
 * câu đều không dò được — ta báo đúng như vậy chứ không đoán.
 */
export const INTROSPECTION_QUERY = `query AgentTasksProbe {
  workItem: __type(name: "WorkItem") { name }
  customFields: __type(name: "WorkItemWidgetCustomFields") { name }
  queryType: __type(name: "Query") { fields { name } }
}`;

/**
 * `/metadata` → version + edition.
 * @param {any} data
 * @returns {{version: string|null, revision: string|null, edition: 'ee'|'ce'|null}}
 */
export function interpretMetadata(data) {
  return {
    version: typeof data?.version === 'string' ? data.version : null,
    revision: typeof data?.revision === 'string' ? data.revision : null,
    // Trường `enterprise` chỉ có từ GitLab 15.6. Vắng mặt ⇒ KHÔNG đoán: đoán "ce" ở đây sẽ kết
    // luận tier=free cho một instance Premium cũ, và server mô phỏng scoped label mãi không ai hiểu.
    edition: typeof data?.enterprise === 'boolean' ? (data.enterprise ? 'ee' : 'ce') : null,
  };
}

/**
 * Kết quả introspection → ba cờ năng lực.
 * @param {{data?: any, errors?: any[]|null}} res
 * @returns {{work_items_graphql: boolean|null, epic_graphql_removed: boolean|null,
 *            custom_fields: boolean|null, unverified: string[]}}
 */
export function interpretIntrospection(res) {
  /** @type {string[]} */ const unverified = [];
  const out = {
    work_items_graphql: /** @type {boolean|null} */ (null),
    epic_graphql_removed: /** @type {boolean|null} */ (null),
    custom_fields: /** @type {boolean|null} */ (null),
    unverified,
  };

  if (Array.isArray(res?.errors) && res.errors.length) {
    unverified.push(
      'work_items_graphql, epic_graphql_removed, custom_fields: GraphQL trả lỗi — ' +
        `${res.errors.map((e) => e?.message ?? String(e)).join('; ')}. ` +
        'Thường là introspection bị tắt hoặc token thiếu scope read_api. Thử tay: ' +
        `curl -H "PRIVATE-TOKEN: …" -H 'Content-Type: application/json' ` +
        `-d '{"query":"{ __typename }"}' <host>/api/graphql`,
    );
    return out;
  }

  const data = res?.data;
  if (!data || typeof data !== 'object') {
    unverified.push(
      'work_items_graphql, epic_graphql_removed, custom_fields: GraphQL không trả trường "data" ' +
        'nào (cũng không có "errors") — phản hồi không đúng dạng. Kiểm AGENT_TASKS_GITLAB_HOST có ' +
        'bị proxy chen vào không.',
    );
    return out;
  }

  // `'khoá' in data` chứ không phải `data.khoá != null`: KHÔNG CÓ khoá (không dò được) khác hẳn
  // khoá = null (type không tồn tại trên instance này).
  if ('workItem' in data) {
    out.work_items_graphql = data.workItem != null;
  } else {
    unverified.push('work_items_graphql: phản hồi không có trường "workItem" — không kết luận.');
  }

  if ('customFields' in data) {
    out.custom_fields = data.customFields != null;
    if (out.custom_fields) {
      // Schema CÓ type không đồng nghĩa dùng được. Trả `true` trơn sẽ khiến lớp trên đi gọi rồi
      // ăn lỗi license — và lỗi đó trông như bug của ta.
      unverified.push(
        'custom_fields: type có trong GraphQL schema, nhưng dùng được hay không do LICENSE quyết ' +
          '(Custom Fields cần Ultimate). Chưa thử tạo field thật. Xem Admin Area > Subscription.',
      );
    }
  } else {
    unverified.push('custom_fields: phản hồi không có trường "customFields" — không kết luận.');
  }

  const fields = data.queryType?.fields;
  if (Array.isArray(fields) && fields.length) {
    out.epic_graphql_removed = !fields.some((f) => f?.name === 'epic');
  } else {
    // Danh sách field RỖNG và KHÔNG ĐỌC ĐƯỢC là hai chuyện khác nhau. Gộp lại thành `true` là
    // tuyên bố "Epic API đã bị xoá" trong khi ta chỉ đơn giản không thấy gì.
    unverified.push(
      'epic_graphql_removed: không đọc được danh sách field của Query type nên không biết ' +
        '`Query.epic` còn hay đã bị xoá (GitLab 19.0 xoá nó). Không kết luận.',
    );
  }

  return out;
}

/**
 * Suy ra tier từ các dấu hiệu đã đo.
 *
 * Phép thử scoped label chỉ chia được "có tính năng trả tiền / không" — nó KHÔNG phân biệt Premium
 * với Ultimate, nên `premium` ở đây luôn kèm một dòng nói rõ điều đó.
 *
 * @param {{edition: 'ee'|'ce'|null, scopedLabels: boolean|null}} sig
 * @returns {{tier: 'free'|'premium'|'unknown', unverified: string[]}}
 */
export function guessTier({ edition, scopedLabels }) {
  /** @type {string[]} */ const unverified = [];

  if (scopedLabels === true) {
    unverified.push(
      'tier_guess: phép thử scoped label chỉ chia được "có tính năng trả tiền / không" — KHÔNG ' +
        'phân biệt Premium với Ultimate. Muốn chắc: Admin Area > Subscription, hoặc thử tạo một ' +
        'Custom Field (chỉ Ultimate cho).',
    );
    return { tier: 'premium', unverified };
  }
  if (scopedLabels === false) return { tier: 'free', unverified };
  // CE không thể chứa tính năng trả tiền — kết luận này chắc chắn, không cần thử ghi.
  if (edition === 'ce') return { tier: 'free', unverified };

  unverified.push(
    'tier_guess: chưa suy ra được vì phép thử scoped label không cho kết quả — xem dòng ' +
      'scoped_labels để biết vì sao.',
  );
  return { tier: 'unknown', unverified };
}

/** Những trường ĐO được. `capabilities` mà cả bảy đều null thì không mang thông tin nào. */
const MEASURED_KEYS = Object.freeze([
  'version',
  'edition',
  'scoped_labels',
  'custom_fields',
  'work_items_graphql',
  'epic_graphql_removed',
  'rate_limit_enabled',
]);

/** Đếm số trường thật sự dò ra được. */
export function countMeasured(capabilities) {
  return MEASURED_KEYS.filter((k) => capabilities?.[k] !== null && capabilities?.[k] !== undefined)
    .length;
}

/**
 * Ghi `capabilities`, GIỮ NGUYÊN mọi khoá khác trong file.
 *
 * ★ Ưu tiên **cấp máy** (`~/.agent-tasks/config.json`), rơi về per-clone khi không có.
 *
 * Vì sao cấp máy: `capabilities` là thuộc tính của **INSTANCE GitLab**, không của dự án. Một máy
 * nhiều dự án dùng chung một instance (spec 2026-08-13) thì probe một lần là đủ — ghi per-clone
 * buộc mỗi dự án probe lại để nhận kết quả y hệt, trái đúng mục tiêu "dự án mới 0 cấu hình".
 *
 * Máy dùng HAI instance thì `capabilities.host` là chỗ phát hiện: nó ghi host đã dò, nên đọc ra là
 * biết bản ghi này thuộc instance nào. Ai cần tách hẳn thì vẫn khai per-clone được (tầng `local`
 * thắng tầng `machine`).
 *
 * Fail-closed: file có sẵn mà không parse được thì KHÔNG ghi đè — người ta có thể đang có override
 * ttlSec/offlinePolicy trong đó, và mất nó thì server đổi hành vi mà không ai biết vì sao.
 *
 * @param {{gitDir?: string|null, machineDir?: string|null, capabilities: object}} arg
 * @returns {{ok: true, path: string, scope: 'machine'|'clone'} | {ok: false, error: string}}
 */
export function writeCapabilities({ gitDir, machineDir, capabilities }) {
  const target = machineDir
    ? { file: path.join(machineDir, 'config.json'), scope: /** @type {const} */ ('machine') }
    : gitDir
      ? { file: path.join(gitDir, LOCAL_BASENAME), scope: /** @type {const} */ ('clone') }
      : null;

  if (!target) {
    return {
      ok: false,
      error:
        'Không biết đặt kết quả ở đâu: không xác định được cả thư mục cấu hình cấp máy lẫn .git của ' +
        `repo. Chạy \`tasks-cli setup\` để tạo cấu hình cấp máy, hoặc chạy lệnh từ bên trong một git repo.`,
    };
  }

  const { file, scope } = target;

  /** @type {string|null} */ let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code !== 'ENOENT') {
      return {
        ok: false,
        error:
          `Không đọc được ${file} (${/** @type {Error} */ (err).message}) — không ghi, để tránh ` +
          'xoá mất cấu hình đang có ở đó. Kiểm quyền file rồi chạy lại.',
      };
    }
  }

  /** @type {Record<string, any>} */ let current = {};
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('nội dung không phải một object JSON');
      }
      current = parsed;
    } catch (err) {
      return {
        ok: false,
        error:
          `${file} không phải JSON hợp lệ (${/** @type {Error} */ (err).message}) — KHÔNG ghi đè ` +
          'để không mất cấu hình trong đó. Sửa tay file rồi chạy lại.',
      };
    }
  }

  try {
    fs.writeFileSync(file, `${JSON.stringify({ ...current, capabilities }, null, 2)}\n`);
  } catch (err) {
    return { ok: false, error: `Không ghi được ${file} (${/** @type {Error} */ (err).message}).` };
  }
  return { ok: true, path: file, scope };
}

/**
 * @param {{gitlab: object, config?: object, gitDir?: string|null, now?: () => number}} deps
 */
export function createProbeRunner({
  gitlab,
  config = {},
  gitDir = null,
  machineDir = null,
  now = () => Date.now(),
}) {
  /**
   * Phép thử tier: thêm `probe-scope::a` rồi `probe-scope::b`, đọc lại xem còn mấy cái.
   * Scoped label hoạt động ⇒ chỉ còn `::b`. Không ⇒ còn cả hai.
   *
   * Đây là phép thử CÓ GHI duy nhất của toàn bộ dự án ngoài luồng nghiệp vụ.
   *
   * @param {number} iid
   */
  async function probeScopedLabels(iid) {
    /** @type {string[]} */ const unverified = [];
    /** @type {string[]} */ const leftovers = [];

    // Biết nhãn nào CÓ TRƯỚC để chỉ xoá đúng cái mình tạo ra. `null` = không biết ⇒ không xoá gì.
    /** @type {Set<string>|null} */ let preexisting = null;
    try {
      preexisting = new Set(
        ((await gitlab.listLabels()) ?? []).map((l) => l?.name).filter(Boolean),
      );
    } catch (err) {
      unverified.push(
        `dọn nhãn probe: không liệt kê được nhãn của project (${/** @type {Error} */ (err).message}) ` +
          'nên KHÔNG xoá nhãn nào ở cấp project — thà để lại rác còn hơn xoá nhãn của bạn.',
      );
    }

    /** @type {boolean|null} */ let value = null;
    let touched = false;

    try {
      await gitlab.updateIssue(iid, { add_labels: A });
      touched = true;
      await gitlab.updateIssue(iid, { add_labels: B });

      const issue = await gitlab.getIssue(iid);
      const labels = new Set(issue?.labels ?? []);
      const hasA = labels.has(A);
      const hasB = labels.has(B);

      if (hasA && hasB) value = false;
      else if (hasB && !hasA) value = true;
      else {
        // Không thấy nhãn nào ⇒ PUT không có tác dụng. Trả `false` ở đây là tuyên bố sai về một
        // instance có thể đang là Premium.
        unverified.push(
          `scoped_labels: đã thử trên #${iid} nhưng đọc lại không thấy nhãn ${PROBE_LABEL_KEY}::* ` +
            `nào (thấy: ${[...labels].join(', ') || 'không có nhãn'}). KHÔNG kết luận. Thường là ` +
            `token chỉ có scope read_api nên PUT bị bỏ qua, hoặc #${iid} không tồn tại. Kiểm quyền ` +
            'token rồi chạy lại.',
        );
      }
    } catch (err) {
      unverified.push(
        `scoped_labels: phép thử trên #${iid} thất bại — ${/** @type {Error} */ (err).message}. ` +
          'Cần token scope `api` (ghi) và một issue nháp còn mở. Chạy ' +
          '`node bin/tasks-cli.mjs verify` để kiểm token.',
      );
    } finally {
      // Dọn trong `finally`: lỗi giữa đường vẫn không được để nhãn probe nằm lại trên issue.
      if (touched) {
        try {
          await gitlab.updateIssue(iid, { remove_labels: `${A},${B}` });
        } catch (err) {
          leftovers.push(
            `nhãn ${A} và ${B} có thể còn trên issue #${iid} ` +
              `(${/** @type {Error} */ (err).message}) — xoá tay trên GitLab.`,
          );
        }

        // GitLab tự tạo nhãn ở cấp project khi add vào issue. Không xoá thì để lại rác vĩnh viễn
        // trong danh sách nhãn — mà về sau không ai biết nó từ đâu ra.
        if (preexisting) {
          for (const name of [A, B]) {
            if (preexisting.has(name)) continue;
            try {
              await gitlab.deleteLabel(name);
            } catch (err) {
              leftovers.push(
                `nhãn ${name} còn trong danh sách nhãn project ` +
                  `(${/** @type {Error} */ (err).message}) — xoá ở Project > Labels.`,
              );
            }
          }
        } else {
          leftovers.push(
            `có thể còn nhãn ${A} / ${B} trong danh sách nhãn project — kiểm ở Project > Labels ` +
              'và xoá nếu không phải nhãn của bạn.',
          );
        }
      }
    }

    return { value, unverified, leftovers };
  }

  return {
    /**
     * @param {{probe_issue_iid?: number|null, write?: boolean}} [a]
     */
    async run(a = {}) {
      const probedAt = new Date(now()).toISOString();
      /** @type {string[]} */ const unverified = [];
      /** @type {string[]} */ const leftovers = [];
      /** Điều SUY RA chứ không đo được — người đọc phải phân biệt được hai loại. */
      /** @type {string[]} */ const inferred = [];

      // ── 1. version + edition ───────────────────────────────────────────
      /** @type {string|null} */ let version = null;
      /** @type {string|null} */ let revision = null;
      /** @type {'ee'|'ce'|null} */ let edition = null;
      try {
        const m = interpretMetadata(await gitlab.metadata());
        version = m.version;
        revision = m.revision;
        edition = m.edition;
        if (edition === null) {
          unverified.push(
            'edition: /metadata không trả trường "enterprise" (trường này chỉ có từ GitLab 15.6) ' +
              '— không biết CE hay EE. Xem Help > About trên web UI.',
          );
        }
      } catch (err) {
        unverified.push(
          `version, edition: gọi /metadata thất bại — ${/** @type {Error} */ (err).message}. ` +
            'Cần token còn sống với scope `read_api`. Kiểm: node bin/tasks-cli.mjs verify',
        );
      }

      // ── 2. GraphQL: work items · epic · custom fields ──────────────────
      let intro = {
        work_items_graphql: /** @type {boolean|null} */ (null),
        epic_graphql_removed: /** @type {boolean|null} */ (null),
        custom_fields: /** @type {boolean|null} */ (null),
        unverified: /** @type {string[]} */ ([]),
      };
      try {
        intro = interpretIntrospection(await gitlab.graphql(INTROSPECTION_QUERY));
      } catch (err) {
        unverified.push(
          'work_items_graphql, epic_graphql_removed, custom_fields: gọi /api/graphql thất bại — ' +
            `${/** @type {Error} */ (err).message}. Lõi dự án chỉ dùng REST nên đây KHÔNG chặn ` +
            'việc dùng bình thường; chỉ là chưa biết instance có Work Items GraphQL hay không.',
        );
      }
      unverified.push(...intro.unverified);

      // ── 3. rate limit ─────────────────────────────────────────────────
      /** @type {boolean|null} */ let rateLimitEnabled = null;
      try {
        rateLimitEnabled = Boolean((await gitlab.rateLimit()).enabled);
      } catch (err) {
        unverified.push(
          `rate_limit_enabled: không đọc được header rate limit — ${/** @type {Error} */ (err).message}.`,
        );
      }

      // ── 4. tier qua scoped label (phép thử CÓ GHI) ────────────────────
      /** @type {boolean|null} */ let scopedLabels = null;
      if (edition === 'ce') {
        // CE không thể có scoped label loại trừ. Ghi lên issue của người ta để "xác nhận" điều đã
        // biết là ghi vô ích — và đây là tool chạy trên project thật của họ.
        scopedLabels = false;
        inferred.push(
          'scoped_labels=false suy ra từ edition CE (bản CE không chứa tính năng trả tiền) — ' +
            'không thực hiện phép thử ghi lên issue.',
        );
      } else if (a.probe_issue_iid == null) {
        unverified.push(
          'scoped_labels, tier_guess: chưa thử vì không có issue nháp. Chạy lại với ' +
            `probe_issue_iid = iid của một issue nháp — phép thử CÓ GHI (thêm ${A} và ${B} rồi xoá).`,
        );
      } else {
        const r = await probeScopedLabels(Number(a.probe_issue_iid));
        scopedLabels = r.value;
        unverified.push(...r.unverified);
        leftovers.push(...r.leftovers);
      }

      const tier = guessTier({ edition, scopedLabels });
      // Nhánh "không có issue nháp" ở trên đã nói cả scoped_labels lẫn tier_guess. Hai dòng cùng ý
      // làm loãng danh sách — và danh sách loãng thì người ta bỏ qua cả danh sách.
      if (!unverified.some((u) => u.startsWith('scoped_labels, tier_guess:'))) {
        unverified.push(...tier.unverified);
      }

      const capabilities = {
        // Ghi host + probed_at để phát hiện capabilities lạc chủ: đổi AGENT_TASKS_GITLAB_HOST mà
        // file cũ còn nằm đó thì mọi quyết định theo tier đều sai, và không có hai trường này thì
        // không cách nào biết.
        host: config.gitlabHost ?? null,
        project_path: config.projectPath ?? null,
        probed_at: probedAt,
        version,
        revision,
        edition,
        tier_guess: tier.tier,
        scoped_labels: scopedLabels,
        custom_fields: intro.custom_fields,
        work_items_graphql: intro.work_items_graphql,
        epic_graphql_removed: intro.epic_graphql_removed,
        rate_limit_enabled: rateLimitEnabled,
        unverified: [...unverified],
        inferred: [...inferred],
      };

      // Cùng thứ tự ưu tiên với writeCapabilities — nếu lệch thì `next` sẽ chỉ sai đường dẫn.
      const writeTarget = machineDir
        ? path.join(machineDir, 'config.json')
        : gitDir
          ? path.join(gitDir, LOCAL_BASENAME)
          : null;
      const measured = countMeasured(capabilities);
      let written = false;
      /** @type {string|null} */ let writeError = null;

      if (a.write === true && measured === 0) {
        // Ghi một `capabilities` toàn null là tệ hơn không ghi: `DEFAULTS.capabilities = null` có
        // nghĩa "chưa dò", nên file rỗng-nghĩa lại làm lần sau tưởng ĐÃ dò rồi và không ai chạy lại.
        writeError =
          'Không dò được trường nào (mọi phép thử đều thất bại) nên KHÔNG ghi capabilities — một ' +
          'file toàn null sẽ làm lần sau tưởng đã dò rồi. Sửa kết nối/token trước: ' +
          '`node bin/tasks-cli.mjs verify`.';
      } else if (a.write === true) {
        const w = writeCapabilities({ gitDir, machineDir, capabilities });
        written = w.ok;
        writeError = w.ok ? null : w.error;
      }

      return {
        ...capabilities,
        unverified,
        leftovers,
        inferred,
        /** Số trường ĐO được (trên 7). 0 ⇒ kết quả này không dùng được cho việc gì. */
        measured,
        written,
        write_target: writeTarget,
        write_error: writeError,
        write_scope: written ? (machineDir ? 'machine' : 'clone') : null,
        next: written
          ? (machineDir
              ? 'Đã lưu ở CẤP MÁY — mọi dự án trên máy này dùng chung kết quả, không phải probe lại.'
              : 'Đã lưu cho clone này. Chạy `tasks-cli setup` trước rồi probe lại thì kết quả dùng được cho mọi dự án.')
          : a.write === true
            ? 'CHƯA lưu — xem write_error.'
            : measured === 0
              ? 'Không dò được gì cả. Kiểm host/token bằng `node bin/tasks-cli.mjs verify` rồi chạy lại.'
              : `Chưa lưu (mặc định chỉ dò). Chạy lại với write=true (CLI: --write) để ghi vào ${writeTarget ?? `<git-dir>/${LOCAL_BASENAME}`}.`,
      };
    },
  };
}
