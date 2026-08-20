import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, Profiler } from 'react';
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
import { useViewportStore } from '../store/viewportStore';
import { normalizeNotes } from '../store/normalization';

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

    const confirmButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('确认归拢')) as HTMLButtonElement | undefined;
    expect(confirmButton).toBeDefined();

    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(arrangeNotes).toHaveBeenCalledWith(518, 434, 'position', 'board');
  });

  it('多选便签右键菜单提供合并入口并复用 store action', async () => {
    const mergeSelectedNotes = vi.fn(() => 'merged-note');
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'note-1',
          kind: 'text',
          boardId: 'default',
          x: 10,
          y: 20,
          title: '',
          content: 'alpha',
          color: '#FFFFFF',
          z: 1,
          createdAt: 100,
          updatedAt: 100,
        },
        {
          id: 'note-2',
          kind: 'text',
          boardId: 'default',
          x: 30,
          y: 40,
          title: '',
          content: 'beta',
          color: '#FFFFFF',
          z: 2,
          createdAt: 200,
          updatedAt: 200,
        },
      ]),
      selectedIds: ['note-1', 'note-2'],
      mergeSelectedNotes,
      contextMenu: {
        isOpen: true,
        x: 120,
        y: 140,
        type: 'NOTE',
        targetId: 'note-1',
      },
    });

    await act(async () => {
      root.render(<ContextMenu />);
    });

    const mergeButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('合并为一张')) as HTMLButtonElement | undefined;
    expect(mergeButton).toBeDefined();

    await act(async () => {
      mergeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(mergeSelectedNotes).toHaveBeenCalledTimes(1);
  });

  it('单张便签右键菜单仅对可按空行拆分内容显示拆分入口', async () => {
    const splitNoteByParagraph = vi.fn(() => ['note-1', 'part-1']);
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'note-1',
          kind: 'text',
          boardId: 'default',
          x: 10,
          y: 20,
          title: '',
          content: '第一段\n\n第二段',
          color: '#FFFFFF',
          z: 1,
          createdAt: 100,
          updatedAt: 100,
        },
      ]),
      selectedIds: ['note-1'],
      splitNoteByParagraph,
      contextMenu: {
        isOpen: true,
        x: 120,
        y: 140,
        type: 'NOTE',
        targetId: 'note-1',
      },
    });

    await act(async () => {
      root.render(<ContextMenu />);
    });

    const splitButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('按段拆分')) as HTMLButtonElement | undefined;
    expect(splitButton).toBeDefined();

    await act(async () => {
      splitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(splitNoteByParagraph).toHaveBeenCalledWith('note-1');
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

describe('ContextMenu 撕下便签菜单项', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      isLoaded: true,
      viewMode: 'BOARD',
      ...normalizeNotes([
        {
          id: 'note-1',
          kind: 'text',
          boardId: 'default',
          x: 10,
          y: 20,
          title: '',
          content: '测试内容',
          color: '#FFFFFF',
          z: 1,
          createdAt: 100,
          updatedAt: 100,
        },
      ]),
      selectedIds: ['note-1'],
      viewport: { x: 0, y: 0, w: 400, h: 300 },
      shellRect: { left: 0, top: 0, right: 400, bottom: 300 },
      contextMenu: {
        isOpen: true,
        x: 120,
        y: 140,
        type: 'NOTE',
        targetId: 'note-1',
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

  it('单张便签右键菜单显示撕下便签入口', async () => {
    await act(async () => {
      root.render(<ContextMenu />);
    });

    const detachButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('撕下便签'),
    );
    expect(detachButton).toBeDefined();
  });

  it('点击撕下便签调用 appController.detachNote', async () => {
    await act(async () => {
      root.render(<ContextMenu />);
    });

    const detachButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('撕下便签'),
    ) as HTMLButtonElement;

    await act(async () => {
      detachButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    const detached = useStore.getState().detachedNotes;
    expect(detached).toHaveLength(1);
    expect(detached[0].noteId).toBe('note-1');
  });

  it('废纸篓模式下不显示撕下便签入口', async () => {
    useStore.setState({ viewMode: 'TRASH' });

    await act(async () => {
      root.render(<ContextMenu />);
    });

    const detachButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('撕下便签'),
    );
    expect(detachButton).toBeUndefined();
  });

  it('多选右键菜单不显示撕下便签入口', async () => {
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'note-1',
          kind: 'text',
          boardId: 'default',
          x: 10,
          y: 20,
          title: '',
          content: 'a',
          color: '#FFFFFF',
          z: 1,
          createdAt: 100,
          updatedAt: 100,
        },
        {
          id: 'note-2',
          kind: 'text',
          boardId: 'default',
          x: 30,
          y: 40,
          title: '',
          content: 'b',
          color: '#FFFFFF',
          z: 2,
          createdAt: 200,
          updatedAt: 200,
        },
      ]),
      selectedIds: ['note-1', 'note-2'],
    });

    await act(async () => {
      root.render(<ContextMenu />);
    });

    const detachButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('撕下便签'),
    );
    expect(detachButton).toBeUndefined();
  });

  it('P0-08 菜单关闭时 viewport 变化不增加 Content 渲染次数', async () => {
    useStore.setState({
      contextMenu: { isOpen: false, x: 10, y: 10, type: 'CANVAS' },
    });

    let commits = 0;
    await act(async () => {
      root.render(
        <Profiler id="p0-08-context-menu" onRender={() => { commits += 1; }}>
          <ContextMenu />
        </Profiler>,
      );
    });

    expect(container.querySelector('[role="menu"]')).toBeNull();
    const commitsAfterMount = commits;

    await act(async () => {
      const viewport = useViewportStore.getState().viewport;
      useViewportStore.setState({ viewport: { ...viewport, x: 80, y: 90 } });
      useViewportStore.setState({
        viewport: { ...useViewportStore.getState().viewport, x: 120, y: 140 },
      });
      useViewportStore.setState({
        viewport: { ...useViewportStore.getState().viewport, x: 160, y: 180 },
      });
    });

    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(commits).toBe(commitsAfterMount);
  });
});
