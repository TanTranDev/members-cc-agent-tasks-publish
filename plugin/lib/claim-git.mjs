// @ts-check
// Nguyên thuỷ git cho claim engine: kho tạm + hai thao tác compare-and-swap.
//
// Tách khỏi claim.mjs vì đây là tầng KHÁC: chỗ này chỉ biết ref và sha, không biết TTL hay
// quyền sở hữu là gì. Tách ra cũng để test gọi thẳng được CAS — cách duy nhất kiểm được lease
// mà không phụ thuộc vào việc căn thời gian giữa các tiến trình.
//
// Mọi lời gọi dùng execFileSync với mảng tham số (không qua shell) ⇒ không có đường command
// injection từ URL hay tên ref.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Hash của cây rỗng — hằng của git, giống nhau ở mọi repo. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Lỗi khi chạm REMOTE (mạng, SSH, quyền). */
export class RemoteError extends Error {
  constructor(message, { stderr = '', status = null } = {}) {
    super(message);
    this.stderr = stderr;
    this.status = status;
  }
}

/**
 * Lỗi khi chuẩn bị kho tạm TRÊN ĐĨA LOCAL.
 * Tách hẳn khỏi RemoteError vì gộp chung thì lỗi đĩa bị báo là "không với tới claim-repo" —
 * agent sẽ đi kiểm mạng trong khi vấn đề nằm ở /tmp. Bug thật, do test race bắt được.
 */
export class LocalSetupError extends Error {
  constructor(message, { cause = null } = {}) {
    super(message);
    this.cause = cause;
  }
}

/**
 * Dựng một kho tạm bare để chứa commit trung gian.
 *
 * ⚠️ PHẢI RIÊNG CHO TỪNG TIẾN TRÌNH. Bản đầu đặt tên theo sha1(url) nên mọi tiến trình trên cùng
 * một máy dùng chung một thư mục — sáu phiên song song đụng nhau ở `git init` và ở lock file của
 * ref cache rồi thất bại, mà lỗi lại bị báo là "không với tới claim-repo". Đúng ca
 * multi-session-một-máy mà dự án này tồn tại để phục vụ; `claim-race.test.mjs` bắt được.
 */
export function prepareScratch(env) {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tasks-scratch-'));
    execFileSync('git', ['init', '--bare', '-q', dir], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    // Cây rỗng phải có trong odb thì `commit-tree` mới dùng được nó.
    execFileSync('git', ['hash-object', '-t', 'tree', '-w', '--stdin'], {
      cwd: dir,
      env,
      input: '',
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    return dir;
  } catch (err) {
    throw new LocalSetupError(
      `Không dựng được kho tạm trong ${os.tmpdir()} — kiểm quyền ghi và dung lượng đĩa. ` +
        `Đây là lỗi ĐĨA LOCAL, không phải lỗi mạng.`,
      { cause: /** @type {Error} */ (err) },
    );
  }
}

/**
 * ★ ĐÂY LÀ COMPARE-AND-SWAP. Toàn bộ tính đúng đắn của việc chống trùng task nằm ở một dòng:
 * `--force-with-lease=<ref>:<expect>` — git server chỉ nhận push nếu ref trên remote VẪN đúng
 * `expect`. Bỏ lease đi (dùng `--force`) thì hai phiên cùng tưởng ref trống sẽ cùng thắng, và
 * kẻ sau ghi đè kẻ trước trong im lặng.
 *
 * @param {{url: string, ref: string, payload: object, expectSha: string|null,
 *          scratchDir: string, env: object}} opts
 * @returns {boolean} true nếu thắng; false nếu lease không khớp (có kẻ nhanh tay hơn).
 */
export function casPushClaim({ url, ref, payload, expectSha, scratchDir, env }) {
  const commit = String(
    execFileSync('git', ['commit-tree', EMPTY_TREE, '-m', JSON.stringify(payload)], {
      cwd: scratchDir,
      env,
      encoding: 'utf8',
    }),
  ).trim();

  // expectSha null ⇒ chuỗi rỗng ⇒ git đòi ref PHẢI CHƯA TỒN TẠI.
  const lease = `--force-with-lease=${ref}:${expectSha ?? ''}`;
  return pushWithLease(['push', lease, url, `${commit}:${ref}`], { scratchDir, env, url });
}

/** Xoá ref bằng CAS. Cùng lý lẽ như casPushClaim. */
export function casDeleteClaim({ url, ref, expectSha, scratchDir, env }) {
  // `?? ''` cho đối xứng với casPushClaim: thiếu nó thì expectSha null hoá thành chuỗi "null"
  // và git từ chối parse — hướng an toàn, nhưng là bất đối xứng chờ nổ.
  const lease = `--force-with-lease=${ref}:${expectSha ?? ''}`;
  return pushWithLease(['push', lease, url, `:${ref}`], { scratchDir, env, url });
}

/**
 * Chạy một push có lease và phân biệt THUA LEASE với SỰ CỐ HẠ TẦNG.
 *
 * ⚠️ `catch { return false }` là sai: nó biến mất mạng / hết hạn credential / hook server từ
 * chối / hết quota thành "có kẻ nhanh tay hơn". Hệ quả đo được: mạng chết giữa chừng ⇒
 * `task_claim_next` duyệt 20 ứng viên, tất cả `false`, rồi báo "20 ứng viên đều đã có phiên
 * khác giữ. Thử lại sau." — sự cố hạ tầng bị báo thành tranh chấp.
 *
 * Git nói rõ `(stale info)` khi thua lease, nên phân biệt được.
 *
 * @returns {boolean} false CHỈ khi thua lease. Sự cố khác ⇒ ném RemoteError.
 */
function pushWithLease(args, { scratchDir, env, url }) {
  try {
    // LC_ALL=C: các mẫu dưới đây là chuỗi tiếng Anh của git. Ép locale để chúng không phụ
    // thuộc ngôn ngữ máy — nếu không, một máy đặt LANG khác sẽ rơi hết vào nhánh "sự cố".
    execFileSync('git', args, {
      cwd: scratchDir,
      env: { ...env, LC_ALL: 'C', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch (err) {
    const stderr = String(/** @type {any} */ (err).stderr ?? '');
    if (LEASE_LOST_RE.test(stderr)) return false;

    throw new RemoteError(
      `Không đẩy được lên claim-repo (${url}) — đây KHÔNG phải tranh chấp claim.`,
      { stderr, status: /** @type {any} */ (err).status ?? null },
    );
  }
}

/**
 * Các thông điệp git nghĩa là "thua tranh chấp ref", KHÔNG phải sự cố hạ tầng.
 *
 * ⚠️ `reference already exists` là ca hay gặp NHẤT mà lại dễ sót: khi hai tiến trình cùng push
 * với lease RỖNG và kẻ kia vừa tạo ref xong, git không nói "stale info" mà nói
 * `! [remote rejected] … (reference already exists)`. Thiếu mẫu này thì mọi lượt thua race
 * bị báo thành "không với tới claim-repo" — chỉ test race THẬT mới lộ ra.
 */
const LEASE_LOST_RE =
  /stale info|reference already exists|fetch first|non-fast-forward|cannot lock ref/i;

/** Chạy một lệnh git, ném RemoteError khi thất bại (trừ khi allowFail). */
export function runGit(args, { cwd, env, allowFail = false }) {
  try {
    return execFileSync('git', args, {
      cwd: cwd ?? undefined,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (allowFail) return null;
    const e = /** @type {any} */ (err);
    throw new RemoteError(`git ${args[0]} thất bại`, {
      stderr: String(e.stderr ?? ''),
      status: e.status ?? null,
    });
  }
}
