import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type {
  ViewMode,
  ContextMenuState,
  NoteHighlight,
  NoteHighlightReason,
} from './types';
import type { SmartPasteResult } from '../utils/smartPaste';
import { useStore } from './useStore';

export const UI_STORE_MODULE = 'uiStore';

interface SmartPasteSplitPanelState {
  noteId: string;
  result: SmartPasteResult;
}

/** 撕下便签的瞬态 UI 记录，仅存在于运行期，不持久化 */
export interface DetachedNote {
  noteId: string;
  position: { x: number; y: number };
  isPinned: boolean;
}

export interface UIStateFields {
  viewMode: ViewMode;
  selectedIds: string[];
  contextMenu: ContextMenuState;
  isDockVisible: boolean;
  isSpotlightOpen: boolean;
  isQuickCaptureOpen: boolean;
  smartPasteSplitPanel: SmartPasteSplitPanelState | null;
  recentlyCreatedIds: string[];
  noteHighlights: Record<string, NoteHighlight>;
  isPinned: boolean;
  detachedNotes: DetachedNote[];
}

export interface UIActions {
  setViewMode: (mode: ViewMode) => void;
  setSelectedIds: (ids: string[]) => void;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  setContextMenu: (menu: ContextMenuState) => void;
  setDockVisible: (visible: boolean) => void;
  setSpotlightOpen: (isOpen: boolean) => void;
  setQuickCaptureOpen: (isOpen: boolean) => void;
  openSmartPasteSplitPanel: (panel: SmartPasteSplitPanelState) => void;
  closeSmartPasteSplitPanel: () => void;
  markRecentlyCreated: (ids: string[]) => void;
  clearRecentlyCreated: (id: string) => void;
  markNoteHighlights: (ids: string[], reason: NoteHighlightReason) => void;
  clearNoteHighlight: (id: string, token?: number) => void;
  setPinned: (pinned: boolean) => void;
  addDetachedNote: (noteId: string, position: { x: number; y: number }) => void;
  removeDetachedNote: (noteId: string) => void;
  updateDetachedNotePosition: (noteId: string, position: { x: number; y: number }) => void;
  toggleDetachedNotePin: (noteId: string) => void;
  focusDetachedNote: (noteId: string) => void;
  replaceUIState: (state: UIStateFields) => void;
}

export type UIStoreState = UIStateFields & UIActions;

// ─── 定时器管理（迁移自 useStore）─────────────────────────────────────────────

let noteHighlightSequence = 0;
const noteHighlightTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const recentlyCreatedTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

const getNoteHighlightDuration = (reason: NoteHighlightReason): number =>
  reason === 'located' ? 1100 : 900;

const clearNoteHighlightTimer = (id: string) => {
  const timer = noteHighlightTimeouts.get(id);
  if (!timer) return;

  clearTimeout(timer);
  noteHighlightTimeouts.delete(id);
};

const clearRecentlyCreatedTimer = (id: string) => {
  const timer = recentlyCreatedTimeouts.get(id);
  if (!timer) return;

  clearTimeout(timer);
  recentlyCreatedTimeouts.delete(id);
};

const createNoteHighlight = (reason: NoteHighlightReason): NoteHighlight => ({
  reason,
  token: Date.now() + (++noteHighlightSequence / 1000),
});

const scheduleNoteHighlightCleanup = (id: string, highlight: NoteHighlight) => {
  clearNoteHighlightTimer(id);

  const timer = setTimeout(() => {
    noteHighlightTimeouts.delete(id);
    useUIStore.getState().clearNoteHighlight(id, highlight.token);
  }, getNoteHighlightDuration(highlight.reason));

  noteHighlightTimeouts.set(id, timer);
};

const scheduleRecentlyCreatedCleanup = (id: string) => {
  clearRecentlyCreatedTimer(id);

  const timer = setTimeout(() => {
    recentlyCreatedTimeouts.delete(id);
    useUIStore.getState().clearRecentlyCreated(id);
  }, 850);

  recentlyCreatedTimeouts.set(id, timer);
};

const assignNoteHighlights = (
  state: UIStateFields,
  ids: string[],
  reason: NoteHighlightReason,
) => {
  if (ids.length === 0) return;

  const highlight = createNoteHighlight(reason);
  ids.forEach((id) => {
    state.noteHighlights[id] = highlight;
    scheduleNoteHighlightCleanup(id, highlight);
    if (reason === 'created') {
      scheduleRecentlyCreatedCleanup(id);
    }
  });
};

// ─── 初始状态 ──────────────────────────────────────────────────────────────────

export const createInitialUIState = (): UIStateFields => ({
  viewMode: 'BOARD',
  selectedIds: [],
  contextMenu: { isOpen: false, x: 0, y: 0, type: 'CANVAS' },
  isDockVisible: false,
  isSpotlightOpen: false,
  isQuickCaptureOpen: false,
  smartPasteSplitPanel: null,
  recentlyCreatedIds: [],
  noteHighlights: {},
  isPinned: false,
  detachedNotes: [],
});

// ─── Store 创建 ────────────────────────────────────────────────────────────────

export const useUIStore = create<UIStoreState>()(
  immer((set) => ({
    ...createInitialUIState(),

    setViewMode: (mode) => {
      set((state) => {
        state.viewMode = mode;
        state.selectedIds = [];
      });
    },

    setSelectedIds: (ids) => {
      set((state) => {
        state.selectedIds = ids;
      });
    },

    toggleSelection: (id) => {
      set((state) => {
        if (state.selectedIds.includes(id)) {
          state.selectedIds = state.selectedIds.filter((i) => i !== id);
        } else {
          state.selectedIds.push(id);
        }
      });
    },

    clearSelection: () => {
      set((state) => {
        state.selectedIds = [];
      });
    },

    setContextMenu: (menu) => {
      set((state) => {
        state.contextMenu = menu;
      });
    },

    setDockVisible: (visible) => {
      set((state) => {
        state.isDockVisible = visible;
      });
    },

    setSpotlightOpen: (isOpen) => {
      set((state) => {
        state.isSpotlightOpen = isOpen;
      });
    },

    setQuickCaptureOpen: (isOpen) => {
      set((state) => {
        state.isQuickCaptureOpen = isOpen;
      });
    },

    openSmartPasteSplitPanel: (panel) => {
      set((state) => {
        state.smartPasteSplitPanel = panel;
      });
    },

    closeSmartPasteSplitPanel: () => {
      set((state) => {
        state.smartPasteSplitPanel = null;
      });
    },

    markRecentlyCreated: (ids) => {
      set((state) => {
        state.recentlyCreatedIds = ids;
        assignNoteHighlights(state, ids, 'created');
      });
    },

    clearRecentlyCreated: (id) => {
      set((state) => {
        clearRecentlyCreatedTimer(id);
        state.recentlyCreatedIds = state.recentlyCreatedIds.filter(
          (createdId) => createdId !== id,
        );
      });
    },

    markNoteHighlights: (ids, reason) => {
      set((state) => {
        assignNoteHighlights(state, ids, reason);
      });
    },

    clearNoteHighlight: (id, token) => {
      set((state) => {
        const current = state.noteHighlights[id];
        if (!current) return;
        if (token !== undefined && current.token !== token) return;

        clearNoteHighlightTimer(id);
        delete state.noteHighlights[id];
      });
    },

    setPinned: (pinned) => {
      set((state) => {
        state.isPinned = pinned;
      });
    },

    addDetachedNote: (noteId, position) => {
      set((state) => {
        if (state.detachedNotes.some((d) => d.noteId === noteId)) return;
        state.detachedNotes.push({ noteId, position, isPinned: false });
      });
    },

    removeDetachedNote: (noteId) => {
      set((state) => {
        state.detachedNotes = state.detachedNotes.filter((d) => d.noteId !== noteId);
      });
    },

    updateDetachedNotePosition: (noteId, position) => {
      set((state) => {
        const entry = state.detachedNotes.find((d) => d.noteId === noteId);
        if (entry) {
          entry.position = position;
        }
      });
    },

    toggleDetachedNotePin: (noteId) => {
      set((state) => {
        const entry = state.detachedNotes.find((d) => d.noteId === noteId);
        if (entry) {
          entry.isPinned = !entry.isPinned;
        }
      });
    },

    focusDetachedNote: (noteId) => {
      set((state) => {
        const index = state.detachedNotes.findIndex((d) => d.noteId === noteId);
        if (index < 0 || index === state.detachedNotes.length - 1) return;

        const [entry] = state.detachedNotes.splice(index, 1);
        state.detachedNotes.push(entry);
      });
    },

    replaceUIState: (nextState) => {
      set((state) => {
        Object.assign(state, nextState);
      });
    },
  })),
);

// ─── Selectors ──────────────────────────────────────────────────────────────────

export const uiSelectors = {
  viewMode: (state: UIStateFields): ViewMode => state.viewMode,
  selectedIds: (state: UIStateFields): string[] => state.selectedIds,
  contextMenu: (state: UIStateFields): ContextMenuState => state.contextMenu,
  isDockVisible: (state: UIStateFields): boolean => state.isDockVisible,
  isSpotlightOpen: (state: UIStateFields): boolean => state.isSpotlightOpen,
  isQuickCaptureOpen: (state: UIStateFields): boolean => state.isQuickCaptureOpen,
  smartPasteSplitPanel: (state: UIStateFields): SmartPasteSplitPanelState | null => state.smartPasteSplitPanel,
  recentlyCreatedIds: (state: UIStateFields): string[] => state.recentlyCreatedIds,
  noteHighlights: (state: UIStateFields): Record<string, NoteHighlight> => state.noteHighlights,
  isPinned: (state: UIStateFields): boolean => state.isPinned,
  detachedNotes: (state: UIStateFields): DetachedNote[] => state.detachedNotes,
};

// ─── 过渡期双向同步桥 ──────────────────────────────────────────────────────────

let unsubscribeUISync: (() => void) | null = null;
let unsubscribeUIReverseSync: (() => void) | null = null;

const UI_SYNC_FIELDS: (keyof UIStateFields)[] = [
  'viewMode',
  'selectedIds',
  'contextMenu',
  'isDockVisible',
  'isSpotlightOpen',
  'isQuickCaptureOpen',
  'smartPasteSplitPanel',
  'recentlyCreatedIds',
  'noteHighlights',
  'isPinned',
  'detachedNotes',
];

const hasUIFieldChanged = (
  current: ReturnType<typeof useStore.getState>,
  previous: ReturnType<typeof useStore.getState>,
): boolean =>
  UI_SYNC_FIELDS.some((field) => current[field] !== previous[field]);

const hasUIStoreFieldChanged = (
  current: UIStateFields,
  previous: UIStateFields,
): boolean =>
  UI_SYNC_FIELDS.some((field) => current[field] !== previous[field]);

const extractUIFromLegacy = (state: ReturnType<typeof useStore.getState>): UIStateFields => ({
  viewMode: state.viewMode,
  selectedIds: state.selectedIds,
  contextMenu: state.contextMenu,
  isDockVisible: state.isDockVisible,
  isSpotlightOpen: state.isSpotlightOpen,
  isQuickCaptureOpen: state.isQuickCaptureOpen,
  smartPasteSplitPanel: state.smartPasteSplitPanel,
  recentlyCreatedIds: state.recentlyCreatedIds,
  noteHighlights: state.noteHighlights,
  isPinned: state.isPinned,
  detachedNotes: state.detachedNotes,
});

const extractUIStateForLegacy = (state: UIStateFields) => ({
  viewMode: state.viewMode,
  selectedIds: state.selectedIds,
  contextMenu: state.contextMenu,
  isDockVisible: state.isDockVisible,
  isSpotlightOpen: state.isSpotlightOpen,
  isQuickCaptureOpen: state.isQuickCaptureOpen,
  smartPasteSplitPanel: state.smartPasteSplitPanel,
  recentlyCreatedIds: state.recentlyCreatedIds,
  noteHighlights: state.noteHighlights,
  isPinned: state.isPinned,
  detachedNotes: state.detachedNotes,
});

const isSameUIState = (a: UIStateFields, b: UIStateFields): boolean =>
  UI_SYNC_FIELDS.every((field) => a[field] === b[field]);

const syncLegacyUIToUIStore = () => {
  const legacyState = useStore.getState();
  const uiStoreState = useUIStore.getState();
  const nextUIState = extractUIFromLegacy(legacyState);

  if (!isSameUIState(uiStoreState, nextUIState)) {
    useUIStore.setState(nextUIState);
  }
};

const syncUIStoreToLegacy = () => {
  const uiState = useUIStore.getState();
  const legacyState = useStore.getState();
  const nextLegacyUI = extractUIStateForLegacy(uiState);

  if (!isSameUIState(legacyState as unknown as UIStateFields, nextLegacyUI)) {
    useStore.setState(nextLegacyUI);
  }
};

export const detachUISync = () => {
  unsubscribeUISync?.();
  unsubscribeUISync = null;
  unsubscribeUIReverseSync?.();
  unsubscribeUIReverseSync = null;
};

export const attachUISync = (): (() => void) => {
  if (unsubscribeUISync) {
    return detachUISync;
  }

  syncLegacyUIToUIStore();

  unsubscribeUISync = useStore.subscribe((state, previousState) => {
    if (hasUIFieldChanged(state, previousState)) {
      syncLegacyUIToUIStore();
    }
  });

  unsubscribeUIReverseSync = useUIStore.subscribe((state, previousState) => {
    if (hasUIStoreFieldChanged(state, previousState)) {
      syncUIStoreToLegacy();
    }
  });

  return detachUISync;
};

attachUISync();
