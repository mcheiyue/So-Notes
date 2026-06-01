import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
}));

vi.mock('./db', () => ({
  db: {
    saveWAL: vi.fn(async () => true),
    loadWAL: vi.fn(async () => undefined),
    clearWAL: vi.fn(async () => undefined),
  },
}));

vi.mock('../utils/fileSystem', () => ({
  saveFile: vi.fn(async () => true),
  openFile: vi.fn(async () => null),
}));

import { createInitialUIState, useUIStore, uiSelectors } from './uiStore';
import { useStore } from './useStore';
import { createEmptyNormalizedNotesState } from './normalization';

const resetUIStore = () => {
  useUIStore.getState().replaceUIState(createInitialUIState());
};

describe('uiStore 初始状态与 selector', () => {
  beforeEach(() => {
    resetUIStore();
  });

  it('提供默认 UI 状态，不包含 Domain 与 Viewport 状态', () => {
    const state = createInitialUIState();

    expect(state.viewMode).toBe('BOARD');
    expect(state.selectedIds).toEqual([]);
    expect(state.contextMenu).toEqual({ isOpen: false, x: 0, y: 0, type: 'CANVAS' });
    expect(state.isDockVisible).toBe(false);
    expect(state.isSpotlightOpen).toBe(false);
    expect(state.isQuickCaptureOpen).toBe(false);
    expect(state.smartPasteSplitPanel).toBeNull();
    expect(state.recentlyCreatedIds).toEqual([]);
    expect(state.noteHighlights).toEqual({});
    expect(state.isPinned).toBe(false);
    expect('notesById' in state).toBe(false);
    expect('viewport' in state).toBe(false);
    expect('canvas' in state).toBe(false);
  });

  it('uiSelectors 能正确读取各子状态', () => {
    const state = createInitialUIState();

    expect(uiSelectors.viewMode(state)).toBe('BOARD');
    expect(uiSelectors.selectedIds(state)).toEqual([]);
    expect(uiSelectors.contextMenu(state)).toEqual({ isOpen: false, x: 0, y: 0, type: 'CANVAS' });
    expect(uiSelectors.isDockVisible(state)).toBe(false);
    expect(uiSelectors.isSpotlightOpen(state)).toBe(false);
    expect(uiSelectors.isQuickCaptureOpen(state)).toBe(false);
    expect(uiSelectors.smartPasteSplitPanel(state)).toBeNull();
    expect(uiSelectors.recentlyCreatedIds(state)).toEqual([]);
    expect(uiSelectors.noteHighlights(state)).toEqual({});
    expect(uiSelectors.isPinned(state)).toBe(false);
  });
});

describe('uiStore 纯 UI actions', () => {
  beforeEach(() => {
    resetUIStore();
  });

  it('setViewMode 更新 viewMode 并清空 selectedIds', () => {
    useUIStore.getState().setSelectedIds(['a', 'b']);
    useUIStore.getState().setViewMode('TRASH');

    expect(useUIStore.getState().viewMode).toBe('TRASH');
    expect(useUIStore.getState().selectedIds).toEqual([]);
  });

  it('setSelectedIds / toggleSelection / clearSelection 正确管理选区', () => {
    useUIStore.getState().setSelectedIds(['a', 'b', 'c']);
    expect(useUIStore.getState().selectedIds).toEqual(['a', 'b', 'c']);

    useUIStore.getState().toggleSelection('b');
    expect(useUIStore.getState().selectedIds).toEqual(['a', 'c']);

    useUIStore.getState().toggleSelection('d');
    expect(useUIStore.getState().selectedIds).toEqual(['a', 'c', 'd']);

    useUIStore.getState().clearSelection();
    expect(useUIStore.getState().selectedIds).toEqual([]);
  });

  it('setContextMenu 更新右键菜单状态', () => {
    const menu = { isOpen: true, x: 100, y: 200, type: 'NOTE' as const, targetId: 'note-1' };
    useUIStore.getState().setContextMenu(menu);

    expect(useUIStore.getState().contextMenu).toEqual(menu);
  });

  it('setDockVisible 切换 Dock 显隐', () => {
    useUIStore.getState().setDockVisible(true);
    expect(useUIStore.getState().isDockVisible).toBe(true);

    useUIStore.getState().setDockVisible(false);
    expect(useUIStore.getState().isDockVisible).toBe(false);
  });

  it('setSpotlightOpen / setQuickCaptureOpen 切换浮层', () => {
    useUIStore.getState().setSpotlightOpen(true);
    expect(useUIStore.getState().isSpotlightOpen).toBe(true);

    useUIStore.getState().setQuickCaptureOpen(true);
    expect(useUIStore.getState().isQuickCaptureOpen).toBe(true);

    useUIStore.getState().setSpotlightOpen(false);
    expect(useUIStore.getState().isSpotlightOpen).toBe(false);
  });

  it('openSmartPasteSplitPanel / closeSmartPasteSplitPanel 管理拆分面板', () => {
    const panel = {
      noteId: 'note-1',
      result: { kind: 'lines' as const, source: 'text', options: [{ id: 'split-lines' as const, label: '按行拆分', contents: ['a', 'b'] }] },
    };
    useUIStore.getState().openSmartPasteSplitPanel(panel);
    expect(useUIStore.getState().smartPasteSplitPanel).toEqual(panel);

    useUIStore.getState().closeSmartPasteSplitPanel();
    expect(useUIStore.getState().smartPasteSplitPanel).toBeNull();
  });

  it('setPinned 切换钉住状态', () => {
    useUIStore.getState().setPinned(true);
    expect(useUIStore.getState().isPinned).toBe(true);

    useUIStore.getState().setPinned(false);
    expect(useUIStore.getState().isPinned).toBe(false);
  });

  it('replaceUIState 替换整个 UI 状态', () => {
    const newState = createInitialUIState();
    newState.isDockVisible = true;
    newState.viewMode = 'TRASH';
    newState.selectedIds = ['x'];

    useUIStore.getState().replaceUIState(newState);

    expect(useUIStore.getState().isDockVisible).toBe(true);
    expect(useUIStore.getState().viewMode).toBe('TRASH');
    expect(useUIStore.getState().selectedIds).toEqual(['x']);
  });
});

describe('uiStore 定时器可控 actions', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    resetUIStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('markRecentlyCreated 设置标记并调度过期清理', () => {
    useUIStore.getState().markRecentlyCreated(['note-1', 'note-2']);
    expect(useUIStore.getState().recentlyCreatedIds).toEqual(['note-1', 'note-2']);
    expect(useUIStore.getState().noteHighlights['note-1']?.reason).toBe('created');
    expect(useUIStore.getState().noteHighlights['note-2']?.reason).toBe('created');

    vi.advanceTimersByTime(900);

    expect(useUIStore.getState().recentlyCreatedIds).toEqual([]);
    expect(useUIStore.getState().noteHighlights['note-1']).toBeUndefined();
    expect(useUIStore.getState().noteHighlights['note-2']).toBeUndefined();
  });

  it('clearRecentlyCreated 只移除指定标记', () => {
    useUIStore.getState().markRecentlyCreated(['a', 'b']);
    useUIStore.getState().clearRecentlyCreated('a');

    expect(useUIStore.getState().recentlyCreatedIds).toEqual(['b']);
  });

  it('markNoteHighlights 按 reason 设置高亮并按时过期', () => {
    useUIStore.getState().markNoteHighlights(['note-1'], 'located');
    expect(useUIStore.getState().noteHighlights['note-1']?.reason).toBe('located');

    vi.advanceTimersByTime(1100);
    expect(useUIStore.getState().noteHighlights['note-1']).toBeUndefined();
  });

  it('markNoteHighlights edited 高亮按 900ms 过期', () => {
    useUIStore.getState().markNoteHighlights(['note-1'], 'edited');
    expect(useUIStore.getState().noteHighlights['note-1']?.reason).toBe('edited');

    vi.advanceTimersByTime(900);
    expect(useUIStore.getState().noteHighlights['note-1']).toBeUndefined();
  });

  it('clearNoteHighlight 按 token 精确清理，不清新高亮', () => {
    vi.setSystemTime(new Date('2026-03-19T10:20:00.000Z'));
    useUIStore.getState().markNoteHighlights(['note-1'], 'located');
    const first = useUIStore.getState().noteHighlights['note-1'];

    vi.setSystemTime(new Date('2026-03-19T10:20:01.000Z'));
    useUIStore.getState().markNoteHighlights(['note-1'], 'edited');
    const second = useUIStore.getState().noteHighlights['note-1'];

    expect(first?.token).not.toBe(second?.token);

    useUIStore.getState().clearNoteHighlight('note-1', first?.token);
    expect(useUIStore.getState().noteHighlights['note-1']).toEqual(second);

    useUIStore.getState().clearNoteHighlight('note-1', second?.token);
    expect(useUIStore.getState().noteHighlights['note-1']).toBeUndefined();
  });
});

describe('uiStore 同步桥', () => {
  beforeEach(() => {
    resetUIStore();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0 }],
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
    });
  });

  it('useStore 中 UI 状态变更会同步到 useUIStore', () => {
    useStore.setState({
      selectedIds: ['note-1', 'note-2'],
      isDockVisible: true,
      isSpotlightOpen: true,
    });

    expect(useUIStore.getState().selectedIds).toEqual(['note-1', 'note-2']);
    expect(useUIStore.getState().isDockVisible).toBe(true);
    expect(useUIStore.getState().isSpotlightOpen).toBe(true);
  });

  it('useStore 中 viewMode 变更会同步到 useUIStore', () => {
    useStore.setState({ viewMode: 'TRASH' });
    expect(useUIStore.getState().viewMode).toBe('TRASH');
  });

  it('useStore 中 contextMenu 变更会同步到 useUIStore', () => {
    useStore.setState({
      contextMenu: { isOpen: true, x: 50, y: 80, type: 'NOTE', targetId: 'note-x' },
    });

    expect(useUIStore.getState().contextMenu).toEqual({
      isOpen: true, x: 50, y: 80, type: 'NOTE', targetId: 'note-x',
    });
  });

  it('useStore 中 isPinned 变更会同步到 useUIStore', () => {
    useStore.setState({ isPinned: true });
    expect(useUIStore.getState().isPinned).toBe(true);
  });

  it('useUIStore 直接写入会通过反向同步桥同步回 useStore', () => {
    useUIStore.getState().setSelectedIds(['new-id']);
    expect(useStore.getState().selectedIds).toEqual(['new-id']);
  });

  it('useUIStore setDockVisible 通过反向桥同步回 useStore', () => {
    useUIStore.getState().setDockVisible(true);
    expect(useStore.getState().isDockVisible).toBe(true);
  });

  it('useUIStore setPinned 通过反向桥同步回 useStore', () => {
    useUIStore.getState().setPinned(true);
    expect(useStore.getState().isPinned).toBe(true);
  });
});

describe('uiStore TRASH 安全收口 UI 字段同步', () => {
  beforeEach(() => {
    resetUIStore();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0 }],
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
    });
  });

  it('useStore setViewMode(TRASH) 清理的 UI 字段同步到 useUIStore', () => {
    useStore.setState({
      selectedIds: ['note-1', 'note-2'],
      contextMenu: { isOpen: true, x: 100, y: 200, type: 'NOTE', targetId: 'note-1' },
      smartPasteSplitPanel: { noteId: 'note-1', result: { kind: 'single', source: 'text', options: [] } },
      isSpotlightOpen: true,
      isQuickCaptureOpen: true,
      isDockVisible: true,
    });

    useStore.getState().setViewMode('TRASH');

    expect(useUIStore.getState().viewMode).toBe('TRASH');
    expect(useUIStore.getState().selectedIds).toEqual([]);
    expect(useUIStore.getState().contextMenu).toEqual({ isOpen: false, x: 0, y: 0, type: 'CANVAS' });
    expect(useUIStore.getState().smartPasteSplitPanel).toBeNull();
    expect(useUIStore.getState().isSpotlightOpen).toBe(false);
    expect(useUIStore.getState().isQuickCaptureOpen).toBe(false);
    expect(useUIStore.getState().isDockVisible).toBe(false);
  });

  it('useStore setViewMode(BOARD) 只清 selectedIds，不触碰其他 UI 状态', () => {
    useStore.setState({
      viewMode: 'TRASH',
      selectedIds: ['note-1'],
      isSpotlightOpen: true,
      isQuickCaptureOpen: true,
    });

    useStore.getState().setViewMode('BOARD');

    expect(useUIStore.getState().viewMode).toBe('BOARD');
    expect(useUIStore.getState().selectedIds).toEqual([]);
    expect(useUIStore.getState().isSpotlightOpen).toBe(true);
    expect(useUIStore.getState().isQuickCaptureOpen).toBe(true);
  });
});

describe('uiStore 多选/右键菜单/Dock 兼容行为', () => {
  beforeEach(() => {
    resetUIStore();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0 }],
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
    });
  });

  it('通过 useStore 设置多选后 useUIStore 可见', () => {
    useStore.getState().setSelectedIds(['a', 'b', 'c']);

    expect(useUIStore.getState().selectedIds).toEqual(['a', 'b', 'c']);
  });

  it('通过 useStore toggleSelection 后 useUIStore 同步', () => {
    useStore.getState().setSelectedIds(['a']);
    useStore.getState().toggleSelection('b');

    expect(useUIStore.getState().selectedIds).toEqual(['a', 'b']);
  });

  it('通过 useStore clearSelection 后 useUIStore 也清空', () => {
    useStore.getState().setSelectedIds(['a', 'b']);
    useStore.getState().clearSelection();

    expect(useUIStore.getState().selectedIds).toEqual([]);
  });

  it('通过 useUIStore 设置右键菜单后 useStore 可见', () => {
    useUIStore.getState().setContextMenu({
      isOpen: true, x: 200, y: 300, type: 'CANVAS',
    });

    expect(useStore.getState().contextMenu).toEqual({
      isOpen: true, x: 200, y: 300, type: 'CANVAS',
    });
  });

  it('通过 useStore setDockVisible 后 useUIStore 同步', () => {
    useStore.getState().setDockVisible(true);
    expect(useUIStore.getState().isDockVisible).toBe(true);

    useStore.getState().setDockVisible(false);
    expect(useUIStore.getState().isDockVisible).toBe(false);
  });

  it('通过 useUIStore setDockVisible 后 useStore 同步', () => {
    useUIStore.getState().setDockVisible(true);
    expect(useStore.getState().isDockVisible).toBe(true);

    useUIStore.getState().setDockVisible(false);
    expect(useStore.getState().isDockVisible).toBe(false);
  });
});

describe('uiStore detachedNotes 状态与 actions', () => {
  beforeEach(() => {
    resetUIStore();
  });

  it('初始状态 detachedNotes 为空数组', () => {
    const state = createInitialUIState();
    expect(state.detachedNotes).toEqual([]);
    expect(uiSelectors.detachedNotes(state)).toEqual([]);
  });

  it('addDetachedNote 追加记录，同一 noteId 不重复添加', () => {
    useUIStore.getState().addDetachedNote('n1', { x: 100, y: 200 });
    expect(useUIStore.getState().detachedNotes).toEqual([
      { noteId: 'n1', position: { x: 100, y: 200 }, isPinned: false },
    ]);

    useUIStore.getState().addDetachedNote('n1', { x: 300, y: 400 });
    expect(useUIStore.getState().detachedNotes).toHaveLength(1);
    expect(useUIStore.getState().detachedNotes[0].position).toEqual({ x: 100, y: 200 });
  });

  it('addDetachedNote 支持多条记录', () => {
    useUIStore.getState().addDetachedNote('n1', { x: 10, y: 20 });
    useUIStore.getState().addDetachedNote('n2', { x: 30, y: 40 });

    expect(useUIStore.getState().detachedNotes).toHaveLength(2);
    expect(useUIStore.getState().detachedNotes[0].noteId).toBe('n1');
    expect(useUIStore.getState().detachedNotes[1].noteId).toBe('n2');
  });

  it('removeDetachedNote 移除指定记录，不影响其他记录', () => {
    useUIStore.getState().addDetachedNote('n1', { x: 10, y: 20 });
    useUIStore.getState().addDetachedNote('n2', { x: 30, y: 40 });
    useUIStore.getState().removeDetachedNote('n1');

    expect(useUIStore.getState().detachedNotes).toEqual([
      { noteId: 'n2', position: { x: 30, y: 40 }, isPinned: false },
    ]);
  });

  it('removeDetachedNote 对不存在的 noteId 无副作用', () => {
    useUIStore.getState().addDetachedNote('n1', { x: 10, y: 20 });
    useUIStore.getState().removeDetachedNote('nonexistent');

    expect(useUIStore.getState().detachedNotes).toHaveLength(1);
  });

  it('updateDetachedNotePosition 只更新指定记录的位置', () => {
    useUIStore.getState().addDetachedNote('n1', { x: 10, y: 20 });
    useUIStore.getState().addDetachedNote('n2', { x: 30, y: 40 });
    useUIStore.getState().updateDetachedNotePosition('n1', { x: 999, y: 888 });

    expect(useUIStore.getState().detachedNotes[0].position).toEqual({ x: 999, y: 888 });
    expect(useUIStore.getState().detachedNotes[1].position).toEqual({ x: 30, y: 40 });
  });

  it('updateDetachedNotePosition 对不存在的 noteId 无副作用', () => {
    useUIStore.getState().addDetachedNote('n1', { x: 10, y: 20 });
    useUIStore.getState().updateDetachedNotePosition('nonexistent', { x: 0, y: 0 });

    expect(useUIStore.getState().detachedNotes[0].position).toEqual({ x: 10, y: 20 });
  });

  it('toggleDetachedNotePin 切换 isPinned 状态', () => {
    useUIStore.getState().addDetachedNote('n1', { x: 10, y: 20 });
    expect(useUIStore.getState().detachedNotes[0].isPinned).toBe(false);

    useUIStore.getState().toggleDetachedNotePin('n1');
    expect(useUIStore.getState().detachedNotes[0].isPinned).toBe(true);

    useUIStore.getState().toggleDetachedNotePin('n1');
    expect(useUIStore.getState().detachedNotes[0].isPinned).toBe(false);
  });

  it('toggleDetachedNotePin 对不存在的 noteId 无副作用', () => {
    useUIStore.getState().addDetachedNote('n1', { x: 10, y: 20 });
    useUIStore.getState().toggleDetachedNotePin('nonexistent');

    expect(useUIStore.getState().detachedNotes[0].isPinned).toBe(false);
    expect(useUIStore.getState().detachedNotes).toHaveLength(1);
  });

  it('replaceUIState 可替换包含 detachedNotes 的完整状态', () => {
    useUIStore.getState().addDetachedNote('n1', { x: 10, y: 20 });

    const newState = createInitialUIState();
    newState.detachedNotes = [
      { noteId: 'replaced', position: { x: 50, y: 60 }, isPinned: true },
    ];
    useUIStore.getState().replaceUIState(newState);

    expect(useUIStore.getState().detachedNotes).toEqual([
      { noteId: 'replaced', position: { x: 50, y: 60 }, isPinned: true },
    ]);
  });
});

describe('uiStore detachedNotes 同步桥', () => {
  beforeEach(() => {
    resetUIStore();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0 }],
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
    });
  });

  it('useUIStore detachedNotes 变更同步到 useStore', () => {
    useUIStore.getState().addDetachedNote('n1', { x: 100, y: 200 });
    expect(useStore.getState().detachedNotes).toEqual([
      { noteId: 'n1', position: { x: 100, y: 200 }, isPinned: false },
    ]);
  });

  it('useStore detachedNotes 变更同步到 useUIStore', () => {
    useStore.setState({
      detachedNotes: [{ noteId: 'n2', position: { x: 50, y: 60 }, isPinned: true }],
    });
    expect(useUIStore.getState().detachedNotes).toEqual([
      { noteId: 'n2', position: { x: 50, y: 60 }, isPinned: true },
    ]);
  });
});
