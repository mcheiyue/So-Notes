import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import {
  ViewportState,
  ShellRectState,
  AppCanvasState,
  InteractionState,
  StickyDragStatus,
} from './types';
import { useStore } from './useStore';
import { bindRuntimePanReader } from './runtimePan';

export const VIEWPORT_STORE_MODULE = 'viewportStore';

export interface ViewportStateFields {
  viewport: ViewportState;
  shellRect: ShellRectState;
  canvas: AppCanvasState;
  interaction: InteractionState;
  stickyDrag: {
    id: string | null;
    offsetX: number;
    offsetY: number;
    status: StickyDragStatus;
  };
}

export interface ViewportActions {
  setViewportSize: (w: number, h: number) => void;
  setShellRect: (rect: ShellRectState) => void;
  setPanMode: (isPan: boolean) => void;
  setEdgePush: (pushState: Partial<{ top: boolean; bottom: boolean; left: boolean; right: boolean }>) => void;
  panViewport: (dx: number, dy: number) => void;
  setViewportPosition: (x: number, y: number) => void;
  setIsDragging: (isDragging: boolean) => void;
  expandCanvas: (w: number, h: number) => void;
  setStickyDrag: (id: string | null, offsetX?: number, offsetY?: number, status?: StickyDragStatus) => void;
  replaceViewportState: (state: ViewportStateFields) => void;
}

export type ViewportStoreState = ViewportStateFields & ViewportActions;

export const createInitialViewportState = (): ViewportStateFields => ({
  viewport: { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight },
  shellRect: { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
  canvas: { w: window.innerWidth, h: window.innerHeight },
  interaction: {
    isPanMode: false,
    isDragging: false,
    edgePush: { top: false, bottom: false, left: false, right: false },
  },
  stickyDrag: { id: null, offsetX: 0, offsetY: 0, status: 'active' },
});

const extractViewportFromLegacy = (state: ReturnType<typeof useStore.getState>): ViewportStateFields => ({
  viewport: state.viewport,
  shellRect: state.shellRect,
  canvas: state.canvas,
  interaction: state.interaction,
  stickyDrag: state.stickyDrag,
});

export const useViewportStore = create<ViewportStoreState>()(
  immer((set) => ({
    ...createInitialViewportState(),

    setViewportSize: (w, h) => {
      set((state) => {
        state.viewport.w = w;
        state.viewport.h = h;
        state.canvas.w = Math.max(state.canvas.w, state.viewport.x + w);
        state.canvas.h = Math.max(state.canvas.h, state.viewport.y + h);
      });
    },

    setShellRect: (rect) => {
      set((state) => {
        state.shellRect = rect;
      });
    },

    setPanMode: (isPan) => {
      set((state) => {
        state.interaction.isPanMode = isPan;
      });
    },

    setEdgePush: (pushState) => {
      set((state) => {
        Object.assign(state.interaction.edgePush, pushState);
      });
    },

    panViewport: (dx, dy) => {
      set((state) => {
        let newX = state.viewport.x + dx;
        let newY = state.viewport.y + dy;

        if (newX < 0) newX = 0;
        if (newY < 0) newY = 0;

        state.viewport.x = newX;
        state.viewport.y = newY;

        const neededW = newX + state.viewport.w;
        const neededH = newY + state.viewport.h;

        if (neededW > state.canvas.w) state.canvas.w = neededW;
        if (neededH > state.canvas.h) state.canvas.h = neededH;
      });
    },

    setViewportPosition: (x, y) => {
      set((state) => {
        const finalX = Math.max(0, x);
        const finalY = Math.max(0, y);

        state.viewport.x = finalX;
        state.viewport.y = finalY;

        state.canvas.w = Math.max(state.canvas.w, finalX + state.viewport.w);
        state.canvas.h = Math.max(state.canvas.h, finalY + state.viewport.h);
      });
    },

    setIsDragging: (isDragging) => {
      if (isDragging) {
        document.body.classList.add('is-dragging');
      } else {
        document.body.classList.remove('is-dragging');
      }
      set((state) => {
        state.interaction.isDragging = isDragging;
      });
    },

    expandCanvas: (w, h) => {
      set((state) => {
        state.canvas.w = Math.max(state.canvas.w, w);
        state.canvas.h = Math.max(state.canvas.h, h);
      });
    },

    setStickyDrag: (id, offsetX = 0, offsetY = 0, status: StickyDragStatus = 'active') => {
      set((state) => {
        state.stickyDrag = { id, offsetX, offsetY, status };
      });
    },

    replaceViewportState: (nextState) => {
      set((state) => {
        Object.assign(state, nextState);
      });
    },
  })),
);

export const viewportSelectors = {
  viewport: (state: ViewportStateFields): ViewportState => state.viewport,
  shellRect: (state: ViewportStateFields): ShellRectState => state.shellRect,
  canvas: (state: ViewportStateFields): AppCanvasState => state.canvas,
  interaction: (state: ViewportStateFields): InteractionState => state.interaction,
  stickyDrag: (state: ViewportStateFields): ViewportStateFields['stickyDrag'] => state.stickyDrag,
};

// 过渡期双向同步桥：旧路径写入 useStore 时，新消费者能从 useViewportStore 读到；
// 新路径写入 useViewportStore 时，仍依赖 useStore 的旧代码与测试也能保持一致。
let unsubscribeViewportSync: (() => void) | null = null;
let unsubscribeViewportReverseSync: (() => void) | null = null;

const VIEWPORT_SYNC_FIELDS: (keyof ViewportStateFields)[] = [
  'viewport',
  'shellRect',
  'canvas',
  'interaction',
  'stickyDrag',
];

const hasViewportFieldChanged = (
  current: ReturnType<typeof useStore.getState>,
  previous: ReturnType<typeof useStore.getState>,
): boolean =>
  VIEWPORT_SYNC_FIELDS.some((field) => current[field] !== previous[field]);

/** 策略 A：reverse 跳过 pan(viewport) 与仅 edgePush 的 interaction；保留 canvas/shellRect/stickyDrag/非 edge interaction */
const buildLegacyReversePatch = (
  current: ViewportStateFields,
  legacy: ReturnType<typeof useStore.getState>,
): Partial<ViewportStateFields> | null => {
  const patch: Partial<ViewportStateFields> = {};

  // pan 热字段（仅 x/y）：不 reverse；viewport 尺寸 w/h 变化仍 reverse
  if (current.viewport !== legacy.viewport) {
    const c = current.viewport;
    const p = legacy.viewport;
    if (c.w !== p.w || c.h !== p.h) {
      patch.viewport = c;
    }
  }
  if (current.shellRect !== legacy.shellRect) {
    patch.shellRect = current.shellRect;
  }
  if (current.canvas !== legacy.canvas) {
    patch.canvas = current.canvas;
  }
  if (current.stickyDrag !== legacy.stickyDrag) {
    patch.stickyDrag = current.stickyDrag;
  }
  if (current.interaction !== legacy.interaction) {
    const c = current.interaction;
    const p = legacy.interaction;
    const nonEdgeSame = c.isPanMode === p.isPanMode && c.isDragging === p.isDragging;
    // 仅 edgePush 变化 → 跳过；isPanMode/isDragging 变化 → reverse 整段 interaction
    if (!nonEdgeSame) {
      patch.interaction = c;
    }
  }

  return Object.keys(patch).length > 0 ? patch : null;
};

const syncLegacyViewportToViewportStore = (
  current: ReturnType<typeof useStore.getState>,
  previous: ReturnType<typeof useStore.getState>,
) => {
  // 只 forward 实际变更字段，避免 reverse 写 canvas 时把陈旧 pan 盖回 viewportStore
  const patch: Partial<ViewportStateFields> = {};
  for (const field of VIEWPORT_SYNC_FIELDS) {
    if (current[field] !== previous[field]) {
      (patch as Record<string, unknown>)[field] = current[field];
    }
  }
  if (Object.keys(patch).length > 0) {
    useViewportStore.setState(patch);
  }
};

const syncViewportStoreToLegacy = () => {
  const viewportState = useViewportStore.getState();
  const legacyState = useStore.getState();
  const patch = buildLegacyReversePatch(viewportState, legacyState);
  if (patch) {
    useStore.setState(patch);
  }
};

export const detachViewportSync = () => {
  unsubscribeViewportSync?.();
  unsubscribeViewportSync = null;
  unsubscribeViewportReverseSync?.();
  unsubscribeViewportReverseSync = null;
};

export const attachViewportSync = (): (() => void) => {
  if (unsubscribeViewportSync) {
    return detachViewportSync;
  }

  // 初始对齐：全量从 legacy 拉一次
  useViewportStore.setState(extractViewportFromLegacy(useStore.getState()));

  unsubscribeViewportSync = useStore.subscribe((state, previousState) => {
    if (hasViewportFieldChanged(state, previousState)) {
      syncLegacyViewportToViewportStore(state, previousState);
    }
  });

  unsubscribeViewportReverseSync = useViewportStore.subscribe((state, previousState) => {
    // 任意字段引用变化都尝试 reverse；buildLegacyReversePatch 会丢掉 pan/edgePush 热字段
    if (VIEWPORT_SYNC_FIELDS.some((field) => state[field] !== previousState[field])) {
      syncViewportStoreToLegacy();
    }
  });

  return detachViewportSync;
};

bindRuntimePanReader(() => {
  const v = useViewportStore.getState().viewport;
  return { x: v.x, y: v.y, w: v.w, h: v.h };
});

attachViewportSync();
