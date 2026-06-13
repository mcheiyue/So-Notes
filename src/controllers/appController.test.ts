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

vi.mock('../utils/noteElementRegistry', () => {
  const mockGetNoteElement = vi.fn(() => document.createElement('div'));
  return {
    getNoteElement: mockGetNoteElement,
    registerNoteElement: vi.fn(),
    unregisterNoteElement: vi.fn(),
  };
});

import { appController } from './appController';
import { useStore } from '../store/useStore';
import { useUIStore, createInitialUIState } from '../store/uiStore';
import { useViewportStore } from '../store/viewportStore';
import { normalizeNotes } from '../store/normalization';
import { LAYOUT } from '../constants/layout';
import type { Note } from '../store/types';
import { getNoteElement } from '../utils/noteElementRegistry';
import { invoke } from '@tauri-apps/api/core';

const createNote = (overrides: Partial<Note> = {}): Note => ({
  id: 'note-1',
  kind: 'text',
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
    useUIStore.getState().replaceUIState(createInitialUIState());
    const s = useStore.getState();
    useViewportStore.setState({
      viewport: { ...s.viewport },
      shellRect: { ...s.shellRect },
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
    useViewportStore.setState({ viewport: { x: 500, y: 300, w: 800, h: 600 } });
    appController.resetViewport();
    const { viewport } = useStore.getState();
    expect(viewport.x).toBe(0);
    expect(viewport.y).toBe(0);
    expect(useViewportStore.getState().viewport.x).toBe(0);
    expect(useViewportStore.getState().viewport.y).toBe(0);
  });

  it('openSpotlight 设置 isSpotlightOpen 为 true', () => {
    useStore.setState({ isSpotlightOpen: false });
    useUIStore.setState({ isSpotlightOpen: false });
    appController.openSpotlight();
    expect(useStore.getState().isSpotlightOpen).toBe(true);
    expect(useUIStore.getState().isSpotlightOpen).toBe(true);
  });

  it('closeSpotlight 设置 isSpotlightOpen 为 false', () => {
    useStore.setState({ isSpotlightOpen: true });
    useUIStore.setState({ isSpotlightOpen: true });
    appController.closeSpotlight();
    expect(useStore.getState().isSpotlightOpen).toBe(false);
    expect(useUIStore.getState().isSpotlightOpen).toBe(false);
  });

  it('toggleSpotlight 切换 isSpotlightOpen 状态', () => {
    useStore.setState({ isSpotlightOpen: false });
    useUIStore.setState({ isSpotlightOpen: false });
    appController.toggleSpotlight();
    expect(useStore.getState().isSpotlightOpen).toBe(true);
    expect(useUIStore.getState().isSpotlightOpen).toBe(true);
    appController.toggleSpotlight();
    expect(useStore.getState().isSpotlightOpen).toBe(false);
    expect(useUIStore.getState().isSpotlightOpen).toBe(false);
  });

  it('openQuickCapture 同步更新 useUIStore 与 legacy useStore 的 isQuickCaptureOpen', () => {
    useStore.setState({ isQuickCaptureOpen: false });
    useUIStore.setState({ isQuickCaptureOpen: false });
    appController.openQuickCapture();
    expect(useUIStore.getState().isQuickCaptureOpen).toBe(true);
    expect(useStore.getState().isQuickCaptureOpen).toBe(true);
  });

  it('openQuickCapture 在 TRASH 模式先回 BOARD 再异步打开 QuickCapture', () => {
    vi.useFakeTimers();
    useStore.setState({ viewMode: 'TRASH', selectedIds: ['n1'], isQuickCaptureOpen: false });
    useUIStore.setState({ viewMode: 'TRASH', selectedIds: ['n1'], isQuickCaptureOpen: false });

    appController.openQuickCapture();

    // 同步：切回 BOARD，清空选区
    expect(useUIStore.getState().viewMode).toBe('BOARD');
    expect(useStore.getState().viewMode).toBe('BOARD');
    expect(useUIStore.getState().selectedIds).toEqual([]);
    expect(useStore.getState().selectedIds).toEqual([]);
    // QuickCapture 尚未打开（异步）
    expect(useUIStore.getState().isQuickCaptureOpen).toBe(false);

    // flush setTimeout
    vi.advanceTimersByTime(0);

    expect(useUIStore.getState().isQuickCaptureOpen).toBe(true);
    expect(useStore.getState().isQuickCaptureOpen).toBe(true);
    vi.useRealTimers();
  });

  it('setViewMode 设置视图模式', () => {
    useStore.setState({ viewMode: 'BOARD' });
    useUIStore.setState({ viewMode: 'BOARD' });
    appController.setViewMode('TRASH');
    expect(useStore.getState().viewMode).toBe('TRASH');
    expect(useUIStore.getState().viewMode).toBe('TRASH');
    appController.setViewMode('BOARD');
    expect(useStore.getState().viewMode).toBe('BOARD');
    expect(useUIStore.getState().viewMode).toBe('BOARD');
  });

  it('toggleViewMode 切换视图模式并清空选区', () => {
    useStore.setState({ viewMode: 'BOARD', selectedIds: ['n1'] });
    useUIStore.setState({ viewMode: 'BOARD', selectedIds: ['n1'] });
    appController.toggleViewMode();
    const state = useStore.getState();
    expect(state.viewMode).toBe('TRASH');
    expect(state.selectedIds).toEqual([]);
    expect(useUIStore.getState().viewMode).toBe('TRASH');
    expect(useUIStore.getState().selectedIds).toEqual([]);
  });

  it('enterTrashMode 进入废纸篓模式', () => {
    useStore.setState({ viewMode: 'BOARD', selectedIds: ['n1'] });
    useUIStore.setState({ viewMode: 'BOARD', selectedIds: ['n1'] });
    appController.enterTrashMode();
    const state = useStore.getState();
    expect(state.viewMode).toBe('TRASH');
    expect(state.selectedIds).toEqual([]);
    expect(useUIStore.getState().viewMode).toBe('TRASH');
    expect(useUIStore.getState().selectedIds).toEqual([]);
  });

  it('enterBoardMode 进入看板模式', () => {
    useStore.setState({ viewMode: 'TRASH', selectedIds: ['n1'] });
    useUIStore.setState({ viewMode: 'TRASH', selectedIds: ['n1'] });
    appController.enterBoardMode();
    const state = useStore.getState();
    expect(state.viewMode).toBe('BOARD');
    expect(state.selectedIds).toEqual([]);
    expect(useUIStore.getState().viewMode).toBe('BOARD');
    expect(useUIStore.getState().selectedIds).toEqual([]);
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
    expect(useViewportStore.getState().viewport.w).toBe(640);
    expect(useViewportStore.getState().viewport.h).toBe(480);
    expect(useViewportStore.getState().shellRect).toEqual({ left: 10, top: 20, right: 650, bottom: 500 });
  });

  it('setPinned 同步钉住状态', () => {
    appController.setPinned(true);
    expect(useStore.getState().isPinned).toBe(true);
    expect(useUIStore.getState().isPinned).toBe(true);
    appController.setPinned(false);
    expect(useStore.getState().isPinned).toBe(false);
    expect(useUIStore.getState().isPinned).toBe(false);
  });

  it('showBoardDock 设置 isDockVisible 为 true', () => {
    useStore.setState({ isDockVisible: false });
    useUIStore.setState({ isDockVisible: false });
    appController.showBoardDock();
    expect(useStore.getState().isDockVisible).toBe(true);
    expect(useUIStore.getState().isDockVisible).toBe(true);
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

describe('appController 撕下便签方法', () => {
  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0, viewport: { x: 0, y: 0 } }],
      currentBoardId: 'default',
      ...normalizeNotes([
        createNote({ id: 'n1', x: 100, y: 200 }),
        createNote({ id: 'n2', x: 300, y: 400 }),
      ]),
      viewport: { x: 50, y: 80, w: 400, h: 300 },
    });
    useUIStore.getState().replaceUIState(createInitialUIState());
    vi.mocked(invoke).mockClear();
  });

  it('detachNote 添加一条 detachedNotes 记录', () => {
    appController.detachNote('n1');
    const detached = useUIStore.getState().detachedNotes;
    expect(detached).toHaveLength(1);
    expect(detached[0].noteId).toBe('n1');
    expect(detached[0].isPinned).toBe(false);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('open_detached_note_window', { noteId: 'n1', spawnX: 50, spawnY: 120, keepAlwaysOnTop: false });
  });

  it('detachNote 对已撕下的 Note 不重复添加但仍聚焦 Rust 窗口', () => {
    appController.detachNote('n1');
    vi.mocked(invoke).mockClear();
    appController.detachNote('n1');
    expect(useUIStore.getState().detachedNotes).toHaveLength(1);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('open_detached_note_window', { noteId: 'n1', spawnX: 50, spawnY: 120, keepAlwaysOnTop: false });
  });

  it('detachNote 不修改领域状态和 Undo 历史', () => {
    const beforeNotesById = { ...useStore.getState().notesById };
    const beforeUndoStack = [...useStore.getState().domainHistory.undoStack];
    const beforeAllNoteIds = [...useStore.getState().allNoteIds];

    appController.detachNote('n1');

    expect(useStore.getState().notesById).toEqual(beforeNotesById);
    expect(useStore.getState().domainHistory.undoStack).toEqual(beforeUndoStack);
    expect(useStore.getState().allNoteIds).toEqual(beforeAllNoteIds);
  });

  it('detachNote 对不存在的 Note 不做任何操作', () => {
    vi.mocked(invoke).mockClear();
    appController.detachNote('nonexistent');
    expect(useUIStore.getState().detachedNotes).toHaveLength(0);
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  it('detachNote 使用 note 位置与 viewport 计算初始坐标', () => {
    appController.detachNote('n1');
    const entry = useUIStore.getState().detachedNotes[0];
    expect(entry.position.x).toBe(50);
    expect(entry.position.y).toBe(120);
  });

  it('closeDetachedNote 移除对应的记录', () => {
    appController.detachNote('n1');
    appController.detachNote('n2');
    expect(useUIStore.getState().detachedNotes).toHaveLength(2);

    appController.closeDetachedNote('n1');
    expect(useUIStore.getState().detachedNotes).toHaveLength(1);
    expect(useUIStore.getState().detachedNotes[0].noteId).toBe('n2');
  });

  it('showAllDetachedNotes 恢复所有运行态撕下窗口', () => {
    appController.detachNote('n1');
    appController.detachNote('n2');
    vi.mocked(invoke).mockClear();

    appController.showAllDetachedNotes();

    expect(vi.mocked(invoke)).toHaveBeenCalledWith('show_detached_note_window', { noteId: 'n1', keepAlwaysOnTop: false });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('show_detached_note_window', { noteId: 'n2', keepAlwaysOnTop: false });
  });

  it('showAllDetachedNotes 在没有撕下窗口时不调用 Rust', () => {
    appController.showAllDetachedNotes();

    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  it('moveDetachedNote 更新指定记录的位置', () => {
    appController.detachNote('n1');
    appController.moveDetachedNote('n1', { x: 500, y: 600 });
    const entry = useUIStore.getState().detachedNotes.find((d) => d.noteId === 'n1');
    expect(entry?.position).toEqual({ x: 500, y: 600 });
  });

  it('toggleDetachedNotePin 切换指定记录的置顶状态', () => {
    appController.detachNote('n1');
    expect(useUIStore.getState().detachedNotes[0].isPinned).toBe(false);

    appController.toggleDetachedNotePin('n1');
    expect(useUIStore.getState().detachedNotes[0].isPinned).toBe(true);

    appController.toggleDetachedNotePin('n1');
    expect(useUIStore.getState().detachedNotes[0].isPinned).toBe(false);
  });

  it('detachNote 重新显示已置顶撕下窗口时保留置顶状态', () => {
    appController.detachNote('n1');
    appController.toggleDetachedNotePin('n1');
    vi.mocked(invoke).mockClear();

    appController.detachNote('n1');

    expect(vi.mocked(invoke)).toHaveBeenCalledWith('open_detached_note_window', {
      noteId: 'n1',
      spawnX: 50,
      spawnY: 120,
      keepAlwaysOnTop: true,
    });
  });

  it('detachNote 打开窗口前重新读取 addDetachedNote 后的最新置顶状态', () => {
    const originalAddDetachedNote = useUIStore.getState().addDetachedNote;
    useUIStore.setState({
      addDetachedNote: (noteId, position) => {
        originalAddDetachedNote(noteId, position);
        const { detachedNotes } = useUIStore.getState();
        useUIStore.setState({
          detachedNotes: detachedNotes.map((entry) =>
            entry.noteId === noteId ? { ...entry, isPinned: true } : entry,
          ),
        });
      },
    });

    try {
      appController.detachNote('n1');

      expect(vi.mocked(invoke)).toHaveBeenCalledWith('open_detached_note_window', {
        noteId: 'n1',
        spawnX: 50,
        spawnY: 120,
        keepAlwaysOnTop: true,
      });
    } finally {
      useUIStore.setState({ addDetachedNote: originalAddDetachedNote });
    }
  });

  it('showAllDetachedNotes 显示已置顶撕下窗口时保留置顶状态', () => {
    appController.detachNote('n1');
    appController.detachNote('n2');
    appController.toggleDetachedNotePin('n1');
    vi.mocked(invoke).mockClear();

    appController.showAllDetachedNotes();

    expect(vi.mocked(invoke)).toHaveBeenCalledWith('show_detached_note_window', { noteId: 'n1', keepAlwaysOnTop: true });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('show_detached_note_window', { noteId: 'n2', keepAlwaysOnTop: false });
  });

  it('focusDetachedNote 将目标撕下视图移动到活跃栈末尾', () => {
    appController.detachNote('n1');
    appController.detachNote('n2');

    appController.focusDetachedNote('n1');

    expect(useUIStore.getState().detachedNotes.map((d) => d.noteId)).toEqual(['n2', 'n1']);
  });

  it('多个 Note 可以同时撕下且互不干扰', () => {
    appController.detachNote('n1');
    appController.detachNote('n2');
    expect(useUIStore.getState().detachedNotes).toHaveLength(2);

    appController.toggleDetachedNotePin('n1');
    appController.moveDetachedNote('n2', { x: 10, y: 20 });

    const d1 = useUIStore.getState().detachedNotes.find((d) => d.noteId === 'n1');
    const d2 = useUIStore.getState().detachedNotes.find((d) => d.noteId === 'n2');
    expect(d1?.isPinned).toBe(true);
    expect(d2?.position).toEqual({ x: 10, y: 20 });
  });
});

describe('appController locateDetachedNote', () => {
  const mockedGetNoteElement = vi.mocked(getNoteElement);

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
    useUIStore.getState().replaceUIState(createInitialUIState());
    mockedGetNoteElement.mockReturnValue(document.createElement('div'));
  });

  it('同看板便签：居中视口、选中、置顶、高亮', () => {
    useUIStore.getState().addDetachedNote('note-local', { x: 50, y: 50 });

    appController.locateDetachedNote('note-local');

    const state = useStore.getState();
    const nWidth = LAYOUT.NOTE_WIDTH;
    const nHeight = LAYOUT.NOTE_MIN_HEIGHT;
    expect(state.viewport.x).toBe(100 + nWidth / 2 - 160);
    expect(state.viewport.y).toBe(200 + nHeight / 2 - 120);
    expect(state.selectedIds).toEqual(['note-local']);
    expect(state.notesById['note-local'].z).toBeGreaterThan(1);
    expect(state.noteHighlights['note-local']?.reason).toBe('located');
  });

  it('跨看板便签：先切换看板再定位', () => {
    useUIStore.getState().addDetachedNote('note-remote', { x: 50, y: 50 });

    appController.locateDetachedNote('note-remote');

    const state = useStore.getState();
    expect(state.currentBoardId).toBe('board-2');

    const nWidth = LAYOUT.NOTE_WIDTH;
    const nHeight = LAYOUT.NOTE_MIN_HEIGHT;
    expect(state.viewport.x).toBe(400 + nWidth / 2 - 160);
    expect(state.viewport.y).toBe(300 + nHeight / 2 - 120);
    expect(state.selectedIds).toEqual(['note-remote']);
    expect(state.noteHighlights['note-remote']?.reason).toBe('located');
  });

  it('从 TRASH 切换到 BOARD 再定位', () => {
    useUIStore.getState().addDetachedNote('note-local', { x: 50, y: 50 });
    useStore.setState({ viewMode: 'TRASH' });
    useUIStore.setState({ viewMode: 'TRASH' });

    appController.locateDetachedNote('note-local');

    const state = useStore.getState();
    expect(state.viewMode).toBe('BOARD');
    expect(state.selectedIds).toEqual(['note-local']);
    expect(state.noteHighlights['note-local']?.reason).toBe('located');
  });

  it('折叠便签：先展开再定位', () => {
    useUIStore.getState().addDetachedNote('note-collapsed', { x: 50, y: 50 });

    appController.locateDetachedNote('note-collapsed');

    const state = useStore.getState();
    expect(state.notesById['note-collapsed'].collapsed).toBe(false);
    expect(state.selectedIds).toEqual(['note-collapsed']);
    expect(state.noteHighlights['note-collapsed']?.reason).toBe('located');
    expect(state.domainHistory.undoStack).toHaveLength(0);
  });

  it('不存在的便签：静默无操作', () => {
    appController.locateDetachedNote('nonexistent');

    const state = useStore.getState();
    expect(state.selectedIds).toEqual([]);
    expect(state.viewport.x).toBe(0);
    expect(state.viewport.y).toBe(0);
  });

  it('已删除便签：静默无操作', () => {
    useStore.setState({
      ...normalizeNotes([
        createNote({ id: 'deleted-note', x: 100, y: 200, deletedAt: Date.now() }),
      ]),
    });
    useUIStore.getState().addDetachedNote('deleted-note', { x: 50, y: 50 });

    appController.locateDetachedNote('deleted-note');

    const state = useStore.getState();
    expect(state.selectedIds).toEqual([]);
    expect(state.noteHighlights['deleted-note']).toBeUndefined();
  });

  it('撕下记录不存在时静默无操作', () => {
    appController.locateDetachedNote('note-local');

    const state = useStore.getState();
    expect(state.selectedIds).toEqual([]);
    expect(state.noteHighlights['note-local']).toBeUndefined();
  });

  it('DOM 未就绪超时后静默退出', () => {
    mockedGetNoteElement.mockReturnValue(undefined);
    useUIStore.getState().addDetachedNote('note-local', { x: 50, y: 50 });

    const rAFCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => {
      rAFCallbacks.push(cb);
      return rAFCallbacks.length;
    }));

    appController.locateDetachedNote('note-local');

    for (let i = 0; i < 5; i++) {
      if (rAFCallbacks.length > 0) {
        const cb = rAFCallbacks.shift()!;
        cb(0);
      }
    }

    const state = useStore.getState();
    expect(state.selectedIds).toEqual([]);
    expect(state.noteHighlights['note-local']).toBeUndefined();
  });

  it('DOM 就绪后重新检查便签有效性', () => {
    useUIStore.getState().addDetachedNote('note-local', { x: 50, y: 50 });
    useStore.setState({
      ...normalizeNotes([
        createNote({ id: 'note-local', x: 100, y: 200, deletedAt: Date.now() }),
      ]),
    });

    appController.locateDetachedNote('note-local');

    const state = useStore.getState();
    expect(state.selectedIds).toEqual([]);
    expect(state.noteHighlights['note-local']).toBeUndefined();
  });
});
