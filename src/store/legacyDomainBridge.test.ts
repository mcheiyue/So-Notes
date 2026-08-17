import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachLegacyDomainBridge, detachLegacyDomainBridge } from './legacyDomainBridge';
import { createInitialDomainState, useDomainStore } from './domainStore';
import { useStore } from './useStore';
import { Board, DEFAULT_CONFIG, Note } from './types';

const resetStores = (options: { reattachBridge?: boolean } = {}) => {
  detachLegacyDomainBridge();
  useStore.setState(useStore.getInitialState(), true);
  useDomainStore.setState({
    replaceDomainState: useDomainStore.getInitialState().replaceDomainState,
  });
  useDomainStore.getState().replaceDomainState(createInitialDomainState());

  if (options.reattachBridge) {
    attachLegacyDomainBridge();
  }
};

const seedSingleNote = (note: Note) => {
  useStore.setState({
    notesById: { [note.id]: note },
    allNoteIds: [note.id],
    boardNoteIds: { [note.boardId]: [note.id] },
    layoutNotesById: {
      [note.id]: {
        id: note.id,
        boardId: note.boardId,
        x: note.x,
        y: note.y,
        color: note.color,
        deletedAt: note.deletedAt ?? null,
      },
    },
    config: { ...DEFAULT_CONFIG, maxZ: note.z },
  });
};

const spyReplaceDomainState = () => {
  const replaceSpy = vi.fn(useDomainStore.getState().replaceDomainState);
  useDomainStore.setState({ replaceDomainState: replaceSpy });
  return replaceSpy;
};

describe('legacyDomainBridge', () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('P0-07 单 note moveNote 不触发全表 replaceDomainState', () => {
    const note: Note = {
      id: 'note-p007-move',
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

    seedSingleNote(note);
    attachLegacyDomainBridge();
    const replaceSpy = spyReplaceDomainState();

    useStore.getState().moveNote(note.id, 100, 200);
    useStore.getState().moveNote(note.id, 110, 210);
    useStore.getState().moveNote(note.id, 120, 220);

    expect(replaceSpy).toHaveBeenCalledTimes(0);
    expect(useDomainStore.getState().notesById[note.id]).toMatchObject({ x: 120, y: 220 });
  });

  it('P0-07 单 note 内容更新不触发全表 replaceDomainState', () => {
    const note: Note = {
      id: 'note-p007-content',
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

    seedSingleNote(note);
    attachLegacyDomainBridge();
    const replaceSpy = spyReplaceDomainState();

    useStore.getState().updateNote(note.id, '第一版');
    useStore.getState().updateTitle(note.id, '新标题');
    useStore.getState().updateNote(note.id, '最终正文');

    expect(replaceSpy).toHaveBeenCalledTimes(0);
    expect(useDomainStore.getState().notesById[note.id]).toMatchObject({
      title: '新标题',
      content: '最终正文',
    });
  });
});
