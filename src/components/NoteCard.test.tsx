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
import { getNoteColor, Note } from '../store/types';

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

  it('有标题时按钮默认隐藏，悬浮后再显示', async () => {
    await renderNoteCard();

    const rootRegion = container.querySelector('.note-card') as HTMLDivElement | null;
    const header = container.querySelector('.drag-handle') as HTMLDivElement | null;

    expect(header?.className).toContain('cursor-grab');
    expect(header?.className).toContain('active:cursor-grabbing');
    expect(header?.className).toContain('opacity-0');
    expect(container.querySelector('[aria-label="复制内容"]')).toBeNull();
    expect(container.querySelector('[aria-label="切换颜色"]')).not.toBeNull();

    await act(async () => {
      rootRegion?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    expect((container.querySelector('.drag-handle') as HTMLDivElement | null)?.className).toContain('opacity-100');
    expect(container.querySelector('[aria-label="复制内容"]')).not.toBeNull();
    expect((container.querySelector('[aria-label="切换颜色"]') as HTMLButtonElement | null)?.className).not.toContain('opacity-0');
  });

  it('折叠态只保留标题与删除按钮，不渲染复制和颜色按钮', async () => {
    useStore.setState({
      notes: [createNote({ collapsed: true, title: '已折叠便签' })],
    });

    await renderNoteCard();

    const header = container.querySelector('.drag-handle') as HTMLDivElement | null;
    const centerLayer = header?.querySelector('.absolute.inset-0') as HTMLDivElement | null;

    expect(container.querySelector('[aria-label="复制内容"]')).toBeNull();
    expect(container.querySelector('[aria-label="切换颜色"]')).toBeNull();
    expect(container.querySelector('[aria-label="删除便签"]')).not.toBeNull();
    expect(container.textContent).toContain('已折叠便签');
    expect(container.querySelector('textarea')).toBeNull();
    expect(header?.querySelector('.flex-1')).toBeNull();
    expect(centerLayer?.textContent).toContain('已折叠便签');
  });

  it('空标题时头部与标题输入共享同一套显隐派生状态', async () => {
    useStore.setState({
      notes: [createNote({ title: '' })],
    });

    await renderNoteCard();

    const rootRegion = container.querySelector('.note-card') as HTMLDivElement | null;
    const initialHeader = container.querySelector('.drag-handle') as HTMLDivElement | null;
    const initialTitleInput = container.querySelector('input[placeholder="标题"]') as HTMLInputElement | null;

    expect(initialHeader?.className).toContain('opacity-0');
    expect(initialTitleInput?.className).toContain('hidden');

    await act(async () => {
      rootRegion?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    const hoveredHeader = container.querySelector('.drag-handle') as HTMLDivElement | null;
    const hoveredTitleInput = container.querySelector('input[placeholder="标题"]') as HTMLInputElement | null;

    expect(hoveredHeader?.className).toContain('opacity-100');
    expect(hoveredTitleInput?.className).toContain('block');
  });

  it('深色模式下增强正文、占位符、选中文本与单选态可见性', async () => {
    useStore.setState({
      notes: [createNote({ color: '#fef9c3' })],
      selectedIds: ['note-1'],
      config: {
        ...useStore.getState().config,
        themeMode: 'dark',
      },
    });

    await renderNoteCard();

    const rootRegion = container.querySelector('.note-card') as HTMLDivElement | null;
    const titleInput = container.querySelector('input[placeholder="标题"]') as HTMLInputElement | null;
    const textarea = container.querySelector('textarea[placeholder="记点什么..."]') as HTMLTextAreaElement | null;

    expect(rootRegion?.style.backgroundColor).toBe(getNoteColor('#fef9c3', true));
    expect(rootRegion?.className).toContain('dark:ring-blue-300/45');
    expect(rootRegion?.className).toContain('dark:border-blue-300/45');

    expect(titleInput?.className).toContain('dark:placeholder-text-secondary/75');
    expect(titleInput?.className).toContain('dark:selection:bg-blue-200/35');
    expect(titleInput?.className).not.toContain('selection:text-slate-900');
    expect(titleInput?.className).not.toContain('dark:selection:text-slate-950');

    expect(textarea?.className).toContain('dark:text-text-primary');
    expect(textarea?.className).toContain('dark:placeholder-text-secondary/75');
    expect(textarea?.className).toContain('dark:selection:bg-blue-200/35');
    expect(textarea?.className).not.toContain('selection:text-slate-900');
    expect(textarea?.className).not.toContain('dark:selection:text-slate-950');
  });

  it('折叠态标题与展开态标题保持同一主文本层级', async () => {
    useStore.setState({
      notes: [createNote({ title: '折叠标题', collapsed: true })],
      config: {
        ...useStore.getState().config,
        themeMode: 'dark',
      },
    });

    await renderNoteCard();

    const collapsedTitle = Array.from(container.querySelectorAll('span')).find(
      (element) => element.textContent === '折叠标题',
    ) as HTMLSpanElement | null;

    expect(collapsedTitle).not.toBeNull();
    expect(collapsedTitle?.className).toContain('text-text-primary');
    expect(collapsedTitle?.className).not.toContain('opacity-90');
  });

  it('仅双击头部才折叠，正文双击不触发折叠', async () => {
    await renderNoteCard();

    const textarea = container.querySelector('textarea[placeholder="记点什么..."]') as HTMLTextAreaElement | null;
    const header = container.querySelector('.drag-handle') as HTMLDivElement | null;

    expect(useStore.getState().notes.find((note) => note.id === 'note-1')?.collapsed).toBe(false);

    await act(async () => {
      textarea?.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true,
        clientX: 240,
        clientY: 260,
      }));
    });

    expect(useStore.getState().notes.find((note) => note.id === 'note-1')?.collapsed).toBe(false);

    await act(async () => {
      header?.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true,
        clientX: 200,
        clientY: 160,
      }));
    });

    expect(useStore.getState().notes.find((note) => note.id === 'note-1')?.collapsed).toBe(true);
  });
});
