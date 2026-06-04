import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

const { emitMock, invokeMock, listenMock, startDraggingMock, setSizeMock } = vi.hoisted(() => ({
  emitMock: vi.fn(),
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  startDraggingMock: vi.fn(),
  setSizeMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
  emit: emitMock,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    startDragging: startDraggingMock,
    setSize: setSizeMock,
  }),
}));

vi.mock('@tauri-apps/api/dpi', () => ({
  LogicalSize: class LogicalSize {
    constructor(
      public width: number,
      public height: number,
    ) {}
  },
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

import { DetachedNoteWindow } from './DetachedNoteWindow';
import { DETACHED_NOTE_EVENTS } from '../types/detachedNoteSnapshot';
import type { DetachedNoteSnapshot } from '../types/detachedNoteSnapshot';

let resizeCallback: ResizeObserverCallback | null = null;

function triggerResize(height: number) {
  if (!resizeCallback) throw new Error('ResizeObserver 未初始化');
  act(() => {
    resizeCallback!([
      {
        borderBoxSize: [{ blockSize: height, inlineSize: 260 }],
        contentRect: { height, width: 260 },
      },
    ] as unknown as ResizeObserverEntry[], {} as ResizeObserver);
  });
}

const createSnapshot = (overrides: Partial<DetachedNoteSnapshot> = {}): DetachedNoteSnapshot => ({
  noteId: 'note-test-1',
  title: '测试标题',
  content: '测试正文',
  color: '#FFFFFF',
  isCollapsed: false,
  ...overrides,
});

describe('DetachedNoteWindow 按钮行为', () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderWindow = async (noteId = 'note-test-1') => {
    await act(async () => {
      root.render(<DetachedNoteWindow noteId={noteId} />);
    });
  };

  const simulateSnapshot = (snapshot: DetachedNoteSnapshot) => {
    const snapshotCall = listenMock.mock.calls.find(
      (call: unknown[]) => call[0] === DETACHED_NOTE_EVENTS.SNAPSHOT,
    );
    expect(snapshotCall).toBeDefined();
    const snapshotCallback = snapshotCall![1] as (event: { payload: DetachedNoteSnapshot }) => void;
    act(() => {
      snapshotCallback({ payload: snapshot });
    });
  };

  beforeEach(() => {
    listenMock.mockClear();
    emitMock.mockClear();
    invokeMock.mockClear();
    startDraggingMock.mockClear();
    setSizeMock.mockClear();
    resizeCallback = null;
    listenMock.mockResolvedValue(vi.fn());
    emitMock.mockResolvedValue(undefined);
    startDraggingMock.mockResolvedValue(undefined);
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'show_detached_note_window') return Promise.resolve(null);
      return Promise.resolve(null);
    });

    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: ResizeObserverCallback) {
        resizeCallback = cb;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    });

    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      cb();
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('快照到达前保持透明占位，避免显示额外窗口壳', async () => {
    await renderWindow();

    expect(container.textContent).not.toContain('加载中…');
    expect(container.querySelector('.bg-transparent')).not.toBeNull();
  });

  it('收到快照后渲染 NoteVisuals 与三个按钮', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    expect(container.querySelector('[data-note-visuals="true"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="定位到画布所在"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="置顶"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="贴回画布"]')).not.toBeNull();
  });

  it('收到快照后不渲染额外背景与 padding 外壳', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    expect(container.querySelector('.bg-primary-bg')).toBeNull();
    expect(container.querySelector('.p-4')).toBeNull();
  });

  it('NoteVisuals 使用默认宽度而非撑满窗口', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    const noteEl = container.querySelector('[data-note-visuals="true"]') as HTMLElement;

    expect(noteEl.className).not.toContain('h-full');
    expect(noteEl.className).not.toContain('w-full');
    expect(noteEl.style.width).not.toBe('100%');
    expect(noteEl.style.height).not.toBe('100%');
    expect(noteEl.style.minHeight).not.toBe('100%');
    expect(noteEl.style.width).toBe('260px');
  });

  it('快照后渲染 data-tauri-drag-region 拖拽区域', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    expect(container.querySelector('[data-tauri-drag-region]')).not.toBeNull();
  });

  it('按下便签表面时启动 Tauri 窗口拖拽', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    const noteEl = container.querySelector('[data-note-visuals="true"]') as HTMLElement;
    await act(async () => {
      noteEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });

    expect(startDraggingMock).toHaveBeenCalledTimes(1);
  });

  it('按下按钮区域时不启动 Tauri 窗口拖拽', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    const locateBtn = container.querySelector(
      '[aria-label="定位到画布所在"]',
    ) as HTMLButtonElement;
    await act(async () => {
      locateBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });

    expect(startDraggingMock).not.toHaveBeenCalled();
  });

  it('NoteVisuals 保留圆角，不使用 rounded-none', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    const noteEl = container.querySelector('[data-note-visuals="true"]');
    expect(noteEl).not.toBeNull();
    expect(noteEl!.className).not.toContain('rounded-none');
    expect(noteEl!.className).toContain('rounded-xl');
  });

  it('点击定位按钮向主窗口发送 locate 事件', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    const locateBtn = container.querySelector(
      '[aria-label="定位到画布所在"]',
    ) as HTMLButtonElement;

    await act(async () => {
      locateBtn.click();
    });

    expect(invokeMock).toHaveBeenCalledWith('show_main_window');
    expect(emitMock).toHaveBeenCalledWith(
      DETACHED_NOTE_EVENTS.LOCATE,
      { noteId: 'note-test-1' },
    );
  });

  it('点击置顶按钮调用 Rust set_detached_note_always_on_top', async () => {
    invokeMock.mockResolvedValueOnce(null).mockResolvedValueOnce(true);

    await renderWindow();
    simulateSnapshot(createSnapshot());

    const pinBtn = container.querySelector(
      '[aria-label="置顶"]',
    ) as HTMLButtonElement;

    await act(async () => {
      pinBtn.click();
    });

    expect(invokeMock).toHaveBeenCalledWith('set_detached_note_always_on_top', {
      noteId: 'note-test-1',
      alwaysOnTop: true,
    });
  });

  it('置顶成功后按钮 aria-label 变为取消置顶，样式带 accent 色', async () => {
    invokeMock.mockResolvedValueOnce(null).mockResolvedValueOnce(true);

    await renderWindow();
    simulateSnapshot(createSnapshot());

    const pinBtn = container.querySelector(
      '[aria-label="置顶"]',
    ) as HTMLButtonElement;

    await act(async () => {
      pinBtn.click();
    });

    await act(async () => {
      await vi.waitFor(() => {
        expect(container.querySelector('[aria-label="取消置顶"]')).not.toBeNull();
      });
    });

    const updatedPinBtn = container.querySelector('[aria-label="取消置顶"]') as HTMLButtonElement;
    expect(updatedPinBtn.className).toContain('text-accent');
  });

  it('再次点击取消置顶', async () => {
    invokeMock.mockResolvedValueOnce(null).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await renderWindow();
    simulateSnapshot(createSnapshot());

    const pinBtn = container.querySelector('[aria-label="置顶"]') as HTMLButtonElement;

    await act(async () => {
      pinBtn.click();
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(container.querySelector('[aria-label="取消置顶"]')).not.toBeNull();
      });
    });

    const cancelPinBtn = container.querySelector('[aria-label="取消置顶"]') as HTMLButtonElement;
    await act(async () => {
      cancelPinBtn.click();
    });

    expect(invokeMock).toHaveBeenLastCalledWith('set_detached_note_always_on_top', {
      noteId: 'note-test-1',
      alwaysOnTop: false,
    });
  });

  it('点击贴回画布按钮调用 Rust close_detached_note_window', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    const closeBtn = container.querySelector(
      '[aria-label="贴回画布"]',
    ) as HTMLButtonElement;

    await act(async () => {
      closeBtn.click();
    });

    expect(invokeMock).toHaveBeenCalledWith('close_detached_note_window', {
      noteId: 'note-test-1',
    });
  });

  it('按钮 click 不向上传播', async () => {
    const parentClick = vi.fn();

    await act(async () => {
      root.render(
        <div onClick={parentClick}>
          <DetachedNoteWindow noteId="note-test-1" />
        </div>,
      );
    });
    simulateSnapshot(createSnapshot());

    const locateBtn = container.querySelector(
      '[aria-label="定位到画布所在"]',
    ) as HTMLButtonElement;

    await act(async () => {
      locateBtn.click();
    });

    expect(parentClick).not.toHaveBeenCalled();
  });

  it('监听器在组件卸载时被清理', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    const unlistenFns = listenMock.mock.results.map((r) => r.value);

    await act(async () => {
      root.unmount();
    });

    for (const unlistenPromise of unlistenFns) {
      const unlistenFn = await unlistenPromise;
      expect(unlistenFn).toHaveBeenCalled();
    }
  });
});

describe('DetachedNoteWindow 尺寸与 ResizeObserver', () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderWindow = async (noteId = 'note-test-1') => {
    await act(async () => {
      root.render(<DetachedNoteWindow noteId={noteId} />);
    });
  };

  const simulateSnapshot = (snapshot: DetachedNoteSnapshot) => {
    const snapshotCall = listenMock.mock.calls.find(
      (call: unknown[]) => call[0] === DETACHED_NOTE_EVENTS.SNAPSHOT,
    );
    expect(snapshotCall).toBeDefined();
    const snapshotCallback = snapshotCall![1] as (event: { payload: DetachedNoteSnapshot }) => void;
    act(() => {
      snapshotCallback({ payload: snapshot });
    });
  };

  beforeEach(() => {
    listenMock.mockClear();
    emitMock.mockClear();
    invokeMock.mockClear();
    startDraggingMock.mockClear();
    setSizeMock.mockClear();
    resizeCallback = null;
    listenMock.mockResolvedValue(vi.fn());
    emitMock.mockResolvedValue(undefined);
    startDraggingMock.mockResolvedValue(undefined);
    invokeMock.mockResolvedValue(null);

    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: ResizeObserverCallback) {
        resizeCallback = cb;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    });

    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      cb();
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('ResizeObserver 触发后以固定宽度 260 调用 setSize', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    triggerResize(300);

    expect(setSizeMock).toHaveBeenCalledWith(
      expect.objectContaining({ width: 260, height: 300 }),
    );
  });

  it('高度超过上限时 setSize 使用上限值，正文区域添加滚动类', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    triggerResize(800);

    const wrapper = container.querySelector('[data-tauri-drag-region]') as HTMLElement;
    expect(wrapper.className).not.toContain('overflow-y-auto');

    const noteEl = container.querySelector('[data-note-visuals="true"]') as HTMLElement;
    expect(noteEl.className).toContain('overflow-hidden');
    expect(noteEl.style.height).toBe('520px');
    expect(noteEl.style.maxHeight).toBe('520px');

    const contentRegion = container.querySelector('[data-note-content-region="true"]') as HTMLElement;
    expect(contentRegion.className).toContain('overflow-y-auto');
    expect(contentRegion.className).toContain('scrollbar-thin');

    expect(setSizeMock).toHaveBeenCalledWith(
      expect.objectContaining({ width: 260, height: 520 }),
    );
  });

  it('高度未超限时不添加滚动类', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    triggerResize(200);

    const noteEl = container.querySelector('[data-note-visuals="true"]') as HTMLElement;
    expect(noteEl.className).not.toContain('overflow-hidden');
    expect(noteEl.style.height).toBe('auto');

    const contentRegion = container.querySelector('[data-note-content-region="true"]') as HTMLElement;
    expect(contentRegion.className).not.toContain('overflow-y-auto');
  });

  it('折叠状态触发小尺寸 setSize', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot({ isCollapsed: true }));

    triggerResize(36);

    expect(setSizeMock).toHaveBeenCalledWith(
      expect.objectContaining({ width: 260, height: 36 }),
    );
  });

  it('相同尺寸不重复调用 setSize', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    triggerResize(300);
    triggerResize(300);

    const sizeCalls = setSizeMock.mock.calls.filter(
      (c: unknown[]) => (c[0] as { width: number }).width === 260,
    );
    expect(sizeCalls).toHaveLength(1);
  });

  it('封顶后高度小幅波动时不重复 setSize', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    triggerResize(800);
    triggerResize(521);
    triggerResize(519);

    const sizeCalls = setSizeMock.mock.calls.filter(
      (c: unknown[]) => (c[0] as { width: number; height: number }).width === 260,
    );
    expect(sizeCalls).toHaveLength(1);
    expect(sizeCalls[0][0]).toEqual(expect.objectContaining({ width: 260, height: 520 }));
  });

  it('内容明显缩短后退出封顶并恢复自然高度', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    triggerResize(800);
    triggerResize(500);

    expect(setSizeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ width: 260, height: 500 }),
    );

    const noteEl = container.querySelector('[data-note-visuals="true"]') as HTMLElement;
    expect(noteEl.className).not.toContain('overflow-hidden');

    const contentRegion = container.querySelector('[data-note-content-region="true"]') as HTMLElement;
    expect(contentRegion.className).not.toContain('overflow-y-auto');
  });

  it('内容变化后 ResizeObserver 重新触发 setSize', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    triggerResize(300);
    expect(setSizeMock).toHaveBeenCalledTimes(1);

    triggerResize(450);
    expect(setSizeMock).toHaveBeenCalledTimes(2);
    expect(setSizeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ width: 260, height: 450 }),
    );
  });
});

describe('DetachedNoteWindow 显示窗口行为', () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderWindow = async (noteId = 'note-test-1') => {
    await act(async () => {
      root.render(<DetachedNoteWindow noteId={noteId} />);
    });
  };

  const simulateSnapshot = (snapshot: DetachedNoteSnapshot) => {
    const snapshotCall = listenMock.mock.calls.find(
      (call: unknown[]) => call[0] === DETACHED_NOTE_EVENTS.SNAPSHOT,
    );
    expect(snapshotCall).toBeDefined();
    const snapshotCallback = snapshotCall![1] as (event: { payload: DetachedNoteSnapshot }) => void;
    act(() => {
      snapshotCallback({ payload: snapshot });
    });
  };

  beforeEach(() => {
    listenMock.mockClear();
    emitMock.mockClear();
    invokeMock.mockClear();
    startDraggingMock.mockClear();
    setSizeMock.mockClear();
    resizeCallback = null;
    listenMock.mockResolvedValue(vi.fn());
    emitMock.mockResolvedValue(undefined);
    startDraggingMock.mockResolvedValue(undefined);
    invokeMock.mockResolvedValue(null);

    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: ResizeObserverCallback) {
        resizeCallback = cb;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    });

    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      cb();
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('挂载时立即调用 show_detached_note_window', async () => {
    await renderWindow();

    expect(invokeMock).toHaveBeenCalledWith('show_detached_note_window', {
      noteId: 'note-test-1',
    });
  });

  it('快照到达时若尚未显示则再次调用 show_detached_note_window', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'show_detached_note_window') return Promise.reject(new Error('暂不可用'));
      return Promise.resolve(null);
    });

    await renderWindow();

    invokeMock.mockClear();
    invokeMock.mockResolvedValue(null);

    simulateSnapshot(createSnapshot());

    expect(invokeMock).toHaveBeenCalledWith('show_detached_note_window', {
      noteId: 'note-test-1',
    });
  });

  it('幂等：show_detached_note_window 不会因快照重复调用', async () => {
    await renderWindow();

    const showCallsBefore = invokeMock.mock.calls.filter(
      (c: unknown[]) => c[0] === 'show_detached_note_window',
    ).length;

    simulateSnapshot(createSnapshot());

    const showCallsAfter = invokeMock.mock.calls.filter(
      (c: unknown[]) => c[0] === 'show_detached_note_window',
    ).length;

    expect(showCallsAfter).toBe(showCallsBefore);
  });

  it('show 失败后允许后续重试', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'show_detached_note_window') return Promise.reject(new Error('失败'));
      return Promise.resolve(null);
    });

    await renderWindow();

    invokeMock.mockResolvedValue(null);

    simulateSnapshot(createSnapshot());

    const showCalls = invokeMock.mock.calls.filter(
      (c: unknown[]) => c[0] === 'show_detached_note_window',
    );
    expect(showCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('READY emit 在监听器 Promise 解析后才发送', async () => {
    let resolveSnapshot: (fn: () => void) => void;
    let resolveMissing: (fn: () => void) => void;

    listenMock.mockImplementation((event: string) => {
      if (event === DETACHED_NOTE_EVENTS.SNAPSHOT) {
        return new Promise<() => void>((resolve) => { resolveSnapshot = resolve; });
      }
      if (event === DETACHED_NOTE_EVENTS.MISSING) {
        return new Promise<() => void>((resolve) => { resolveMissing = resolve; });
      }
      return Promise.resolve(vi.fn());
    });

    await renderWindow();

    expect(emitMock).not.toHaveBeenCalledWith(
      DETACHED_NOTE_EVENTS.READY,
      expect.anything(),
    );

    await act(async () => {
      resolveSnapshot!(vi.fn());
    });

    expect(emitMock).not.toHaveBeenCalledWith(
      DETACHED_NOTE_EVENTS.READY,
      expect.anything(),
    );

    await act(async () => {
      resolveMissing!(vi.fn());
    });

    expect(emitMock).toHaveBeenCalledWith(
      DETACHED_NOTE_EVENTS.READY,
      { noteId: 'note-test-1' },
    );
  });

  it('卸载后不再发送 READY emit', async () => {
    let resolveSnapshot: (fn: () => void) => void;
    let resolveMissing: (fn: () => void) => void;

    listenMock.mockImplementation((event: string) => {
      if (event === DETACHED_NOTE_EVENTS.SNAPSHOT) {
        return new Promise<() => void>((resolve) => { resolveSnapshot = resolve; });
      }
      if (event === DETACHED_NOTE_EVENTS.MISSING) {
        return new Promise<() => void>((resolve) => { resolveMissing = resolve; });
      }
      return Promise.resolve(vi.fn());
    });

    await renderWindow();

    await act(async () => {
      root.unmount();
    });

    await act(async () => {
      resolveSnapshot!(vi.fn());
      resolveMissing!(vi.fn());
    });

    expect(emitMock).not.toHaveBeenCalledWith(
      DETACHED_NOTE_EVENTS.READY,
      expect.anything(),
    );
  });

  it('正文区域类名包含 overflow-x-hidden 和 detached-scroll-area', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    triggerResize(800);

    const contentRegion = container.querySelector('[data-note-content-region="true"]') as HTMLElement;
    expect(contentRegion.className).toContain('overflow-x-hidden');
    expect(contentRegion.className).toContain('detached-scroll-area');
  });

  it('文本内容区域包含 break-words 和 whitespace-pre-wrap', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    const textDiv = container.querySelector('[data-note-content-region="true"] > div') as HTMLElement;
    expect(textDiv.className).toContain('break-words');
    expect(textDiv.className).toContain('whitespace-pre-wrap');
  });
});

describe('DetachedNoteWindow 瞬态视觉提示', () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderWindow = async (noteId = 'note-test-1') => {
    await act(async () => {
      root.render(<DetachedNoteWindow noteId={noteId} />);
    });
  };

  const simulateSnapshot = (snapshot: DetachedNoteSnapshot) => {
    const snapshotCall = listenMock.mock.calls.find(
      (call: unknown[]) => call[0] === DETACHED_NOTE_EVENTS.SNAPSHOT,
    );
    expect(snapshotCall).toBeDefined();
    const snapshotCallback = snapshotCall![1] as (event: { payload: DetachedNoteSnapshot }) => void;
    act(() => {
      snapshotCallback({ payload: snapshot });
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    listenMock.mockClear();
    emitMock.mockClear();
    invokeMock.mockClear();
    startDraggingMock.mockClear();
    setSizeMock.mockClear();
    listenMock.mockResolvedValue(vi.fn());
    emitMock.mockResolvedValue(undefined);
    startDraggingMock.mockResolvedValue(undefined);
    invokeMock.mockResolvedValue(null);

    vi.stubGlobal('ResizeObserver', class {
      constructor(_cb: ResizeObserverCallback) {}
      observe() {}
      disconnect() {}
      unobserve() {}
    });

    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      cb();
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('收到首张快照后可见 NoteVisuals 以 isActive 样式渲染', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    const noteVisuals = container.querySelectorAll('[data-note-visuals="true"]');
    expect(noteVisuals.length).toBeGreaterThanOrEqual(2);

    const visibleNote = noteVisuals[0] as HTMLElement;
    expect(visibleNote.style.boxShadow).toContain('4px 14px');
  });

  it('隐藏测量 NoteVisuals 不以 isActive 样式渲染', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    const measureNote = container.querySelector('[data-detached-note-measure="true"]') as HTMLElement;
    expect(measureNote).not.toBeNull();
    expect(measureNote.style.boxShadow).toContain('2px 8px');
    expect(measureNote.style.boxShadow).not.toContain('4px 14px');
  });

  it('首张快照后显示"悬浮"徽章', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    const cue = container.querySelector('[data-detached-note-cue="true"]');
    expect(cue).not.toBeNull();
    expect(cue!.textContent).toBe('悬浮');
  });

  it('1600ms 后"悬浮"徽章自动消失', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    expect(container.querySelector('[data-detached-note-cue="true"]')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1600);
    });

    expect(container.querySelector('[data-detached-note-cue="true"]')).toBeNull();
  });

  it('定时器清理不会在卸载后触发 setState', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    act(() => {
      root.unmount();
    });

    act(() => {
      vi.advanceTimersByTime(2000);
    });
  });

  it('后续快照不会重新触发高亮', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(container.querySelector('[data-detached-note-cue="true"]')).toBeNull();

    simulateSnapshot(createSnapshot({
      title: '更新标题',
      content: '更新内容',
    }));

    expect(container.querySelector('[data-detached-note-cue="true"]')).toBeNull();
  });
});

describe('DetachedNoteWindow 主题同步', () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderWindow = async (noteId = 'note-test-1') => {
    await act(async () => {
      root.render(<DetachedNoteWindow noteId={noteId} />);
    });
  };

  beforeEach(() => {
    listenMock.mockClear();
    emitMock.mockClear();
    invokeMock.mockClear();
    startDraggingMock.mockClear();
    setSizeMock.mockClear();
    resizeCallback = null;
    document.documentElement.classList.remove('dark');
    localStorage.clear();
    listenMock.mockResolvedValue(vi.fn());
    emitMock.mockResolvedValue(undefined);
    startDraggingMock.mockResolvedValue(undefined);
    invokeMock.mockResolvedValue(null);

    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: ResizeObserverCallback) {
        resizeCallback = cb;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    });

    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      cb();
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.documentElement.classList.remove('dark');
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('收到主题事件后同步 detached document 的 dark class 与本地 theme', async () => {
    await renderWindow();

    const themeCall = listenMock.mock.calls.find(
      (call: unknown[]) => call[0] === DETACHED_NOTE_EVENTS.THEME,
    );
    expect(themeCall).toBeDefined();
    const themeCallback = themeCall![1] as (event: { payload: { themeMode: 'light' | 'dark' | 'system'; isDark: boolean } }) => void;

    act(() => {
      themeCallback({ payload: { themeMode: 'dark', isDark: true } });
    });

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('theme')).toBe('dark');

    act(() => {
      themeCallback({ payload: { themeMode: 'light', isDark: false } });
    });

    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('theme')).toBe('light');
  });
});
