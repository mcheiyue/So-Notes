import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

const { emitMock, invokeMock, listenMock } = vi.hoisted(() => ({
  emitMock: vi.fn(),
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
  emit: emitMock,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
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
    listenMock.mockResolvedValue(vi.fn());
    emitMock.mockResolvedValue(undefined);
    invokeMock.mockResolvedValue(null);

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

  it('快照到达前显示加载状态', async () => {
    await renderWindow();

    expect(container.textContent).toContain('加载中…');
  });

  it('收到快照后渲染 NoteVisuals 与三个按钮', async () => {
    await renderWindow();
    simulateSnapshot(createSnapshot());

    expect(container.querySelector('[aria-label="定位到画布所在"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="置顶"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="贴回画布"]')).not.toBeNull();
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

    expect(emitMock).toHaveBeenCalledWith(
      DETACHED_NOTE_EVENTS.LOCATE,
      { noteId: 'note-test-1' },
    );
  });

  it('点击置顶按钮调用 Rust set_detached_note_always_on_top', async () => {
    invokeMock.mockResolvedValueOnce(true);

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
    invokeMock.mockResolvedValueOnce(true);

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
    invokeMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

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
