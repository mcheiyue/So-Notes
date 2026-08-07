import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialViewportState, useViewportStore, viewportSelectors } from './viewportStore';
import { useStore } from './useStore';

const resetViewportStore = () => {
  useViewportStore.getState().replaceViewportState(createInitialViewportState());
};

describe('viewportStore 初始状态与 selector', () => {
  beforeEach(() => {
    resetViewportStore();
  });

  it('提供默认 Viewport 状态，不包含 Domain 与 UI 状态', () => {
    const state = createInitialViewportState();

    expect(state.viewport).toBeDefined();
    expect(state.viewport.x).toBe(0);
    expect(state.viewport.y).toBe(0);
    expect(state.shellRect).toBeDefined();
    expect(state.canvas).toBeDefined();
    expect(state.interaction.isPanMode).toBe(false);
    expect(state.interaction.isDragging).toBe(false);
    expect(state.interaction.edgePush).toEqual({ top: false, bottom: false, left: false, right: false });
    expect(state.stickyDrag).toEqual({ id: null, offsetX: 0, offsetY: 0, status: 'active' });
    expect('notesById' in state).toBe(false);
    expect('selectedIds' in state).toBe(false);
    expect('viewMode' in state).toBe(false);
  });

  it('viewport selector 能正确读取各子状态', () => {
    const state = createInitialViewportState();

    expect(viewportSelectors.viewport(state)).toBe(state.viewport);
    expect(viewportSelectors.shellRect(state)).toBe(state.shellRect);
    expect(viewportSelectors.canvas(state)).toBe(state.canvas);
    expect(viewportSelectors.interaction(state)).toBe(state.interaction);
    expect(viewportSelectors.stickyDrag(state)).toBe(state.stickyDrag);
  });
});

describe('viewportStore 写入动作', () => {
  beforeEach(() => {
    resetViewportStore();
  });

  it('setViewportSize 更新 viewport 尺寸并自动扩展 canvas', () => {
    useViewportStore.getState().setViewportSize(800, 600);
    const state = useViewportStore.getState();

    expect(state.viewport.w).toBe(800);
    expect(state.viewport.h).toBe(600);
    expect(state.canvas.w).toBeGreaterThanOrEqual(800);
    expect(state.canvas.h).toBeGreaterThanOrEqual(600);
  });

  it('setShellRect 更新 shell 矩形', () => {
    const rect = { left: 10, top: 20, right: 1290, bottom: 740 };
    useViewportStore.getState().setShellRect(rect);

    expect(useViewportStore.getState().shellRect).toEqual(rect);
  });

  it('setPanMode 切换平移模式', () => {
    useViewportStore.getState().setPanMode(true);
    expect(useViewportStore.getState().interaction.isPanMode).toBe(true);

    useViewportStore.getState().setPanMode(false);
    expect(useViewportStore.getState().interaction.isPanMode).toBe(false);
  });

  it('setEdgePush 合并更新 edge push 状态', () => {
    useViewportStore.getState().setEdgePush({ right: true });
    expect(useViewportStore.getState().interaction.edgePush.right).toBe(true);
    expect(useViewportStore.getState().interaction.edgePush.top).toBe(false);

    useViewportStore.getState().setEdgePush({ top: true, right: false });
    expect(useViewportStore.getState().interaction.edgePush.top).toBe(true);
    expect(useViewportStore.getState().interaction.edgePush.right).toBe(false);
  });

  it('panViewport 应用增量并自动扩展 canvas', () => {
    useViewportStore.getState().panViewport(100, 200);
    const state = useViewportStore.getState();

    expect(state.viewport.x).toBe(100);
    expect(state.viewport.y).toBe(200);
    expect(state.canvas.w).toBeGreaterThanOrEqual(state.viewport.x + state.viewport.w);
    expect(state.canvas.h).toBeGreaterThanOrEqual(state.viewport.y + state.viewport.h);
  });

  it('panViewport 遵循左上硬墙 (x>=0, y>=0)', () => {
    useViewportStore.getState().panViewport(50, 50);
    useViewportStore.getState().panViewport(-200, -200);

    expect(useViewportStore.getState().viewport.x).toBe(0);
    expect(useViewportStore.getState().viewport.y).toBe(0);
  });

  it('setViewportPosition 使用绝对坐标并自动扩展 canvas', () => {
    useViewportStore.getState().setViewportPosition(300, 400);
    const state = useViewportStore.getState();

    expect(state.viewport.x).toBe(300);
    expect(state.viewport.y).toBe(400);
    expect(state.canvas.w).toBeGreaterThanOrEqual(300 + state.viewport.w);
    expect(state.canvas.h).toBeGreaterThanOrEqual(400 + state.viewport.h);
  });

  it('setViewportPosition 遵循左上硬墙', () => {
    useViewportStore.getState().setViewportPosition(-100, -50);

    expect(useViewportStore.getState().viewport.x).toBe(0);
    expect(useViewportStore.getState().viewport.y).toBe(0);
  });

  it('setIsDragging 更新 interaction.isDragging 并操作 body class', () => {
    useViewportStore.getState().setIsDragging(true);
    expect(useViewportStore.getState().interaction.isDragging).toBe(true);
    expect(document.body.classList.contains('is-dragging')).toBe(true);

    useViewportStore.getState().setIsDragging(false);
    expect(useViewportStore.getState().interaction.isDragging).toBe(false);
    expect(document.body.classList.contains('is-dragging')).toBe(false);
  });

  it('expandCanvas 只扩展不收缩', () => {
    const initialW = useViewportStore.getState().canvas.w;
    const initialH = useViewportStore.getState().canvas.h;

    useViewportStore.getState().expandCanvas(initialW + 500, initialH + 500);
    expect(useViewportStore.getState().canvas.w).toBe(initialW + 500);
    expect(useViewportStore.getState().canvas.h).toBe(initialH + 500);

    useViewportStore.getState().expandCanvas(10, 10);
    expect(useViewportStore.getState().canvas.w).toBe(initialW + 500);
    expect(useViewportStore.getState().canvas.h).toBe(initialH + 500);
  });

  it('setStickyDrag 更新粘性拖拽状态', () => {
    useViewportStore.getState().setStickyDrag('note-1', 20, 30, 'active');
    expect(useViewportStore.getState().stickyDrag).toEqual({
      id: 'note-1',
      offsetX: 20,
      offsetY: 30,
      status: 'active',
    });

    useViewportStore.getState().setStickyDrag('note-1', 20, 30, 'suspended');
    expect(useViewportStore.getState().stickyDrag.status).toBe('suspended');

    useViewportStore.getState().setStickyDrag(null);
    expect(useViewportStore.getState().stickyDrag.id).toBeNull();
    expect(useViewportStore.getState().stickyDrag.status).toBe('active');
  });

  it('replaceViewportState 替换整个 viewport 状态', () => {
    const newState = createInitialViewportState();
    newState.viewport = { x: 999, y: 888, w: 100, h: 100 };
    newState.interaction.isPanMode = true;

    useViewportStore.getState().replaceViewportState(newState);

    expect(useViewportStore.getState().viewport.x).toBe(999);
    expect(useViewportStore.getState().viewport.y).toBe(888);
    expect(useViewportStore.getState().interaction.isPanMode).toBe(true);
  });

  it('P0-06 setViewportPosition 不每调用触发 useStore.setState', () => {
    // 先撑大 canvas，避免 position 连带扩 canvas 触发 reverse setState
    useViewportStore.getState().expandCanvas(5000, 5000);
    const spy = vi.spyOn(useStore, 'setState');
    for (let i = 0; i < 5; i++) {
      useViewportStore.getState().setViewportPosition(100 + i * 10, 200);
    }
    expect(spy).toHaveBeenCalledTimes(0);
    spy.mockRestore();
  });

  it('P0-06 setEdgePush 不每调用触发 useStore.setState', () => {
    const spy = vi.spyOn(useStore, 'setState');
    for (let i = 0; i < 5; i++) {
      useViewportStore.getState().setEdgePush({ [i % 2 === 0 ? 'top' : 'right']: true });
    }
    expect(spy).toHaveBeenCalledTimes(0);
    spy.mockRestore();
  });

  it('P0-06 setViewportPosition 后 switchBoard 写入 boards[].viewport', () => {
    useStore.setState({
      boards: [
        { id: 'default', name: '主板', icon: '📌', createdAt: 0 },
        { id: 'board-2', name: '二号板', icon: '🧩', createdAt: 1, viewport: { x: 10, y: 20 } },
      ],
      currentBoardId: 'default',
      saveToDisk: vi.fn(async () => true),
    });
    useViewportStore.getState().expandCanvas(5000, 5000);
    useViewportStore.getState().setViewportPosition(500, 600);

    useStore.getState().switchBoard('board-2');

    const oldBoard = useStore.getState().boards.find((b) => b.id === 'default');
    expect(oldBoard?.viewport).toEqual({ x: 500, y: 600 });
  });
});

describe('viewportStore 同步桥', () => {
  beforeEach(() => {
    resetViewportStore();
    useStore.setState({
      viewport: { x: 0, y: 0, w: 800, h: 600 },
      shellRect: { left: 0, top: 0, right: 800, bottom: 600 },
      canvas: { w: 800, h: 600 },
      interaction: {
        isPanMode: false,
        isDragging: false,
        edgePush: { top: false, bottom: false, left: false, right: false },
      },
      stickyDrag: { id: null, offsetX: 0, offsetY: 0, status: 'active' },
    });
  });

  it('useStore 中 viewport 状态变更会同步到 useViewportStore', () => {
    useStore.setState({
      viewport: { x: 100, y: 200, w: 1280, h: 720 },
    });

    expect(useViewportStore.getState().viewport.x).toBe(100);
    expect(useViewportStore.getState().viewport.y).toBe(200);
    expect(useViewportStore.getState().viewport.w).toBe(1280);
  });

  it('useStore 中 interaction 状态变更会同步到 useViewportStore', () => {
    useStore.setState({
      interaction: {
        isPanMode: true,
        isDragging: true,
        edgePush: { top: true, bottom: false, left: false, right: false },
      },
    });

    expect(useViewportStore.getState().interaction.isPanMode).toBe(true);
    expect(useViewportStore.getState().interaction.isDragging).toBe(true);
    expect(useViewportStore.getState().interaction.edgePush.top).toBe(true);
  });

  it('useStore 中 stickyDrag 状态变更会同步到 useViewportStore', () => {
    useStore.setState({
      stickyDrag: { id: 'note-x', offsetX: 10, offsetY: 20, status: 'active' },
    });

    expect(useViewportStore.getState().stickyDrag.id).toBe('note-x');
    expect(useViewportStore.getState().stickyDrag.offsetX).toBe(10);
  });

  it('useViewportStore 直接写入会通过反向同步桥同步回 useStore（非热字段）', () => {
    useViewportStore.getState().setShellRect({ left: 10, top: 20, right: 1290, bottom: 740 });

    expect(useViewportStore.getState().shellRect).toEqual({ left: 10, top: 20, right: 1290, bottom: 740 });
    expect(useStore.getState().shellRect).toEqual({ left: 10, top: 20, right: 1290, bottom: 740 });
  });
});

describe('viewportStore 切板过渡桥接验证（Commit 09）', () => {
  const setupTwoBoardState = () => {
    const saveSpy = vi.fn(async () => true);
    useStore.setState({
      boards: [
        { id: 'default', name: '主板', icon: '📌', createdAt: 0 },
        { id: 'board-2', name: '二号板', icon: '🧩', createdAt: 1, viewport: { x: 500, y: 600 } },
      ],
      currentBoardId: 'default',
      viewport: { x: 100, y: 200, w: 1280, h: 720 },
      shellRect: { left: 0, top: 0, right: 1280, bottom: 720 },
      canvas: { w: 1280, h: 720 },
      interaction: {
        isPanMode: false,
        isDragging: false,
        edgePush: { top: false, bottom: false, left: false, right: false },
      },
      stickyDrag: { id: null, offsetX: 0, offsetY: 0, status: 'active' },
      saveToDisk: saveSpy,
    });
    useViewportStore.getState().replaceViewportState({
      viewport: { x: 100, y: 200, w: 1280, h: 720 },
      shellRect: { left: 0, top: 0, right: 1280, bottom: 720 },
      canvas: { w: 1280, h: 720 },
      interaction: {
        isPanMode: false,
        isDragging: false,
        edgePush: { top: false, bottom: false, left: false, right: false },
      },
      stickyDrag: { id: null, offsetX: 0, offsetY: 0, status: 'active' },
    });
    return saveSpy;
  };

  it('switchBoard 保存旧看板 viewport 到 Board 数据', () => {
    setupTwoBoardState();

    useStore.getState().switchBoard('board-2');

    const oldBoard = useStore.getState().boards.find((b) => b.id === 'default');
    expect(oldBoard?.viewport).toEqual({ x: 100, y: 200 });
  });

  it('switchBoard 从目标看板恢复 viewport 到 useStore.viewport', () => {
    setupTwoBoardState();

    useStore.getState().switchBoard('board-2');

    expect(useStore.getState().viewport.x).toBe(500);
    expect(useStore.getState().viewport.y).toBe(600);
  });

  it('switchBoard 目标看板无 viewport 时恢复到 0,0', () => {
    setupTwoBoardState();
    useStore.setState({
      boards: [
        { id: 'default', name: '主板', icon: '📌', createdAt: 0 },
        { id: 'board-2', name: '二号板', icon: '🧩', createdAt: 1 },
      ],
    });

    useStore.getState().switchBoard('board-2');

    expect(useStore.getState().viewport.x).toBe(0);
    expect(useStore.getState().viewport.y).toBe(0);
  });

  it('switchBoard 恢复的 viewport 通过过渡同步桥可见于 useViewportStore', () => {
    setupTwoBoardState();

    useStore.getState().switchBoard('board-2');

    expect(useViewportStore.getState().viewport.x).toBe(500);
    expect(useViewportStore.getState().viewport.y).toBe(600);
  });

  it('switchBoard 目标看板无 viewport 时 viewportStore 也恢复到 0,0', () => {
    setupTwoBoardState();
    useStore.setState({
      boards: [
        { id: 'default', name: '主板', icon: '📌', createdAt: 0 },
        { id: 'board-2', name: '二号板', icon: '🧩', createdAt: 1 },
      ],
    });

    useStore.getState().switchBoard('board-2');

    expect(useViewportStore.getState().viewport.x).toBe(0);
    expect(useViewportStore.getState().viewport.y).toBe(0);
  });

  it('switchBoard 回切看板后恢复该看板之前保存的 viewport，viewportStore 也同步', () => {
    setupTwoBoardState();

    useStore.getState().switchBoard('board-2');
    expect(useStore.getState().viewport.x).toBe(500);
    expect(useViewportStore.getState().viewport.x).toBe(500);

    useStore.getState().setViewportPosition(700, 800);
    expect(useViewportStore.getState().viewport.x).toBe(700);

    useStore.getState().switchBoard('default');

    expect(useStore.getState().viewport.x).toBe(100);
    expect(useStore.getState().viewport.y).toBe(200);

    const board2 = useStore.getState().boards.find((b) => b.id === 'board-2');
    expect(board2?.viewport).toEqual({ x: 700, y: 800 });

    expect(useViewportStore.getState().viewport.x).toBe(100);
    expect(useViewportStore.getState().viewport.y).toBe(200);
  });
});
