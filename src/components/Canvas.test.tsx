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
  DraggableCore: ({ children }: { children: React.ReactNode }) => children,
}));

const { mockSaveImageFromSystemClipboard, mockWriteAttachmentFromBytes, mockWriteAttachmentFromPath, mockDeleteAttachmentFile } = vi.hoisted(() => ({
  mockSaveImageFromSystemClipboard: vi.fn(async () => ({
    hash: 'a'.repeat(64),
    filename: 'clipboard-image.png',
    mimeType: 'image/png',
    size: 1024,
    relativePath: `attachments/${'a'.repeat(64)}.png`,
    createdAt: 1000,
    bytesWritten: 1024,
  })),
  mockWriteAttachmentFromPath: vi.fn(async (_sourcePath: string, filename: string, mimeType?: string) => ({
    hash: 'b'.repeat(64),
    filename,
    mimeType: mimeType ?? 'application/octet-stream',
    size: 2048,
    relativePath: `attachments/${'b'.repeat(64)}.png`,
    createdAt: 2000,
    bytesWritten: 2048,
  })),
  mockWriteAttachmentFromBytes: vi.fn(async (_data: ArrayBuffer | Uint8Array, filename: string, mimeType?: string) => ({
    hash: 'e'.repeat(64),
    filename,
    mimeType: mimeType ?? 'application/octet-stream',
    size: 5,
    relativePath: `attachments/${'e'.repeat(64)}.png`,
    createdAt: 2500,
    bytesWritten: 5,
  })),
  mockDeleteAttachmentFile: vi.fn(async (relativePath: string) => ({
    deleted: true,
    relativePath,
  })),
}));

vi.mock('../services/storage/attachmentPersistence', () => ({
  saveImageFromSystemClipboard: mockSaveImageFromSystemClipboard,
  writeAttachmentFromBytes: mockWriteAttachmentFromBytes,
  writeAttachmentFromPath: mockWriteAttachmentFromPath,
  deleteAttachmentFile: mockDeleteAttachmentFile,
}));

import { Canvas } from './Canvas';
import { useStore } from '../store/useStore';
import { normalizeNotes, createLayoutNotesById } from '../store/normalization';
import { Note } from '../store/types';
import { LAYOUT } from '../constants/layout';
import { resetViewportSpawnSequenceForTests } from '../utils/spawnPosition';
import {
  beginEdgePushDragSession,
  setEdgePushDragLeader,
  getEdgePushDragLeader,
  getEdgePushAccumulatedDelta,
  updateEdgePushPointerDelta,
} from '../utils/edgePushDragCompensation';
import { registerActiveNoteDragFinalizer } from '../utils/activeNoteDrag';
import { resolveDragStopWorldPosition } from '../utils/dragCoordinates';

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
    resetViewportSpawnSequenceForTests();
    setEdgePushDragLeader(null);
    mockSaveImageFromSystemClipboard.mockClear();
    mockWriteAttachmentFromBytes.mockClear();
    mockWriteAttachmentFromPath.mockClear();
    mockDeleteAttachmentFile.mockClear();
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

  it('画布获得粘贴事件时默认保留为一张便签', async () => {
    const addNotesWithContentBatch = vi.fn(() => ['new-note']);
    const openSmartPasteSplitPanel = vi.fn();
    useStore.setState({ addNotesWithContentBatch, openSmartPasteSplitPanel });

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

    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { getData: () => '第一行\n第二行' },
    });

    await act(async () => {
      canvasRoot?.dispatchEvent(pasteEvent);
    });

    expect(addNotesWithContentBatch).toHaveBeenCalledWith([
      { content: '第一行\n第二行', x: 550, y: 132 },
    ]);
    expect(openSmartPasteSplitPanel).toHaveBeenCalledWith({
      noteId: 'new-note',
      result: expect.objectContaining({ kind: 'lines', source: '第一行\n第二行' }),
    });
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

  it('画布根层可接收粘贴事件且不暴露默认焦点外框', async () => {
    await renderCanvas();

    const canvasRoot = container.firstElementChild as HTMLDivElement | null;

    expect(canvasRoot).not.toBeNull();
    expect(canvasRoot?.getAttribute('tabindex')).toBe('0');
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

  it('折叠便签只按当前可视高度命中，不会命中展开后才会占据的下方区域', async () => {
    const normalized = normalizeNotes([
      createNote({ id: 'note-collapsed', x: 120, y: 140, collapsed: true }),
    ]);
    useStore.setState({
      ...normalized,
      layoutNotesById: createLayoutNotesById(normalized.notesById),
      boardNoteIds: { 'default': ['note-collapsed'] },
      selectedIds: [],
      viewport: { x: 40, y: 60, w: 1280, h: 720 },
    });

    await renderCanvas();

    const canvasRoot = container.firstElementChild as HTMLDivElement | null;
    canvasRoot!.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      right: 1280,
      bottom: 720,
      width: 1280,
      height: 720,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect));

    await act(async () => {
      canvasRoot?.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        button: 0,
        clientX: 100,
        clientY: 120,
      }));
      canvasRoot?.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        buttons: 1,
        clientX: 200,
        clientY: 160,
      }));
      canvasRoot?.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
        clientX: 200,
        clientY: 160,
      }));
    });

    expect(useStore.getState().selectedIds).toEqual([]);
  });

  it('Shift 空框选保持旧选择，不会因为空结果覆盖已有选中项', async () => {
    useStore.setState({
      selectedIds: ['note-1'],
    });

    await renderCanvas();

    const canvasRoot = container.firstElementChild as HTMLDivElement | null;
    canvasRoot!.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      right: 1280,
      bottom: 720,
      width: 1280,
      height: 720,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect));

    await act(async () => {
      canvasRoot?.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        button: 0,
        clientX: 800,
        clientY: 500,
        shiftKey: true,
      }));
      canvasRoot?.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        buttons: 1,
        clientX: 860,
        clientY: 560,
        shiftKey: true,
      }));
      canvasRoot?.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
        clientX: 860,
        clientY: 560,
        shiftKey: true,
      }));
    });

    expect(useStore.getState().selectedIds).toEqual(['note-1']);
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

  it('leader drag session 活跃时即使 isDragging 为 false 也忽略空白画布双击与清空选择', async () => {
    const addNote = vi.fn();
    const clearSelection = vi.fn();
    useStore.setState({
      addNote,
      clearSelection,
      interaction: {
        isPanMode: false,
        isDragging: false,
        edgePush: { top: false, bottom: false, left: false, right: false },
      },
    });
    setEdgePushDragLeader('note-1');

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

  it('active DragSession 便签即使旧布局位置被虚拟化裁剪也会保持渲染', async () => {
    useStore.setState({
      viewport: { x: 2000, y: 60, w: 1280, h: 720 },
    });

    beginEdgePushDragSession('note-1', ['note-1'], {
      'note-1': { x: 120, y: 140 },
    });

    await renderCanvas();

    expect(container.querySelector('[data-id="note-1"]')).not.toBeNull();
  });

  it('没有 active DragSession 时视口外旧布局便签仍会被虚拟化裁剪', async () => {
    useStore.setState({
      viewport: { x: 2000, y: 60, w: 1280, h: 720 },
    });

    await renderCanvas();

    expect(container.querySelector('[data-id="note-1"]')).toBeNull();
  });

  it('拖拽中会临时禁用虚拟化，避免便签 DOM 被卸载导致 edgePush 中断', async () => {
    useStore.setState({
      viewport: { x: 2000, y: 60, w: 1280, h: 720 },
      interaction: {
        ...useStore.getState().interaction,
        isDragging: true,
      },
    });

    await renderCanvas();

    expect(container.querySelector('[data-id="note-1"]')).not.toBeNull();
  });

  it('sticky drag 中会临时禁用虚拟化，避免待放置便签被卸载', async () => {
    useStore.setState({
      viewport: { x: 2000, y: 60, w: 1280, h: 720 },
      stickyDrag: { id: 'note-1', offsetX: 20, offsetY: 20, status: 'active' },
    });

    await renderCanvas();

    expect(container.querySelector('[data-id="note-1"]')).not.toBeNull();
  });

  it('sticky drag 失焦时进入 suspended 状态而不是直接清空', async () => {
    useStore.setState({
      stickyDrag: { id: 'note-1', offsetX: 20, offsetY: 20, status: 'active' },
    });

    await renderCanvas();

    await act(async () => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(useStore.getState().stickyDrag).toEqual({
      id: 'note-1',
      offsetX: 20,
      offsetY: 20,
      status: 'suspended',
    });
    expect(container.textContent).toContain('吸附移动已暂停');
  });

  it('sticky drag 按 Escape 会取消并恢复预览位置', async () => {
    useStore.setState({
      stickyDrag: { id: 'note-1', offsetX: 20, offsetY: 20, status: 'active' },
    });

    await renderCanvas();

    const noteEl = container.querySelector('[data-id="note-1"]') as HTMLElement | null;
    expect(noteEl).not.toBeNull();

    noteEl!.style.transform = 'translate(500px, 600px)';

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(useStore.getState().stickyDrag.id).toBeNull();
    expect(noteEl?.style.transform).toBe('translate(120px, 140px)');
  });

  it('sticky 群组落位与普通拖拽一致，按单卡贴边语义分别结算', async () => {
    const normalized = normalizeNotes([
      createNote({ id: 'leader', x: 100, y: 100 }),
      createNote({ id: 'follower', x: 320, y: 130, createdAt: 2 }),
    ]);

    useStore.setState({
      ...normalized,
      layoutNotesById: createLayoutNotesById(normalized.notesById),
      boardNoteIds: { default: ['leader', 'follower'] },
      selectedIds: ['leader', 'follower'],
      stickyDrag: { id: 'leader', offsetX: 20, offsetY: 20, status: 'active' },
      viewport: { x: 0, y: 0, w: 1280, h: 720 },
    });

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

    const leaderEl = container.querySelector('[data-id="leader"]') as HTMLElement | null;
    const followerEl = container.querySelector('[data-id="follower"]') as HTMLElement | null;
    expect(leaderEl).not.toBeNull();
    expect(followerEl).not.toBeNull();

    await act(async () => {
      canvasRoot?.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        buttons: 1,
        clientX: 1130,
        clientY: 690,
      }));
    });

    expect(leaderEl!.style.transform).toBe('translate(1100px, 650px)');
    expect(followerEl!.style.transform).toBe('translate(1320px, 680px)');

    await act(async () => {
      canvasRoot?.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        button: 0,
        clientX: 260,
        clientY: 260,
      }));
    });

    const leader = useStore.getState().notesById['leader'];
    const follower = useStore.getState().notesById['follower'];
    const viewport = useStore.getState().viewport;
    const expectedLeader = resolveDragStopWorldPosition(
      1100,
      650,
      viewport,
      LAYOUT.NOTE_WIDTH,
      LAYOUT.NOTE_MIN_HEIGHT,
      false,
      10,
    );
    const expectedFollower = resolveDragStopWorldPosition(
      1320,
      680,
      viewport,
      LAYOUT.NOTE_WIDTH,
      LAYOUT.NOTE_MIN_HEIGHT,
      false,
      10,
    );

    expect(useStore.getState().stickyDrag.id).toBeNull();
    expect(leader?.x).toBe(expectedLeader.x);
    expect(leader?.y).toBe(expectedLeader.y);
    expect(follower?.x).toBe(expectedFollower.x);
    expect(follower?.y).toBe(expectedFollower.y);
  });

  it('普通虚拟化使用便签矩形相交判断，便签边缘进入缓冲区时仍会渲染', async () => {
    const wideNote = createNote({ x: 1740, y: 140 });
    const normalized = normalizeNotes([wideNote]);
    useStore.setState({
      ...normalized,
      layoutNotesById: createLayoutNotesById(normalized.notesById),
      viewport: { x: 2000, y: 60, w: 1280, h: 720 },
    });

    await renderCanvas();

    expect(container.querySelector('[data-id="note-1"]')).not.toBeNull();
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

  it('边缘推动拖拽会话中 viewport 与所有拖拽便签读取同一 DragSession 位置', async () => {
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

    beginEdgePushDragSession('leader', ['leader', 'follower'], {
      leader: { x: 100, y: 100 },
      follower: { x: 300, y: 100 },
    });
    updateEdgePushPointerDelta(50, 0);

    await renderCanvas();

    expect(rafMock).toHaveBeenCalledTimes(1);
    const leaderEl = container.querySelector('[data-id="leader"]') as HTMLElement | null;
    const followerEl = container.querySelector('[data-id="follower"]') as HTMLElement | null;

    await act(async () => {
      rafCallbacks[0]?.(0);
    });

    expect(useStore.getState().notesById['leader']?.x).toBe(100);
    expect(useStore.getState().notesById['follower']?.x).toBe(300);
    expect(leaderEl?.style.transform).toBe('translate(155px, 100px)');
    expect(followerEl?.style.transform).toBe('translate(355px, 100px)');
  });

  it('边缘推动拖拽期间累积增量跨帧保持 edgePush true', async () => {
    useStore.setState({
      interaction: {
        ...useStore.getState().interaction,
        edgePush: { top: false, bottom: false, left: false, right: true },
      },
    });

    beginEdgePushDragSession('note-1', ['note-1'], {
      'note-1': { x: 120, y: 140 },
    });

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

    beginEdgePushDragSession('note-1', ['note-1'], {
      'note-1': { x: 120, y: 140 },
    });
    updateEdgePushPointerDelta(80, 0);

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

    beginEdgePushDragSession('leader', ['leader'], {
      leader: { x: 100, y: 100 },
    });
    updateEdgePushPointerDelta(50, 0);

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

    beginEdgePushDragSession('note-1', ['note-1'], {
      'note-1': { x: 120, y: 140 },
    });
    updateEdgePushPointerDelta(80, 0);

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

  it('top-left 边缘推动在 viewport (0,0) 钳位时不累积幻影增量', async () => {
    useStore.setState({
      viewport: { x: 0, y: 0, w: 1280, h: 720 },
      interaction: {
        ...useStore.getState().interaction,
        edgePush: { top: true, bottom: false, left: true, right: false },
      },
    });

    beginEdgePushDragSession('note-1', ['note-1'], {
      'note-1': { x: 120, y: 140 },
    });

    await renderCanvas();

    expect(rafMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      rafCallbacks[0]?.(0);
    });

    expect(useStore.getState().viewport.x).toBe(0);
    expect(useStore.getState().viewport.y).toBe(0);
    expect(getEdgePushAccumulatedDelta().x).toBe(0);
    expect(getEdgePushAccumulatedDelta().y).toBe(0);

    await act(async () => {
      rafCallbacks[1]?.(0);
    });

    expect(useStore.getState().viewport.x).toBe(0);
    expect(useStore.getState().viewport.y).toBe(0);
    expect(getEdgePushAccumulatedDelta().x).toBe(0);
    expect(getEdgePushAccumulatedDelta().y).toBe(0);
  });

  it('top-left 边缘推动在 viewport (0,0) 时选中便签不因幻影增量移动', async () => {
    const moveSelectedNotes = vi.fn();
    useStore.setState({
      viewport: { x: 0, y: 0, w: 1280, h: 720 },
      moveSelectedNotes,
      interaction: {
        ...useStore.getState().interaction,
        edgePush: { top: true, bottom: false, left: true, right: false },
      },
    });

    await renderCanvas();

    expect(rafMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      rafCallbacks[0]?.(0);
    });

    expect(moveSelectedNotes).toHaveBeenCalledWith(0, 0, undefined);
  });

  it('窗口失焦时对称清理 dragging、edgePush 与 leader session', async () => {
    useStore.setState({
      interaction: {
        ...useStore.getState().interaction,
        isDragging: true,
        edgePush: { top: false, bottom: false, left: false, right: true },
      },
    });

    beginEdgePushDragSession('note-1', ['note-1'], {
      'note-1': { x: 120, y: 140 },
    });
    updateEdgePushPointerDelta(80, 0);

    await renderCanvas();

    await act(async () => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(useStore.getState().interaction.isDragging).toBe(false);
    expect(useStore.getState().interaction.edgePush.right).toBe(false);
    expect(getEdgePushDragLeader()).toBeNull();
  });

  it('窗口失焦会先触发普通便签拖拽收口，再执行全局拖拽清理', async () => {
    const activeDragFinalizer = vi.fn();
    registerActiveNoteDragFinalizer(activeDragFinalizer);
    document.body.classList.add('is-dragging');
    useStore.setState({
      interaction: {
        ...useStore.getState().interaction,
        isDragging: true,
        edgePush: { top: false, bottom: false, left: false, right: true },
      },
    });

    await renderCanvas();

    await act(async () => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(activeDragFinalizer).toHaveBeenCalledTimes(1);
    expect(activeDragFinalizer).toHaveBeenCalledWith('window-blur');
    expect(useStore.getState().interaction.isDragging).toBe(false);
    expect(useStore.getState().interaction.edgePush.right).toBe(false);
    expect(document.body.classList.contains('is-dragging')).toBe(false);
  });

  it('document.visibilitychange hidden 对称清理 dragging、edgePush 与 leader session', async () => {
    useStore.setState({
      interaction: {
        ...useStore.getState().interaction,
        isDragging: true,
        edgePush: { top: false, bottom: false, left: false, right: true },
      },
    });

    beginEdgePushDragSession('note-1', ['note-1'], {
      'note-1': { x: 120, y: 140 },
    });
    updateEdgePushPointerDelta(80, 0);

    await renderCanvas();

    await act(async () => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(useStore.getState().interaction.isDragging).toBe(false);
    expect(useStore.getState().interaction.edgePush.right).toBe(false);
    expect(getEdgePushDragLeader()).toBeNull();

    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  it('document.visibilitychange hidden 会先触发普通便签拖拽收口', async () => {
    const activeDragFinalizer = vi.fn();
    registerActiveNoteDragFinalizer(activeDragFinalizer);
    useStore.setState({
      interaction: {
        ...useStore.getState().interaction,
        isDragging: true,
        edgePush: { top: false, bottom: false, left: false, right: false },
      },
    });

    await renderCanvas();

    await act(async () => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(activeDragFinalizer).toHaveBeenCalledTimes(1);
    expect(activeDragFinalizer).toHaveBeenCalledWith('window-blur');
    expect(useStore.getState().interaction.isDragging).toBe(false);

    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  it('sticky drag 失焦时进入 suspended 状态 (visibilitychange hidden)', async () => {
    useStore.setState({
      stickyDrag: { id: 'note-1', offsetX: 20, offsetY: 20, status: 'active' },
    });

    await renderCanvas();

    await act(async () => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(useStore.getState().stickyDrag).toEqual({
      id: 'note-1',
      offsetX: 20,
      offsetY: 20,
      status: 'suspended',
    });

    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  it('document.visibilitychange visible 不触发清理', async () => {
    useStore.setState({
      interaction: {
        ...useStore.getState().interaction,
        isDragging: true,
        edgePush: { top: false, bottom: false, left: false, right: true },
      },
    });

    await renderCanvas();

    await act(async () => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(useStore.getState().interaction.isDragging).toBe(true);
    expect(useStore.getState().interaction.edgePush.right).toBe(true);
  });

  it('Space 双击重置视口到原点并退出平移模式', async () => {
    useStore.setState({
      interaction: {
        ...useStore.getState().interaction,
        isPanMode: true,
      },
      viewport: { x: 200, y: 300, w: 1280, h: 720 },
    });

    await renderCanvas();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
    });

    expect(useStore.getState().interaction.isPanMode).toBe(false);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
    });

    expect(useStore.getState().interaction.isPanMode).toBe(false);
    expect(useStore.getState().viewport.x).toBe(0);
    expect(useStore.getState().viewport.y).toBe(0);
  });

  it('contextMenu 事件阻止默认行为并打开菜单', async () => {
    const setContextMenu = vi.fn();
    useStore.setState({ setContextMenu });

    await renderCanvas();

    const canvasRoot = container.firstElementChild as HTMLDivElement | null;

    await act(async () => {
      canvasRoot?.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        clientX: 300,
        clientY: 400,
      }));
    });

    expect(setContextMenu).toHaveBeenCalledWith({
      isOpen: true,
      x: 300,
      y: 400,
      type: 'CANVAS',
    });
  });

  it('图片粘贴：单选一个未删除便签时在旁边创建图片便签', async () => {
    useStore.setState({ selectedIds: ['note-1'] });

    await renderCanvas();

    const canvasRoot = container.firstElementChild as HTMLDivElement | null;
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        getData: () => '',
        items: [{ type: 'image/png', kind: 'file' }],
      },
    });

    await act(async () => {
      canvasRoot?.dispatchEvent(pasteEvent);
    });

    expect(mockSaveImageFromSystemClipboard).toHaveBeenCalledTimes(1);
    const createdId = useStore.getState().selectedIds[0];
    expect(createdId).toBeTruthy();
    expect(createdId).not.toBe('note-1');
    expect(useStore.getState().notesById['note-1']?.attachments).toBeUndefined();

    const note = useStore.getState().notesById[createdId];
    expect(note?.kind).toBe('image');
    expect(note?.x).toBe(150);
    expect(note?.y).toBe(170);
    expect(note?.attachments).toEqual([
      expect.objectContaining({
        hash: 'a'.repeat(64),
        filename: 'clipboard-image.png',
        mimeType: 'image/png',
        relativePath: `attachments/${'a'.repeat(64)}.png`,
      }),
    ]);
  });

  it('图片粘贴：未选中便签时创建新便签并附加图片', async () => {
    useStore.setState({ selectedIds: [] });

    await renderCanvas();

    const canvasRoot = container.firstElementChild as HTMLDivElement | null;
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        getData: () => '',
        items: [{ type: 'image/png', kind: 'file' }],
      },
    });

    await act(async () => {
      canvasRoot?.dispatchEvent(pasteEvent);
    });

    expect(mockSaveImageFromSystemClipboard).toHaveBeenCalledTimes(1);
    const createdId = useStore.getState().selectedIds[0];
    expect(createdId).toBeTruthy();
    expect(useStore.getState().notesById[createdId]?.kind).toBe('image');
    expect(useStore.getState().notesById[createdId]?.attachments).toEqual([
      expect.objectContaining({
        hash: 'a'.repeat(64),
        filename: 'clipboard-image.png',
        mimeType: 'image/png',
        relativePath: `attachments/${'a'.repeat(64)}.png`,
      }),
    ]);
  });

  it('图片粘贴：多选便签时创建新便签而非批量追加', async () => {
    useStore.setState({ selectedIds: ['note-1', 'note-other'] });

    await renderCanvas();

    const canvasRoot = container.firstElementChild as HTMLDivElement | null;
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        getData: () => '',
        items: [{ type: 'image/jpeg', kind: 'file' }],
      },
    });

    await act(async () => {
      canvasRoot?.dispatchEvent(pasteEvent);
    });

    expect(mockSaveImageFromSystemClipboard).toHaveBeenCalledTimes(1);
    const createdId = useStore.getState().selectedIds[0];
    expect(createdId).toBeTruthy();
    expect(createdId).not.toBe('note-1');
    expect(createdId).not.toBe('note-other');
    expect(useStore.getState().notesById['note-1']?.attachments).toBeUndefined();
    expect(useStore.getState().notesById[createdId]?.kind).toBe('image');
    expect(useStore.getState().notesById[createdId]?.attachments).toEqual([
      expect.objectContaining({
        hash: 'a'.repeat(64),
        filename: 'clipboard-image.png',
        mimeType: 'image/png',
        relativePath: `attachments/${'a'.repeat(64)}.png`,
      }),
    ]);
  });

  it('图片粘贴：输入框/文本域内粘贴不触发 saveImageFromSystemClipboard', async () => {
    mockSaveImageFromSystemClipboard.mockClear();
    await renderCanvas();

    const canvasRoot = container.firstElementChild as HTMLDivElement | null;
    const input = document.createElement('input');
    canvasRoot!.appendChild(input);

    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        getData: () => '',
        items: [{ type: 'image/png', kind: 'file' }],
      },
    });

    await act(async () => {
      input.dispatchEvent(pasteEvent);
    });

    expect(mockSaveImageFromSystemClipboard).not.toHaveBeenCalled();

    input.remove();
  });

  it('图片粘贴：SVG 图片不进入图片路径，回退到文本智能粘贴', async () => {
    mockSaveImageFromSystemClipboard.mockClear();
    const addNotesWithContentBatch = vi.fn(() => ['svg-note']);
    useStore.setState({ addNotesWithContentBatch });

    await renderCanvas();

    const canvasRoot = container.firstElementChild as HTMLDivElement | null;
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        getData: () => 'some svg text',
        items: [{ type: 'image/svg+xml', kind: 'file' }],
      },
    });

    await act(async () => {
      canvasRoot?.dispatchEvent(pasteEvent);
    });

    expect(mockSaveImageFromSystemClipboard).not.toHaveBeenCalled();
    expect(addNotesWithContentBatch).toHaveBeenCalledTimes(1);
  });

  it('文本智能粘贴在图片粘贴实现后仍保持原行为', async () => {
    mockSaveImageFromSystemClipboard.mockClear();
    const addNotesWithContentBatch = vi.fn(() => ['text-note']);
    const openSmartPasteSplitPanel = vi.fn();
    useStore.setState({ addNotesWithContentBatch, openSmartPasteSplitPanel });

    await renderCanvas();

    const canvasRoot = container.firstElementChild as HTMLDivElement | null;
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { getData: () => '第一行\n第二行' },
    });

    await act(async () => {
      canvasRoot?.dispatchEvent(pasteEvent);
    });

    expect(mockSaveImageFromSystemClipboard).not.toHaveBeenCalled();
    expect(addNotesWithContentBatch).toHaveBeenCalledWith([
      { content: '第一行\n第二行', x: 550, y: 132 },
    ]);
    expect(openSmartPasteSplitPanel).toHaveBeenCalledWith({
      noteId: 'text-note',
      result: expect.objectContaining({ kind: 'lines', source: '第一行\n第二行' }),
    });
  });

  const createMockFile = (name: string, type: string, path?: string): File => {
    const file = new File(['dummy'], name, { type });
    if (path) {
      Object.defineProperty(file, 'path', { value: path, configurable: true });
    }
    return file;
  };

  const createFileDragEvent = (
    type: 'dragover' | 'drop',
    files: File[],
    options: { clientX?: number; clientY?: number; target?: Element } = {},
  ): Event => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const fileList = Object.assign(files, { item: (i: number) => files[i] ?? null });
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        types: ['Files'],
        files: fileList,
        items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
        dropEffect: 'none',
      },
    });
    if (options.clientX !== undefined) {
      Object.defineProperty(event, 'clientX', { value: options.clientX });
      Object.defineProperty(event, 'clientY', { value: options.clientY ?? 0 });
    }
    if (options.target) {
      Object.defineProperty(event, 'target', { value: options.target });
    }
    return event;
  };

  it('文件拖入 dragover 时阻止浏览器默认行为', async () => {
    await renderCanvas();

    const canvasRoot = container.firstElementChild as HTMLDivElement | null;
    const pngFile = createMockFile('test.png', 'image/png', '/path/to/test.png');
    const dragoverEvent = createFileDragEvent('dragover', [pngFile]);

    const preventDefaultSpy = vi.spyOn(dragoverEvent, 'preventDefault');

    await act(async () => {
      canvasRoot?.dispatchEvent(dragoverEvent);
    });

    expect(preventDefaultSpy).toHaveBeenCalledTimes(1);
  });

  it('文件拖到非空白目标时阻止默认行为但不创建便签', async () => {
    const addImageNotesBatch = vi.fn(() => []);
    useStore.setState({ addImageNotesBatch });

    await renderCanvas();

    const noteHeader = container.querySelector('.drag-handle') as HTMLElement | null;
    expect(noteHeader).not.toBeNull();

    const pngFile = createMockFile('test.png', 'image/png', '/path/to/test.png');
    const dropEvent = createFileDragEvent('drop', [pngFile], { target: noteHeader! });

    const preventDefaultSpy = vi.spyOn(dropEvent, 'preventDefault');

    await act(async () => {
      canvasRoot = container.firstElementChild as HTMLDivElement | null;
      canvasRoot?.dispatchEvent(dropEvent);
    });

    expect(preventDefaultSpy).toHaveBeenCalledTimes(1);
    expect(addImageNotesBatch).not.toHaveBeenCalled();
  });

  let canvasRoot: HTMLDivElement | null = null;

  it('拖入单张 PNG 到空白画布创建一个带附件的便签', async () => {
    await renderCanvas();

    canvasRoot = container.firstElementChild as HTMLDivElement | null;
    canvasRoot!.getBoundingClientRect = vi.fn(() => ({
      left: 10, top: 20, right: 1290, bottom: 740,
      width: 1280, height: 720, x: 10, y: 20, toJSON: () => ({}),
    } as DOMRect));

    const pngFile = createMockFile('photo.png', 'image/png', '/home/user/photo.png');
    const dropEvent = createFileDragEvent('drop', [pngFile], {
      clientX: 200, clientY: 300,
    });

    await act(async () => {
      canvasRoot?.dispatchEvent(dropEvent);
    });

    expect(mockWriteAttachmentFromPath).toHaveBeenCalledTimes(1);
    expect(mockWriteAttachmentFromPath).toHaveBeenCalledWith(
      '/home/user/photo.png', 'photo.png', 'image/png',
    );

    const state = useStore.getState();
    expect(state.selectedIds.length).toBe(1);
    const noteId = state.selectedIds[0];
    const note = state.notesById[noteId];
    expect(note).toBeDefined();
    expect(note!.kind).toBe('image');
    expect(note!.title).toBe('photo.png');
    expect(note!.editingWidth).toBe(LAYOUT.IMAGE_NOTE_WIDTH);
    expect(note!.editingHeight).toBe(LAYOUT.IMAGE_NOTE_HEIGHT);
    expect(note!.attachments).toBeDefined();
    expect(note!.attachments!.length).toBe(1);
    expect(note!.attachments![0].filename).toBe('photo.png');
    expect(note!.attachments![0].hash).toBe('b'.repeat(64));
  });

  it('拖入无本地路径的 PNG 时走字节写入回退', async () => {
    await renderCanvas();

    canvasRoot = container.firstElementChild as HTMLDivElement | null;
    canvasRoot!.getBoundingClientRect = vi.fn(() => ({
      left: 10, top: 20, right: 1290, bottom: 740,
      width: 1280, height: 720, x: 10, y: 20, toJSON: () => ({}),
    } as DOMRect));

    const pngFile = createMockFile('drop.png', 'image/png');
    const dropEvent = createFileDragEvent('drop', [pngFile], {
      clientX: 200, clientY: 300,
    });

    await act(async () => {
      canvasRoot?.dispatchEvent(dropEvent);
    });

    expect(mockWriteAttachmentFromPath).not.toHaveBeenCalled();
    expect(mockWriteAttachmentFromBytes).toHaveBeenCalledTimes(1);
    expect(mockWriteAttachmentFromBytes).toHaveBeenCalledWith(
      expect.any(ArrayBuffer), 'drop.png', 'image/png',
    );

    const state = useStore.getState();
    const note = state.notesById[state.selectedIds[0]];
    expect(note?.kind).toBe('image');
    expect(note?.title).toBe('drop.png');
    expect(note?.attachments?.[0].filename).toBe('drop.png');
    expect(note?.attachments?.[0].hash).toBe('e'.repeat(64));
  });

  it('拖入多张图片创建多张层叠便签，一条撤销移除全部', async () => {
    mockWriteAttachmentFromPath.mockClear();
    let hashCounter = 0;
    mockWriteAttachmentFromPath.mockImplementation(async (_sp: string, filename: string, mimeType?: string) => {
      hashCounter += 1;
      const hash = hashCounter.toString().padStart(64, 'c');
      return {
        hash,
        filename,
        mimeType: mimeType ?? 'application/octet-stream',
        size: 1024,
        relativePath: `attachments/${hash}.png`,
        createdAt: 3000 + hashCounter,
        bytesWritten: 1024,
      };
    });

    await renderCanvas();

    canvasRoot = container.firstElementChild as HTMLDivElement | null;
    canvasRoot!.getBoundingClientRect = vi.fn(() => ({
      left: 0, top: 0, right: 1280, bottom: 720,
      width: 1280, height: 720, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect));

    const file1 = createMockFile('a.png', 'image/png', '/a.png');
    const file2 = createMockFile('b.jpg', 'image/jpeg', '/b.jpg');
    const file3 = createMockFile('c.webp', 'image/webp', '/c.webp');
    const dropEvent = createFileDragEvent('drop', [file1, file2, file3], {
      clientX: 100, clientY: 200,
    });

    await act(async () => {
      canvasRoot?.dispatchEvent(dropEvent);
    });

    expect(mockWriteAttachmentFromPath).toHaveBeenCalledTimes(3);

    const state = useStore.getState();
    expect(state.selectedIds.length).toBe(3);

    const note1 = state.notesById[state.selectedIds[0]];
    const note2 = state.notesById[state.selectedIds[1]];
    const note3 = state.notesById[state.selectedIds[2]];
    expect(note1).toBeDefined();
    expect(note2).toBeDefined();
    expect(note3).toBeDefined();

    expect(note1!.x).toBe(140);
    expect(note1!.y).toBe(260);
    expect(note2!.x).toBe(170);
    expect(note2!.y).toBe(290);
    expect(note3!.x).toBe(200);
    expect(note3!.y).toBe(320);

    expect(note1!.attachments![0].filename).toBe('a.png');
    expect(note2!.attachments![0].filename).toBe('b.jpg');
    expect(note3!.attachments![0].filename).toBe('c.webp');

    expect(state.domainHistory.undoStack.length).toBeGreaterThan(0);
    const lastEntry = state.domainHistory.undoStack[state.domainHistory.undoStack.length - 1];
    expect(lastEntry.label).toBe('create-image-notes');

    const undoResult = useStore.getState().undoDomainChange();
    expect(undoResult).toBe(true);

    const afterUndo = useStore.getState();
    expect(afterUndo.notesById[state.selectedIds[0]]).toBeUndefined();
    expect(afterUndo.notesById[state.selectedIds[1]]).toBeUndefined();
    expect(afterUndo.notesById[state.selectedIds[2]]).toBeUndefined();
    expect(afterUndo.selectedIds.length).toBe(0);

    mockWriteAttachmentFromPath.mockImplementation(async (_sp: string, filename: string, mimeType?: string) => ({
      hash: 'b'.repeat(64),
      filename,
      mimeType: mimeType ?? 'application/octet-stream',
      size: 2048,
      relativePath: `attachments/${'b'.repeat(64)}.png`,
      createdAt: 2000,
      bytesWritten: 2048,
    }));
  });

  it('拖入 SVG 和非图片文件被拒绝，不创建便签', async () => {
    const addImageNotesBatch = vi.fn(() => []);
    useStore.setState({ addImageNotesBatch });
    mockWriteAttachmentFromPath.mockClear();

    await renderCanvas();

    canvasRoot = container.firstElementChild as HTMLDivElement | null;
    canvasRoot!.getBoundingClientRect = vi.fn(() => ({
      left: 0, top: 0, right: 1280, bottom: 720,
      width: 1280, height: 720, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect));

    const svgFile = createMockFile('icon.svg', 'image/svg+xml', '/icon.svg');
    const txtFile = createMockFile('readme.txt', 'text/plain', '/readme.txt');
    const dropEvent = createFileDragEvent('drop', [svgFile, txtFile], {
      clientX: 100, clientY: 200,
    });

    await act(async () => {
      canvasRoot?.dispatchEvent(dropEvent);
    });

    expect(mockWriteAttachmentFromPath).not.toHaveBeenCalled();
    expect(addImageNotesBatch).not.toHaveBeenCalled();
  });

  it('writeAttachmentFromPath 部分失败时只创建成功的便签', async () => {
    mockWriteAttachmentFromPath.mockClear();
    let callCount = 0;
    mockWriteAttachmentFromPath.mockImplementation(async (_sp: string, filename: string, mimeType?: string) => {
      callCount += 1;
      if (callCount === 2) {
        throw new Error('磁盘空间不足');
      }
      const hash = callCount.toString().padStart(64, 'd');
      return {
        hash,
        filename,
        mimeType: mimeType ?? 'application/octet-stream',
        size: 1024,
        relativePath: `attachments/${hash}.png`,
        createdAt: 4000 + callCount,
        bytesWritten: 1024,
      };
    });

    await renderCanvas();

    canvasRoot = container.firstElementChild as HTMLDivElement | null;
    canvasRoot!.getBoundingClientRect = vi.fn(() => ({
      left: 0, top: 0, right: 1280, bottom: 720,
      width: 1280, height: 720, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect));

    const file1 = createMockFile('ok1.png', 'image/png', '/ok1.png');
    const file2 = createMockFile('fail.png', 'image/png', '/fail.png');
    const file3 = createMockFile('ok3.png', 'image/png', '/ok3.png');
    const dropEvent = createFileDragEvent('drop', [file1, file2, file3], {
      clientX: 100, clientY: 200,
    });

    await act(async () => {
      canvasRoot?.dispatchEvent(dropEvent);
    });

    expect(mockWriteAttachmentFromPath).toHaveBeenCalledTimes(3);

    const state = useStore.getState();
    expect(state.selectedIds.length).toBe(2);
    const note1 = state.notesById[state.selectedIds[0]];
    const note2 = state.notesById[state.selectedIds[1]];
    expect(note1).toBeDefined();
    expect(note1!.attachments![0].filename).toBe('ok1.png');
    expect(note2).toBeDefined();
    expect(note2!.attachments![0].filename).toBe('ok3.png');

    mockWriteAttachmentFromPath.mockImplementation(async (_sp: string, filename: string, mimeType?: string) => ({
      hash: 'b'.repeat(64),
      filename,
      mimeType: mimeType ?? 'application/octet-stream',
      size: 2048,
      relativePath: `attachments/${'b'.repeat(64)}.png`,
      createdAt: 2000,
      bytesWritten: 2048,
    }));
  });
});
