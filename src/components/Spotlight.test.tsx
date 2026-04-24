import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

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

vi.mock('../hooks/useSearchWorker', () => ({
  useSearchWorker: () => ({
    isReady: true,
    isSearching: false,
    groups: [],
    total: 0,
    search: vi.fn(),
    updateNotes: vi.fn(),
    updateBoards: vi.fn(),
    currentBoardId: 'default',
  }),
}));

import { Spotlight } from './Spotlight';
import { normalizeNotes } from '../store/normalization';
import { useStore } from '../store/useStore';
import { Note } from '../store/types';
import { LAYOUT } from '../constants/layout';

const createNote = (overrides: Partial<Note> = {}): Note => ({
  id: 'note-1',
  boardId: 'default',
  x: 120,
  y: 160,
  title: '恢复交互',
  content: '检查 Spotlight 覆盖层交互',
  color: '#FFFFFF',
  z: 1,
  collapsed: false,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

describe('Spotlight WindowShell 浮层交互合同', () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderSpotlight = async () => {
    await act(async () => {
      root.render(<Spotlight />);
    });
  };

  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0, viewport: { x: 0, y: 0 } }],
      currentBoardId: 'default',
      ...normalizeNotes([createNote()]),
      isSpotlightOpen: true,
      viewport: { x: 0, y: 0, w: 320, h: 240 },
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

  it('为 overlay 根层、backdrop 与面板显式恢复 pointer-events，并保持点击 backdrop 关闭', async () => {
    await renderSpotlight();

    const backdrop = container.querySelector('button[aria-label="关闭搜索"]') as HTMLButtonElement | null;
    const input = container.querySelector('input[placeholder="搜索便签..."]') as HTMLInputElement | null;
    const panel = input?.closest('div.pointer-events-auto.relative') as HTMLDivElement | null;
    const rootLayer = backdrop?.parentElement as HTMLDivElement | null;

    expect(rootLayer).not.toBeNull();
    expect(rootLayer?.className).toContain('pointer-events-auto');
    expect(backdrop).not.toBeNull();
    expect(backdrop?.className).toContain('pointer-events-auto');
    expect(panel).not.toBeNull();
    expect(panel?.className).toContain('pointer-events-auto');

    await act(async () => {
      backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(useStore.getState().isSpotlightOpen).toBe(false);
    expect(container.querySelector('button[aria-label="关闭搜索"]')).toBeNull();
  });

  it('选择搜索结果后按 viewport 尺寸而不是 window 尺寸居中', async () => {
    const setViewportPosition = vi.fn();
    const clearSelection = vi.fn();
    const setSelectedIds = vi.fn();
    const bringToFront = vi.fn();

    useStore.setState({
      setViewportPosition,
      clearSelection,
      setSelectedIds,
      bringToFront,
    });

    await renderSpotlight();

    const input = container.querySelector('input[placeholder="搜索便签..."]') as HTMLInputElement | null;
    expect(input).not.toBeNull();

    await act(async () => {
      const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setInputValue?.call(input, '恢复');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => undefined);

    const resultButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('恢复交互')) as HTMLButtonElement | undefined;
    expect(resultButton).toBeDefined();

    await act(async () => {
      resultButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(setViewportPosition).toHaveBeenCalledWith(
      (120 + LAYOUT.NOTE_WIDTH / 2) - 160,
      (160 + LAYOUT.NOTE_MIN_HEIGHT / 2) - 120,
    );
    expect(setSelectedIds).toHaveBeenCalledWith(['note-1']);
    expect(bringToFront).toHaveBeenCalledWith('note-1');
    expect(clearSelection).toHaveBeenCalled();
  });
});
