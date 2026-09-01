---
name: task-finish
description: Dùng khi sắp báo xong một work item đã claim — trước khi gọi task_complete. Giải thích bảy điều kiện server kiểm và cách thoả từng cái, để không phải sửa nhiều vòng. Triggers "xong task", "báo hoàn thành", "complete task", "đính bằng chứng gate", "task_complete báo thiếu", "khai đánh đổi", "khai nợ kỹ thuật", /task-finish.
model: sonnet
---

# Kết thúc một work item

`task_complete` **kiểm trước khi cho qua**. Thiếu điều kiện nào nó trả về danh sách đánh số, và
bạn phải sửa rồi gọi lại. Đọc mục này trước thì qua ngay lần đầu.

## Bảy điều kiện

| # | Điều kiện | Cách thoả |
|---|---|---|
| 1 | `claim_token` đúng và còn hiệu lực | Giữ token từ lúc claim; hết hạn thì `task_claim` lại |
| 2 | `care::chat` ⇒ `hazard` không rỗng | Truyền tham số `hazard` một dòng: *"hazard là &lt;gì&gt;; vỡ thì &lt;hậu quả&gt;"* |
| 3 | `care::chat` **hoặc** `review::required` ⇒ `tradeoff` không rỗng | Đã chọn hướng nào, **bỏ hướng nào**, đổi lại được gì |
| 4 | `spec_delta` **phải có mặt** | Mảng các `{capability, op, requirement}`; hoặc `[]` kèm điều 5 |
| 5 | `spec_delta: []` ⇒ `risk_declared` nói rõ | Phải chứa đúng cụm *"không đổi hành vi quan sát được"* |
| 6 | Gate chưa xanh ⇒ `gate_waiver` | Trường **riêng**, không phải viết dài trong `risk_declared` |
| 7 | `observe: "l1-pending"` ⇒ `summary` có checklist | Liệt kê điểm cần nhìn bằng `- [ ]` |

Item còn có nhãn `review::required` (cửa rủi ro) ⇒ thêm tham số **`review_evidence`**: số note của
`code-reviewer`, hoặc xác nhận tường minh của người. Cùng luật với `hazard` — khoảng trắng bị bỏ qua,
không xoá bằng chứng đã có.

## `tradeoff` và `debt` — hai trường viết cho người đọc SAU BA THÁNG

Hai trường mới ở v0.2, và là toàn bộ lý do `tasks_recap` trả lời được câu *"vì sao hệ thống thành ra
thế này"*.

| Trường | Bắt buộc khi | Viết gì | Bỏ trống nghĩa là |
|---|---|---|---|
| `tradeoff` | `care::chat` **hoặc** `review::required` | chọn hướng nào · **bỏ hướng nào** · đổi lại được gì | không ai biết vì sao. Item có đổi hành vi mà trống ⇒ recap liệt kê iid đó ở mục *thiếu dấu vết* |
| `debt` | **không bao giờ** bắt buộc | thứ biết là chưa đúng/chưa đủ · **ở đâu** · trả nợ thì phải làm gì | không có nợ. Đừng viết *"không có"* — nó thành một nhãn `debt` rỗng nghĩa |

Khai `debt` ⇒ tool **tự gắn nhãn `debt`**, và item hiện ở mục *nợ còn mở* của `tasks_recap` cho tới
khi được đóng. `spec_delta` không rỗng ⇒ tự gắn **`spec-changed`**.

**Đủ và không đủ:**

| ❌ Không đủ | ✅ Đủ |
|---|---|
| *"đã cân nhắc kỹ rồi chọn cách này"* | *"Backoff cố định thay vì jitter: jitter cần server đồng bộ mà contract chưa mở. Đổi lại chấp nhận đồng loạt reconnect khi mạng chập."* |
| *"còn một số chỗ chưa tối ưu"* | *"`OrdersScreen` còn gọi endpoint cũ; trả nợ = đổi sang `/v2/orders` sau khi client 3.1 phủ hết."* |

Thật sự không có đánh đổi nào thì **viết đúng thế kèm lý do** (*"chỉ có một đường đi được vì contract
khoá cứng"*) — đó là lời khai hợp lệ. Viết một câu cho đủ thủ tục thì **tệ hơn bỏ trống**: bỏ trống
còn được đếm ở mục *thiếu dấu vết*, còn câu rỗng nghĩa thì trông như đã khai.

## Khối "Kết quả" — thứ NGƯỜI đọc, `task_complete` tự ghi

Không phải làm gì thêm. Khối gồm: **đã làm gì · đổi hành vi · vì sao/đánh đổi · nợ để lại · hazard ·
rủi ro · gate · MR**.

Nó tồn tại vì bốn tệp `.md` đính kèm **không được GitLab render**, và khối `agent-meta` là JSON —
nên trước v0.2 đường đọc của người audit là *"mở item, thấy một hộp JSON và bốn link tải file"*.
Trường không khai hiện `_không khai_` chứ **không biến mất**: một mục vắng mặt đọc như "việc này
không có phần đó", còn `_không khai_` nói đúng sự thật là không ai ghi.

## Vì sao đòi hazard khi CHẶT

Mức cẩn thận CHẶT quyết định *bao nhiêu công*, nhưng chỉ hazard mới nói *canh cái gì*. Rollback
chống đúng hazard đó, test có ca tấn công đúng hazard đó, reviewer soi đúng chỗ đó.

**CHẶT mà không nêu hazard là nghi lễ, không phải cẩn thận.**

### Khai ở đâu

Hai đường, dùng cái nào cũng qua cổng:

| Khai lúc | Gọi gì | Khi nào |
|---|---|---|
| **phân loại** (đúng chỗ) | `task_intake({ …, care: "chat", hazard: "…" })` | biết ngay từ đầu đây là việc CHẶT |
| **báo xong** | `task_complete({ …, hazard: "…" })` | item đã tồn tại mà chưa có lời khai (ingest, hoặc intake không truyền) |

`task_complete` chỉ ghi đè khi giá trị mới **có nội dung** — truyền chuỗi rỗng/khoảng trắng thì lời
khai cũ giữ nguyên, không bị xoá.

⚠️ **Bản < 0.1.11 không có đường nào cả**: cổng đọc `meta.hazard` nhưng không tool nào nhận nó làm
input, nên **mọi** item `care::chat` đều không đóng được — y hệt với `review_evidence` và nhãn
`review::required`. Gặp triệu chứng "khai gì cũng bị chặn" ⇒ kiểm phiên bản plugin trước khi đi tìm
lỗi ở chỗ khác. Bản < 0.1.11 thì gỡ bằng tay: sửa khối `agent-meta` trong description (tool giữ lại
giá trị đã có), hoặc đổi nhãn `status::` trên GitLab.

## Vì sao `spec_delta` không được bỏ trống

`specs/` là nguồn sự thật hành vi. Task đổi hành vi quan sát được mà không sửa spec ⇒ spec lặng
lẽ sai, đúng thứ nó tồn tại để chống. Cho phép `[]` nhưng bắt khai lý do, vì "không đổi hành vi"
là một **khẳng định**, không phải mặc định.

## Đính tài liệu — MỘT lệnh, gọi TRƯỚC khi kết thúc

```
task_attach_docs(...)  →  task_complete(...)     xong việc
task_attach_docs(...)  →  task_block(...)        bế tắc
```

⚠️ `task_complete` **và** `task_block` đều **nhả claim**. Sau đó bạn không ghi được lên item nữa —
nên tài liệu phải đính **trước**, không phải sau. Cả hai lệnh sẽ trả `warnings[]` nhắc nếu bạn
quên, nhưng lúc đó đã muộn.

`task_attach_docs` làm ba việc trong **một** lần đọc ledger: upload file gốc, dựng khối tóm tắt
render trong description, và set nhãn `gate::*`. **`task_attach_gate_evidence` không còn tồn tại** —
tool này thay thế nó.

### Bốn nguồn và tên trên item

| Nguồn local | Thành |
|---|---|
| `specs/<capability>/spec.md` | `spec.md` |
| `docs/wip/<lô>/verify.md` | `ledger.md` |
| `docs/releases/entries/<YYYYMM>/<ts>-<slug>.md` | `handoff-qc.md` |
| `docs-raw/<task>/*.md` (trừ `brief.md`) | `api-spec.md`, hoặc `api-spec-<tên>.md` khi có nhiều |

### Khai `ledger` tường minh — bạn vừa ghi nó

Bỏ trống thì tool phải đoán bằng **mtime mới nhất** trong `docs/wip/`, và nó sẽ trả **dry-run** bắt
bạn xác nhận. Khai tường minh thì đi thẳng một lệnh:

```
task_attach_docs({ work_item_iid: 42, claim_token: "…", ledger: "docs/wip/lo-07/verify.md" })
```

⚠️ Vì sao chỗ này có ma sát mà chỗ khác không: hai phiên chạy song song trên cùng máy sẽ **tranh
nhau "lô mới nhất"** — phiên A ghi ledger sau, phiên B gọi attach và đính ledger của A vào item của
B. Không ai biết, vì không có gì báo. Đó là lý do duy nhất tool đòi `confirm`.

### Chạy lại không tốn gì

Nội dung không đổi ⇒ **0 upload, 0 ghi description**. Hash lưu trong `agent-meta`. Cứ gọi lại nếu
không chắc.

### Kết quả nói gì

| Trường | Nghĩa |
|---|---|
| `attached[]` | đã upload lần này |
| `skipped_unchanged[]` | đã đính từ trước, nội dung không đổi |
| `skipped[]` | **không** đính, kèm lý do — đọc cái này, đừng bỏ qua |
| `gate_status` | `green`/`red`/`pending`, suy từ ledger |
| `ledger_missing[]` | ledger thiếu mục bắt buộc (`RISK (khai)` · `SPEC` · `SPAWN`) |

`skipped[]` có dòng `AGENT_TASKS_ATTACH_*=false` ⇒ nguồn đó bị **tắt bằng cấu hình**, không phải
lỗi. `ledger_missing[]` không rỗng ⇒ bổ sung vào ledger rồi gọi lại.

⚠️ File `.md` đính kèm **không được GitLab render** — click là tải file thô. Đó là lý do khối tóm
tắt gate được ghi thẳng vào description: để QC đọc được ngay mà vẫn có file gốc để đối chiếu. Cùng
lý do đó sinh ra khối **"Kết quả"** ở trên — hai khối, hai lệnh, không khối nào dựng lại nội dung
của khối kia.

## Quan sát — không bao giờ chặn land

Không có rig để nhìn tận mắt ⇒ `observe: "l1-pending"` + checklist trong `summary`. Item vẫn
sang `review` bình thường.

Luật cứng duy nhất ở đây là **trung thực về mức**: cấm ghi "done" trơn khi thực tế là L1-pending.
Chặn *im lặng*, không chặn *tiến độ*.

## Bế tắc thì dùng `task_block`, đừng bỏ lửng

Cùng một lỗi ba lần liên tiếp ⇒ dừng, `task_block` với `reason` + `needs`. Item về hàng đợi kèm
nhãn `needs-advice` để người gỡ. Bỏ lửng thì item kẹt tới hết TTL và không ai biết vì sao.

Gỡ được rồi thì `task_complete` **tự bỏ** nhãn `needs-advice` lúc chuyển sang `review` — không phải
gỡ tay trên GitLab. (Bản < 0.1.12 không gỡ, nên vé cũ có thể còn đeo nhãn sai.)
