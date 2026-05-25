import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: vi.fn(async () => ''),
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

import { ContextMenu } from './ContextMenu';
import { useStore } from '../store/useStore';

describe('ContextMenu shell 坐标合同', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      isLoaded: true,
      selectedIds: [],
      viewport: { x: 40, y: 60, w: 400, h: 300 },
      shellRect: { left: 12, top: 16, right: 512, bottom: 416 },
      contextMenu: {
        isOpen: true,
        x: 490,
        y: 390,
        type: 'CANVAS',
      },
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

  it('按 shell 内容区边界夹取菜单位置，并按 shell 原点换算画布坐标', async () => {
    const addNote = vi.fn();
    useStore.setState({ addNote });

    await act(async () => {
      root.render(<ContextMenu />);
    });

    const menu = container.querySelector('[role="menu"]') as HTMLDivElement | null;
    const createButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('新建便签')) as HTMLButtonElement | undefined;

    expect(menu).not.toBeNull();
    expect(menu?.style.left).toBe('352px');
    expect(menu?.style.top).toBe('216px');
    expect(createButton).toBeDefined();

    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(addNote).toHaveBeenCalledWith(518, 434);
  });

  it('确认一键归拢后提供更新时间和颜色归拢入口', async () => {
    const arrangeNotes = vi.fn();
    useStore.setState({ arrangeNotes });

    await act(async () => {
      root.render(<ContextMenu />);
    });

    const arrangeButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('一键归拢')) as HTMLButtonElement | undefined;
    expect(arrangeButton).toBeDefined();

    await act(async () => {
      arrangeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    const updatedButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('按更新时间归拢')) as HTMLButtonElement | undefined;
    const colorButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('按颜色归拢')) as HTMLButtonElement | undefined;
    expect(updatedButton).toBeDefined();
    expect(colorButton).toBeDefined();

    await act(async () => {
      updatedButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(arrangeNotes).toHaveBeenCalledWith(518, 434, 'updatedAt', 'board');
  });

  it('单选时画布菜单归拢仍显式整理当前看板全部便签', async () => {
    const arrangeNotes = vi.fn();
    useStore.setState({ arrangeNotes, selectedIds: ['note-1'] });

    await act(async () => {
      root.render(<ContextMenu />);
    });

    const arrangeButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('一键归拢')) as HTMLButtonElement | undefined;
    expect(arrangeButton).toBeDefined();

    await act(async () => {
      arrangeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    const confirmButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('一键归拢')) as HTMLButtonElement | undefined;
    expect(confirmButton).toBeDefined();

    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(arrangeNotes).toHaveBeenCalledWith(518, 434, 'position', 'board');
  });

  it('贴近壳右边界时子菜单翻到左侧并限制高度', async () => {
    useStore.setState({
      currentBoardId: 'default',
      boards: [
        { id: 'default', name: '主板', icon: '📌', createdAt: 0, viewport: { x: 0, y: 0 } },
        { id: 'archive', name: '归档', icon: '🗂️', createdAt: 1, viewport: { x: 0, y: 0 } },
      ],
      selectedIds: [],
      shellRect: { left: 12, top: 16, right: 260, bottom: 316 },
      contextMenu: {
        isOpen: true,
        x: 240,
        y: 96,
        type: 'NOTE',
        targetId: 'note-1',
      },
    });

    await act(async () => {
      root.render(<ContextMenu />);
    });

    const moveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('移动到')) as HTMLButtonElement | undefined;
    expect(moveButton).toBeDefined();

    await act(async () => {
      moveButton?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    });

    await act(async () => undefined);

    const submenus = Array.from(container.querySelectorAll('[role="menu"]')) as HTMLDivElement[];
    const moveSubmenu = submenus.find((menu) => menu.className.includes('overflow-y-auto') && menu.textContent?.includes('归档'));

    expect(moveSubmenu).toBeDefined();
    expect(moveSubmenu?.className).toContain('right-full');
    expect(moveSubmenu?.className).toContain('overflow-y-auto');
    expect(moveSubmenu?.style.maxHeight).toBe('212px');
  });
});
