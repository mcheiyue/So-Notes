import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

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
});
