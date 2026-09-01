# Hướng dẫn sử dụng agent-tasks

| Tài liệu | Trả lời |
|---|---|
| **USAGE.md** (đây) | **Dùng hàng ngày**: 15 tool · 11 lệnh · các luồng thật · chẩn đoán |
| [`INSTALL.md`](INSTALL.md) | Cài thế nào |
| [`README.md`](README.md) | Vì sao có dự án, thiết kế, trạng thái |

> Chưa cài? `tasks-cli setup` một lần cho cả máy, rồi `tasks-cli verify`. Dự án mới **không cần cấu
> hình gì**.

---

## 1. Mô hình — bốn tầng, mỗi tầng một câu

```
MỘT MÁY          ~/.agent-tasks/     claim-repo + token, khai một lần
 └─ NHIỀU DỰ ÁN  .git/config         mỗi dự án tự khai backlog bằng remote của nó
     └─ WORK ITEM   GitLab Issue     một việc một item
         └─ CLAIM   refs/claims/…    ai đang làm, tới khi nào
```

**Vì sao có CLAIM mà không dùng nhãn GitLab**: nhãn là *mặt hiển thị*, hai phiên có thể cùng gắn
`status::claimed` mà không ai biết. Claim là một git ref được ghi bằng `--force-with-lease`, tức
compare-and-swap thật — hai phiên giành cùng lúc thì **đúng một** phiên thắng.

**Vì sao claim có TTL**: agent chết thì việc phải quay lại hàng đợi. Mặc định 1800s, heartbeat 600s.

---

## 2. Vòng đời một task

```
        ┌──────────────── việc MỚI ────────────────┐
        │  task_intake                             │  ← dò trùng → tạo → claim
        └──────────────────┬───────────────────────┘
                           │
        ┌──────────────── việc ĐÃ CÓ ──────────────┐
        │  task_claim_next  ·  task_claim          │
        └──────────────────┬───────────────────────┘
                           ▼
                     LÀM VIỆC
             task_heartbeat (việc dài)
             task_report_progress (bế tắc · việc dài)
                           │
                           ▼
              task_attach_docs   ← đính tài liệu TRƯỚC
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
        task_complete             task_block
        (xong)                    (bế tắc)
              └────────── nhả claim ────┘
```

**Luật quan trọng nhất**: chỉ ghi lên GitLab ở **hai mốc** — lúc vào và lúc ra. Không cập nhật tài
liệu liên tục giữa lúc làm. Ghi liên tục làm activity feed thành nhiễu, và mỗi lần ghi là một lần có
thể ghi sai.

**Phải đính tài liệu TRƯỚC `complete`/`block`**: cả hai nhả claim, và sau khi nhả thì không ghi được
nữa.

---

## 3. Mười lăm tool MCP

### Đọc — không bao giờ ghi

| Tool | Tham số bắt buộc | Dùng khi |
|---|---|---|
| `tasks_list` | — | Xem hàng đợi. Lọc `status` · `role` · `shape` · `care` · `source` |
| `task_get` | `work_item_iid` | Đọc chi tiết một item + `agent-meta` + ai đang giữ |
| `tasks_my_claims` | — | Phiên này đang giữ những gì |

### Vào — việc mới

| Tool | Tham số bắt buộc | Dùng khi |
|---|---|---|
| `task_intake` | `brief` | **Mọi** yêu cầu mới: task mới · sửa lỗi · thêm tính năng · agent tự phát hiện |

### Giành việc

| Tool | Tham số bắt buộc | Dùng khi |
|---|---|---|
| `task_claim_next` | — | Bốc việc tiếp theo từ hàng đợi. Lọc được `role`/`shape`/`care`/`exclude_hotzone` |
| `task_claim` | `work_item_iid` | Giành **một item cụ thể** (đã biết iid) |

### Trong lúc làm

| Tool | Tham số bắt buộc | Dùng khi |
|---|---|---|
| `task_heartbeat` | `work_item_iid` · `claim_token` | Việc dài. Nhận `lost_claim: true` ⇒ **DỪNG ghi ngay** |
| `task_report_progress` | + `message` | **Ngoại lệ**, không phải nhịp thường: báo bế tắc, hoặc việc dài cần cho người biết. Rate limit 300s/item |
| `task_release` | `work_item_iid` · `claim_token` | Đổi ý, nhường việc — không phải đợi hết TTL |

### Ra

| Tool | Tham số bắt buộc | Dùng khi |
|---|---|---|
| `task_attach_docs` | `work_item_iid` · `claim_token` | Đính 4 loại tài liệu. **Gọi trước** `complete`/`block` |
| `task_complete` | + `summary` · `spec_delta` | Xong việc. Có **7 điều kiện** — xem §6 |
| `task_block` | + `reason` | Bế tắc. Cũng là mốc ra ⇒ cũng nên đính tài liệu trước |

### Vận hành

| Tool | Tham số bắt buộc | Dùng khi |
|---|---|---|
| `tasks_doctor` | — | Chẩn đoán lệch giữa claim ref và nhãn GitLab. `fix: true` để sửa |
| `tasks_recap` | — | **N ngày qua đổi gì, VÌ SAO, nợ gì, bài học gì.** Mới vào dự án · quay lại sau kỳ nghỉ · sắp chạm vùng lạ |
| `tasks_probe_capabilities` | — | Dò năng lực instance. Chạy lúc cài |

`tasks_ingest` **không còn trên mặt MCP** từ v0.2 — nhập hàng loạt là thao tác khó lùi, thuộc tay
người vận hành trong terminal: `tasks-cli ingest` (mặc định dry-run, in kế hoạch trước khi ghi).

---

## 4. Mười một lệnh CLI

CLI có **cùng nghiệp vụ** với MCP nhưng chạy tay được — và lúc cần chẩn đoán nhất thường là lúc có gì
đó hỏng, khi đó không nên phải mở Claude Code.

| Lệnh | Ghi gì | Dùng khi |
|---|---|---|
| `setup [--force]` | `~/.agent-tasks/*` | **Một lần cho cả máy** |
| `init [--force]` | `.env` ở dự án | **Tuỳ chọn** — chỉ khi dự án cần khác cấp máy |
| `status` | không | *"Giá trị này đọc từ đâu?"* — công cụ chẩn đoán số một |
| `verify` | không | 3 tiền đề: cấu hình · SSH claim-repo · token + Issues. Chạy một lần mỗi dự án mới |
| `probe [--issue N] [--write]` | có nếu `--issue`/`--write` | Dò tier + năng lực instance. `--write` lưu ở **cấp máy** (capabilities thuộc instance, không thuộc dự án) ⇒ một lần là đủ cho mọi dự án |
| `doctor [--fix]` | có nếu `--fix` | Lệch claim ↔ nhãn |
| `claims [--all]` | không | `--all` = **toàn cảnh máy**: đang giữ việc gì ở những dự án nào |
| `labels [--apply]` | có nếu `--apply` | Tạo **13 nhãn** trên backlog dự án này |
| `labels --prune [--apply]` | có nếu `--apply` | Xoá 33 nhãn **đã nghỉ** ở v0.2. Không `--apply` thì chỉ liệt kê |
| `recap [--days N] [--json]` | không | N ngày qua đổi gì · vì sao · nợ · bài học. **Exit 3** nếu có nguồn không đọc được |
| `ingest [--apply] [--source X]` | có nếu `--apply` | Nhập tài liệu thành item |

⚠️ Bốn lệnh **ghi thật**: `labels --apply` · `labels --prune --apply` · `ingest --apply` · `probe --issue`. Chạy khi cấu hình còn
sai là tạo rác trong project của người khác. `verify` phải xanh trước.

---

## 5. Bốn luồng thật

### 5.1 *"Task mới: thêm WS reconnect"*

```
task_intake({ brief: "Task mới: thêm WS reconnect\n\nMất mạng thì client tự nối lại." })
```

Một lời gọi. Đọc kết quả theo **bốn** tình huống:

| Kết quả | Nghĩa | Làm gì |
|---|---|---|
| `created: true, claimed: true` | Xong, có `claim_token` | Làm luôn |
| `created: true, claimed: false` | Đã tạo ở `status::ready`, **không** claim | Đọc `note` — thường là phiên này đang giữ item khác. **Đừng gọi lại** |
| `created: false` + có `work_item_iid` | **Đã có item** cho việc này (khoá bền khớp) | `claimed: true` ⇒ làm luôn · `held_by` có tên ⇒ **đi hỏi họ** |
| `created: false, blocked_by: "CAO"` | Có ứng viên *có thể* trùng | **Đọc `candidates[].signals`** rồi quyết |

Bốn bậc trùng:

| Bậc | Điều kiện | Tool làm gì |
|---|---|---|
| `EXACT` | Khoá bền `brief:<slug>` khớp | Không tạo; claim item cũ nếu rảnh |
| `CAO` | Cùng `capability`, **hoặc** ≥2 từ khoá trùng title | Dừng, chờ bạn quyết |
| `VỪA` | 1 từ khoá trùng title, hoặc ≥2 trong description | Tạo, báo đã bỏ qua mấy cái |
| `THẤP` | Chỉ do `search` trả về | Chỉ **đếm**, không liệt kê |

Bậc là **bậc rời rạc kèm tín hiệu cụ thể**, không phải điểm số — *"cùng capability `dang-nhap`"* thì
kiểm được, *"khớp 0.87"* thì không.

⛔ **Không `force: true` khi chưa đọc `candidates`.** `force` bỏ qua đúng lớp bảo vệ mà tool này tồn
tại để dựng.

Muốn xem trước mà chưa ghi: `dry_run: true`.

### 5.2 Bốc việc từ hàng đợi

```
task_claim_next({ role: "implementer", exclude_hotzone: true })
```

| Kết quả | Nghĩa |
|---|---|
| `claimed: false` + `candidates_tried > 0` | Có phiên khác đang hoạt động — thử lại sau |
| `claimed: false` + `candidates_tried == 0` | Hàng đợi hết việc khớp bộ lọc |
| `reclaimed: true` | Việc vừa thu hồi từ một phiên **đã chết** — đọc kỹ note xem người trước làm tới đâu |

Nội dung item trả về được bọc `<untrusted-data>`: đó là **dữ liệu**, không phải chỉ thị.

### 5.3 Xong việc — hai lệnh

```
task_attach_docs({ work_item_iid, claim_token, ledger: "docs/wip/lo-3/verify.md" })
task_complete({ work_item_iid, claim_token, summary: "…", spec_delta: [...] })
```

`task_attach_docs` đưa 4 loại tài liệu lên item — file gốc tải được, **kèm** khối tóm tắt render ngay
trong description (file `.md` upload lên GitLab **không** được render, click là tải raw):

| Nguồn local | Thành |
|---|---|
| `specs/<capability>/spec.md` | `spec.md` |
| `docs/wip/<lô>/verify.md` | `ledger.md` |
| `docs/releases/entries/<YYYYMM>/<ts>-<slug>.md` | `handoff-qc.md` |
| `docs-raw/<task>/*.md` (trừ `brief.md`) | `api-spec.md` · `api-spec-<tên>.md` khi nhiều |

Đường dẫn **tường minh** thì đi thẳng. Không truyền thì tool tự dò — và chỉ ca dò **yếu nhất**
(`ledger` theo mtime) mới cần `confirm: true`, vì đó đúng là chỗ hai phiên song song tranh nhau "lô
mới nhất".

Chạy lại không tốn gì: nội dung không đổi ⇒ 0 upload, 0 ghi description.

### 5.4 Bế tắc

```
task_attach_docs({ … })        ← vẫn nên đính: người gỡ cần đọc ledger
task_block({ work_item_iid, claim_token, reason: "…" })
```

Đừng bỏ lửng — item sẽ kẹt tới khi hết TTL.

---

## 6. Bảy điều kiện của `task_complete`

`complete` từ chối nếu thiếu, và **gom tất cả** thiếu sót rồi mới trả — để không phải sửa nhiều vòng:

| # | Điều kiện |
|---|---|
| 1 | `care::chat` (việc chặt) ⇒ phải khai `hazard` — qua tham số `hazard` của `task_intake` (đúng chỗ: lúc phân loại) hoặc của `task_complete` |
| 2 | `care::chat` **hoặc** `review::required` ⇒ phải khai **`tradeoff`**: chọn hướng nào, **bỏ hướng nào**, đổi lại được gì |
| 3 | `spec_delta` **bắt buộc có mặt**; rỗng thì `risk_declared` phải nói rõ *"không đổi hành vi quan sát được"* |
| 4 | Item không có `gate::green` ⇒ phải có `gate_waiver` (một trường **riêng**, không dò từ khoá trong `risk_declared`) |
| 5 | `review::required` ⇒ phải có bằng chứng review — qua tham số `review_evidence` của `task_complete` |
| 6 | `observe: l1-pending` ⇒ `summary` phải kèm checklist điểm cần nhìn |
| 7 | `summary` không được rỗng |

Nếu `task_attach_docs` chưa được gọi (hoặc hash tài liệu đã lệch), `complete` **nhắc** nhưng **không
chặn** — chặn ở đây sẽ khiến agent bế tắc không báo được `blocked` chỉ vì thiếu một file.

### Hai trường KHÔNG bắt buộc mà đáng khai nhất

| Trường | Tác dụng |
|---|---|
| `debt` | khai ⇒ tự gắn nhãn **`debt`**; item hiện ở mục *nợ còn mở* của `tasks_recap` cho tới khi đóng |
| `mr_url` | nối item ↔ code đã land |

`spec_delta` không rỗng ⇒ tự gắn **`spec-changed`**. Hai nhãn phái sinh này là lý do `tasks_recap`
tổng hợp được nợ và thay đổi hành vi bằng một truy vấn server-side rẻ.

### `task_complete` cũng ghi khối "Kết quả" cho NGƯỜI đọc

Một khối trong description: **đã làm gì · đổi hành vi · vì sao/đánh đổi · nợ để lại · hazard · rủi ro
· gate · MR**. Trường không khai hiện `_không khai_` chứ không biến mất — "vắng mục" đọc như *"việc
này không có phần đó"*, còn `_không khai_` nói đúng sự thật là **không ai ghi**.

---

## 7. Bảng nhãn — 13 nhãn, mỗi nhãn một câu hỏi của NGƯỜI

v0.2 cắt từ **44 xuống 13**. Luật phân tuyến: **nhãn** = thứ người phải thấy ngay trên board, hoặc
thứ cần lọc server-side rẻ. **`agent-meta`** = mọi thứ còn lại. Và không bao giờ cả hai.

| Nhãn | Ai gắn | Người thấy nó thì LÀM GÌ |
|---|---|---|
| `status::ready` | server | không gì — chờ agent lấy |
| `status::claimed` | server | không gì — đang có phiên làm |
| `status::review` | server | **duyệt** |
| `status::blocked` | server | **gỡ** |
| `care::chat` | intake/ingest | đọc kỹ hơn trước khi duyệt: việc chạm thứ đắt |
| `gate::green` | `task_attach_docs` | không gì |
| `gate::red` | `task_attach_docs` | **không duyệt** cho tới khi gate xanh |
| `needs-advice` | `task_block` | **trả lời** cho agent đi tiếp được |
| `hotzone` | **NGƯỜI** | không chạy song song các item này |
| `review::required` | **NGƯỜI**, hoặc agent khi quyết định vào luồng review | đòi bằng chứng review trước khi đóng |
| `source-drifted` | ingest | tài liệu nguồn đã đổi sau khi item được tạo — đối chiếu lại |
| `debt` | `task_complete` khi khai `debt` | đọc mục *Nợ để lại* trên item; xếp lịch trả |
| `spec-changed` | `task_complete` khi `spec_delta` ≠ rỗng | có đổi hành vi quan sát được — QC test đúng chỗ đó |

**VẮNG NHÃN LÀ MỘT GIÁ TRỊ**, cố ý:

| Không thấy | Nghĩa |
|---|---|
| không có `care::chat` | mức **thường** (`care::thuong` đã bỏ) |
| không có `gate::*` | gate **chưa chạy** (`gate::pending` đã bỏ) |

### Còn `shape` / `role` / `source` / `observe` đi đâu?

Vào **`agent-meta`**, không mất. Chúng là thứ AGENT đọc để định tuyến, không phải thứ người xử lý —
và trước v0.2 chúng được ghi CẢ nhãn CẢ meta — tức một dữ kiện ở hai chỗ, đúng thứ luật phân tuyến
của schema cấm: **nhãn** = thứ người thấy ngay + lọc server-side rẻ; **meta** = còn lại; không bao
giờ cả hai.
`qc::` bị bỏ hẳn: chỉ `qc::todo` từng được ghi, không ai đọc, không ai chuyển.

Hệ quả phải biết: `tasks_list` và `task_claim_next` lọc bốn trường đó ở **client**, trên một trang
100 item. Cả hai trả `scan.truncated` — `true` nghĩa là **còn item ngoài phạm vi quét**, không phải
"hàng đợi chỉ có thế".

### Nâng cấp từ 0.1.x

```bash
node plugin/bin/tasks-cli.mjs labels --apply          # tạo 2 nhãn mới: debt, spec-changed
node plugin/bin/tasks-cli.mjs labels --prune          # xem 33 nhãn đã nghỉ còn tồn tại
node plugin/bin/tasks-cli.mjs labels --prune --apply  # xoá thật
```

⚠️ `--prune` xoá nhãn khỏi project, và GitLab gỡ nhãn đó khỏi **mọi issue đang mang** — không lùi
được. Không prune cũng không sao: nhãn cũ chỉ là rác hiển thị, không tool nào ghi thêm chúng nữa.
`--prune` chỉ xoá theo **danh sách tường minh** 33 tên đã nghỉ, không xoá nhãn riêng của dự án.

⚠️ **Máy còn chạy plugin 0.1.x sẽ gắn lại `shape::`/`role::`/`source::`** lên item mới — `agent-meta`
có cơ chế chống ghi đè theo phiên bản, nhưng bộ nhãn thì không. Nâng cấp cả nhóm trước khi prune.

⚠️ **GitLab Free không loại trừ scoped label.** Server mô phỏng: một `PUT` mang cả `remove_labels` lẫn
`add_labels`, rồi đọc lại và dọn thêm nếu còn sót. Thấy hai `status::*` trên một item ⇒
`tasks_doctor --fix`.

---

## 8. Nhiều dự án trên một máy

Không phải làm gì đặc biệt — mở dự án nào thì làm việc với backlog của dự án đó. Cơ chế:

| Giá trị | Đến từ |
|---|---|
| `gitlabHost` · `projectPath` | **đọc `.git/config`** của dự án đang mở |
| `claimRepoUrl` · token | `~/.agent-tasks/` — dùng chung |

Claim của mọi dự án nằm trên **một** claim-repo, tách nhau bằng `refs/claims/<projectKey>/…` nên không
đụng nhau. Vì vậy có toàn cảnh:

```bash
tasks-cli claims --all
```

```
grp/duan-a#42   ton@macbook · còn 1200s   ← phiên này
grp/duan-b#7    ton@macbook · còn 300s
grp/duan-c#15   mai@imac    · còn 1500s
```

**Khi nào cần khai tường minh `projectPath`** — ba ca:

| Ca | Xử |
|---|---|
| Repo tắt Issues | Bật Issues, hoặc trỏ backlog sang project khác |
| Muốn tách work item khỏi issue người dùng | Khai project backlog riêng |
| Nhiều remote, không có `origin` | Đặt `remoteName`, hoặc khai `projectPath` |

Khai ở đâu:

```bash
tasks-cli init --local     # <git-dir>/agent-tasks.env — của RIÊNG clone này, quyền 600
```

Một file khai được cả ba: backlog (`AGENT_TASKS_PROJECT_PATH`), claim-repo
(`AGENT_TASKS_CLAIM_REPO_URL`), token (`GITLAB_TOKEN`). Nó thắng `.env` của dự án, chỉ thua biến
shell. Dòng nào để trống thì kế thừa cấp máy.

⚠️ **Đừng khai vào `.claude/agent-tasks.config.json` nếu `.claude/` là symlink dùng chung** — bố
trí rất phổ biến khi nhiều repo dùng chung một bộ agent/hook/settings. Mọi dự án trỏ vào đó sẽ đọc
**cùng một** `projectPath`: work item ghi nhầm backlog, claim nhầm `projectKey`, và không có triệu
chứng nào chỉ về nguyên nhân. `status` phát hiện và cảnh báo ca này, kèm tên các dự án đang chia sẻ.

Khai ở `.claude/agent-tasks.config.json` (commit được, cả team dùng) hoặc `.env` (không commit).

⚠️ Vì backlog là Issues của repo code, `task_intake` sẽ gặp cả **issue do người viết**. Nó **vẫn xét**
chúng làm ứng viên — người báo bug rồi agent định làm bug đó thì đó *đúng là* trùng — và gắn signal
*"issue do NGƯỜI tạo, chưa qua agent-tasks"* để bạn biết cần đọc/hỏi trước.

---

## 9. Chẩn đoán

**Bước đầu tiên, luôn luôn**: `tasks-cli status`. Nó trả lời *"giá trị này đọc từ đâu"* — câu hỏi
đúng cho gần như mọi sự cố cấu hình.

| Triệu chứng | Nguyên nhân | Xử |
|---|---|---|
| `Thiếu claimRepoUrl … tasks-cli setup` | Máy chưa cài | `tasks-cli setup` |
| `Không suy được projectPath từ git remote` | Repo chưa có remote, hoặc nhiều remote không có `origin` | `git remote add origin <url>`, hoặc khai `projectPath` |
| `còn GIÁ TRỊ MẪU` | `setup` rồi chưa điền | Điền 2 giá trị |
| `Issues BỊ TẮT` | Backlog là repo code mà repo đó tắt Issues | Bật Issues, hoặc trỏ project khác |
| ⚠️ `HOST LỆCH` | `projectPath` suy từ remote host A, `gitlabHost` khai host B | Khai cả hai tường minh nếu đúng ý |
| Đủ 15 tool nhưng tool nào cũng *"chưa sẵn sàng"* | cwd của server không nằm trong repo dự án | Mở lại đúng thư mục dự án |
| Token đúng mà vẫn báo thiếu | shell có `GITLAB_TOKEN` **rỗng** đè lên | `unset GITLAB_TOKEN` |
| Dự án A dùng token của dự án B | `export GITLAB_TOKEN` ở shell đè **mọi** dự án | Bỏ export; đã có cảnh báo sẵn cho ca này |
| `reason: "offline"` | Không với tới claim-repo | `git ls-remote <claimRepoUrl>` |
| `reason: "local-setup"` | Lỗi **đĩa local**, không phải mạng | Kiểm quyền ghi + dung lượng `/tmp` |
| `lost_claim: true` | Claim đã mất | **DỪNG ghi ngay**, `task_claim` lại |
| Claim hết hạn giữa lúc làm | Heartbeat chết cùng tiến trình | `task_claim` lại; tăng `ttlSec` nếu task thường dài |
| Hai nhãn `status::*` trên một item | Free tier không loại trừ scoped label | `tasks_doctor --fix` |
| claim-repo hiện *"empty repository"* | Custom ref không render trên UI | **Bình thường** — kiểm bằng `git ls-remote <url> 'refs/claims/*'` |
| Tài liệu không lên item | Chưa `task_attach_docs` trước `complete`/`block` | Claim đã nhả ⇒ không ghi được. Lần sau đính trước |

---

## 10. Giới hạn đã biết

Ghi ra để không ai ngạc nhiên — đây là **quyết định**, không phải thiếu sót:

| Giới hạn | Vì sao |
|---|---|
| **Heartbeat chết cùng tiến trình** | Đóng Claude Code = claim hết hạn sau ≤ `ttlSec`. Đúng: người đóng máy thì việc nên quay lại hàng đợi. Việc dài thì gọi `task_heartbeat` |
| **Upload tích tụ, không tự dọn** | Mỗi lần nội dung đổi là một upload mới; bản cũ vẫn nằm trong project. `SKIP`-theo-hash là thứ kìm phình (nội dung không đổi ⇒ 0 upload), và `upload_id` được lưu để dọn được về sau |
| **File `.md` không render trên GitLab** | Đã bù bằng khối tóm tắt render kèm bên cạnh |
| **Chất lượng bậc `CAO`/`VỪA` chưa đo trên backlog thật** | Nếu bắt oan nhiều, cách sửa là **thêm tín hiệu**, không phải quay lại điểm số |
| **`export GITLAB_TOKEN` ở shell đè mọi dự án** | Giữ quy ước dotenv (shell là đường override tạm một lệnh). Có cảnh báo khi token shell khác token cấp máy |
| **Chưa nghiệm thu trên GitLab thật** | Xem [README §6](README.md#6-việc-kế-tiếp) |

---

## 11. Cho agent: skill nào cho việc gì

Agent không cần đọc tài liệu này — nó có 6 skill, mỗi skill dạy một luồng:

| Việc | Skill |
|---|---|
| Cài đặt | `task-setup` |
| Yêu cầu **mới** | `task-new` |
| Bốc việc **đã có** | `task-next` |
| Xem trạng thái | `task-status` |
| Kết thúc task | `task-finish` |
| Lệch claim ↔ nhãn | `task-doctor` |
