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

import { NoteCard } from './NoteCard';
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

describe('NoteCard 头部交互边界', () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderNoteCard = async () => {
    await act(async () => {
      root.render(<NoteCard id="note-1" />);
    });
  };

  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      notes: [createNote()],
      currentBoardId: 'default',
      viewport: { x: 0, y: 0, w: 1280, h: 720 },
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
  });

  it('将拖拽把手、折叠区、按钮区与正文区拆成独立 DOM 区域', async () => {
    await renderNoteCard();

    const dragHandle = container.querySelector('[data-note-card-region="drag-handle"]');
    const collapseRegion = container.querySelector('[data-note-card-region="collapse"]');
    const leftButtons = container.querySelector('[data-note-card-region="buttons-left"]');
    const rightButtons = container.querySelector('[data-note-card-region="buttons-right"]');
    const bodyRegion = container.querySelector('[data-note-card-region="body"]');

    expect(dragHandle).not.toBeNull();
    expect(collapseRegion).not.toBeNull();
    expect(leftButtons).not.toBeNull();
    expect(rightButtons).not.toBeNull();
    expect(bodyRegion).not.toBeNull();

    expect(collapseRegion?.contains(dragHandle as Node)).toBe(false);
    expect(bodyRegion?.contains(dragHandle as Node)).toBe(false);
    expect(bodyRegion?.contains(leftButtons as Node)).toBe(false);
    expect(bodyRegion?.contains(rightButtons as Node)).toBe(false);
  });

  it('折叠态不渲染复制按钮，并保留独立折叠触发区', async () => {
    useStore.setState({
      notes: [createNote({ collapsed: true, title: '已折叠便签' })],
    });

    await renderNoteCard();

    expect(container.querySelector('[aria-label="复制内容"]')).toBeNull();
    expect(container.querySelector('[aria-label="展开便签"]')).not.toBeNull();
    expect(container.textContent).toContain('已折叠便签');
    expect(container.querySelector('[data-note-card-region="body"]')).toBeNull();
  });

  it('空标题时头部与标题输入共享同一套显隐派生状态', async () => {
    useStore.setState({
      notes: [createNote({ title: '' })],
    });

    await renderNoteCard();

    const rootRegion = container.querySelector('[data-note-card-region="root"]') as HTMLDivElement | null;
    const initialHeader = container.querySelector('[data-note-card-region="header"]') as HTMLDivElement | null;
    const initialTitleInput = container.querySelector('input[placeholder="标题"]') as HTMLInputElement | null;

    expect(initialHeader?.className).toContain('opacity-0');
    expect(initialTitleInput?.className).toContain('hidden');

    await act(async () => {
      rootRegion?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    const hoveredHeader = container.querySelector('[data-note-card-region="header"]') as HTMLDivElement | null;
    const hoveredTitleInput = container.querySelector('input[placeholder="标题"]') as HTMLInputElement | null;

    expect(hoveredHeader?.className).toContain('opacity-100');
    expect(hoveredTitleInput?.className).toContain('block');
  });
});
