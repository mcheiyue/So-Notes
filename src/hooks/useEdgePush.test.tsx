import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { useEffect } from 'react';
import { createInitialViewportState, useViewportStore } from '../store/viewportStore';
import { EDGE_PUSH_ACTIVATION_DELAY, EDGE_PUSH_EXIT_THRESHOLD, useEdgePush } from './useEdgePush';
import { LAYOUT } from '../constants/layout';

type EdgeHarnessApi = {
  checkEdge: (x: number, y: number, width: number, height: number) => void;
  clearEdge: () => void;
};

let harnessApi: EdgeHarnessApi | null = null;

const EdgeHarness = () => {
  const { checkEdge, clearEdge } = useEdgePush();

  useEffect(() => {
    harnessApi = { checkEdge, clearEdge };
    return () => {
      harnessApi = null;
    };
  }, [checkEdge, clearEdge]);

  return null;
};

describe('useEdgePush', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });

    // 策略 A：edgePush 只写 useViewportStore，测试读源与生产一致
    useViewportStore.getState().replaceViewportState({
      ...createInitialViewportState(),
      viewport: { x: 40, y: 60, w: 1280, h: 720 },
      interaction: {
        isPanMode: false,
        isDragging: true,
        edgePush: { top: false, bottom: false, left: false, right: false },
      },
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<EdgeHarness />);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    harnessApi = null;
    vi.useRealTimers();
  });

  it('首次靠边需要经过 arming 延迟后才进入 edge push', async () => {
    expect(EDGE_PUSH_ACTIVATION_DELAY).toBe(1000);

    await act(async () => {
      harnessApi?.checkEdge(1005, 100, 260, 120);
    });

    expect(useViewportStore.getState().interaction.edgePush.right).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(EDGE_PUSH_ACTIVATION_DELAY - 1);
    });

    expect(useViewportStore.getState().interaction.edgePush.right).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });

    expect(useViewportStore.getState().interaction.edgePush.right).toBe(true);
  });

  it('active pushing 期间轻微 jitter 不会立即断流', async () => {
    await act(async () => {
      harnessApi?.checkEdge(1005, 100, 260, 120);
      vi.advanceTimersByTime(EDGE_PUSH_ACTIVATION_DELAY);
    });

    expect(useViewportStore.getState().interaction.edgePush.right).toBe(true);

    const jitterX = 1280 - 260 - LAYOUT.EDGE_PUSH_THRESHOLD - 6;
    expect(jitterX).toBeGreaterThan(1280 - 260 - EDGE_PUSH_EXIT_THRESHOLD);

    await act(async () => {
      harnessApi?.checkEdge(jitterX, 100, 260, 120);
      vi.advanceTimersByTime(EDGE_PUSH_ACTIVATION_DELAY);
    });

    expect(useViewportStore.getState().interaction.edgePush.right).toBe(true);
  });

  it('明显离开边缘后才退出 pushing', async () => {
    await act(async () => {
      harnessApi?.checkEdge(1005, 100, 260, 120);
      vi.advanceTimersByTime(EDGE_PUSH_ACTIVATION_DELAY);
    });

    expect(useViewportStore.getState().interaction.edgePush.right).toBe(true);

    const leaveX = 1280 - 260 - EDGE_PUSH_EXIT_THRESHOLD - 20;

    await act(async () => {
      harnessApi?.checkEdge(leaveX, 100, 260, 120);
    });

    expect(useViewportStore.getState().interaction.edgePush.right).toBe(false);
  });

  it('drag session 结束后会清理 pending timer 与 pushing 状态', async () => {
    await act(async () => {
      harnessApi?.checkEdge(1005, 100, 260, 120);
    });

    useViewportStore.getState().setIsDragging(false);

    await act(async () => {
      vi.advanceTimersByTime(EDGE_PUSH_ACTIVATION_DELAY);
    });

    expect(useViewportStore.getState().interaction.edgePush.right).toBe(false);
  });
});
