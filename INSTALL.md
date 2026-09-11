# Cài đặt agent-tasks

| Tài liệu | Trả lời |
|---|---|
| **INSTALL.md** (đây) | Cài thế nào: một lần cho máy, một file JSON cho mỗi repo, một board cho mỗi dự án |
| [`USAGE.md`](USAGE.md) | **Dùng hàng ngày**: 15 tool · 11 lệnh · các luồng thật · chẩn đoán |
| [`README.md`](README.md) | Plugin làm gì, board 5 cột, 10 nhãn, giới hạn đã biết |

## HAI đường cài — chọn đúng đường của bạn

| | Bạn là | Cần clone repo? | Cần `npm install`? |
|---|---|---|---|
| **A. Cài từ marketplace** | người **dùng** plugin | ❌ | ❌ |
| **B. Clone** | người **sửa** plugin | ✅ | ✅ |

### ⚡ A. Cài từ marketplace

```
/plugin marketplace add TanTranDev/members-cc-agent-tasks-publish
/plugin install agent-tasks@agent-tasks-marketplace
```

Rồi **khởi động lại Claude Code**, và nói với agent: `/task-setup`. Skill đó chạy nốt phần cấu hình.

Claude Code chạy `npm ci --ignore-scripts` ngay trong bản copy ở cache (plugin root có
`package.json` + `package-lock.json`) — không cần `npm install` tay.

⚠️ **Cập nhật đi theo `version`, không theo commit**: `/plugin update agent-tasks`.

### B. Clone — chỉ khi bạn SỬA plugin

```bash
npm install
node plugin/bin/tasks-cli.mjs setup           # 1 lần cho MÁY → dán token
cd /đường/dẫn/repo-du-an
node /đường/dẫn/agent-task-management/plugin/bin/tasks-cli.mjs init     # 1 lần cho REPO
node /đường/dẫn/agent-task-management/plugin/bin/tasks-cli.mjs verify   # phải xanh hết
node /đường/dẫn/agent-task-management/plugin/bin/tasks-cli.mjs labels --apply
node /đường/dẫn/agent-task-management/plugin/bin/tasks-cli.mjs board --apply
```

Sửa skill xong mà không thấy tác dụng: bản đã cài là **bản copy** trong cache. `npm run plugin:sync`
so nội dung, bump version khi khác, rồi đồng bộ.

---

## 1. Chuẩn bị trên GitLab (một lần cho cả team)

### 1.1 Hai project

| Project | Chứa gì | Mấy cái |
|---|---|---|
| **board** (vd `nhom/agent-board`) | issue = work item · issue board 5 cột. Phải **bật Issues** | 1 cho mỗi dự án — hoặc 1 dùng chung cho nhiều repo |
| **claim-repo** (vd `nhom/agent-claims`) | chỉ `refs/claims/*`. Không commit, không issue. Sẽ hiện "empty repository" — đúng | **1** cho cả team |

Board **không nhất thiết** là repo code. Nhiều team để một project `agent-board` riêng để người
quản lý mở một board thấy mọi dự án. `boardUrl` trong cấu hình trỏ vào đó.

claim-repo dùng chung được vì ref đã tách theo dự án (`refs/claims/<projectKey>/<hash>`). Loại trừ
tương hỗ cần một điểm hội tụ; tách ra chỉ tốn thêm SSH mà không được gì.

### 1.2 Token

**Group Access Token**, scope `api`, tạo ở group chứa **cả** board lẫn claim-repo. Rò rỉ không mở
được toàn bộ tài khoản; audit trail chỉ rõ bot nào sửa gì.

Hệ quả phải biết: token bot ⇒ server **không** set assignee (card không avatar). Khối "Đang làm" trên
item vẫn ghi đủ ai · máy · agent. Muốn avatar: `AGENT_TASKS_GITLAB_USER_ID=<id của bạn>` trong
`~/.agent-tasks/.env`.

### 1.3 SSH vào claim-repo

Claim đi qua **git-over-ssh**, không qua API. Máy nào chạy agent phải push được vào claim-repo:

```bash
git ls-remote git@git.congty.vn:nhom/agent-claims.git      # không được hỏi mật khẩu
```

---

## 2. Cấu hình — một file trong repo, một token trên máy

```
REPO CODEBASE   agent-tasks.config.json   ← commit, cả team dùng chung
MỖI MÁY         ~/.agent-tasks/.env       ← GITLAB_TOKEN, không vào repo
```

### 2.1 Máy: token

```bash
tasks-cli setup            # tạo ~/.agent-tasks/.env (quyền 600)
```

```bash
# ~/.agent-tasks/.env
GITLAB_TOKEN=glpat-…
```

### 2.2 Repo: `agent-tasks.config.json`

```bash
cd repo-du-an && tasks-cli init
```

```jsonc
{
  "_doc": ["…giải thích từng khoá…"],
  "boardUrl":     "https://git.congty.vn/nhom/agent-board",      // project chứa ISSUE BOARD
  "claimRepoUrl": "git@git.congty.vn:nhom/agent-claims.git",     // SSH, project RIÊNG
  "ttlSec": 1800,
  "heartbeatSec": 600
}
```

`init` điền `boardUrl` theo git remote của repo — đó là **gợi ý**; sửa nếu board ở project khác.
Commit file này. Người sau clone repo chỉ cần §2.1.

⚠️ **Không đặt token vào file JSON** — token trong `agent-tasks.config.json` bị loại bỏ + cảnh báo.

### 2.3 Một clone cần khác (token riêng, board riêng)

```bash
tasks-cli init --local     # <git-dir>/agent-tasks.env — git không track
```

Thắng file của dự án, chỉ thua biến shell.

### 2.4 Thứ tự ưu tiên

```
DEFAULTS
 ← ~/.agent-tasks/config.json         cấp máy (bản cũ, chỉ fallback)
 ← .claude/agent-tasks.config.json    bản cũ (tránh — .claude/ hay là symlink dùng chung)
 ← agent-tasks.config.json Ở ROOT     ★ của dự án, commit
 ← <git-dir>/agent-tasks-local.json   per-clone, không commit
 ← ~/.agent-tasks/.env                token cấp máy
 ← .env ở root dự án                  override một dự án
 ← <git-dir>/agent-tasks.env          override + token riêng một clone
 ← biến ở shell                       cao nhất
      ↓
 boardUrl  → gitlabHost + projectPath  (chỉ điền khoá CÒN TRỐNG)
 git remote → gitlabHost + projectPath (fallback cuối)
```

`tasks-cli status` in ra tầng nào đã nạp và khoá nào suy từ đâu.

### 2.5 Tắt riêng một clone

`AGENT_TASKS_ENABLED=false` trong `<git-dir>/agent-tasks.env`.

---

## 3. Kiểm

```bash
tasks-cli verify
```

| Dòng | Nghĩa khi ✗ |
|---|---|
| `cấu hình` | thiếu `boardUrl`/`claimRepoUrl`, hoặc còn giá trị mẫu |
| `claim-repo` | SSH không với tới — token đúng cũng không cứu được |
| `token` / `backlog` | 401 sai token · 403 thiếu scope `api` · 404 `boardUrl` trỏ project không tồn tại · **Issues BỊ TẮT** ⇒ bật Issues cho project board |

Exit ≠ 0 khi còn lỗi. Xanh hết mới sang bước 4.

---

## 4. Khởi tạo board (mỗi project board một lần)

```bash
tasks-cli labels            # xem 10 nhãn
tasks-cli labels --apply    # tạo — idempotent
tasks-cli board             # xem 5 cột
tasks-cli board --apply     # dựng issue board (Free: dùng lại board đang có)
```

Nâng cấp từ 0.1.x / 0.2.x — item cũ còn nhãn cũ:

```bash
tasks-cli labels --migrate          # xem
tasks-cli labels --migrate --apply  # ready→backlog · claimed→working · blocked→needs-you · review→in-review · care::chat→careful
tasks-cli labels --prune --apply    # xoá tên nhãn cũ khỏi project (gỡ khỏi mọi issue — không lùi)
```

Nhập tài liệu có sẵn thành work item (tuỳ chọn, **từng nguồn một**):

```bash
tasks-cli ingest                        # dry-run
tasks-cli ingest --source spec --apply
```

Dò tier instance (tuỳ chọn, dùng issue **nháp**): `tasks-cli probe --issue 1 --write`.

---

## 5. Bật plugin / MCP server

Cài qua marketplace (§A) là xong. Cài local khi phát triển:

```bash
claude plugin marketplace add /đường/dẫn/agent-task-management --scope user
claude plugin install agent-tasks@agent-tasks-marketplace --scope user
```

Server định vị dự án theo **cwd lúc khởi động** (đi ngược lên `.git`) — cwd phải nằm trong repo dự
án. ⚠️ Đừng vừa cài plugin vừa `claude mcp add` tay: hai server cùng khai 15 tool trùng tên.

**Kiểm**: hỏi *"board đang thế nào"* → agent gọi `tasks_list`. `claude mcp list` thấy
`agent-tasks: ✓ connected`. Thấy đủ 15 tool nhưng gọi cái nào cũng "chưa sẵn sàng" ⇒ cwd không nằm
trong repo có `agent-tasks.config.json`.

---

## 6. Sự cố thường gặp

| Triệu chứng | Nguyên nhân | Xử |
|---|---|---|
| `còn GIÁ TRỊ MẪU` | `init` rồi chưa sửa | sửa `boardUrl` / `claimRepoUrl` |
| `boardUrl không nhận dạng được` | URL thiếu path | cần `https://<host>/<group>/<project>` |
| Token đúng mà vẫn báo thiếu | shell có `GITLAB_TOKEN` rỗng đè | `unset GITLAB_TOKEN` |
| `Không tìm thấy .git` | chạy ngoài git repo | chạy từ root dự án |
| `reason: "offline"` | không với tới claim-repo | `git ls-remote <claimRepoUrl>` |
| `reason: "local-setup"` | lỗi đĩa local (`/tmp`) | kiểm quyền ghi + dung lượng |
| Hai `status::*` trên một item | Free không loại trừ scoped label | `tasks_doctor --fix` |
| Board không có cột | chưa `board --apply` | §4 |
| Card không có avatar | token là bot | `AGENT_TASKS_GITLAB_USER_ID` |
| `heartbeatSec >= ttlSec` | claim chết giữa việc | đặt `heartbeatSec ≈ ttlSec/3` |

---

## 7. Gỡ cài đặt

```bash
tasks-cli claims                                              # nhả hết claim trước
git push <claimRepoUrl> --delete 'refs/claims/<projectKey>/*' # dọn ref còn sót
claude plugin uninstall agent-tasks@agent-tasks-marketplace
claude plugin marketplace remove agent-tasks-marketplace
```

Work item trên GitLab **giữ nguyên** — chúng là dữ liệu của bạn, không phải của công cụ.
