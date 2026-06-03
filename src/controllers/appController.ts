import { useStore } from '../store/useStore';
import { useUIStore } from '../store/uiStore';
import { invoke } from '@tauri-apps/api/core';
import { LAYOUT } from '../constants/layout';
import type { Note, ShellRectState, StickyDragStatus } from '../store/types';
import { parseSmartPaste, buildSmartPasteNoteInputs } from '../utils/smartPaste';
import { getViewportSpawnOrigin } from '../utils/spawnPosition';
import { getNoteElement } from '../utils/noteElementRegistry';

type ArrangeNotesStrategy = 'position' | 'updatedAt' | 'color';
type ArrangeNotesScope = 'auto' | 'board' | 'selection';

type WorldPosition = {
  x: number;
  y: number;
};

const toggleViewMode = (): void => {
  const { viewMode, setViewMode, clearSelection } = useStore.getState();
  clearSelection();
  setViewMode(viewMode === 'TRASH' ? 'BOARD' : 'TRASH');
};

const enterTrashMode = (): void => {
  const { setViewMode, clearSelection } = useStore.getState();
  clearSelection();
  setViewMode('TRASH');
};

const enterBoardMode = (): void => {
  const { setViewMode, clearSelection } = useStore.getState();
  clearSelection();
  setViewMode('BOARD');
};

const switchBoard = (boardId: string): void => {
  const state = useStore.getState();
  state.switchBoard(boardId);
  enterBoardMode();
};

const runOnBoardView = (action: () => void): void => {
  if (useStore.getState().viewMode === 'TRASH') {
    enterBoardMode();
    window.setTimeout(action, 0);
    return;
  }

  action();
};

export const appController = {

  selectAllNotes: (): void => {
    useStore.getState().selectAllNotes();
  },

  deleteSelectedNotes: (): void => {
    useStore.getState().deleteSelectedNotes();
  },

  duplicateSelectedNotes: (): void => {
    useStore.getState().duplicateSelectedNotes();
  },

  deleteNote: (noteId: string): void => {
    useStore.getState().deleteNote(noteId);
  },

  duplicateNote: (noteId: string): void => {
    useStore.getState().duplicateNote(noteId);
  },

  changeNoteColor: (noteId: string, color: string): void => {
    useStore.getState().changeColor(noteId, color);
  },

  changeSelectedNotesColor: (color: string): void => {
    useStore.getState().changeSelectedNotesColor(color);
  },

  moveNoteToBoard: (noteId: string, boardId: string): void => {
    useStore.getState().moveNoteToBoard(noteId, boardId);
  },

  copyNoteToBoard: (noteId: string, boardId: string): void => {
    useStore.getState().copyNoteToBoard(noteId, boardId);
  },

  moveSelectedNotesToBoard: (boardId: string): void => {
    useStore.getState().moveSelectedNotesToBoard(boardId);
  },

  copySelectedNotesToBoard: (boardId: string): void => {
    useStore.getState().copySelectedNotesToBoard(boardId);
  },

  toggleSelectedNotesCollapse: (noteIds: string[]): void => {
    useStore.getState().batchToggleCollapse(noteIds);
  },

  bringSelectedNotesToFront: (noteIds: string[]): void => {
    useStore.getState().batchBringToFront(noteIds);
  },

  sendSelectedNotesToBack: (noteIds: string[]): void => {
    useStore.getState().batchSendToBack(noteIds);
  },

  bringNoteToFront: (noteId: string): void => {
    const state = useStore.getState();
    state.bringToFront(noteId);
    state.finalizeLayoutChange([noteId]);
  },

  startStickyDrag: (noteId: string, offsetX = 0, offsetY = 0, status?: StickyDragStatus): void => {
    useStore.getState().setStickyDrag(noteId, offsetX, offsetY, status);
  },

  mergeSelectedNotes: (): string | null => useStore.getState().mergeSelectedNotes(),

  splitNoteByParagraph: (noteId: string): string[] => useStore.getState().splitNoteByParagraph(noteId),

  arrangeNotes: (startX?: number, startY?: number, strategy?: ArrangeNotesStrategy, scope?: ArrangeNotesScope): void => {
    useStore.getState().arrangeNotes(startX, startY, strategy, scope);
  },

  showBoardDock: (): void => {
    useStore.getState().setDockVisible(true);
  },

  exportNoteSelection: async (noteId?: string): Promise<void> => {
    const state = useStore.getState();
    if (noteId && !state.selectedIds.includes(noteId)) {
      state.setSelectedIds([noteId]);
    }
    await useStore.getState().exportSelectedNotes();
  },

  resetViewport: (): void => {
    useStore.getState().setViewportPosition(0, 0);
  },

  syncShellViewport: (rect: ShellRectState & { width: number; height: number }): void => {
    const nextWidth = Math.max(0, rect.width);
    const nextHeight = Math.max(0, rect.height);
    const { viewport, shellRect, setViewportSize, setShellRect } = useStore.getState();

    if (viewport.w !== nextWidth || viewport.h !== nextHeight) {
      setViewportSize(nextWidth, nextHeight);
    }

    if (
      shellRect.left !== rect.left ||
      shellRect.top !== rect.top ||
      shellRect.right !== rect.right ||
      shellRect.bottom !== rect.bottom
    ) {
      setShellRect({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      });
    }
  },

  setPinned: (pinned: boolean): void => {
    useStore.getState().setPinned(pinned);
  },

  openSpotlight: (): void => {
    useStore.getState().setSpotlightOpen(true);
  },

  closeSpotlight: (): void => {
    useStore.getState().setSpotlightOpen(false);
  },

  toggleSpotlight: (): void => {
    const { isSpotlightOpen, setSpotlightOpen } = useStore.getState();
    setSpotlightOpen(!isSpotlightOpen);
  },

  setViewMode: (mode: 'BOARD' | 'TRASH'): void => {
    useStore.getState().setViewMode(mode);
  },

  toggleViewMode,

  switchBoard,

  enterTrashMode,

  enterBoardMode,

  openQuickCapture: (): void => {
    runOnBoardView(() => {
      useStore.getState().setQuickCaptureOpen(true);
    });
  },

  createNoteAtWorldPosition: (position: WorldPosition): void => {
    useStore.getState().addNote(position.x, position.y);
  },

  createNoteAtViewportOrigin: (): void => {
    runOnBoardView(() => {
      const state = useStore.getState();
      const origin = getViewportSpawnOrigin(state.viewport);
      state.addNote(origin.x, origin.y);
    });
  },

  /**
   * locateAndSelectNote 编排顺序（与原 Spotlight handleSelect 一致）：
   * 关闭 Spotlight → switchBoard（跨看板）→ toggleCollapse（折叠时）
   * → rAF：验证有效性 → clearSelection → setViewportPosition → setSelectedIds
   * → bringToFront → markNoteHighlights('located')
   */
  locateAndSelectNote: (note: Note): void => {
    const state = useStore.getState();

    state.setSpotlightOpen(false);

    if (note.boardId !== state.currentBoardId) {
      switchBoard(note.boardId);
    }

    if (note.collapsed) {
      state.toggleCollapse(note.id, { recordHistory: false });
    }

    requestAnimationFrame(() => {
      const current = useStore.getState();
      const target = current.notesById[note.id];

      if (!target || target.deletedAt || target.boardId !== current.currentBoardId || target.collapsed) {
        return;
      }

      const nWidth = LAYOUT.NOTE_WIDTH;
      const nHeight = Math.max(LAYOUT.NOTE_MIN_HEIGHT, target.height || LAYOUT.NOTE_MIN_HEIGHT);
      const targetX = target.x + nWidth / 2 - current.viewport.w / 2;
      const targetY = target.y + nHeight / 2 - current.viewport.h / 2;

      current.clearSelection();
      current.setViewportPosition(targetX, targetY);
      current.setSelectedIds([target.id]);
      current.bringToFront(target.id);
      current.markNoteHighlights([target.id], 'located');
    });
  },

  smartPasteFromText: (text: string, origin?: WorldPosition): void => {
    const state = useStore.getState();
    const result = parseSmartPaste(text);
    const targetOrigin = origin ?? getViewportSpawnOrigin(state.viewport);
    const notes = buildSmartPasteNoteInputs(
      result.source ? [result.source] : [],
      targetOrigin.x,
      targetOrigin.y,
    );

    if (notes.length > 0) {
      const createdIds = state.addNotesWithContentBatch(notes) ?? [];
      if (createdIds.length > 0 && result.options.length > 1) {
        state.openSmartPasteSplitPanel({ noteId: createdIds[0], result });
      }
    }
  },

  smartPasteFromTextAtViewportOrigin: (text: string): void => {
    runOnBoardView(() => {
      appController.smartPasteFromText(text);
    });
  },

  detachNote: (noteId: string): void => {
    const uiState = useUIStore.getState();
    const alreadyDetached = uiState.detachedNotes.some((d) => d.noteId === noteId);

    if (!alreadyDetached) {
      const domainState = useStore.getState();
      const note = domainState.notesById[noteId];
      if (!note) return;

      const { viewport } = domainState;
      const x = Math.max(40, Math.min(note.x - viewport.x, viewport.w - 200));
      const y = Math.max(40, Math.min(note.y - viewport.y, viewport.h - 150));
      uiState.addDetachedNote(noteId, { x, y });
    }

    invoke('open_detached_note_window', { noteId }).catch(() => undefined);
  },

  closeDetachedNote: (noteId: string): void => {
    useUIStore.getState().removeDetachedNote(noteId);
  },

  moveDetachedNote: (noteId: string, position: { x: number; y: number }): void => {
    useUIStore.getState().updateDetachedNotePosition(noteId, position);
  },

  toggleDetachedNotePin: (noteId: string): void => {
    useUIStore.getState().toggleDetachedNotePin(noteId);
  },

  focusDetachedNote: (noteId: string): void => {
    useUIStore.getState().focusDetachedNote(noteId);
  },

  /**
   * locateDetachedNote 编排顺序（与 locateAndSelectNote 对齐）：
   * 检查撕下记录存在 → switchBoard（跨看板）→ toggleCollapse（折叠时）
   * → rAF 轮询 DOM 就绪 → 验证有效性 → clearSelection → setViewportPosition
   * → setSelectedIds → bringToFront → markNoteHighlights('located')
   */
  locateDetachedNote: (noteId: string): void => {
    const domainState = useStore.getState();
    const note = domainState.notesById[noteId];
    if (!note || note.deletedAt) return;

    if (!useUIStore.getState().detachedNotes.some((d) => d.noteId === noteId)) return;

    if (domainState.viewMode === 'TRASH') {
      enterBoardMode();
    }

    if (note.boardId !== useStore.getState().currentBoardId) {
      switchBoard(note.boardId);
    }

    if (note.collapsed) {
      useStore.getState().toggleCollapse(noteId, { recordHistory: false });
    }

    const MAX_DOM_READINESS_FRAMES = 5;

    const tryLocate = (frame: number): void => {
      if (frame >= MAX_DOM_READINESS_FRAMES) return;

      const element = getNoteElement(noteId);
      if (!element) {
        requestAnimationFrame(() => tryLocate(frame + 1));
        return;
      }

      const current = useStore.getState();
      const target = current.notesById[noteId];
      if (!target || target.deletedAt || target.boardId !== current.currentBoardId) return;
      if (!useUIStore.getState().detachedNotes.some((d) => d.noteId === noteId)) return;

      const nWidth = LAYOUT.NOTE_WIDTH;
      const nHeight = Math.max(LAYOUT.NOTE_MIN_HEIGHT, target.height || LAYOUT.NOTE_MIN_HEIGHT);
      const targetX = target.x + nWidth / 2 - current.viewport.w / 2;
      const targetY = target.y + nHeight / 2 - current.viewport.h / 2;

      current.clearSelection();
      current.setViewportPosition(targetX, targetY);
      current.setSelectedIds([noteId]);
      current.bringToFront(noteId);
      current.markNoteHighlights([noteId], 'located');
    };

    requestAnimationFrame(() => tryLocate(0));
  },
} as const;

export type AppController = typeof appController;
