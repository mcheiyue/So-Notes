import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { QuickCaptureOverlay } from './QuickCaptureOverlay';
import { useStore } from '../store/useStore';
import { resetViewportSpawnSequenceForTests } from '../utils/spawnPosition';

describe('QuickCaptureOverlay 输入事件', () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderOverlay = async () => {
    await act(async () => {
      root.render(<QuickCaptureOverlay />);
    });
  };

  beforeEach(() => {
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

  it('textarea 内按 Escape 不关闭浮层，避免输入法取消组字时丢内容', async () => {
    await renderOverlay();

    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();

    await act(async () => {
      textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });

    expect(useStore.getState().isQuickCaptureOpen).toBe(true);
  });

  it('浮层阻断右键默认菜单', async () => {
    await renderOverlay();

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    dialog?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
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
});
