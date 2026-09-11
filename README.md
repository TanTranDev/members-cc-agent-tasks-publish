# agent-tasks

Board **5 cột** cho nhiều phiên agent làm việc trên GitLab, viết cho **người quản lý** đọc được:

```
Backlog  →  Working  →  Needs you  →  In review  →  Ready to merge
chưa ai     agent đang   agent cần     bạn QC theo   bạn merge / rebase,
nhận        làm — ghi rõ bạn: trả lời, hướng dẫn     hoặc ok cho agent
            AI · MÁY ·   quyết định,   agent viết    đóng issue
            AGENT        gỡ, sửa CI
```

Hai phiên agent không thể nhận cùng một task. Mỗi item nói được **ai đang làm**, **kiểm thế nào**,
**vì sao chốt thế**, và **còn nợ gì** — nợ là issue riêng trong Backlog, không phải một nhãn.

Cài xong, phiên của bạn có thêm: **15 MCP tool** · **7 skill** · **11 lệnh CLI**.

> **Không phụ thuộc tech stack.** agent-tasks không đọc code của bạn. Nó cần một project GitLab
> chứa issue board và một repo git để giữ khoá. Board **không nhất thiết** là repo code.

---

## Sáu thứ nó giải

| # | Vấn đề | Cách giải |
|---|---|---|
| 1 | Hai phiên agent nhận trùng một task, không ai biết cho tới lúc merge | **claim bằng git ref + CAS** (`--force-with-lease`), có TTL + heartbeat |
| 2 | Không biết ai đang giữ task | khối **"Đang làm"** ở đầu item: người · máy · agent · hết hạn lúc nào (+ assignee nếu có user id) |
| 3 | Task lên review mà không biết kiểm thế nào | `task_complete` **từ chối** khi thiếu **hướng dẫn QC** — bước làm → thấy gì. Không kiểm tay được mới thay bằng bằng chứng máy |
| 4 | Nhãn `debt` mọc khắp nơi, không ai bóc | mỗi khoản nợ ⇒ **một issue mới** ở Backlog, nhãn `debt`, link về task gốc |
| 5 | Title issue là câu chat dán vào | `task_intake` đòi `title` + `acceptance`; skill `task-new` bắt agent **phỏng vấn** người trước |
| 6 | Board đầy nhãn từ vựng quy trình | **10 nhãn**: 5 cột + 5 hành động của người. Không còn `care::chat`, `gate::`, `observe`, `needs-advice` |

**Vì sao claim không dùng nhãn GitLab**: nhãn là *mặt hiển thị* — hai phiên có thể cùng gắn
`status::working` mà không ai biết. Claim là một git ref ghi bằng `--force-with-lease`, tức
compare-and-swap thật: hai phiên giành cùng lúc thì **đúng một** phiên thắng.

---

## Cài

```bash
claude plugin marketplace add TanTranDev/members-cc-agent-tasks-publish
claude plugin install agent-tasks@agent-tasks-marketplace
```

Rồi **khởi động lại Claude Code**, và nói với agent: `/task-setup`.

⚠️ Tên marketplace là **`agent-tasks-marketplace`** — khác tên repo.

**Không cần `git clone`, không cần `npm install`.** Cập nhật: `claude plugin update agent-tasks`
(đi theo số `version`, mỗi bản phát hành đều bump).

---

## Cấu hình: một file JSON trong repo, một token trên máy

```
REPO CODEBASE   agent-tasks.config.json   ← commit, cả team dùng chung
                  boardUrl      https://git.congty.vn/nhom/agent-board   ← project chứa ISSUE BOARD
                  claimRepoUrl  git@git.congty.vn:nhom/agent-claims.git  ← repo chỉ giữ khoá
MỖI MÁY         ~/.agent-tasks/.env       ← GITLAB_TOKEN, không bao giờ vào repo
```

```bash
tasks-cli init            # sinh agent-tasks.config.json (sửa boardUrl + claimRepoUrl, commit)
tasks-cli setup           # ~/.agent-tasks/.env — dán token
tasks-cli verify          # 3 tiền đề: cấu hình · SSH claim-repo · token
tasks-cli labels --apply  # 10 nhãn trên project chứa board
tasks-cli board --apply   # 5 cột trên issue board
```

| Repo cần có | Chứa gì | Mấy cái |
|---|---|---|
| **project chứa board** | issue = work item, board 5 cột | 1 cho mỗi dự án — hoặc 1 dùng chung nhiều repo |
| **claim-repo** | chỉ `refs/claims/*`. Không commit, không issue. Hiện "empty repository" là đúng | 1 cho cả team |

---

## Vòng đời một task

```
việc MỚI   → phỏng vấn người → task_intake   (title + tiêu chí → dò trùng → tạo ở Backlog → claim)
việc ĐÃ CÓ → task_claim_next (AUTO: bóc Backlog) | task_claim (MANUAL: người giao #iid)
                    ↓  Working — item ghi "Đang làm: ai · máy · agent"
              LÀM VIỆC   · task_heartbeat nếu dài
                         · cần người quyết → task_report_progress kind=question  → Needs you (giữ claim)
                         · kẹt hẳn         → task_block                          → Needs you (nhả claim)
                    ↓
              task_attach_docs → task_complete (+ HƯỚNG DẪN QC, nợ → issue mới)   → In review
                    ↓  NGƯỜI kiểm theo "Cách kiểm", kéo sang Ready to merge
              người merge/rebase — hoặc ok cho agent làm rồi task_close            → đóng
```

**Hai chế độ**: **Auto** — agent lặp `task_claim_next` cho tới khi Backlog hết. **Manual** — người
chỉ đích danh *"làm #42"*. Cả hai đổ về cùng một board.

**Luật quan trọng nhất**: chỉ ghi lên GitLab ở **hai mốc** — lúc vào và lúc ra. Ba cột cuối cố ý
**không** tự đi tiếp: người là lớp phòng thủ cuối.

---

## 10 nhãn — 5 cột + 5 hành động của NGƯỜI

| Nhãn | Bạn thấy nó thì LÀM GÌ |
|---|---|
| `status::backlog` | không gì — agent sẽ bóc, hoặc giao đích danh |
| `status::working` | không gì — đọc khối "Đang làm" nếu muốn biết ai |
| `status::needs-you` | **đọc khối "Cần bạn"**, trả lời / quyết định, kéo về Backlog hoặc giao lại |
| `status::in-review` | **kiểm** theo khối "Cách kiểm", đạt thì kéo sang Ready to merge |
| `status::ready-to-merge` | **merge / rebase**, hoặc bảo agent làm rồi đóng |
| `careful` | đọc kỹ hơn: việc chạm thứ đắt (one-way door) |
| `hotzone` | không chạy song song các item này (bạn tự gắn) |
| `review::required` | đòi bằng chứng review trước khi đóng (bạn tự gắn) |
| `source-drifted` | tài liệu nguồn đã đổi sau khi tạo item — đối chiếu lại |
| `debt` | **item này là một khoản nợ** để trả — bóc như việc thường |

`shape` · `role` · `source` · `gate` · `qc` nằm trong khối `agent-meta` (gấp lại) — thứ agent và
Orchestrator đọc, không phải thứ người xử lý. Nâng cấp từ bản cũ: `tasks-cli labels --migrate --apply`.

---

## "N ngày qua đổi gì, vì sao" — `tasks_recap`

```
/task-recap                       # skill, mặc định 7 ngày
tasks-cli recap --days 30         # người tự xem, không cần Claude
```

Gộp ba nguồn (item · `docs/releases/entries/` · `docs/knowledge/`): đã land gì · vì sao · nợ còn mở ·
hành vi đã đổi · bài học · **đang ở cột nào** · **chỗ KHÔNG có dấu vết**. `KHÔNG ĐỌC ĐƯỢC` ≠ rỗng.

---

## Tài liệu

| Tệp | Trả lời |
|---|---|
| [`INSTALL.md`](INSTALL.md) | Cài thế nào — marketplace, hoặc clone khi bạn SỬA plugin |
| [`USAGE.md`](USAGE.md) | **Dùng hàng ngày**: 15 tool · 11 lệnh · các luồng thật · điều kiện complete · chẩn đoán |

---

## Giới hạn đã biết, khai thẳng

- **GitLab Free không loại trừ scoped label.** Server mô phỏng bằng một `PUT` mang cả `remove_labels`
  lẫn `add_labels`. Quyền làm việc do **claim ref** quyết định, nhãn chỉ là mặt hiển thị. Thấy hai
  `status::*` trên một item ⇒ `tasks_doctor --fix`.
- **Đóng Claude Code = ngừng heartbeat = claim hết hạn sau ≤ TTL.** Việc quay lại Backlog — đúng.
- **Assignee trên card cần user id thật.** Group token là bot nên server không assign; khối "Đang làm"
  vẫn ghi đủ. Muốn avatar: `AGENT_TASKS_GITLAB_USER_ID`.
- **Free tier: một issue board mỗi project.** `board --apply` dùng lại board đang có.
