---
name: task-doctor
description: Dùng khi trạng thái task có vẻ sai — item ở Working mà không ai làm, claim treo không nhả được, cột trên board không khớp thực tế, item còn nhãn bản cũ (status::ready, care::chat…), hoặc claim-repo hiện "empty repository". Triggers "task bị kẹt", "claim treo", "nhãn sai", "cột sai", "doctor", "lock-repo trống", "nhãn cũ", /task-doctor.
model: sonnet
---

# Chẩn đoán khi trạng thái task có vẻ sai

## Nhớ mô hình trước khi sửa

Có **hai** nguồn, trả lời hai câu khác nhau:

| Nguồn | Giữ gì | Ai thắng khi lệch |
|---|---|---|
| **claim ref** (git refs trên claim-repo) | ai đang có QUYỀN làm | ✅ **ref thắng** |
| **nhãn `status::*`** + khối "Đang làm" trên GitLab | cột trên board, mặt hiển thị cho người | chỉ là bản chiếu |

Nhãn lệch không phải lỗi đúng đắn — nó chỉ là hiển thị tụt hậu. Đừng hoảng, và đừng sửa tay trên UI
GitLab (sẽ lệch lại ngay ở lần sync sau).

## Năm loại lệch và cách xử

| Lệch | Ý nghĩa | Xử |
|---|---|---|
| Cột **Working**, **không có** ref | Agent chết / đóng máy chưa dọn | `tasks_doctor --fix` sau khi hết grace: item về **Backlog**, khối "Đang làm" đổi thành "chưa ai nhận" |
| Có ref, cột **không phải** Working | GitLab lỗi lúc sync | `tasks_doctor --fix` — đồng bộ theo ref |
| Ref **quá hạn** còn nằm đó | Agent chết giữa chừng | `tasks_doctor --fix` thu hồi |
| Item còn **nhãn bản cũ** (`status::ready`, `care::chat`, `gate::*`, `needs-advice`, `spec-changed`) | Chưa migrate sau khi lên v0.3 | `tasks-cli labels --migrate --apply` rồi `labels --prune --apply` |
| **Hai** ref cho cùng item | Không thể xảy ra về lý thuyết | ⛔ Lỗi nghiêm trọng — **dừng và báo người** |

`tasks_doctor` mặc định **chỉ đọc**. Thêm `fix: true` mới sửa. Nó cũng đếm item còn nhãn cũ
(`legacy-labels`) nhưng **không** tự đổi — dọn hàng loạt là việc của CLI `--migrate`.

## Item ở Needs you mà không ai làm gì

Không phải lệch — đó là cột **của người**. Đọc khối "Cần bạn" trên item: agent cần gì. Trả lời bằng
comment rồi kéo card về **Backlog** (agent auto sẽ bóc lại) hoặc giao đích danh (`task_claim`).
Agent không tự nhặt item ở cột này.

## "Empty repository" trên claim-repo là BÌNH THƯỜNG

Claim sống dưới custom ref `refs/claims/*`, mà GitLab web UI chỉ render branch, tag và cây file của
default branch. Kiểm bằng git, không bằng UI:

```bash
git ls-remote <claimRepoUrl> 'refs/claims/*'
node "${CLAUDE_PLUGIN_ROOT}/bin/tasks-cli.mjs" claims
```

## Claim của tôi không nhả được

1. `tasks_my_claims` — còn giữ thật không?
2. Còn ⇒ `task_release` với đúng `claim_token`.
3. Mất token ⇒ chờ TTL (mặc định 30 phút), hoặc `tasks_doctor --fix` sau khi hết hạn.
4. ⚠️ **Không** xoá ref bằng tay trừ khi biết chắc chủ claim đã chết — xoá nhầm sẽ để hai phiên
   cùng làm một việc.

## Phân biệt "mất mạng" với "mất khoá"

- `reason: "offline"` ⇒ không với tới claim-repo. Claim **chưa** mất. Kiểm mạng/SSH.
- `reason: "local-setup"` ⇒ lỗi **đĩa local** (không dựng được kho tạm trong `/tmp`).
- `lost_claim: true` ⇒ claim **đã** bị thu hồi thật. DỪNG ghi.
