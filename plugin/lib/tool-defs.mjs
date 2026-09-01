// @ts-check
// Khai báo bộ tool MCP — DỮ LIỆU THUẦN, không logic.
//
// Tách khỏi lib/tools.mjs để hai thứ đổi vì hai lý do khác nhau không phải chạm cùng một file:
// khai báo đổi khi hợp đồng với model đổi; handler đổi khi nghiệp vụ đổi.
//
// Ngân sách: 14 tool vận hành + 1 tool cài đặt = 15. Anthropic đo được rằng quá "a couple of dozen"
// tool thì độ chính xác chọn tool của model giảm — nên đây là trần cứng, không phải gợi ý.
//
// Trần từng là 14 và đã được NÂNG có ý thức lên 15 khi thêm `task_intake` (lô 2, D21):
//   - 15 vẫn xa ngưỡng ~2 chục nên rủi ro chọn sai tool không đổi đáng kể;
//   - lô 2 đã gộp `find_candidates` + `create_from_brief` thành MỘT tool để chỉ tốn 1 suất;
//   - điều kiện kèm theo: skill phải rõ ràng. `plugin/skills/task-new/SKILL.md` là phần bắt buộc
//     của lô này, không phải phụ kiện — tool nhiều mà không có skill chỉ đường thì đúng là chỗ
//     model bắt đầu chọn sai.
// Muốn thêm tool thứ 16: gộp hoặc bỏ một tool khác trước, đừng nâng trần lần nữa mà không đo.
//
// v0.2 — `tasks_recap` vào, `tasks_ingest` RA khỏi mặt MCP. Trần giữ nguyên 15, đúng luật trên.
//   · Vì sao trả bằng `tasks_ingest`: không skill nào gọi nó; CLI có đủ nghiệp vụ và còn IN RA
//     KẾ HOẠCH trước khi ghi (`tasks-cli ingest`, mặc định dry-run); và chính mô tả của nó nói
//     "tạo hàng loạt issue là thao tác khó lùi" — thao tác khó lùi thì thuộc tay người vận hành
//     trong terminal, không thuộc danh sách tool mà agent chọn giữa lúc làm việc.
//   · Vì sao KHÔNG trả bằng `tasks_probe_capabilities`, dù nó cũng là tool cài đặt: nó từng là
//     TOOL CHẾT và đã được trả nợ có chủ đích (README "nợ đã trả", kèm
//     `__tests__/runtime-wiring.test.mjs` canh đúng chỗ nối), và `plugin/skills/task-setup`
//     khai đường MCP của nó. Gỡ nó là lặng lẽ đảo một việc đã làm xong.
//   · Điều kiện kèm theo — GIỐNG lần nâng trần ở lô 2: phải có skill chỉ đường.
//     `plugin/skills/task-recap/SKILL.md` là phần bắt buộc của lô này, không phải phụ kiện.
//   · Bất biến "thao tác khó lùi mặc định an toàn" trước đây được canh bằng một test trên
//     inputSchema của `tasks_ingest`. Test đó đã được THAY, không bỏ: nay canh chính
//     `createIngestRunner().run({})` (xem `__tests__/ingest-run.test.mjs`) — mạnh hơn, vì nó đo
//     hành vi chứ không đo một hằng số trong khai báo.

import { ROLE, SHAPE, CARE, SOURCE, STATUS, OBSERVE } from './schema.mjs';

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const I = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const B = (description, def) => ({ type: 'boolean', description, ...(def === undefined ? {} : { default: def }) });

// Import từ schema.mjs thay vì khai lại: hai bản sao của một enum là một cặp phải đồng bộ bằng
// tay, và lệch nhau ở đây thì model gửi giá trị mà server từ chối — hoặc tệ hơn, server nhận một
// giá trị mà bộ lọc không bao giờ khớp.
const ROLE_ENUM = ROLE;
const SHAPE_ENUM = SHAPE;

export const TOOL_DEFS = [
  {
    name: 'tasks_list',
    description:
      'Liệt kê work item theo bộ lọc. Chỉ ĐỌC, không giành việc. Dùng để xem hàng đợi có gì trước khi quyết định. ' +
      'Trả kèm `scan`: lọc theo role/shape/source (hoặc care=thuong) chạy ở CLIENT trên một trang 100 item, ' +
      'nên `scan.truncated: true` nghĩa là CÒN item ngoài phạm vi quét — đừng đọc kết quả đó thành "hàng đợi chỉ có thế".',
    inputSchema: {
      type: 'object',
      properties: {
        status: { enum: STATUS, description: 'Lọc SERVER-side (nhãn).' },
        role: { enum: ROLE_ENUM, description: 'Lọc CLIENT-side (agent-meta.role_hint) — xem `scan`.' },
        shape: { enum: SHAPE_ENUM, description: 'Lọc CLIENT-side (agent-meta.shape) — xem `scan`.' },
        care: {
          enum: CARE,
          description: '`chat` lọc SERVER-side (nhãn care::chat); `thuong` lọc CLIENT-side vì mức thường = VẮNG nhãn.',
        },
        source: { enum: SOURCE, description: 'Lọc CLIENT-side (agent-meta.source.kind) — xem `scan`.' },
        limit: I('Tối đa bao nhiêu item. Mặc định 20, trần 100.', { default: 20 }),
      },
    },
  },
  {
    name: 'task_get',
    description: 'Đọc chi tiết một work item kèm khối agent-meta và trạng thái claim hiện tại.',
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
      'KHÁC task_claim_next: cái đó bốc việc ĐÃ CÓ trong hàng đợi, còn đây là việc chưa từng vào hệ thống. ' +
      'Có ứng viên trùng mức EXACT/CAO thì tool KHÔNG tạo và trả danh sách để bạn đọc — đó là điểm chính của nó.',
    inputSchema: {
      type: 'object',
      required: ['brief'],
      properties: {
        brief: S('Mô tả việc cần làm, nguyên văn theo cách người dùng nói. Dòng đầu dùng làm title.'),
        title: S('Ghi đè title. Bỏ trống ⇒ suy từ dòng đầu của brief.'),
        slug: S('Khoá bền để dò trùng lần sau. Bỏ trống ⇒ suy từ title. Sẽ được chuẩn hoá.'),
        capability: S('Capability liên quan (tên thư mục trong specs/). Giúp dò trùng chính xác hơn.'),
        shape: { enum: SHAPE_ENUM, description: 'Hình dạng công việc.' },
        care: { enum: ['thuong', 'chat'], description: 'Mức cẩn trọng.' },
        hazard: S(
          'Một dòng "hazard là <gì>; vỡ thì <hậu quả>". BẮT BUỘC trên thực tế khi care = chat: ' +
            'task_complete sẽ từ chối đóng item care::chat có hazard rỗng. Khai ở đây là đúng chỗ — ' +
            'hazard thuộc lúc PHÂN LOẠI (Q3), không phải lúc báo xong.',
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
      'Giành work item tiếp theo phù hợp và trả về nội dung việc kèm claim_token. Đây là cách ĐÚNG DUY NHẤT ' +
      'để bắt đầu một task — không claim mà làm thì hai phiên có thể làm trùng mà không ai biết cho tới lúc merge. ' +
      'Trả claimed=false nếu không còn item nào khớp. Claim tự hết hạn nếu không heartbeat.',
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
    description: 'Giành một item CỤ THỂ theo iid. Dùng khi đã biết mình muốn làm cái nào.',
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
    description: 'Nhả claim, trả item về hàng đợi. Dùng khi không làm nữa nhưng chưa xong.',
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
      'Ghi một mốc tiến độ lên item (thành comment). Dùng cho mốc THẬT: xong một bước của plan, phát hiện ' +
      'điều bất ngờ. KHÔNG dùng để tường thuật từng thao tác. Bị giới hạn tần suất.',
    inputSchema: {
      type: 'object',
      required: ['work_item_iid', 'claim_token', 'message'],
      properties: {
        work_item_iid: I('iid của item.'),
        claim_token: S('Token claim.'),
        message: S('Nội dung mốc.', { maxLength: 4000 }),
        kind: { enum: ['progress', 'finding', 'question', 'warning'], default: 'progress' },
      },
    },
  },
  {
    name: 'task_attach_docs',
    description:
      'Đính tài liệu của task lên item: upload file gốc (spec.md · ledger.md · handoff-qc.md · api-spec.md) ' +
      'rồi ghi một khối bảng link + tóm tắt gate vào description. Làm luôn việc set nhãn gate:: từ ledger. ' +
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
        api_spec: {
          type: 'array',
          items: { type: 'string' },
          description: 'Các file tài liệu API. Bỏ trống ⇒ mọi .md trong docs-raw/<slug>/ trừ brief.md.',
        },
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
      'Báo xong phần của agent: item sang status::review và nhả claim. Server KIỂM TRA TRƯỚC khi cho qua — ' +
      'thiếu điều kiện sẽ trả lỗi kèm danh sách chính xác thiếu gì.',
    inputSchema: {
      type: 'object',
      required: ['work_item_iid', 'claim_token', 'summary', 'spec_delta'],
      properties: {
        work_item_iid: I('iid của item.'),
        claim_token: S('Token claim.'),
        summary: S('Tóm tắt đã làm gì.', { maxLength: 4000 }),
        spec_delta: {
          type: 'array',
          description:
            'BẮT BUỘC có mặt. Mảng rỗng [] nghĩa là không đổi hành vi quan sát được — khi đó risk_declared phải nói rõ điều đó.',
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
        risk_declared: S('3–5 dòng: đã đổi hành vi gì · edge case CHƯA test · chỗ không chắc.'),
        hazard: S(
          'Một dòng "hazard là <gì>; vỡ thì <hậu quả>". BẮT BUỘC khi item có nhãn care::chat và ' +
            'chưa khai hazard từ lúc task_intake — không khai thì lệnh này bị từ chối. ' +
            'Chuỗi rỗng/khoảng trắng bị bỏ qua, KHÔNG xoá lời khai đã có.',
        ),
        review_evidence: S(
          'BẮT BUỘC khi item có nhãn review::required: trỏ tới bằng chứng review — số note của ' +
            'code-reviewer, hoặc xác nhận tường minh của người. Chuỗi rỗng/khoảng trắng bị bỏ qua.',
        ),
        tradeoff: S(
          'ĐÃ CHỌN HƯỚNG NÀO, BỎ HƯỚNG NÀO, ĐỔI LẠI ĐƯỢC GÌ. BẮT BUỘC khi item là care::chat hoặc ' +
            'có review::required — hai ca đó chắc chắn có đánh đổi. Đây là trường mà bản recap N ' +
            'ngày dùng để trả lời "vì sao hệ thống thành ra thế này", nên viết cho người đọc sau ' +
            '3 tháng, không phải cho người đang ngồi cạnh. Không có đánh đổi nào thì viết đúng thế ' +
            'kèm lý do. Chuỗi rỗng/khoảng trắng bị bỏ qua, KHÔNG xoá lời khai đã có.',
        ),
        debt: S(
          'NỢ KỸ THUẬT CỐ Ý ĐỂ LẠI: thứ biết là chưa đúng/chưa đủ, ở đâu, và trả thì phải làm gì. ' +
            'Không bắt buộc — nhưng khai thì tool tự gắn nhãn `debt` lên item, và item đó sẽ hiện ' +
            'trong mục "nợ còn mở" của `tasks_recap` cho tới khi được đóng. Không có nợ thì BỎ ' +
            'TRỐNG, đừng viết "không có" (nó sẽ thành một nhãn debt rỗng nghĩa).',
        ),
        gate_waiver: S('Chỉ điền khi gate chưa xanh: nói rõ vì sao lần này không có bằng chứng gate.'),
        observe: { enum: OBSERVE, default: 'l0' },
        mr_url: S('Link merge request nếu có.'),
      },
    },
  },
  {
    name: 'task_block',
    description:
      'Đánh dấu bế tắc: item sang status::blocked, nhả claim, gắn needs-advice. Dùng khi 3-strikes hoặc cần người gỡ.',
    inputSchema: {
      type: 'object',
      required: ['work_item_iid', 'claim_token', 'reason'],
      properties: {
        work_item_iid: I('iid của item.'),
        claim_token: S('Token claim.'),
        reason: S('Bế tắc ở đâu.'),
        needs: S('Cần gì để gỡ.'),
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
      'Chẩn đoán lệch giữa claim ref và nhãn GitLab, và claim quá hạn. Chỉ đọc trừ khi fix=true.',
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
      'docs/releases/entries · docs/knowledge) và khai rõ nguồn nào KHÔNG đọc được — ' +
      'nguồn thiếu KHÔNG có nghĩa là "kỳ này không có gì xảy ra".',
    inputSchema: {
      type: 'object',
      properties: {
        days: I('Cửa sổ, số ngày. Mặc định 7, trần 90.', { default: 7, minimum: 1, maximum: 90 }),
      },
    },
  },
];

/** Tool chỉ chạy lúc cài đặt — không nằm trong luồng làm việc thường ngày. */
export const SETUP_TOOL_DEFS = [
  {
    name: 'tasks_probe_capabilities',
    description:
      'Dò năng lực GitLab instance (version, có scoped label không, work items GraphQL…) rồi ghi vào cấu hình. ' +
      'Chạy một lần lúc cài. Thứ KHÔNG dò được sẽ liệt kê ở trường unverified thay vì im lặng bỏ qua.',
    inputSchema: {
      type: 'object',
      properties: {
        probe_issue_iid: I('Issue nháp để thử scoped label. Bỏ trống ⇒ bỏ qua phép thử tier.'),
        write: B('true ⇒ ghi kết quả vào file cấu hình.', false),
      },
    },
  },
];

export const ALL_TOOL_NAMES = [...TOOL_DEFS, ...SETUP_TOOL_DEFS].map((t) => t.name);

