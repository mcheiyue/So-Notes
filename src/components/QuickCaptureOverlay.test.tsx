import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { QuickCaptureOverlay } from './QuickCaptureOverlay';
import { useStore } from '../store/useStore';
import { resetViewportSpawnSequenceForTests } from '../utils/spawnPosition';

const { readTextMock } = vi.hoisted(() => ({
  readTextMock: vi.fn(async () => ''),
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: readTextMock,
}));

describe('QuickCaptureOverlay 输入事件', () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderOverlay = async () => {
    await act(async () => {
      root.render(<QuickCaptureOverlay />);
    });
  };

  beforeEach(() => {
    readTextMock.mockReset();
    readTextMock.mockResolvedValue('');

    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
    );

    useStore.setState(useStore.getInitialState(), true);
    resetViewportSpawnSequenceForTests();
    useStore.setState({ isQuickCaptureOpen: true });

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

  it('IME 组合中按 Escape 不关闭浮层', async () => {
    await renderOverlay();

    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();

    await act(async () => {
      textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true }));
    });

    expect(useStore.getState().isQuickCaptureOpen).toBe(true);
  });

  it('非组合状态按 Escape 关闭浮层', async () => {
    await renderOverlay();

    expect(useStore.getState().isQuickCaptureOpen).toBe(true);

    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();

    await act(async () => {
      textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: false }));
    });

    expect(useStore.getState().isQuickCaptureOpen).toBe(false);
  });

  it('打开时读取剪贴板内容并预填并全选', async () => {
    readTextMock.mockResolvedValueOnce('剪贴板中的文本');

    useStore.setState({ isQuickCaptureOpen: false });
    await renderOverlay();

    const selectSpy = vi.spyOn(HTMLTextAreaElement.prototype, 'select');

    await act(async () => {
      useStore.setState({ isQuickCaptureOpen: true });
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toBe('剪贴板中的文本');
    expect(selectSpy).toHaveBeenCalled();

    selectSpy.mockRestore();
  });

  it('剪贴板为空时不覆盖已有状态', async () => {
    readTextMock.mockResolvedValueOnce('');

    await renderOverlay();

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toBe('');
  });

  it('Tab 焦点在对话框控件内循环', async () => {
    readTextMock.mockResolvedValueOnce('可提交内容');

    await renderOverlay();

    await act(async () => {
      await Promise.resolve();
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement | null;
    const buttons = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[];
    const dialogButtons = buttons.filter(
      (b) => b.textContent?.includes('取消') || b.textContent?.includes('创建'),
    );

    expect(textarea).not.toBeNull();
    expect(dialogButtons.length).toBe(2);
    const [cancelButton, createButton] = dialogButtons;

    textarea?.focus();
    expect(document.activeElement).toBe(textarea);

    await act(async () => {
      textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });

    expect(document.activeElement).toBe(cancelButton);

    await act(async () => {
      cancelButton?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });

    expect(document.activeElement).toBe(createButton);

    await act(async () => {
      createButton?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });

    expect(document.activeElement).toBe(textarea);
  });

  it('浮层阻断右键默认菜单', async () => {
    await renderOverlay();

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    dialog?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('根层使用壳内绝对定位，避免突破窗口圆角裁剪域', async () => {
    await renderOverlay();

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.className).toContain('absolute');
    expect(dialog?.className).toContain('pointer-events-auto');
    expect(dialog?.className).not.toContain('fixed');
  });

  it('提交快速捕获时使用统一视口落点', async () => {
    const addNotesWithContentBatch = vi.fn();
    useStore.setState({
      addNotesWithContentBatch,
      viewport: { x: 40, y: 60, w: 1280, h: 720 },
    });

    await renderOverlay();

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();

    await act(async () => {
      const setTextareaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setTextareaValue?.call(textarea, '快速捕获内容');
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const submitButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('创建'));
    expect(submitButton).toBeDefined();

    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(addNotesWithContentBatch).toHaveBeenCalledWith([
      { content: '快速捕获内容', x: 550, y: 132 },
    ]);
    expect(useStore.getState().isQuickCaptureOpen).toBe(false);
  });

  it('文案守卫: Quick Capture 显示当前看板且不使用页面工作区项目', async () => {
    // B-C16-1 / B-C16-2 / B-C16-3：有名正常路径 + 用户名含禁用子串时仍原样展示
    const cases = ['工作看板', '我的页面笔记', '工作区A', '项目X'] as const;

    for (const name of cases) {
      useStore.setState({
        boards: [
          { id: 'default', name: '我的看板', icon: '📌', createdAt: 0 },
          { id: 'work', name, icon: '💼', createdAt: 1 },
        ],
        currentBoardId: 'work',
        isQuickCaptureOpen: true,
      });

      await renderOverlay();

      const header = container.querySelector('.border-b');
      expect(header).not.toBeNull();
      const headerText = header?.textContent ?? '';

      expect(headerText).toContain(name);
      // 模板段守卫：禁止产品固定词顶替 label；禁止整段 /页面|工作区|项目/ 作唯一断言
      expect(headerText).not.toMatch(/快速捕获\s*·\s*(页面|工作区|项目)(\s|$)/);
      const labelSeg = headerText.split(/·/).slice(1).join('·').trim();
      expect(labelSeg).toBe(name);
    }
  });

  it('文案守卫: Quick Capture 空名回退当前看板', async () => {
    // B-C26-1..4 + B-C26-6/7：空串 / ASCII 空白 / 控制空白 / Unicode 空白 / board 缺失
    type EmptyCase =
      | { kind: 'name'; name: string }
      | { kind: 'missing-board' };

    const cases: EmptyCase[] = [
      { kind: 'name', name: '' },
      { kind: 'name', name: '   ' },
      { kind: 'name', name: '\t\n' },
      { kind: 'name', name: '\u00a0' },
      { kind: 'name', name: '\u3000' },
      { kind: 'missing-board' },
    ];

    for (const c of cases) {
      if (c.kind === 'missing-board') {
        useStore.setState({
          boards: [],
          currentBoardId: 'missing-board-id',
          isQuickCaptureOpen: true,
        });
      } else {
        useStore.setState({
          boards: [{ id: 'work', name: c.name, icon: '💼', createdAt: 1 }],
          currentBoardId: 'work',
          isQuickCaptureOpen: true,
        });
      }

      await renderOverlay();

      const header = container.querySelector('.border-b');
      expect(header).not.toBeNull();
      const headerText = header?.textContent ?? '';
      expect(headerText).toContain('当前看板');
      const labelSeg = headerText.split(/·/).slice(1).join('·').trim();
      expect(labelSeg).toBe('当前看板');
    }
  });

  it('文案守卫: Quick Capture 长名截断且 emoji 不抛错', async () => {
    // B-C26-5：emoji 前缀 + ≥80 字符 BMP 长串；不强制回退为「当前看板」
    const longName = `📌${'测'.repeat(80)}`;

    useStore.setState({
      boards: [{ id: 'work', name: longName, icon: '📌', createdAt: 1 }],
      currentBoardId: 'work',
      isQuickCaptureOpen: true,
    });

    await expect(renderOverlay()).resolves.not.toThrow();

    const header = container.querySelector('.border-b');
    expect(header).not.toBeNull();
    const labelSpan = header?.querySelector('.truncate');
    expect(labelSpan).not.toBeNull();
    expect(labelSpan?.className).toContain('truncate');

    const headerText = header?.textContent ?? '';
    expect(headerText).toContain(longName);
    expect(headerText).not.toMatch(/快速捕获\s*·\s*当前看板(\s|$)/);
    const labelSeg = headerText.split(/·/).slice(1).join('·').trim();
    expect(labelSeg).toBe(longName);
  });
});
