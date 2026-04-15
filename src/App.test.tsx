import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
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

  const renderApp = async () => {
    await act(async () => {
      root.render(<App />);
    });
  };

  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      viewMode: 'BOARD',
      isSpotlightOpen: false,
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
});
