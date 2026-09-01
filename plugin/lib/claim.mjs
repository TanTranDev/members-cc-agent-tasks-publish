// @ts-check
// Claim engine — compare-and-swap phân tán bằng git refs.
//
// VÌ SAO GIT REFS: GitLab không có CAS qua API (gitlab-org/gitlab#328664 còn mở), nên mọi cơ chế
// "gắn label để giành việc" đều còn race window. `git push --force-with-lease=<ref>:<expect>`
// thì CHỈ thắng nếu ref trên remote vẫn đúng <expect> — và phép so đó do GIT SERVER thực thi.
// Đây là mô hình cc-lock v2 đã chạy production, đổi đơn vị khoá từ đường dẫn file sang work item.
// Chi tiết: project-agent-task-management/docs/05-design-claim-protocol.md
//
// KHÁC cc-lock ở một điểm quan trọng: owner có SESSION_ID. cc-lock coi hai session mở cùng thư
// mục là MỘT clone và không chặn nhau — đúng cho khoá file, SAI cho khoá task.
//
// Nguyên thuỷ git (kho tạm + hai thao tác CAS) sống ở lib/claim-git.mjs — tầng đó chỉ biết ref
// và sha; tầng này biết TTL, quyền sở hữu, và chính sách khi mất mạng.

import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  prepareScratch,
  casPushClaim,
  casDeleteClaim,
  runGit,
  LocalSetupError,
} from './claim-git.mjs';
import { makePayloadIO, buildPayload } from './claim-payload.mjs';

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

/** Khoá định danh một work item, đủ để hai project không đụng nhau. */
export function itemKeyFor(gitlabHost, projectPath, iid) {
  return `${gitlabHost}/${projectPath}#${iid}`;
}

/** Tên ref cho một item. Mỗi item một ref ⇒ không có bottleneck một-branch. */
export function refNameFor(namespace, projectKey, itemKey) {
  return `${namespace}/${projectKey}/${sha1(itemKey)}`;
}

/**
 * Định danh chủ khoá. CÓ sessionId ⇒ hai phiên cùng máy cùng thư mục vẫn phân biệt được.
 * KHÔNG có pid: pid đổi khi tiến trình khởi động lại, nhưng phiên thì chưa chắc đã đổi.
 */
export function ownerIdFor({ host, clonePath, sessionId }) {
  return sha1(`${host}\0${clonePath}\0${sessionId}`);
}

/**
 * Claim đã hết hạn tới mức người khác được phép thu hồi chưa?
 * Điều kiện: expires_at + skew + grace < now
 * Ba toán hạng tách bạch để mutation test đảo được từng cái.
 * expires_at hỏng/thiếu ⇒ KHÔNG coi là hết hạn (fail-closed: thà kẹt còn hơn cướp nhầm).
 */
export function isExpired(claim, nowMs, skewSec, graceSec) {
  const exp = Date.parse(claim?.expires_at ?? '');
  if (!Number.isFinite(exp)) return false;
  return exp + (skewSec + graceSec) * 1000 < nowMs;
}

/**
 * @param {{config: object, identity: object, gitEnv?: object, now?: () => number}} opts
 */
export function createClaimEngine({ config, identity, gitEnv, now }) {
  const nowMs = now ?? (() => Date.now());
  const env = { ...(gitEnv ?? process.env), GIT_TERMINAL_PROMPT: '0' };
  const url = config.claimRepoUrl;
  const ns = config.refNamespace ?? 'refs/claims';
  const projectKey = config.projectKey;
  const ownerId = ownerIdFor(identity);

  // Kho tạm — riêng cho từng tiến trình. Lý do ở lib/claim-payload.mjs → prepareScratch.
  /** @type {string|null} */
  let scratch = null;

  const git = (args, { cwd = scratch, allowFail = false } = {}) =>
    runGit(args, { cwd, env, allowFail });

  function ensureScratch() {
    if (scratch) return scratch;
    const dir = prepareScratch(env);
    scratch = dir;
    process.once('exit', () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* dọn dẹp best-effort — tiến trình đang thoát, không còn gì để báo cáo */
      }
    });
    return dir;
  }

  const { remoteSha, readPayload } = makePayloadIO({ git, url });
  const payloadFor = (itemKey, ref, ttlSec, previous) =>
    buildPayload({ identity, ownerId, itemKey, ref, ttlSec, previous, nowMs });

  const casPush = (ref, payload, expectSha) =>
    casPushClaim({ url, ref, payload, expectSha, scratchDir: ensureScratch(), env });

  const casDelete = (ref, expectSha) =>
    casDeleteClaim({ url, ref, expectSha, scratchDir: ensureScratch(), env });

  /**
   * Quy một lỗi hạ tầng về mã lý do ĐÚNG NGUYÊN NHÂN.
   * Gộp hai loại này lại là báo sai chỗ cần sửa: lỗi /tmp mà nói "kiểm tra mạng".
   */
  const infraFail = (verb, err) => {
    if (err instanceof LocalSetupError) {
      return { ok: false, reason: 'local-setup', message: err.message };
    }
    // Bỏ qua dòng "To <url>" và các dòng hint — chúng chiếm chỗ mà không nói nguyên nhân.
    const lines = String(err?.stderr ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^To /.test(l) && !/^hint:/.test(l));
    const detail = lines.length ? ` git nói: ${lines.join(' · ')}` : '';
    return {
      ok: false,
      reason: 'offline',
      message:
        `Không với tới claim-repo (${url}) khi ${verb}. Kiểm tra mạng/SSH rồi thử lại.${detail}`,
    };
  };

  return {
    ownerId,
    refFor: (itemKey) => refNameFor(ns, projectKey, itemKey),

    /**
     * Giành một item.
     * Thứ tự CAS-trước là bắt buộc: nếu gắn nhãn GitLab trước rồi CAS sau thì có khoảng thời
     * gian item mang nhãn "claimed" mà chưa ai thật sự giữ (docs/05 §5.2).
     */
    acquire(itemKey, { ttlSec } = {}) {
      const ref = refNameFor(ns, projectKey, itemKey);
      const ttl = ttlSec ?? config.ttlSec;

      let current;
      try {
        ensureScratch();
        current = remoteSha(ref);
      } catch (err) {
        // fail-closed: thà không làm còn hơn hai phiên làm trùng.
        return infraFail('giành việc', err);
      }

      let reclaimed = false;
      if (current) {
        const read = readPayload(current);

        // FAIL-CLOSED: không biết ref đang mang gì thì KHÔNG được giành.
        // CAS không cứu được ở đây — nó chỉ chặn khi ref ĐỔI SHA, mà chủ hợp lệ chỉ đổi sha mỗi
        // nhịp heartbeat (10 phút). Trong cửa sổ đó lease vẫn khớp và kẻ đến sau thắng.
        // Cùng chiều với isExpired: thà kẹt còn hơn cướp nhầm.
        if (read.state === 'unreadable') {
          return {
            ok: false,
            reason: 'unreadable',
            message:
              `Ref của ${itemKey} tồn tại nhưng ${read.why}. KHÔNG giành vì không biết ai đang ` +
              `giữ — giành mù ở đây là cướp claim còn sống. Kiểm quyền đọc claim-repo ` +
              `(fetch theo sha cần uploadpack.allowAnySHA1InWant), rồi thử lại. ` +
              `Nếu chắc chắn ref này là rác: tasks_doctor --fix.`,
          };
        }

        if (read.state === 'unparseable') {
          return {
            ok: false,
            reason: 'unparseable',
            message:
              `Ref của ${itemKey} mang payload không đọc được (có thể do bản agent-tasks khác ` +
              `ghi). KHÔNG giành để tránh cướp của phiên chạy bản mới hơn. Dọn bằng ` +
              `tasks_doctor --fix nếu xác định đó là rác.`,
          };
        }

        const held = read.payload;
        if (!isExpired(held, nowMs(), config.skewSec, config.graceSec)) {
          return {
            ok: false,
            reason: 'held',
            heldBy: {
              owner: held.owner,
              host: held.host,
              session_id: held.session_id,
              expires_at: held.expires_at,
            },
            message:
              `Item ${itemKey} đang được ${held.owner} giữ tới ${held.expires_at}. ` +
              `Lấy item khác, hoặc chờ hết hạn.`,
          };
        }
        reclaimed = true;
      }

      const payload = payloadFor(itemKey, ref, ttl, null);
      let won;
      try {
        won = casPush(ref, payload, current);
      } catch (err) {
        return infraFail('giành việc', err);
      }
      if (!won) {
        return {
          ok: false,
          reason: 'held',
          message: `Một phiên khác vừa giành ${itemKey} trước (thua ở bước CAS).`,
        };
      }
      return { ok: true, reclaimed, claim: payload };
    },

    /** Gia hạn. Mất mạng KHÁC mất khoá — không được kết luận lostClaim khi offline. */
    renew(itemKey, claimToken, { extendSec } = {}) {
      const ref = refNameFor(ns, projectKey, itemKey);
      let current;
      try {
        ensureScratch();
        current = remoteSha(ref);
      } catch (err) {
        return infraFail('gia hạn', err);
      }

      if (!current) {
        return {
          ok: false,
          reason: 'not-held',
          lostClaim: true,
          message: `Không còn claim nào cho ${itemKey} — có thể đã bị thu hồi. DỪNG ghi thêm.`,
        };
      }

      const read = readPayload(current);
      if (read.state !== 'ok') {
        return {
          ok: false,
          reason: 'unreadable',
          message:
            `Không đọc được claim hiện tại của ${itemKey} (${read.why ?? 'payload hỏng'}). ` +
            `Đây là sự cố ĐỌC, không phải mất khoá — chưa kết luận được gì. Thử lại; ` +
            `nếu lặp lại thì kiểm quyền đọc claim-repo.`,
        };
      }
      const held = read.payload;
      if (held.claim_token !== claimToken) {
        return {
          ok: false,
          reason: 'token-mismatch',
          lostClaim: true,
          message:
            `claim_token không khớp claim hiện tại của ${itemKey} (đang thuộc ${held.owner}). ` +
            `Claim của bạn đã bị thu hồi — DỪNG ghi thêm.`,
        };
      }

      const payload = payloadFor(itemKey, ref, extendSec ?? config.ttlSec, held);
      let won;
      try {
        won = casPush(ref, payload, current);
      } catch (err) {
        return infraFail('gia hạn', err);
      }
      if (!won) {
        return {
          ok: false,
          reason: 'token-mismatch',
          lostClaim: true,
          message: `Ref đổi giữa chừng — claim của bạn đã bị thu hồi. DỪNG ghi thêm.`,
        };
      }
      return { ok: true, claim: payload };
    },

    release(itemKey, claimToken) {
      const ref = refNameFor(ns, projectKey, itemKey);
      let current;
      try {
        ensureScratch();
        current = remoteSha(ref);
      } catch (err) {
        return infraFail('nhả khoá', err);
      }
      if (!current) return { ok: false, reason: 'not-held', message: `Không giữ ${itemKey}.` };

      const read = readPayload(current);
      if (read.state !== 'ok') {
        return {
          ok: false,
          reason: 'unreadable',
          message:
            `Không đọc được claim hiện tại của ${itemKey} (${read.why ?? 'payload hỏng'}). ` +
            `Đây là sự cố ĐỌC, không phải mất khoá — chưa kết luận được gì. Thử lại; ` +
            `nếu lặp lại thì kiểm quyền đọc claim-repo.`,
        };
      }
      const held = read.payload;
      if (held.claim_token !== claimToken) {
        return { ok: false, reason: 'token-mismatch', message: `claim_token không khớp.` };
      }

      let won;
      try {
        won = casDelete(ref, current);
      } catch (err) {
        return infraFail('nhả khoá', err);
      }
      return won
        ? { ok: true }
        : { ok: false, reason: 'token-mismatch', message: 'Ref đổi giữa chừng.' };
    },

    /** Kiểm token trước MỌI thao tác ghi — chặn confused deputy và chặn agent nhầm item. */
    verifyToken(itemKey, claimToken) {
      const ref = refNameFor(ns, projectKey, itemKey);
      let current;
      try {
        ensureScratch();
        current = remoteSha(ref);
      } catch (err) {
        return infraFail('kiểm khoá', err);
      }
      if (!current) return { ok: false, reason: 'not-held' };

      const read = readPayload(current);
      if (read.state !== 'ok') {
        return {
          ok: false,
          reason: 'unreadable',
          message:
            `Không đọc được claim hiện tại của ${itemKey} (${read.why ?? 'payload hỏng'}). ` +
            `Đây là sự cố ĐỌC, không phải mất khoá — chưa kết luận được gì. Thử lại; ` +
            `nếu lặp lại thì kiểm quyền đọc claim-repo.`,
        };
      }
      const held = read.payload;
      if (held.claim_token !== claimToken) return { ok: false, reason: 'token-mismatch' };
      if (isExpired(held, nowMs(), config.skewSec, config.graceSec)) {
        return { ok: false, reason: 'expired', claim: held };
      }
      return { ok: true, claim: held };
    },

    /**
     * Mọi claim đang sống. Một round-trip fetch cho cả namespace (docs/05 §3.4).
     *
     * `allProjects: true` bỏ lọc theo `projectKey` ⇒ thấy claim của MỌI dự án trên claim-repo này.
     * Vì một máy nhiều dự án dùng chung một claim-repo (spec M1), đây là cách xem toàn cảnh "máy
     * này đang giữ việc gì ở những dự án nào" — và là lý do dự án không cần một registry riêng.
     *
     * @param {{allProjects?: boolean}} [opts]
     */
    list(opts = {}) {
      const all = opts.allProjects === true;
      const prefix = all ? `${ns}/*` : `${ns}/${projectKey}`;
      let out;
      try {
        ensureScratch();
        out = git(['ls-remote', url, `${prefix}/*`]);
      } catch {
        return [];
      }

      const shas = String(out)
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split(/\s+/)[0]);
      if (!shas.length) return [];

      // ⚠️ REFSPEC CHỈ ĐƯỢC CÓ MỘT `*` MỖI PHÍA. `+refs/claims/*/*:refs/atm-cache/all/*/*` là
      // refspec KHÔNG HỢP LỆ — git từ chối hẳn với "fatal: invalid refspec". Vì lượt fetch này
      // `allowFail`, lỗi đó bị nuốt im lặng và kết quả vẫn đúng (readPayload tự fetch theo từng
      // sha), nên nó không hiện ra ở đâu — chỉ mất sạch tối ưu "một round-trip cho cả namespace"
      // (docs/05 §3.4) và biến `--all` thành N lần bắt tay SSH.
      //
      // Một `*` khớp được NHIỀU CẤP: `+refs/claims/*:refs/atm-cache/all/*` biến
      // `refs/claims/proj-a/aaa` → `refs/atm-cache/all/proj-a/aaa`, tức vẫn giữ nguyên projectKey
      // nên hai dự án không ghi đè cache của nhau.
      const fetchSpec = all
        ? `+${ns}/*:refs/atm-cache/all/*`
        : `+${prefix}/*:refs/atm-cache/${projectKey}/*`;
      git(['fetch', '-q', '--no-tags', url, fetchSpec], { allowFail: true });

      const claims = [];
      let skipped = 0;
      for (const sha of shas) {
        const r = readPayload(sha);
        if (r.state === 'ok') claims.push(r.payload);
        else skipped++;
      }
      // Ref không đọc được KHÔNG được biến mất im lặng: caller cần biết danh sách này thiếu.
      if (skipped) Object.defineProperty(claims, 'skipped', { value: skipped, enumerable: false });
      return claims;
    },

    /** Thu hồi cơ hội: mọi ref quá hạn đều bị dọn. Gọi khi có agent lấy việc (docs/05 §6.2). */
    reclaimExpired() {
      const reclaimed = [];
      for (const c of this.list()) {
        if (!isExpired(c, nowMs(), config.skewSec, config.graceSec)) continue;

        // ⚠️ TỰ TÍNH tên ref từ c.item — TUYỆT ĐỐI không dùng c.ref.
        // c.ref đến từ commit message trên claim-repo, tức dữ liệu REMOTE không kiểm được, mà
        // claim-repo thì ai cũng push được (đó là thiết kế). Bản đầu tin c.ref nên một payload
        // khai `ref: "refs/heads/main"` kèm expires_at quá khứ là đủ để phiên bất kỳ xoá hộ
        // branch đó. Review dựng lại được: refs/heads/main bị xoá thật.
        // Tên ref vốn là hàm của item (docs/05 §3.2) — không có lý do nào để tin bản tự khai.
        const ref = refNameFor(ns, projectKey, c.item);
        const sha = (() => {
          try {
            return remoteSha(ref);
          } catch {
            return null;
          }
        })();
        if (sha && casDelete(ref, sha)) reclaimed.push({ ...c, ref });
      }
      return reclaimed;
    },
  };
}
