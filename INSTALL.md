# Cài đặt agent-tasks

Hai phần tách bạch: **MCP server** (chạy được độc lập) và **plugin Claude Code** (lớp mỏng bọc
ngoài). Bộ khung chỉ khai plugin, không chứa code.

| Tài liệu | Trả lời |
|---|---|
| **INSTALL.md** (đây) | Cài thế nào, một lần cho máy + gì cho mỗi dự án |
| [`USAGE.md`](USAGE.md) | **Dùng hàng ngày**: 15 tool · 11 lệnh · các luồng thật · chẩn đoán |
| [`README.md`](README.md) | Plugin làm gì, cài thế nào, 13 nhãn, và giới hạn đã biết |

## HAI đường cài — chọn đúng đường của bạn

| | Bạn là | Cần clone repo? | Cần `npm install`? |
|---|---|---|---|
| **A. Cài từ marketplace** | người **dùng** plugin | ❌ | ❌ |
| **B. Clone** | người **sửa** plugin | ✅ | ✅ |

---

### ⚡ A. Cài từ marketplace — không cần source git

```
/plugin marketplace add TanTranDev/members-cc-agent-tasks-publish
/plugin install agent-tasks@agent-tasks-marketplace
```

Rồi **khởi động lại Claude Code**, và nói với agent: `/task-setup`. Skill đó chạy nốt phần cấu hình
(2 giá trị cho cả máy, rồi 1 lệnh cho mỗi dự án) — bạn không phải gõ đường dẫn nào.

**Vì sao không cần `npm install`**: Claude Code chạy `npm ci --ignore-scripts` ngay trong bản copy ở
cache, vì plugin root có `package.json` + `package-lock.json`. MCP server nạp được SDK từ đó.

⚠️ **Cập nhật đi theo `version` của `plugin.json`, không theo commit.** `claude plugin update` so
VERSION chứ không so nội dung: version không đổi thì nó báo *"already at the latest version"* rồi
không làm gì. Nên bản phát hành nào cũng bump version — và bạn cập nhật bằng:

```
/plugin update agent-tasks
```

---

### B. Clone — chỉ khi bạn SỬA plugin

```bash
npm install
node plugin/bin/tasks-cli.mjs setup           # 1 lần cho MÁY → điền 2 giá trị
node plugin/bin/tasks-cli.mjs verify          # phải xanh hết
node plugin/bin/tasks-cli.mjs probe --write   # 1 lần cho MÁY (dò tier instance)
node plugin/bin/tasks-cli.mjs labels --apply  # 1 lần cho MỖI DỰ ÁN
```

Dự án thứ hai trở đi: **chỉ** dòng cuối.

⚠️ Sửa skill xong mà không thấy tác dụng: bản đã cài là một **bản copy** trong cache, và `plugin
update` so version. Chạy `npm run plugin:sync` — nó so nội dung, bump version khi (và chỉ khi) nội
dung thật sự khác, rồi đồng bộ.

---

## 1. Chuẩn bị trên GitLab (một lần cho cả team)

### 1.1 Repo nào cần có

| Repo | Chứa gì | Phải tạo mấy cái |
|---|---|---|
| **claim-repo** (vd `grp/agent-claims`) | chỉ **khoá**: `refs/claims/*`. Không commit, không issue | **1** cho cả team |
| **backlog** = Issues của **chính repo code** | work item của **riêng** dự án đó | **0** — mỗi dự án đã có sẵn |

⚠️ Đây **không phải** "một repo GitLab cho mọi dự án". Chỉ *khoá* mới dùng chung; *dữ liệu* thì
mỗi dự án một chỗ.

- **claim-repo dùng chung được** vì ref đã tách sẵn theo dự án —
  `refs/claims/<projectKey>/<sha1(host/projectPath#iid)>`. Hai dự án không đụng ref của nhau kể cả
  khi trùng iid. Loại trừ tương hỗ cần một điểm hội tụ; tách ra chỉ tốn thêm SSH + cấu hình mỗi dự
  án mà không được gì. Đổi lại, `claims --all` (§6) thấy được toàn cảnh mọi dự án trong một lệnh.
- **backlog KHÔNG dùng chung**: `projectPath` đọc từ `git remote` của dự án đang mở (§3.2), nên dự
  án nào ghi issue vào repo của dự án đó. Không phải tạo gì, chỉ cần repo code bật Issues
  (`verify` kiểm giúp). Repo tắt Issues, hoặc muốn backlog riêng ⇒ §3.3.

Thật sự cần claim-repo riêng cho một dự án (vd repo đó ở group khác, không dùng chung SSH được)
thì khai `claimRepoUrl` ở `.claude/agent-tasks.config.json` — tầng dự án thắng tầng máy (§3.4).

⚠️ Vì chỉ chứa custom ref, claim-repo **luôn hiện "empty repository"** trên web UI — bình thường,
không phải hỏng. Cách kiểm ở §6.

💡 Ghi ngay vào phần mô tả của claim-repo: *"Repo này chỉ chứa custom ref `refs/claims/*`.
UI hiện 'empty repository' là đúng. Kiểm bằng `git ls-remote <url> 'refs/claims/*'`."*
Không ghi thì sẽ có người mở ra, thấy trống, rồi tưởng hỏng.

### 1.2 Token

Tạo **Group Access Token** ở group chứa claim-repo **và** các repo dự án (miễn phí trên self-managed):

- Scope: `api` (đọc + ghi). Không có scope hẹp hơn cho issues — GitLab không chia nhỏ tới mức đó.
- Hạn: 90 ngày, đặt lịch xoay vòng.
- Chỗ đặt: `~/.agent-tasks/.env` — **một lần cho cả máy** (§3.2).

⚠️ Group token blast-radius nhỏ hơn PAT: rò rỉ không mở được toàn bộ tài khoản, và audit trail
chỉ rõ bot nào sửa gì.

### 1.3 Quyền SSH vào claim-repo

Claim đi qua **git-over-ssh**, không qua API. Máy nào dùng agent-tasks thì key SSH của máy đó
phải push được vào claim-repo.

```bash
git ls-remote git@git.example.inc:grp/agent-claims.git    # phải chạy được, không hỏi mật khẩu
```

---

## 2. Cài server

**Cài từ marketplace (đường A)** ⇒ **bỏ qua mục này.** Server đã nằm trong plugin, và Claude Code đã
chạy `npm ci` giúp bạn. Đi thẳng tới §3.

**Chỉ khi bạn SỬA plugin (đường B)**:

```bash
git clone <repo dev của plugin này>
cd <thư mục vừa clone>
npm install
node plugin/bin/tasks-cli.mjs status      # phải in ra trạng thái, không nổ
```

Node ≥ 20.

---

## 3. Cấu hình — một lần cho cả máy

### 3.1 Tạo

```bash
node plugin/bin/tasks-cli.mjs setup     # tạo ~/.agent-tasks/{config.json,.env}, quyền 600
```

### 3.2 Điền đúng 2 giá trị

```jsonc
// ~/.agent-tasks/config.json
{ "claimRepoUrl": "git@git.example.inc:grp/agent-claims.git" }   // SSH, KHÔNG https
```

```bash
# ~/.agent-tasks/.env
GITLAB_TOKEN=glpat-…      # group token, scope api
```

Xong. **Mọi dự án trên máy dùng được**, không cần cấu hình riêng: `gitlabHost` và `projectPath`
được **đọc từ `git remote`** của từng dự án (backlog = Issues của repo code).

⚠️ **Đừng khai `gitlabHost`/`projectPath` ở cấp máy** — làm vậy là ép mọi dự án dùng cùng một
project.

⚠️ **Giá trị mẫu không phải cấu hình.** Ngay sau `setup`, `config.json` còn
`git@git.example.inc:…`; `status` báo *"còn GIÁ TRỊ MẪU"* và coi như **chưa** cấu hình. Cố ý — để
không ai tưởng đã xong rồi đi gọi một host không tồn tại.

### 3.3 Khi một dự án cần khác cấp máy

Ba ca: repo tắt Issues · muốn backlog riêng · nhiều remote không có `origin`.

**Cách được khuyến nghị — cấu hình của riêng clone bạn:**

```bash
node plugin/bin/tasks-cli.mjs init --local    # tạo <git-dir>/agent-tasks.env, quyền 600
```

Một file, khai được cả ba thứ: nơi chứa work item (`AGENT_TASKS_PROJECT_PATH`), nơi chứa ref
(`AGENT_TASKS_CLAIM_REPO_URL`), và token. Dòng nào để trống thì kế thừa tầng trên; xoá file là mọi
thứ về y như cũ.

Ba lý do nó nằm trong `<git-dir>/` chứ không ở đâu khác:

| Chỗ | Vì sao **không** dùng |
|---|---|
| `.claude/agent-tasks.config.json` | `.claude/` rất hay là **symlink dùng chung** giữa nhiều repo. Đặt `projectPath` ở đó ⇒ N dự án đọc chung một giá trị ⇒ work item ghi nhầm backlog, claim nhầm `projectKey`. `status` cảnh báo nếu phát hiện ca này |
| `.env` ở root dự án | File đó thường là của **ứng dụng** (17 dòng của Flutter/Node…), cả team dùng chung nội dung. Trộn token agent-tasks vào là ép hai vòng đời chung một file |
| `<git-dir>/agent-tasks.env` ✅ | Thư mục thật của **từng clone**. Git không có đường nào track ⇒ an toàn theo **cấu trúc**, không nhờ ai nhớ gitignore |

Vẫn dùng được `.claude/agent-tasks.config.json` khi cả team **cần** chung một giá trị và `.claude/`
là thư mục thật:

```jsonc
{ "projectPath": "grp/backlog-rieng" }     // commit được — token thì không, xem §3.4
```

Khai tường minh **luôn thắng** giá trị đọc từ remote.

### 3.4 Thứ tự ưu tiên

```
DEFAULTS
 ← ~/.agent-tasks/config.json         cấp máy, dùng chung
 ← .claude/agent-tasks.config.json    dự án, commit được
 ← <git-dir>/agent-tasks-local.json   per-clone, không commit
 ← ~/.agent-tasks/.env                cấp máy: token
 ← .env ở root dự án                  override một dự án
 ← <git-dir>/agent-tasks.env          per-clone: token + mọi khoá  ★
 ← biến ở shell                       cao nhất
      ↓
 ĐỌC từ git remote — chỉ điền khoá CÒN TRỐNG
```

Tầng ★ thắng `.env` của dự án vì **cụ thể hơn**: một dự án có thể có nhiều clone, và `.env` ở root
là thứ cả team dùng chung.

Token chỉ được ở một file `.env` (cấp máy · dự án · clone) hoặc shell: token trong **file JSON nào
cũng** bị **loại bỏ + cảnh báo**, vì JSON commit được. Quy tắc đó không có ngoại lệ nào.

💡 Giá trị **rỗng = chưa khai**, không phải "đặt về rỗng". `GITLAB_TOKEN=` bỏ trống ở tầng dưới
không xoá token của tầng trên — cố ý, vì `init --local` sinh sẵn dòng đó để bạn điền vào.

⚠️ Biến shell thắng **mọi** tầng, nên `export GITLAB_TOKEN=…` trong `.zshrc` sẽ đè token của **mọi
dự án**. Cấu hình cảnh báo nếu token từ shell khác token cấp máy.

```bash
AGENT_TASKS_TTL_SEC=3600 node plugin/bin/tasks-cli.mjs status   # override tạm một lệnh
```

Không chắc giá trị đọc từ đâu: `status` in từng tầng đã nạp **và** khoá nào đến từ git remote.

### 3.5 Tắt riêng một clone

```bash
AGENT_TASKS_ENABLED=false        # trong <git-dir>/agent-tasks.env của clone đó
```

Đặt ở đó thì đúng phạm vi "một clone" và không ai commit nhầm sang máy người khác.

---

## 4. Cài plugin vào Claude Code

Marketplace nhận **đường dẫn local**, không cần đẩy repo lên GitHub:

```bash
claude plugin marketplace add /đường/dẫn/agent-task-management --scope user
claude plugin install agent-tasks@agent-tasks-marketplace --scope user
```

Được **15 tool + 7 skill**. Skill là thứ dạy agent *khi nào* gọi tool nào — thiếu nó thì tool vẫn
chạy nhưng agent phải đoán, và chỗ trả giá là `task_complete` với 7 điều kiện của nó.

⚠️ **`--scope user`, đừng sửa `.claude/settings.json` của dự án** nếu `.claude/` là symlink dùng
chung: bật cho một dự án là bật cho tất cả những dự án trỏ vào đó (§3.3).

Chỉ muốn tool, không muốn skill:

```bash
claude mcp add agent-tasks -- node /đường/dẫn/server.mjs
```

⚠️ **Đừng làm cả hai.** Plugin đã kèm MCP server, nên cài thêm bằng tay là **hai** server cùng
khai 15 tool trùng tên trong một phiên. Kiểm bằng `claude mcp list` — chỉ được thấy **một** dòng
`agent-tasks`. (`claude plugin details` báo *"MCP servers (0)"* cho plugin này là **sai** — nó có
đăng ký, chỉ là inventory không đếm.)

### 4.1 Sau mỗi lần sửa repo này

Hai nửa của plugin cập nhật theo **hai cơ chế khác nhau**:

| Sửa gì | Phải làm |
|---|---|
| `plugin/skills/*/SKILL.md` | `npm run plugin:sync` rồi **restart** — skill được **copy** vào `~/.claude/plugins/cache/…/<version>/`, và `plugin update` so VERSION chứ không so nội dung |
| `plugin/server.mjs` · `plugin/lib/` · `plugin/bin/` | **restart** Claude Code; nếu không thấy tác dụng thì `npm run plugin:sync` rồi restart |

⚠️ **Giả định CHƯA đo lại ở dòng thứ hai.** Trước v0.2, `server.mjs` nằm ở gốc repo và manifest trỏ
`${CLAUDE_PLUGIN_ROOT}/../server.mjs`, nên MCP chạy **thẳng từ repo** — restart là đủ, đã đo. Từ v0.2
code nằm TRONG plugin root (đổi này là để bản cài từ marketplace tự đủ), nên `${CLAUDE_PLUGIN_ROOT}`
có thể trỏ vào **bản copy trong cache** thay vì thư mục nguồn. Nếu đúng vậy thì sửa `lib/` cũng cần
`plugin:sync`. Chưa đo trên một lượt cài thật, nên đây là giả định, không phải kết luận — cách chốt:
sửa một dòng `log()` trong `plugin/server.mjs`, restart, xem stderr có đổi không.

```bash
npm run plugin:sync              # bump version → claude plugin update → dọn bản cũ
npm run plugin:sync -- --dry-run # chỉ xem sẽ làm gì
```

⚠️ **`claude plugin update` so VERSION, không so nội dung.** Sửa skill mà không bump thì lệnh báo
*"already at the latest version"* rồi **không làm gì** — bạn tiếp tục chạy bản cũ, không dấu hiệu
nào. Đó là toàn bộ lý do có `plugin:sync`: nó bump **khi và chỉ khi** nội dung thật sự khác bản đã
cài, nên chạy thừa cũng không sinh rác.

💡 Không cần commit trước khi sync: cache copy từ **working tree**. (`gitCommitSha` trong
`installed_plugins.json` vẫn ghi commit cũ — đừng tin field đó.)

Không cần `--env GITLAB_TOKEN=…`: server tự đọc `~/.agent-tasks/.env`. Truyền thêm cũng được, biến
shell thắng — nhưng xem cảnh báo ở §3.4.

⚠️ Server định vị dự án theo **cwd lúc khởi động** (đi ngược lên tới `.git`). Thấy đủ 15 tool nhưng
gọi cái nào cũng trả "chưa sẵn sàng" ⇒ server chạy đúng, chỉ là cwd không nằm trong repo dự án nào.

Kiểm: mở Claude Code, hỏi *"còn việc gì trong hàng đợi"* — nó phải gọi `tasks_list`.

---

## 5. Khởi tạo dữ liệu

### 5.1 Một lần cho cả MÁY

```bash
node plugin/bin/tasks-cli.mjs verify              # 3 tiền đề: cấu hình · SSH claim-repo · token + Issues
node plugin/bin/tasks-cli.mjs probe --write       # dò năng lực instance rồi lưu vào ~/.agent-tasks/config.json
                                           #   thêm --issue <iid nháp> để dò được cả tier
                                           #   ⚠️ phép thử tier CÓ GHI 2 nhãn rồi xoá — dùng issue nháp
```

`probe --write` lưu ở **cấp máy** vì `capabilities` là thuộc tính của **instance GitLab**, không của
dự án — mọi dự án dùng chung instance thì dò một lần là đủ. Máy dùng hai instance thì
`capabilities.host` ghi rõ bản ghi thuộc host nào.

### 5.2 Mỗi dự án

```bash
node plugin/bin/tasks-cli.mjs status               # xác nhận host/project derive đúng
node plugin/bin/tasks-cli.mjs verify               # chỗ phát hiện repo TẮT Issues
node plugin/bin/tasks-cli.mjs labels               # xem 13 nhãn sẽ tạo
node plugin/bin/tasks-cli.mjs labels --apply       # tạo thật (idempotent, chạy lại được)
```

Nâng cấp từ plugin 0.1.x trên một project đã có nhãn cũ: thêm một bước dọn. `--prune` xoá theo danh
sách 33 nhãn ĐÃ NGHỈ ở v0.2, và GitLab gỡ nhãn đó khỏi **mọi issue đang mang** — không lùi được, nên
lệnh mặc định chỉ liệt kê:

```bash
node plugin/bin/tasks-cli.mjs labels --prune          # xem nhãn nào còn tồn tại
node plugin/bin/tasks-cli.mjs labels --prune --apply  # xoá thật
```

Không prune cũng chạy đúng: nhãn cũ chỉ còn là rác hiển thị, không tool nào ghi thêm chúng. Nhưng
**máy nào còn chạy 0.1.x sẽ gắn lại `shape::`/`role::`/`source::`** lên item mới — nâng cấp cả nhóm
trước khi prune, không thì dọn xong lại mọc.

⚠️ `labels --apply` chạy trên backlog của **dự án đang mở**, nên mỗi dự án cần một lần.

### 5.3 Nhập tài liệu có sẵn thành work item (tuỳ chọn)

```bash
node plugin/bin/tasks-cli.mjs ingest                        # DRY-RUN: xem kế hoạch + nợ metadata
node plugin/bin/tasks-cli.mjs ingest --source spec --apply  # làm từng nguồn một
node plugin/bin/tasks-cli.mjs ingest --source changelog --apply
node plugin/bin/tasks-cli.mjs ingest --source brief --apply

node plugin/bin/tasks-cli.mjs doctor              # xác nhận không lệch
```

⚠️ **Đừng chạy cả ba nguồn cùng lúc ở lần đầu.** Parser sai ở một nguồn thì dọn 126 item thay
vì 41. `ingest` mặc định dry-run vì lý do đó.

💡 Từ nay yêu cầu mới nên đi qua `task_intake` (xem [`USAGE.md` §5.1](USAGE.md#51-task-mới-thêm-ws-reconnect))
— `ingest` là để nhập **tài liệu đã có sẵn** trong repo, không phải đường vào thường ngày.

---

## 6. Kiểm tra hoạt động

```bash
node plugin/bin/tasks-cli.mjs claims        # claim của dự án đang mở
node plugin/bin/tasks-cli.mjs claims --all  # mọi dự án dùng claim-repo này
git ls-remote <claimRepoUrl> 'refs/claims/*'
```

Thấy `refs/claims/<projectKey>/<sha1>` là đúng. Web UI vẫn hiện "empty repository" — bình thường.

Nhiều dự án dùng chung một claim-repo nên `--all` sẽ hiện **nhiều `projectKey`** — đó là toàn cảnh
"máy này đang giữ việc gì ở những dự án nào".

---

## 7. Sự cố thường gặp

| Triệu chứng | Nguyên nhân | Xử |
|---|---|---|
| `Thiếu claimRepoUrl … tasks-cli setup` | Máy chưa cài | §3.1 — `tasks-cli setup` |
| `Không suy được projectPath từ git remote` | Repo chưa có remote, hoặc nhiều remote không có `origin` | `git remote add origin <url>`, đặt `remoteName`, hoặc khai `projectPath` (§3.3) |
| `Issues BỊ TẮT` | Backlog là Issues của repo code mà repo đó tắt Issues | Bật Issues, hoặc khai `projectPath` trỏ project khác (§3.3) |
| `còn GIÁ TRỊ MẪU` | `setup` rồi nhưng chưa điền | §3.2 |
| Token đúng mà vẫn báo thiếu | shell có `GITLAB_TOKEN` **rỗng** đè lên | `unset GITLAB_TOKEN` rồi thử lại |
| Dự án A dùng token của dự án B | `export GITLAB_TOKEN` ở shell đè mọi dự án | Bỏ export; cấu hình có cảnh báo sẵn cho ca này |
| Nhiều dự án cùng đọc một `projectPath` | `.claude/` là **symlink dùng chung**, mà cấu hình lại đặt trong đó | `tasks-cli init --local` rồi xoá `.claude/agent-tasks.config.json` (§3.3) |
| Đủ 15 tool nhưng tool nào cũng "chưa sẵn sàng" | cwd của server không nằm trong repo dự án | §4 |
| `heartbeatSec >= ttlSec` | Claim chết giữa lúc đang làm | Đặt `heartbeatSec ≈ ttlSec/3` |
| `reason: "offline"` | Không với tới claim-repo | Kiểm SSH: `git ls-remote <url>` |
| `reason: "local-setup"` | Lỗi **đĩa local**, không phải mạng | Kiểm quyền ghi + dung lượng `/tmp` |
| claim-repo hiện "empty repository" | Custom ref không render trên UI | Bình thường — §1.1 |
| Hai nhãn `status::*` trên một item | GitLab Free không loại trừ scoped label | `tasks_doctor --fix` |
| Claim hết hạn giữa lúc đang làm | Heartbeat chết cùng tiến trình | `task_claim` lại; tăng `ttlSec` nếu task thường dài hơn |
| Tài liệu không lên item | Chưa gọi `task_attach_docs` trước `task_complete`/`task_block` | Claim đã nhả ⇒ không ghi được nữa. Lần sau đính trước |
| `dry_run: true` mãi | Không khai `ledger` nên tool phải đoán bằng mtime | Khai `ledger` tường minh, hoặc thêm `confirm: true` |
| File `.md` đính kèm không render trên GitLab | Đúng hành vi của GitLab, không phải lỗi | Đọc khối tóm tắt trong description; file gốc để đối chiếu |
| ⚠️ `HOST LỆCH` | `projectPath` suy từ remote host A, `gitlabHost` khai host B | Khai **cả hai** tường minh nếu đúng ý (§3.3) |
| Ứng viên trùng là issue của người dùng | Backlog là Issues của repo code nên trộn lẫn | Bình thường — signal ghi rõ *"issue do NGƯỜI tạo"*. Đọc rồi quyết |
| Mỗi dự án lại phải `probe` | Bản cũ ghi capabilities per-clone | Đã sửa: `probe --write` lưu cấp máy. Chạy lại một lần |

→ Bảng chẩn đoán đầy đủ hơn, kèm cách đọc kết quả từng tool: [`USAGE.md` §9](USAGE.md#9-chẩn-đoán)

---

## 8. Gỡ cài đặt

```bash
node plugin/bin/tasks-cli.mjs claims                                   # nhả hết claim trước
git push <claimRepoUrl> --delete 'refs/claims/<projectKey>/*'   # dọn ref còn sót
```

Gỡ hẳn khỏi máy thì xoá cả cấu hình cấp máy:

```bash
rm -rf ~/.agent-tasks        # ⚠️ chứa token — xoá là mất, không có bản sao
```

Rồi bỏ `enabledPlugins` khỏi `.claude/settings.json`. Work item trên GitLab **giữ nguyên** —
chúng là dữ liệu của bạn, không phải của công cụ.
