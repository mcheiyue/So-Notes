import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { invoke } from '@tauri-apps/api/core';
import { LayoutNote, Note, AppConfig, StorageData, StorageDataInput, STORAGE_SCHEMA_VERSION, DEFAULT_CONFIG, NOTE_COLORS, ContextMenuState, Board, DEFAULT_BOARD, ViewMode, ViewportState, AppCanvasState, InteractionState, ThemeMode, ShellRectState, SaveResult, StickyDragStatus, NoteHighlight, NoteHighlightReason, AttachmentRef } from './types';

import { db } from './db';
import { createEmptyNormalizedNotesState, createLayoutNotesById, denormalizeNotes, extractLayoutNote, normalizeNotes, sanitizeNoteAttachments } from './normalization';
import { createUndoRedoHistory, pushHistoryEntry, undoHistory, redoHistory, clearDomainHistory as clearDomainHistoryFn, type HistoryStack, type HistoryEntry } from './undoRedoHistory';
import { applyDomainPatch, type DomainPatch } from './domainPatches';
import type { DomainState } from './domainStore';

import { saveFile, openFile } from '../utils/fileSystem';
import { createDataTransferService, type ImportFromFileResult } from '../services/transfer/DataTransferService';
import { diagnostics } from '../utils/diagnostics';
import { getNoteVisualHeight } from '../utils/noteVisualMetrics';
import { finalizeActiveNoteDrag } from '../utils/activeNoteDrag';
import { buildSmartPasteNoteInputs, splitParagraphs } from '../utils/smartPaste';
import type { SmartPasteNoteInput, SmartPasteOptionId, SmartPasteResult } from '../utils/smartPaste';
import { LAYOUT } from '../constants/layout';
import { computeImageNoteSize } from '../utils/imageNoteSize';
import { deleteAttachmentFile, invalidateAttachmentPathCache, resolveAttachmentAssetUrlCached } from '../services/storage/attachmentPersistence';
import { collectLiveAttachmentRefs } from '../services/storage/attachmentConsistency';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface SmartPasteSplitPanelState {
  noteId: string;
  result: SmartPasteResult;
}

interface DetachedNoteUIEntry {
  noteId: string;
  position: { x: number; y: number };
  isPinned: boolean;
}

interface NoteResizeSnapshot {
  editingWidth: number | undefined;
  editingHeight: number | undefined;
  renderedWidth: number;
  renderedHeight: number;
  updatedAt: number;
}

type ArrangeNotesStrategy = 'position' | 'updatedAt' | 'color';
type ArrangeNotesScope = 'auto' | 'board' | 'selection';

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
  detachedNotes: DetachedNoteUIEntry[];

  // 领域撤销/重做历史（v1.4.3）
  domainHistory: HistoryStack<DomainPatch>;

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
  mergeSelectedNotes: () => string | null;
  splitNoteByParagraph: (noteId: string) => string[];
  bringToFront: (id: string, options?: { recordHistory?: boolean }) => void;
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
  toggleCollapse: (id: string, options?: { recordHistory?: boolean }) => void;
  undoDomainChange: () => boolean;
  redoDomainChange: () => boolean;
  clearDomainHistory: () => void;
  commitNoteTextEdit: (noteId: string, beforeTitle: string, beforeContent: string, beforeUpdatedAt: number) => void;
  commitNoteEditingSize: (noteId: string, newWidth: number, newHeight: number, beforeResize: NoteResizeSnapshot) => void;
  captureMoveSnapshot: (positions: Record<string, { x: number; y: number; updatedAt: number }>) => void;
  setStickyDrag: (id: string | null, offsetX?: number, offsetY?: number, status?: StickyDragStatus) => void;
  addImageNotesBatch: (inputs: Array<{ x: number; y: number; attachment: AttachmentRef; originalWidth?: number; originalHeight?: number }>) => string[];
  
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

let noteHighlightSequence = 0;
const noteHighlightTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const recentlyCreatedTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const pendingMoveSnapshots = new Map<string, { x: number; y: number; updatedAt: number }>();

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
  schemaVersion: STORAGE_SCHEMA_VERSION,
  storageUpdatedAt: Date.now(),
  notes: denormalizeNotes(state),
  boards: state.boards,
  currentBoardId: state.currentBoardId,
  config: state.config,
});

const isFiniteTimestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const getLegacyStorageUpdatedAt = (notes: Note[]): number => {
  if (notes.length === 0) {
    return 0;
  }

  return Math.max(...notes.map((note) => note.updatedAt || 0));
};

const hasInvalidStorageContract = (data: StorageData): boolean =>
  !Array.isArray(data.notes)
  || !Array.isArray(data.boards)
  || data.boards.length === 0
  || typeof data.currentBoardId !== 'string'
  || data.currentBoardId.length === 0
  || !data.boards.some((board) => board.id === data.currentBoardId);

const hasValidStorageContract = (data: StorageData | null | undefined): data is StorageData =>
  data != null && !hasInvalidStorageContract(data);

const hasMigratableStorageData = (data: StorageData | null | undefined): data is StorageData =>
  data != null && Array.isArray(data.notes);

const normalizeStorageDataMetadata = (data: StorageDataInput): StorageData => ({
  ...data,
  schemaVersion: isFiniteTimestamp(data.schemaVersion) ? data.schemaVersion : STORAGE_SCHEMA_VERSION,
  storageUpdatedAt: isFiniteTimestamp(data.storageUpdatedAt) ? data.storageUpdatedAt : getLegacyStorageUpdatedAt(data.notes),
});

const normalizeWalStorageData = (raw: unknown): StorageData | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  if (!Array.isArray((raw as { notes?: unknown }).notes)) return undefined;

  try {
    return normalizeStorageDataMetadata(raw as StorageDataInput);
  } catch {
    return undefined;
  }
};

const migrateAndSanitizeStorageData = (data: StorageData): StorageData => {
  const migrated: StorageData = {
    ...data,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    notes: Array.isArray(data.notes) ? data.notes : [],
    boards: Array.isArray(data.boards) ? data.boards : [DEFAULT_BOARD],
    currentBoardId: typeof data.currentBoardId === 'string' ? data.currentBoardId : DEFAULT_BOARD.id,
    config: { ...DEFAULT_CONFIG, ...(data.config && typeof data.config === 'object' ? data.config : {}) },
  };

  if (migrated.notes.length > 0) {
    const currentMaxZ = Math.max(...migrated.notes.map(n => n.z || 0), 0);
    migrated.config.maxZ = Math.max(currentMaxZ, migrated.notes.length);

    migrated.notes.forEach((n, i) => {
      if (n.x < 0 || n.y < 0) { n.x = 20 + (i * 10); n.y = 20 + (i * 10); }
      if (n.collapsed === undefined) n.collapsed = false;
      if (n.title === undefined) n.title = '';
      if (n.kind !== 'image') n.kind = 'text';
      if (!n.boardId) n.boardId = 'default';
      if (!n.updatedAt) n.updatedAt = n.createdAt || Date.now();
      if (n.width !== undefined && n.editingWidth === undefined) { n.editingWidth = n.width; }
      if (n.height !== undefined && n.editingHeight === undefined) { n.editingHeight = n.height; }
      delete n.width;
      delete n.height;
      n.attachments = sanitizeNoteAttachments(n);
    });
  }

  if (migrated.boards.length === 0) {
    migrated.boards = [DEFAULT_BOARD];
    migrated.currentBoardId = DEFAULT_BOARD.id;
  }

  if (!migrated.currentBoardId || !migrated.boards.find(b => b.id === migrated.currentBoardId)) {
    migrated.currentBoardId = migrated.boards[0].id;
  }

  return migrated;
};

const tryPrepareStorageSource = (data: StorageData | null | undefined): StorageData | null => {
  if (!hasMigratableStorageData(data)) return null;

  try {
    const migrated = migrateAndSanitizeStorageData(data);
    return hasValidStorageContract(migrated) ? migrated : null;
  } catch {
    return null;
  }
};

const getBoardNoteIds = (state: Pick<State, 'boardNoteIds'>, boardId: string): string[] => state.boardNoteIds[boardId] ?? [];

const getNoteById = (state: Pick<State, 'notesById'>, id: string): Note | undefined => state.notesById[id];

const getBoardNotes = (state: Pick<State, 'notesById' | 'boardNoteIds'>, boardId: string): Note[] => {
  return getBoardNoteIds(state, boardId).flatMap((id) => {
    const note = state.notesById[id];
    return note && !note.deletedAt ? [note] : [];
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

const collectAttachmentRelativePaths = (notes: Note[]): Set<string> => {
  const paths = new Set<string>();
  collectLiveAttachmentRefs(notes).forEach((ref) => paths.add(ref.relativePath));
  return paths;
};

const cleanupUnreferencedAttachmentFiles = (candidatePaths: ReadonlySet<string>) => {
  if (candidatePaths.size === 0) return;

  const livePaths = collectAttachmentRelativePaths(Object.values(useStore.getState().notesById));
  const pathsToDelete = Array.from(candidatePaths).filter((relativePath) => !livePaths.has(relativePath));
  if (pathsToDelete.length === 0) return;

  void Promise.allSettled(
    pathsToDelete.map(async (relativePath) => {
      await deleteAttachmentFile(relativePath);
      invalidateAttachmentPathCache(relativePath);
    }),
  );
};

const extractDomainSlice = (state: State): DomainState => ({
  notesById: state.notesById,
  allNoteIds: state.allNoteIds,
  boardNoteIds: state.boardNoteIds,
  layoutNotesById: state.layoutNotesById,
  boards: state.boards,
  currentBoardId: state.currentBoardId,
  config: state.config,
});

const resolveRestoreBoardId = (
  state: Pick<State, 'boards' | 'currentBoardId'>,
  preferredBoardId: string,
): string | null => {
  if (state.boards.some((board) => board.id === preferredBoardId)) {
    return preferredBoardId;
  }
  if (state.boards.some((board) => board.id === state.currentBoardId)) {
    return state.currentBoardId;
  }
  return state.boards[0]?.id ?? null;
};

const prehydrateImageNoteAssetUrls = async (notes: Note[]): Promise<void> => {
  const imageRelativePaths = notes
    .filter((note) => note.kind === 'image')
    .flatMap((note) => note.attachments ?? [])
    .map((attachment) => attachment.relativePath);

  if (imageRelativePaths.length === 0) return;

  await Promise.allSettled(
    Array.from(new Set(imageRelativePaths)).map((relativePath) =>
      resolveAttachmentAssetUrlCached(relativePath),
    ),
  );
};

const clearDanglingNoteUiRefs = (state: State, removedNoteIds: ReadonlySet<string>) => {
  state.selectedIds = state.selectedIds.filter((id) => !removedNoteIds.has(id));
  state.recentlyCreatedIds = state.recentlyCreatedIds.filter((id) => !removedNoteIds.has(id));
  for (const id of removedNoteIds) {
    clearNoteHighlightTimer(id);
    delete state.noteHighlights[id];
  }
};

const extractAffectedNoteFromPatch = (
  patch: DomainPatch,
  currentState: DomainState,
): { noteId: string; boardId: string } | null => {
  switch (patch.type) {
    case 'add-note':
      return { noteId: patch.note.id, boardId: patch.note.boardId };
    case 'remove-note': {
      const note = currentState.notesById[patch.noteId];
      return note ? { noteId: patch.noteId, boardId: note.boardId } : null;
    }
    case 'update-fields': {
      const note = currentState.notesById[patch.noteId];
      if (!note) return null;
      return { noteId: patch.noteId, boardId: patch.fields.boardId ?? note.boardId };
    }
    case 'update-position': {
      const note = currentState.notesById[patch.noteId];
      return note ? { noteId: patch.noteId, boardId: note.boardId } : null;
    }
    case 'compound-patch': {
      for (const childPatch of patch.patches) {
        const affected = extractAffectedNoteFromPatch(childPatch, currentState);
        if (affected) return affected;
      }
      return null;
    }
  }
};

const buildAffectedNoteNavigationPatch = (
  patch: DomainPatch,
  preApplyDomain: DomainState,
  postApplyNotesById: Record<string, Note>,
  currentBoardId: string,
  viewport: State['viewport'],
): Partial<State> => {
  const affected = extractAffectedNoteFromPatch(patch, preApplyDomain);
  if (!affected) return {};

  const note = postApplyNotesById[affected.noteId];
  if (!note || note.deletedAt) return {};

  const nWidth = LAYOUT.NOTE_WIDTH;
  const nHeight = LAYOUT.NOTE_MIN_HEIGHT;
  const noteRight = note.x + nWidth;
  const noteBottom = note.y + nHeight;
  const isInCurrentViewport =
    noteRight >= viewport.x &&
    note.x <= viewport.x + viewport.w &&
    noteBottom >= viewport.y &&
    note.y <= viewport.y + viewport.h;
  const shouldCenter = affected.boardId !== currentBoardId || !isInCurrentViewport;

  const boardPatch: Partial<State> = affected.boardId !== currentBoardId
    ? { currentBoardId: affected.boardId, viewMode: 'BOARD' }
    : {};

  if (!shouldCenter) {
    return { ...boardPatch, selectedIds: [note.id] };
  }

  const targetX = note.x + nWidth / 2 - viewport.w / 2;
  const targetY = note.y + nHeight / 2 - viewport.h / 2;

  return {
    ...boardPatch,
    viewport: { ...viewport, x: targetX, y: targetY },
    selectedIds: [note.id],
  };
};

const toMutableHistoryStack = <T>(stack: HistoryStack<T>): {
  undoStack: HistoryEntry<T>[];
  redoStack: HistoryEntry<T>[];
  capacity: number;
} => ({
  undoStack: [...stack.undoStack],
  redoStack: [...stack.redoStack],
  capacity: stack.capacity,
});


// 薄委托目标：create 完成后由 top-level await 绑定，避免 useStore↔uiStore 循环 TDZ
let uiSetViewModeRef: (mode: ViewMode) => void = () => {
  throw new Error('setViewMode: uiStore 尚未就绪');
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
    detachedNotes: [],
    domainHistory: createUndoRedoHistory<DomainPatch>(),

    init: async () => {
      let finalData: StorageData = normalizeStorageDataMetadata({
        notes: [], 
        boards: [DEFAULT_BOARD], 
        currentBoardId: DEFAULT_BOARD.id, 
        config: DEFAULT_CONFIG 
      });
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
            diskData = normalizeStorageDataMetadata(parsed);
          }
        } catch (e) {
          console.warn('Failed to parse disk data:', e);
        }
      }

      // 2. Conflict Resolution: Timestamp Arbitration
      const getLatestUpdate = (data: StorageData | null | undefined) => {
        if (!data) return 0;
        return isFiniteTimestamp(data.storageUpdatedAt) ? data.storageUpdatedAt : getLegacyStorageUpdatedAt(data.notes);
      };

      const normalizedWalData = normalizeWalStorageData(walData);
      const walTime = getLatestUpdate(normalizedWalData);
      const diskTime = getLatestUpdate(diskData);

      const candidates = [
        { source: 'DISK' as const, data: diskData, time: diskTime },
        { source: 'WAL' as const, data: normalizedWalData, time: walTime },
      ].sort((left, right) => {
        if (left.time !== right.time) return right.time - left.time;
        if (left.source === right.source) return 0;
        return left.source === 'WAL' ? -1 : 1;
      });

      for (const candidate of candidates) {
        const prepared = tryPrepareStorageSource(candidate.data);
        if (prepared) {
          finalData = prepared;
          source = candidate.source;
          break;
        }
      }

      await prehydrateImageNoteAssetUrls(finalData.notes);

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
    },

    /** @deprecated 请使用 `useUIStore.setViewMode` 或 `appController.setViewMode` */
    setViewMode: (mode) => {
      // 由文件末尾 top-level await 绑定；模块初始化完成后可用
      uiSetViewModeRef(mode);
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
    },
    
    updateBoard: (boardId, updates) => {
        set((state) => {
            const board = state.boards.find(b => b.id === boardId);
            if (board) {
                Object.assign(board, updates);
            }
        });
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
            kind: 'text',
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

      return selectedIds;
    },

    setPinned: (pinned) => set({ isPinned: pinned }),

    addNote: (x, y) => {
      const newNote: Note = {
        id: crypto.randomUUID(),
        kind: 'text',
        boardId: get().currentBoardId,
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

        const entry: HistoryEntry<DomainPatch> = {
          id: crypto.randomUUID(),
          label: 'add-note',
          createdAt: Date.now(),
          undo: { type: 'remove-note', noteId: newNote.id },
          redo: { type: 'add-note', note: { ...newNote } },
        };
        state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
      });
    },

    addNoteWithContent: (x, y, content) => {
      const newNote: Note = {
        id: crypto.randomUUID(),
        kind: 'text',
        boardId: get().currentBoardId,
        title: '',
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

        const entry: HistoryEntry<DomainPatch> = {
          id: crypto.randomUUID(),
          label: 'add-note-with-content',
          createdAt: Date.now(),
          undo: { type: 'remove-note', noteId: newNote.id },
          redo: { type: 'add-note', note: { ...newNote } },
        };
        state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
      });
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
        const createdNotes: Note[] = [];

        normalizedNotes.forEach((note, index) => {
          const newNote: Note = {
            id: createdIds[index],
            kind: 'text',
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
          createdNotes.push({ ...newNote });
        });

        state.config.maxZ += normalizedNotes.length;
        state.selectedIds = createdIds;
        state.recentlyCreatedIds = createdIds;
        assignNoteHighlights(state, createdIds, 'created');

        const entry: HistoryEntry<DomainPatch> = {
          id: crypto.randomUUID(),
          label: 'add-notes-with-content-batch',
          createdAt: Date.now(),
          undo: {
            type: 'compound-patch',
            patches: createdIds.map((id) => ({ type: 'remove-note' as const, noteId: id })),
          },
          redo: {
            type: 'compound-patch',
            patches: createdNotes.map((note) => ({ type: 'add-note' as const, note })),
          },
        };
        state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
      });

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
    },

    updateNote: (id, content) => {
      set((state) => {
        const note = getNoteById(state, id);
        if (note) {
          note.content = content;
          note.updatedAt = Date.now();
        }
      });
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

        set((state) => {
            uniqueIds.forEach((id) => {
                const note = getNoteById(state, id);
                if (note) {
                    note.updatedAt = timestamp;
                }
            });

            if (uniqueIds.length === 1) {
                const noteId = uniqueIds[0];
                const snapshot = pendingMoveSnapshots.get(noteId);
                pendingMoveSnapshots.delete(noteId);
                const note = getNoteById(state, noteId);
                if (snapshot && note && !note.deletedAt && (note.x !== snapshot.x || note.y !== snapshot.y)) {
                    const entry: HistoryEntry<DomainPatch> = {
                        id: crypto.randomUUID(),
                        label: 'move-note',
                        createdAt: Date.now(),
                        undo: { type: 'update-position', noteId, x: snapshot.x, y: snapshot.y, updatedAt: snapshot.updatedAt },
                        redo: { type: 'update-position', noteId, x: note.x, y: note.y, updatedAt: note.updatedAt },
                    };
                    state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
                }
            } else {
                const undoPatches: DomainPatch[] = [];
                const redoPatches: DomainPatch[] = [];

                for (const id of uniqueIds) {
                    const snapshot = pendingMoveSnapshots.get(id);
                    pendingMoveSnapshots.delete(id);
                    if (!snapshot) continue;

                    const note = getNoteById(state, id);
                    if (!note || note.deletedAt) continue;
                    if (note.x === snapshot.x && note.y === snapshot.y) continue;

                    undoPatches.push({ type: 'update-position', noteId: id, x: snapshot.x, y: snapshot.y, updatedAt: snapshot.updatedAt });
                    redoPatches.push({ type: 'update-position', noteId: id, x: note.x, y: note.y, updatedAt: note.updatedAt });
                }

                if (undoPatches.length > 0) {
                    const entry: HistoryEntry<DomainPatch> = {
                        id: crypto.randomUUID(),
                        label: 'move-selected-notes',
                        createdAt: Date.now(),
                        undo: { type: 'compound-patch', patches: undoPatches },
                        redo: { type: 'compound-patch', patches: redoPatches },
                    };
                    state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
                }
            }
        });
    },

    arrangeNotes: (
        startX?: number,
        startY?: number,
        strategy: ArrangeNotesStrategy = 'position',
        scope: ArrangeNotesScope = 'auto',
    ) => {
        const affectedIds: string[] = [];
        const preArrangeSnapshots = new Map<string, { x: number; y: number; updatedAt: number }>();

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

            for (const note of targetNotes) {
                preArrangeSnapshots.set(note.id, { x: note.x, y: note.y, updatedAt: note.updatedAt });
            }

            affectedIds.push(...targetNotes.map((note) => note.id));

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

        if (preArrangeSnapshots.size > 0) {
            const currentState = get();
            const undoPatches: DomainPatch[] = [];
            const redoPatches: DomainPatch[] = [];

            for (const [noteId, snapshot] of preArrangeSnapshots) {
                const note = currentState.notesById[noteId];
                if (!note || note.deletedAt) continue;
                if (note.x === snapshot.x && note.y === snapshot.y) continue;

                undoPatches.push({ type: 'update-position', noteId, x: snapshot.x, y: snapshot.y, updatedAt: snapshot.updatedAt });
                redoPatches.push({ type: 'update-position', noteId, x: note.x, y: note.y, updatedAt: note.updatedAt });
            }

            if (undoPatches.length > 0) {
                set((state) => {
                    const entry: HistoryEntry<DomainPatch> = {
                        id: crypto.randomUUID(),
                        label: 'arrange-notes',
                        createdAt: Date.now(),
                        undo: { type: 'compound-patch', patches: undoPatches },
                        redo: { type: 'compound-patch', patches: redoPatches },
                    };
                    state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
                });
            }
        }
    },

    mergeSelectedNotes: () => {
        const selectedNotes = get().selectedIds
            .flatMap((id) => {
                const note = get().notesById[id];
                return note && !note.deletedAt ? [note] : [];
            });

        if (selectedNotes.length < 2) {
            return null;
        }

        // 跨看板防护：所有选中未删除便签必须属于同一 boardId
        const firstBoardId = selectedNotes[0].boardId;
        const isSameBoard = selectedNotes.every(note => note.boardId === firstBoardId);
        if (!isSameBoard) {
            return null;
        }

        const sortedNotes = [...selectedNotes].sort(compareNotesByPosition);
        const createdAt = Date.now();
        const mergedId = crypto.randomUUID();
        const minX = Math.min(...sortedNotes.map((note) => note.x));
        const minY = Math.min(...sortedNotes.map((note) => note.y));
        const mergedContent = sortedNotes
            .map((note) => note.content.trim())
            .filter((content) => content.length > 0)
            .join('\n\n');

        set((state) => {
            const newNote: Note = {
                id: mergedId,
                kind: 'text',
                boardId: sortedNotes[0].boardId,
                title: '',
                content: mergedContent,
                x: minX,
                y: minY,
                z: state.config.maxZ + 1,
                color: sortedNotes[0].color,
                collapsed: false,
                createdAt,
                updatedAt: createdAt,
            };

            for (const note of sortedNotes) {
                removeNoteFromNormalizedState(state, note.id);
            }
            appendNoteToNormalizedState(state, newNote);
            state.config.maxZ += 1;
            state.selectedIds = [mergedId];
            state.recentlyCreatedIds = [mergedId];
            assignNoteHighlights(state, [mergedId], 'created');

            const entry: HistoryEntry<DomainPatch> = {
                id: crypto.randomUUID(),
                label: 'merge-notes',
                createdAt: Date.now(),
                undo: {
                    type: 'compound-patch',
                    patches: [
                        { type: 'remove-note', noteId: newNote.id },
                        ...sortedNotes.map((n) => ({ type: 'add-note' as const, note: n })),
                    ],
                },
                redo: {
                    type: 'compound-patch',
                    patches: [
                        ...sortedNotes.map((n) => ({ type: 'remove-note' as const, noteId: n.id })),
                        { type: 'add-note', note: newNote },
                    ],
                },
            };
            state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
        });

        return mergedId;
    },

    splitNoteByParagraph: (noteId) => {
        const targetNote = get().notesById[noteId];
        if (!targetNote || targetNote.deletedAt) {
            return [];
        }

        const paragraphs = splitParagraphs(targetNote.content);
        if (paragraphs.length < 2) {
            return [];
        }

        const splitInputs = buildSmartPasteNoteInputs(['', ...paragraphs], targetNote.x, targetNote.y).slice(1);
        const createdAt = Date.now();
        const startZ = get().config.maxZ;
        const createdIds = splitInputs.map(() => crypto.randomUUID());

        set((state) => {
            const existingNote = state.notesById[noteId];
            if (!existingNote || existingNote.deletedAt) {
                return;
            }

            const originalNote = { ...existingNote };
            removeNoteFromNormalizedState(state, noteId);

            splitInputs.forEach((input, index) => {
                const newNote: Note = {
                    id: createdIds[index],
                    kind: 'text',
                    boardId: originalNote.boardId,
                    title: '',
                    content: input.content,
                    x: input.x,
                    y: input.y,
                    z: startZ + index + 1,
                    color: originalNote.color,
                    collapsed: false,
                    createdAt,
                    updatedAt: createdAt,
                };

                appendNoteToNormalizedState(state, newNote);
            });

            state.config.maxZ += splitInputs.length;
            state.selectedIds = createdIds;
            state.recentlyCreatedIds = createdIds;
            assignNoteHighlights(state, createdIds, 'created');

            const splitNotes = createdIds
                .map((id) => state.notesById[id])
                .filter((n): n is Note => n !== undefined);
            const entry: HistoryEntry<DomainPatch> = {
                id: crypto.randomUUID(),
                label: 'split-note',
                createdAt: Date.now(),
                undo: {
                    type: 'compound-patch',
                    patches: [
                        ...splitNotes.map((n) => ({ type: 'remove-note' as const, noteId: n.id })),
                        { type: 'add-note' as const, note: originalNote },
                    ],
                },
                redo: {
                    type: 'compound-patch',
                    patches: [
                        { type: 'remove-note' as const, noteId: originalNote.id },
                        ...splitNotes.map((n) => ({ type: 'add-note' as const, note: n })),
                    ],
                },
            };
            state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
        });

        return createdIds;
    },

    bringToFront: (id, options = {}) => {
      set((state) => {
        const note = getNoteById(state, id);
        if (note) {
          const oldZ = note.z;
          state.config.maxZ += 1;
          note.z = state.config.maxZ;

          if (options.recordHistory === false) return;

          const entry: HistoryEntry<DomainPatch> = {
            id: crypto.randomUUID(),
            label: 'bring-to-front',
            createdAt: Date.now(),
            undo: { type: 'update-fields', noteId: id, fields: { z: oldZ } },
            redo: { type: 'update-fields', noteId: id, fields: { z: note.z } },
          };
          state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
        }
      });
    },

    deleteNote: (id) => {
      set((state) => {
        const note = getNoteById(state, id);
        if (!note || note.deletedAt) return;

        const deletedAt = Date.now();
        note.deletedAt = deletedAt;
        state.layoutNotesById[note.id] = extractLayoutNote(note);
        clearTransientNoteState(state, note.id);
        state.selectedIds = state.selectedIds.filter(selId => selId !== id);

        const entry: HistoryEntry<DomainPatch> = {
          id: crypto.randomUUID(),
          label: 'soft-delete-note',
          createdAt: Date.now(),
          undo: { type: 'update-fields', noteId: id, fields: { deletedAt: null } },
          redo: { type: 'update-fields', noteId: id, fields: { deletedAt } },
        };
        state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
      });
    },

    
    restoreNote: (id) => {
        set((state) => {
            const note = getNoteById(state, id);
            if (!note || !note.deletedAt) return;

            const prevDeletedAt = note.deletedAt;
            const prevZ = note.z;
            const prevBoardId = note.boardId;

            const targetBoardId = resolveRestoreBoardId(state, note.boardId);
            if (!targetBoardId) return;

            note.deletedAt = null;
            if (note.boardId !== targetBoardId) {
                moveNoteBetweenBoards(state, id, targetBoardId);
            }

            state.config.maxZ += 1;
            note.z = state.config.maxZ;
            state.layoutNotesById[note.id] = extractLayoutNote(note);

            const entry: HistoryEntry<DomainPatch> = {
                id: crypto.randomUUID(),
                label: 'restore-note',
                createdAt: Date.now(),
                undo: { type: 'update-fields', noteId: id, fields: { deletedAt: prevDeletedAt, boardId: prevBoardId, z: prevZ } },
                redo: { type: 'update-fields', noteId: id, fields: { deletedAt: null, boardId: note.boardId, z: note.z } },
            };
            state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
        });
    },


    deleteNotePermanently: (id) => {
        const candidatePaths = new Set<string>();
        set((state) => {
            const note = state.notesById[id];
            if (note) {
                collectAttachmentRelativePaths([note]).forEach((relativePath) => candidatePaths.add(relativePath));
            }
            removeNoteFromNormalizedState(state, id);
            state.selectedIds = state.selectedIds.filter((selectedId) => selectedId !== id);
        });
        cleanupUnreferencedAttachmentFiles(candidatePaths);
    },

    emptyTrash: () => {
        const candidatePaths = new Set<string>();
        set((state) => {
            const noteIdsToDelete = state.allNoteIds.filter((id) => state.notesById[id]?.deletedAt);
            noteIdsToDelete.forEach((noteId) => {
                const note = state.notesById[noteId];
                if (note) {
                    collectAttachmentRelativePaths([note]).forEach((relativePath) => candidatePaths.add(relativePath));
                }
            });
            noteIdsToDelete.forEach((noteId) => removeNoteFromNormalizedState(state, noteId));
            state.selectedIds = state.selectedIds.filter((id) => state.notesById[id]);
        });
        cleanupUnreferencedAttachmentFiles(candidatePaths);
    },

    restoreAllTrash: () => {
        set((state) => {
            const snapshots: Array<{ id: string; prevDeletedAt: number; undoBoardId: string; prevZ: number }> = [];
            let maxZ = state.config.maxZ;

            state.allNoteIds.forEach((id) => {
                const note = state.notesById[id];
                if (!note || !note.deletedAt) return;

                const targetBoardId = resolveRestoreBoardId(state, note.boardId);
                if (!targetBoardId) return;

                snapshots.push({ id, prevDeletedAt: note.deletedAt, undoBoardId: targetBoardId, prevZ: note.z });

                note.deletedAt = null;
                if (note.boardId !== targetBoardId) {
                    moveNoteBetweenBoards(state, id, targetBoardId);
                }
                maxZ += 1;
                note.z = maxZ;
                state.layoutNotesById[note.id] = extractLayoutNote(note);
            });

            state.config.maxZ = maxZ;

            if (snapshots.length === 0) return;

            const entry: HistoryEntry<DomainPatch> = {
                id: crypto.randomUUID(),
                label: 'restore-all-trash',
                createdAt: Date.now(),
                undo: {
                    type: 'compound-patch',
                    patches: snapshots.map(({ id, prevDeletedAt, undoBoardId, prevZ }) => ({
                        type: 'update-fields' as const,
                        noteId: id,
                        fields: { deletedAt: prevDeletedAt, boardId: undoBoardId, z: prevZ },
                    })),
                },
                redo: {
                    type: 'compound-patch',
                    patches: snapshots.map(({ id }) => {
                        const note = state.notesById[id];
                        return {
                            type: 'update-fields' as const,
                            noteId: id,
                            fields: { deletedAt: null as number | null, boardId: note?.boardId ?? '', z: note?.z ?? 0 },
                        };
                    }),
                },
            };
            state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
        });
    },

    restoreSelectedTrash: (ids) => {
        set((state) => {
            const snapshots: Array<{ id: string; prevDeletedAt: number; undoBoardId: string; prevZ: number }> = [];
            let maxZ = state.config.maxZ;

            ids.forEach((id) => {
                const note = state.notesById[id];
                if (!note || !note.deletedAt) return;

                const targetBoardId = resolveRestoreBoardId(state, note.boardId);
                if (!targetBoardId) return;

                snapshots.push({ id, prevDeletedAt: note.deletedAt, undoBoardId: targetBoardId, prevZ: note.z });

                note.deletedAt = null;
                if (note.boardId !== targetBoardId) {
                    moveNoteBetweenBoards(state, id, targetBoardId);
                }
                maxZ += 1;
                note.z = maxZ;
                state.layoutNotesById[note.id] = extractLayoutNote(note);
            });

            state.config.maxZ = maxZ;

            if (snapshots.length === 0) return;

            const entry: HistoryEntry<DomainPatch> = {
                id: crypto.randomUUID(),
                label: 'restore-selected-trash',
                createdAt: Date.now(),
                undo: {
                    type: 'compound-patch',
                    patches: snapshots.map(({ id, prevDeletedAt, undoBoardId, prevZ }) => ({
                        type: 'update-fields' as const,
                        noteId: id,
                        fields: { deletedAt: prevDeletedAt, boardId: undoBoardId, z: prevZ },
                    })),
                },
                redo: {
                    type: 'compound-patch',
                    patches: snapshots.map(({ id }) => {
                        const note = state.notesById[id];
                        return {
                            type: 'update-fields' as const,
                            noteId: id,
                            fields: { deletedAt: null as number | null, boardId: note?.boardId ?? '', z: note?.z ?? 0 },
                        };
                    }),
                },
            };
            state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
        });
    },

    deleteSelectedPermanently: (ids) => {
        const candidatePaths = new Set<string>();
        set((state) => {
            ids.forEach((id) => {
                const note = state.notesById[id];
                if (note) {
                    collectAttachmentRelativePaths([note]).forEach((relativePath) => candidatePaths.add(relativePath));
                }
                removeNoteFromNormalizedState(state, id);
            });
            state.selectedIds = state.selectedIds.filter((selectedId) => !ids.includes(selectedId));
        });
        cleanupUnreferencedAttachmentFiles(candidatePaths);
    },

    
    changeColor: (id, color) => {
      set((state) => {
         const note = getNoteById(state, id);
         if (note && note.color !== color) {
           const oldColor = note.color;
           note.color = color;
           state.layoutNotesById[note.id] = extractLayoutNote(note);

           const entry: HistoryEntry<DomainPatch> = {
             id: crypto.randomUUID(),
             label: 'change-color',
             createdAt: Date.now(),
             undo: { type: 'update-fields', noteId: id, fields: { color: oldColor } },
             redo: { type: 'update-fields', noteId: id, fields: { color } },
           };
           state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
         }
      });
    },

    changeSelectedNotesColor: (color) => {
        set((state) => {
            const changes: Array<{ noteId: string; oldColor: string }> = [];

            state.selectedIds.forEach(id => {
                const note = getNoteById(state, id);
                if (!note || note.deletedAt) return;
                if (note.color === color) return;

                changes.push({ noteId: id, oldColor: note.color });
                note.color = color;
                state.layoutNotesById[note.id] = extractLayoutNote(note);
            });

            if (changes.length === 0) return;

            const entry: HistoryEntry<DomainPatch> = {
                id: crypto.randomUUID(),
                label: 'change-selected-color',
                createdAt: Date.now(),
                undo: {
                    type: 'compound-patch',
                    patches: changes.map(({ noteId, oldColor }) => ({
                        type: 'update-fields' as const,
                        noteId,
                        fields: { color: oldColor },
                    })),
                },
                redo: {
                    type: 'compound-patch',
                    patches: changes.map(({ noteId }) => ({
                        type: 'update-fields' as const,
                        noteId,
                        fields: { color },
                    })),
                },
            };
            state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
        });
    },

    toggleCollapse: (id, options = {}) => {
      set((state) => {
        const note = getNoteById(state, id);
        if (note) {
          const oldCollapsed = note.collapsed ?? false;
          note.collapsed = !oldCollapsed;

          if (options.recordHistory === false) return;

          const entry: HistoryEntry<DomainPatch> = {
            id: crypto.randomUUID(),
            label: 'toggle-collapse',
            createdAt: Date.now(),
            undo: { type: 'update-fields', noteId: id, fields: { collapsed: oldCollapsed } },
            redo: { type: 'update-fields', noteId: id, fields: { collapsed: !oldCollapsed } },
          };
          state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
        }
      });
    },

    commitNoteTextEdit: (noteId, beforeTitle, beforeContent, beforeUpdatedAt) => {
      set((state) => {
        const note = getNoteById(state, noteId);
        if (!note) return;

        if (note.title === beforeTitle && note.content === beforeContent) return;

        const entry: HistoryEntry<DomainPatch> = {
          id: crypto.randomUUID(),
          label: 'edit-text',
          createdAt: Date.now(),
          undo: { type: 'update-fields', noteId, fields: { title: beforeTitle, content: beforeContent, updatedAt: beforeUpdatedAt } },
          redo: { type: 'update-fields', noteId, fields: { title: note.title, content: note.content, updatedAt: note.updatedAt } },
        };
        state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
      });
    },

    commitNoteEditingSize: (noteId, newWidth, newHeight, beforeResize) => {
      set((state) => {
        const note = getNoteById(state, noteId);
        if (!note || note.deletedAt) return;

        const clampedWidth = Math.max(LAYOUT.NOTE_MIN_WIDTH, newWidth);
        const clampedHeight = Math.max(LAYOUT.NOTE_MIN_HEIGHT, newHeight);

        const effectiveStartWidth = Math.max(LAYOUT.NOTE_MIN_WIDTH, beforeResize.renderedWidth);
        const effectiveStartHeight = Math.max(LAYOUT.NOTE_MIN_HEIGHT, beforeResize.renderedHeight);

        if (clampedWidth === effectiveStartWidth && clampedHeight === effectiveStartHeight) return;

        const updatedAt = Date.now();
        note.editingWidth = clampedWidth;
        note.editingHeight = clampedHeight;
        note.updatedAt = updatedAt;

        const entry: HistoryEntry<DomainPatch> = {
          id: crypto.randomUUID(),
          label: 'resize-editing-size',
          createdAt: updatedAt,
          undo: { type: 'update-fields', noteId, fields: { editingWidth: beforeResize.editingWidth, editingHeight: beforeResize.editingHeight, updatedAt: beforeResize.updatedAt } },
          redo: { type: 'update-fields', noteId, fields: { editingWidth: clampedWidth, editingHeight: clampedHeight, updatedAt } },
        };
        state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
      });
    },

    addImageNotesBatch: (inputs) => {
      if (inputs.length === 0) {
        return [];
      }

      const boardId = get().currentBoardId;
      const createdAt = Date.now();
      const startZ = get().config.maxZ;
      const createdIds = inputs.map(() => crypto.randomUUID());

      set((state) => {
        inputs.forEach((input, index) => {
          const { editingWidth, editingHeight } = computeImageNoteSize(input.originalWidth, input.originalHeight);
          const newNote: Note = {
            id: createdIds[index],
            kind: 'image',
            boardId,
            title: input.attachment.filename,
            content: '',
            x: input.x,
            y: input.y,
            z: startZ + index + 1,
            color: NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)],
            collapsed: false,
            editingWidth,
            editingHeight,
            createdAt,
            updatedAt: createdAt,
            attachments: [{ ...input.attachment }],
          };

          appendNoteToNormalizedState(state, newNote);
        });

        state.config.maxZ += inputs.length;
        state.selectedIds = createdIds;
        state.recentlyCreatedIds = createdIds;
        assignNoteHighlights(state, createdIds, 'created');

        const createdNotes = createdIds
          .map((id) => state.notesById[id])
          .filter((n): n is Note => n !== undefined);

        const entry: HistoryEntry<DomainPatch> = {
          id: crypto.randomUUID(),
            label: 'create-image-notes',
          createdAt: Date.now(),
          undo: {
            type: 'compound-patch',
            patches: createdNotes.map((n) => ({ type: 'remove-note' as const, noteId: n.id })),
          },
          redo: {
            type: 'compound-patch',
            patches: createdNotes.map((n) => ({ type: 'add-note' as const, note: { ...n } })),
          },
        };
        state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
      });

      return createdIds;
    },

    captureMoveSnapshot: (positions) => {
      for (const [id, pos] of Object.entries(positions)) {
        pendingMoveSnapshots.set(id, pos);
      }
    },

    undoDomainChange: () => {
      const currentHistory = get().domainHistory;
      const result = undoHistory(currentHistory);
      if (!result.entry) return false;

      const currentDomain = extractDomainSlice(get());
      const patched = applyDomainPatch(currentDomain, result.entry.undo);

      if (patched === currentDomain) return false;

      const removedIds = new Set(
        Object.keys(currentDomain.notesById).filter((id) => !patched.notesById[id]),
      );
      const navigationPatch = buildAffectedNoteNavigationPatch(
        result.entry.undo,
        currentDomain,
        patched.notesById,
        currentDomain.currentBoardId,
        get().viewport,
      );

      set((state) => {
        Object.assign(state, patched);
        state.domainHistory = toMutableHistoryStack(result.stack);
        if (removedIds.size > 0) {
          clearDanglingNoteUiRefs(state, removedIds);
        }
        Object.assign(state, navigationPatch);
      });

      return true;
    },

    redoDomainChange: () => {
      const currentHistory = get().domainHistory;
      const result = redoHistory(currentHistory);
      if (!result.entry) return false;

      const currentDomain = extractDomainSlice(get());
      const patched = applyDomainPatch(currentDomain, result.entry.redo);

      if (patched === currentDomain) return false;

      const removedIds = new Set(
        Object.keys(currentDomain.notesById).filter((id) => !patched.notesById[id]),
      );
      const navigationPatch = buildAffectedNoteNavigationPatch(
        result.entry.redo,
        currentDomain,
        patched.notesById,
        currentDomain.currentBoardId,
        get().viewport,
      );

      set((state) => {
        Object.assign(state, patched);
        state.domainHistory = toMutableHistoryStack(result.stack);
        if (removedIds.size > 0) {
          clearDanglingNoteUiRefs(state, removedIds);
        }
        Object.assign(state, navigationPatch);
      });

      return true;
    },

    clearDomainHistory: () => {
      set((state) => {
        state.domainHistory = toMutableHistoryStack(
          clearDomainHistoryFn(state.domainHistory),
        );
      });
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
            const currentBoardNotes = getBoardNotes(state, state.currentBoardId);
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

        const deletedAt = Date.now();

        set((state) => {
            const snapshots: Array<{ id: string }> = [];

            selectedIds.forEach((id) => {
                const note = state.notesById[id];
                if (!note || note.deletedAt) return;

                snapshots.push({ id });
                note.deletedAt = deletedAt;
                state.layoutNotesById[note.id] = extractLayoutNote(note);
                clearTransientNoteState(state, note.id);
            });

            state.selectedIds = [];

            if (snapshots.length === 0) return;

            const entry: HistoryEntry<DomainPatch> = {
                id: crypto.randomUUID(),
                label: 'soft-delete-selected',
                createdAt: Date.now(),
                undo: {
                    type: 'compound-patch',
                    patches: snapshots.map(({ id }) => ({
                        type: 'update-fields' as const,
                        noteId: id,
                        fields: { deletedAt: null as number | null },
                    })),
                },
                redo: {
                    type: 'compound-patch',
                    patches: snapshots.map(({ id }) => ({
                        type: 'update-fields' as const,
                        noteId: id,
                        fields: { deletedAt },
                    })),
                },
            };
            state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
        });
    },

    duplicateNote: (id) => {
        set((state) => {
            const note = getNoteById(state, id);
            if (note) {
                const timestamp = Date.now();
                const newNote: Note = {
                    ...note,
                    id: crypto.randomUUID(),
                    x: note.x + 20,
                    y: note.y + 20,
                    z: state.config.maxZ + 1,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                };
                appendNoteToNormalizedState(state, newNote);
                state.config.maxZ += 1;

                const entry: HistoryEntry<DomainPatch> = {
                    id: crypto.randomUUID(),
                    label: 'duplicate-note',
                    createdAt: Date.now(),
                    undo: { type: 'remove-note', noteId: newNote.id },
                    redo: { type: 'add-note', note: { ...newNote } },
                };
                state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
            }
        });
    },

    duplicateSelectedNotes: () => {
        set((state) => {
            const { selectedIds } = state;
            if (selectedIds.length === 0) return;
            
            const newSelectedIds: string[] = [];
            const createdNotes: Note[] = [];
            const timestamp = Date.now();

            selectedIds.forEach(id => {
                const note = getNoteById(state, id);
                if (note) {
                    const newNote: Note = {
                        ...note,
                        id: crypto.randomUUID(),
                        x: note.x + 20,
                        y: note.y + 20,
                        z: state.config.maxZ + 1,
                        createdAt: timestamp,
                        updatedAt: timestamp,
                    };
                    appendNoteToNormalizedState(state, newNote);
                    state.config.maxZ += 1;
                    newSelectedIds.push(newNote.id);
                    createdNotes.push({ ...newNote });
                }
            });

            if (newSelectedIds.length > 0) {
                state.selectedIds = newSelectedIds;

                const entry: HistoryEntry<DomainPatch> = {
                    id: crypto.randomUUID(),
                    label: 'duplicate-selected-notes',
                    createdAt: Date.now(),
                    undo: {
                        type: 'compound-patch',
                        patches: createdNotes.map((note) => ({ type: 'remove-note' as const, noteId: note.id })),
                    },
                    redo: {
                        type: 'compound-patch',
                        patches: createdNotes.map((note) => ({ type: 'add-note' as const, note })),
                    },
                };
                state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
            }
        });
    },

    moveNoteToBoard: (id, targetBoardId) => {
        set((state) => {
            const note = getNoteById(state, id);
            if (note) {
                const oldBoardId = note.boardId;
                const oldX = note.x;
                const oldY = note.y;
                const oldUpdatedAt = note.updatedAt;
                moveNoteBetweenBoards(state, id, targetBoardId);
                note.x += Math.floor(Math.random() * 20);
                note.y += Math.floor(Math.random() * 20);
                state.layoutNotesById[note.id] = extractLayoutNote(note);
                state.selectedIds = state.selectedIds.filter(selId => selId !== id);

                const entry: HistoryEntry<DomainPatch> = {
                    id: crypto.randomUUID(),
                    label: 'move-note-to-board',
                    createdAt: Date.now(),
                    undo: {
                        type: 'compound-patch',
                        patches: [
                            { type: 'update-fields', noteId: id, fields: { boardId: oldBoardId } },
                            { type: 'update-position', noteId: id, x: oldX, y: oldY, updatedAt: oldUpdatedAt },
                        ],
                    },
                    redo: {
                        type: 'compound-patch',
                        patches: [
                            { type: 'update-fields', noteId: id, fields: { boardId: note.boardId } },
                            { type: 'update-position', noteId: id, x: note.x, y: note.y, updatedAt: note.updatedAt },
                        ],
                    },
                };
                state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
            }
        });
    },

    copyNoteToBoard: (id, targetBoardId) => {
        set((state) => {
            const note = getNoteById(state, id);
            if (note) {
                const timestamp = Date.now();
                const newNote: Note = {
                    ...note,
                    id: crypto.randomUUID(),
                    boardId: targetBoardId,
                    z: state.config.maxZ + 1,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                };
                newNote.x += Math.floor(Math.random() * 20);
                newNote.y += Math.floor(Math.random() * 20);
                appendNoteToNormalizedState(state, newNote);
                state.layoutNotesById[newNote.id] = extractLayoutNote(newNote);
                state.config.maxZ += 1;

                const entry: HistoryEntry<DomainPatch> = {
                    id: crypto.randomUUID(),
                    label: 'copy-note-to-board',
                    createdAt: Date.now(),
                    undo: { type: 'remove-note', noteId: newNote.id },
                    redo: { type: 'add-note', note: { ...newNote } },
                };
                state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
            }
        });
    },

    moveSelectedNotesToBoard: (targetBoardId) => {
        set((state) => {
            const { selectedIds } = state;
            if (selectedIds.length === 0) return;

            const changes: Array<{
                id: string;
                oldBoardId: string;
                oldX: number;
                oldY: number;
                oldUpdatedAt: number;
                newBoardId: string;
                newX: number;
                newY: number;
                newUpdatedAt: number;
            }> = [];
            selectedIds.forEach((id) => {
                const note = state.notesById[id];
                if (note) {
                    const oldBoardId = note.boardId;
                    const oldX = note.x;
                    const oldY = note.y;
                    const oldUpdatedAt = note.updatedAt;
                    moveNoteBetweenBoards(state, id, targetBoardId);
                    note.x += Math.floor(Math.random() * 30);
                    note.y += Math.floor(Math.random() * 30);
                    state.layoutNotesById[note.id] = extractLayoutNote(note);
                    changes.push({
                        id,
                        oldBoardId,
                        oldX,
                        oldY,
                        oldUpdatedAt,
                        newBoardId: note.boardId,
                        newX: note.x,
                        newY: note.y,
                        newUpdatedAt: note.updatedAt,
                    });
                }
            });

            if (changes.length > 0) {
                state.selectedIds = [];

                const entry: HistoryEntry<DomainPatch> = {
                    id: crypto.randomUUID(),
                    label: 'move-selected-notes-to-board',
                    createdAt: Date.now(),
                    undo: {
                        type: 'compound-patch',
                        patches: changes.flatMap(({ id, oldBoardId, oldX, oldY, oldUpdatedAt }) => [
                            { type: 'update-fields' as const, noteId: id, fields: { boardId: oldBoardId } },
                            { type: 'update-position' as const, noteId: id, x: oldX, y: oldY, updatedAt: oldUpdatedAt },
                        ]),
                    },
                    redo: {
                        type: 'compound-patch',
                        patches: changes.flatMap(({ id, newBoardId, newX, newY, newUpdatedAt }) => [
                            { type: 'update-fields' as const, noteId: id, fields: { boardId: newBoardId } },
                            { type: 'update-position' as const, noteId: id, x: newX, y: newY, updatedAt: newUpdatedAt },
                        ]),
                    },
                };
                state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
            }
        });
    },

    copySelectedNotesToBoard: (targetBoardId) => {
        set((state) => {
            const { selectedIds } = state;
            if (selectedIds.length === 0) return;

            const createdNotes: Note[] = [];
            const timestamp = Date.now();
            selectedIds.forEach(id => {
                const note = getNoteById(state, id);
                if (note) {
                    const newNote: Note = {
                        ...note,
                        id: crypto.randomUUID(),
                        boardId: targetBoardId,
                        z: state.config.maxZ + 1,
                        createdAt: timestamp,
                        updatedAt: timestamp,
                    };
                    newNote.x += Math.floor(Math.random() * 30);
                    newNote.y += Math.floor(Math.random() * 30);
                    appendNoteToNormalizedState(state, newNote);
                    state.layoutNotesById[newNote.id] = extractLayoutNote(newNote);
                    state.config.maxZ += 1;
                    createdNotes.push({ ...newNote });
                }
            });

            if (createdNotes.length === 0) return;

            const entry: HistoryEntry<DomainPatch> = {
                id: crypto.randomUUID(),
                label: 'copy-selected-notes-to-board',
                createdAt: Date.now(),
                undo: {
                    type: 'compound-patch',
                    patches: createdNotes.map((note) => ({ type: 'remove-note' as const, noteId: note.id })),
                },
                redo: {
                    type: 'compound-patch',
                    patches: createdNotes.map((note) => ({ type: 'add-note' as const, note })),
                },
            };
            state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
        });
    },

    batchToggleCollapse: (ids) => {
        set((state) => {
            if (ids.length === 0) return;
            
            const collapsedCount = ids.filter(id => {
                const note = state.notesById[id];
                return note?.collapsed;
            }).length;
            
            const shouldExpand = collapsedCount >= ids.length / 2;
            
            const changes: Array<{ noteId: string; oldCollapsed: boolean; newCollapsed: boolean }> = [];
            ids.forEach(id => {
                const note = state.notesById[id];
                if (note) {
                    const oldCollapsed = note.collapsed ?? false;
                    const newCollapsed = shouldExpand ? false : true;
                    if (oldCollapsed === newCollapsed) return;
                    note.collapsed = newCollapsed;
                    changes.push({ noteId: id, oldCollapsed, newCollapsed });
                }
            });

            if (changes.length === 0) return;

            const entry: HistoryEntry<DomainPatch> = {
                id: crypto.randomUUID(),
                label: 'batch-toggle-collapse',
                createdAt: Date.now(),
                undo: {
                    type: 'compound-patch',
                    patches: changes.map(({ noteId, oldCollapsed }) => ({
                        type: 'update-fields' as const,
                        noteId,
                        fields: { collapsed: oldCollapsed },
                    })),
                },
                redo: {
                    type: 'compound-patch',
                    patches: changes.map(({ noteId, newCollapsed }) => ({
                        type: 'update-fields' as const,
                        noteId,
                        fields: { collapsed: newCollapsed },
                    })),
                },
            };
            state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
        });
    },

    batchBringToFront: (ids) => {
        set((state) => {
            if (ids.length === 0) return;
            
            const notesWithZ = ids
                .map(id => ({ id, z: state.notesById[id]?.z ?? 0 }))
                .sort((a, b) => a.z - b.z);
            
            let currentMaxZ = state.config.maxZ;
            const changes: Array<{ noteId: string; oldZ: number; newZ: number }> = [];

            notesWithZ.forEach(({ id }) => {
                const note = state.notesById[id];
                if (note) {
                    const oldZ = note.z;
                    currentMaxZ += 1;
                    note.z = currentMaxZ;
                    changes.push({ noteId: id, oldZ, newZ: note.z });
                }
            });

            state.config.maxZ = currentMaxZ;

            if (changes.length === 0) return;

            const entry: HistoryEntry<DomainPatch> = {
                id: crypto.randomUUID(),
                label: 'batch-bring-to-front',
                createdAt: Date.now(),
                undo: {
                    type: 'compound-patch',
                    patches: changes.map(({ noteId, oldZ }) => ({ type: 'update-fields' as const, noteId, fields: { z: oldZ } })),
                },
                redo: {
                    type: 'compound-patch',
                    patches: changes.map(({ noteId, newZ }) => ({ type: 'update-fields' as const, noteId, fields: { z: newZ } })),
                },
            };
            state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
        });
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
            const changes: Array<{ noteId: string; oldZ: number; newZ: number }> = [];

            notesWithZ.forEach(({ id }) => {
                const note = state.notesById[id];
                if (note) {
                    const oldZ = note.z;
                    currentMinZ += 1;
                    note.z = currentMinZ;
                    changes.push({ noteId: id, oldZ, newZ: note.z });
                }
            });

            if (changes.length === 0) return;

            const entry: HistoryEntry<DomainPatch> = {
                id: crypto.randomUUID(),
                label: 'batch-send-to-back',
                createdAt: Date.now(),
                undo: {
                    type: 'compound-patch',
                    patches: changes.map(({ noteId, oldZ }) => ({ type: 'update-fields' as const, noteId, fields: { z: oldZ } })),
                },
                redo: {
                    type: 'compound-patch',
                    patches: changes.map(({ noteId, newZ }) => ({ type: 'update-fields' as const, noteId, fields: { z: newZ } })),
                },
            };
            state.domainHistory = toMutableHistoryStack(pushHistoryEntry(get().domainHistory, entry));
        });
    },

    reorderBoard: (boardId, direction) => {
        set((state) => {
            const index = state.boards.findIndex(b => b.id === boardId);
            if (index === -1) return;

            const newIndex = direction === 'left' ? index - 1 : index + 1;
            
            if (newIndex < 0 || newIndex >= state.boards.length) return;

            const temp = state.boards[index];
            state.boards[index] = state.boards[newIndex];
            state.boards[newIndex] = temp;
        });
    },

    saveToDisk: async () => {
      const currentState = get();
      const { saveGenerationId } = currentState;
      const storageData = serializeState(currentState);
      const currentGen = saveGenerationId + 1;
      set({ isSaving: true, saveStatus: 'saving', saveError: null, saveGenerationId: currentGen });

      if (hasInvalidStorageContract(storageData)) {
        if (get().saveGenerationId === currentGen) {
          set({
            isSaving: false,
            saveStatus: 'error',
            saveError: '检测到无效存储数据，已阻止覆盖本地存储。',
          });
        }
        return false;
      }

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
        const service = createDataTransferService({
            getState: get, set, denormalizeNotes, normalizeNotes, createLayoutNotesById,
            appendNoteToNormalizedState, normalizeStorageDataMetadata,
            saveToDisk: get().saveToDisk, saveWAL: db.saveWAL, openFile, saveFile,
        });
        await service.exportBoard(boardId);
    },

    exportCurrentBoard: async () => {
        const service = createDataTransferService({
            getState: get, set, denormalizeNotes, normalizeNotes, createLayoutNotesById,
            appendNoteToNormalizedState, normalizeStorageDataMetadata,
            saveToDisk: get().saveToDisk, saveWAL: db.saveWAL, openFile, saveFile,
        });
        await service.exportCurrentBoard();
    },

    exportAll: async () => {
        const service = createDataTransferService({
            getState: get, set, denormalizeNotes, normalizeNotes, createLayoutNotesById,
            appendNoteToNormalizedState, normalizeStorageDataMetadata,
            saveToDisk: get().saveToDisk, saveWAL: db.saveWAL, openFile, saveFile,
        });
        await service.exportAll();
    },

    exportSelectedNotes: async () => {
        const service = createDataTransferService({
            getState: get, set, denormalizeNotes, normalizeNotes, createLayoutNotesById,
            appendNoteToNormalizedState, normalizeStorageDataMetadata,
            saveToDisk: get().saveToDisk, saveWAL: db.saveWAL, openFile, saveFile,
        });
        await service.exportSelectedNotes();
    },

    importFromFile: async () => {
        const service = createDataTransferService({
            getState: get, set, denormalizeNotes, normalizeNotes, createLayoutNotesById,
            appendNoteToNormalizedState, normalizeStorageDataMetadata,
            saveToDisk: get().saveToDisk, saveWAL: db.saveWAL, openFile, saveFile,
        });
        return service.importFromFile();
    },

    setThemeMode: (mode) => {
        set((state) => {
            state.config.themeMode = mode;
        });

        const isSystemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const shouldBeDark = mode === 'dark' || (mode === 'system' && isSystemDark);

        if (shouldBeDark) {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }

        localStorage.setItem('theme', mode);
    },
  }))
);

// useStore 已导出后再加载 uiStore，循环安全；绑定薄委托
const { useUIStore } = await import('./uiStore');
uiSetViewModeRef = (mode) => {
  useUIStore.getState().setViewMode(mode);
};

