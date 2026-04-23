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

import { MiniMap } from './MiniMap';
import { normalizeNotes, createLayoutNotesById } from '../store/normalization';
import { useStore } from '../store/useStore';

describe('MiniMap 看板隔离', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useStore.setState(useStore.getInitialState(), true);

    const normalized = normalizeNotes([
      {
        id: 'note-a',
        boardId: 'default',
        x: 100,
        y: 120,
        title: 'A',
        content: 'alpha',
        color: '#FFFFFF',
        z: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'note-b',
        boardId: 'board-2',
        x: 3000,
        y: 2400,
        title: 'B',
        content: 'beta',
        color: '#FFFFFF',
        z: 2,
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: 'note-c',
        boardId: 'default',
        x: 200,
        y: 220,
        title: 'C',
        content: 'gamma',
        color: '#FFFFFF',
        z: 3,
        createdAt: 3,
        updatedAt: 3,
        deletedAt: 999,
      },
    ]);

    useStore.setState({
      boards: [
        { id: 'default', name: '主板', icon: '📌', createdAt: 0, viewport: { x: 20, y: 30 } },
        { id: 'board-2', name: '第二板', icon: '🧪', createdAt: 1, viewport: { x: 500, y: 600 } },
        { id: 'board-empty', name: '空板', icon: '🫥', createdAt: 2, viewport: { x: 0, y: 0 } },
      ],
      currentBoardId: 'default',
      viewport: { x: 20, y: 30, w: 1200, h: 800 },
      interaction: {
        isPanMode: false,
        isDragging: false,
        edgePush: { top: false, bottom: false, left: false, right: false },
      },
      ...normalized,
      layoutNotesById: createLayoutNotesById(normalized.notesById),
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

  const renderMiniMap = async () => {
    await act(async () => {
      root.render(<MiniMap />);
    });
  };

  it('只渲染当前看板且未删除的便签', async () => {
    await renderMiniMap();

    expect(container.querySelectorAll('.minimap-note')).toHaveLength(1);
  });

  it('切换看板后立即切换 minimap 便签集合', async () => {
    await renderMiniMap();

    await act(async () => {
      useStore.getState().switchBoard('board-2');
    });

    const notes = container.querySelectorAll('.minimap-note');
    expect(notes).toHaveLength(1);

    const viewport = container.querySelector('.minimap-viewport') as HTMLDivElement | null;
    expect(viewport).not.toBeNull();
    expect(viewport?.style.left).not.toBe('');
    expect(viewport?.style.top).not.toBe('');
  });

  it('当前看板为空时仍保留 viewport 指示器', async () => {
    await renderMiniMap();

    await act(async () => {
      useStore.getState().switchBoard('board-empty');
    });

    expect(container.querySelectorAll('.minimap-note')).toHaveLength(0);

    const viewport = container.querySelector('.minimap-viewport') as HTMLDivElement | null;
    expect(viewport).not.toBeNull();
    expect(Number.parseFloat(viewport?.style.width ?? '0')).toBeGreaterThan(0);
    expect(Number.parseFloat(viewport?.style.height ?? '0')).toBeGreaterThan(0);
  });

  it('隐藏态 reveal hotspot 显式恢复 pointer-events，同时不阻塞背景画布', async () => {
    await renderMiniMap();

    const revealButton = container.querySelector('button[aria-label="显示小地图"]') as HTMLButtonElement | null;
    const mapContainer = container.querySelector('.minimap-interaction-area') as HTMLDivElement | null;

    expect(revealButton).not.toBeNull();
    expect(revealButton?.className).toContain('pointer-events-auto');
    expect(mapContainer).not.toBeNull();
    expect(mapContainer?.className).toContain('pointer-events-none');
  });

});
