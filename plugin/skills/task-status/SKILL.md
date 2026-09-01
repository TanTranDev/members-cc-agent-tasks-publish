---
name: task-status
description: Dùng khi cần biết hàng đợi có gì, ai đang giữ việc nào, hoặc phiên này còn giữ claim nào trước khi kết thúc. Triggers "còn việc gì", "ai đang làm gì", "tôi đang giữ task nào", "xem hàng đợi", "trạng thái task", /task-status.
model: haiku
effort: low
context: fork
---

# Xem trạng thái hàng đợi và claim

## Skill này chạy trong context RIÊNG — trả về một báo cáo, không phải một cuộc trò chuyện

`context: fork` nên phiên gọi chỉ nhận **văn bản cuối** của bạn: kết quả tool thô không chảy về
đó. Vì vậy báo cáo phải tự đủ nghĩa — item nào, `claimed_by` là ai, còn bao lâu (`expires_in_sec`),
lệch chỗ nào. Bỏ chi tiết nào thì phiên gọi phải hỏi lại, và mất luôn phần tiết kiệm.

⚠️ Chỉ đọc. Cần `task_release`/`task_complete` thì **nói ra**, đừng gọi: `claim_token` nằm trong
context của phiên đã claim, không có ở đây.

## Không kèm yêu cầu cụ thể ⇒ chạy báo cáo mặc định, TUYỆT ĐỐI không hỏi lại

Gọi trống (`/task-status`) là ca **thường gặp nhất**, không phải ca thiếu thông tin. Mặc định:
`tasks_list` + `tasks_my_claims`, rồi báo cáo cả hai.

Fork không đối thoại được: hỏi *"bạn muốn xem gì?"* là kết thúc lượt ngay tại đó — người phải gọi
lại từ đầu, và cả lượt vừa rồi thành 0 tool, ~17k token đổ đi. Kể cả khi yêu cầu mơ hồ, cứ chạy
báo cáo mặc định trước rồi nêu thêm phần chưa rõ ở cuối.

## Ba câu hỏi, ba tool

| Câu hỏi | Tool |
|---|---|
| Hàng đợi có gì? | `tasks_list` (lọc theo `status`/`role`/`shape`/`care`/`source`) |
| Phiên NÀY đang giữ gì? | `tasks_my_claims` |
| Một item cụ thể ra sao? | `task_get` |

Câu hỏi **"dạo này dự án đổi gì, vì sao"** KHÔNG thuộc skill này — đó là `/task-recap`. Skill này
trả lời *"bây giờ đang thế nào"*; recap trả lời *"đã xảy ra chuyện gì"*. Trả lời sai câu bằng một
danh sách hàng đợi là cách người hỏi đọc xong vẫn không biết gì về những thay đổi đã land.

## ⚠️ `scan.truncated` — đọc trước khi kết luận hàng đợi ngắn

Từ v0.2, `role`/`shape`/`source` không còn là nhãn (chúng ở trong `agent-meta`), nên `tasks_list`
lọc chúng ở **client** trên một trang 100 item và trả thêm trường `scan`:

| `scan` | Nghĩa |
|---|---|
| `client_filtered: false` | server lọc hết — kết quả đầy đủ |
| `truncated: false` | đã quét hết phần khớp bộ lọc nhãn |
| **`truncated: true`** | **CÒN item ngoài phạm vi quét** — báo cáo PHẢI nói ra, đừng viết "hàng đợi chỉ có N việc" |

## Trước khi kết thúc phiên — luôn chạy `tasks_my_claims`

Claim còn treo sẽ chặn phiên khác cho tới khi hết TTL (mặc định 30 phút). Xong việc thì
`task_complete`; chưa xong mà dừng thì `task_release` để trả ngay.

⚠️ Đóng Claude Code = ngừng heartbeat = claim tự hết hạn sau ≤ TTL. Đó là hành vi **đúng** (máy
tắt thì việc nên quay lại hàng đợi), nhưng trong khoảng đó item vẫn hiện là `claimed`.

## Đọc kết quả `tasks_list`

- `claimed_by` + `expires_at` ⇒ đang có người làm, còn bao lâu.
- `claimed_by: null` mà nhãn là `status::claimed` ⇒ **lệch**. Chạy `tasks_doctor`.

## Bốn trạng thái

| | Nghĩa | Ai đẩy đi tiếp |
|---|---|---|
| `ready` | chờ agent lấy | agent — `task_claim_next` |
| `claimed` | đang có người làm | chủ claim |
| `review` | xong phần agent, chờ người | **người** |
| `blocked` | bế tắc, cần gỡ | **người** |

`review` và `blocked` cố ý **không** tự động đi tiếp. Người duyệt là lớp phòng thủ cuối.
