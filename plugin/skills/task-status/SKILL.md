---
name: task-status
description: Dùng khi cần biết board đang thế nào — cột nào có gì, ai (người/máy/agent) đang giữ việc nào, item nào đang cần người, hoặc phiên này còn giữ claim nào trước khi kết thúc. Triggers "còn việc gì", "ai đang làm gì", "tôi đang giữ task nào", "xem board", "xem hàng đợi", "trạng thái task", "có gì cần tôi không", /task-status.
model: haiku
effort: low
context: fork
---

# Xem board và claim

## Skill này chạy trong context RIÊNG — trả về một báo cáo, không phải một cuộc trò chuyện

`context: fork` nên phiên gọi chỉ nhận **văn bản cuối** của bạn. Báo cáo phải tự đủ nghĩa: item nào,
cột nào, `claimed_by` là ai (owner · host · agent), còn bao lâu, item nào đang **cần người** và cần gì.

⚠️ Chỉ đọc. Cần `task_release`/`task_complete`/`task_close` thì **nói ra**, đừng gọi: `claim_token`
nằm trong context của phiên đã claim.

## Gọi trống ⇒ chạy báo cáo mặc định, TUYỆT ĐỐI không hỏi lại

`/task-status` không kèm gì là ca **thường gặp nhất**. Mặc định: `tasks_list` (không lọc) +
`tasks_my_claims`, rồi trình theo **5 cột**:

```
Backlog (3)        #12 Thêm export CSV · #15 … · #19 …
Working (2)        #7  Tự nối lại WS      ← ton @ macbook-ton · agent implementer · còn 22 phút
                   #9  …                  ← linh @ pc-linh · agent debugger · còn 5 phút
Needs you (1)      #4  Đổi schema đơn hàng ← ⚖️ cần quyết định: "có thêm cột hay không" (agent đã dừng)
In review (2)      #3 · #6                ← chờ QC theo khối "Cách kiểm"
Ready to merge (1) #2                     ← chờ merge
Phiên này giữ: #7 (còn 22 phút)
```

Fork không đối thoại được: hỏi *"bạn muốn xem gì?"* là kết thúc lượt ngay tại đó.

## Ba câu hỏi, ba tool

| Câu hỏi | Tool |
|---|---|
| Board có gì / ai đang làm gì / cái nào cần người? | `tasks_list` — lọc `status` (backlog · working · needs-you · in-review · ready-to-merge), `role`, `care`… |
| Phiên NÀY đang giữ gì? | `tasks_my_claims` |
| Một item cụ thể ra sao? | `task_get` — trả `claimed_by`, `needs`, `meta` |

Câu *"dạo này dự án đổi gì, vì sao"* KHÔNG thuộc skill này — đó là `/task-recap`.

## Đọc kết quả `tasks_list`

Mỗi item có:

| Trường | Nghĩa |
|---|---|
| `status` / `column` | cột trên board |
| `claimed_by` | `{owner, host, agent, since, expires_at}` — ai/máy/agent đang giữ; `null` = không ai |
| `needs` | `{kind, reason, needs, holding}` — vì sao ở Needs you và người cần làm gì; `holding: true` = agent còn đang chờ trong phiên |
| `mr` | link MR nếu có |
| `careful` | việc chạm thứ đắt — đọc kỹ hơn trước khi duyệt |
| `legacy_labels` | item còn nhãn bản cũ — nhắc chạy `tasks-cli labels --migrate` |

`claimed_by: null` mà cột là **Working** ⇒ **lệch** (agent chết chưa dọn). Nói ra và gợi `tasks_doctor`.

## ⚠️ `scan.truncated` — đọc trước khi kết luận

Lọc theo `role`/`shape`/`source`/`care=thuong` chạy ở **client** trên một trang 100 item. `truncated: true`
⇒ **CÒN item ngoài phạm vi quét** — báo cáo PHẢI nói ra.

## Trước khi kết thúc phiên — luôn chạy `tasks_my_claims`

Claim còn treo chặn phiên khác tới khi hết TTL (mặc định 30 phút). Xong thì `task_complete`; chưa
xong mà dừng thì `task_release`.

## Năm cột — ai đẩy đi tiếp

| Cột | Nghĩa | Ai đẩy |
|---|---|---|
| **Backlog** | chưa ai nhận | agent (`task_claim_next`) hoặc người giao (`task_claim`) |
| **Working** | agent đang làm | chủ claim |
| **Needs you** | agent không tự đi tiếp được — cần người trả lời / quyết / gỡ / sửa CI | **người**: trả lời rồi kéo về Backlog hoặc giao lại |
| **In review** | agent xong, chờ QC theo "Cách kiểm" | **người**: QC đạt ⇒ kéo sang Ready to merge |
| **Ready to merge** | QC đạt | **người** merge/rebase, hoặc ok cho agent `task_close` |

Ba cột cuối cố ý **không** tự động đi tiếp. Người duyệt là lớp phòng thủ cuối.
