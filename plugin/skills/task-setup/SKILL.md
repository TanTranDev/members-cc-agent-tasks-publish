---
name: task-setup
description: Dùng khi cài agent-tasks — lần đầu trên một MÁY (tạo ~/.agent-tasks, đặt token, claim-repo) hoặc khi mở một DỰ ÁN mới trên máy đã cài. Triggers "cài agent-tasks", "cấu hình gitlab", "setup task", "đặt token ở đâu", "start MCP", "cài plugin", "chưa cấu hình", "thiếu claimRepoUrl", "còn giá trị mẫu", "dự án mới", /task-setup.
model: sonnet
---

# Cài agent-tasks

## Trước tiên: máy này đã cài chưa?

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" status
```

| Thấy gì | Làm gì |
|---|---|
| `cấu hình: ✓ sẵn sàng` | **Xong rồi.** Chỉ cần `labels --apply` nếu backlog dự án này chưa có nhãn |
| `Thiếu claimRepoUrl … tasks-cli setup` | Máy chưa cài → làm **§A** |
| `Không suy được projectPath từ git remote` | Máy đã cài, dự án này thiếu remote → làm **§B** |

**Một máy nhiều dự án**: thứ dùng chung khai **một lần** ở `~/.agent-tasks/`; còn `gitlabHost` và
`projectPath` được **đọc từ git remote** của từng dự án. Nên **dự án thứ hai trở đi không cần cấu
hình gì**.

## §A. Một lần cho cả MÁY

| # | Bước | Lệnh | Ai làm |
|---|---|---|---|
| A0 | Dựng claim-repo + token trên GitLab | (web GitLab) | **người** |
| A1 | Tạo `~/.agent-tasks/` | `node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" setup` | agent |
| A2 | Điền **2** giá trị | sửa 2 file vừa tạo | **người** cấp giá trị, agent ghi |
| A3 | Kiểm 3 tiền đề | `node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" verify` | agent |
| A4 | Dò năng lực instance (nên làm) | `node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" probe --write` | agent |

`probe --write` lưu ở **cấp máy** — `capabilities` là thuộc tính của instance GitLab nên mọi dự án
dùng chung, không phải dò lại từng dự án.

Chỉ **hai** giá trị phải điền, và cả hai dùng chung cho mọi dự án:

| Giá trị | Ở đâu |
|---|---|
| `claimRepoUrl` | `~/.agent-tasks/config.json` |
| `GITLAB_TOKEN` | `~/.agent-tasks/.env` (quyền 600) |

⚠️ **Không** khai `gitlabHost`/`projectPath` ở đây — chúng được đọc từ remote của từng dự án. Khai
vào sẽ ép **mọi** dự án trên máy dùng cùng một project.

## §B. Mỗi dự án

**Bình thường: không phải làm gì.** Mở dự án ra là chạy được, vì `projectPath` đọc từ
`git remote origin`. Chỉ cần một lần:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" labels --apply    # tạo bộ nhãn trên backlog của dự án này
```

Ba ca cần can thiệp:

| Ca | Dấu hiệu | Xử |
|---|---|---|
| Repo chưa có remote | `status`: *"Không tìm thấy remote nào"* | `git remote add origin <url>`, hoặc khai `projectPath` tường minh |
| Nhiều remote, không có `origin` | `status` liệt kê tên các remote | Đặt `remoteName` trong `~/.agent-tasks/config.json`, hoặc khai `projectPath` tường minh |
| Backlog **không** phải repo code (repo tắt Issues, hoặc muốn tách riêng) | `verify`: *"Issues BỊ TẮT"* | Khai tường minh — xem §B1 |

### B1. Khai `projectPath` tường minh cho một dự án

Hai chỗ, chọn theo việc **có muốn commit** hay không:

```jsonc
// .claude/agent-tasks.config.json  — commit được, cả team dùng chung
{ "projectPath": "grp/backlog-rieng" }
```

```bash
# .env ở root dự án — không commit, chỉ máy này
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" init      # tạo .env (TUỲ CHỌN, chỉ khi cần override)
```

Khai tường minh **luôn thắng** giá trị đọc từ remote. Đó là điểm của thiết kế: đọc remote là mặc
định tiện, không phải luật cứng.

⚠️ `labels --apply` và `ingest --apply` **ghi thật** lên GitLab; chạy khi cấu hình còn sai là tạo rác
trong project của người khác. `verify` phải **xanh hết** trước.

→ Dùng hàng ngày (15 tool · các luồng · chẩn đoán): [`USAGE.md`](../../../USAGE.md)

## 0. Tiền đề trên GitLab — hỏi người, đừng đoán

Ba thứ này agent không tự tạo được. Thiếu cái nào thì **dừng và hỏi**, đừng bịa giá trị để
"chạy cho xong":

| Cần | Ghi chú |
|---|---|
| Project **claim-repo** (`grp/agent-claims`) | **MỘT** cái cho cả máy, dùng chung mọi dự án. Sẽ hiện "empty repository" — xem §6 |
| **Group Access Token**, scope `api` | tạo ở group chứa claim-repo **và** các repo dự án |
| **SSH key** của máy này push được vào claim-repo | `git ls-remote git@host:grp/agent-claims.git` không được hỏi mật khẩu |

Backlog **không** nằm trong danh sách này: nó là Issues của chính repo code từng dự án, nên không
phải tạo gì — chỉ cần repo đó **bật Issues** (`verify` kiểm giúp).

Vì sao group token chứ không phải PAT cá nhân: rò rỉ không mở được toàn bộ tài khoản, và audit
trail chỉ rõ bot nào sửa gì. Một token phủ mọi dự án trong group.

## 1. `setup` tạo gì

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" setup
```

Tạo `~/.agent-tasks/config.json` và `~/.agent-tasks/.env` (**quyền 600** — chỉ chủ máy đọc được).
Đã có sẵn thì **không ghi đè**; cần thay thì `--force`, nó lưu `.bak` trước (file này chứa token).

## 2. Điền 2 giá trị

```jsonc
// ~/.agent-tasks/config.json
{ "claimRepoUrl": "git@git.congty.vn:nhom/agent-claims.git" }   // SSH, KHÔNG https
```

```bash
# ~/.agent-tasks/.env
GITLAB_TOKEN=glpat-…      # group access token, scope api
```

Thế thôi. `gitlabHost` và `projectPath` đọc từ `git remote` của từng dự án.

⚠️ **Giá trị mẫu không phải cấu hình.** Ngay sau `setup`, `config.json` chứa
`git@git.example.inc:…`. `status` sẽ báo *"còn GIÁ TRỊ MẪU"* và coi như **chưa** cấu hình — cố ý, để
không ai tưởng đã xong rồi đi gọi một host không tồn tại.

⚠️ **Không đặt token vào file JSON nào.** Cả `~/.agent-tasks/config.json` lẫn
`.claude/agent-tasks.config.json`: token trong đó bị **loại bỏ + cảnh báo**. Hai chỗ hợp lệ duy nhất
là `~/.agent-tasks/.env` (cấp máy) và `.env` của dự án — và chỉ vì chúng được gitignore / nằm ngoài repo.

### Thứ tự ưu tiên khi cùng một khoá xuất hiện nhiều nơi

```
DEFAULTS
 ← ~/.agent-tasks/config.json         cấp máy, dùng chung
 ← .claude/agent-tasks.config.json    dự án, commit được
 ← <git-dir>/agent-tasks-local.json   per-clone, không commit
 ← ~/.agent-tasks/.env                cấp máy: token
 ← .env ở root dự án                  override một dự án
 ← biến ở shell                       cao nhất
      ↓
 ĐỌC từ git remote — chỉ điền khoá CÒN TRỐNG
```

Biến ở shell thắng file — dùng để override tạm một lệnh:
`AGENT_TASKS_TTL_SEC=3600 node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" status`.

⚠️ Vì shell thắng **mọi** tầng, `export GITLAB_TOKEN=…` sẽ đè token của **mọi dự án** trên máy. Cấu
hình sẽ cảnh báo nếu token từ shell khác token cấp máy. Đừng export nó trong `.zshrc`.

Không chắc giá trị đang đọc từ đâu thì `status` in ra: tầng nào đã nạp, và khoá nào **đọc từ remote**.

## 3. Kiểm 3 tiền đề

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" verify
```

Kiểm đúng ba thứ hay sai nhất, và **mỗi thứ báo riêng** để không đổ lỗi sai chỗ:

| Dòng | Nghĩa khi ✗ |
|---|---|
| `cấu hình` | thiếu `claimRepoUrl` (chạy `setup`), không suy được `projectPath` từ remote, hoặc còn giá trị mẫu |
| `claim-repo` | SSH không với tới. Claim đi qua **git-over-ssh**, không qua API — token đúng cũng không cứu được |
| `token` / `backlog` | 401 ⇒ token sai/hết hạn · 403 ⇒ thiếu scope `api` · 404 ⇒ `projectPath` suy từ remote không tồn tại trên host này · **Issues BỊ TẮT** ⇒ bật Issues cho repo, hoặc khai `projectPath` trỏ project khác (§B1) |

`verify` trả exit code ≠ 0 khi còn lỗi. Xanh hết mới sang bước 4.

⚠️ `verify` chạy cho **dự án đang mở**. Máy đã cài xong rồi thì mỗi dự án mới vẫn nên chạy một lần
— nó là chỗ phát hiện repo tắt Issues.

## 4. Tạo bộ nhãn

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" labels          # xem trước, không ghi
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" labels --apply  # ghi thật — idempotent, chạy lại được
```

Nhập tài liệu thành work item là việc **riêng, sau đó**, và làm **từng nguồn một**:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" ingest                        # dry-run (mặc định)
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" ingest --source spec --apply
```

⚠️ Đừng chạy cả ba nguồn ở lần đầu. Parser sai một nguồn thì phải dọn 126 item thay vì 41.

## 4b. Dò năng lực instance

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" probe                        # chỉ dò, không ghi gì
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" probe --issue 1 --write      # + phép thử tier, lưu kết quả
```

Qua MCP thì là tool `tasks_probe_capabilities` với `probe_issue_iid` và `write` — cùng nghiệp vụ,
cùng kết quả. Dùng CLI khi MCP server chưa bật (thường là đúng lúc này, vì bước 5 mới bật nó).

Trả lời: instance bản mấy, CE hay EE, **tier Free hay Premium+**, có Work Items GraphQL không, có
rate limit không. Lõi dự án chỉ dùng tính năng Free nên **không biết tier vẫn chạy được** — biết thì
bỏ được phần mô phỏng scoped label.

Hai điều phải nói với người trước khi chạy `--issue`:

- Phép thử tier **CÓ GHI**: thêm hai nhãn `probe-scope::a` / `probe-scope::b` lên issue đó rồi xoá
  cả hai (kể cả nhãn ở cấp project). Dùng **issue nháp**, đừng dùng work item thật.
- Dọn không được thì kết quả có mục `RÁC CÒN LẠI` kèm chỗ đi xoá tay, và exit ≠ 0. Đọc mục đó,
  đừng bỏ qua.

Đọc kết quả — `?` khác `·`, và đây là chỗ dễ hiểu sai nhất:

| Hiện | Nghĩa |
|---|---|
| `✓ có` | đã đo được, có |
| `· không` | đã đo được, không có |
| `? chưa dò được` | **chưa biết** — lý do nằm ở mục `CHƯA DÒ ĐƯỢC` bên dưới |

Không có issue nháp thì cứ chạy `probe` trần: vẫn dò được version, GraphQL, rate limit; riêng
`tier_guess` sẽ là `unknown`. Không dò được trường nào thì `probe` **không ghi file** và trả exit 2 —
một file `capabilities` toàn `null` sẽ làm lần sau tưởng đã dò rồi.

`--write` lưu vào `<git-dir>/agent-tasks-local.json` — tầng cấu hình per-clone, không commit.

## 5. Bật MCP server và plugin

MCP server **tự đọc cấu hình** — không cần truyền token qua dòng lệnh.

⚠️ Server định vị dự án theo **cwd lúc khởi động** (đi ngược lên tới `.git`), rồi nạp theo thứ tự
`~/.agent-tasks/` → `.env` của dự án → `<git-dir>/agent-tasks.env`. Nên cwd phải nằm trong repo
dự án đang mở, không phải repo agent-task-management.

**Cách A — qua plugin** (khuyến nghị: kèm luôn 6 skill). Marketplace nhận đường dẫn local, không
cần đẩy repo lên GitHub:

```bash
claude plugin marketplace add /đường/dẫn/agent-task-management --scope user
claude plugin install agent-tasks@agent-tasks-marketplace --scope user
```

⚠️ Dùng `--scope user`, **đừng** sửa `.claude/settings.json` của dự án nếu `.claude/` là symlink
dùng chung — bật cho một dự án là bật cho mọi dự án trỏ vào đó.

**Cách B — chỉ MCP server, không skill:**

```bash
claude mcp add agent-tasks -- node /đường/dẫn/agent-task-management/server.mjs
```

⚠️ **Đừng làm cả hai.** Plugin đã kèm MCP server; cài thêm bằng tay là hai server cùng khai 15
tool trùng tên. `claude mcp list` chỉ được thấy MỘT dòng `agent-tasks`.

**Kiểm đã lên chưa:** mở Claude Code, hỏi *"còn việc gì trong hàng đợi"* → phải gọi `tasks_list`.
Hoặc `claude mcp list` thấy `agent-tasks: ✓ connected`. Còn thấy đủ 15 tool nhưng gọi cái nào cũng
trả "chưa sẵn sàng" ⇒ server chạy đúng, chỉ là cwd không nằm trong repo dự án nào.

## 6. Hai thứ trông như hỏng nhưng bình thường

**claim-repo hiện "empty repository".** Đúng, không phải hỏng. Claim sống dưới custom ref
`refs/claims/*`, mà web UI GitLab chỉ render branch và tag. Kiểm bằng git, không bằng UI:

```bash
git ls-remote <claimRepoUrl> 'refs/claims/*'
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" claims
```

**Claim tự hết hạn khi đóng Claude Code.** Heartbeat sống theo tiến trình; đóng máy ⇒ claim hết
sau ≤ `ttlSec` (mặc định 30 phút) và việc quay lại hàng đợi. Đó là hành vi đúng.

## Sự cố khi cài

| Triệu chứng | Nguyên nhân | Xử |
|---|---|---|
| `✗ .env vẫn còn GIÁ TRỊ MẪU` | `init` rồi chưa điền | §2 |
| Đặt token đúng trong `.env` mà vẫn báo thiếu token | shell có `GITLAB_TOKEN` rỗng đè lên | `unset GITLAB_TOKEN` rồi thử lại |
| `Không tìm thấy .git` | chạy ngoài git repo | chạy từ trong root dự án |
| `reason: "offline"` | không với tới claim-repo | `git ls-remote <claimRepoUrl>` |
| `reason: "local-setup"` | lỗi **đĩa local**, không phải mạng | kiểm quyền ghi + dung lượng `/tmp` |
| Hai nhãn `status::*` trên một item | GitLab Free không loại trừ scoped label | `tasks_doctor --fix` |
| `heartbeatSec >= ttlSec` | claim sẽ chết giữa lúc đang làm | đặt `heartbeatSec ≈ ttlSec/3` |

## Gỡ cài đặt

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" claims                                   # nhả hết claim trước
git push <claimRepoUrl> --delete 'refs/claims/<projectKey>/*'   # dọn ref còn sót
```

Rồi gỡ plugin:

```bash
claude plugin uninstall agent-tasks@agent-tasks-marketplace
claude plugin marketplace remove agent-tasks-marketplace
```

Work item trên GitLab **giữ nguyên** — chúng là dữ liệu của bạn, không phải của công cụ.
