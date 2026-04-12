import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

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

import { BoardDock } from './BoardDock';
import { Z_INDEX } from '../constants/layout';
import { useStore } from '../store/useStore';

describe('BoardDock v1.2.4 最小修复', () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderBoardDock = async () => {
    await act(async () => {
      root.render(<BoardDock />);
    });
  };

  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      boards: [
        { id: 'default', name: '主板', icon: '📌', createdAt: 0, viewport: { x: 0, y: 0 } },
        { id: 'board-2', name: '实验板', icon: '🧪', createdAt: 1, viewport: { x: 40, y: 60 } },
      ],
      notes: [],
      currentBoardId: 'default',
      isDockVisible: true,
      viewMode: 'BOARD',
      config: { ...useStore.getState().config, themeMode: 'system' },
      switchBoard: vi.fn(),
      createBoard: vi.fn(),
      deleteBoard: vi.fn(),
      updateBoard: vi.fn(),
      reorderBoard: vi.fn(),
      setDockVisible: vi.fn(),
      setViewMode: vi.fn(),
      clearSelection: vi.fn(),
      exportAll: vi.fn(async () => undefined),
      importFromFile: vi.fn(async () => undefined),
      exportCurrentBoard: vi.fn(async () => undefined),
      setThemeMode: vi.fn(),
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

  it('保持共享浮层层级合同顺序稳定', () => {
    expect(Z_INDEX.MINIMAP).toBeLessThan(Z_INDEX.DOCK_BACKDROP);
    expect(Z_INDEX.DOCK_BACKDROP).toBeLessThan(Z_INDEX.DOCK);
    expect(Z_INDEX.DOCK).toBeLessThan(Z_INDEX.TOOLTIP);
    expect(Z_INDEX.TOOLTIP).toBeLessThan(Z_INDEX.MENU);
    expect(Z_INDEX.MENU).toBeLessThan(Z_INDEX.SPOTLIGHT);
  });

  it('右键看板时菜单锚点对齐真实 board item，而不是默认 0 坐标', async () => {
    await renderBoardDock();

    const boardButton = container.querySelector('[data-board-id="board-2"]') as HTMLButtonElement | null;

    expect(boardButton).not.toBeNull();

    Object.defineProperty(boardButton!, 'offsetLeft', { configurable: true, value: 120 });
    Object.defineProperty(boardButton!, 'offsetWidth', { configurable: true, value: 36 });
    Object.defineProperty(boardButton!, 'offsetTop', { configurable: true, value: 12 });

    await act(async () => {
      boardButton?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });

    const menu = container.querySelector('.board-dock-context-menu') as HTMLDivElement | null;

    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain('实验板');
    expect(menu?.style.left).toBe('138px');
    expect(menu?.style.left).not.toBe('0px');
  });

  it('锚点计算不依赖 transform 后的屏幕坐标', async () => {
    await renderBoardDock();

    const boardButton = container.querySelector('[data-board-id="board-2"]') as HTMLButtonElement | null;

    expect(boardButton).not.toBeNull();

    Object.defineProperty(boardButton!, 'offsetLeft', { configurable: true, value: 180 });
    Object.defineProperty(boardButton!, 'offsetWidth', { configurable: true, value: 40 });
    Object.defineProperty(boardButton!, 'offsetTop', { configurable: true, value: 8 });
    boardButton!.getBoundingClientRect = vi.fn(() => ({
      x: 262,
      y: 430,
      left: 262,
      top: 430,
      width: 36,
      height: 36,
      right: 298,
      bottom: 466,
      toJSON: () => ({}),
    } as DOMRect));

    await act(async () => {
      boardButton?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });

    const menu = container.querySelector('.board-dock-context-menu') as HTMLDivElement | null;

    expect(menu).not.toBeNull();
    expect(menu?.style.left).toBe('200px');
  });
});
