import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { WindowShell } from './WindowShell';

describe('WindowShell 内容区测量契约', () => {
  let container: HTMLDivElement;
  let root: Root;
  let resizeObserverCallback: ResizeObserverCallback | null = null;

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        resizeObserverCallback = callback;
      }

      observe() {}
      disconnect() {}
      unobserve() {}
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
    resizeObserverCallback = null;
    vi.unstubAllGlobals();
  });

  it('在内容区尺寸变化时向外同步矩形信息', async () => {
    const onContentRectChange = vi.fn();
    const emptyBoxSizes: ResizeObserverSize[] = [];

    await act(async () => {
      root.render(
        <WindowShell onContentRectChange={onContentRectChange}>
          <div>content</div>
        </WindowShell>
      );
    });

    const shellContent = container.querySelector('[data-testid="window-shell-content"]') as HTMLDivElement | null;
    expect(shellContent).not.toBeNull();

    Object.defineProperty(shellContent, 'clientWidth', { configurable: true, value: 320 });
    Object.defineProperty(shellContent, 'clientHeight', { configurable: true, value: 240 });
    shellContent!.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      top: 0,
      right: 320,
      bottom: 240,
      width: 320,
      height: 240,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect));

    await act(async () => {
      resizeObserverCallback?.([
        {
          contentRect: {
            width: 320,
            height: 240,
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: 320,
            bottom: 240,
            toJSON: () => ({}),
          } as DOMRectReadOnly,
          target: shellContent!,
          borderBoxSize: emptyBoxSizes,
          contentBoxSize: emptyBoxSizes,
          devicePixelContentBoxSize: emptyBoxSizes,
        },
      ], {} as ResizeObserver);
    });

    expect(onContentRectChange).toHaveBeenCalledWith({
      width: 320,
      height: 240,
      left: 0,
      top: 0,
      right: 320,
      bottom: 240,
    });
  });

  it('壳层启用 isolate 并固定 content/overlay 分层', async () => {
    await act(async () => {
      root.render(
        <WindowShell overlay={<div data-testid="overlay-child" />}>
          <div>content</div>
        </WindowShell>
      );
    });

    const shell = container.querySelector('[data-testid="window-shell"]') as HTMLElement | null;
    const content = container.querySelector('[data-testid="window-shell-content"]') as HTMLElement | null;
    const overlay = container.querySelector('[data-testid="window-shell-overlay"]') as HTMLElement | null;

    expect(shell?.className).toContain('isolate');
    expect(content?.className).toContain('z-0');
    expect(overlay?.className).toContain('z-10');
  });
});
