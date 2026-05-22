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
import { normalizeNotes, createLayoutNotesById } from '../store/normalization';
import { Note } from '../store/types';
import { LAYOUT } from '../constants/layout';
import {
  setEdgePushDragLeader,
  getEdgePushDragLeader,
  getEdgePushAccumulatedDelta,
  setLastDraggablePosition,
} from '../utils/edgePushDragCompensation';

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
  let rafCallbacks: FrameRequestCallback[];

  const renderCanvas = async () => {
    await act(async () => {
      root.render(<Canvas />);
    });
  };

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    rafCallbacks = [];
    rafMock = vi.fn((callback: FrameRequestCallback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    });
    cancelRafMock = vi.fn();
    vi.stubGlobal('requestAnimationFrame', rafMock);
    vi.stubGlobal('cancelAnimationFrame', cancelRafMock);

    useStore.setState(useStore.getInitialState(), true);
    setEdgePushDragLeader(null);
    const normalized = normalizeNotes([createNote()]);
    useStore.setState({
      ...normalized,
      layoutNotesById: createLayoutNotesById(normalized.notesById),
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
    expect(useStore.getState().notesById['note-1']?.collapsed).toBe(true);
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

  it('空白单击不触发框选命中，仅清空选择', async () => {
    const clearSelection = vi.fn();
    const setSelectedIds = vi.fn();
    useStore.setState({
      clearSelection,
      setSelectedIds,
      selectedIds: ['note-1'],
    });

    await renderCanvas();

    const canvasRoot = container.firstElementChild as HTMLDivElement | null;

    await act(async () => {
      canvasRoot?.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        button: 0,
        clientX: 260,
        clientY: 260,
      }));
      canvasRoot?.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
        clientX: 261,
        clientY: 261,
      }));
    });

    expect(clearSelection).toHaveBeenCalledTimes(1);
    expect(setSelectedIds).not.toHaveBeenCalled();
  });

  it('非零 shell 偏移下框选 mouseup 命中正确扣除画布偏移', async () => {
    useStore.setState({
      selectedIds: [],
      layoutNotesById: createLayoutNotesById({
        'note-target': { id: 'note-target', boardId: 'default', x: 500, y: 500, width: 260, height: 200, z: 1, deletedAt: null, title: 't', content: 'c', color: '#fff', collapsed: false, createdAt: 1, updatedAt: 1 },
      }),
      boardNoteIds: { 'default': ['note-target'] },
    });

    await renderCanvas();

    const canvasRoot = container.firstElementChild as HTMLDivElement | null;
    canvasRoot!.getBoundingClientRect = vi.fn(() => ({
      left: 50,
      top: 80,
      right: 1330,
      bottom: 800,
      width: 1280,
      height: 720,
      x: 50,
      y: 80,
      toJSON: () => ({}),
    } as DOMRect));

    await act(async () => {
      canvasRoot?.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        button: 0,
        clientX: 100,
        clientY: 130,
      }));
      canvasRoot?.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        buttons: 1,
        clientX: 700,
        clientY: 700,
      }));
      canvasRoot?.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
        clientX: 700,
        clientY: 700,
      }));
    });

    expect(useStore.getState().selectedIds).toContain('note-target');
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

  it('Space 背景拖拽遵循抓手方向，向右下拖动时视口向左上移动', async () => {
    useStore.setState({
      interaction: {
        ...useStore.getState().interaction,
        isPanMode: true,
      },
    });

    await renderCanvas();

    const canvasRoot = container.firstElementChild as HTMLDivElement | null;
    const noteEl = container.querySelector('[data-id="note-1"]') as HTMLElement | null;
    const worldLayer = noteEl?.parentElement as HTMLElement | null;
    expect(canvasRoot).not.toBeNull();
    expect(worldLayer).not.toBeNull();

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
      rafCallbacks[0]?.(0);
    });

    expect(worldLayer?.style.transform).toBe('translate3d(-10px, -35px, 0)');
    expect(useStore.getState().viewport.x).toBe(10);
    expect(useStore.getState().viewport.y).toBe(35);

    await act(async () => {
      window.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
        clientX: 250,
        clientY: 265,
      }));
    });

    expect(useStore.getState().viewport.x).toBe(10);
    expect(useStore.getState().viewport.y).toBe(35);
  });

  it('边缘推动推进视口与选中便签世界坐标', async () => {
    useStore.setState({
      interaction: {
        ...useStore.getState().interaction,
        edgePush: { top: false, bottom: false, left: false, right: true },
      },
    });

    await renderCanvas();

    expect(rafMock).toHaveBeenCalledTimes(1);

    const noteEl = container.querySelector('[data-id="note-1"]') as HTMLElement | null;
    const worldLayer = noteEl?.parentElement as HTMLElement | null;
    expect(noteEl).not.toBeNull();
    expect(worldLayer).not.toBeNull();

    await act(async () => {
      rafCallbacks[0]?.(0);
    });

    expect(useStore.getState().viewport.x).toBe(45);
    expect(useStore.getState().viewport.y).toBe(60);
    expect(worldLayer?.style.transform).toBe('translate3d(-45px, -60px, 0)');
    expect(useStore.getState().notesById['note-1']?.x).toBe(125);
  });

  it('边缘推动拖拽 leader 时排除 leader，只移动 follower', async () => {
    const normalized = normalizeNotes([
      createNote({ id: 'leader', x: 100, y: 100 }),
      createNote({ id: 'follower', x: 300, y: 100, createdAt: 2 }),
    ]);
    useStore.setState({
      ...normalized,
      layoutNotesById: createLayoutNotesById(normalized.notesById),
      boardNoteIds: { 'default': ['leader', 'follower'] },
      selectedIds: ['leader', 'follower'],
      interaction: {
        ...useStore.getState().interaction,
        edgePush: { top: false, bottom: false, left: false, right: true },
      },
    });

    setEdgePushDragLeader('leader');
    setLastDraggablePosition(150, 100);

    await renderCanvas();

    expect(rafMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      rafCallbacks[0]?.(0);
    });

    expect(useStore.getState().notesById['leader']?.x).toBe(100);
    expect(useStore.getState().notesById['follower']?.x).toBe(305);
  });

  it('边缘推动拖拽期间累积增量跨帧保持 edgePush true', async () => {
    useStore.setState({
      interaction: {
        ...useStore.getState().interaction,
        edgePush: { top: false, bottom: false, left: false, right: true },
      },
    });

    setEdgePushDragLeader('note-1');
    setLastDraggablePosition(120, 140);

    await renderCanvas();

    expect(rafMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      rafCallbacks[0]?.(0);
    });

    expect(getEdgePushAccumulatedDelta().x).toBe(LAYOUT.EDGE_PUSH_SPEED);
    expect(useStore.getState().interaction.edgePush.right).toBe(true);

    await act(async () => {
      rafCallbacks[1]?.(0);
    });

    expect(getEdgePushAccumulatedDelta().x).toBe(LAYOUT.EDGE_PUSH_SPEED * 2);
    expect(useStore.getState().interaction.edgePush.right).toBe(true);
  });

  it('边缘推动 leader DOM 补偿应用到元素', async () => {
    const normalized = normalizeNotes([createNote({ id: 'note-1', x: 120, y: 140 })]);
    useStore.setState({
      ...normalized,
      layoutNotesById: createLayoutNotesById(normalized.notesById),
      interaction: {
        ...useStore.getState().interaction,
        edgePush: { top: false, bottom: false, left: false, right: true },
      },
    });

    setEdgePushDragLeader('note-1');
    setLastDraggablePosition(200, 140);

    await renderCanvas();

    const noteEl = container.querySelector('[data-id="note-1"]') as HTMLElement | null;
    expect(noteEl).not.toBeNull();

    await act(async () => {
      rafCallbacks[0]?.(0);
    });

    const expectedX = 200 + LAYOUT.EDGE_PUSH_SPEED;
    expect(noteEl?.style.transform).toBe(`translate(${expectedX}px, 140px)`);
  });

  it('边缘推动 leader 排除后最终位置含累积增量', async () => {
    const normalized = normalizeNotes([
      createNote({ id: 'leader', x: 100, y: 100 }),
    ]);
    useStore.setState({
      ...normalized,
      layoutNotesById: createLayoutNotesById(normalized.notesById),
      boardNoteIds: { 'default': ['leader'] },
      selectedIds: ['leader'],
      interaction: {
        ...useStore.getState().interaction,
        edgePush: { top: false, bottom: false, left: false, right: true },
      },
    });

    setEdgePushDragLeader('leader');
    setLastDraggablePosition(150, 100);

    await renderCanvas();

    await act(async () => {
      rafCallbacks[0]?.(0);
      rafCallbacks[1]?.(0);
      rafCallbacks[2]?.(0);
    });

    const delta = getEdgePushAccumulatedDelta();
    expect(delta.x).toBe(LAYOUT.EDGE_PUSH_SPEED * 3);

    const leaderStore = useStore.getState().notesById['leader'];
    expect(leaderStore?.x).toBe(100);

    const finalX = 150 + delta.x;
    expect(finalX).toBe(150 + LAYOUT.EDGE_PUSH_SPEED * 3);
  });

  it('edgePush 短暂归零时不会提前清空 leader drag session', async () => {
    useStore.setState({
      interaction: {
        ...useStore.getState().interaction,
        edgePush: { top: false, bottom: false, left: false, right: true },
      },
    });

    setEdgePushDragLeader('note-1');
    setLastDraggablePosition(200, 140);

    await renderCanvas();

    await act(async () => {
      rafCallbacks[0]?.(0);
    });

    expect(getEdgePushDragLeader()).toBe('note-1');
    expect(getEdgePushAccumulatedDelta().x).toBe(LAYOUT.EDGE_PUSH_SPEED);

    await act(async () => {
      useStore.getState().setEdgePush({ top: false, bottom: false, left: false, right: false });
    });

    expect(getEdgePushDragLeader()).toBe('note-1');
    expect(getEdgePushAccumulatedDelta().x).toBe(LAYOUT.EDGE_PUSH_SPEED);
  });

  it('窗口失焦时对称清理 dragging、edgePush 与 leader session', async () => {
    useStore.setState({
      interaction: {
        ...useStore.getState().interaction,
        isDragging: true,
        edgePush: { top: false, bottom: false, left: false, right: true },
      },
    });

    setEdgePushDragLeader('note-1');
    setLastDraggablePosition(200, 140);

    await renderCanvas();

    await act(async () => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(useStore.getState().interaction.isDragging).toBe(false);
    expect(useStore.getState().interaction.edgePush.right).toBe(false);
    expect(getEdgePushDragLeader()).toBeNull();
  });
});
