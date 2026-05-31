import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
}));

vi.mock('../store/db', () => ({
  db: {
    saveWAL: vi.fn(async () => undefined),
    loadWAL: vi.fn(async () => undefined),
    clearWAL: vi.fn(async () => undefined),
  },
}));

vi.mock('../utils/fileSystem', () => ({
  saveFile: vi.fn(async () => true),
  openFile: vi.fn(async () => null),
}));

import { appController } from './appController';
import { useStore } from '../store/useStore';
import { normalizeNotes } from '../store/normalization';
import { LAYOUT } from '../constants/layout';
import type { Note } from '../store/types';

const createNote = (overrides: Partial<Note> = {}): Note => ({
  id: 'note-1',
  boardId: 'default',
  x: 120,
  y: 160,
  title: '测试标题',
  content: '测试内容',
  color: '#FFFFFF',
  z: 1,
  collapsed: false,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

describe('appController first-tier intents', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0, viewport: { x: 0, y: 0 } }],
      currentBoardId: 'default',
      ...normalizeNotes([
        createNote({ id: 'n1', x: 10, y: 20 }),
        createNote({ id: 'n2', x: 30, y: 40 }),
        createNote({ id: 'n3', x: 50, y: 60, boardId: 'default' }),
      ]),
      viewport: { x: 0, y: 0, w: 320, h: 240 },
    });
  });

  it('selectAllNotes 选中当前看板全部便签', () => {
    useStore.setState({ selectedIds: [] });
    appController.selectAllNotes();
    const { selectedIds } = useStore.getState();
    expect(selectedIds).toHaveLength(3);
    expect(selectedIds).toContain('n1');
    expect(selectedIds).toContain('n2');
    expect(selectedIds).toContain('n3');
  });

  it('deleteSelectedNotes 软删除选中便签并清空选区', () => {
    useStore.setState({ selectedIds: ['n1', 'n2'] });
    appController.deleteSelectedNotes();
    const state = useStore.getState();
    expect(state.selectedIds).toEqual([]);
    expect(state.notesById['n1'].deletedAt).toBeDefined();
    expect(state.notesById['n2'].deletedAt).toBeDefined();
    expect(state.notesById['n3'].deletedAt).toBeUndefined();
  });

  it('deleteSelectedNotes 无选中时不做任何变更', () => {
    useStore.setState({ selectedIds: [] });
    appController.deleteSelectedNotes();
    const state = useStore.getState();
    expect(state.notesById['n1'].deletedAt).toBeUndefined();
  });

  it('duplicateSelectedNotes 复制选中便签并更新选区到新便签', () => {
    useStore.setState({ selectedIds: ['n1'] });
    appController.duplicateSelectedNotes();
    const state = useStore.getState();
    expect(state.selectedIds).toHaveLength(1);
    expect(state.selectedIds[0]).not.toBe('n1');
    const newNote = state.notesById[state.selectedIds[0]];
    expect(newNote).toBeDefined();
    expect(newNote.content).toBe('测试内容');
    expect(newNote.x).toBe(30);
    expect(newNote.y).toBe(40);
  });

  it('duplicateSelectedNotes 无选中时不做任何变更', () => {
    const before = useStore.getState().allNoteIds.length;
    useStore.setState({ selectedIds: [] });
    appController.duplicateSelectedNotes();
    expect(useStore.getState().allNoteIds).toHaveLength(before);
  });

  it('resetViewport 将视口重置到原点', () => {
    useStore.setState({ viewport: { x: 500, y: 300, w: 800, h: 600 } });
    appController.resetViewport();
    const { viewport } = useStore.getState();
    expect(viewport.x).toBe(0);
    expect(viewport.y).toBe(0);
  });

  it('openSpotlight 设置 isSpotlightOpen 为 true', () => {
    useStore.setState({ isSpotlightOpen: false });
    appController.openSpotlight();
    expect(useStore.getState().isSpotlightOpen).toBe(true);
  });

  it('closeSpotlight 设置 isSpotlightOpen 为 false', () => {
    useStore.setState({ isSpotlightOpen: true });
    appController.closeSpotlight();
    expect(useStore.getState().isSpotlightOpen).toBe(false);
  });

  it('toggleSpotlight 切换 isSpotlightOpen 状态', () => {
    useStore.setState({ isSpotlightOpen: false });
    appController.toggleSpotlight();
    expect(useStore.getState().isSpotlightOpen).toBe(true);
    appController.toggleSpotlight();
    expect(useStore.getState().isSpotlightOpen).toBe(false);
  });

  it('setViewMode 设置视图模式', () => {
    useStore.setState({ viewMode: 'BOARD' });
    appController.setViewMode('TRASH');
    expect(useStore.getState().viewMode).toBe('TRASH');
    appController.setViewMode('BOARD');
    expect(useStore.getState().viewMode).toBe('BOARD');
  });

  it('toggleViewMode 切换视图模式并清空选区', () => {
    useStore.setState({ viewMode: 'BOARD', selectedIds: ['n1'] });
    appController.toggleViewMode();
    const state = useStore.getState();
    expect(state.viewMode).toBe('TRASH');
    expect(state.selectedIds).toEqual([]);
  });

  it('enterTrashMode 进入废纸篓模式', () => {
    useStore.setState({ viewMode: 'BOARD', selectedIds: ['n1'] });
    appController.enterTrashMode();
    const state = useStore.getState();
    expect(state.viewMode).toBe('TRASH');
    expect(state.selectedIds).toEqual([]);
  });

  it('enterBoardMode 进入看板模式', () => {
    useStore.setState({ viewMode: 'TRASH', selectedIds: ['n1'] });
    appController.enterBoardMode();
    const state = useStore.getState();
    expect(state.viewMode).toBe('BOARD');
    expect(state.selectedIds).toEqual([]);
  });

  it('switchBoard 切换看板、回到看板视图并清空选区', () => {
    useStore.setState({
      boards: [
        { id: 'default', name: '主板', icon: '📌', createdAt: 0, viewport: { x: 0, y: 0 } },
        { id: 'board-2', name: '二号板', icon: '🧭', createdAt: 1, viewport: { x: 0, y: 0 } },
      ],
      viewMode: 'TRASH',
      selectedIds: ['n1'],
    });

    appController.switchBoard('board-2');

    const state = useStore.getState();
    expect(state.currentBoardId).toBe('board-2');
    expect(state.viewMode).toBe('BOARD');
    expect(state.selectedIds).toEqual([]);
  });

  it('syncShellViewport 同步视口尺寸与 Shell 矩形', () => {
    appController.syncShellViewport({ left: 10, top: 20, right: 650, bottom: 500, width: 640, height: 480 });

    const { viewport, shellRect } = useStore.getState();
    expect(viewport.w).toBe(640);
    expect(viewport.h).toBe(480);
    expect(shellRect).toEqual({ left: 10, top: 20, right: 650, bottom: 500 });
  });

  it('setPinned 同步钉住状态', () => {
    appController.setPinned(true);
    expect(useStore.getState().isPinned).toBe(true);
    appController.setPinned(false);
    expect(useStore.getState().isPinned).toBe(false);
  });

  it('菜单意图包装可修改单个便签颜色并复制便签', () => {
    appController.changeNoteColor('n1', '#D1FAE5');
    expect(useStore.getState().notesById.n1.color).toBe('#D1FAE5');

    const before = useStore.getState().allNoteIds.length;
    appController.duplicateNote('n1');
    const state = useStore.getState();
    expect(state.allNoteIds).toHaveLength(before + 1);
    const copiedNoteId = state.allNoteIds.find((id) => id !== 'n1' && state.notesById[id].content === '测试内容' && state.notesById[id].x === 30);
    expect(copiedNoteId).toBeDefined();
  });

  it('bringNoteToFront 置顶并刷新便签更新时间', () => {
    useStore.setState({ config: { ...useStore.getState().config, maxZ: 5 } });
    const beforeUpdatedAt = useStore.getState().notesById.n1.updatedAt;

    appController.bringNoteToFront('n1');

    const note = useStore.getState().notesById.n1;
    expect(note.z).toBe(6);
    expect(note.updatedAt).toBeGreaterThanOrEqual(beforeUpdatedAt);
  });
});

describe('appController locateAndSelectNote', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      boards: [
        { id: 'default', name: '主板', icon: '📌', createdAt: 0, viewport: { x: 0, y: 0 } },
        { id: 'board-2', name: '二号板', icon: '🧭', createdAt: 1, viewport: { x: 0, y: 0 } },
      ],
      currentBoardId: 'default',
      ...normalizeNotes([
        createNote({ id: 'note-local', x: 100, y: 200 }),
        createNote({ id: 'note-remote', boardId: 'board-2', x: 400, y: 300 }),
        createNote({ id: 'note-collapsed', x: 50, y: 50, collapsed: true }),
      ]),
      viewport: { x: 0, y: 0, w: 320, h: 240 },
    });
  });

  it('同看板正常便签：关闭 Spotlight → 居中视口 → 选中 → 置顶 → 高亮', () => {
    useStore.setState({ isSpotlightOpen: true });
    const note = useStore.getState().notesById['note-local'];

    appController.locateAndSelectNote(note);

    const state = useStore.getState();
    expect(state.isSpotlightOpen).toBe(false);
    expect(state.currentBoardId).toBe('default');

    const nWidth = LAYOUT.NOTE_WIDTH;
    const nHeight = LAYOUT.NOTE_MIN_HEIGHT;
    expect(state.viewport.x).toBe(100 + nWidth / 2 - 160);
    expect(state.viewport.y).toBe(200 + nHeight / 2 - 120);
    expect(state.selectedIds).toEqual(['note-local']);
    expect(state.noteHighlights['note-local']?.reason).toBe('located');
  });

  it('跨看板便签：先切换看板再定位', () => {
    useStore.setState({ isSpotlightOpen: true });
    const note = useStore.getState().notesById['note-remote'];

    appController.locateAndSelectNote(note);

    const state = useStore.getState();
    expect(state.isSpotlightOpen).toBe(false);
    expect(state.currentBoardId).toBe('board-2');

    const nWidth = LAYOUT.NOTE_WIDTH;
    const nHeight = LAYOUT.NOTE_MIN_HEIGHT;
    expect(state.viewport.x).toBe(400 + nWidth / 2 - 160);
    expect(state.viewport.y).toBe(300 + nHeight / 2 - 120);
    expect(state.selectedIds).toEqual(['note-remote']);
    expect(state.noteHighlights['note-remote']?.reason).toBe('located');
  });

  it('折叠便签：先展开再定位', () => {
    useStore.setState({ isSpotlightOpen: true });
    const note = useStore.getState().notesById['note-collapsed'];

    appController.locateAndSelectNote(note);

    const state = useStore.getState();
    expect(state.notesById['note-collapsed'].collapsed).toBe(false);
    expect(state.selectedIds).toEqual(['note-collapsed']);
    expect(state.noteHighlights['note-collapsed']?.reason).toBe('located');
    expect(state.domainHistory.undoStack).toHaveLength(0);
  });

  it('已删除便签：不执行定位', () => {
    useStore.setState({
      isSpotlightOpen: true,
      ...normalizeNotes([
        createNote({ id: 'deleted-note', x: 100, y: 200, deletedAt: Date.now() }),
      ]),
    });
    const note = { ...createNote({ id: 'deleted-note', x: 100, y: 200 }), deletedAt: Date.now() };

    appController.locateAndSelectNote(note);

    const state = useStore.getState();
    expect(state.selectedIds).toEqual([]);
    expect(state.noteHighlights['deleted-note']).toBeUndefined();
  });
});
