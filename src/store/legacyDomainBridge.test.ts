import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachLegacyDomainBridge, detachLegacyDomainBridge } from './legacyDomainBridge';
import { createInitialDomainState, useDomainStore } from './domainStore';
import { useStore } from './useStore';
import { Board, DEFAULT_CONFIG, Note } from './types';

const resetStores = (options: { reattachBridge?: boolean } = {}) => {
  detachLegacyDomainBridge();
  useStore.setState(useStore.getInitialState(), true);
  useDomainStore.getState().replaceDomainState(createInitialDomainState());

  if (options.reattachBridge) {
    attachLegacyDomainBridge();
  }
};

describe('legacyDomainBridge', () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    resetStores({ reattachBridge: true });
  });

  it('挂载时将旧 useStore 的 Domain 快照同步到 domainStore', () => {
    const note: Note = {
      id: 'note-a',
      kind: 'text',
      boardId: 'default',
      x: 10,
      y: 20,
      title: '标题',
      content: '正文',
      color: '#FFFFFF',
      z: 3,
      createdAt: 1,
      updatedAt: 2,
    };

    useStore.setState({
      notesById: { [note.id]: note },
      allNoteIds: [note.id],
      boardNoteIds: { default: [note.id] },
      layoutNotesById: {
        [note.id]: {
          id: note.id,
          boardId: note.boardId,
          x: note.x,
          y: note.y,
          color: note.color,
          deletedAt: null,
        },
      },
      config: { ...DEFAULT_CONFIG, maxZ: 3 },
    });

    attachLegacyDomainBridge();

    const domainState = useDomainStore.getState();
    expect(domainState.notesById[note.id]).toMatchObject({ title: '标题', content: '正文' });
    expect(domainState.allNoteIds).toEqual([note.id]);
    expect(domainState.boardNoteIds.default).toEqual([note.id]);
    expect(domainState.layoutNotesById[note.id]).toMatchObject({ x: 10, y: 20 });
    expect(domainState.config.maxZ).toBe(3);
  });

  it('旧 useStore 的 Domain 引用变化时刷新 domainStore 镜像', () => {
    const secondBoard: Board = {
      id: 'board-2',
      name: '第二看板',
      icon: '🚀',
      createdAt: 10,
    };

    attachLegacyDomainBridge();
    useStore.setState({
      boards: [useStore.getState().boards[0], secondBoard],
      currentBoardId: secondBoard.id,
    });

    const domainState = useDomainStore.getState();
    expect(domainState.boards.map((board) => board.id)).toContain(secondBoard.id);
    expect(domainState.currentBoardId).toBe(secondBoard.id);
  });

  it('旧 useStore 只有 UI 状态变化时不刷新 Domain 镜像引用', () => {
    attachLegacyDomainBridge();
    const beforeNotesById = useDomainStore.getState().notesById;

    useStore.setState({ selectedIds: ['note-ui-only'] });

    expect(useDomainStore.getState().notesById).toBe(beforeNotesById);
  });
});
