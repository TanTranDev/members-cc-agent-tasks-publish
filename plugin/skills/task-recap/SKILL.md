---
name: task-recap
description: Dùng khi cần biết dự án đã đổi những gì trong N ngày qua và VÌ SAO — mới vào dự án, quay lại sau kỳ nghỉ, sắp chạm một vùng lạ, hoặc có người hỏi "dạo này có gì thay đổi". Trả về đã land gì, đánh đổi đã chốt, nợ kỹ thuật còn mở, hành vi nào đã đổi, bài học đã ghi, và việc đang ở đâu. Triggers "dạo này có gì mới", "tuần qua đổi gì", "recap", "bối cảnh dự án", "nợ kỹ thuật còn gì", "vì sao lại làm thế", /task-recap.
model: haiku
effort: low
context: fork
---

# Bối cảnh dự án N ngày qua

## Skill này chạy trong context RIÊNG — trả về một BÁO CÁO, không phải một cuộc trò chuyện

`context: fork` nên phiên gọi chỉ nhận **văn bản cuối** của bạn. `tasks_recap` đã trả về markdown
đầy đủ: **chuyển nguyên bản đó**, đừng tóm tắt lại thành ba dòng. Tóm tắt ở đây là bỏ đúng phần
người ta cần — tên item, số iid, câu đánh đổi nguyên văn — và phiên gọi sẽ phải hỏi lại từ đầu.

Được phép **cắt** khi báo cáo quá dài: bỏ từ dưới lên (bài học → hành vi → nợ cũ), và nói rõ đã cắt
mục nào. KHÔNG bỏ mục **"Chỗ KHÔNG có dấu vết"** — đó là mục duy nhất nói về cái THIẾU, và là thứ
người quản lý không thể tự suy ra từ các mục còn lại.

## Một tool, một lời gọi

```
tasks_recap({ days: 7 })      # mặc định 7; trần 90
```

Không kèm yêu cầu cụ thể ⇒ chạy `days: 7`, **TUYỆT ĐỐI không hỏi lại**. Fork không đối thoại được:
hỏi *"anh muốn xem mấy ngày?"* là kết thúc lượt ngay tại đó, người phải gọi lại từ đầu, và cả lượt
vừa rồi thành 0 tool.

| Người nói gì | `days` |
|---|---|
| *"dạo này"*, *"tuần qua"*, không nói gì | 7 |
| *"hai tuần"*, *"nửa tháng"* | 14 |
| *"tháng qua"*, *"tôi nghỉ một tháng"* | 30 |
| *"từ hồi..."* mà không rõ mốc | 30, và nói rõ trong báo cáo là đã chọn 30 |

## Đọc kết quả: ba câu phải trả lời được sau khi đọc

1. **Cái gì đã đổi** — mục *Đã land* + *Hành vi quan sát được đã đổi*.
2. **Vì sao thành ra thế này** — mục *Vì sao*. Đây là phần đắt nhất và cũng là phần hay trống nhất.
3. **Chỗ nào đang nợ / đang chờ mình** — mục *Nợ kỹ thuật* + *Bây giờ đang ở đâu*.

## ⚠️ Nguồn thiếu KHÔNG phải là "kỳ này không có gì xảy ra"

Recap gộp từ **ba** nguồn: item trên tracker · `docs/releases/entries/` · `docs/knowledge/`. Dòng
**"Nguồn đã đọc"** ở đầu báo cáo nói từng nguồn đọc được mấy mục, hay **KHÔNG ĐỌC ĐƯỢC**.

Thấy `KHÔNG ĐỌC ĐƯỢC` ⇒ **nói ra ngay ở dòng đầu báo cáo của bạn**, đừng để nó nằm chìm giữa bảng.
Nguyên nhân thường gặp: chạy ngoài repo (`root` null) · repo chưa có thư mục đó · sai clone. Một bản
recap thiếu một nguồn mà không ai để ý là cách nhanh nhất để kết luận sai rằng dự án đang im.

Tương tự với **"nợ còn mở"**: `KHÔNG truy vấn được nhãn debt` ≠ `0 item`.

## Chỉ ĐỌC — và giới hạn đó là thật

Skill này không claim, không sửa, không đóng gì. Thấy việc cần làm (item bế tắc, nợ đáng trả) thì
**nêu ra kèm số iid** để phiên gọi tự quyết — `claim_token` nằm trong context của phiên đã claim,
không có ở đây.

## Người trong dự án dùng được mà không cần Claude

Cùng một lõi, hai vỏ:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" recap --days 7          # bản người đọc
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" recap --days 30 --json  # bản máy đọc, cho script
```

⚠️ Khi bạn đọc dòng trên, `${CLAUDE_PLUGIN_ROOT}` **đã được thay bằng đường dẫn tuyệt đối thật**.
Người ngồi ở terminal thì KHÔNG có biến đó — nên khi nhắc lệnh này cho họ, **dán đường dẫn đã giải**,
đừng dán nguyên chuỗi `${CLAUDE_PLUGIN_ROOT}`. Dán chuỗi chưa giải là đưa một lệnh chạy không được.

CLI trả **exit 3** khi có nguồn không đọc được — bản recap vẫn in ra vì nó có ích, nhưng script hay
pipeline phải biết bản này chưa đầy đủ. Nhắc đường CLI này khi người hỏi *"làm sao tôi tự xem?"*.

## Mục "Vì sao" trống thì đó là một PHÁT HIỆN, không phải một mục nhàm

`tradeoff` chỉ vào được item qua `task_complete` (xem skill `task-finish`), và server chỉ **BẮT BUỘC**
nó ở hai ca: `careful` và `review::required`. Nên mục *Vì sao* trống ở một item đổi hành vi nghĩa
là **ai đó đã land một thay đổi mà không ghi lại quyết định** — recap liệt kê đúng những iid đó ở
mục *Chỗ KHÔNG có dấu vết*. Chuyển nguyên danh sách iid ấy: nó là việc phải đi hỏi, không phải nhiễu.
