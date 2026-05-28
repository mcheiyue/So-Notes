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

const isSameViewportState = (
  a: ViewportStateFields,
  b: ViewportStateFields,
): boolean =>
  a.viewport === b.viewport &&
  a.shellRect === b.shellRect &&
  a.canvas === b.canvas &&
  a.interaction === b.interaction &&
  a.stickyDrag === b.stickyDrag;

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

const hasViewportStoreFieldChanged = (
  current: ViewportStateFields,
  previous: ViewportStateFields,
): boolean =>
  VIEWPORT_SYNC_FIELDS.some((field) => current[field] !== previous[field]);

const extractViewportStateForLegacy = (state: ViewportStateFields) => ({
  viewport: state.viewport,
  shellRect: state.shellRect,
  canvas: state.canvas,
  interaction: state.interaction,
  stickyDrag: state.stickyDrag,
});

const syncLegacyViewportToViewportStore = () => {
  const legacyState = useStore.getState();
  const viewportStoreState = useViewportStore.getState();
  const nextViewportState = extractViewportFromLegacy(legacyState);

  if (!isSameViewportState(viewportStoreState, nextViewportState)) {
    useViewportStore.setState(nextViewportState);
  }
};

const syncViewportStoreToLegacy = () => {
  const viewportState = useViewportStore.getState();
  const legacyState = useStore.getState();
  const nextLegacyViewport = extractViewportStateForLegacy(viewportState);

  if (!isSameViewportState(legacyState, nextLegacyViewport)) {
    useStore.setState(nextLegacyViewport);
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

  syncLegacyViewportToViewportStore();

  unsubscribeViewportSync = useStore.subscribe((state, previousState) => {
    if (hasViewportFieldChanged(state, previousState)) {
      syncLegacyViewportToViewportStore();
    }
  });

  unsubscribeViewportReverseSync = useViewportStore.subscribe((state, previousState) => {
    if (hasViewportStoreFieldChanged(state, previousState)) {
      syncViewportStoreToLegacy();
    }
  });

  return detachViewportSync;
};

attachViewportSync();
