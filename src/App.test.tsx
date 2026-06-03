import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (command: string) => {
    if (command === 'get_pin_mode') {
      return false;
    }
    if (command === 'get_global_shortcut_error') {
      return null;
    }
    return null;
  }),
  listenMock: vi.fn(async () => vi.fn()),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
  emitTo: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: vi.fn(async () => ''),
}));

vi.mock('./store/db', () => ({
  db: {
    saveWAL: vi.fn(async () => undefined),
    loadWAL: vi.fn(async () => undefined),
    clearWAL: vi.fn(async () => undefined),
  },
}));

vi.mock('./utils/fileSystem', () => ({
  saveFile: vi.fn(async () => true),
  openFile: vi.fn(async () => null),
}));

vi.mock('./components/Canvas', () => ({
  Canvas: () => <div data-testid="canvas" />,
  CanvasWithProfiler: () => <div data-testid="canvas" />,
}));

vi.mock('./utils/performance', () => ({
  useFPSMonitor: () => ({ start: () => {}, stop: () => {} }),
}));

vi.mock('./utils/diagnostics', () => ({
  diagnostics: { updateFPS: () => {}, updateNoteStats: () => {}, updateMetrics: () => {}, recordSlowPath: () => {} },
}));

vi.mock('./components/TrashGrid', () => ({
  TrashGrid: () => <div data-testid="trash-grid" />,
}));

vi.mock('./components/BoardDock', () => ({
  BoardDock: () => <div data-testid="board-dock" />,
}));

vi.mock('./components/PinFab', () => ({
  PinFab: () => <div data-testid="pin-fab" />,
}));

vi.mock('./components/ContextMenu', () => ({
  ContextMenu: () => <div data-testid="context-menu" />,
}));

vi.mock('./components/MiniMap', () => ({
  MiniMap: () => <div data-testid="mini-map" />,
}));

vi.mock('./components/Spotlight', () => ({
  Spotlight: () => <div data-testid="spotlight" />,
}));

vi.mock('./components/ShortcutsManager', () => ({
  default: () => <div data-testid="shortcuts-manager" />,
}));

import App from './App';
import { useStore } from './store/useStore';
import { useUIStore, createInitialUIState } from './store/uiStore';
import { resetViewportSpawnSequenceForTests } from './utils/spawnPosition';
import { readText } from '@tauri-apps/plugin-clipboard-manager';

describe('App WindowShell 组合契约', () => {
  let container: HTMLDivElement;
  let root: Root;
  let resizeObserverCallback: ResizeObserverCallback | null = null;

  const renderApp = async () => {
    await act(async () => {
      root.render(<App />);
    });
  };

  beforeEach(() => {
    invokeMock.mockClear();
    listenMock.mockClear();

    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    resetViewportSpawnSequenceForTests();

    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        resizeObserverCallback = callback;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    });

    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      viewMode: 'BOARD',
      isSpotlightOpen: false,
      isPinned: false,
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    resizeObserverCallback = null;
    vi.unstubAllGlobals();
  });

  it('BOARD 模式下将壳内内容与壳外浮层分离', async () => {
    useStore.setState({ isSpotlightOpen: true, isQuickCaptureOpen: true });

    await renderApp();

    const shell = container.querySelector('[data-testid="window-shell"]') as HTMLElement | null;
    const canvas = container.querySelector('[data-testid="canvas"]') as HTMLElement | null;
    const boardDock = container.querySelector('[data-testid="board-dock"]') as HTMLElement | null;
    const miniMap = container.querySelector('[data-testid="mini-map"]') as HTMLElement | null;
    const pinFab = container.querySelector('[data-testid="pin-fab"]') as HTMLElement | null;
    const spotlight = container.querySelector('[data-testid="spotlight"]') as HTMLElement | null;
    const contextMenu = container.querySelector('[data-testid="context-menu"]') as HTMLElement | null;
    const shellOverlay = container.querySelector('[data-testid="window-shell-overlay"]') as HTMLElement | null;
    const quickCapture = container.querySelector('[role="dialog"][aria-label="快速捕获"]') as HTMLElement | null;

    expect(shell).not.toBeNull();
    expect(canvas).not.toBeNull();
    expect(boardDock).not.toBeNull();
    expect(miniMap).not.toBeNull();
    expect(pinFab).not.toBeNull();
    expect(spotlight).not.toBeNull();
    expect(contextMenu).not.toBeNull();
    expect(shellOverlay).not.toBeNull();
    expect(quickCapture).not.toBeNull();

    expect(shell?.contains(canvas)).toBe(true);
    expect(shell?.contains(boardDock)).toBe(true);
    expect(shell?.contains(miniMap)).toBe(true);
    expect(shell?.contains(pinFab)).toBe(true);
    expect(shell?.contains(spotlight)).toBe(true);
    expect(shell?.contains(quickCapture)).toBe(true);
    expect(shellOverlay?.contains(quickCapture)).toBe(true);
    expect(shell?.contains(contextMenu)).toBe(false);
    expect(shellOverlay?.className).toContain('pointer-events-none');
    expect(quickCapture?.className).toContain('pointer-events-auto');
    expect(listenMock).toHaveBeenCalledWith('reset-viewport', expect.any(Function));
    expect(listenMock).toHaveBeenCalledWith('pin-state-changed', expect.any(Function));
    expect(listenMock).toHaveBeenCalledWith('open-quick-capture', expect.any(Function));
    expect(listenMock).toHaveBeenCalledWith('create-note-from-clipboard', expect.any(Function));
    expect(listenMock).toHaveBeenCalledWith('tray-new-note', expect.any(Function));
    expect(listenMock).toHaveBeenCalledWith('global-shortcut-register-failed', expect.any(Function));
    expect(listenMock).toHaveBeenCalledWith('detached-note:locate', expect.any(Function));
    expect(listenMock).toHaveBeenCalledWith('detached-note:closed', expect.any(Function));
    expect(invokeMock).toHaveBeenCalledWith('get_pin_mode');
    expect(invokeMock).toHaveBeenCalledWith('get_global_shortcut_error');
  });

  it('将当前看板名称同步到托盘 tooltip，正常状态不附带保存状态', async () => {
    await renderApp();

    expect(invokeMock).toHaveBeenCalledWith('set_tray_tooltip', {
      tooltip: 'SoNotes · 当前看板：主板',
    });
  });

  it('保存失败时更新托盘 tooltip 状态', async () => {
    await renderApp();

    const state = useStore.getState();
    const currentBoard = state.boards.find((board) => board.id === state.currentBoardId)!;

    await act(async () => {
      useStore.setState({
        boards: state.boards.map((board) => (
          board.id === currentBoard.id ? { ...board, name: '项目看板' } : board
        )),
        saveStatus: 'error',
        saveError: '持久化写入失败。',
      });
    });

    expect(invokeMock).toHaveBeenCalledWith('set_tray_tooltip', {
      tooltip: 'SoNotes · 当前看板：项目看板 · 保存失败：持久化写入失败。',
    });
  });

  it('保存中时更新托盘 tooltip 状态', async () => {
    await renderApp();

    await act(async () => {
      useStore.setState({ saveStatus: 'saving' });
    });

    expect(invokeMock).toHaveBeenCalledWith('set_tray_tooltip', {
      tooltip: 'SoNotes · 当前看板：主板 · 保存中',
    });
  });

  it('收到全局快捷键注册失败事件后显示提示', async () => {
    let shortcutFailedHandler: ((event: { payload: string }) => void) | null = null;
    listenMock.mockImplementation(async (...args: unknown[]) => {
      const [eventName, handler] = args as [string, (event: { payload: string }) => void];
      if (eventName === 'global-shortcut-register-failed') {
        shortcutFailedHandler = handler;
      }
      return vi.fn();
    });

    await renderApp();

    expect(container.textContent).not.toContain('全局快捷键不可用');

    await act(async () => {
      shortcutFailedHandler?.({ payload: 'Ctrl+Alt+N 已被占用' });
    });

    expect(container.textContent).toContain('全局快捷键不可用');
    expect(container.textContent).toContain('Ctrl+Alt+N 已被占用');
  });

  it('切换到 TRASH 时保留同一个 WindowShell，只替换内容槽', async () => {
    await renderApp();

    const shellBefore = container.querySelector('[data-testid="window-shell"]') as HTMLElement | null;
    expect(shellBefore?.querySelector('[data-testid="canvas"]')).not.toBeNull();
    expect(shellBefore?.querySelector('[data-testid="trash-grid"]')).toBeNull();

    await act(async () => {
      useStore.setState({
        viewMode: 'TRASH',
        isSpotlightOpen: true,
      });
    });

    const shellAfter = container.querySelector('[data-testid="window-shell"]') as HTMLElement | null;
    const boardDock = container.querySelector('[data-testid="board-dock"]') as HTMLElement | null;

    expect(shellAfter).toBe(shellBefore);
    expect(shellAfter?.querySelector('[data-testid="canvas"]')).toBeNull();
    expect(shellAfter?.querySelector('[data-testid="trash-grid"]')).not.toBeNull();
    expect(shellAfter?.querySelector('[data-testid="spotlight"]')).toBeNull();
    expect(shellAfter?.querySelector('[data-testid="mini-map"]')).toBeNull();
    expect(shellAfter?.querySelector('[data-testid="pin-fab"]')).toBeNull();
    expect(shellAfter?.contains(boardDock)).toBe(true);
    expect(shellAfter?.contains(container.querySelector('[data-testid="context-menu"]'))).toBe(false);
  });

  it('收到 pin-state-changed 事件后写入全局 pinned 状态', async () => {
    let pinChangedHandler: ((event: { payload: boolean }) => void) | null = null;
    listenMock.mockImplementation(async (...args: unknown[]) => {
      const [eventName, handler] = args as [string, (event: { payload: boolean }) => void];
      if (eventName === 'pin-state-changed') {
        pinChangedHandler = handler;
      }
      return vi.fn();
    });

    await renderApp();

    expect(useStore.getState().isPinned).toBe(false);

    await act(async () => {
      pinChangedHandler?.({ payload: true });
    });

    expect(useStore.getState().isPinned).toBe(true);
  });

  it('托盘非鼠标入口使用统一视口落点并连续错位', async () => {
    let trayNewNoteHandler: (() => void) | null = null;
    let clipboardNoteHandler: (() => Promise<void>) | null = null;
    const addNote = vi.fn();
    const addNotesWithContentBatch = vi.fn();

    vi.mocked(readText).mockResolvedValueOnce('剪贴板内容');
    listenMock.mockImplementation(async (...args: unknown[]) => {
      const [eventName, handler] = args as [string, () => void | Promise<void>];
      if (eventName === 'tray-new-note') {
        trayNewNoteHandler = handler as () => void;
      }
      if (eventName === 'create-note-from-clipboard') {
        clipboardNoteHandler = handler as () => Promise<void>;
      }
      return vi.fn();
    });
    useStore.setState({
      addNote,
      addNotesWithContentBatch,
    });

    await renderApp();

    useStore.setState({
      viewport: { x: 40, y: 60, w: 1280, h: 720 },
    });

    await act(async () => {
      trayNewNoteHandler?.();
    });
    await act(async () => {
      await clipboardNoteHandler?.();
    });

    expect(addNote).toHaveBeenCalledWith(550, 132);
    expect(addNotesWithContentBatch).toHaveBeenCalledWith([
      { content: '剪贴板内容', x: 582, y: 160 },
    ]);
  });

  it('TRASH 下托盘新建先切回 BOARD 再延迟创建便签', async () => {
    let trayNewNoteHandler: (() => void) | null = null;
    const addNote = vi.fn();

    listenMock.mockImplementation(async (...args: unknown[]) => {
      const [eventName, handler] = args as [string, () => void | Promise<void>];
      if (eventName === 'tray-new-note') {
        trayNewNoteHandler = handler as () => void;
      }
      return vi.fn();
    });
    useStore.setState({
      viewMode: 'TRASH',
      addNote,
    });

    await renderApp();

    await act(async () => {
      trayNewNoteHandler?.();
    });

    expect(useStore.getState().viewMode).toBe('BOARD');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(addNote).toHaveBeenCalledTimes(1);
  });

  it('TRASH 下托盘剪贴板先切回 BOARD 再延迟创建便签', async () => {
    let clipboardNoteHandler: (() => Promise<void>) | null = null;
    const addNotesWithContentBatch = vi.fn();

    vi.mocked(readText).mockResolvedValueOnce('TRASH剪贴板');
    listenMock.mockImplementation(async (...args: unknown[]) => {
      const [eventName, handler] = args as [string, () => void | Promise<void>];
      if (eventName === 'create-note-from-clipboard') {
        clipboardNoteHandler = handler as () => Promise<void>;
      }
      return vi.fn();
    });
    useStore.setState({
      viewMode: 'TRASH',
      addNotesWithContentBatch,
    });

    await renderApp();

    await act(async () => {
      await clipboardNoteHandler?.();
    });

    expect(useStore.getState().viewMode).toBe('BOARD');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(addNotesWithContentBatch).toHaveBeenCalledTimes(1);
  });

  it('TRASH 下 open-quick-capture 先切回 BOARD 再延迟打开', async () => {
    let quickCaptureHandler: (() => void) | null = null;

    listenMock.mockImplementation(async (...args: unknown[]) => {
      const [eventName, handler] = args as [string, () => void | Promise<void>];
      if (eventName === 'open-quick-capture') {
        quickCaptureHandler = handler as () => void;
      }
      return vi.fn();
    });
    useStore.setState({
      viewMode: 'TRASH',
    });

    await renderApp();

    await act(async () => {
      quickCaptureHandler?.();
    });

    expect(useStore.getState().viewMode).toBe('BOARD');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(useStore.getState().isQuickCaptureOpen).toBe(true);
  });

  it('WindowShell 内容矩形变化时同步更新 viewport 与 shellRect', async () => {
    await renderApp();

    const shellContent = container.querySelector('[data-testid="window-shell-content"]') as HTMLDivElement | null;
    const emptyBoxSizes: ResizeObserverSize[] = [];

    expect(shellContent).not.toBeNull();

    Object.defineProperty(shellContent, 'clientWidth', { configurable: true, value: 360 });
    Object.defineProperty(shellContent, 'clientHeight', { configurable: true, value: 540 });
    shellContent!.getBoundingClientRect = vi.fn(() => ({
      left: 20,
      top: 30,
      right: 380,
      bottom: 570,
      width: 360,
      height: 540,
      x: 20,
      y: 30,
      toJSON: () => ({}),
    } as DOMRect));

    await act(async () => {
      resizeObserverCallback?.([
        {
          contentRect: {
            width: 360,
            height: 540,
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: 360,
            bottom: 540,
            toJSON: () => ({}),
          } as DOMRectReadOnly,
          target: shellContent!,
          borderBoxSize: emptyBoxSizes,
          contentBoxSize: emptyBoxSizes,
          devicePixelContentBoxSize: emptyBoxSizes,
        },
      ], {} as ResizeObserver);
    });

    const { viewport, shellRect } = useStore.getState();
    expect(viewport.w).toBe(360);
    expect(viewport.h).toBe(540);
    expect(shellRect).toEqual({
      left: 20,
      top: 30,
      right: 380,
      bottom: 570,
    });
  });

  it('收到 detached-note:closed 事件后清理撕下便签运行态映射', async () => {
    let closedHandler: ((event: { payload: { noteId: string } }) => void) | null = null;
    listenMock.mockImplementation(async (...args: unknown[]) => {
      const [eventName, handler] = args as [string, (event: { payload: { noteId: string } }) => void];
      if (eventName === 'detached-note:closed') {
        closedHandler = handler;
      }
      return vi.fn();
    });

    await renderApp();

    useUIStore.getState().addDetachedNote('note-closed-1', { x: 100, y: 200 });
    expect(useUIStore.getState().detachedNotes).toHaveLength(1);

    await act(async () => {
      closedHandler?.({ payload: { noteId: 'note-closed-1' } });
    });

    expect(useUIStore.getState().detachedNotes).toHaveLength(0);
  });
});

describe('App DetachedNoteOverlay 集成契约', () => {
  let container: HTMLDivElement;
  let overlayRoot: HTMLDivElement;
  let root: Root;

  const renderApp = async () => {
    await act(async () => {
      root.render(<App />);
    });
  };

  const createIntegrationNote = (overrides: Record<string, unknown> = {}) => ({
    id: 'note-int-1',
    boardId: 'default',
    title: '集成标题',
    content: '集成正文内容',
    x: 100,
    y: 200,
    z: 1,
    color: '#FFFFFF',
    collapsed: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  });

  beforeEach(() => {
    invokeMock.mockClear();
    listenMock.mockClear();

    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    resetViewportSpawnSequenceForTests();

    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
      unobserve() {}
    });

    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      viewMode: 'BOARD',
      isSpotlightOpen: false,
      isPinned: false,
    });

    useUIStore.getState().replaceUIState(createInitialUIState());

    container = document.createElement('div');
    document.body.appendChild(container);

    overlayRoot = document.createElement('div');
    overlayRoot.id = 'overlay-root';
    document.body.appendChild(overlayRoot);

    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    overlayRoot.remove();
    vi.unstubAllGlobals();
  });

  it('通过 App 组合后撕下便签 portal 渲染到 #overlay-root', async () => {
    const note = createIntegrationNote();
    useStore.setState({
      notesById: { [note.id]: note },
      allNoteIds: [note.id],
      boardNoteIds: { default: [note.id] },
    });
    useUIStore.getState().addDetachedNote(note.id, { x: 150, y: 250 });

    await renderApp();

    const overlay = overlayRoot.querySelector('[data-testid="detached-note-overlay"]');
    expect(overlay).not.toBeNull();

    const shell = overlayRoot.querySelector(
      `[data-testid="detached-note-shell-${note.id}"]`,
    );
    expect(shell).not.toBeNull();
  });

  it('store 更新标题与内容后撕下视图同步反映', async () => {
    const note = createIntegrationNote();
    useStore.setState({
      notesById: { [note.id]: note },
      allNoteIds: [note.id],
      boardNoteIds: { default: [note.id] },
    });
    useUIStore.getState().addDetachedNote(note.id, { x: 100, y: 200 });

    await renderApp();

    const shell = overlayRoot.querySelector(
      `[data-testid="detached-note-shell-${note.id}"]`,
    );
    expect(shell?.textContent).toContain('集成标题');
    expect(shell?.textContent).toContain('集成正文内容');

    await act(async () => {
      useStore.setState({
        notesById: {
          [note.id]: { ...note, title: '同步后标题', content: '同步后正文' },
        },
      });
    });

    expect(shell?.textContent).toContain('同步后标题');
    expect(shell?.textContent).toContain('同步后正文');
  });

  it('点击 pin 按钮切换 UI store 中的置顶状态', async () => {
    const note = createIntegrationNote();
    useStore.setState({
      notesById: { [note.id]: note },
      allNoteIds: [note.id],
      boardNoteIds: { default: [note.id] },
    });
    useUIStore.getState().addDetachedNote(note.id, { x: 100, y: 200 });

    await renderApp();

    expect(useUIStore.getState().detachedNotes[0].isPinned).toBe(false);

    const pinBtn = overlayRoot.querySelector(
      `[data-testid="detached-note-pin-${note.id}"]`,
    ) as HTMLButtonElement;
    expect(pinBtn).not.toBeNull();

    await act(async () => {
      pinBtn.click();
    });

    expect(useUIStore.getState().detachedNotes[0].isPinned).toBe(true);

    await act(async () => {
      pinBtn.click();
    });

    expect(useUIStore.getState().detachedNotes[0].isPinned).toBe(false);
  });

  it('点击贴回画布按钮关闭撕下视图', async () => {
    const note = createIntegrationNote();
    useStore.setState({
      notesById: { [note.id]: note },
      allNoteIds: [note.id],
      boardNoteIds: { default: [note.id] },
    });
    useUIStore.getState().addDetachedNote(note.id, { x: 100, y: 200 });

    await renderApp();

    expect(useUIStore.getState().detachedNotes).toHaveLength(1);

    const stickBackBtn = overlayRoot.querySelector(
      `[data-testid="detached-note-stick-back-${note.id}"]`,
    ) as HTMLButtonElement;
    expect(stickBackBtn).not.toBeNull();

    await act(async () => {
      stickBackBtn.click();
    });

    expect(useUIStore.getState().detachedNotes).toHaveLength(0);
    const shellAfter = overlayRoot.querySelector(
      `[data-testid="detached-note-shell-${note.id}"]`,
    );
    expect(shellAfter).toBeNull();
  });

  it('软删除便签后撕下视图自动关闭', async () => {
    const note = createIntegrationNote();
    useStore.setState({
      notesById: { [note.id]: note },
      allNoteIds: [note.id],
      boardNoteIds: { default: [note.id] },
    });
    useUIStore.getState().addDetachedNote(note.id, { x: 100, y: 200 });

    await renderApp();

    expect(useUIStore.getState().detachedNotes).toHaveLength(1);

    await act(async () => {
      useStore.setState({
        notesById: {
          [note.id]: { ...note, deletedAt: Date.now() },
        },
      });
    });

    expect(useUIStore.getState().detachedNotes).toHaveLength(0);
    const shellAfter = overlayRoot.querySelector(
      `[data-testid="detached-note-shell-${note.id}"]`,
    );
    expect(shellAfter).toBeNull();
  });

  it('便签不存在时不渲染撕下视图', async () => {
    useUIStore.getState().addDetachedNote('nonexistent-note', { x: 10, y: 20 });

    await renderApp();

    const shell = overlayRoot.querySelector(
      '[data-testid="detached-note-shell-nonexistent-note"]',
    );
    expect(shell).toBeNull();
  });
});
