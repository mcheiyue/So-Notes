import { describe, expect, it } from 'vitest';
import { createInitialDomainState, domainSelectors } from './domainStore';

describe('domainStore 只读骨架', () => {
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
