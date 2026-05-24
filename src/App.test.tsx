import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (command: string) => {
    if (command === 'get_pin_mode') {
      return false;
    }
    return null;
  }),
  listenMock: vi.fn(async (..._args: unknown[]) => vi.fn()),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
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
    useStore.setState({ isSpotlightOpen: true });

    await renderApp();

    const shell = container.querySelector('[data-testid="window-shell"]') as HTMLElement | null;
    const canvas = container.querySelector('[data-testid="canvas"]') as HTMLElement | null;
    const boardDock = container.querySelector('[data-testid="board-dock"]') as HTMLElement | null;
    const miniMap = container.querySelector('[data-testid="mini-map"]') as HTMLElement | null;
    const pinFab = container.querySelector('[data-testid="pin-fab"]') as HTMLElement | null;
    const spotlight = container.querySelector('[data-testid="spotlight"]') as HTMLElement | null;
    const contextMenu = container.querySelector('[data-testid="context-menu"]') as HTMLElement | null;
    const shellOverlay = container.querySelector('[data-testid="window-shell-overlay"]') as HTMLElement | null;

    expect(shell).not.toBeNull();
    expect(canvas).not.toBeNull();
    expect(boardDock).not.toBeNull();
    expect(miniMap).not.toBeNull();
    expect(pinFab).not.toBeNull();
    expect(spotlight).not.toBeNull();
    expect(contextMenu).not.toBeNull();
    expect(shellOverlay).not.toBeNull();

    expect(shell?.contains(canvas)).toBe(true);
    expect(shell?.contains(boardDock)).toBe(true);
    expect(shell?.contains(miniMap)).toBe(true);
    expect(shell?.contains(pinFab)).toBe(true);
    expect(shell?.contains(spotlight)).toBe(true);
    expect(shell?.contains(contextMenu)).toBe(false);
    expect(shellOverlay?.className).toContain('pointer-events-none');
    expect(listenMock).toHaveBeenCalledWith('reset-viewport', expect.any(Function));
    expect(listenMock).toHaveBeenCalledWith('pin-state-changed', expect.any(Function));
    expect(listenMock).toHaveBeenCalledWith('open-quick-capture', expect.any(Function));
    expect(listenMock).toHaveBeenCalledWith('create-note-from-clipboard', expect.any(Function));
    expect(listenMock).toHaveBeenCalledWith('tray-new-note', expect.any(Function));
    expect(listenMock).toHaveBeenCalledWith('resume-current-board', expect.any(Function));
    expect(invokeMock).toHaveBeenCalledWith('get_pin_mode');
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
});
