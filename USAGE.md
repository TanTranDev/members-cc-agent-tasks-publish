# Hướng dẫn sử dụng agent-tasks

| Tài liệu | Trả lời |
|---|---|
| **USAGE.md** (đây) | **Dùng hàng ngày**: 15 tool · 11 lệnh · các luồng thật · điều kiện complete · chẩn đoán |
| [`INSTALL.md`](INSTALL.md) | Cài thế nào |
| [`README.md`](README.md) | Vì sao có dự án, board 5 cột, 10 nhãn |

> Chưa cài? `/task-setup` trong Claude Code, hoặc `tasks-cli init` + `setup` + `verify` + `labels --apply` + `board --apply`.

---

## 1. Mô hình — một câu mỗi tầng

```
REPO CODEBASE   agent-tasks.config.json     boardUrl + claimRepoUrl, commit, cả team dùng chung
 └─ MÁY          ~/.agent-tasks/.env         GITLAB_TOKEN, không vào repo
     └─ BOARD    project GitLab (boardUrl)   5 cột: Backlog · Working · Needs you · In review · Ready to merge
         └─ ITEM  GitLab Issue               một việc một item; khối "Đang làm" · "Yêu cầu" · "Cần bạn" · "Cách kiểm"
             └─ CLAIM  refs/claims/…         ai đang làm, tới khi nào — CAS thật, TTL 1800s, heartbeat 600s
```

**Vì sao có CLAIM mà không dùng nhãn**: nhãn là *mặt hiển thị*, hai phiên có thể cùng gắn
`status::working`. Claim là git ref ghi bằng `--force-with-lease`: hai phiên giành cùng lúc thì
**đúng một** thắng. **Vì sao claim có TTL**: agent chết thì việc phải quay lại Backlog.

---

## 2. Vòng đời một task và ai đẩy ở mỗi cột

```
        ┌── việc MỚI: phỏng vấn người → task_intake (title + acceptance → dò trùng → tạo → claim) ──┐
        └── việc ĐÃ CÓ: task_claim_next (AUTO) · task_claim #iid (MANUAL) ──────────────────────────┘
                                   ▼
   Backlog ──claim──▶ Working ──complete──▶ In review ──người QC đạt──▶ Ready to merge ──người merge / task_close──▶ đóng
      ▲                 │  ▲                                                  (agent chỉ close khi người đã ok)
      │  question ─────►│  │ mốc tiếp / task_claim lại
      │  (giữ claim)    ▼  │
      └──── người trả lời ── Needs you ◀── task_block (nhả claim)
```

| Cột | Ai đẩy đi tiếp | Bằng gì |
|---|---|---|
| Backlog | agent | `task_claim_next` (auto) · `task_claim` (người giao) |
| Working | agent giữ claim | `task_complete` · `task_block` · `task_report_progress kind=question` |
| Needs you | **người** | trả lời bằng comment → kéo card về Backlog, hoặc giao lại `task_claim` |
| In review | **người** | QC theo khối "Cách kiểm" → kéo sang Ready to merge |
| Ready to merge | **người** | merge/rebase — hoặc ok cho agent làm rồi `task_close` |

**Luật**: chỉ ghi lên GitLab ở **hai mốc** — lúc vào và lúc ra. Đính tài liệu **TRƯỚC** `complete`/`block`
(cả hai nhả claim).

---

## 3. Mười lăm tool MCP

### Đọc — không bao giờ ghi

| Tool | Tham số bắt buộc | Dùng khi |
|---|---|---|
| `tasks_list` | — | Xem board. Lọc `status` (5 cột) · `role` · `shape` · `care` · `source`. Mỗi item trả `claimed_by {owner, host, agent, expires_at}` · `needs` · `mr` |
| `task_get` | `work_item_iid` | Chi tiết một item + `agent-meta` + ai giữ + vì sao cần người |
| `tasks_my_claims` | — | Phiên này đang giữ gì |

### Vào — việc mới

| Tool | Tham số bắt buộc | Dùng khi |
|---|---|---|
| `task_intake` | `title` · `acceptance[]` · `brief` | **Mọi** yêu cầu mới. Đòi title + tiêu chí ⇒ agent phải **phỏng vấn** trước, không dán câu chat |

### Giành việc

| Tool | Tham số bắt buộc | Dùng khi |
|---|---|---|
| `task_claim_next` | — | **AUTO**: bóc item cũ nhất ở Backlog. Lọc `role`/`shape`/`care`/`exclude_hotzone` |
| `task_claim` | `work_item_iid` | **MANUAL**: người giao đích danh, hoặc nhận lại item ở Needs you |

### Trong lúc làm

| Tool | Tham số bắt buộc | Dùng khi |
|---|---|---|
| `task_heartbeat` | `work_item_iid` · `claim_token` | Việc dài. `lost_claim: true` ⇒ **DỪNG ghi** |
| `task_report_progress` | + `message` | `kind: "question"` ⇒ item lên **Needs you**, **giữ** claim. Kind khác ⇒ về Working. Rate limit 300s/item |
| `task_release` | `work_item_iid` · `claim_token` | Đổi ý — item về Backlog ngay |

### Ra

| Tool | Tham số bắt buộc | Dùng khi |
|---|---|---|
| `task_attach_docs` | `work_item_iid` · `claim_token` | Đính spec · ledger · handoff · api-spec; lưu gate vào meta. **Gọi trước** complete/block |
| `task_complete` | + `summary` (+ `qc_steps` hoặc `qc_not_manual`) | Xong. **7 điều kiện** — §6. Nợ ⇒ issue mới |
| `task_block` | + `reason` | Kẹt hẳn ⇒ **Needs you**, nhả claim, khối "Cần bạn" |
| `task_close` | `work_item_iid` · `approved_by` | **Người đã ok** ⇒ đóng issue. Item phải ở In review / Ready to merge |

### Vận hành

| Tool | Tham số bắt buộc | Dùng khi |
|---|---|---|
| `tasks_doctor` | — | Lệch claim ref ↔ nhãn · claim quá hạn · item còn nhãn bản cũ. `fix: true` để sửa |
| `tasks_recap` | — | N ngày qua đổi gì, vì sao, nợ gì, đang ở cột nào |

`tasks_ingest` (nhập hàng loạt) và `tasks_probe_capabilities` (dò instance) **chỉ còn ở CLI** — hai
việc cài đặt/khó lùi, không thuộc danh sách tool agent chọn giữa lúc làm.

---

## 4. Mười một lệnh CLI

| Lệnh | Ghi GitLab? | Làm gì |
|---|---|---|
| `init [--force]` | không | tạo `agent-tasks.config.json` ở root repo (commit) |
| `init --local` | không | override riêng clone: `<git-dir>/agent-tasks.env` |
| `setup [--force]` | không | `~/.agent-tasks/.env` chứa token |
| `status` | không | cấu hình đọc từ đâu, board nào, claim của phiên |
| `verify` | không | 3 tiền đề: cấu hình · SSH claim-repo · token + Issues bật |
| `labels [--apply]` | có nếu `--apply` | 10 nhãn v0.3 |
| `labels --migrate [--apply]` | có nếu `--apply` | đổi nhãn v0.2 trên item đang mở sang v0.3 |
| `labels --prune [--apply]` | có nếu `--apply` | xoá tên nhãn đã nghỉ khỏi project |
| `board [--apply]` | có nếu `--apply` | issue board 5 cột |
| `doctor [--fix]` | có nếu `--fix` | như `tasks_doctor` |
| `claims [--all]` | không | claim đang sống |
| `probe [--issue N] [--write]` | có nếu `--issue` | dò tier/năng lực instance |
| `recap [--days 7] [--json]` | không | như `tasks_recap`; exit 3 nếu có nguồn không đọc được |
| `ingest [--apply] [--source …]` | có nếu `--apply` | nhập spec/changelog/brief thành item (mặc định dry-run) |

---

## 5. Bốn luồng thật

### 5.1 *"Task mới: thêm WS reconnect"* — phỏng vấn rồi mới tạo

Agent hỏi tối đa 3 câu (mục tiêu · phạm vi · xong thì kiểm bằng gì), rồi:

```
task_intake({
  title: "Tự nối lại WS khi mất mạng",
  acceptance: ["Tắt mạng 10s → mở lại ⇒ badge 'Đã kết nối' trong ≤ 3s", "Tin đang gửi không mất"],
  goal: "Người đang chat mất mạng không phải reload app.",
  scope: ["WS client"], out_of_scope: ["Retry cho REST"],
  brief: "Task mới: thêm WS reconnect. Mất mạng thì client phải tự nối lại."
})
```

Item sinh ra có khối **🎯 Yêu cầu** (mục tiêu · phạm vi · tiêu chí dạng checklist) và nguyên văn
gấp lại. Đọc kết quả theo **bốn** tình huống:

| Kết quả | Làm gì |
|---|---|
| `created: true, claimed: true` | làm luôn — item ở Working, khối "Đang làm" ghi bạn |
| `created: true, claimed: false` | phiên đang giữ item khác — **đừng gọi lại** |
| `created: false` + `work_item_iid` | đã có item: `claimed: true` ⇒ làm · `held_by` ⇒ **hỏi họ** |
| `created: false, blocked_by: "CAO"` | đọc `candidates[].signals` rồi `task_claim` hoặc `force: true` |

Cảnh báo *"title trùng nguyên văn dòng đầu của brief"* ⇒ agent vừa dán câu chat làm title.

### 5.2 Bốc việc — AUTO và MANUAL

```
task_claim_next({ role: "implementer", exclude_hotzone: true })   # auto: bóc Backlog
task_claim({ work_item_iid: 42 })                                  # manual: "làm #42 đi"
```

`claimed: false` + `candidates_tried > 0` ⇒ có phiên khác đang hoạt động · `== 0` ⇒ Backlog hết.
`reclaimed: true` ⇒ thu hồi từ phiên **đã chết**, đọc comment xem người trước làm tới đâu.
`task_claim_next` **không bao giờ** bốc item ở Needs you — cột đó của người.

### 5.3 Xong việc — đính tài liệu, viết hướng dẫn QC, nợ thành issue

```
task_attach_docs({ work_item_iid, claim_token, ledger: "docs/wip/lo-3/verify.md" })
task_complete({
  work_item_iid, claim_token,
  summary: "Thêm vòng nối lại với backoff cố định 1-2-4s.",
  qc_steps: [
    "Đăng nhập demo01 → mở phòng A → tắt wifi 10s → mở lại ⇒ badge 'Đã kết nối' trong ≤ 3s",
    "Gửi 3 tin trong lúc mất mạng ⇒ sau khi nối lại cả 3 hiện đúng thứ tự, không trùng",
  ],
  debt: [{ title: "Viết test cho ca mất mạng > 30s", detail: "ws-client.test còn thiếu" }],
  mr_url: "https://git.congty.vn/nhom/app/-/merge_requests/45",
})
```

Kết quả: item sang **In review**, khối **✅ Kết quả** (Cách kiểm đứng đầu), issue nợ mới ở Backlog
(nhãn `debt`, link về #iid), comment *"Agent báo xong — chờ QC"*.

### 5.4 Cần người — hai mức

```
task_report_progress({ kind: "question", message: "Giữ API cũ hay đổi luôn? Khuyến nghị: giữ, thêm cờ." })
   → Needs you, GIỮ claim; người trả lời comment; mốc tiếp theo tự về Working
task_block({ reason: "cùng một lỗi ba lần", needs: "xem log CI job #812", kind: "ci-failed" })
   → Needs you, NHẢ claim, khối "Cần bạn" ở đầu item
```

### 5.5 Đóng — khi người đã ok

```
task_close({ work_item_iid: 42, approved_by: "Tôn: ok merge đi", merged_ref: "!45 → main @ a1b2c3d" })
```

Không có ok ⇒ không gọi; item dừng ở Ready to merge cho người tự merge.

---

## 6. Bảy điều kiện của `task_complete`

Gom **tất cả** thiếu sót rồi mới trả — không phải sửa nhiều vòng:

| # | Điều kiện |
|---|---|
| 1 | **Hướng dẫn QC**: `qc_steps[]` (mỗi bước ≥ 8 ký tự, LÀM GÌ → THẤY GÌ) **hoặc** `qc_not_manual` + (gate xanh hoặc `qc_evidence`) |
| 2 | `claim_token` còn hiệu lực |
| 3 | Item `careful` ⇒ `hazard` (khai lúc intake hoặc lúc complete) |
| 4 | `careful` **hoặc** `review::required` ⇒ `tradeoff` |
| 5 | `review::required` ⇒ `review_evidence` |
| 6 | `debt[]` mỗi khoản có `title` (vì thành issue) |
| 7 | `summary` không rỗng |

**Không còn**: `observe`, câu *"không đổi hành vi quan sát được"*, `gate_waiver` bắt buộc.
`spec_delta` tuỳ chọn. Chưa `task_attach_docs` ⇒ **nhắc**, không chặn.

---

## 7. Bảng nhãn — 10 nhãn, mỗi nhãn một cột hoặc một hành động

| Nhãn | Ai gắn | Người thấy nó thì LÀM GÌ |
|---|---|---|
| `status::backlog` | server | không gì |
| `status::working` | server | không gì — đọc "Đang làm" nếu muốn biết ai |
| `status::needs-you` | server (`task_block`, `question`) hoặc người kéo | **đọc "Cần bạn"**, trả lời, kéo về Backlog / giao lại |
| `status::in-review` | server (`task_complete`) | **QC** theo "Cách kiểm" → kéo sang Ready to merge |
| `status::ready-to-merge` | **người** kéo | **merge/rebase**, hoặc ok cho agent `task_close` |
| `careful` | intake/ingest khi `care: chat` | đọc kỹ hơn trước khi duyệt |
| `hotzone` | **người** | không chạy song song |
| `review::required` | **người** | đòi bằng chứng review |
| `source-drifted` | ingest | đối chiếu lại nguồn |
| `debt` | `task_complete` lên **issue nợ mới** | bóc như việc thường |

**Đã bỏ** (đọc được trên item cũ, không ghi nữa): `status::ready|claimed|review|blocked` →
backlog|working|in-review|needs-you · `care::chat` → `careful` · `gate::*` (vào `agent-meta.gate`) ·
`needs-advice` (= needs-you) · `spec-changed` (vào khối Kết quả).

### Nâng cấp từ 0.1.x / 0.2.x

```bash
tasks-cli labels --apply               # tạo 10 nhãn mới
tasks-cli labels --migrate             # xem item đang mở nào còn nhãn cũ
tasks-cli labels --migrate --apply     # đổi thật
tasks-cli labels --prune --apply       # xoá tên nhãn cũ khỏi project (gỡ khỏi mọi issue — không lùi)
tasks-cli board --apply                # dựng 5 cột
```

Chuyển `claimRepoUrl` từ `~/.agent-tasks/config.json` vào `agent-tasks.config.json` của repo. Máy
còn chạy plugin cũ sẽ gắn lại nhãn cũ lên item mới — nâng cấp cả nhóm trước khi `--prune`.

---

## 8. Nhiều dự án trên một máy

Mỗi repo một `agent-tasks.config.json` (board có thể khác nhau, hoặc nhiều repo trỏ chung một
project board). Token dùng chung ở `~/.agent-tasks/.env`. Claim-repo dùng chung được: ref đã tách
theo `projectKey` (`refs/claims/<projectKey>/<hash>`), `claims --all` thấy toàn cảnh.

Một clone cần token/board khác: `tasks-cli init --local` → `<git-dir>/agent-tasks.env` (git không
track). Không dùng `.claude/agent-tasks.config.json` — `.claude/` hay là symlink dùng chung.

---

## 9. Chẩn đoán

| Triệu chứng | Nghĩa | Xử |
|---|---|---|
| Cột Working, `claimed_by: null` | agent chết chưa dọn | `tasks_doctor --fix` (sau grace) → về Backlog |
| Có claim, cột không phải Working | GitLab lỗi lúc sync | `tasks_doctor --fix` |
| Hai `status::*` trên một item | Free không loại trừ scoped label | `tasks_doctor --fix` |
| Item còn `status::ready` / `care::chat` | chưa migrate | `tasks-cli labels --migrate --apply` |
| `reason: "offline"` | không với tới claim-repo | `git ls-remote <claimRepoUrl>` |
| `reason: "local-setup"` | lỗi đĩa local (`/tmp`) | kiểm quyền ghi / dung lượng |
| claim-repo "empty repository" | UI không render `refs/claims/*` | bình thường — `tasks-cli claims` |
| Card không có avatar | token là bot | `AGENT_TASKS_GITLAB_USER_ID` |
| `task_complete` báo thiếu `qc_steps` | chưa viết hướng dẫn QC | viết bước LÀM GÌ → THẤY GÌ (skill `task-finish`) |

---

## 10. Giới hạn đã biết

- Mô phỏng scoped label trên Free là **mô phỏng, không phải bảo đảm** — nhưng quyền làm việc do claim ref quyết.
- Đóng Claude Code ⇒ claim hết hạn sau ≤ TTL; trong khoảng đó item vẫn hiện Working.
- Free tier một board/project — `board --apply` dùng lại board đang có; thứ tự cột kéo tay.
- `tasks_list` lọc `role`/`shape`/`source`/`care=thuong` ở client trên 100 item — đọc `scan.truncated`.

---

## 11. Cho agent: skill nào cho việc gì

| Việc | Skill |
|---|---|
| Có yêu cầu mới (kể cả "sửa lỗi này") | `/task-new` — phỏng vấn → `task_intake` |
| Nhận việc: auto bóc Backlog, hoặc người giao #iid | `/task-next` |
| Sắp báo xong, viết hướng dẫn QC, khai nợ, đóng issue | `/task-finish` |
| Board đang thế nào, ai giữ gì, cái nào cần người | `/task-status` |
| Dạo này dự án đổi gì, vì sao | `/task-recap` |
| Trạng thái có vẻ sai, nhãn cũ, claim treo | `/task-doctor` |
| Cài máy mới / dự án mới / dựng board | `/task-setup` |
