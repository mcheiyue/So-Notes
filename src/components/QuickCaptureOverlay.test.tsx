import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { QuickCaptureOverlay } from './QuickCaptureOverlay';
import { useStore } from '../store/useStore';

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
});
