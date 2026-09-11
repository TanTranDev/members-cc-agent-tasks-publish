// @ts-check
// Wiring: cấu hình → các dependency mà tool layer cần.
// Đây là chỗ DUY NHẤT biết cách ráp mọi thứ lại; lib/tools.mjs chỉ nhận dependency đã dựng sẵn.

import crypto from 'node:crypto';
import os from 'node:os';

import { loadConfig, machineDir } from './config.mjs';
import { createClaimEngine } from './claim.mjs';
import { createGitLabClient } from './gitlab.mjs';
import { createRateLimiter } from './evidence.mjs';
import { createHandlers, ALL_TOOL_NAMES } from './tools.mjs';
import { createProbeRunner } from './probe.mjs';

/**
 * Định danh phiên.
 *
 * `sessionId` là điểm khác cc-lock: nó coi hai session mở cùng thư mục là MỘT clone và không
 * chặn nhau. Đúng cho khoá file, SAI cho khoá task — nên ở đây phiên phải phân biệt được.
 * Ưu tiên id do host cấp; không có thì sinh ngẫu nhiên mỗi tiến trình, vẫn đảm bảo hai tiến
 * trình khác nhau không bao giờ trùng.
 */
export function resolveIdentity({ root, env = process.env } = {}) {
  const sessionId =
    env.CLAUDE_SESSION_ID ||
    env.AGENT_TASKS_SESSION_ID ||
    `pid-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;

  return {
    host: os.hostname(),
    clonePath: root ?? process.cwd(),
    sessionId,
    owner: env.AGENT_TASKS_OWNER || env.USER || env.LOGNAME || 'unknown',
    pid: process.pid,
    agentRole: env.AGENT_TASKS_ROLE || null,
    /**
     * v0.3: TÊN agent, để người nhìn khối "Đang làm" biết đúng agent nào (một máy chạy nhiều
     * agent). Bỏ trống ⇒ dùng vai; không có vai ⇒ "agent".
     */
    agentName: env.AGENT_TASKS_AGENT_NAME || env.AGENT_TASKS_ROLE || null,
    /**
     * v0.3: id người dùng GitLab để set assignee lúc claim — card trên board hiện avatar.
     * Bỏ trống ⇒ runtime thử `whoami` (token cá nhân thì ra người, group token thì ra bot và
     * KHÔNG assign).
     */
    gitlabUserId: (() => {
      const raw = String(env.AGENT_TASKS_GITLAB_USER_ID ?? '').trim();
      if (!raw) return null;
      const n = Number(raw);
      // Không phải số nguyên dương ⇒ coi như KHÔNG khai (rơi về whoami), không để NaN lọt vào cache.
      return Number.isInteger(n) && n > 0 ? n : null;
    })(),
  };
}

/**
 * Dựng toàn bộ runtime. Chưa cấu hình xong thì KHÔNG ném lỗi — trả về trạng thái "trơ" kèm lý
 * do, vì plugin được cài per-máy nên sẽ có mặt cả ở repo chưa dùng tới nó.
 */
export function createRuntime({ cwd = process.cwd(), env = process.env } = {}) {
  const loaded = loadConfig({ cwd, env });
  const { config, token, root, configured, reason, warnings } = loaded;

  // Dùng env ĐÃ MERGE (.env + shell), không phải `env` thô. Nếu lấy `env` thô thì
  // AGENT_TASKS_OWNER/ROLE/SESSION_ID đặt trong .env sẽ vô tác dụng một cách lặng lẽ —
  // và identity sai thì claim ghi tên sai chủ, đúng thứ khó truy nhất.
  const effectiveEnv = loaded.env ?? env;

  if (!configured || !token) {
    const why = !configured
      ? reason
      : 'Chưa có GITLAB_TOKEN trong biến môi trường — không gọi được GitLab.';
    return {
      configured: false,
      reason: why,
      warnings,
      config,
      root,
      gitDir: loaded.gitDir,
      sources: loaded.sources,
      envApplied: loaded.envApplied,
      /**
       * Mọi tool HỢP LỆ trả cùng một lỗi có hướng dẫn thay vì nổ giữa chừng.
       *
       * ⚠️ Phải giới hạn ở tập tên đã khai. Bản đầu dùng Proxy trả handler cho MỌI tên, nên gõ
       * sai tên tool cũng nhận "chưa cấu hình" — agent sẽ đi sửa cấu hình trong khi lỗi thật là
       * sai tên. Cùng lớp lỗi báo-sai-nguyên-nhân với vụ offline/local-setup ở claim.mjs.
       */
      handlers: Object.fromEntries(
        ALL_TOOL_NAMES.map((name) => [
          name,
          async () => ({
            isError: true,
            content: [{
              type: 'text',
              text:
                `agent-tasks chưa sẵn sàng: ${why}\n\nCác cảnh báo:\n` +
                ((warnings ?? []).map((w) => `- ${w}`).join('\n') || '(không có)'),
            }],
          }),
        ]),
      ),
    };
  }

  const identity = resolveIdentity({ root, env: effectiveEnv });
  const gitlab = createGitLabClient({
    host: config.gitlabHost,
    projectPath: config.projectPath,
    token,
  });
  const claims = createClaimEngine({ config, identity });
  const rateLimiter = createRateLimiter(config.progressMinIntervalSec);

  // `ingest` và `probe` KHÔNG nối vào handler: cả hai đã rời mặt MCP (lý do ở đầu lib/tool-defs.mjs),
  // đường còn lại là `tasks-cli ingest` / `tasks-cli probe`, và CLI gọi runner riêng qua `rt.probe`.
  // `machineDir` để probe ghi capabilities ở CẤP MÁY: capabilities là thuộc tính của instance GitLab.
  const probe = createProbeRunner({
    gitlab,
    config,
    gitDir: loaded.gitDir,
    machineDir: machineDir(effectiveEnv),
  });
  // `root` là bắt buộc cho task_attach_docs — nó đọc tài liệu trên đĩa.
  const handlers = createHandlers({ cfg: config, gitlab, claims, rateLimiter, root, identity });

  return {
    configured: true,
    reason: null,
    warnings,
    config,
    root,
    /** Nơi đặt tầng cấu hình per-clone — `probe --write` ghi capabilities vào đây. */
    gitDir: loaded.gitDir,
    sources: loaded.sources,
    envApplied: loaded.envApplied,
    identity,
    gitlab,
    claims,
    probe,
    handlers,
  };
}

/**
 * Heartbeat nền: gia hạn mọi claim của phiên này theo chu kỳ.
 *
 * ⚠️ Giới hạn đã biết: timer sống theo tiến trình. Đóng Claude Code = ngừng heartbeat = claim
 * hết hạn sau ≤ ttlSec. Đó là hành vi ĐÚNG (người đóng máy thì việc nên quay lại hàng đợi),
 * nhưng phải nói rõ để không ai ngạc nhiên. Agent vẫn nên gọi task_heartbeat khi biết mình
 * sắp làm việc dài.
 */
export function startHeartbeat(runtime, { log = () => {} } = {}) {
  if (!runtime.configured) return () => {};

  const everyMs = Math.max(60, Number(runtime.config.heartbeatSec) || 600) * 1000;
  const timer = setInterval(() => {
    try {
      for (const c of runtime.claims.list()) {
        if (c.owner_id !== runtime.claims.ownerId) continue;
        const r = runtime.claims.renew(c.item, c.claim_token);
        if (!r.ok && r.lostClaim) log(`⚠️ mất claim ${c.item}: ${r.message}`);
      }
    } catch (err) {
      log(`⚠️ heartbeat lỗi: ${/** @type {Error} */ (err).message}`);
    }
  }, everyMs);

  timer.unref?.();
  return () => clearInterval(timer);
}
