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

import { NoteCard } from './NoteCard';
import { useStore } from '../store/useStore';
import { useUIStore } from '../store';
import { normalizeNotes } from '../store/normalization';
import { getNoteColor, getNoteDarkSpectrum, Note } from '../store/types';
import { getEdgeCheckRect, resolveDragStopWorldPosition } from '../utils/dragCoordinates';

const hexToRgbString = (hex: string): string => {
  const normalized = hex.replace('#', '');
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgb(${red}, ${green}, ${blue})`;
};

const hexToRgbaString = (hex: string, alpha: number): string => {
  const normalized = hex.replace('#', '');
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
};

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
      ...normalizeNotes([createNote()]),
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
      ...normalizeNotes([createNote({ collapsed: true, title: '已折叠便签' })]),
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
      ...normalizeNotes([createNote({ title: '' })]),
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
      ...normalizeNotes([createNote({ color: '#fef9c3' })]),
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
    const spectrum = getNoteDarkSpectrum('#fef9c3');

    expect(rootRegion?.style.backgroundColor).toBe(hexToRgbString(getNoteColor('#fef9c3', true)));
    expect(rootRegion?.style.backgroundImage).toContain('radial-gradient');
    expect(rootRegion?.style.backgroundImage).toContain('245, 158, 11');
    expect(rootRegion?.style.borderColor).toBe(hexToRgbaString(spectrum.accent, 0.48));
    expect(rootRegion?.style.boxShadow).toContain(hexToRgbaString(spectrum.accent, 0.28));

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
      ...normalizeNotes([createNote({ title: '折叠标题', collapsed: true })]),
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

    expect(useStore.getState().notesById['note-1']?.collapsed).toBe(false);

    await act(async () => {
      textarea?.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true,
        clientX: 240,
        clientY: 260,
      }));
    });

    expect(useStore.getState().notesById['note-1']?.collapsed).toBe(false);

    await act(async () => {
      header?.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true,
        clientX: 200,
        clientY: 160,
      }));
    });

    expect(useStore.getState().notesById['note-1']?.collapsed).toBe(true);
  });

  it('mouseout 清除 hover 态，box-shadow 回落到默认层级', async () => {
    await renderNoteCard();

    const rootRegion = container.querySelector('.note-card') as HTMLDivElement | null;
    expect(rootRegion?.style.boxShadow).toContain('0 2px 8px');

    await act(async () => {
      rootRegion?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(rootRegion?.style.boxShadow).toContain('0 4px');

    await act(async () => {
      rootRegion?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(rootRegion?.style.boxShadow).toContain('0 2px 8px');
  });

  it('深色模式默认使用 spectrum border，hover 后切到 accent-derived border 且 hover 清除后恢复', async () => {
    useStore.setState({
      ...normalizeNotes([createNote({ color: '#fef9c3' })]),
      config: {
        ...useStore.getState().config,
        themeMode: 'dark',
      },
    });

    await renderNoteCard();

    const rootRegion = container.querySelector('.note-card') as HTMLDivElement | null;
    const spectrum = getNoteDarkSpectrum('#fef9c3');

    expect(rootRegion?.style.borderColor).toBe(hexToRgbString(spectrum.border));

    await act(async () => {
      rootRegion?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    expect(rootRegion?.style.borderColor).toBe(hexToRgbaString(spectrum.accent, 0.4));
    expect(rootRegion?.style.boxShadow).toContain(hexToRgbaString(spectrum.accent, 0.22));

    await act(async () => {
      rootRegion?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });

    expect(rootRegion?.style.borderColor).toBe(hexToRgbString(spectrum.border));
    expect(rootRegion?.style.boxShadow).not.toContain(hexToRgbaString(spectrum.accent, 0.22));
  });

  it('mouseover 时 box-shadow 外层增强而非过度夸张', async () => {
    await renderNoteCard();

    const rootRegion = container.querySelector('.note-card') as HTMLDivElement | null;
    const shadow = rootRegion?.style.boxShadow ?? '';
    expect(shadow).toContain('0 2px 8px');
    expect(shadow).not.toContain('0 12px');

    await act(async () => {
      rootRegion?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    const hoverShadow = rootRegion?.style.boxShadow ?? '';
    expect(hoverShadow).toContain('0 4px');
    expect(hoverShadow).not.toContain('0 12px');
  });

  it('window blur 清除 hover 态', async () => {
    await renderNoteCard();

    const rootRegion = container.querySelector('.note-card') as HTMLDivElement | null;

    await act(async () => {
      rootRegion?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(rootRegion?.style.boxShadow).toContain('0 4px');

    await act(async () => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(rootRegion?.style.boxShadow).toContain('0 2px 8px');
  });

  it('不使用 backdrop-blur 和 backdrop-saturate（仿玻璃方案）', async () => {
    await renderNoteCard();

    const rootRegion = container.querySelector('.note-card') as HTMLDivElement | null;
    expect(rootRegion).not.toBeNull();
    expect(rootRegion?.className).not.toContain('backdrop-blur');
    expect(rootRegion?.className).not.toContain('backdrop-saturate');
    expect(rootRegion?.className).not.toContain('hover:shadow');
    expect(rootRegion?.className).not.toContain('dark:hover:bg');
    expect(rootRegion?.style.backdropFilter).toBe('');
    expect(rootRegion?.getAttribute('style')).not.toContain('backdrop-filter');
  });

  it('hover 态由 React 状态驱动 box-shadow 变化，不依赖 CSS hover 伪类', async () => {
    await renderNoteCard();

    const rootRegion = container.querySelector('.note-card') as HTMLDivElement | null;
    expect(rootRegion?.style.boxShadow).toContain('0 2px 8px');

    await act(async () => {
      rootRegion?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(rootRegion?.style.boxShadow).toContain('0 4px');

    await act(async () => {
      rootRegion?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(rootRegion?.style.boxShadow).toContain('0 2px 8px');
  });

  it('visibilitychange hidden 清除 hover 态', async () => {
    await renderNoteCard();

    const rootRegion = container.querySelector('.note-card') as HTMLDivElement | null;

    await act(async () => {
      rootRegion?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(rootRegion?.style.boxShadow).toContain('0 4px');

    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    });
    expect(rootRegion?.style.boxShadow).toContain('0 2px 8px');
  });

  it('编辑正文后在失焦时触发临时编辑高亮', async () => {
    const markNoteHighlights = vi.fn();
    useUIStore.setState({ markNoteHighlights });

    await renderNoteCard();

    const textarea = container.querySelector('textarea[placeholder="记点什么..."]') as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();

    await act(async () => {
      textarea?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });

    await act(async () => {
      const setTextareaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setTextareaValue?.call(textarea, '内容已更新');
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      textarea?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    expect(markNoteHighlights).toHaveBeenCalledWith(['note-1'], 'edited');
  });

  it('不包含 before: 伪元素高光类（C2 已改用 inline 样式）', async () => {
    await renderNoteCard();
    const rootRegion = container.querySelector('.note-card') as HTMLDivElement | null;
    expect(rootRegion?.className).not.toContain('before:absolute');
    expect(rootRegion?.className).not.toContain('before:bg-gradient');
  });

  it('inline backgroundImage 提供静态亚克力表面光泽', async () => {
    await renderNoteCard();
    const rootRegion = container.querySelector('.note-card') as HTMLDivElement | null;
    const bgImage = rootRegion?.style.backgroundImage ?? '';
    expect(bgImage).toContain('linear-gradient');
    expect(bgImage).toContain('rgba(255, 255, 255');
  });

  it('inline boxShadow 含 inset 高光层（亚克力质感）', async () => {
    await renderNoteCard();
    const rootRegion = container.querySelector('.note-card') as HTMLDivElement | null;
    const shadow = rootRegion?.style.boxShadow ?? '';
    expect(shadow).toContain('inset 0 1px 1px');
    expect(shadow).toContain('rgba(255,255,255');
  });

  it('深色模式 inline boxShadow 同样包含 inset 高光', async () => {
    useStore.setState({
      ...normalizeNotes([createNote()]),
      config: {
        ...useStore.getState().config,
        themeMode: 'dark',
      },
    });

    await renderNoteCard();
    const rootRegion = container.querySelector('.note-card') as HTMLDivElement | null;
    const shadow = rootRegion?.style.boxShadow ?? '';
    expect(shadow).toContain('inset 0 1px 0');
    expect(shadow).toContain('inset 1px 0 0');
    expect(shadow).toContain('rgba(255,255,255');
    expect(shadow).toContain('0 8px 20px -12px');
  });

  it('深色模式 inline backgroundImage 使用 accent 径向柔光，而不是只有白色线性高光', async () => {
    useStore.setState({
      ...normalizeNotes([createNote({ color: '#f3e8ff' })]),
      config: {
        ...useStore.getState().config,
        themeMode: 'dark',
      },
    });

    await renderNoteCard();

    const rootRegion = container.querySelector('.note-card') as HTMLDivElement | null;
    const bgImage = rootRegion?.style.backgroundImage ?? '';
    expect(bgImage).toContain('radial-gradient');
    expect(bgImage).toContain('168, 85, 247');
    expect(bgImage).toContain('linear-gradient');
  });

  it('pointercancel 清除 hover 态', async () => {
    useStore.setState({
      ...normalizeNotes([createNote({ color: '#fef9c3' })]),
      config: {
        ...useStore.getState().config,
        themeMode: 'dark',
      },
    });

    await renderNoteCard();

    const rootRegion = container.querySelector('.note-card') as HTMLDivElement | null;
    const spectrum = getNoteDarkSpectrum('#fef9c3');

    await act(async () => {
      rootRegion?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(rootRegion?.style.borderColor).toBe(hexToRgbaString(spectrum.accent, 0.4));

    await act(async () => {
      rootRegion?.dispatchEvent(new Event('pointercancel', { bubbles: true }));
    });
    expect(rootRegion?.style.borderColor).toBe(hexToRgbString(spectrum.border));
  });
});

describe('NoteCard 拖拽坐标换算', () => {
  it('边缘检测将世界坐标换算为屏幕坐标', () => {
    expect(getEdgeCheckRect(860, 260, { x: 200, y: 40 }, 260, 160)).toEqual({
      x: 660,
      y: 220,
      width: 260,
      height: 160,
    });
  });

  it('组拖拽边缘检测同样扣除当前视口偏移', () => {
    expect(getEdgeCheckRect(860, 260, { x: 200, y: 40 }, 260, 160, {
      minX: -120,
      minY: 30,
      width: 720,
      height: 360,
    })).toEqual({
      x: 540,
      y: 250,
      width: 720,
      height: 360,
    });
  });

  it('拖拽停止时保留 react-draggable 返回的世界坐标，避免重复叠加视口', () => {
    expect(resolveDragStopWorldPosition(230, 180, {
      x: 100,
      y: 50,
      w: 1280,
      h: 720,
    }, 260, 160, false, 10)).toEqual({
      x: 230,
      y: 180,
    });
  });

  it('拖拽停止时仍按屏幕边界夹取后换回世界坐标', () => {
    expect(resolveDragStopWorldPosition(1500, 900, {
      x: 100,
      y: 50,
      w: 1280,
      h: 720,
    }, 260, 160, false, 10)).toEqual({
      x: 1110,
      y: 600,
    });
  });
});

describe('NoteCard TRASH 右键菜单守卫', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...normalizeNotes([createNote()]),
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

  it('isStatic=true（TRASH 列表）时右键不打开 NOTE 菜单', async () => {
    const setContextMenu = vi.fn();
    useStore.setState({ setContextMenu });

    await act(async () => {
      root.render(<NoteCard id="note-1" isStatic={true} />);
    });

    const article = container.querySelector('.note-card') as HTMLElement | null;
    expect(article).not.toBeNull();

    await act(async () => {
      article?.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 150,
        clientY: 250,
      }));
    });

    expect(setContextMenu).not.toHaveBeenCalled();
  });

  it('isStatic=false（BOARD 模式）时右键正常打开 NOTE 菜单', async () => {
    const setContextMenu = vi.fn();
    useStore.setState({ setContextMenu });

    await act(async () => {
      root.render(<NoteCard id="note-1" isStatic={false} />);
    });

    const article = container.querySelector('.note-card') as HTMLElement | null;
    expect(article).not.toBeNull();

    await act(async () => {
      article?.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 150,
        clientY: 250,
      }));
    });

    expect(setContextMenu).toHaveBeenCalledWith({
      isOpen: true,
      x: 150,
      y: 250,
      type: 'NOTE',
      targetId: 'note-1',
    });
  });
});
