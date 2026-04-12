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

  const renderCanvas = async () => {
    await act(async () => {
      root.render(<Canvas />);
    });
  };

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

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

    await act(async () => {
      canvasRoot?.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true,
        clientX: 180,
        clientY: 220,
      }));
    });

    expect(addNote).toHaveBeenCalledTimes(1);
    expect(addNote).toHaveBeenCalledWith(220, 280);
  });

  it('双击 NoteCard 折叠区不会被误判为空白画布', async () => {
    const addNote = vi.fn();
    useStore.setState({ addNote });

    await renderCanvas();

    const collapseButton = container.querySelector('[aria-label="折叠便签"]') as HTMLButtonElement | null;
    expect(collapseButton).not.toBeNull();

    await act(async () => {
      collapseButton?.dispatchEvent(new MouseEvent('dblclick', {
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
});
