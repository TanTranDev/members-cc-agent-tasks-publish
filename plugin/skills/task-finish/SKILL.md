---
name: task-finish
description: Dùng khi sắp báo xong một work item đã claim — trước khi gọi task_complete — hoặc khi người đã ok để đóng issue (task_close). Giải thích điều kiện server kiểm (HƯỚNG DẪN QC là điều kiện số một) và cách nợ kỹ thuật thành issue riêng. Triggers "xong task", "báo hoàn thành", "complete task", "viết hướng dẫn QC", "khai nợ kỹ thuật", "đóng issue", "close task", "merge xong rồi", /task-finish.
model: sonnet
---

# Kết thúc một work item

Hai mốc, hai tool:

| Mốc | Tool | Item đi đâu |
|---|---|---|
| Agent xong phần của mình | `task_attach_docs` → **`task_complete`** | **In review** — người QC theo hướng dẫn bạn viết |
| Người QC đạt và **đã ok** merge/đóng | **`task_close`** | đóng issue |

Giữa hai mốc là việc của **người**: kiểm theo khối "Cách kiểm", kéo card sang **Ready to merge**,
merge/rebase (hoặc bảo bạn làm). Bạn không tự đi qua đoạn đó.

## `task_complete` — điều kiện server kiểm

Thiếu điều kiện nào nó trả về danh sách đánh số; đọc mục này trước thì qua ngay lần đầu.

| # | Điều kiện | Cách thoả |
|---|---|---|
| 1 | **Hướng dẫn QC** | `qc_steps[]` — xem bên dưới. Đây là điều kiện quan trọng nhất |
| 2 | `claim_token` đúng và còn hiệu lực | Giữ token từ lúc claim; hết hạn thì `task_claim` lại |
| 3 | Item `careful` ⇒ `hazard` không rỗng | Một dòng *"hazard là &lt;gì&gt;; vỡ thì &lt;hậu quả&gt;"* |
| 4 | `careful` **hoặc** `review::required` ⇒ `tradeoff` | Chọn hướng nào, **bỏ hướng nào**, đổi lại được gì |
| 5 | `review::required` ⇒ `review_evidence` | Số note của code-reviewer, hoặc xác nhận của người |
| 6 | `debt[]` có thì mỗi khoản phải có `title` | Vì mỗi khoản thành một issue |
| 7 | `summary` không rỗng | 2–6 dòng đã làm gì |

Không còn: `observe`, câu thần chú *"không đổi hành vi quan sát được"*, `gate_waiver` bắt buộc.
`spec_delta` **không bắt buộc** — có đổi hành vi theo `specs/` thì khai, không thì bỏ.

### `qc_steps` — viết cho người KIỂM TAY

Mỗi phần tử một bước, dạng **LÀM GÌ → THẤY GÌ**, có chỗ bấm / endpoint / lệnh, dữ liệu mẫu, kết quả
kỳ vọng. Người QC không đọc code và không có ngữ cảnh của bạn.

| ❌ Không kiểm được | ✅ Kiểm được |
|---|---|
| *"kiểm tra reconnect"* | *"Đăng nhập tài khoản demo01 → mở phòng chat A → tắt wifi 10s → mở lại ⇒ badge góc phải chuyển 'Đã kết nối' trong ≤ 3s"* |
| *"chạy test"* | *"Gửi 3 tin liên tiếp trong lúc mất mạng ⇒ sau khi nối lại cả 3 tin hiện ở phòng chat, đúng thứ tự, không trùng"* |

Tool từ chối bước dưới 8 ký tự (*"ok"*, *"test"*).

**Không kiểm tay được** (refactor nội bộ, đổi build, sửa CI…) ⇒ thay bằng:

```
qc_not_manual: "refactor module thanh toán, không đổi hành vi quan sát được",
qc_evidence:   "npm test → 612 pass · npm run typecheck → 0 lỗi"     // bắt buộc nếu gate chưa xanh
```

Gate xanh đã đính qua `task_attach_docs` thì `qc_evidence` không bắt buộc, nhưng ghi vẫn tốt.

### `debt` — mỗi khoản là MỘT ISSUE mới trong Backlog

```
debt: [
  { title: "Đổi OrdersScreen sang /v2/orders", detail: "còn gọi endpoint cũ; trả nợ khi client 3.1 phủ hết" },
]
```

Tool tạo issue riêng (nhãn `debt`, cột Backlog) cho từng khoản, link vào khối Kết quả của item này.
Item này **không** mang nhãn `debt`. Người và agent khác thấy nợ như một việc thường để bóc.

`title` phải đọc như **một việc phải làm**, không phải một lời than (*"code còn xấu"* ⇒ không tạo được
việc gì từ đó). Không có nợ thì **bỏ trống**.

### `tradeoff` — viết cho người đọc SAU BA THÁNG

| ❌ Không đủ | ✅ Đủ |
|---|---|
| *"đã cân nhắc kỹ rồi chọn cách này"* | *"Backoff cố định thay vì jitter: jitter cần server đồng bộ mà contract chưa mở. Đổi lại chấp nhận đồng loạt reconnect khi mạng chập."* |

Thật sự không có đánh đổi ⇒ **viết đúng thế kèm lý do**. Một câu cho đủ thủ tục thì tệ hơn bỏ trống.

### Khối "Kết quả" — `task_complete` tự ghi

Thứ tự theo câu hỏi của người QC: **Cách kiểm** → Đã làm gì → Gate (bằng chứng máy) → Vì sao/đánh
đổi → Nợ để lại (link issue) → Hazard → Chỗ chưa chắc → MR. Trường không khai hiện `_không khai_`.
Khối "Đang làm" ở đầu item đổi thành *"Chờ bạn QC"*.

## Đính tài liệu — gọi TRƯỚC `task_complete` / `task_block`

```
task_attach_docs({ work_item_iid, claim_token, ledger: "docs/wip/lo-07/verify.md" })
```

Cả hai lệnh kết thúc đều **nhả claim**, sau đó bạn không ghi được lên item nữa. Tool upload spec /
ledger / handoff / api-spec, dựng bảng link + tóm tắt gate, và **lưu kết quả gate vào agent-meta**
(v0.3 không còn nhãn `gate::`). Khai `ledger` tường minh để khỏi phải `confirm` (mtime là chỗ hai
phiên song song tranh nhau). Chạy lại không tốn gì: nội dung không đổi ⇒ 0 upload.

## `task_close` — chỉ khi NGƯỜI đã ok

Luồng đúng:

1. Người QC đạt, kéo card sang **Ready to merge** (hoặc nói thẳng trong chat).
2. Bạn **hỏi**: *"Merge !45 vào main luôn nhé?"* — hoặc người tự bảo *"ok merge đi / rebase rồi đóng"*.
3. Người **ok** ⇒ bạn merge / rebase / xác nhận đã land.
4. Gọi:

```
task_close({ work_item_iid: 42, approved_by: "Tôn: ok merge đi", merged_ref: "!45 → main @ a1b2c3d" })
```

Tool kiểm: item ở **In review** hoặc **Ready to merge**, không ai khác đang giữ claim, có
`approved_by`. Nó ghi note *ai ok · đã land ở đâu*, đóng issue, và ghi `history: closed`.

⛔ **Không có ok của người thì KHÔNG gọi `task_close`.** Item dừng ở Ready to merge cho người tự
merge — đó là hành vi đúng, không phải việc bỏ dở.

## Bế tắc thì `task_block`, chờ quyết định thì `task_report_progress kind=question`

| Tình huống | Tool | Claim |
|---|---|---|
| Cần người trả lời nhưng bạn **còn đang chờ** trong phiên | `task_report_progress({ kind: "question", message: "câu hỏi + lựa chọn + khuyến nghị" })` | **giữ**; item lên Needs you; mốc tiếp theo tự về Working |
| Cùng một lỗi ba lần · CI đỏ không tự sửa được · cần quyết định lớn, phiên sẽ kết thúc | `task_block({ reason, needs, kind })` với `kind` ∈ question · decision · blocked · ci-failed · changes-requested | **nhả**; item lên Needs you kèm khối "Cần bạn" |

Đừng bỏ lửng — item sẽ kẹt ở Working tới khi hết TTL và không ai biết vì sao.
