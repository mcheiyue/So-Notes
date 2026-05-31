import { Note } from './types';
import { DomainState } from './domainStore';
import { extractLayoutNote } from './normalization';

/** 新增或还原一张完整便签到 DomainState */
export interface AddNotePatch {
  type: 'add-note';
  note: Note;
}

/** 从 DomainState 中完全移除一张便签（非软删除，不设置 deletedAt） */
export interface RemoveNotePatch {
  type: 'remove-note';
  noteId: string;
}

/** 更新单张便签的字段 */
export interface UpdateFieldsPatch {
  type: 'update-fields';
  noteId: string;
  fields: Partial<Pick<Note, 'title' | 'content' | 'color' | 'collapsed' | 'updatedAt' | 'z' | 'width' | 'height' | 'boardId'>>;
}

/** 更新单张便签的位置 x/y */
export interface UpdatePositionPatch {
  type: 'update-position';
  noteId: string;
  x: number;
  y: number;
}

export type DomainPatch =
  | AddNotePatch
  | RemoveNotePatch
  | UpdateFieldsPatch
  | UpdatePositionPatch;

const LAYOUT_AFFECTING_FIELDS: ReadonlySet<string> = new Set([
  'x', 'y', 'boardId', 'color', 'width', 'height', 'deletedAt',
]);

function hasLayoutAffectingField(fields: Record<string, unknown>): boolean {
  for (const key of Object.keys(fields)) {
    if (LAYOUT_AFFECTING_FIELDS.has(key)) {
      return true;
    }
  }
  return false;
}

function omitRecordKey<TValue>(record: Record<string, TValue>, key: string): Record<string, TValue> {
  const nextRecord = { ...record };
  delete nextRecord[key];
  return nextRecord;
}

function removeFromBoardBucket(
  boardNoteIds: Record<string, string[]>,
  boardId: string,
  noteId: string,
): Record<string, string[]> {
  const bucket = boardNoteIds[boardId];
  if (!bucket) return boardNoteIds;

  const filtered = bucket.filter((id) => id !== noteId);
  if (filtered.length === 0) {
    return omitRecordKey(boardNoteIds, boardId);
  }
  return { ...boardNoteIds, [boardId]: filtered };
}

function appendToBoardBucket(
  boardNoteIds: Record<string, string[]>,
  boardId: string,
  noteId: string,
): Record<string, string[]> {
  const bucket = boardNoteIds[boardId] ?? [];
  if (bucket.includes(noteId)) return boardNoteIds;
  return { ...boardNoteIds, [boardId]: [...bucket, noteId] };
}

function recalculateMaxZ(state: DomainState): DomainState {
  const notes = Object.values(state.notesById);
  const maxNoteZ = notes.length > 0
    ? Math.max(...notes.map((note) => note.z || 0))
    : 0;
  const newMaxZ = Math.max(state.config.maxZ, maxNoteZ, state.allNoteIds.length);
  if (newMaxZ === state.config.maxZ) return state;
  return {
    ...state,
    config: { ...state.config, maxZ: newMaxZ },
  };
}

/** 对 DomainState 应用单条 patch，返回新的 DomainState。不变异输入。 */
export function applyDomainPatch(state: DomainState, patch: DomainPatch): DomainState {
  switch (patch.type) {
    case 'add-note':
      return applyAddNotePatch(state, patch);
    case 'remove-note':
      return applyRemoveNotePatch(state, patch);
    case 'update-fields':
      return applyUpdateFieldsPatch(state, patch);
    case 'update-position':
      return applyUpdatePositionPatch(state, patch);
  }
}

function applyAddNotePatch(state: DomainState, patch: AddNotePatch): DomainState {
  const { note } = patch;

  if (state.notesById[note.id]) {
    return state;
  }

  const newNotesById = { ...state.notesById, [note.id]: note };
  const newAllNoteIds = state.allNoteIds.includes(note.id)
    ? state.allNoteIds
    : [...state.allNoteIds, note.id];
  const newBoardNoteIds = appendToBoardBucket(state.boardNoteIds, note.boardId, note.id);
  const newLayoutNotesById = {
    ...state.layoutNotesById,
    [note.id]: extractLayoutNote(note),
  };

  return recalculateMaxZ({
    ...state,
    notesById: newNotesById,
    allNoteIds: newAllNoteIds,
    boardNoteIds: newBoardNoteIds,
    layoutNotesById: newLayoutNotesById,
  });
}

function applyRemoveNotePatch(state: DomainState, patch: RemoveNotePatch): DomainState {
  const { noteId } = patch;
  const note = state.notesById[noteId];
  if (!note) return state;

  const restNotesById = omitRecordKey(state.notesById, noteId);
  const newAllNoteIds = state.allNoteIds.filter((id) => id !== noteId);
  const newBoardNoteIds = removeFromBoardBucket(state.boardNoteIds, note.boardId, noteId);
  const restLayoutNotesById = omitRecordKey(state.layoutNotesById, noteId);

  return recalculateMaxZ({
    ...state,
    notesById: restNotesById,
    allNoteIds: newAllNoteIds,
    boardNoteIds: newBoardNoteIds,
    layoutNotesById: restLayoutNotesById,
  });
}

function applyUpdateFieldsPatch(state: DomainState, patch: UpdateFieldsPatch): DomainState {
  const { noteId, fields } = patch;
  const note = state.notesById[noteId];
  if (!note) return state;

  const updatedNote: Note = { ...note, ...fields };
  const newNotesById = { ...state.notesById, [noteId]: updatedNote };

  let newBoardNoteIds = state.boardNoteIds;
  let newLayoutNotesById = state.layoutNotesById;

  if (fields.boardId !== undefined && fields.boardId !== note.boardId) {
    newBoardNoteIds = removeFromBoardBucket(newBoardNoteIds, note.boardId, noteId);
    newBoardNoteIds = appendToBoardBucket(newBoardNoteIds, fields.boardId, noteId);
  }

  if (hasLayoutAffectingField(fields)) {
    newLayoutNotesById = {
      ...newLayoutNotesById,
      [noteId]: extractLayoutNote(updatedNote),
    };
  }

  return recalculateMaxZ({
    ...state,
    notesById: newNotesById,
    boardNoteIds: newBoardNoteIds,
    layoutNotesById: newLayoutNotesById,
  });
}

function applyUpdatePositionPatch(state: DomainState, patch: UpdatePositionPatch): DomainState {
  const { noteId, x, y } = patch;
  const note = state.notesById[noteId];
  if (!note) return state;

  const updatedNote: Note = { ...note, x, y };
  const newNotesById = { ...state.notesById, [noteId]: updatedNote };
  const newLayoutNotesById = {
    ...state.layoutNotesById,
    [noteId]: extractLayoutNote(updatedNote),
  };

  return {
    ...state,
    notesById: newNotesById,
    layoutNotesById: newLayoutNotesById,
  };
}
