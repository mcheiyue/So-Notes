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

const mockLocateDetachedNote = vi.fn();
const mockToggleDetachedNotePin = vi.fn();
const mockCloseDetachedNote = vi.fn();

vi.mock('../controllers/appController', () => ({
  appController: {
    locateDetachedNote: (...args: unknown[]) => mockLocateDetachedNote(...args),
    toggleDetachedNotePin: (...args: unknown[]) => mockToggleDetachedNotePin(...args),
    closeDetachedNote: (...args: unknown[]) => mockCloseDetachedNote(...args),
  },
}));

import { DetachedNoteOverlay } from './DetachedNoteOverlay';
import { useUIStore, createInitialUIState } from '../store/uiStore';
import { useStore } from '../store/useStore';
import { createEmptyNormalizedNotesState } from '../store/normalization';
import type { Note } from '../store/types';

const resetUIStore = () => {
  useUIStore.getState().replaceUIState(createInitialUIState());
};

const createTestNote = (overrides: Partial<Note> = {}): Note => ({
  id: 'note-test-1',
  boardId: 'default',
  title: '测试标题',
  content: '测试正文内容',
  x: 100,
  y: 200,
  z: 1,
  color: '#FFFFFF',
  collapsed: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

describe('DetachedNoteOverlay 渲染', () => {
  let container: HTMLDivElement;
  let overlayRoot: HTMLDivElement;
  let root: Root;

  const renderOverlay = async () => {
    await act(async () => {
      root.render(<DetachedNoteOverlay />);
    });
  };

  beforeEach(() => {
    resetUIStore();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0 }],
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
    });

    container = document.createElement('div');
    document.body.appendChild(container);

    overlayRoot = document.createElement('div');
    overlayRoot.id = 'overlay-root';
    document.body.appendChild(overlayRoot);

    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    overlayRoot.remove();
  });

  it('detachedNotes 为空时不渲染任何内容', async () => {
    await renderOverlay();

    expect(overlayRoot.children.length).toBe(0);
  });

  it('有 detachedNotes 时通过 portal 渲染到 #overlay-root', async () => {
    const note = createTestNote();
    useStore.setState({
      notesById: { [note.id]: note },
      allNoteIds: [note.id],
    });
    useUIStore.getState().addDetachedNote(note.id, { x: 150, y: 250 });

    await renderOverlay();

    const overlay = overlayRoot.querySelector('[data-testid="detached-note-overlay"]');
    expect(overlay).not.toBeNull();

    const shell = overlayRoot.querySelector(`[data-testid="detached-note-shell-${note.id}"]`);
    expect(shell).not.toBeNull();
  });

  it('支持渲染多个撕下视图', async () => {
    const note1 = createTestNote({ id: 'n1', title: '便签一' });
    const note2 = createTestNote({ id: 'n2', title: '便签二' });
    useStore.setState({
      notesById: { [note1.id]: note1, [note2.id]: note2 },
      allNoteIds: [note1.id, note2.id],
    });
    useUIStore.getState().addDetachedNote('n1', { x: 10, y: 20 });
    useUIStore.getState().addDetachedNote('n2', { x: 300, y: 400 });

    await renderOverlay();

    const shell1 = overlayRoot.querySelector('[data-testid="detached-note-shell-n1"]');
    const shell2 = overlayRoot.querySelector('[data-testid="detached-note-shell-n2"]');
    expect(shell1).not.toBeNull();
    expect(shell2).not.toBeNull();
  });

  it('每个撕下视图定位在 UI state 中记录的位置', async () => {
    const note = createTestNote();
    useStore.setState({
      notesById: { [note.id]: note },
      allNoteIds: [note.id],
    });
    useUIStore.getState().addDetachedNote(note.id, { x: 123, y: 456 });

    await renderOverlay();

    const shell = overlayRoot.querySelector(
      `[data-testid="detached-note-shell-${note.id}"]`,
    ) as HTMLElement | null;
    expect(shell).not.toBeNull();
    expect(shell!.style.left).toBe('123px');
    expect(shell!.style.top).toBe('456px');
  });

  it('便签不存在时该撕下视图不渲染', async () => {
    useUIStore.getState().addDetachedNote('nonexistent', { x: 10, y: 20 });

    await renderOverlay();

    const shell = overlayRoot.querySelector('[data-testid="detached-note-shell-nonexistent"]');
    expect(shell).toBeNull();
  });

  it('主题切换后撕下视图同步更新深色便签材质', async () => {
    const note = createTestNote({ color: '#FFFFFF' });
    useStore.setState({
      notesById: { [note.id]: note },
      allNoteIds: [note.id],
      config: { ...useStore.getState().config, themeMode: 'light' },
    });
    useUIStore.getState().addDetachedNote(note.id, { x: 150, y: 250 });

    await renderOverlay();

    const visuals = overlayRoot.querySelector('[data-note-visuals="true"]') as HTMLElement | null;
    expect(visuals?.style.backgroundColor).toBe('rgb(255, 255, 255)');

    await act(async () => {
      useStore.setState({
        config: { ...useStore.getState().config, themeMode: 'dark' },
      });
    });

    expect(visuals?.style.backgroundColor).toBe('rgb(19, 30, 49)');
  });

  it('#overlay-root 不存在时组件不崩溃', async () => {
    overlayRoot.remove();

    useUIStore.getState().addDetachedNote('n1', { x: 10, y: 20 });

    await renderOverlay();

    expect(container.children.length).toBe(0);
  });
});

describe('DetachedNoteOverlay 拖拽移动', () => {
  let container: HTMLDivElement;
  let overlayRoot: HTMLDivElement;
  let root: Root;

  const renderOverlay = async () => {
    await act(async () => {
      root.render(<DetachedNoteOverlay />);
    });
  };

  beforeEach(() => {
    resetUIStore();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0 }],
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
    });

    container = document.createElement('div');
    document.body.appendChild(container);

    overlayRoot = document.createElement('div');
    overlayRoot.id = 'overlay-root';
    document.body.appendChild(overlayRoot);

    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    overlayRoot.remove();
  });

  it('拖拽后更新对应记录的位置', async () => {
    const note = createTestNote();
    useStore.setState({
      notesById: { [note.id]: note },
      allNoteIds: [note.id],
    });
    useUIStore.getState().addDetachedNote(note.id, { x: 100, y: 200 });

    await renderOverlay();

    const handle = overlayRoot.querySelector(
      `[data-testid="detached-note-drag-handle-${note.id}"]`,
    ) as HTMLElement | null;
    expect(handle).not.toBeNull();

    await act(async () => {
      handle!.dispatchEvent(
        new MouseEvent('mousedown', { clientX: 150, clientY: 220, bubbles: true }),
      );
    });

    await act(async () => {
      document.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 200, clientY: 280, bubbles: true }),
      );
    });

    const afterMove = useUIStore.getState().detachedNotes.find((d) => d.noteId === note.id);
    expect(afterMove?.position).toEqual({ x: 150, y: 260 });

    await act(async () => {
      document.dispatchEvent(
        new MouseEvent('mouseup', { clientX: 200, clientY: 280, bubbles: true }),
      );
    });

    const afterUp = useUIStore.getState().detachedNotes.find((d) => d.noteId === note.id);
    expect(afterUp?.position).toEqual({ x: 150, y: 260 });
  });

  it('在浮层上松开鼠标后停止拖拽', async () => {
    const note = createTestNote();
    useStore.setState({
      notesById: { [note.id]: note },
      allNoteIds: [note.id],
    });
    useUIStore.getState().addDetachedNote(note.id, { x: 100, y: 200 });

    await renderOverlay();

    const handle = overlayRoot.querySelector(
      `[data-testid="detached-note-drag-handle-${note.id}"]`,
    ) as HTMLElement | null;
    const shell = overlayRoot.querySelector(
      `[data-testid="detached-note-shell-${note.id}"]`,
    ) as HTMLElement | null;
    expect(handle).not.toBeNull();
    expect(shell).not.toBeNull();

    await act(async () => {
      handle!.dispatchEvent(
        new MouseEvent('mousedown', { clientX: 150, clientY: 220, bubbles: true }),
      );
      document.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 180, clientY: 250, bubbles: true }),
      );
      shell!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    const afterShellUp = useUIStore.getState().detachedNotes.find((d) => d.noteId === note.id);
    expect(afterShellUp?.position).toEqual({ x: 130, y: 230 });

    await act(async () => {
      document.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 230, clientY: 300, bubbles: true }),
      );
    });

    const afterExtraMove = useUIStore.getState().detachedNotes.find((d) => d.noteId === note.id);
    expect(afterExtraMove?.position).toEqual({ x: 130, y: 230 });
  });

  it('拖拽只影响被拖拽记录的位置，不影响其他记录', async () => {
    const note1 = createTestNote({ id: 'n1' });
    const note2 = createTestNote({ id: 'n2' });
    useStore.setState({
      notesById: { [note1.id]: note1, [note2.id]: note2 },
      allNoteIds: [note1.id, note2.id],
    });
    useUIStore.getState().addDetachedNote('n1', { x: 100, y: 200 });
    useUIStore.getState().addDetachedNote('n2', { x: 500, y: 600 });

    await renderOverlay();

    const handle1 = overlayRoot.querySelector(
      '[data-testid="detached-note-drag-handle-n1"]',
    ) as HTMLElement;

    await act(async () => {
      handle1.dispatchEvent(
        new MouseEvent('mousedown', { clientX: 150, clientY: 220, bubbles: true }),
      );
    });

    await act(async () => {
      document.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 250, clientY: 320, bubbles: true }),
      );
    });

    const entry1 = useUIStore.getState().detachedNotes.find((d) => d.noteId === 'n1');
    const entry2 = useUIStore.getState().detachedNotes.find((d) => d.noteId === 'n2');
    expect(entry1?.position).toEqual({ x: 200, y: 300 });
    expect(entry2?.position).toEqual({ x: 500, y: 600 });

    await act(async () => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
  });
});

describe('DetachedNoteOverlay 按钮行为', () => {
  let container: HTMLDivElement;
  let overlayRoot: HTMLDivElement;
  let root: Root;

  const renderOverlay = async () => {
    await act(async () => {
      root.render(<DetachedNoteOverlay />);
    });
  };

  beforeEach(() => {
    resetUIStore();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0 }],
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
      notesById: {
        'note-test-1': createTestNote(),
      },
      allNoteIds: ['note-test-1'],
    });
    useUIStore.getState().addDetachedNote('note-test-1', { x: 100, y: 200 });

    container = document.createElement('div');
    document.body.appendChild(container);

    overlayRoot = document.createElement('div');
    overlayRoot.id = 'overlay-root';
    document.body.appendChild(overlayRoot);

    root = createRoot(container);

    mockLocateDetachedNote.mockClear();
    mockToggleDetachedNotePin.mockClear();
    mockCloseDetachedNote.mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    overlayRoot.remove();
  });

  it('点击定位按钮调用 appController.locateDetachedNote', async () => {
    await renderOverlay();

    const locateBtn = overlayRoot.querySelector(
      '[data-testid="detached-note-locate-note-test-1"]',
    ) as HTMLButtonElement;
    expect(locateBtn).not.toBeNull();

    await act(async () => {
      locateBtn.click();
    });

    expect(mockLocateDetachedNote).toHaveBeenCalledWith('note-test-1');
    expect(mockLocateDetachedNote).toHaveBeenCalledTimes(1);
  });

  it('点击置顶按钮调用 appController.toggleDetachedNotePin', async () => {
    await renderOverlay();

    const pinBtn = overlayRoot.querySelector(
      '[data-testid="detached-note-pin-note-test-1"]',
    ) as HTMLButtonElement;
    expect(pinBtn).not.toBeNull();

    await act(async () => {
      pinBtn.click();
    });

    expect(mockToggleDetachedNotePin).toHaveBeenCalledWith('note-test-1');
    expect(mockToggleDetachedNotePin).toHaveBeenCalledTimes(1);
  });

  it('点击贴回画布按钮调用 appController.closeDetachedNote', async () => {
    await renderOverlay();

    const stickBackBtn = overlayRoot.querySelector(
      '[data-testid="detached-note-stick-back-note-test-1"]',
    ) as HTMLButtonElement;
    expect(stickBackBtn).not.toBeNull();

    await act(async () => {
      stickBackBtn.click();
    });

    expect(mockCloseDetachedNote).toHaveBeenCalledWith('note-test-1');
    expect(mockCloseDetachedNote).toHaveBeenCalledTimes(1);
  });

  it('三个按钮均有可访问的 aria-label', async () => {
    await renderOverlay();

    const locateBtn = overlayRoot.querySelector('[data-testid="detached-note-locate-note-test-1"]');
    const pinBtn = overlayRoot.querySelector('[data-testid="detached-note-pin-note-test-1"]');
    const stickBackBtn = overlayRoot.querySelector('[data-testid="detached-note-stick-back-note-test-1"]');

    expect(locateBtn?.getAttribute('aria-label')).toBe('定位到画布所在');
    expect(pinBtn?.getAttribute('aria-label')).toBe('置顶');
    expect(stickBackBtn?.getAttribute('aria-label')).toBe('贴回画布');
  });

  it('按钮 mousedown 不触发浮层拖拽', async () => {
    await renderOverlay();

    const locateBtn = overlayRoot.querySelector(
      '[data-testid="detached-note-locate-note-test-1"]',
    ) as HTMLButtonElement;

    await act(async () => {
      locateBtn.dispatchEvent(
        new MouseEvent('mousedown', { clientX: 120, clientY: 220, bubbles: true }),
      );
      document.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 200, clientY: 300, bubbles: true }),
      );
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    const entry = useUIStore.getState().detachedNotes.find((d) => d.noteId === 'note-test-1');
    expect(entry?.position).toEqual({ x: 100, y: 200 });
  });

  it('浮层内容事件不会通过 Portal 冒泡到 React 祖先', async () => {
    const ancestorMouseDown = vi.fn();
    const ancestorClick = vi.fn();
    const ancestorContextMenu = vi.fn();

    await act(async () => {
      root.render(
        <div
          onMouseDown={ancestorMouseDown}
          onClick={ancestorClick}
          onContextMenu={ancestorContextMenu}
        >
          <DetachedNoteOverlay />
        </div>,
      );
    });

    const shell = overlayRoot.querySelector(
      '[data-testid="detached-note-shell-note-test-1"]',
    ) as HTMLElement | null;
    expect(shell).not.toBeNull();

    await act(async () => {
      shell!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      shell!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const contextMenuEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      shell!.dispatchEvent(contextMenuEvent);
    });

    expect(ancestorMouseDown).not.toHaveBeenCalled();
    expect(ancestorClick).not.toHaveBeenCalled();
    expect(ancestorContextMenu).not.toHaveBeenCalled();
    expect(contextMenuEvent.defaultPrevented).toBe(true);
  });

  it('置顶状态时 pin 按钮 aria-label 变为取消置顶', async () => {
    useUIStore.getState().toggleDetachedNotePin('note-test-1');

    await renderOverlay();

    const pinBtn = overlayRoot.querySelector('[data-testid="detached-note-pin-note-test-1"]');
    expect(pinBtn?.getAttribute('aria-label')).toBe('取消置顶');
  });
});

describe('DetachedNoteOverlay Note 同步', () => {
  let container: HTMLDivElement;
  let overlayRoot: HTMLDivElement;
  let root: Root;

  const renderOverlay = async () => {
    await act(async () => {
      root.render(<DetachedNoteOverlay />);
    });
  };

  beforeEach(() => {
    resetUIStore();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0 }],
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
    });

    container = document.createElement('div');
    document.body.appendChild(container);

    overlayRoot = document.createElement('div');
    overlayRoot.id = 'overlay-root';
    document.body.appendChild(overlayRoot);

    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    overlayRoot.remove();
  });

  it('标题变更后撕下视图同步更新', async () => {
    const note = createTestNote();
    useStore.setState({
      notesById: { [note.id]: note },
      allNoteIds: [note.id],
    });
    useUIStore.getState().addDetachedNote(note.id, { x: 100, y: 200 });

    await renderOverlay();

    const titleEl = overlayRoot.querySelector(
      `[data-testid="detached-note-shell-${note.id}"]`,
    );
    expect(titleEl?.textContent).toContain('测试标题');

    await act(async () => {
      useStore.setState({
        notesById: {
          [note.id]: { ...note, title: '更新后的标题' },
        },
      });
    });

    expect(titleEl?.textContent).toContain('更新后的标题');
  });

  it('内容变更后撕下视图同步更新', async () => {
    const note = createTestNote();
    useStore.setState({
      notesById: { [note.id]: note },
      allNoteIds: [note.id],
    });
    useUIStore.getState().addDetachedNote(note.id, { x: 100, y: 200 });

    await renderOverlay();

    const shell = overlayRoot.querySelector(
      `[data-testid="detached-note-shell-${note.id}"]`,
    );
    expect(shell?.textContent).toContain('测试正文内容');

    await act(async () => {
      useStore.setState({
        notesById: {
          [note.id]: { ...note, content: '新的正文' },
        },
      });
    });

    expect(shell?.textContent).toContain('新的正文');
  });

  it('颜色变更后撕下视图同步更新', async () => {
    const note = createTestNote({ color: '#FF0000' });
    useStore.setState({
      notesById: { [note.id]: note },
      allNoteIds: [note.id],
    });
    useUIStore.getState().addDetachedNote(note.id, { x: 100, y: 200 });

    await renderOverlay();

    await act(async () => {
      useStore.setState({
        notesById: {
          [note.id]: { ...note, color: '#00FF00' },
        },
      });
    });

    const shell = overlayRoot.querySelector(
      `[data-testid="detached-note-shell-${note.id}"]`,
    );
    expect(shell).not.toBeNull();

    const visuals = shell?.querySelector('[data-note-visuals="true"]') as HTMLElement | null;
    expect(visuals?.style.backgroundColor).toBe('rgb(0, 255, 0)');
  });

  it('折叠状态变更后撕下视图同步更新', async () => {
    const note = createTestNote({ collapsed: false, content: '折叠后应隐藏的正文' });
    useStore.setState({
      notesById: { [note.id]: note },
      allNoteIds: [note.id],
    });
    useUIStore.getState().addDetachedNote(note.id, { x: 100, y: 200 });

    await renderOverlay();

    await act(async () => {
      useStore.setState({
        notesById: {
          [note.id]: { ...note, collapsed: true },
        },
      });
    });

    const shell = overlayRoot.querySelector(
      `[data-testid="detached-note-shell-${note.id}"]`,
    );
    expect(shell).not.toBeNull();
    expect(shell?.textContent).toContain('测试标题');
    expect(shell?.textContent).not.toContain('折叠后应隐藏的正文');
  });
});

describe('DetachedNoteOverlay 自动关闭', () => {
  let container: HTMLDivElement;
  let overlayRoot: HTMLDivElement;
  let root: Root;

  const renderOverlay = async () => {
    await act(async () => {
      root.render(<DetachedNoteOverlay />);
    });
  };

  beforeEach(() => {
    resetUIStore();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0 }],
      currentBoardId: 'default',
      config: { ...useStore.getState().config, maxZ: 1 },
    });

    container = document.createElement('div');
    document.body.appendChild(container);

    overlayRoot = document.createElement('div');
    overlayRoot.id = 'overlay-root';
    document.body.appendChild(overlayRoot);

    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    overlayRoot.remove();
  });

  it('便签从 notesById 移除后撕下视图自动关闭', async () => {
    const note = createTestNote();
    useStore.setState({
      notesById: { [note.id]: note },
      allNoteIds: [note.id],
    });
    useUIStore.getState().addDetachedNote(note.id, { x: 100, y: 200 });

    await renderOverlay();

    const shell = overlayRoot.querySelector(
      `[data-testid="detached-note-shell-${note.id}"]`,
    );
    expect(shell).not.toBeNull();
    expect(useUIStore.getState().detachedNotes).toHaveLength(1);

    await act(async () => {
      useStore.setState({
        notesById: {},
        allNoteIds: [],
      });
    });

    expect(useUIStore.getState().detachedNotes).toHaveLength(0);
    const shellAfter = overlayRoot.querySelector(
      `[data-testid="detached-note-shell-${note.id}"]`,
    );
    expect(shellAfter).toBeNull();
  });

  it('软删除便签后撕下视图自动关闭', async () => {
    const note = createTestNote();
    useStore.setState({
      notesById: { [note.id]: note },
      allNoteIds: [note.id],
    });
    useUIStore.getState().addDetachedNote(note.id, { x: 100, y: 200 });

    await renderOverlay();

    const shell = overlayRoot.querySelector(
      `[data-testid="detached-note-shell-${note.id}"]`,
    );
    expect(shell).not.toBeNull();
    expect(useUIStore.getState().detachedNotes).toHaveLength(1);

    await act(async () => {
      useStore.setState({
        notesById: {
          [note.id]: { ...note, deletedAt: Date.now() },
        },
      });
    });

    expect(useUIStore.getState().detachedNotes).toHaveLength(0);
    const shellAfter = overlayRoot.querySelector(
      `[data-testid="detached-note-shell-${note.id}"]`,
    );
    expect(shellAfter).toBeNull();
  });

  it('多个撕下视图中只有一个因便签消失而关闭', async () => {
    const note1 = createTestNote({ id: 'n1' });
    const note2 = createTestNote({ id: 'n2' });
    useStore.setState({
      notesById: { [note1.id]: note1, [note2.id]: note2 },
      allNoteIds: [note1.id, note2.id],
    });
    useUIStore.getState().addDetachedNote('n1', { x: 10, y: 20 });
    useUIStore.getState().addDetachedNote('n2', { x: 300, y: 400 });

    await renderOverlay();

    expect(useUIStore.getState().detachedNotes).toHaveLength(2);

    await act(async () => {
      useStore.setState({
        notesById: { [note2.id]: note2 },
        allNoteIds: [note2.id],
      });
    });

    expect(useUIStore.getState().detachedNotes).toHaveLength(1);
    expect(useUIStore.getState().detachedNotes[0].noteId).toBe('n2');
  });
});
