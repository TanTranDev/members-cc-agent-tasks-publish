// @ts-check
// Khai báo bộ tool MCP — DỮ LIỆU THUẦN, không logic.
//
// Tách khỏi lib/tools.mjs để hai thứ đổi vì hai lý do khác nhau không phải chạm cùng một file:
// khai báo đổi khi hợp đồng với model đổi; handler đổi khi nghiệp vụ đổi.
//
// Ngân sách: 15 tool vận hành. Anthropic đo được rằng quá "a couple of dozen" tool thì độ chính
// xác chọn tool của model giảm — nên đây là trần cứng, không phải gợi ý.
//
// Lịch sử trần:
//   · 14 → 15 ở lô 2 khi thêm `task_intake`, kèm điều kiện: tool cửa vào phải có skill chỉ đường.
//   · v0.2: `tasks_recap` vào, `tasks_ingest` ra (nhập hàng loạt là thao tác khó lùi, thuộc CLI).
//   · v0.3: `task_close` vào, `tasks_probe_capabilities` RA khỏi mặt MCP. Probe là việc CÀI ĐẶT,
//     chạy một lần bằng `tasks-cli probe`; không agent nào cần nó giữa lúc làm việc. `task_close`
//     thì nằm ngay trên đường đi hàng ngày (docs/11 §C7): người ok ⇒ agent merge ⇒ đóng issue.
// Muốn thêm tool thứ 16: gộp hoặc bỏ một tool khác trước, đừng nâng trần lần nữa mà không đo.

import { ROLE, SHAPE, CARE, SOURCE, STATUS, NEEDS_KIND } from './schema.mjs';

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const I = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const B = (description, def) => ({ type: 'boolean', description, ...(def === undefined ? {} : { default: def }) });
const LIST = (description) => ({ type: 'array', items: { type: 'string' }, description });

const ROLE_ENUM = ROLE;
const SHAPE_ENUM = SHAPE;

export const TOOL_DEFS = [
  {
    name: 'tasks_list',
    description:
      'Liệt kê work item theo bộ lọc. Chỉ ĐỌC, không giành việc. Dùng để xem board có gì trước khi quyết định. ' +
      'Mỗi item trả `status` (backlog · working · needs-you · in-review · ready-to-merge), `claimed_by` ' +
      '(ai/máy/agent đang làm), `needs` (vì sao cần người) và `mr`. ' +
      'Trả kèm `scan`: lọc theo role/shape/source (hoặc care=thuong) chạy ở CLIENT trên một trang 100 item, ' +
      'nên `scan.truncated: true` nghĩa là CÒN item ngoài phạm vi quét.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { enum: STATUS, description: 'Cột trên board. Lọc SERVER-side (nhãn).' },
        role: { enum: ROLE_ENUM, description: 'Lọc CLIENT-side (agent-meta.role_hint) — xem `scan`.' },
        shape: { enum: SHAPE_ENUM, description: 'Lọc CLIENT-side (agent-meta.shape) — xem `scan`.' },
        care: {
          enum: CARE,
          description: '`chat` lọc SERVER-side (nhãn careful); `thuong` lọc CLIENT-side vì mức thường = VẮNG nhãn.',
        },
        source: { enum: SOURCE, description: 'Lọc CLIENT-side (agent-meta.source.kind) — xem `scan`.' },
        limit: I('Tối đa bao nhiêu item. Mặc định 20, trần 100.', { default: 20 }),
      },
    },
  },
  {
    name: 'task_get',
    description: 'Đọc chi tiết một work item kèm khối agent-meta, ai đang giữ, và vì sao cần người (nếu có).',
    inputSchema: {
      type: 'object',
      required: ['work_item_iid'],
      properties: { work_item_iid: I('Số iid của issue trong project.') },
    },
  },
  {
    name: 'task_intake',
    description:
      'CỬA VÀO cho mọi yêu cầu MỚI: task mới, sửa lỗi, bổ sung tính năng, hoặc việc agent tự phát hiện ' +
      'giữa lúc làm. Dò trùng trước rồi tạo work item, và claim luôn nếu phiên đang rảnh. ' +
      'PHẢI PHỎNG VẤN NGƯỜI TRƯỚC (skill task-new): `title` là tên việc bạn tự viết sau khi hiểu, KHÔNG phải ' +
      'câu chat của người; `acceptance` là tiêu chí hoàn thành kiểm được. `brief` là nguyên văn, chỉ dùng để dò ' +
      'trùng và lưu tham khảo. ' +
      'KHÁC task_claim_next: cái đó bốc việc ĐÃ CÓ trong Backlog, còn đây là việc chưa từng vào hệ thống. ' +
      'Có ứng viên trùng mức EXACT/CAO thì tool KHÔNG tạo và trả danh sách để bạn đọc.',
    inputSchema: {
      type: 'object',
      required: ['title', 'acceptance', 'brief'],
      properties: {
        title: S(
          'Tên việc, ≤ 80 ký tự, dạng động từ + đối tượng ("Thêm reconnect cho WS client khi mất mạng"). ' +
            'Bạn viết sau khi đã hiểu yêu cầu — không dán câu chat của người.',
        ),
        acceptance: LIST(
          'Tiêu chí hoàn thành, mỗi dòng một điều KIỂM ĐƯỢC ("mất mạng 10s rồi có lại ⇒ client tự nối trong ≤ 3s"). ' +
            'Ít nhất một dòng. Đây là thứ người QC sẽ đối chiếu.',
        ),
        brief: S('Nguyên văn yêu cầu theo cách người nói (giữ để dò trùng và tham khảo — sẽ nằm trong mục gấp).'),
        goal: S('Mục tiêu / vì sao cần việc này, 1–3 câu cho người đọc sau.'),
        scope: LIST('Phạm vi: những gì việc này CÓ làm.'),
        out_of_scope: LIST('Những gì việc này KHÔNG làm — để không ai kỳ vọng nhầm.'),
        slug: S('Khoá bền để dò trùng lần sau. Bỏ trống ⇒ suy từ title. Sẽ được chuẩn hoá.'),
        capability: S('Capability liên quan (tên thư mục trong specs/). Giúp dò trùng chính xác hơn.'),
        shape: { enum: SHAPE_ENUM, description: 'Hình dạng công việc (agent-meta).' },
        care: { enum: ['thuong', 'chat'], description: '`chat` ⇒ gắn nhãn `careful` (việc chạm thứ đắt).' },
        hazard: S(
          'Một dòng "hazard là <gì>; vỡ thì <hậu quả>". BẮT BUỘC trên thực tế khi care = chat: ' +
            'task_complete sẽ từ chối đóng item careful có hazard rỗng.',
        ),
        role: { enum: ROLE_ENUM, description: 'Vai phù hợp để làm việc này.' },
        force: B('true ⇒ tạo dù có ứng viên mức CAO. Chỉ dùng SAU KHI đã đọc danh sách ứng viên.', false),
        dry_run: B('true ⇒ chỉ dò trùng, không ghi gì lên GitLab.', false),
        ttl_sec: I('TTL của claim nếu tool claim luôn. Bỏ trống ⇒ theo cấu hình.'),
      },
    },
  },
  {
    name: 'task_claim_next',
    description:
      'CHẾ ĐỘ AUTO: giành work item tiếp theo trong Backlog và trả về nội dung việc kèm claim_token. Đây là cách ' +
      'ĐÚNG DUY NHẤT để bắt đầu một task — không claim mà làm thì hai phiên có thể làm trùng mà không ai biết. ' +
      'Item chuyển sang Working và ghi rõ ai/máy/agent đang làm. Trả claimed=false nếu không còn item nào khớp. ' +
      'Claim tự hết hạn nếu không heartbeat.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { enum: ROLE_ENUM, description: 'Chỉ lấy item gợi ý cho vai này. Bỏ trống ⇒ mọi vai.' },
        shape: { enum: SHAPE_ENUM },
        care: { enum: CARE },
        exclude_hotzone: B('true ⇒ bỏ qua item chạm hot-zone (những item đó phải chạy tuần tự).', false),
        ttl_sec: I('Thời hạn giữ, giây.', { minimum: 300, maximum: 14400 }),
      },
    },
  },
  {
    name: 'task_claim',
    description:
      'CHẾ ĐỘ MANUAL: giành một item CỤ THỂ theo iid — khi người giao đích danh việc này cho bạn, hoặc khi ' +
      'nhận lại item ở Needs you sau khi người đã trả lời. Item chuyển sang Working.',
    inputSchema: {
      type: 'object',
      required: ['work_item_iid'],
      properties: { work_item_iid: I('iid của item.'), ttl_sec: I('Thời hạn giữ, giây.') },
    },
  },
  {
    name: 'task_heartbeat',
    description:
      'Gia hạn claim đang giữ. Gọi khi sắp làm việc dài. Trả lost_claim=true nghĩa là claim ĐÃ BỊ THU HỒI — ' +
      'khi đó phải DỪNG ngay, không ghi thêm gì lên item nữa.',
    inputSchema: {
      type: 'object',
      required: ['work_item_iid', 'claim_token'],
      properties: {
        work_item_iid: I('iid của item.'),
        claim_token: S('Token nhận được lúc claim.'),
        extend_sec: I('Gia hạn thêm bao nhiêu giây.'),
      },
    },
  },
  {
    name: 'task_release',
    description: 'Nhả claim, trả item về Backlog. Dùng khi không làm nữa nhưng chưa xong.',
    inputSchema: {
      type: 'object',
      required: ['work_item_iid', 'claim_token'],
      properties: {
        work_item_iid: I('iid của item.'),
        claim_token: S('Token claim.'),
        reason: S('Vì sao nhả — ghi lên item cho người sau.'),
      },
    },
  },
  {
    name: 'task_report_progress',
    description:
      'Ghi một mốc lên item (thành comment). `kind: "question"` ⇒ item sang cột NEEDS YOU nhưng bạn VẪN GIỮ ' +
      'claim — dùng khi cần người quyết định/trả lời mà bạn còn đang chờ. Kind khác ⇒ item về Working. ' +
      'Dùng cho mốc THẬT, KHÔNG tường thuật từng thao tác. Bị giới hạn tần suất.',
    inputSchema: {
      type: 'object',
      required: ['work_item_iid', 'claim_token', 'message'],
      properties: {
        work_item_iid: I('iid của item.'),
        claim_token: S('Token claim.'),
        message: S('Nội dung mốc. Với question: câu hỏi + các lựa chọn + bạn khuyến nghị gì.', { maxLength: 4000 }),
        kind: { enum: ['progress', 'finding', 'question', 'warning'], default: 'progress' },
      },
    },
  },
  {
    name: 'task_attach_docs',
    description:
      'Đính tài liệu của task lên item: upload file gốc (spec.md · ledger.md · handoff-qc.md · api-spec.md) ' +
      'rồi ghi một khối bảng link + tóm tắt gate vào description, và lưu kết quả gate vào agent-meta. ' +
      'PHẢI gọi TRƯỚC task_complete hoặc task_block (hai lệnh đó nhả claim). Chạy lại không tốn gì: ' +
      'nội dung không đổi thì bỏ qua.',
    inputSchema: {
      type: 'object',
      required: ['work_item_iid', 'claim_token'],
      properties: {
        work_item_iid: I('iid của item.'),
        claim_token: S('Token claim.'),
        spec: S('Đường dẫn specs/<capability>/spec.md. Bỏ trống ⇒ suy từ agent-meta hoặc spec_delta.'),
        ledger: S(
          'Đường dẫn docs/wip/<lô>/verify.md. Bỏ trống ⇒ lấy lô mới nhất theo mtime (PHỎNG ĐOÁN — sẽ cần confirm).',
        ),
        handoff: S(
          'Đường dẫn docs/releases/entries/<YYYYMM>/<ts>-<slug>.md. Bỏ trống ⇒ fragment mới nhất (PHỎNG ĐOÁN).',
        ),
        api_spec: LIST('Các file tài liệu API. Bỏ trống ⇒ mọi .md trong docs-raw/<slug>/ trừ brief.md.'),
        spec_delta: {
          type: 'array',
          description:
            'spec_delta bạn sắp gửi cho task_complete. Dùng để suy ra capability khi item không có ' +
            'agent-meta.source — nhờ vậy khỏi phải khai spec tường minh.',
          items: {
            type: 'object',
            properties: {
              capability: S('Tên capability trong specs/.'),
              op: S('ADDED | MODIFIED | REMOVED | RENAMED.'),
              requirement: S('Tên requirement.'),
            },
          },
        },
        confirm: B(
          'Bắt buộc true khi có nguồn phải PHỎNG ĐOÁN (mtime). Nguồn khai tường minh thì không cần.',
          false,
        ),
      },
    },
  },
  {
    name: 'task_complete',
    description:
      'Báo xong phần của agent: item sang IN REVIEW và nhả claim. Server KIỂM TRA TRƯỚC khi cho qua — ' +
      'thiếu điều kiện sẽ trả lỗi kèm danh sách chính xác thiếu gì. Điều kiện quan trọng nhất: HƯỚNG DẪN QC ' +
      '(`qc_steps`) để người kiểm được bằng tay; chỉ khi không thể kiểm tay mới dùng `qc_not_manual` + bằng ' +
      'chứng máy. Nợ để lại (`debt`) sẽ thành ISSUE MỚI trong Backlog, không gắn nhãn lên item này.',
    inputSchema: {
      type: 'object',
      required: ['work_item_iid', 'claim_token', 'summary'],
      properties: {
        work_item_iid: I('iid của item.'),
        claim_token: S('Token claim.'),
        summary: S('Đã làm gì, 2–6 dòng cho người đọc.', { maxLength: 4000 }),
        qc_steps: LIST(
          'HƯỚNG DẪN KIỂM TAY cho người QC — mỗi phần tử một bước: "LÀM GÌ → THẤY GÌ". Nêu rõ màn hình / ' +
            'endpoint / lệnh, dữ liệu mẫu, và kết quả kỳ vọng. Bắt buộc, trừ khi việc này không thể kiểm tay ' +
            '(khi đó dùng qc_not_manual).',
        ),
        qc_not_manual: S(
          'CHỈ khi không thể kiểm tay: vì sao (vd "refactor nội bộ, không đổi hành vi quan sát được"). ' +
            'Khi dùng trường này phải có gate xanh hoặc `qc_evidence`.',
        ),
        qc_evidence: S('Bằng chứng máy đi kèm qc_not_manual: test nào / lệnh nào đã chạy, kết quả.'),
        spec_delta: {
          type: 'array',
          description:
            'Đổi hành vi quan sát được, theo specs/. Không bắt buộc; có thì mỗi mục {capability, op, requirement}.',
          items: {
            type: 'object',
            required: ['capability', 'op', 'requirement'],
            properties: {
              capability: S('Tên capability trong specs/.'),
              op: { enum: ['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED'] },
              requirement: S('Tên requirement NGUYÊN VĂN.'),
            },
          },
        },
        risk_declared: S('Chỗ chưa chắc / edge case CHƯA test — để người QC soi đúng chỗ.'),
        hazard: S(
          'Một dòng "hazard là <gì>; vỡ thì <hậu quả>". BẮT BUỘC khi item có nhãn careful và chưa khai ' +
            'hazard từ lúc task_intake. Chuỗi rỗng bị bỏ qua, KHÔNG xoá lời khai đã có.',
        ),
        review_evidence: S(
          'BẮT BUỘC khi item có nhãn review::required: số note của code-reviewer, hoặc xác nhận của người.',
        ),
        tradeoff: S(
          'ĐÃ CHỌN HƯỚNG NÀO, BỎ HƯỚNG NÀO, ĐỔI LẠI ĐƯỢC GÌ. BẮT BUỘC khi item careful hoặc review::required. ' +
            'Viết cho người đọc sau 3 tháng.',
        ),
        debt: {
          type: 'array',
          description:
            'NỢ KỸ THUẬT CỐ Ý ĐỂ LẠI. Mỗi khoản THÀNH MỘT ISSUE MỚI trong Backlog (nhãn debt) — nên title phải ' +
            'đọc như một việc phải làm. Không có nợ thì BỎ TRỐNG.',
          items: {
            type: 'object',
            required: ['title'],
            properties: {
              title: S('Việc phải làm để trả nợ ("Đổi OrdersScreen sang /v2/orders").'),
              detail: S('Ở đâu, vì sao để lại, trả thì làm gì.'),
            },
          },
        },
        gate_waiver: S('Nếu có ledger nhưng gate đỏ: vì sao vẫn báo xong. Không bắt buộc.'),
        mr_url: S('Link merge request nếu có — người sẽ merge/rebase ở cột Ready to merge.'),
      },
    },
  },
  {
    name: 'task_block',
    description:
      'Agent KHÔNG tự đi tiếp được và DỪNG: item sang cột NEEDS YOU, nhả claim, ghi rõ cần người làm gì. ' +
      'Dùng khi 3-strikes, chờ quyết định lâu, hoặc cần người gỡ. Khác task_report_progress kind=question ' +
      '(cái đó GIỮ claim và chờ).',
    inputSchema: {
      type: 'object',
      required: ['work_item_iid', 'claim_token', 'reason'],
      properties: {
        work_item_iid: I('iid của item.'),
        claim_token: S('Token claim.'),
        reason: S('Kẹt ở đâu.'),
        needs: S('Người cần làm gì để agent đi tiếp — càng cụ thể càng tốt.'),
        kind: { enum: NEEDS_KIND, default: 'blocked', description: 'Loại: question · decision · blocked · ci-failed · changes-requested.' },
      },
    },
  },
  {
    name: 'task_close',
    description:
      'ĐÓNG issue sau khi NGƯỜI đã ok: bạn hỏi, người đồng ý (merge thẳng / rebase thẳng / xong rồi), bạn làm, ' +
      'rồi gọi lệnh này. Item phải đang ở In review hoặc Ready to merge. KHÔNG có ok của người thì KHÔNG gọi — ' +
      'item dừng ở Ready to merge để người tự merge.',
    inputSchema: {
      type: 'object',
      required: ['work_item_iid', 'approved_by'],
      properties: {
        work_item_iid: I('iid của item.'),
        approved_by: S('Ai đã ok, nguyên văn ("Tôn: ok merge đi").'),
        merged_ref: S('MR đã merge / commit / branch đã rebase — bằng chứng việc đã land.'),
        note: S('Ghi chú thêm cho người đọc sau.'),
      },
    },
  },
  {
    name: 'tasks_my_claims',
    description: 'Liệt kê các claim mà PHIÊN NÀY đang giữ, kèm thời gian còn lại. Dùng để kiểm tra trước khi kết thúc.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tasks_doctor',
    description:
      'Chẩn đoán lệch giữa claim ref và nhãn GitLab, claim quá hạn, và nhãn v0.2 chưa dọn. Chỉ đọc trừ khi fix=true.',
    inputSchema: {
      type: 'object',
      properties: { fix: B('true ⇒ tự sửa những lệch an toàn.', false) },
    },
  },
  {
    name: 'tasks_recap',
    description:
      'BỐI CẢNH DỰ ÁN trong N ngày qua: đã land gì, VÌ SAO (đánh đổi đã chốt), nợ kỹ thuật còn mở, ' +
      'hành vi quan sát được nào đã đổi, bài học đã ghi, và việc đang ở đâu lúc này. ' +
      'Gọi khi: mới vào dự án · quay lại sau khi nghỉ · trước khi bốc một task ở vùng lạ · ' +
      'người hỏi "dạo này có gì thay đổi". Chỉ ĐỌC. Gộp từ BA nguồn (item tracker · ' +
      'docs/releases/entries · docs/knowledge) và khai rõ nguồn nào KHÔNG đọc được.',
    inputSchema: {
      type: 'object',
      properties: {
        days: I('Cửa sổ, số ngày. Mặc định 7, trần 90.', { default: 7, minimum: 1, maximum: 90 }),
      },
    },
  },
];

/**
 * Tool chỉ chạy lúc cài đặt. v0.3: RỖNG — `tasks_probe_capabilities` rời mặt MCP, còn `tasks-cli probe`.
 * Giữ export để server/test không phải đổi hình dạng.
 */
export const SETUP_TOOL_DEFS = [];

export const ALL_TOOL_NAMES = [...TOOL_DEFS, ...SETUP_TOOL_DEFS].map((t) => t.name);
