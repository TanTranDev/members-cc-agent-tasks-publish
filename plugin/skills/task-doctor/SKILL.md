---
name: task-doctor
description: Dùng khi trạng thái task có vẻ sai — item hiện là claimed mà không ai làm, claim treo không nhả được, nhãn trên GitLab không khớp thực tế, hoặc claim-repo hiện "empty repository". Triggers "task bị kẹt", "claim treo", "nhãn sai", "doctor", "lock-repo trống", /task-doctor.
model: sonnet
---

# Chẩn đoán khi trạng thái task có vẻ sai

## Nhớ mô hình trước khi sửa

Có **hai** nguồn, và chúng trả lời hai câu khác nhau:

| Nguồn | Giữ gì | Ai thắng khi lệch |
|---|---|---|
| **claim ref** (git refs trên claim-repo) | ai đang có QUYỀN làm | ✅ **ref thắng** |
| **nhãn GitLab** | mặt hiển thị cho người | chỉ là bản chiếu |

Nhãn lệch không phải lỗi đúng đắn — nó chỉ là hiển thị tụt hậu. Đừng hoảng, và đừng sửa tay
trên UI GitLab (sẽ lệch lại ngay ở lần sync sau).

## Bốn loại lệch và cách xử

| Lệch | Ý nghĩa | Xử |
|---|---|---|
| Nhãn `claimed`, **không có** ref | Agent vừa xong mà chưa sync, hoặc ref bị dọn | `tasks_doctor --fix` sau khi chờ; đừng xoá nhãn ngay |
| Có ref, nhãn **không phải** `claimed` | GitLab lỗi lúc sync | `tasks_doctor --fix` — đồng bộ theo ref |
| Ref **quá hạn** còn nằm đó | Agent chết giữa chừng | `tasks_doctor --fix` thu hồi; item về `ready` |
| **Hai** ref cho cùng item | Không thể xảy ra về lý thuyết | ⛔ Lỗi nghiêm trọng — **dừng và báo người** |

`tasks_doctor` mặc định **chỉ đọc**. Thêm `fix: true` mới sửa.

## "Empty repository" trên claim-repo là BÌNH THƯỜNG

Mở project claim-repo trên GitLab thấy "empty repository" ⇒ **không phải hỏng**.

Claim sống dưới custom ref `refs/claims/*`, mà GitLab web UI chỉ render `refs/heads/*` (branch),
`refs/tags/*` và cây file của default branch. Claim-repo không có branch nào nên UI kết luận
trống — trong khi bên dưới đang có rất nhiều ref sống.

Kiểm bằng git, không bằng UI:

```bash
git ls-remote <claimRepoUrl> 'refs/claims/*'
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" claims
```

## Claim của tôi không nhả được

1. `tasks_my_claims` — còn giữ thật không?
2. Còn ⇒ `task_release` với đúng `claim_token`.
3. Mất token ⇒ chờ TTL (mặc định 30 phút), hoặc `tasks_doctor --fix` sau khi hết hạn.
4. ⚠️ **Không** xoá ref bằng tay trừ khi biết chắc chủ claim đã chết — xoá nhầm sẽ để hai phiên
   cùng làm một việc, đúng thứ cơ chế này sinh ra để chống.

## Phân biệt "mất mạng" với "mất khoá"

Hai thứ khác nhau, và tool nói rõ:

- `reason: "offline"` ⇒ không với tới claim-repo. Claim **chưa** mất. Kiểm mạng/SSH.
- `reason: "local-setup"` ⇒ lỗi **đĩa local** (không dựng được kho tạm trong `/tmp`). Kiểm
  quyền ghi và dung lượng — không phải lỗi mạng.
- `lost_claim: true` ⇒ claim **đã** bị thu hồi thật. DỪNG ghi.
