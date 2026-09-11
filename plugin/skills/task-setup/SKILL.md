---
name: task-setup
description: Dùng khi cài agent-tasks — lần đầu trên một MÁY (đặt token) hoặc khi mở một DỰ ÁN mới (tạo agent-tasks.config.json trong repo, trỏ boardUrl tới project GitLab chứa issue board, tạo nhãn, dựng board 5 cột). Triggers "cài agent-tasks", "cấu hình gitlab", "setup task", "đặt token ở đâu", "start MCP", "cài plugin", "chưa cấu hình", "thiếu claimRepoUrl", "còn giá trị mẫu", "dự án mới", "boardUrl", "dựng board", /task-setup.
model: sonnet
---

# Cài agent-tasks

## Mô hình v0.3 — cấu hình sống TRONG REPO

```
REPO CODEBASE      agent-tasks.config.json   ← commit, cả team dùng chung:
                                                 boardUrl (project GitLab chứa ISSUE BOARD)
                                                 claimRepoUrl · ttlSec · heartbeatSec
MỖI MÁY            ~/.agent-tasks/.env       ← chỉ GITLAB_TOKEN (không bao giờ vào repo)
 └─ WORK ITEM      GitLab Issue trên board   ← một việc một item, 5 cột
     └─ CLAIM      refs/claims/… ở claim-repo ← ai đang làm, tới khi nào
```

**Board không nhất thiết nằm ở repo code.** `boardUrl` là URL project GitLab bạn copy từ trình duyệt
(`https://git.congty.vn/nhom/agent-board`); server suy ra host + project path từ đó. Không khai ⇒
đọc git remote của repo (fallback bản cũ).

## Trước tiên: máy này đã cài chưa?

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" status
```

| Thấy gì | Làm gì |
|---|---|
| `cấu hình: ✓ sẵn sàng` | **Xong.** Chỉ cần §B3/§B4 nếu project chứa board chưa có nhãn / cột |
| `Thiếu claimRepoUrl … tasks-cli init` | Repo chưa có `agent-tasks.config.json` → §B |
| `Chưa có GITLAB_TOKEN` | Máy chưa có token → §A |
| `board: (không khai — đọc từ git remote)` | Chạy được nhưng board = Issues của repo code. Muốn board riêng → §B1 |

## §A. Một lần cho cả MÁY — chỉ token

| # | Bước | Lệnh | Ai làm |
|---|---|---|---|
| A0 | Tạo **Group Access Token** scope `api` ở group chứa cả board lẫn claim-repo | (web GitLab) | **người** |
| A1 | Tạo `~/.agent-tasks/.env` | `node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" setup` | agent |
| A2 | Dán token vào `~/.agent-tasks/.env` (quyền 600) | sửa file | **người** cấp giá trị, agent ghi |

⚠️ **Không đặt token vào file JSON nào.** Token trong `agent-tasks.config.json` bị **loại bỏ + cảnh
báo** — file đó được commit. Muốn token riêng cho một clone: `tasks-cli init --local` →
`<git-dir>/agent-tasks.env`.

Vì sao group token chứ không PAT cá nhân: rò rỉ không mở được toàn bộ tài khoản; audit trail chỉ rõ
bot nào sửa gì. Đổi lại: token bot ⇒ server **không** set assignee (card không có avatar) — khối
"Đang làm" trên item vẫn ghi đủ ai/máy/agent. Muốn có avatar: đặt `AGENT_TASKS_GITLAB_USER_ID=<id
của bạn>` trong `~/.agent-tasks/.env`.

## §B. Mỗi DỰ ÁN

### B1. Tạo `agent-tasks.config.json` ở root repo

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" init
```

File sinh ra có `_doc` giải thích từng khoá. **Ba thứ phải đúng:**

```jsonc
{
  "boardUrl":     "https://git.congty.vn/nhom/agent-board",      // project chứa ISSUE BOARD — hỏi người
  "claimRepoUrl": "git@git.congty.vn:nhom/agent-claims.git",     // SSH, project RIÊNG, chỉ giữ khoá
  "ttlSec": 1800, "heartbeatSec": 600
}
```

Hai câu **phải hỏi người**, đừng đoán:

- *Board nằm ở project nào?* — `init` điền sẵn theo git remote của repo, nhưng đó là **gợi ý**: nhiều
  team dùng một project `agent-board` riêng cho nhiều repo.
- *Claim-repo là project nào?* — một cái cho cả team, dùng chung được cho mọi dự án.

Commit file này. Người sau clone repo ⇒ chỉ cần §A.

### B2. Kiểm

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" verify
```

| Dòng | Nghĩa khi ✗ |
|---|---|
| `cấu hình` | thiếu khoá trong `agent-tasks.config.json`, hoặc còn giá trị mẫu |
| `claim-repo` | SSH không với tới. Claim đi qua **git-over-ssh** — token đúng cũng không cứu được |
| `token` / `backlog` | 401 token sai · 403 thiếu scope · 404 `boardUrl` trỏ project không tồn tại · **Issues BỊ TẮT** ⇒ bật Issues cho project chứa board |

Xanh hết mới sang B3.

### B3. Tạo bộ nhãn (10 nhãn)

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" labels           # xem trước
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" labels --apply   # ghi thật — idempotent
```

### B4. Dựng board 5 cột

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" board --apply
```

Tạo (hoặc dùng lại) issue board với 5 cột theo nhãn `status::*`: **Backlog · Working · Needs you ·
In review · Ready to merge**. Free tier chỉ cho một board/project — lệnh dùng lại board đang có.
Thứ tự cột kéo tay trên UI nếu chưa đúng.

### B5. Nâng cấp từ bản cũ (0.1.x / 0.2.x)

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" labels --migrate          # xem item nào còn nhãn cũ
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" labels --migrate --apply  # ready→backlog, claimed→working, …
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" labels --prune --apply    # xoá tên nhãn cũ khỏi project
```

`--prune` xoá nhãn khỏi project và gỡ khỏi **mọi** issue đang mang — không lùi được; chạy `--migrate`
trước. Bản cũ để `claimRepoUrl` ở `~/.agent-tasks/config.json` vẫn đọc được, nhưng hãy chuyển vào
`agent-tasks.config.json` để cả team chung một bản.

⚠️ `labels --apply` · `board --apply` · `ingest --apply` **ghi thật** lên project chứa board; `verify`
phải xanh trước.

## Thứ tự ưu tiên khi cùng một khoá xuất hiện nhiều nơi

```
DEFAULTS
 ← ~/.agent-tasks/config.json         cấp máy (bản cũ, chỉ fallback)
 ← .claude/agent-tasks.config.json    bản cũ (tránh: .claude/ hay là symlink dùng chung)
 ← agent-tasks.config.json Ở ROOT     ★ CỦA DỰ ÁN, commit
 ← <git-dir>/agent-tasks-local.json   per-clone, không commit
 ← ~/.agent-tasks/.env                token cấp máy
 ← .env ở root dự án                  override một dự án
 ← <git-dir>/agent-tasks.env          override + token riêng một clone
 ← biến ở shell                       cao nhất
      ↓
 boardUrl → gitlabHost + projectPath  (chỉ điền khoá CÒN TRỐNG)
 git remote → gitlabHost + projectPath (fallback cuối)
```

Không chắc giá trị đang đọc từ đâu: `status` in tầng nào đã nạp, khoá nào suy từ `boardUrl`, khoá
nào từ remote.

## Dò năng lực instance (tuỳ chọn)

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" probe                    # chỉ dò
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" probe --issue 1 --write  # + thử tier trên issue NHÁP, lưu cấp máy
```

Lõi chỉ dùng tính năng Free nên không biết tier vẫn chạy được. `probe --issue` **có ghi** hai nhãn
thử rồi xoá — dùng issue nháp. `?` = chưa dò được, khác `·` = không có. (v0.3: probe chỉ còn ở CLI,
không còn trên mặt MCP.)

## Bật MCP server và plugin

Server **tự đọc cấu hình** theo cwd lúc khởi động (đi ngược lên `.git`) — cwd phải nằm trong repo
dự án. Cài qua marketplace (xem README) hoặc local:

```bash
claude plugin marketplace add /đường/dẫn/agent-task-management --scope user
claude plugin install agent-tasks@agent-tasks-marketplace --scope user
```

⚠️ Đừng vừa cài plugin vừa `claude mcp add` server tay — hai server cùng khai 15 tool trùng tên.

**Kiểm:** hỏi *"board đang thế nào"* → agent gọi `tasks_list`. Hoặc `claude mcp list` thấy
`agent-tasks: ✓ connected`.

## Hai thứ trông như hỏng nhưng bình thường

- **claim-repo hiện "empty repository"**: claim sống dưới `refs/claims/*`, UI GitLab chỉ render
  branch/tag. Kiểm: `git ls-remote <claimRepoUrl> 'refs/claims/*'` hoặc `tasks-cli claims`.
- **Đóng Claude Code = claim hết hạn sau ≤ TTL**: heartbeat sống theo tiến trình. Việc quay lại
  Backlog — đúng hành vi.

## Sự cố khi cài

| Triệu chứng | Nguyên nhân | Xử |
|---|---|---|
| `còn GIÁ TRỊ MẪU` | `init` rồi chưa sửa | sửa `boardUrl` / `claimRepoUrl` |
| `boardUrl không nhận dạng được` | dán URL thiếu path | cần `https://<host>/<group>/<project>` |
| Token đúng mà vẫn báo thiếu | shell có `GITLAB_TOKEN` rỗng đè lên | `unset GITLAB_TOKEN` |
| `Không tìm thấy .git` | chạy ngoài git repo | chạy từ root dự án |
| `reason: "offline"` | không với tới claim-repo | `git ls-remote <claimRepoUrl>` |
| Hai nhãn `status::*` trên một item | GitLab Free không loại trừ scoped label | `tasks_doctor --fix` |
| Board không có cột | chưa chạy `board --apply` | §B4 |

## Gỡ cài đặt

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" claims                          # nhả hết claim trước
git push <claimRepoUrl> --delete 'refs/claims/<projectKey>/*'
claude plugin uninstall agent-tasks@agent-tasks-marketplace
```

Work item trên GitLab **giữ nguyên** — chúng là dữ liệu của bạn.
