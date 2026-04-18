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

vi.mock('react-draggable', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

import { Canvas } from './Canvas';
import { useStore } from '../store/useStore';
import { Note } from '../store/types';

const createNote = (overrides: Partial<Note> = {}): Note => ({
  id: 'note-1',
  boardId: 'default',
  x: 120,
  y: 140,
  title: '标题',
  content: '内容',
  color: '#FFFFFF',
  z: 1,
  collapsed: false,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

describe('Canvas 空白命中判定', () => {
  let container: HTMLDivElement;
  let root: Root;
  let rafMock: ReturnType<typeof vi.fn>;
  let cancelRafMock: ReturnType<typeof vi.fn>;

  const renderCanvas = async () => {
    await act(async () => {
      root.render(<Canvas />);
    });
  };

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    rafMock = vi.fn(() => 1);
    cancelRafMock = vi.fn();
    vi.stubGlobal('requestAnimationFrame', rafMock);
    vi.stubGlobal('cancelAnimationFrame', cancelRafMock);

    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      notes: [createNote()],
      currentBoardId: 'default',
      isLoaded: true,
      init: vi.fn(async () => undefined),
      selectedIds: ['note-1'],
      viewport: { x: 40, y: 60, w: 1280, h: 720 },
      interaction: {
        isPanMode: false,
        isDragging: false,
        edgePush: { top: false, bottom: false, left: false, right: false },
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
    vi.unstubAllGlobals();
  });

  it('双击空白画布时才新建便签', async () => {
    const addNote = vi.fn();
    useStore.setState({ addNote });

    await renderCanvas();

    const canvasRoot = container.firstElementChild as HTMLDivElement | null;
    canvasRoot!.getBoundingClientRect = vi.fn(() => ({
      left: 10,
      top: 20,
      right: 1290,
      bottom: 740,
      width: 1280,
      height: 720,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    } as DOMRect));

    await act(async () => {
      canvasRoot?.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true,
        clientX: 180,
        clientY: 220,
      }));
    });

    expect(addNote).toHaveBeenCalledTimes(1);
    expect(addNote).toHaveBeenCalledWith(210, 260);
  });

  it('双击 NoteCard 头部不会被误判为空白画布', async () => {
    const addNote = vi.fn();
    useStore.setState({ addNote });

    await renderCanvas();

    const noteHeader = container.querySelector('.drag-handle') as HTMLElement | null;
    expect(noteHeader).not.toBeNull();

    await act(async () => {
      noteHeader?.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true,
        clientX: 200,
        clientY: 160,
      }));
    });

    expect(addNote).not.toHaveBeenCalled();
    expect(useStore.getState().notes.find((note) => note.id === 'note-1')?.collapsed).toBe(true);
  });

  it('点击头部按钮区不会触发空白命中的清空选择', async () => {
    const clearSelection = vi.fn();
    useStore.setState({ clearSelection });

    await renderCanvas();

    const colorButton = container.querySelector('[aria-label="切换颜色"]') as HTMLButtonElement | null;
    expect(colorButton).not.toBeNull();

    await act(async () => {
      colorButton?.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        button: 0,
        clientX: 190,
        clientY: 160,
      }));
    });

    expect(clearSelection).not.toHaveBeenCalled();
  });

  it('点击空白画布仍会触发原有的清空选择逻辑', async () => {
    const clearSelection = vi.fn();
    useStore.setState({ clearSelection });

    await renderCanvas();

    const canvasRoot = container.firstElementChild as HTMLDivElement | null;

    await act(async () => {
      canvasRoot?.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        button: 0,
        clientX: 260,
        clientY: 260,
      }));
    });

    expect(clearSelection).toHaveBeenCalledTimes(1);
  });

  it('画布根层不再暴露默认焦点外框', async () => {
    await renderCanvas();

    const canvasRoot = container.firstElementChild as HTMLDivElement | null;

    expect(canvasRoot).not.toBeNull();
    expect(canvasRoot?.getAttribute('tabindex')).toBeNull();
    expect(canvasRoot?.className).toContain('outline-none');
    expect(canvasRoot?.className).toContain('focus:outline-none');
  });

  it('非零 shell 偏移下框选框仍按画布局部坐标定位', async () => {
    const clearSelection = vi.fn();
    useStore.setState({ clearSelection });

    await renderCanvas();

    const canvasRoot = container.firstElementChild as HTMLDivElement | null;
    canvasRoot!.getBoundingClientRect = vi.fn(() => ({
      left: 10,
      top: 20,
      right: 1290,
      bottom: 740,
      width: 1280,
      height: 720,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    } as DOMRect));

    const selectionBox = container.querySelector('.border-dashed') as HTMLDivElement | null;
    expect(selectionBox).not.toBeNull();

    await act(async () => {
      canvasRoot?.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        button: 0,
        clientX: 110,
        clientY: 140,
      }));

      canvasRoot?.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        buttons: 1,
        clientX: 170,
        clientY: 200,
      }));
    });

    const updatedSelectionBox = container.querySelector('.border-dashed') as HTMLDivElement | null;

    expect(clearSelection).toHaveBeenCalledTimes(1);
    expect(updatedSelectionBox?.style.left).toBe('100px');
    expect(updatedSelectionBox?.style.top).toBe('120px');
    expect(updatedSelectionBox?.style.width).toBe('60px');
    expect(updatedSelectionBox?.style.height).toBe('60px');
  });

  it('拖拽锁开启时忽略空白画布双击与清空选择', async () => {
    const addNote = vi.fn();
    const clearSelection = vi.fn();
    useStore.setState({
      addNote,
      clearSelection,
      interaction: {
        isPanMode: false,
        isDragging: true,
        edgePush: { top: false, bottom: false, left: false, right: false },
      },
    });

    await renderCanvas();

    const canvasRoot = container.firstElementChild as HTMLDivElement | null;

    await act(async () => {
      canvasRoot?.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true,
        clientX: 180,
        clientY: 220,
      }));

      canvasRoot?.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        button: 0,
        clientX: 260,
        clientY: 260,
      }));
    });

    expect(addNote).not.toHaveBeenCalled();
    expect(clearSelection).not.toHaveBeenCalled();
  });

  it('深色模式下框选矩形使用更强的边框与填充可见性', async () => {
    useStore.setState({
      config: {
        ...useStore.getState().config,
        themeMode: 'dark',
      },
    });

    await renderCanvas();

    const selectionBox = container.querySelector('.border-dashed') as HTMLDivElement | null;

    expect(selectionBox).not.toBeNull();
    expect(selectionBox?.className).toContain('border-blue-500/55');
    expect(selectionBox?.className).toContain('dark:bg-blue-200/15');
    expect(selectionBox?.className).toContain('dark:border-blue-200/80');
    expect(selectionBox?.className).toContain('dark:shadow-[0_0_0_1px_rgba(191,219,254,0.3)]');
  });

  it('背景平移采用事件驱动 rAF，静止不空转且失焦停机', async () => {
    useStore.setState({
      interaction: {
        ...useStore.getState().interaction,
        isPanMode: true,
      },
    });

    await renderCanvas();

    const canvasRoot = container.firstElementChild as HTMLDivElement | null;
    expect(canvasRoot).not.toBeNull();
    expect(rafMock).toHaveBeenCalledTimes(0);

    await act(async () => {
      canvasRoot?.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        button: 0,
        clientX: 220,
        clientY: 240,
      }));

      canvasRoot?.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        buttons: 1,
        clientX: 250,
        clientY: 265,
      }));
    });

    expect(rafMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(cancelRafMock).toHaveBeenCalledWith(1);
  });
});
