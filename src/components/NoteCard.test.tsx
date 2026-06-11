import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, Root } from 'react-dom/client';

type MockDraggableCallback = (event: MouseEvent, ...args: unknown[]) => void;

type MockDraggableCoreProps = {
  onStart?: MockDraggableCallback;
  onDrag?: MockDraggableCallback;
  onStop?: MockDraggableCallback;
  disabled?: boolean;
};

type MockDraggableCoreComponentProps = MockDraggableCoreProps & {
  children: ReactNode;
  [key: string]: unknown;
};

const {
  convertFileSrcMock,
  resolveAttachmentPathMock,
  getCachedAttachmentAssetUrlMock,
  saveImageFromSystemClipboardMock,
  writeImageMock,
  imageFromPathMock,
  getImageDimensionsFromRelativePathMock,
  draggableCorePropsRef,
} = vi.hoisted(() => ({
  convertFileSrcMock: vi.fn((path: string) => `asset://localhost/${path}`),
  resolveAttachmentPathMock: vi.fn(async (path: string) => `/abs/${path}`),
  getCachedAttachmentAssetUrlMock: vi.fn((path: string) => `asset://localhost//abs/${path}`),
  saveImageFromSystemClipboardMock: vi.fn(async () => ({
    hash: 'b'.repeat(64),
    filename: 'clipboard-image.png',
    mimeType: 'image/png',
    size: 2048,
    relativePath: `attachments/${'b'.repeat(64)}.png`,
    createdAt: 2,
    bytesWritten: 2048,
  })),
  writeImageMock: vi.fn(async () => undefined),
  imageFromPathMock: vi.fn(async (path: string) => ({ path, __tauriImage: true })),
  getImageDimensionsFromRelativePathMock: vi.fn(async () => ({ width: 1080, height: 1920 })),
  draggableCorePropsRef: { current: null as MockDraggableCoreProps | null },
}));

vi.mock('@tauri-apps/api/image', () => ({
  Image: {
    fromPath: imageFromPathMock,
  },
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeImage: writeImageMock,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
  convertFileSrc: convertFileSrcMock,
}));

vi.mock('../services/storage/attachmentPersistence', () => ({
  resolveAttachmentPath: resolveAttachmentPathMock,
  getCachedAttachmentAssetUrl: getCachedAttachmentAssetUrlMock,
  saveImageFromSystemClipboard: saveImageFromSystemClipboardMock,
}));

vi.mock('../utils/imageDimensions', () => ({
  getImageDimensionsFromRelativePath: getImageDimensionsFromRelativePathMock,
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
  default: ({ children }: { children: ReactNode }) => children,
  DraggableCore: ({ children, ...props }: MockDraggableCoreComponentProps) => {
    draggableCorePropsRef.current = props;
    return children;
  },
}));

vi.mock('../store/confirmStore', () => ({
  confirm: vi.fn(async () => true),
}));

import { NoteCard } from './NoteCard';
import { confirm } from '../store/confirmStore';
import { useStore } from '../store/useStore';
import { useUIStore } from '../store';
import { normalizeNotes } from '../store/normalization';
import { getNoteColor, getNoteDarkSpectrum, Note } from '../store/types';
import type { AttachmentRef } from '../store/types';
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
  kind: 'text',
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

const createAttachment = (overrides: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: 'att-1',
  hash: 'a'.repeat(64),
  filename: 'photo.png',
  mimeType: 'image/png',
  size: 1024,
  relativePath: `attachments/${'a'.repeat(64)}.png`,
  createdAt: 1,
  ...overrides,
});

const getLatestDraggableCoreProps = (): MockDraggableCoreProps => {
  const props = draggableCorePropsRef.current;
  if (!props) {
    throw new Error('未捕获到 DraggableCore props');
  }

  return props;
};

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
    convertFileSrcMock.mockClear();
    resolveAttachmentPathMock.mockClear();
    resolveAttachmentPathMock.mockImplementation(async (path: string) => `/abs/${path}`);
    getCachedAttachmentAssetUrlMock.mockClear();
    getCachedAttachmentAssetUrlMock.mockImplementation((path: string) => `asset://localhost//abs/${path}`);
    saveImageFromSystemClipboardMock.mockClear();
    writeImageMock.mockClear();
    imageFromPathMock.mockClear();
    getImageDimensionsFromRelativePathMock.mockClear();
    getImageDimensionsFromRelativePathMock.mockResolvedValue({ width: 1080, height: 1920 });
    draggableCorePropsRef.current = null;
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => undefined),
      },
    });
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

  it('折叠态便签的 article 内第一个子元素是 .drag-handle 头部，保证拖拽命中区域', async () => {
    useStore.setState({
      ...normalizeNotes([createNote({ collapsed: true, title: '折叠拖拽' })]),
    });

    await renderNoteCard();

    const article = container.querySelector('[data-note-visuals]') as HTMLElement | null;
    expect(article).not.toBeNull();

    const firstElementChild = article?.firstElementChild as HTMLElement | null;
    expect(firstElementChild).not.toBeNull();
    expect(firstElementChild?.classList.contains('drag-handle')).toBe(true);
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
    const textarea = container.querySelector('textarea[placeholder="记点什么…"]') as HTMLTextAreaElement | null;
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

  it('正文输入框图片粘贴在当前便签旁创建图片便签，不走文本插入', async () => {
    const addImageNotesBatch = vi.fn();
    useStore.setState({ addImageNotesBatch });
    await renderNoteCard();

    const textarea = container.querySelector('textarea[placeholder="记点什么…"]') as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();

    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        items: [{ type: 'image/png' }],
      },
    });

    await act(async () => {
      textarea?.dispatchEvent(pasteEvent);
    });

    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(saveImageFromSystemClipboardMock).toHaveBeenCalledTimes(1);
    expect(getImageDimensionsFromRelativePathMock).toHaveBeenCalledWith(`attachments/${'b'.repeat(64)}.png`);
    expect(addImageNotesBatch).toHaveBeenCalledTimes(1);
    expect(addImageNotesBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        x: 400,
        y: 140,
        originalWidth: 1080,
        originalHeight: 1920,
        attachment: expect.objectContaining({
          hash: 'b'.repeat(64),
          filename: 'clipboard-image.png',
          mimeType: 'image/png',
          relativePath: `attachments/${'b'.repeat(64)}.png`,
        }),
      }),
    ]);
  });

  it('标题输入框文本粘贴不拦截，保留原生输入行为', async () => {
    const addImageNotesBatch = vi.fn();
    useStore.setState({ addImageNotesBatch });
    await renderNoteCard();

    const titleInput = container.querySelector('input[placeholder="标题"]') as HTMLInputElement | null;
    expect(titleInput).not.toBeNull();

    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        items: [{ type: 'text/plain' }],
      },
    });

    await act(async () => {
      titleInput?.dispatchEvent(pasteEvent);
    });

    expect(pasteEvent.defaultPrevented).toBe(false);
    expect(saveImageFromSystemClipboardMock).not.toHaveBeenCalled();
    expect(addImageNotesBatch).not.toHaveBeenCalled();
  });

  it('尺寸拖拽期间禁用 width/height 过渡', async () => {
    useStore.setState({ selectedIds: ['note-1'] });
    await renderNoteCard();

    const article = container.querySelector('.note-card') as HTMLElement | null;
    const handle = container.querySelector('[aria-label="调整便签尺寸"]') as HTMLElement | null;
    expect(article).not.toBeNull();
    expect(handle).not.toBeNull();
    expect(article?.className).toContain('transition-[box-shadow,border-color,background-color,width,height]');

    handle!.setPointerCapture = vi.fn();

    await act(async () => {
      handle?.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        clientX: 260,
        clientY: 220,
      }));
    });

    expect(article?.className).toContain('transition-[box-shadow,border-color,background-color]');
    expect(article?.className).not.toContain('width,height');
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

    const textarea = container.querySelector('textarea[placeholder="记点什么…"]') as HTMLTextAreaElement | null;
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

  it('拖拽在便签内停止时无需重新 mouseover 也会恢复 chrome', async () => {
    await renderNoteCard();

    const rootRegion = container.querySelector('.note-card') as HTMLDivElement | null;
    expect(rootRegion).not.toBeNull();
    vi.spyOn(rootRegion!, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 120, 260, 160));

    await act(async () => {
      rootRegion?.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true,
        clientX: 140,
        clientY: 150,
      }));
    });

    expect((container.querySelector('.drag-handle') as HTMLDivElement | null)?.className).toContain('opacity-100');
    expect(container.querySelector('[aria-label="复制内容"]')).not.toBeNull();

    const { onStart, onStop } = getLatestDraggableCoreProps();

    await act(async () => {
      onStart?.(new MouseEvent('mousedown', {
        bubbles: true,
        clientX: 140,
        clientY: 150,
      }));
    });

    expect((container.querySelector('.drag-handle') as HTMLDivElement | null)?.className).toContain('opacity-0');
    expect(container.querySelector('[aria-label="复制内容"]')).toBeNull();

    await act(async () => {
      onStop?.(new MouseEvent('mouseup', {
        bubbles: true,
        clientX: 180,
        clientY: 200,
      }));
    });

    expect((container.querySelector('.drag-handle') as HTMLDivElement | null)?.className).toContain('opacity-100');
    expect(container.querySelector('[aria-label="复制内容"]')).not.toBeNull();
  });

  it('拖拽在便签外停止时保持 chrome 隐藏', async () => {
    await renderNoteCard();

    const rootRegion = container.querySelector('.note-card') as HTMLDivElement | null;
    expect(rootRegion).not.toBeNull();
    vi.spyOn(rootRegion!, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 120, 260, 160));

    await act(async () => {
      rootRegion?.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true,
        clientX: 140,
        clientY: 150,
      }));
    });

    expect((container.querySelector('.drag-handle') as HTMLDivElement | null)?.className).toContain('opacity-100');
    expect(container.querySelector('[aria-label="复制内容"]')).not.toBeNull();

    const { onStart, onStop } = getLatestDraggableCoreProps();

    await act(async () => {
      onStart?.(new MouseEvent('mousedown', {
        bubbles: true,
        clientX: 140,
        clientY: 150,
      }));
    });

    expect((container.querySelector('.drag-handle') as HTMLDivElement | null)?.className).toContain('opacity-0');
    expect(container.querySelector('[aria-label="复制内容"]')).toBeNull();

    await act(async () => {
      onStop?.(new MouseEvent('mouseup', {
        bubbles: true,
        clientX: 420,
        clientY: 320,
      }));
    });

    expect((container.querySelector('.drag-handle') as HTMLDivElement | null)?.className).toContain('opacity-0');
    expect(container.querySelector('[aria-label="复制内容"]')).toBeNull();
  });

  it('拖拽未选中的便签时在拖拽开始阶段收敛选中，清掉陈旧多选高亮', async () => {
    useStore.setState({
      ...normalizeNotes([
        createNote(),
        createNote({ id: 'note-2', x: 420, y: 160 }),
        createNote({ id: 'note-3', x: 720, y: 220 }),
      ]),
      selectedIds: ['note-2', 'note-3'],
    });

    await renderNoteCard();

    const header = container.querySelector('.drag-handle') as HTMLDivElement | null;
    expect(header).not.toBeNull();

    await act(async () => {
      header?.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        clientX: 220,
        clientY: 180,
      }));
    });

    expect(useStore.getState().selectedIds).toEqual(['note-2', 'note-3']);

    const { onStart, onStop } = getLatestDraggableCoreProps();

    await act(async () => {
      onStart?.(new MouseEvent('mousedown', {
        bubbles: true,
        clientX: 220,
        clientY: 180,
      }));
    });

    expect(useStore.getState().selectedIds).toEqual(['note-1']);

    await act(async () => {
      onStop?.(new MouseEvent('mouseup', {
        bubbles: true,
        clientX: 220,
        clientY: 180,
      }));
    });
  });

  it('点击拖拽表面置顶不写入领域撤销历史', async () => {
    useStore.setState({
      ...normalizeNotes([
        createNote({ z: 1 }),
        createNote({ id: 'note-2', x: 420, y: 160, z: 2 }),
      ]),
      config: {
        ...useStore.getState().config,
        maxZ: 2,
      },
    });

    await renderNoteCard();

    const header = container.querySelector('.drag-handle') as HTMLDivElement | null;
    expect(header).not.toBeNull();

    const beforeUndoLength = useStore.getState().domainHistory.undoStack.length;

    await act(async () => {
      header?.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        clientX: 220,
        clientY: 180,
      }));
    });

    const state = useStore.getState();
    expect(state.notesById['note-1']?.z).toBe(3);
    expect(state.domainHistory.undoStack).toHaveLength(beforeUndoLength);
  });

  it('普通点击便签主体置顶不写入领域撤销历史', async () => {
    useStore.setState({
      ...normalizeNotes([
        createNote({ z: 1 }),
        createNote({ id: 'note-2', x: 420, y: 160, z: 2 }),
      ]),
      config: {
        ...useStore.getState().config,
        maxZ: 2,
      },
    });

    await renderNoteCard();

    const rootRegion = container.querySelector('.note-card') as HTMLDivElement | null;
    expect(rootRegion).not.toBeNull();

    const beforeUndoLength = useStore.getState().domainHistory.undoStack.length;

    await act(async () => {
      rootRegion?.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        clientX: 220,
        clientY: 180,
      }));
    });

    const state = useStore.getState();
    expect(state.notesById['note-1']?.z).toBe(3);
    expect(state.selectedIds).toEqual(['note-1']);
    expect(state.domainHistory.undoStack).toHaveLength(beforeUndoLength);
  });

  it('拖拽已在多选里的便签时保留当前多选，继续按组选中拖拽', async () => {
    useStore.setState({
      ...normalizeNotes([
        createNote(),
        createNote({ id: 'note-2', x: 420, y: 160 }),
      ]),
      selectedIds: ['note-1', 'note-2'],
    });

    await renderNoteCard();

    const { onStart, onStop } = getLatestDraggableCoreProps();

    await act(async () => {
      onStart?.(new MouseEvent('mousedown', {
        bubbles: true,
        clientX: 220,
        clientY: 180,
      }));
    });

    expect(useStore.getState().selectedIds).toEqual(['note-1', 'note-2']);

    await act(async () => {
      onStop?.(new MouseEvent('mouseup', {
        bubbles: true,
        clientX: 220,
        clientY: 180,
      }));
    });
  });

  it('平移模式不再整卡禁用指针事件，chrome 可恢复显示且不会退化成普通便签交互', async () => {
    useStore.setState({
      ...normalizeNotes([
        createNote(),
        createNote({ id: 'note-2', x: 420, y: 160 }),
      ]),
      selectedIds: ['note-2'],
      interaction: {
        ...useStore.getState().interaction,
        isPanMode: true,
      },
    });

    await renderNoteCard();

    const rootRegion = container.querySelector('.note-card') as HTMLDivElement | null;
    expect(rootRegion).not.toBeNull();
    expect(rootRegion?.className).not.toContain('pointer-events-none');
    expect(container.querySelector('[data-note-pan-guard="true"]')).not.toBeNull();
    expect(getLatestDraggableCoreProps().disabled).toBe(true);

    await act(async () => {
      rootRegion?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    expect((container.querySelector('.drag-handle') as HTMLDivElement | null)?.className).toContain('opacity-100');
    expect(container.querySelector('[aria-label="复制内容"]')).not.toBeNull();

    await act(async () => {
      rootRegion?.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        clientX: 220,
        clientY: 180,
      }));
    });

    expect(useStore.getState().selectedIds).toEqual(['note-2']);

    await act(async () => {
      useStore.setState({
        interaction: {
          ...useStore.getState().interaction,
          isPanMode: false,
        },
      });
    });

    expect(container.querySelector('[data-note-pan-guard="true"]')).toBeNull();
    expect((container.querySelector('.drag-handle') as HTMLDivElement | null)?.className).toContain('opacity-100');
  });

  it('平移模式在指针已位于卡片内且未重新 mouseover 时，mousedown 也会恢复 chrome 且不改选中态', async () => {
    useStore.setState({
      ...normalizeNotes([
        createNote({ title: '' }),
        createNote({ id: 'note-2', x: 420, y: 160 }),
      ]),
      selectedIds: ['note-2'],
      interaction: {
        ...useStore.getState().interaction,
        isPanMode: true,
      },
    });

    await renderNoteCard();

    const header = container.querySelector('.drag-handle') as HTMLDivElement | null;
    const titleInput = container.querySelector('input[placeholder="标题"]') as HTMLInputElement | null;
    const panGuard = container.querySelector('[data-note-pan-guard="true"]') as HTMLDivElement | null;

    expect(header?.className).toContain('opacity-0');
    expect(titleInput?.className).toContain('hidden');
    expect(container.querySelector('[aria-label="复制内容"]')).toBeNull();
    expect(panGuard).not.toBeNull();

    await act(async () => {
      panGuard?.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        clientX: 220,
        clientY: 180,
      }));
    });

    expect((container.querySelector('.drag-handle') as HTMLDivElement | null)?.className).toContain('opacity-100');
    expect((container.querySelector('input[placeholder="标题"]') as HTMLInputElement | null)?.className).toContain('block');
    expect(container.querySelector('[aria-label="复制内容"]')).not.toBeNull();
    expect(useStore.getState().selectedIds).toEqual(['note-2']);
  });

  it('编辑正文后在失焦时触发临时编辑高亮', async () => {
    const markNoteHighlights = vi.fn();
    useUIStore.setState({ markNoteHighlights });

    await renderNoteCard();

    const textarea = container.querySelector('textarea[placeholder="记点什么…"]') as HTMLTextAreaElement | null;
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

  it('article 元素带有 data-note-visuals 属性，证明通过 NoteVisuals 渲染', async () => {
    await renderNoteCard();
    const article = container.querySelector('[data-note-visuals]') as HTMLElement | null;
    expect(article).not.toBeNull();
    expect(article?.getAttribute('data-note-visuals')).toBe('true');
    expect(article?.className).toContain('note-card');
  });

  it('展开图片便签渲染主图预览且不再显示附件条', async () => {
    const attachment = createAttachment();
    useStore.setState({
      ...normalizeNotes([createNote({ kind: 'image', title: 'photo.png', attachments: [attachment] })]),
    });

    await renderNoteCard();

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="image-note-preview-trigger"]')).not.toBeNull();
      expect(container.querySelector('img')?.getAttribute('src')).toBe(`asset://localhost//abs/${attachment.relativePath}`);
    });

    expect(container.querySelector('[data-testid="note-attachments"]')).toBeNull();
  });

  it('图片便签复制按钮复制图片本身而不是文件名文本', async () => {
    const attachment = createAttachment();
    useStore.setState({
      ...normalizeNotes([createNote({ kind: 'image', title: 'photo.png', content: '', attachments: [attachment] })]),
    });

    await renderNoteCard();

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="image-note-preview-trigger"]')).not.toBeNull();
    });

    const rootRegion = container.querySelector('.note-card') as HTMLDivElement | null;
    await act(async () => {
      rootRegion?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    const copyButton = container.querySelector('[aria-label="复制内容"]') as HTMLButtonElement | null;
    expect(copyButton).not.toBeNull();

    await act(async () => {
      copyButton?.click();
    });

    await vi.waitFor(() => {
      expect(imageFromPathMock).toHaveBeenCalledWith(`/abs/${attachment.relativePath}`);
      expect(writeImageMock).toHaveBeenCalledWith({ path: `/abs/${attachment.relativePath}`, __tauriImage: true });
    });
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('图片便签复制失败时给出可见失败反馈', async () => {
    const attachment = createAttachment();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    imageFromPathMock.mockRejectedValueOnce(new Error('缺少 image-png feature'));
    useStore.setState({
      ...normalizeNotes([createNote({ kind: 'image', title: 'photo.png', content: '', attachments: [attachment] })]),
    });

    await renderNoteCard();

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="image-note-preview-trigger"]')).not.toBeNull();
    });

    const rootRegion = container.querySelector('.note-card') as HTMLDivElement | null;
    await act(async () => {
      rootRegion?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    const copyButton = container.querySelector('[aria-label="复制内容"]') as HTMLButtonElement | null;
    expect(copyButton).not.toBeNull();

    await act(async () => {
      copyButton?.click();
    });

    await vi.waitFor(() => {
      expect(copyButton?.className).toContain('text-red-500');
    });
    expect(writeImageMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to copy note:', expect.any(Error));
    consoleErrorSpy.mockRestore();
  });

  it('折叠图片便签不渲染主图预览', async () => {
    useStore.setState({
      ...normalizeNotes([createNote({ kind: 'image', collapsed: true, attachments: [createAttachment()] })]),
    });

    await renderNoteCard();

    expect(container.querySelector('[data-testid="image-note-preview-trigger"]')).toBeNull();
    expect(resolveAttachmentPathMock).not.toHaveBeenCalled();
  });

  it('展开图片便签点击预览后覆盖层挂载在 document.body 而非便签卡片内部（需先聚焦）', async () => {
    const attachment = createAttachment();
    useStore.setState({
      ...normalizeNotes([createNote({ kind: 'image', title: 'photo.png', attachments: [attachment] })]),
      selectedIds: ['note-1'],
    });

    await renderNoteCard();

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="image-note-preview-trigger"]')).not.toBeNull();
    });

    const trigger = container.querySelector('[data-testid="image-note-preview-trigger"]') as HTMLButtonElement;
    await act(async () => {
      trigger.click();
    });

    expect(container.querySelector('[data-testid="image-note-preview-overlay"]')).toBeNull();

    const overlayOnBody = document.body.querySelector('[data-testid="image-note-preview-overlay"]') as HTMLElement | null;
    expect(overlayOnBody).not.toBeNull();
    expect(overlayOnBody?.className).toContain('fixed');
    expect(overlayOnBody?.className).toContain('inset-2');
    expect(overlayOnBody?.className).toContain('rounded-2xl');

    const previewImg = overlayOnBody?.querySelector('img') as HTMLImageElement | null;
    expect(previewImg).not.toBeNull();
    expect(previewImg?.className).toContain('rounded-xl');
    expect(previewImg?.className).toContain('border');

    await act(async () => {
      overlayOnBody?.click();
    });

    expect(document.body.querySelector('[data-testid="image-note-preview-overlay"]')).toBeNull();
  });

  it('未聚焦的展开图片便签点击预览不打开覆盖层', async () => {
    const attachment = createAttachment();
    useStore.setState({
      ...normalizeNotes([createNote({ kind: 'image', title: 'photo.png', attachments: [attachment] })]),
      selectedIds: [],
    });

    await renderNoteCard();

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="image-note-preview-trigger"]')).not.toBeNull();
    });

    const trigger = container.querySelector('[data-testid="image-note-preview-trigger"]') as HTMLButtonElement;
    expect(trigger.className).toContain('cursor-default');

    await act(async () => {
      trigger.click();
    });

    expect(document.body.querySelector('[data-testid="image-note-preview-overlay"]')).toBeNull();
  });

  it('未聚焦图片便签首次点击主图只聚焦，第二次点击才打开大图', async () => {
    const attachment = createAttachment();
    useStore.setState({
      ...normalizeNotes([createNote({ kind: 'image', title: 'photo.png', attachments: [attachment] })]),
      selectedIds: [],
    });

    await renderNoteCard();

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="image-note-preview-trigger"]')).not.toBeNull();
    });

    let trigger = container.querySelector('[data-testid="image-note-preview-trigger"]') as HTMLButtonElement;
    await act(async () => {
      trigger.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      trigger.click();
    });

    expect(useStore.getState().selectedIds).toEqual(['note-1']);
    expect(document.body.querySelector('[data-testid="image-note-preview-overlay"]')).toBeNull();

    trigger = container.querySelector('[data-testid="image-note-preview-trigger"]') as HTMLButtonElement;
    await act(async () => {
      trigger.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      trigger.click();
    });

    expect(document.body.querySelector('[data-testid="image-note-preview-overlay"]')).not.toBeNull();
  });

  it('深色模式视觉样式与 NoteVisuals 独立渲染一致（共享视觉渲染能力）', async () => {
    useStore.setState({
      ...normalizeNotes([createNote({ color: '#fef9c3' })]),
      config: {
        ...useStore.getState().config,
        themeMode: 'dark',
      },
    });

    await renderNoteCard();

    const article = container.querySelector('[data-note-visuals]') as HTMLElement | null;
    const spectrum = getNoteDarkSpectrum('#fef9c3');

    expect(article).not.toBeNull();
    expect(article?.style.backgroundColor).toBe(hexToRgbString(getNoteColor('#fef9c3', true)));
    expect(article?.style.backgroundImage).toContain('radial-gradient');
    expect(article?.style.backgroundImage).toContain('245, 158, 11');
    expect(article?.style.boxShadow).toContain('0 8px 20px -12px');
    expect(article?.style.borderColor).toBe(hexToRgbString(spectrum.border));
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

  it('isStatic=true 时永久删除使用统一确认文案', async () => {
    vi.mocked(confirm).mockResolvedValue(false);
    const deleteNotePermanently = vi.fn();
    useStore.setState({ deleteNotePermanently });

    await act(async () => {
      root.render(<NoteCard id="note-1" isStatic={true} />);
    });

    const deleteButton = container.querySelector('[aria-label="永久删除"]') as HTMLButtonElement | null;
    expect(deleteButton).not.toBeNull();

    await act(async () => {
      deleteButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(confirm).toHaveBeenCalledWith({ title: '永久删除', message: '确认永久删除此便签？此操作无法撤销。', kind: 'danger' });
    expect(deleteNotePermanently).not.toHaveBeenCalled();
  });
});
