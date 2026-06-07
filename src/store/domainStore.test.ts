import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialDomainState, domainSelectors, setDomainPersistenceBridge, useDomainStore } from './domainStore';

const resetDomainStore = () => {
  useDomainStore.getState().replaceDomainState(createInitialDomainState());
};

describe('domainStore 只读骨架', () => {
  beforeEach(() => {
    setDomainPersistenceBridge(null);
    resetDomainStore();
  });

  afterEach(() => {
    setDomainPersistenceBridge(null);
  });

  it('提供默认 Domain 状态，不包含 UI 与 Viewport 状态', () => {
    const state = createInitialDomainState();

    expect(state.boards).toHaveLength(1);
    expect(state.currentBoardId).toBe(state.boards[0].id);
    expect(state.allNoteIds).toEqual([]);
    expect('viewMode' in state).toBe(false);
    expect('viewport' in state).toBe(false);
    expect('contextMenu' in state).toBe(false);
  });

  it('只读 selector 能读取当前看板便签与废纸篓便签', () => {
    const state = createInitialDomainState();
    state.notesById = {
      noteA: {
        id: 'noteA',
        kind: 'text',
        boardId: state.currentBoardId,
        x: 0,
        y: 0,
        title: 'A',
        content: '当前看板',
        color: '#FFFFFF',
        z: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      noteB: {
        id: 'noteB',
        kind: 'text',
        boardId: state.currentBoardId,
        x: 0,
        y: 0,
        title: 'B',
        content: '废纸篓',
        color: '#FFFFFF',
        z: 2,
        createdAt: 2,
        updatedAt: 2,
        deletedAt: 3,
      },
    };
    state.allNoteIds = ['noteA', 'noteB'];
    state.boardNoteIds = { [state.currentBoardId]: ['noteA', 'noteB'] };

    expect(domainSelectors.currentBoard(state)?.id).toBe(state.currentBoardId);
    expect(domainSelectors.noteById(state, 'noteA')?.title).toBe('A');
    expect(domainSelectors.currentBoardNotes(state).map((note) => note.id)).toEqual(['noteA']);
    expect(domainSelectors.trashNotes(state).map((note) => note.id)).toEqual(['noteB']);
  });
});

describe('domainStore Domain 写入动作', () => {
  beforeEach(() => {
    setDomainPersistenceBridge(null);
    resetDomainStore();
  });

  afterEach(() => {
    setDomainPersistenceBridge(null);
  });

  it('新增、编辑、移动、软删除与还原便签时同步维护 normalized 与 layout 状态', () => {
    const bridge = vi.fn();
    setDomainPersistenceBridge(bridge);

    const noteId = useDomainStore.getState().addNote({ x: 10, y: 20, content: 'hello' });
    useDomainStore.getState().updateTitle(noteId, '标题');
    useDomainStore.getState().updateNote(noteId, '正文');
    useDomainStore.getState().moveNote(noteId, 30, 40);
    useDomainStore.getState().softDeleteNote(noteId);

    let state = useDomainStore.getState();
    expect(state.notesById[noteId]).toMatchObject({ title: '标题', content: '正文', x: 30, y: 40 });
    expect(state.notesById[noteId]?.deletedAt).toEqual(expect.any(Number));
    expect(state.layoutNotesById[noteId]).toMatchObject({ id: noteId, x: 30, y: 40, deletedAt: expect.any(Number) });
    expect(domainSelectors.currentBoardNotes(state).map((note) => note.id)).toEqual([]);
    expect(domainSelectors.trashNotes(state).map((note) => note.id)).toEqual([noteId]);

    useDomainStore.getState().restoreNote(noteId);
    state = useDomainStore.getState();
    expect(state.notesById[noteId]?.deletedAt).toBeNull();
    expect(state.layoutNotesById[noteId]?.deletedAt).toBeNull();
    expect(domainSelectors.currentBoardNotes(state).map((note) => note.id)).toEqual([noteId]);
    expect(bridge).toHaveBeenCalledTimes(6);
  });

  it('永久删除便签时同步清理 allNoteIds、boardNoteIds 与 layoutNotesById', () => {
    const noteId = useDomainStore.getState().addNote({ x: 0, y: 0 });

    useDomainStore.getState().deleteNotePermanently(noteId);
    const state = useDomainStore.getState();

    expect(state.notesById[noteId]).toBeUndefined();
    expect(state.allNoteIds).not.toContain(noteId);
    expect(state.boardNoteIds[state.currentBoardId] ?? []).not.toContain(noteId);
    expect(state.layoutNotesById[noteId]).toBeUndefined();
  });

  it('看板动作只修改 Domain 状态，并在删除看板时删除看板内便签', () => {
    const boardId = useDomainStore.getState().createBoard('第二看板', '🚀');
    const noteId = useDomainStore.getState().addNote({ x: 0, y: 0, boardId });

    useDomainStore.getState().updateBoard(boardId, { name: '重命名看板' });
    useDomainStore.getState().deleteBoard(boardId);
    const state = useDomainStore.getState();

    expect(state.boards.map((board) => board.id)).not.toContain(boardId);
    expect(state.currentBoardId).toBe(state.boards[0].id);
    expect(state.notesById[noteId]).toBeUndefined();
    expect('viewMode' in state).toBe(false);
    expect('selectedIds' in state).toBe(false);
  });

  it('批量复制和跨看板移动便签时保持 boardNoteIds 与 maxZ 一致', () => {
    const sourceId = useDomainStore.getState().addNote({ x: 10, y: 20, content: 'source' });
    const targetBoardId = useDomainStore.getState().createBoard('目标看板', '📚');

    const copiedIds = useDomainStore.getState().copyNotesToBoard([sourceId], targetBoardId);
    useDomainStore.getState().moveNotesToBoard([sourceId], targetBoardId);
    const state = useDomainStore.getState();

    expect(copiedIds).toHaveLength(1);
    expect(state.notesById[sourceId]?.boardId).toBe(targetBoardId);
    expect(state.notesById[copiedIds[0]]?.boardId).toBe(targetBoardId);
    expect(state.boardNoteIds[targetBoardId]).toEqual(expect.arrayContaining([sourceId, copiedIds[0]]));
    expect(state.config.maxZ).toBeGreaterThanOrEqual(3);
  });
});
