# agent-tasks

Điều phối công việc cho **nhiều phiên agent** qua work item của GitLab. Hai phiên Claude Code không
thể nhận cùng một task — và bạn biết được *"N ngày qua source đổi gì, VÌ SAO, còn nợ gì"*.

Cài xong, phiên của bạn có thêm: **15 MCP tool** · **7 skill** · **11 lệnh CLI**.

> **Không phụ thuộc tech stack.** agent-tasks không đọc code của bạn. Nó cần GitLab (work item) và
> một repo git để giữ khoá. Dự án Go, Python, Rust, Java, TypeScript, mobile… dùng y như nhau.

---

## Bốn thứ nó giải

| # | Vấn đề | Cách giải |
|---|---|---|
| 1 | Hai phiên agent nhận trùng một task, không ai biết cho tới lúc merge | **claim bằng git ref + CAS** (`--force-with-lease`), có TTL + heartbeat |
| 2 | Việc xong rồi mà không ai biết *vì sao* chốt thế | trường `tradeoff` / `debt` trên item + khối **"Kết quả"** người đọc được |
| 3 | Người mới vào dự án không biết chuyện gì đã xảy ra | `tasks_recap` — gộp 3 nguồn, kèm mục **"Chỗ KHÔNG có dấu vết"** |
| 4 | Board đầy nhãn mà người quản lý không xử lý được gì | **13 nhãn**, mỗi nhãn trả lời một câu hỏi của người |

**Vì sao claim không dùng nhãn GitLab**: nhãn là *mặt hiển thị* — hai phiên có thể cùng gắn
`status::claimed` mà không ai biết. Claim là một git ref ghi bằng `--force-with-lease`, tức
compare-and-swap thật: hai phiên giành cùng lúc thì **đúng một** phiên thắng.

**Vì sao claim có TTL**: agent chết thì việc phải quay lại hàng đợi. Mặc định 1800s, heartbeat 600s.

---

## Cài

```bash
claude plugin marketplace add TanTranDev/members-cc-agent-tasks-publish
claude plugin install agent-tasks@agent-tasks-marketplace
```

Rồi **khởi động lại Claude Code**, và nói với agent: `/task-setup`.

⚠️ Tên marketplace là **`agent-tasks-marketplace`** — khác tên repo. Đây là chỗ dễ gõ sai.

**Không cần `git clone`, không cần `npm install`.** Claude Code chạy `npm ci --ignore-scripts` ngay
trong bản copy ở cache (plugin root có `package.json` + `package-lock.json`), nên MCP server nạp được
SDK từ đó.

### Cập nhật

```bash
claude plugin update agent-tasks
```

⚠️ **Cập nhật đi theo số `version`, không theo commit.** `plugin update` so **VERSION** chứ không so
nội dung: version không đổi thì nó báo *"already at the latest version"* rồi không làm gì. Mỗi bản
phát hành đều bump version.

---

## Cấu hình: hai giá trị cho cả MÁY, một lệnh cho mỗi DỰ ÁN

`/task-setup` chạy hộ toàn bộ. Muốn tự làm bằng CLI: xem [`INSTALL.md`](INSTALL.md).

```
MỘT MÁY          ~/.agent-tasks/     claim-repo + token, khai MỘT LẦN
 └─ NHIỀU DỰ ÁN  .git/config         mỗi dự án tự khai backlog bằng git remote của nó
     └─ WORK ITEM   GitLab Issue     một việc một item
         └─ CLAIM   refs/claims/…    ai đang làm, tới khi nào
```

Dự án thứ hai trở đi cần **0 file cấu hình** — `gitlabHost` + `projectPath` đọc từ git remote.

| Repo cần có | Chứa gì | Phải tạo mấy cái |
|---|---|---|
| **claim-repo** | chỉ **khoá**: `refs/claims/*`. Không commit, không issue | **1** cho cả team |
| **backlog** = Issues của chính repo code | work item của riêng dự án đó | **0** — mỗi dự án đã có sẵn |

claim-repo dùng chung được vì ref đã tách theo dự án: `refs/claims/<projectKey>/<hash>`. Hai dự án
không đụng ref của nhau kể cả khi trùng số iid.

---

## Vòng đời một task

```
việc MỚI   → task_intake        (dò trùng → tạo → claim)
việc ĐÃ CÓ → task_claim_next | task_claim
                    ↓
              LÀM VIỆC   (task_heartbeat nếu dài · task_report_progress nếu bế tắc)
                    ↓
              task_attach_docs      ← đính tài liệu TRƯỚC
                    ↓
        task_complete  |  task_block
              └── cả hai NHẢ CLAIM ──┘
```

**Luật quan trọng nhất**: chỉ ghi lên GitLab ở **hai mốc** — lúc vào và lúc ra. Ghi liên tục làm
activity feed thành nhiễu, và mỗi lần ghi là một lần có thể ghi sai.

**Phải đính tài liệu TRƯỚC `complete`/`block`**: cả hai nhả claim, và sau khi nhả thì không ghi được
lên item nữa.

---

## 13 nhãn — mỗi nhãn một câu hỏi của NGƯỜI

| Nhãn | Người thấy nó thì LÀM GÌ |
|---|---|
| `status::ready` · `status::claimed` | không gì — chờ agent lấy / đang có phiên làm |
| `status::review` | **duyệt** |
| `status::blocked` | **gỡ** |
| `care::chat` | đọc kỹ hơn trước khi duyệt: việc chạm thứ đắt |
| `gate::green` · `gate::red` | red ⇒ **không duyệt** cho tới khi xanh |
| `needs-advice` | **trả lời** để agent đi tiếp được |
| `hotzone` | không chạy song song các item này |
| `review::required` | đòi bằng chứng review trước khi đóng |
| `source-drifted` | tài liệu nguồn đã đổi sau khi item được tạo — đối chiếu lại |
| `debt` | đọc mục *Nợ để lại* trên item; xếp lịch trả |
| `spec-changed` | có đổi hành vi quan sát được — QC test đúng chỗ đó |

**VẮNG NHÃN LÀ MỘT GIÁ TRỊ**: không `care::chat` = mức thường · không `gate::*` = gate chưa chạy.

`shape` · `role` · `source` · `observe` nằm trong khối `agent-meta` của item, **không** phải nhãn —
chúng là thứ agent đọc để định tuyến, không phải thứ người xử lý. Chi tiết + đường dọn nhãn cũ khi
nâng cấp từ 0.1.x: [`USAGE.md`](USAGE.md) §7.

---

## "N ngày qua đổi gì, vì sao" — `tasks_recap`

```
/task-recap                       # skill, mặc định 7 ngày
tasks_recap({ days: 30 })         # tool, trần 90
```

Gộp **ba** nguồn: item trên tracker · `docs/releases/entries/` · `docs/knowledge/`. Trả về: đã land
gì · **vì sao** (đánh đổi đã chốt) · nợ kỹ thuật còn mở · hành vi nào đã đổi · bài học đã ghi · việc
đang ở đâu lúc này.

Mục đáng đọc nhất là mục cuối — **"Chỗ KHÔNG có dấu vết"**: item đổi hành vi mà không khai đánh đổi ·
item xong mà gate không xanh · fragment thiếu mục *Vì sao* · khối meta hỏng. Đó là danh sách việc
phải đi hỏi, không phải nhiễu.

⚠️ Đọc dòng **"Nguồn đã đọc"** trước khi tin bản recap: `KHÔNG ĐỌC ĐƯỢC` **≠** nguồn rỗng, và
`KHÔNG truy vấn được nhãn debt` **≠** hết nợ.

Người trong dự án tự xem được, không cần Claude:

```bash
tasks-cli recap --days 7          # exit 3 nếu có nguồn không đọc được
```

---

## Tài liệu

| Tệp | Trả lời |
|---|---|
| [`INSTALL.md`](INSTALL.md) | Cài thế nào — hai đường: marketplace, hoặc clone (chỉ khi bạn SỬA plugin) |
| [`USAGE.md`](USAGE.md) | **Dùng hàng ngày**: 15 tool · 11 lệnh · các luồng thật · bảng nhãn · chẩn đoán |

---

## Bản phát hành này chứa gì

Chỉ **phần CHẠY**. Tài liệu thiết kế (vì sao claim dùng git ref, vì sao Free tier phải mô phỏng
scoped label…) nằm ở repo phát triển — cố ý không đi kèm.

Comment trong `plugin/lib/*.mjs` có những trích dẫn dạng `(docs/05 §3.4)`. Đó là **dẫn nguồn** tới
tài liệu thiết kế nội bộ, ghi lại quyết định nào sinh ra dòng code đó — không phải link hỏng, và cố ý
giữ để người bảo trì truy được. Mọi thứ **cần để dùng** plugin đều nằm trong `README` · `INSTALL` ·
`USAGE` và trong chính mô tả của 15 tool.

Kiểm bản đang có trong tay:

```bash
claude plugin validate ./plugin
```

---

## Giới hạn đã biết, khai thẳng

- **GitLab Free không loại trừ scoped label.** Server mô phỏng bằng một `PUT` mang cả
  `remove_labels` lẫn `add_labels`. Đó là **mô phỏng, không phải bảo đảm** — nhưng chấp nhận được, vì
  quyền làm việc do **claim ref** quyết định, nhãn chỉ là mặt hiển thị. Thấy hai `status::*` trên một
  item ⇒ `tasks_doctor --fix`.
- **Đóng Claude Code = ngừng heartbeat = claim hết hạn sau ≤ TTL.** Đó là hành vi ĐÚNG (máy tắt thì
  việc nên quay lại hàng đợi), nhưng trong khoảng đó item vẫn hiện là `claimed`.
- **Chưa nghiệm thu trên một GitLab instance thật ở mọi tier.** Lõi chỉ dùng tính năng Free nên chạy
  được ở mọi tier; `tasks-cli probe --issue <iid nháp> --write` là lệnh chốt câu đó cho instance của
  bạn.
