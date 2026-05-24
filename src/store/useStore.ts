import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { invoke } from '@tauri-apps/api/core';
import { LayoutNote, Note, AppConfig, StorageData, DEFAULT_CONFIG, NOTE_COLORS, ContextMenuState, Board, DEFAULT_BOARD, ViewMode, ViewportState, AppCanvasState, InteractionState, ThemeMode, ShellRectState, SaveResult, StickyDragStatus, NoteHighlight, NoteHighlightReason } from './types';

import { db } from './db';
import { createEmptyNormalizedNotesState, createLayoutNotesById, denormalizeNotes, extractLayoutNote, normalizeNotes } from './normalization';

import { generateBoardExport, generateFullBackup, processImport, ImportFailureCode, ImportSummary } from '../utils/dataTransfer';
import { saveFile, openFile } from '../utils/fileSystem';
import { diagnostics } from '../utils/diagnostics';
import { getNoteVisualHeight, getNoteVisualWidth } from '../utils/noteVisualMetrics';
import { finalizeActiveNoteDrag } from '../utils/activeNoteDrag';
import { buildSmartPasteNoteInputs } from '../utils/smartPaste';
import type { SmartPasteNoteInput, SmartPasteOptionId, SmartPasteResult } from '../utils/smartPaste';

interface ImportFromFileResult {
  status: 'cancelled' | 'success' | 'error';
  code?: ImportFailureCode | 'SAVE_FAILED';
  message?: string;
  summary?: ImportSummary;
  rolledBack?: boolean;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface SmartPasteSplitPanelState {
  noteId: string;
  result: SmartPasteResult;
}

type ArrangeNotesStrategy = 'position' | 'updatedAt' | 'color';
type ArrangeNotesScope = 'auto' | 'board' | 'selection';

interface ArrangeUndoPosition {
  id: string;
  x: number;
  y: number;
}

interface ArrangeUndoToastState {
  token: number;
  noteCount: number;
  positions: ArrangeUndoPosition[];
}

interface State {
  notesById: Record<string, Note>;
  allNoteIds: string[];
  boardNoteIds: Record<string, string[]>;
  layoutNotesById: Record<string, LayoutNote>;


  boards: Board[];
  currentBoardId: string;
  viewMode: ViewMode;
  config: AppConfig;
  isLoaded: boolean;
  isSaving: boolean;
  saveStatus: SaveStatus;
  saveError: string | null;
  lastSavedAt: number | null;
  saveGenerationId: number;
  isPinned: boolean;
  
  // Sticky Drag State
  stickyDrag: {
    id: string | null;
    offsetX: number;
    offsetY: number;
    status: StickyDragStatus;
  };

  // Selection & UI State
  selectedIds: string[];
  contextMenu: ContextMenuState;
  
  // Viewport & Canvas State (v1.1.5)
  viewport: ViewportState;
  shellRect: ShellRectState;
  canvas: AppCanvasState;
  interaction: InteractionState;
  
  // Dock UI State (Transient)
  isDockVisible: boolean;
  isSpotlightOpen: boolean;
  isQuickCaptureOpen: boolean;
  smartPasteSplitPanel: SmartPasteSplitPanelState | null;
  recentlyCreatedIds: string[];
  noteHighlights: Record<string, NoteHighlight>;
  arrangeUndoToast: ArrangeUndoToastState | null;

  // Actions
  init: () => Promise<void>;
  
  // Viewport Actions
  setSpotlightOpen: (isOpen: boolean) => void;
  setQuickCaptureOpen: (isOpen: boolean) => void;
  openSmartPasteSplitPanel: (panel: SmartPasteSplitPanelState) => void;
  closeSmartPasteSplitPanel: () => void;
  applySmartPasteSplit: (optionId: SmartPasteOptionId) => string[];
  markRecentlyCreated: (ids: string[]) => void;
  clearRecentlyCreated: (id: string) => void;
  markNoteHighlights: (ids: string[], reason: NoteHighlightReason) => void;
  clearNoteHighlight: (id: string, token?: number) => void;
  setPinned: (pinned: boolean) => void;
  setViewportSize: (w: number, h: number) => void;
  setShellRect: (rect: ShellRectState) => void;
  setPanMode: (isPan: boolean) => void;
  setEdgePush: (pushState: Partial<{ top: boolean; bottom: boolean; left: boolean; right: boolean }>) => void;
  panViewport: (dx: number, dy: number) => void; // Delta pan
  setViewportPosition: (x: number, y: number) => void; // Absolute pan
  bringCurrentBoardNotesIntoView: () => boolean;
  setIsDragging: (isDragging: boolean) => void; // Global drag state
  expandCanvas: (w: number, h: number) => void; // Expand world boundaries

  // Board Actions
  switchBoard: (boardId: string) => void;
  setViewMode: (mode: ViewMode) => void;
  createBoard: (name: string, icon: string) => void;
  deleteBoard: (boardId: string) => void;
  updateBoard: (boardId: string, updates: Partial<Board>) => void;
  setDockVisible: (visible: boolean) => void;

  addNote: (x: number, y: number) => void;
  addNoteWithContent: (x: number, y: number, content: string) => void;
  addNotesWithContentBatch: (notes: SmartPasteNoteInput[]) => string[];
  updateTitle: (id: string, title: string) => void;
  updateNote: (id: string, content: string) => void;
  moveNote: (id: string, x: number, y: number) => void;
  moveSelectedNotes: (dx: number, dy: number, excludeId?: string) => void;
  finalizeLayoutChange: (noteIds: string[]) => void;
  arrangeNotes: (startX?: number, startY?: number, strategy?: ArrangeNotesStrategy, scope?: ArrangeNotesScope) => void;
  undoLastArrange: () => boolean;
  dismissArrangeUndoToast: () => void;
  bringToFront: (id: string) => void;
  deleteNote: (id: string) => void; // Soft delete
  restoreNote: (id: string) => void; // Restore from Trash
  deleteNotePermanently: (id: string) => void; // Hard delete
  emptyTrash: () => void;
  restoreAllTrash: () => void;
  restoreSelectedTrash: (ids: string[]) => void;
  deleteSelectedPermanently: (ids: string[]) => void;
  deleteSelectedNotes: () => void;
  changeColor: (id: string, color: string) => void;
  changeSelectedNotesColor: (color: string) => void;
  toggleCollapse: (id: string) => void;
  setStickyDrag: (id: string | null, offsetX?: number, offsetY?: number, status?: StickyDragStatus) => void;
  
  // New Actions for v1.1.1 & v1.1.2
  duplicateNote: (id: string) => void;
  duplicateSelectedNotes: () => void;
  moveNoteToBoard: (id: string, targetBoardId: string) => void;
  copyNoteToBoard: (id: string, targetBoardId: string) => void;
  moveSelectedNotesToBoard: (targetBoardId: string) => void;
  copySelectedNotesToBoard: (targetBoardId: string) => void;
  batchToggleCollapse: (ids: string[]) => void;
  batchBringToFront: (ids: string[]) => void;
  batchSendToBack: (ids: string[]) => void;
  reorderBoard: (boardId: string, direction: 'left' | 'right') => void;

  // Selection Actions
  setSelectedIds: (ids: string[]) => void;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  selectAllNotes: () => void;
  setContextMenu: (menu: ContextMenuState) => void;

  saveToDisk: () => Promise<boolean>;
  
  // Data Transfer Actions
  exportBoard: (boardId: string) => Promise<void>;
  exportCurrentBoard: () => Promise<void>;
  exportAll: () => Promise<void>;
  exportSelectedNotes: () => Promise<void>;
  importFromFile: () => Promise<ImportFromFileResult>;
  
  // Theme Action
  setThemeMode: (mode: ThemeMode) => void;
}

// Helper to debounce disk saves
let saveTimeout: ReturnType<typeof setTimeout> | null = null;

const DEBOUNCE_DELAY = 2000; // 2 seconds lazy save
const WAL_THROTTLE = 100;    // 100ms throttle for IndexedDB

let lastWALSave = 0;
let noteHighlightSequence = 0;
let arrangeUndoSequence = 0;
const noteHighlightTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const recentlyCreatedTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

const getNoteHighlightDuration = (reason: NoteHighlightReason): number => (reason === 'located' ? 1100 : 900);

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

const scheduleNoteHighlightCleanup = (id: string, highlight: NoteHighlight) => {
  clearNoteHighlightTimer(id);

  const timer = setTimeout(() => {
    noteHighlightTimeouts.delete(id);
    useStore.getState().clearNoteHighlight(id, highlight.token);
  }, getNoteHighlightDuration(highlight.reason));

  noteHighlightTimeouts.set(id, timer);
};

const scheduleRecentlyCreatedCleanup = (id: string) => {
  clearRecentlyCreatedTimer(id);

  const timer = setTimeout(() => {
    recentlyCreatedTimeouts.delete(id);
    useStore.getState().clearRecentlyCreated(id);
  }, 850);

  recentlyCreatedTimeouts.set(id, timer);
};

const clearTransientNoteState = (
  state: Pick<State, 'noteHighlights' | 'recentlyCreatedIds'>,
  noteId: string,
) => {
  clearNoteHighlightTimer(noteId);
  clearRecentlyCreatedTimer(noteId);
  delete state.noteHighlights[noteId];
  state.recentlyCreatedIds = state.recentlyCreatedIds.filter((id) => id !== noteId);
};

const createNoteHighlight = (reason: NoteHighlightReason): NoteHighlight => ({
  reason,
  token: Date.now() + (++noteHighlightSequence / 1000),
});

const assignNoteHighlights = (
  state: Pick<State, 'noteHighlights'>,
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

const calculateCurrentBoardNotesViewport = (
  state: Pick<State, 'notesById' | 'boardNoteIds' | 'layoutNotesById' | 'currentBoardId' | 'viewport'>,
): { x: number; y: number; right: number; bottom: number } | null => {
  const liveNotes = getBoardNoteIds(state, state.currentBoardId).flatMap((id) => {
    const note = state.notesById[id];
    return note && !note.deletedAt ? [note] : [];
  });

  if (liveNotes.length === 0) {
    return null;
  }

  const bounds = liveNotes.reduce(
    (acc, note) => {
      const layout = state.layoutNotesById[note.id] ?? extractLayoutNote(note);
      const noteWidth = getNoteVisualWidth(note, layout);
      const noteHeight = getNoteVisualHeight(note, layout);

      return {
        left: Math.min(acc.left, note.x),
        top: Math.min(acc.top, note.y),
        right: Math.max(acc.right, note.x + noteWidth),
        bottom: Math.max(acc.bottom, note.y + noteHeight),
      };
    },
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
  );

  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;

  return {
    x: Math.max(0, Math.round(centerX - state.viewport.w / 2)),
    y: Math.max(0, Math.round(centerY - state.viewport.h / 2)),
    right: bounds.right,
    bottom: bounds.bottom,
  };
};

const colorOrder = new Map(NOTE_COLORS.map((color, index) => [color.toLowerCase(), index]));

const compareNotesByPosition = (a: Note, b: Note): number => {
  const dy = a.y - b.y;
  if (Math.abs(dy) > 50) return dy;
  return a.x - b.x;
};

const getColorOrder = (color: string): number => colorOrder.get(color.toLowerCase()) ?? NOTE_COLORS.length;

const sortNotesForArrange = (notes: Note[], strategy: ArrangeNotesStrategy): Note[] => {
  return [...notes].sort((a, b) => {
    if (strategy === 'updatedAt') {
      const updatedDelta = b.updatedAt - a.updatedAt;
      if (updatedDelta !== 0) return updatedDelta;
      return compareNotesByPosition(a, b);
    }

    if (strategy === 'color') {
      const colorDelta = getColorOrder(a.color) - getColorOrder(b.color);
      if (colorDelta !== 0) return colorDelta;
      return compareNotesByPosition(a, b);
    }

    return compareNotesByPosition(a, b);
  });
};

const createArrangeUndoToast = (positions: ArrangeUndoPosition[]): ArrangeUndoToastState => ({
  token: Date.now() + (++arrangeUndoSequence / 1000),
  noteCount: positions.length,
  positions,
});

const resolveSaveErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return '写入本地存储时发生未知错误。';
};

const serializeState = (state: Pick<State, 'notesById' | 'allNoteIds' | 'boardNoteIds' | 'boards' | 'currentBoardId' | 'config'>): StorageData => ({
  notes: denormalizeNotes(state),
  boards: state.boards,
  currentBoardId: state.currentBoardId,
  config: state.config,
});

const getBoardNoteIds = (state: Pick<State, 'boardNoteIds'>, boardId: string): string[] => state.boardNoteIds[boardId] ?? [];

const getNoteById = (state: Pick<State, 'notesById'>, id: string): Note | undefined => state.notesById[id];

const getBoardNotes = (state: Pick<State, 'notesById' | 'boardNoteIds'>, boardId: string): Note[] => {
  return getBoardNoteIds(state, boardId).flatMap((id) => {
    const note = state.notesById[id];
    return note ? [note] : [];
  });
};

const ensureBoardNoteBucket = (state: Pick<State, 'boardNoteIds'>, boardId: string): string[] => {
  if (!state.boardNoteIds[boardId]) {
    state.boardNoteIds[boardId] = [];
  }

  return state.boardNoteIds[boardId];
};

const appendNoteToNormalizedState = (state: Pick<State, 'notesById' | 'allNoteIds' | 'boardNoteIds' | 'layoutNotesById'>, note: Note) => {
  state.notesById[note.id] = note;
  state.allNoteIds.push(note.id);
  ensureBoardNoteBucket(state, note.boardId).push(note.id);
  state.layoutNotesById[note.id] = {
    id: note.id,
    x: note.x,
    y: note.y,
    boardId: note.boardId,
    deletedAt: note.deletedAt ?? null,
    color: note.color,
    width: note.width,
    height: note.height,
  };
};


const removeNoteIdFromBoard = (state: Pick<State, 'boardNoteIds'>, boardId: string, noteId: string) => {
  const boardIds = state.boardNoteIds[boardId];
  if (!boardIds) {
    return;
  }

  state.boardNoteIds[boardId] = boardIds.filter((id) => id !== noteId);

  if (state.boardNoteIds[boardId].length === 0) {
    delete state.boardNoteIds[boardId];
  }
};

const moveNoteBetweenBoards = (state: Pick<State, 'notesById' | 'boardNoteIds' | 'layoutNotesById'>, noteId: string, targetBoardId: string) => {
  const note = state.notesById[noteId];
  if (!note || note.boardId === targetBoardId) {
    return;
  }

  removeNoteIdFromBoard(state, note.boardId, noteId);
  note.boardId = targetBoardId;
  ensureBoardNoteBucket(state, targetBoardId).push(noteId);

  if (state.layoutNotesById[noteId]) {
    state.layoutNotesById[noteId].boardId = targetBoardId;
  }
};


const removeNoteFromNormalizedState = (state: Pick<State, 'notesById' | 'allNoteIds' | 'boardNoteIds' | 'layoutNotesById' | 'noteHighlights' | 'recentlyCreatedIds'>, noteId: string) => {
  const note = state.notesById[noteId];
  if (!note) {
    return;
  }

  clearTransientNoteState(state, noteId);
  removeNoteIdFromBoard(state, note.boardId, noteId);
  delete state.notesById[noteId];
  state.allNoteIds = state.allNoteIds.filter((id) => id !== noteId);
  delete state.layoutNotesById[noteId];
};


export const useStore = create<State>()(
  immer((set, get) => ({
    ...createEmptyNormalizedNotesState(),
    layoutNotesById: {},
    config: DEFAULT_CONFIG,

    isLoaded: false,
    isSaving: false,
    saveStatus: 'idle',
    saveError: null,
    lastSavedAt: null,
    saveGenerationId: 0,
    isPinned: false,
    
    stickyDrag: {
        id: null,
        offsetX: 0,
        offsetY: 0,
        status: 'active',
    },

    selectedIds: [],
    contextMenu: { isOpen: false, x: 0, y: 0, type: 'CANVAS' },
    
    // v1.1.5 Init
    viewport: { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight },
    shellRect: { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
    canvas: { w: window.innerWidth, h: window.innerHeight },
    interaction: { 
        isPanMode: false,
        isDragging: false,
        edgePush: { top: false, bottom: false, left: false, right: false }
    },
    
    // New State Init
    boards: [DEFAULT_BOARD],
    currentBoardId: DEFAULT_BOARD.id,
    viewMode: 'BOARD',
    isDockVisible: false,
    isSpotlightOpen: false,
    isQuickCaptureOpen: false,
    smartPasteSplitPanel: null,
    recentlyCreatedIds: [],
    noteHighlights: {},
    arrangeUndoToast: null,

    init: async () => {
      let finalData: StorageData = { 
        notes: [], 
        boards: [DEFAULT_BOARD], 
        currentBoardId: DEFAULT_BOARD.id, 
        config: DEFAULT_CONFIG 
      };
      let source: 'WAL' | 'DISK' | 'NEW' = 'NEW';

      // 1. Load both sources in parallel
      const [walData, diskJson] = await Promise.all([
        db.loadWAL(),
        invoke<string>('load_content', { filename: 'data.json' }).catch(() => null)
      ]);

      let diskData: StorageData | null = null;
      if (diskJson) {
        try {
          const parsed = JSON.parse(diskJson);
          if (parsed && Array.isArray(parsed.notes)) {
            diskData = parsed;
          }
        } catch (e) {
          console.warn('Failed to parse disk data:', e);
        }
      }

      // 2. Conflict Resolution: Timestamp Arbitration
      const getLatestUpdate = (data: StorageData | null | undefined) => {
        if (!data || data.notes.length === 0) return 0;
        return Math.max(...data.notes.map(n => n.updatedAt || 0));
      };

      const walTime = getLatestUpdate(walData);
      const diskTime = getLatestUpdate(diskData);

      // console.log(`Init Arbitration -> WAL: ${walTime}, DISK: ${diskTime}`);

      // Decision Logic
      if (diskData && diskTime > walTime) {
        // Disk is newer (or WAL is empty/stale) -> Use Disk
        // console.log('Using DISK (Newer content found)');
        finalData = diskData;
        source = 'DISK';
      } else if (walData && walData.notes.length > 0) {
        // WAL is newer or equal -> Use WAL
        // console.log('Using WAL (Cache is active)');
        finalData = walData;
        source = 'WAL';
      } else if (diskData) {
        // Fallback to Disk if WAL is empty
        // console.log('Using DISK (WAL empty)');
        finalData = diskData;
        source = 'DISK';
      }

      // 3. Hydrate State
      if (finalData.notes.length > 0) {
        const currentMaxZ = Math.max(...finalData.notes.map(n => n.z || 0), 0);
        finalData.config.maxZ = Math.max(currentMaxZ, finalData.notes.length);
        
        // Data Migration / Sanity Check
        finalData.notes.forEach((n, i) => {
           if (n.x < 0 || n.y < 0) { n.x = 20 + (i * 10); n.y = 20 + (i * 10); }
           if (n.collapsed === undefined) n.collapsed = false;
           if (n.title === undefined) n.title = "";
           if (!n.boardId) n.boardId = 'default'; // Migration: Assign default board
           if (!n.updatedAt) n.updatedAt = n.createdAt || Date.now();
        });
      }
      
      // Ensure boards exist (Migration from v1.0.9)
      if (!finalData.boards || finalData.boards.length === 0) {
          finalData.boards = [DEFAULT_BOARD];
          finalData.currentBoardId = DEFAULT_BOARD.id;
      }
      // Ensure currentBoardId is valid
      if (!finalData.currentBoardId || !finalData.boards.find(b => b.id === finalData.currentBoardId)) {
          finalData.currentBoardId = finalData.boards[0].id;
      }

      set((state) => {
        const normalizedNotes = normalizeNotes(finalData.notes);
        state.notesById = normalizedNotes.notesById;
        state.allNoteIds = normalizedNotes.allNoteIds;
        state.boardNoteIds = normalizedNotes.boardNoteIds;
        state.layoutNotesById = createLayoutNotesById(normalizedNotes.notesById);

        state.config = finalData.config;
        state.boards = finalData.boards;
        state.currentBoardId = finalData.currentBoardId;
        
        // Restore viewport for the initial board
        const activeBoard = state.boards.find(b => b.id === state.currentBoardId);
        if (activeBoard && activeBoard.viewport) {
            state.viewport.x = activeBoard.viewport.x;
            state.viewport.y = activeBoard.viewport.y;
        }

        state.isLoaded = true;

        // Apply loaded theme
        const theme = finalData.config.themeMode || 'system';
        const isSystemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const shouldBeDark = theme === 'dark' || (theme === 'system' && isSystemDark);
        
        if (shouldBeDark) {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
        localStorage.setItem('theme', theme);
      });
      
      // 4. Sync Sources
      // If we chose DISK, we must update the stale WAL immediately
      if (source === 'DISK') {
          await db.saveWAL(finalData);
      }
      // If we chose WAL (and it was indeed newer), we eventually save to disk,
      // but only if it strictly has changes. 
      // Safe default: If loading from WAL, trigger a lazy save to ensure consistency.
      if (source === 'WAL') {
          get().saveToDisk(); 
      }
    },

    switchBoard: (boardId) => {
        finalizeActiveNoteDrag('switch-board');
        set((state) => {
            // 1. Save current viewport to OLD board
            const oldBoard = state.boards.find(b => b.id === state.currentBoardId);
            if (oldBoard) {
                oldBoard.viewport = { x: state.viewport.x, y: state.viewport.y };
            }

            // 2. Switch
            if (state.boards.find(b => b.id === boardId)) {
                state.currentBoardId = boardId;
                state.viewMode = 'BOARD'; // Auto-switch to board view
                state.selectedIds = []; // Clear selection to prevent ghost edits
                state.stickyDrag = { id: null, offsetX: 0, offsetY: 0, status: 'active' }; // Reset drag
                
                // 3. Restore viewport from NEW board
                const newBoard = state.boards.find(b => b.id === boardId);
                if (newBoard && newBoard.viewport) {
                    state.viewport.x = newBoard.viewport.x;
                    state.viewport.y = newBoard.viewport.y;
                } else {
                    state.viewport.x = 0;
                    state.viewport.y = 0;
                }
            }
        });
        get().saveToDisk();
    },

    setViewMode: (mode) => {
        set((state) => {
            state.viewMode = mode;
            state.selectedIds = []; // Clear selection on view switch
        });
    },

    createBoard: (name, icon) => {
        const newBoard: Board = {
            id: crypto.randomUUID(),
            name,
            icon,
            createdAt: Date.now()
        };
        set((state) => {
            state.boards.push(newBoard);
            state.currentBoardId = newBoard.id; // Auto-switch
            state.selectedIds = [];
        });
        get().saveToDisk();
    },

    deleteBoard: (boardId) => {
        const { boards } = get();
        if (boards.length <= 1) return; // Prevent deleting last board
        
        // Find fallback board
        const fallbackId = boards.find(b => b.id !== boardId)?.id || 'default';

        set((state) => {
            const noteIdsToDelete = [...getBoardNoteIds(state, boardId)];
            noteIdsToDelete.forEach((noteId) => removeNoteFromNormalizedState(state, noteId));
            delete state.boardNoteIds[boardId];
            
            state.boards = state.boards.filter(b => b.id !== boardId);
            if (state.currentBoardId === boardId) {
                state.currentBoardId = fallbackId;
                state.selectedIds = [];
            } else {
                state.selectedIds = state.selectedIds.filter((id) => state.notesById[id]);
            }
        });
        get().saveToDisk();
    },
    
    updateBoard: (boardId, updates) => {
        set((state) => {
            const board = state.boards.find(b => b.id === boardId);
            if (board) {
                Object.assign(board, updates);
            }
        });
        get().saveToDisk();
    },

    // v1.1.5 Viewport Actions
    setViewportSize: (w, h) => {
        set((state) => {
            state.viewport.w = w;
            state.viewport.h = h;
            // Ensure canvas is at least viewport size
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

    setIsDragging: (isDragging) => {
        // Direct DOM manipulation for performance (avoids React re-renders)
        if (isDragging) {
            document.body.classList.add('is-dragging');
        } else {
            document.body.classList.remove('is-dragging');
        }
        set((state) => {
            state.interaction.isDragging = isDragging;
        });
    },

    setEdgePush: (pushState) => {
        set((state) => {
            Object.assign(state.interaction.edgePush, pushState);
        });
    },

    panViewport: (dx, dy) => {
        set((state) => {
            // Apply delta
            let newX = state.viewport.x + dx;
            let newY = state.viewport.y + dy;

            // Enforce Top-Left Hard Wall (x >= 0, y >= 0)
            if (newX < 0) newX = 0;
            if (newY < 0) newY = 0;

            state.viewport.x = newX;
            state.viewport.y = newY;

            // Auto-expand canvas if viewport moves into new territory
            const neededW = newX + state.viewport.w;
            const neededH = newY + state.viewport.h;
            
            if (neededW > state.canvas.w) state.canvas.w = neededW;
            if (neededH > state.canvas.h) state.canvas.h = neededH;
        });
    },

    setViewportPosition: (x, y) => {
        set((state) => {
            // Enforce Top-Left Hard Wall
            const finalX = Math.max(0, x);
            const finalY = Math.max(0, y);

            state.viewport.x = finalX;
            state.viewport.y = finalY;

            // Expand canvas
            state.canvas.w = Math.max(state.canvas.w, finalX + state.viewport.w);
            state.canvas.h = Math.max(state.canvas.h, finalY + state.viewport.h);
        });
    },

    bringCurrentBoardNotesIntoView: () => {
        const targetViewport = calculateCurrentBoardNotesViewport(get());

        if (!targetViewport) {
            return false;
        }

        set((state) => {
            state.viewport.x = targetViewport.x;
            state.viewport.y = targetViewport.y;
            state.canvas.w = Math.max(state.canvas.w, targetViewport.x + state.viewport.w, targetViewport.right);
            state.canvas.h = Math.max(state.canvas.h, targetViewport.y + state.viewport.h, targetViewport.bottom);
        });

        return true;
    },

    expandCanvas: (w, h) => {
        set((state) => {
            state.canvas.w = Math.max(state.canvas.w, w);
            state.canvas.h = Math.max(state.canvas.h, h);
        });
    },

    setDockVisible: (visible) => set({ isDockVisible: visible }),

    setSpotlightOpen: (isOpen) => set({ isSpotlightOpen: isOpen }),

    setQuickCaptureOpen: (isOpen) => set({ isQuickCaptureOpen: isOpen }),

    openSmartPasteSplitPanel: (panel) => set({ smartPasteSplitPanel: panel }),

    closeSmartPasteSplitPanel: () => set({ smartPasteSplitPanel: null }),

    markRecentlyCreated: (ids) => set((state) => {
      state.recentlyCreatedIds = ids;
      assignNoteHighlights(state, ids, 'created');
    }),

    clearRecentlyCreated: (id) => set((state) => {
      clearRecentlyCreatedTimer(id);
      state.recentlyCreatedIds = state.recentlyCreatedIds.filter((createdId) => createdId !== id);
    }),

    markNoteHighlights: (ids, reason) => set((state) => {
      assignNoteHighlights(state, ids, reason);
    }),

    clearNoteHighlight: (id, token) => set((state) => {
      const current = state.noteHighlights[id];
      if (!current) return;
      if (token !== undefined && current.token !== token) return;

      clearNoteHighlightTimer(id);
      delete state.noteHighlights[id];
    }),

    applySmartPasteSplit: (optionId) => {
      const panel = get().smartPasteSplitPanel;
      if (!panel) {
        return [];
      }

      const option = panel.result.options.find((candidate) => candidate.id === optionId);
      if (!option || option.id === 'keep') {
        set({ smartPasteSplitPanel: null });
        return [panel.noteId];
      }

      const targetNote = get().notesById[panel.noteId];
      if (!targetNote) {
        set({ smartPasteSplitPanel: null });
        return [];
      }

      const contents = option.contents
        .map((content) => content.trim())
        .filter((content) => content.length > 0);

      if (contents.length === 0) {
        set({ smartPasteSplitPanel: null });
        return [];
      }

      const splitInputs = buildSmartPasteNoteInputs(contents, targetNote.x, targetNote.y).slice(1);
      const createdAt = Date.now();
      const startZ = get().config.maxZ;
      const createdIds = splitInputs.map(() => crypto.randomUUID());
      const selectedIds = [panel.noteId, ...createdIds];

      set((state) => {
        const existingNote = state.notesById[panel.noteId];
        if (!existingNote) {
          state.smartPasteSplitPanel = null;
          return;
        }

        existingNote.content = contents[0];
        existingNote.updatedAt = createdAt;

        splitInputs.forEach((input, index) => {
          const newNote: Note = {
            id: createdIds[index],
            boardId: existingNote.boardId,
            title: '',
            content: input.content,
            x: input.x,
            y: input.y,
            z: startZ + index + 1,
            color: NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)],
            collapsed: false,
            createdAt,
            updatedAt: createdAt,
          };

          appendNoteToNormalizedState(state, newNote);
        });

        state.config.maxZ += splitInputs.length;
        state.selectedIds = selectedIds;
        state.recentlyCreatedIds = selectedIds;
        assignNoteHighlights(state, selectedIds, 'created');
        state.smartPasteSplitPanel = null;
      });

      get().saveToDisk();
      return selectedIds;
    },

    setPinned: (pinned) => set({ isPinned: pinned }),

    addNote: (x, y) => {
      const newNote: Note = {
        id: crypto.randomUUID(),
        boardId: get().currentBoardId, // Assign to current board
        title: '',
        content: '',
        x,
        y,
        z: get().config.maxZ + 1,
        color: NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)],
        collapsed: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      set((state) => {
        appendNoteToNormalizedState(state, newNote);
        state.config.maxZ += 1;
        state.selectedIds = [newNote.id];
        state.recentlyCreatedIds = [newNote.id];
        assignNoteHighlights(state, [newNote.id], 'created');
      });

      get().saveToDisk();
    },

    addNoteWithContent: (x, y, content) => {
      const newNote: Note = {
        id: crypto.randomUUID(),
        boardId: get().currentBoardId, // Assign to current board
        title: '', // Optional: extract first line as title? For now empty.
        content: content,
        x,
        y,
        z: get().config.maxZ + 1,
        color: NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)],
        collapsed: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      set((state) => {
        appendNoteToNormalizedState(state, newNote);
        state.config.maxZ += 1;
        state.selectedIds = [newNote.id];
        state.recentlyCreatedIds = [newNote.id];
        assignNoteHighlights(state, [newNote.id], 'created');
      });

      get().saveToDisk();
    },

    addNotesWithContentBatch: (notes) => {
      const normalizedNotes = notes
        .map((note) => ({ ...note, content: note.content.trim() }))
        .filter((note) => note.content.length > 0);

      if (normalizedNotes.length === 0) {
        return [];
      }

      const boardId = get().currentBoardId;
      const createdAt = Date.now();
      const startZ = get().config.maxZ;
      const createdIds = normalizedNotes.map(() => crypto.randomUUID());

      set((state) => {
        normalizedNotes.forEach((note, index) => {
          const newNote: Note = {
            id: createdIds[index],
            boardId,
            title: '',
            content: note.content,
            x: note.x,
            y: note.y,
            z: startZ + index + 1,
            color: NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)],
            collapsed: false,
            createdAt,
            updatedAt: createdAt,
          };

          appendNoteToNormalizedState(state, newNote);
        });

        state.config.maxZ += normalizedNotes.length;
        state.selectedIds = createdIds;
        state.recentlyCreatedIds = createdIds;
        assignNoteHighlights(state, createdIds, 'created');
      });

      get().saveToDisk();
      return createdIds;
    },

    updateTitle: (id, title) => {
      set((state) => {
        const note = getNoteById(state, id);
        if (note) {
          note.title = title;
          note.updatedAt = Date.now();
        }
      });
      
      // Throttle WAL save
      const now = Date.now();
      if (now - lastWALSave > WAL_THROTTLE) {
        lastWALSave = now;
        db.saveWAL(serializeState(get()));
      }
      
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => get().saveToDisk(), DEBOUNCE_DELAY);
    },

    updateNote: (id, content) => {
      set((state) => {
        const note = getNoteById(state, id);
        if (note) {
          note.content = content;
          note.updatedAt = Date.now();
        }
      });
      
      const now = Date.now();
      if (now - lastWALSave > WAL_THROTTLE) {
        lastWALSave = now;
        db.saveWAL(serializeState(get()));
      }
      
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => get().saveToDisk(), DEBOUNCE_DELAY);
    },

    moveNote: (id, x, y) => {
      set((state) => {
        const note = getNoteById(state, id);
        if (note) {
          note.x = x;
          note.y = y;
          state.layoutNotesById[note.id] = extractLayoutNote(note);
        }
      });
    },


    moveSelectedNotes: (dx, dy, excludeId) => {
        set((state) => {
            state.selectedIds.forEach(id => {
                if (id === excludeId) return;
                const note = getNoteById(state, id);
                if (note) {
                    note.x += dx;
                    note.y += dy;
                    state.layoutNotesById[note.id] = extractLayoutNote(note);
                }
            });
        });
    },


    finalizeLayoutChange: (noteIds) => {
        const uniqueIds = [...new Set(noteIds)];
        if (uniqueIds.length === 0) return;

        const timestamp = Date.now();
        let hasUpdatedNotes = false;

        set((state) => {
            uniqueIds.forEach((id) => {
                const note = getNoteById(state, id);
                if (note) {
                    note.updatedAt = timestamp;
                    hasUpdatedNotes = true;
                }
            });
        });

        if (hasUpdatedNotes) {
            if (saveTimeout) clearTimeout(saveTimeout);
            saveTimeout = setTimeout(() => get().saveToDisk(), DEBOUNCE_DELAY);
        }
    },

    arrangeNotes: (
        startX?: number,
        startY?: number,
        strategy: ArrangeNotesStrategy = 'position',
        scope: ArrangeNotesScope = 'auto',
    ) => {
        const affectedIds: string[] = [];
        set((state) => {
            const viewport = state.viewport;
            const worldRightEdge = viewport.x + viewport.w;
            const worldBottomEdge = viewport.y + viewport.h;

            // Default to current viewport + padding if not provided
            const effectiveStartX = startX ?? (viewport.x + 50);
            const effectiveStartY = startY ?? (viewport.y + 50);

            const COLUMN_WIDTH = 320; // Approx card width (300) + gap (20)
            const ROW_GAP = 20;
            
            // 1. Determine targets: Selection or current board
            let targetNotes = denormalizeNotes(state);
            const shouldArrangeSelection = scope === 'selection' || (scope === 'auto' && state.selectedIds.length > 0);
            
            if (shouldArrangeSelection) {
                targetNotes = state.selectedIds.flatMap((id) => {
                    const note = state.notesById[id];
                    return note ? [note] : [];
                });
            } else {
                // Fix: Only arrange notes in the current board!
                targetNotes = getBoardNotes(state, state.currentBoardId);
            }

            if (targetNotes.length === 0) return;

            affectedIds.push(...targetNotes.map((note) => note.id));
            state.arrangeUndoToast = createArrangeUndoToast(
                targetNotes.map((note) => ({ id: note.id, x: note.x, y: note.y })),
            );

            const sortedNotes = sortNotesForArrange(targetNotes, strategy);

            // 3. Row-based Layout with Boundary Check
            let currentX = effectiveStartX;
            let currentY = effectiveStartY;
            let maxRowH = 0;
            
            // Boundary Guard for Start Position
            // Ensure we don't start off the right edge of the world view
            if (currentX + COLUMN_WIDTH > worldRightEdge) {
                currentX = Math.max(viewport.x + 20, worldRightEdge - COLUMN_WIDTH * 2);
            }
            // Ensure we don't start off the bottom
            if (currentY > worldBottomEdge - 100) {
                currentY = viewport.y + 50; 
            }
            
            // Keep track of the "carriage return" X position
            const rowStartX = currentX;

            sortedNotes.forEach((note) => {
                // Check if we need to wrap to new row
                if (currentX + COLUMN_WIDTH > worldRightEdge - 20) {
                    currentX = rowStartX;
                    currentY += maxRowH + ROW_GAP;
                    maxRowH = 0; // Reset row height
                }

                // Update Note Position in State
                // We need to find the actual note object in the drafted state
                const stateNote = getNoteById(state, note.id);
                if (stateNote) {
                    stateNote.x = currentX;
                    stateNote.y = currentY;
                    state.layoutNotesById[stateNote.id] = extractLayoutNote(stateNote);
                }


                // Advance X
                currentX += COLUMN_WIDTH;
                
                // Track max height for next row (assume default height 200 if not measured)
                // Since we don't know actual DOM height here, we assume a standard height or 
                // we could improve this by passing heights from UI.
                // For now, fixed row step or safe estimate.
                const estimatedHeight = getNoteVisualHeight(note, state.layoutNotesById[note.id]);
                if (estimatedHeight > maxRowH) maxRowH = estimatedHeight;
            });
        });
        if (affectedIds.length > 0) {
            get().finalizeLayoutChange(affectedIds);
        }
    },

    undoLastArrange: () => {
        const restoredIds: string[] = [];

        set((state) => {
            const snapshot = state.arrangeUndoToast;
            if (!snapshot) return;

            snapshot.positions.forEach((position) => {
                const note = getNoteById(state, position.id);
                if (!note || note.deletedAt) return;

                note.x = position.x;
                note.y = position.y;
                state.layoutNotesById[note.id] = extractLayoutNote(note);
                restoredIds.push(note.id);
            });

            state.arrangeUndoToast = null;
        });

        if (restoredIds.length > 0) {
            get().finalizeLayoutChange(restoredIds);
            return true;
        }

        return false;
    },

    dismissArrangeUndoToast: () => {
        set((state) => {
            state.arrangeUndoToast = null;
        });
    },

    bringToFront: (id) => {
      set((state) => {
        const note = getNoteById(state, id);
        if (note) {
          state.config.maxZ += 1;
          note.z = state.config.maxZ;
        }
      });
    },

    deleteNote: (id) => {
      set((state) => {
        const note = getNoteById(state, id);
        if (note) {
          note.deletedAt = Date.now(); // Soft delete
          state.layoutNotesById[note.id] = extractLayoutNote(note);
          clearTransientNoteState(state, note.id);
        }
        // Remove from selection if deleted
        state.selectedIds = state.selectedIds.filter(selId => selId !== id);
      });
      get().saveToDisk();
    },

    
    restoreNote: (id) => {
        set((state) => {
            const note = getNoteById(state, id);
            if (note) {
                note.deletedAt = null; // Restore
                
                // Safety Check: Does the target board still exist?
                const boardExists = state.boards.some(b => b.id === note.boardId);
                if (!boardExists) {
                    moveNoteBetweenBoards(state, id, state.currentBoardId);
                }
                
                // Visual Feedback: Bring to top so user sees it
                state.config.maxZ += 1;
                note.z = state.config.maxZ;
                state.layoutNotesById[note.id] = extractLayoutNote(note);
            }
        });
        get().saveToDisk();
    },


    deleteNotePermanently: (id) => {
        set((state) => {
            removeNoteFromNormalizedState(state, id);
            state.selectedIds = state.selectedIds.filter((selectedId) => selectedId !== id);
        });
        get().saveToDisk();
    },

    emptyTrash: () => {
        set((state) => {
            const noteIdsToDelete = state.allNoteIds.filter((id) => state.notesById[id]?.deletedAt);
            noteIdsToDelete.forEach((noteId) => removeNoteFromNormalizedState(state, noteId));
            state.selectedIds = state.selectedIds.filter((id) => state.notesById[id]);
        });
        get().saveToDisk();
    },

    restoreAllTrash: () => {
        set((state) => {
            state.allNoteIds.forEach((id) => {
                const note = state.notesById[id];
                if (!note) return;
                if (note.deletedAt) {
                    note.deletedAt = null;
                    // Safety Check
                    if (!state.boards.some(b => b.id === note.boardId)) {
                        moveNoteBetweenBoards(state, id, state.currentBoardId);
                    }
                    // Bring to front
                    state.config.maxZ += 1;
                    note.z = state.config.maxZ;
                    state.layoutNotesById[note.id] = extractLayoutNote(note);
                }
            });
        });
        get().saveToDisk();
    },

    restoreSelectedTrash: (ids) => {
        set((state) => {
            ids.forEach((id) => {
                const note = state.notesById[id];
                if (!note || !note.deletedAt) return;
                
                note.deletedAt = null;
                
                if (!state.boards.some(b => b.id === note.boardId)) {
                    moveNoteBetweenBoards(state, id, state.currentBoardId);
                }
                
                state.config.maxZ += 1;
                note.z = state.config.maxZ;
                state.layoutNotesById[note.id] = extractLayoutNote(note);
            });
        });
        get().saveToDisk();
    },

    deleteSelectedPermanently: (ids) => {
        set((state) => {
            ids.forEach((id) => {
                removeNoteFromNormalizedState(state, id);
            });
            state.selectedIds = state.selectedIds.filter((selectedId) => !ids.includes(selectedId));
        });
        get().saveToDisk();
    },

    
    changeColor: (id, color) => {
      set((state) => {
         const note = getNoteById(state, id);
         if (note) {
           note.color = color;
           state.layoutNotesById[note.id] = extractLayoutNote(note);
         }
      });
      get().saveToDisk();
    },

    changeSelectedNotesColor: (color) => {
        set((state) => {
            state.selectedIds.forEach(id => {
                const note = getNoteById(state, id);
                if (note) {
                    note.color = color;
                    state.layoutNotesById[note.id] = extractLayoutNote(note);
                }
            });
        });
        get().saveToDisk();
    },

    toggleCollapse: (id) => {
      set((state) => {
        const note = getNoteById(state, id);
        if (note) {
          note.collapsed = !note.collapsed;
        }
      });
      get().saveToDisk();
    },
    
    setStickyDrag: (id, offsetX = 0, offsetY = 0, status: StickyDragStatus = 'active') => {
        set((state) => {
            state.stickyDrag = { id, offsetX, offsetY, status };
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
                state.selectedIds = state.selectedIds.filter(i => i !== id);
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

    selectAllNotes: () => {
        set((state) => {
            const currentBoardNotes = getBoardNotes(state, state.currentBoardId).filter((note) => !note.deletedAt);
            state.selectedIds = currentBoardNotes.map(n => n.id);
        });
    },

    setContextMenu: (menu) => {
        set((state) => {
            state.contextMenu = menu;
        });
    },

    deleteSelectedNotes: () => {
        const { selectedIds } = get();
        if (selectedIds.length === 0) return;
        
        set((state) => {
            selectedIds.forEach((id) => {
                const note = state.notesById[id];
                if (note) {
                    note.deletedAt = Date.now();
                    state.layoutNotesById[note.id] = extractLayoutNote(note);
                    clearTransientNoteState(state, note.id);
                }
            });
            state.selectedIds = [];
        });
        get().saveToDisk();
    },

    duplicateNote: (id) => {
        set((state) => {
            const note = getNoteById(state, id);
            if (note) {
                const newNote: Note = {
                    ...note,
                    id: crypto.randomUUID(),
                    x: note.x + 20,
                    y: note.y + 20,
                    z: state.config.maxZ + 1,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    // Title copy? Yes.
                };
                appendNoteToNormalizedState(state, newNote);
                state.config.maxZ += 1;
                // Auto-select the new note? Maybe not, to avoid confusion.
            }
        });
        get().saveToDisk();
    },

    duplicateSelectedNotes: () => {
        set((state) => {
            const { selectedIds } = state;
            if (selectedIds.length === 0) return;
            
            const newSelectedIds: string[] = [];

            selectedIds.forEach(id => {
                const note = getNoteById(state, id);
                if (note) {
                    const newNote: Note = {
                        ...note,
                        id: crypto.randomUUID(),
                        x: note.x + 20, // Offset slightly
                        y: note.y + 20,
                        z: state.config.maxZ + 1,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                    };
                    appendNoteToNormalizedState(state, newNote);
                    state.config.maxZ += 1;
                    newSelectedIds.push(newNote.id);
                }
            });

            // Auto-select the newly created duplicates for UX
            if (newSelectedIds.length > 0) {
                state.selectedIds = newSelectedIds;
            }
        });
        get().saveToDisk();
    },

    moveNoteToBoard: (id, targetBoardId) => {
        set((state) => {
            const note = getNoteById(state, id);
            if (note) {
                moveNoteBetweenBoards(state, id, targetBoardId);
                note.x += Math.floor(Math.random() * 20);
                note.y += Math.floor(Math.random() * 20);
                state.layoutNotesById[note.id] = extractLayoutNote(note);
                state.selectedIds = state.selectedIds.filter(selId => selId !== id);
            }
        });
        get().saveToDisk();
    },

    copyNoteToBoard: (id, targetBoardId) => {
        set((state) => {
            const note = getNoteById(state, id);
            if (note) {
                const newNote: Note = {
                    ...note,
                    id: crypto.randomUUID(),
                    boardId: targetBoardId,
                    z: state.config.maxZ + 1,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                };
                newNote.x += Math.floor(Math.random() * 20);
                newNote.y += Math.floor(Math.random() * 20);
                appendNoteToNormalizedState(state, newNote);
                state.layoutNotesById[newNote.id] = extractLayoutNote(newNote);
                state.config.maxZ += 1;
            }
        });
        get().saveToDisk();
    },

    moveSelectedNotesToBoard: (targetBoardId) => {
        set((state) => {
            const { selectedIds } = state;
            if (selectedIds.length === 0) return;

            let movedCount = 0;
            selectedIds.forEach((id) => {
                const note = state.notesById[id];
                if (note) {
                    moveNoteBetweenBoards(state, id, targetBoardId);
                    note.x += Math.floor(Math.random() * 30);
                    note.y += Math.floor(Math.random() * 30);
                    state.layoutNotesById[note.id] = extractLayoutNote(note);
                    movedCount++;
                }
            });

            if (movedCount > 0) {
                state.selectedIds = [];
            }
        });
        get().saveToDisk();
    },

    copySelectedNotesToBoard: (targetBoardId) => {
        set((state) => {
            const { selectedIds } = state;
            if (selectedIds.length === 0) return;

            selectedIds.forEach(id => {
                const note = getNoteById(state, id);
                if (note) {
                    const newNote: Note = {
                        ...note,
                        id: crypto.randomUUID(),
                        boardId: targetBoardId,
                        z: state.config.maxZ + 1,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                    };
                    newNote.x += Math.floor(Math.random() * 30);
                    newNote.y += Math.floor(Math.random() * 30);
                    appendNoteToNormalizedState(state, newNote);
                    state.layoutNotesById[newNote.id] = extractLayoutNote(newNote);
                    state.config.maxZ += 1;
                }
            });
        });
        get().saveToDisk();
    },

    batchToggleCollapse: (ids) => {
        set((state) => {
            if (ids.length === 0) return;
            
            const collapsedCount = ids.filter(id => {
                const note = state.notesById[id];
                return note?.collapsed;
            }).length;
            
            const shouldExpand = collapsedCount >= ids.length / 2;
            
            ids.forEach(id => {
                const note = state.notesById[id];
                if (note) {
                    note.collapsed = shouldExpand ? false : true;
                }
            });
        });
        get().saveToDisk();
    },

    batchBringToFront: (ids) => {
        set((state) => {
            if (ids.length === 0) return;
            
            const notesWithZ = ids
                .map(id => ({ id, z: state.notesById[id]?.z ?? 0 }))
                .sort((a, b) => a.z - b.z);
            
            let currentMaxZ = state.config.maxZ;
            
            notesWithZ.forEach(({ id }) => {
                const note = state.notesById[id];
                if (note) {
                    currentMaxZ += 1;
                    note.z = currentMaxZ;
                }
            });
            
            state.config.maxZ = currentMaxZ;
        });
        get().saveToDisk();
    },

    batchSendToBack: (ids) => {
        set((state) => {
            if (ids.length === 0) return;
            
            const allZValues = Object.values(state.notesById)
                .map(n => n.z)
                .filter((z): z is number => z !== undefined);
            const minZ = Math.min(...allZValues, 0);
            
            const notesWithZ = ids
                .map(id => ({ id, z: state.notesById[id]?.z ?? 0 }))
                .sort((a, b) => a.z - b.z);
            
            let currentMinZ = minZ - ids.length;
            
            notesWithZ.forEach(({ id }) => {
                const note = state.notesById[id];
                if (note) {
                    currentMinZ += 1;
                    note.z = currentMinZ;
                }
            });
        });
        get().saveToDisk();
    },

    reorderBoard: (boardId, direction) => {
        set((state) => {
            const index = state.boards.findIndex(b => b.id === boardId);
            if (index === -1) return;

            const newIndex = direction === 'left' ? index - 1 : index + 1;
            
            // Boundary Check
            if (newIndex < 0 || newIndex >= state.boards.length) return;

            // Swap
            const temp = state.boards[index];
            state.boards[index] = state.boards[newIndex];
            state.boards[newIndex] = temp;
        });
        get().saveToDisk();
    },

    saveToDisk: async () => {
      const currentState = get();
      const { saveGenerationId } = currentState;
      const storageData = serializeState(currentState);
      const currentGen = saveGenerationId + 1;
      set({ isSaving: true, saveStatus: 'saving', saveError: null, saveGenerationId: currentGen });

      try {
        const serializationStart = performance.now();
        const jsonString = JSON.stringify(storageData, null, 2);
        const serializationDuration = performance.now() - serializationStart;

        const ipcStart = performance.now();
        const walSaved = await db.saveWAL(storageData);
        if (!walSaved) {
          if (get().saveGenerationId === currentGen) {
             set({ saveStatus: 'error', saveError: '写入本地缓存失败，未保存到磁盘。' });
          }
          return false;
        }

        const result = await invoke<SaveResult>('save_content', { filename: 'data.json', content: jsonString, generationId: currentGen });
        const ipcDuration = performance.now() - ipcStart;
        const ioDuration = result?.io_duration_ms || 0;

        // 检查 Rust 侧写入结果（WriteAck.success 可能为 false）
        if (!result?.success) {
          const errorMsg = result?.error || '磁盘写入失败';
          if (import.meta.env.DEV) {
            console.warn(`[Save] Rust 写入失败: ${errorMsg}, 重试: ${result?.retries || 0}`);
          }
          if (get().saveGenerationId === currentGen) {
             set({ saveStatus: 'error', saveError: errorMsg });
          }
          return false;
        }

        if (import.meta.env.DEV) {
          console.log(`[Save] 序列化: ${serializationDuration.toFixed(2)}ms, IPC+IO: ${ipcDuration.toFixed(2)}ms, Rust I/O: ${ioDuration}ms`);
        }

        diagnostics.updateMetrics({ lastSaveDuration: Math.round(ipcDuration) });
        if (ipcDuration > 500) {
          diagnostics.recordSlowPath('数据落盘 (IPC+IO)', ipcDuration);
        }

        if (get().saveGenerationId === currentGen) {
           set({ saveStatus: 'saved', saveError: null, lastSavedAt: Date.now() });
        }

        return true;
      } catch (err) {
        console.error('Disk Save Failed:', err);
        if (get().saveGenerationId === currentGen) {
           set({ saveStatus: 'error', saveError: resolveSaveErrorMessage(err) });
        }
        return false;
      } finally {
        // 只有当前世代仍是自己时，才由自己关闭 loading 状态
        // 否则高并发下旧世代的 finally 会误清新世代的 isSaving
        if (get().saveGenerationId === currentGen) {
          set({ isSaving: false });
        }
      }
    },

    exportBoard: async (boardId) => {
        const state = get();
        const { boards } = state;
        const board = boards.find(b => b.id === boardId);
        if (!board) return;

        const json = generateBoardExport(board, denormalizeNotes(state));
        const fileName = `Board_${board.name.replace(/[^a-z0-9]/gi, '_')}.json`;
        
        await saveFile(json, fileName);
    },

    exportCurrentBoard: async () => {
        const { currentBoardId } = get();
        await get().exportBoard(currentBoardId);
    },

    exportAll: async () => {
        const state = get();
        const { boards, config, currentBoardId } = state;
        const notes = denormalizeNotes(state);
        const json = generateFullBackup(boards, notes, config, currentBoardId);
        const fileName = `SoNotes_Backup_${new Date().toISOString().split('T')[0]}.json`;
        
        await saveFile(json, fileName);
    },

    exportSelectedNotes: async () => {
        const state = get();
        const { selectedIds, boards, currentBoardId } = state;
        if (selectedIds.length === 0) return;

        const selectedNotes = selectedIds
            .map(id => state.notesById[id])
            .filter((n): n is Note => n !== undefined && !n.deletedAt);

        if (selectedNotes.length === 0) return;

        const currentBoard = boards.find(b => b.id === currentBoardId);
        if (!currentBoard) return;

        const json = generateBoardExport(currentBoard, selectedNotes);
        const fileName = `Selected_${selectedNotes.length}_notes.json`;
        
        await saveFile(json, fileName);
    },

    importFromFile: async () => {
        const jsonContent = await openFile();
        if (!jsonContent) {
            return { status: 'cancelled' };
        }

        const existingBoardNames = get().boards.map(board => board.name);
        const result = processImport(jsonContent, existingBoardNames);
        if (result.status === 'error') {
            console.error(`Import failed: ${result.code} - ${result.message}`);
            return {
                status: 'error',
                code: result.code,
                message: result.message,
            };
        }

        const previousState = get();
        const snapshot = {
            boards: previousState.boards,
            notes: denormalizeNotes(previousState),
            currentBoardId: previousState.currentBoardId,
            viewMode: previousState.viewMode,
            selectedIds: previousState.selectedIds,
        };

        const { boards: newBoards, notes: newNotes, suggestedCurrentBoardId, summary } = result.data;
        if (newBoards.length === 0) {
            return {
                status: 'error',
                code: 'INVALID_STRUCTURE',
                message: '导入失败：备份文件中没有可导入的看板。',
            };
        }

        set((state) => {
            // v1.2.7 约定：导入批次保留内部相对顺序，并整体追加到本地看板末尾。
            state.boards.push(...newBoards);
            newNotes.forEach((note) => appendNoteToNormalizedState(state, note));
            
            if (suggestedCurrentBoardId) {
                state.currentBoardId = suggestedCurrentBoardId;
                state.viewMode = 'BOARD';
            }
            state.selectedIds = [];
        });
        
        const saved = await get().saveToDisk();
        if (!saved) {
            set((state) => {
                const normalizedSnapshot = normalizeNotes(snapshot.notes);
                state.boards = snapshot.boards;
                state.notesById = normalizedSnapshot.notesById;
                state.allNoteIds = normalizedSnapshot.allNoteIds;
                state.boardNoteIds = normalizedSnapshot.boardNoteIds;
                state.layoutNotesById = createLayoutNotesById(normalizedSnapshot.notesById);
                state.currentBoardId = snapshot.currentBoardId;
                state.viewMode = snapshot.viewMode;
                state.selectedIds = snapshot.selectedIds;
            });
            await db.saveWAL({
                boards: snapshot.boards,
                notes: snapshot.notes,
                currentBoardId: snapshot.currentBoardId,
                config: get().config,
            });

            return {
                status: 'error',
                code: 'SAVE_FAILED',
                message: '导入失败：写入本地存储时出错，已回滚到导入前状态。',
                summary,
                rolledBack: true,
            };
        }

        const summaryMessage = summary.skippedNotesCount > 0
            ? `导入完成，已跳过 ${summary.skippedNotesCount} 条异常便签。`
            : result.compatibility === 'LEGACY'
                ? '已导入旧版备份，并按当前规则完成兼容处理。'
                : '导入成功。';

        return {
            status: 'success',
            message: summaryMessage,
            summary,
        };
    },

    setThemeMode: (mode) => {
        set((state) => {
            state.config.themeMode = mode;
        });

        // Apply theme immediately
        const isSystemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const shouldBeDark = mode === 'dark' || (mode === 'system' && isSystemDark);

        if (shouldBeDark) {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }

        // Persist to localStorage for index.html script
        localStorage.setItem('theme', mode);
        
        get().saveToDisk();
    },
  }))
);

