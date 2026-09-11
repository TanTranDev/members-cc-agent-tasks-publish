// @ts-check
// Dựng issue board 5 cột cho NGƯỜI (docs/11 §C9). Tách khỏi CLI để test được với gitlab giả —
// bản đầu nằm trong `case 'board'` của tasks-cli và crash ở nhánh --apply mà không test nào bắt.
//
// Free tier: MỘT board mỗi project, tạo thêm trả 403/422 ⇒ dùng lại board đang có (ưu tiên board
// tên có chữ "agent", không thì board đầu tiên). Cột đã có thì bỏ qua — chạy lại không tốn gì.

import { STATUS, STATUS_HUMAN, labelDefinitions } from './schema.mjs';

/** Kế hoạch hiển thị cho người trước khi ghi. */
export function planBoard() {
  return STATUS.map((s) => ({ status: s, column: STATUS_HUMAN[s], label: `status::${s}` }));
}

/**
 * Tạo nhãn còn thiếu, tìm/tạo board, thêm cột còn thiếu.
 * @param {object} gitlab client có listLabels · createLabel · listBoards · createBoard · listBoardLists · createBoardList
 * @returns {Promise<{board: {id: number, name: string, created: boolean}, added: string[], existed: string[]}>}
 */
export async function applyBoard(gitlab) {
  for (const d of labelDefinitions()) await gitlab.createLabel(d);
  const labels = await gitlab.listLabels();
  const idOf = new Map(labels.map((l) => [l.name, l.id]));
  const want = STATUS.map((s) => `status::${s}`);
  const missing = want.filter((n) => !idOf.has(n));
  if (missing.length) {
    throw new Error(`project chưa có nhãn ${missing.join(', ')} sau khi tạo — kiểm quyền token (cần scope api).`);
  }

  const boards = await gitlab.listBoards();
  let board = boards.find((b) => /agent/i.test(b.name ?? '')) ?? boards[0];
  let created = false;
  if (!board) {
    board = await gitlab.createBoard('Agent');
    created = true;
  }

  const lists = await gitlab.listBoardLists(board.id);
  const have = new Set(lists.map((l) => l.label?.name).filter(Boolean));
  /** @type {string[]} */ const added = [];
  /** @type {string[]} */ const existed = [];
  for (const n of want) {
    if (have.has(n)) {
      existed.push(n);
      continue;
    }
    await gitlab.createBoardList(board.id, idOf.get(n));
    added.push(n);
  }
  return { board: { id: board.id, name: board.name, created }, added, existed };
}
