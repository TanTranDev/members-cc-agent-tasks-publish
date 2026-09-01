// @ts-check
// Dựng và đọc payload của một claim. Tầng này biết "một claim trông như thế nào" và
// "làm sao lấy nó về từ remote" — không biết TTL, quyền sở hữu hay chính sách khi mất mạng.

import crypto from 'node:crypto';

export const PAYLOAD_VERSION = 1;

/**
 * Dựng payload cho một lượt acquire hoặc renew.
 * `previous` khác null ⇒ đây là renew: giữ nguyên `acquired_at` và `claim_token`.
 */
export function buildPayload({ identity, ownerId, itemKey, ref, ttlSec, previous, nowMs }) {
  const t = nowMs();
  return {
    v: PAYLOAD_VERSION,
    item: itemKey,
    ref,
    owner: identity.owner,
    owner_id: ownerId,
    host: identity.host,
    clone_path: identity.clonePath,
    session_id: identity.sessionId,
    pid: identity.pid,
    agent_role: identity.agentRole ?? null,
    acquired_at: previous?.acquired_at ?? new Date(t).toISOString(),
    renewed_at: previous ? new Date(t).toISOString() : null,
    expires_at: new Date(t + ttlSec * 1000).toISOString(),
    claim_token: previous?.claim_token ?? `c1_${crypto.randomBytes(12).toString('hex')}`,
  };
}

/**
 * Hai phép đọc trạng thái trên claim-repo.
 * @param {{git: Function, url: string}} deps `git` ném khi thất bại trừ khi allowFail.
 */
export function makePayloadIO({ git, url }) {
  return {
    /** sha hiện tại của ref trên remote, hoặc null nếu ref chưa tồn tại. Ném khi không với tới. */
    remoteSha(ref) {
      const line = String(git(['ls-remote', url, ref])).trim();
      return line ? line.split(/\s+/)[0] : null;
    },

    /**
     * Đọc payload JSON nằm trong commit message của một sha.
     *
     * ⚠️ Phân biệt BA kết quả, không gộp thành `null`. Bản đầu gộp lại, và `acquire` coi mọi
     * `null` là "claim chết" ⇒ **cướp được claim đang sống**: chỉ cần một blip mạng ở
     * round-trip thứ hai, hoặc claim-repo không cho fetch theo sha
     * (`uploadpack.allowAnySHA1InWant` — CHƯA ai xác minh trên GitLab thật). Ca tệ nhất: nếu
     * server không bao giờ cho fetch theo sha thì MỌI acquire đều là cướp, im lặng 100%, và
     * bare repo local trong test không bao giờ thấy.
     *
     * @returns {{state:'ok', payload:object} | {state:'unreadable', why:string} | {state:'unparseable'}}
     */
    readPayload(sha) {
      const fetched =
        git(['fetch', '-q', url, sha], { allowFail: true }) ??
        git(['fetch', '-q', '--no-tags', url, `+${sha}`], { allowFail: true });

      const msg = git(['log', '-1', '--format=%B', sha], { allowFail: true });
      if (msg === null) {
        return {
          state: 'unreadable',
          why:
            fetched === null
              ? `không fetch được commit ${sha.slice(0, 8)} từ claim-repo`
              : `fetch xong nhưng không đọc được commit ${sha.slice(0, 8)}`,
        };
      }
      try {
        return { state: 'ok', payload: JSON.parse(String(msg).trim()) };
      } catch {
        return { state: 'unparseable' };
      }
    },
  };
}
