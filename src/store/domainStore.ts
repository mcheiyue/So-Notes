import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { AppConfig, Board, DEFAULT_BOARD, DEFAULT_CONFIG, LayoutNote, Note, NOTE_COLORS } from './types';
import { createEmptyNormalizedNotesState, createLayoutNotesById, extractLayoutNote, normalizeNotes } from './normalization';

export const DOMAIN_STORE_MODULE = 'domainStore';

interface BoardViewport {
  x: number;
  y: number;
}

interface AddNoteInput {
  x: number;
  y: number;
  content?: string;
  title?: string;
  boardId?: string;
  color?: string;
}

interface BatchNoteInput {
  x: number;
  y: number;
  content: string;
}

export type BoardReorderDirection = 'left' | 'right';

export interface DomainState {
  notesById: Record<string, Note>;
  allNoteIds: string[];
  boardNoteIds: Record<string, string[]>;
  layoutNotesById: Record<string, LayoutNote>;
  boards: Board[];
  currentBoardId: string;
  config: AppConfig;
}

export type DomainPersistenceBridge = (state: DomainState) => void;

export interface DomainActions {
  replaceDomainState: (state: DomainState) => void;
  /** 桥单 note 镜像；内部 notify 持久化 */
  mirrorPatchNote: (note: Note, layout?: LayoutNote | null) => void;
  hydrateFromNotes: (notes: Note[], boards: Board[], currentBoardId: string, config: AppConfig) => void;
  setCurrentBoard: (boardId: string) => void;
  createBoard: (name: string, icon: string) => string;
  deleteBoard: (boardId: string) => void;
  updateBoard: (boardId: string, updates: Partial<Board>) => void;
  reorderBoard: (boardId: string, direction: BoardReorderDirection) => void;
  setBoardViewport: (boardId: string, viewport: BoardViewport) => void;
  addNote: (input: AddNoteInput) => string;
  addNotesWithContentBatch: (notes: BatchNoteInput[], boardId?: string) => string[];
  updateTitle: (id: string, title: string) => void;
  updateNote: (id: string, content: string) => void;
  moveNote: (id: string, x: number, y: number) => void;
  moveNotes: (ids: string[], dx: number, dy: number, excludeId?: string) => void;
  finalizeLayoutChange: (noteIds: string[]) => void;
  bringToFront: (id: string) => void;
  softDeleteNote: (id: string) => void;
  softDeleteNotes: (ids: string[]) => void;
  restoreNote: (id: string) => void;
  restoreNotes: (ids: string[]) => void;
  deleteNotePermanently: (id: string) => void;
  deleteNotesPermanently: (ids: string[]) => void;
  emptyTrash: () => void;
  changeColor: (id: string, color: string) => void;
  changeNotesColor: (ids: string[], color: string) => void;
  toggleCollapse: (id: string) => void;
  batchToggleCollapse: (ids: string[]) => void;
  duplicateNote: (id: string) => string | null;
  duplicateNotes: (ids: string[]) => string[];
  moveNoteToBoard: (id: string, targetBoardId: string) => void;
  moveNotesToBoard: (ids: string[], targetBoardId: string) => void;
  copyNoteToBoard: (id: string, targetBoardId: string) => string | null;
  copyNotesToBoard: (ids: string[], targetBoardId: string) => string[];
  batchBringToFront: (ids: string[]) => void;
  batchSendToBack: (ids: string[]) => void;
}

export type DomainStoreState = DomainState & DomainActions;

export const createInitialDomainState = (): DomainState => ({
  ...createEmptyNormalizedNotesState(),
  layoutNotesById: {},
  boards: [{ ...DEFAULT_BOARD }],
  currentBoardId: DEFAULT_BOARD.id,
  config: { ...DEFAULT_CONFIG },
});

let domainPersistenceBridge: DomainPersistenceBridge | null = null;

export const setDomainPersistenceBridge = (bridge: DomainPersistenceBridge | null): (() => void) => {
  domainPersistenceBridge = bridge;

  return () => {
    if (domainPersistenceBridge === bridge) {
      domainPersistenceBridge = null;
    }
  };
};

const toDomainState = (state: DomainState): DomainState => ({
  notesById: state.notesById,
  allNoteIds: state.allNoteIds,
  boardNoteIds: state.boardNoteIds,
  layoutNotesById: state.layoutNotesById,
  boards: state.boards,
  currentBoardId: state.currentBoardId,
  config: state.config,
});

const notifyPersistenceBridge = (state: DomainState) => {
  domainPersistenceBridge?.(toDomainState(state));
};

const getBoardNoteIds = (state: DomainState, boardId: string): string[] => state.boardNoteIds[boardId] ?? [];

const getNoteById = (state: DomainState, id: string): Note | undefined => state.notesById[id];

const ensureBoardNoteBucket = (state: DomainState, boardId: string): string[] => {
  if (!state.boardNoteIds[boardId]) {
    state.boardNoteIds[boardId] = [];
  }

  return state.boardNoteIds[boardId];
};

const appendNoteToDomainState = (state: DomainState, note: Note) => {
  state.notesById[note.id] = note;
  state.allNoteIds.push(note.id);
  ensureBoardNoteBucket(state, note.boardId).push(note.id);
  state.layoutNotesById[note.id] = extractLayoutNote(note);
};

const removeNoteIdFromBoard = (state: DomainState, boardId: string, noteId: string) => {
  const boardIds = state.boardNoteIds[boardId];
  if (!boardIds) {
    return;
  }

  state.boardNoteIds[boardId] = boardIds.filter((id) => id !== noteId);

  if (state.boardNoteIds[boardId].length === 0) {
    delete state.boardNoteIds[boardId];
  }
};

const removeNoteFromDomainState = (state: DomainState, noteId: string) => {
  const note = state.notesById[noteId];
  if (!note) {
    return;
  }

  removeNoteIdFromBoard(state, note.boardId, noteId);
  delete state.notesById[noteId];
  state.allNoteIds = state.allNoteIds.filter((id) => id !== noteId);
  delete state.layoutNotesById[noteId];
};

const moveNoteBetweenBoards = (state: DomainState, noteId: string, targetBoardId: string) => {
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

const resolveTargetBoardId = (state: DomainState, boardId?: string): string => {
  if (boardId && state.boards.some((board) => board.id === boardId)) {
    return boardId;
  }

  return state.currentBoardId;
};

const chooseNoteColor = (color?: string): string => color ?? NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)];

const createDomainNote = (state: DomainState, input: AddNoteInput, id: string, createdAt: number, z: number): Note => ({
  id,
  kind: 'text',
  boardId: resolveTargetBoardId(state, input.boardId),
  title: input.title ?? '',
  content: input.content ?? '',
  x: input.x,
  y: input.y,
  z,
  color: chooseNoteColor(input.color),
  collapsed: false,
  createdAt,
  updatedAt: createdAt,
});

const recalculateMaxZ = (state: DomainState) => {
  const maxNoteZ = Math.max(...Object.values(state.notesById).map((note) => note.z || 0), 0);
  state.config.maxZ = Math.max(state.config.maxZ, maxNoteZ, state.allNoteIds.length);
};

// ponytail: single write body for useStore + domainStore. History stays in useStore.
export const applyAddNote = (
  state: DomainState,
  input: AddNoteInput,
  id: string,
  createdAt: number,
): Note => {
  const nextZ = state.config.maxZ + 1;
  const note = createDomainNote(state, input, id, createdAt, nextZ);
  appendNoteToDomainState(state, note);
  state.config.maxZ = nextZ;
  return note;
};

export const applyAddNotesWithContentBatch = (
  state: DomainState,
  notes: readonly BatchNoteInput[],
  ids: readonly string[],
  createdAt: number,
  boardId?: string,
): Note[] => {
  const targetBoardId = resolveTargetBoardId(state, boardId);
  const startZ = state.config.maxZ;
  const created: Note[] = [];
  notes.forEach((note, index) => {
    const noteId = ids[index];
    if (!noteId) {
      return;
    }

    const newNote = createDomainNote(state, { ...note, boardId: targetBoardId }, noteId, createdAt, startZ + index + 1);
    appendNoteToDomainState(state, newNote);
    created.push(newNote);
  });
  state.config.maxZ += notes.length;
  return created;
};

export const applyUpdateTitle = (state: DomainState, id: string, title: string): boolean => {
  const note = getNoteById(state, id);
  if (!note) {
    return false;
  }

  note.title = title;
  note.updatedAt = Date.now();
  return true;
};

export const applyUpdateNote = (state: DomainState, id: string, content: string): boolean => {
  const note = getNoteById(state, id);
  if (!note) {
    return false;
  }

  note.content = content;
  note.updatedAt = Date.now();
  return true;
};

export const applyMoveNote = (state: DomainState, id: string, x: number, y: number): boolean => {
  const note = getNoteById(state, id);
  if (!note) {
    return false;
  }

  note.x = x;
  note.y = y;
  state.layoutNotesById[note.id] = extractLayoutNote(note);
  return true;
};

export const applyMoveNotes = (
  state: DomainState,
  ids: readonly string[],
  dx: number,
  dy: number,
  excludeId?: string,
): boolean => {
  let changed = false;
  ids.forEach((id) => {
    if (id === excludeId) {
      return;
    }

    const note = getNoteById(state, id);
    if (!note) {
      return;
    }

    note.x += dx;
    note.y += dy;
    state.layoutNotesById[note.id] = extractLayoutNote(note);
    changed = true;
  });
  return changed;
};

export const applyFinalizeLayoutChange = (
  state: DomainState,
  noteIds: readonly string[],
  timestamp: number,
): boolean => {
  let changed = false;
  noteIds.forEach((id) => {
    const note = getNoteById(state, id);
    if (!note) {
      return;
    }

    note.updatedAt = timestamp;
    changed = true;
  });
  return changed;
};

export const applySoftDeleteNotes = (
  state: DomainState,
  ids: readonly string[],
  deletedAt: number,
): string[] => {
  const deletedIds: string[] = [];
  ids.forEach((id) => {
    const note = getNoteById(state, id);
    if (!note || note.deletedAt) {
      return;
    }

    note.deletedAt = deletedAt;
    state.layoutNotesById[note.id] = extractLayoutNote(note);
    deletedIds.push(id);
  });
  return deletedIds;
};

export const applyDeleteNotesPermanently = (state: DomainState, ids: readonly string[]): string[] => {
  const removedIds: string[] = [];
  ids.forEach((id) => {
    if (!state.notesById[id]) {
      return;
    }

    removeNoteFromDomainState(state, id);
    removedIds.push(id);
  });
  return removedIds;
};

export const domainSelectors = {
  noteById: (state: DomainState, noteId: string): Note | undefined => state.notesById[noteId],
  boardById: (state: DomainState, boardId: string): Board | undefined => state.boards.find((board) => board.id === boardId),
  currentBoard: (state: DomainState): Board | undefined => state.boards.find((board) => board.id === state.currentBoardId),
  currentBoardNotes: (state: DomainState): Note[] => {
    const noteIds = state.boardNoteIds[state.currentBoardId] ?? [];
    return noteIds.flatMap((noteId) => {
      const note = state.notesById[noteId];
      return note && !note.deletedAt ? [note] : [];
    });
  },
  trashNotes: (state: DomainState): Note[] => state.allNoteIds.flatMap((noteId) => {
    const note = state.notesById[noteId];
    return note?.deletedAt ? [note] : [];
  }),
  layoutNoteById: (state: DomainState, noteId: string): LayoutNote | undefined => state.layoutNotesById[noteId],
};

export const useDomainStore = create<DomainStoreState>()(
  immer((set, get) => ({
    ...createInitialDomainState(),

    replaceDomainState: (nextState) => {
      set((state) => {
        Object.assign(state, nextState);
      });
      notifyPersistenceBridge(get());
    },

    /** 桥：单 note 镜像写（须 notify，禁止裸 setState 漏持久化） */
    mirrorPatchNote: (note: Note, layout?: LayoutNote | null) => {
      set((state) => {
        state.notesById[note.id] = note;
        if (layout) {
          state.layoutNotesById[note.id] = layout;
        }
      });
      notifyPersistenceBridge(get());
    },

    hydrateFromNotes: (notes, boards, currentBoardId, config) => {
      set((state) => {
        const normalizedNotes = normalizeNotes(notes);
        state.notesById = normalizedNotes.notesById;
        state.allNoteIds = normalizedNotes.allNoteIds;
        state.boardNoteIds = normalizedNotes.boardNoteIds;
        state.layoutNotesById = createLayoutNotesById(normalizedNotes.notesById);
        state.boards = boards.length > 0 ? boards.map((board) => ({ ...board })) : [{ ...DEFAULT_BOARD }];
        state.currentBoardId = state.boards.some((board) => board.id === currentBoardId)
          ? currentBoardId
          : state.boards[0].id;
        state.config = { ...config };
        recalculateMaxZ(state);
      });
    },

    setCurrentBoard: (boardId) => {
      let changed = false;
      set((state) => {
        if (!state.boards.some((board) => board.id === boardId)) return;
        if (state.currentBoardId === boardId) return;

        state.currentBoardId = boardId;
        changed = true;
      });
      if (changed) notifyPersistenceBridge(get());
    },

    createBoard: (name, icon) => {
      const boardId = crypto.randomUUID();
      const newBoard: Board = { id: boardId, name, icon, createdAt: Date.now() };

      set((state) => {
        state.boards.push(newBoard);
        state.currentBoardId = boardId;
      });
      notifyPersistenceBridge(get());
      return boardId;
    },

    deleteBoard: (boardId) => {
      let changed = false;
      set((state) => {
        if (state.boards.length <= 1) return;
        if (!state.boards.some((board) => board.id === boardId)) return;

        const fallbackId = state.boards.find((board) => board.id !== boardId)?.id ?? DEFAULT_BOARD.id;
        getBoardNoteIds(state, boardId).forEach((noteId) => removeNoteFromDomainState(state, noteId));
        delete state.boardNoteIds[boardId];
        state.boards = state.boards.filter((board) => board.id !== boardId);
        if (state.currentBoardId === boardId) {
          state.currentBoardId = fallbackId;
        }
        changed = true;
      });
      if (changed) notifyPersistenceBridge(get());
    },

    updateBoard: (boardId, updates) => {
      let changed = false;
      set((state) => {
        const board = state.boards.find((candidate) => candidate.id === boardId);
        if (!board) return;

        Object.assign(board, updates);
        changed = true;
      });
      if (changed) notifyPersistenceBridge(get());
    },

    reorderBoard: (boardId, direction) => {
      let changed = false;
      set((state) => {
        const index = state.boards.findIndex((board) => board.id === boardId);
        if (index === -1) return;

        const nextIndex = direction === 'left' ? index - 1 : index + 1;
        if (nextIndex < 0 || nextIndex >= state.boards.length) return;

        const currentBoard = state.boards[index];
        state.boards[index] = state.boards[nextIndex];
        state.boards[nextIndex] = currentBoard;
        changed = true;
      });
      if (changed) notifyPersistenceBridge(get());
    },

    setBoardViewport: (boardId, viewport) => {
      let changed = false;
      set((state) => {
        const board = state.boards.find((candidate) => candidate.id === boardId);
        if (!board) return;

        board.viewport = viewport;
        changed = true;
      });
      if (changed) notifyPersistenceBridge(get());
    },

    addNote: (input) => {
      const id = crypto.randomUUID();
      const createdAt = Date.now();

      set((state) => {
        applyAddNote(state, input, id, createdAt);
      });
      notifyPersistenceBridge(get());
      return id;
    },

    addNotesWithContentBatch: (notes, boardId) => {
      const normalizedNotes = notes
        .map((note) => ({ ...note, content: note.content.trim() }))
        .filter((note) => note.content.length > 0);

      if (normalizedNotes.length === 0) {
        return [];
      }

      const ids = normalizedNotes.map(() => crypto.randomUUID());
      const createdAt = Date.now();

      set((state) => {
        applyAddNotesWithContentBatch(state, normalizedNotes, ids, createdAt, boardId);
      });
      notifyPersistenceBridge(get());
      return ids;
    },

    updateTitle: (id, title) => {
      let changed = false;
      set((state) => {
        changed = applyUpdateTitle(state, id, title);
      });
      if (changed) notifyPersistenceBridge(get());
    },

    updateNote: (id, content) => {
      let changed = false;
      set((state) => {
        changed = applyUpdateNote(state, id, content);
      });
      if (changed) notifyPersistenceBridge(get());
    },

    moveNote: (id, x, y) => {
      let changed = false;
      set((state) => {
        changed = applyMoveNote(state, id, x, y);
      });
      if (changed) notifyPersistenceBridge(get());
    },

    moveNotes: (ids, dx, dy, excludeId) => {
      let changed = false;
      set((state) => {
        changed = applyMoveNotes(state, ids, dx, dy, excludeId);
      });
      if (changed) notifyPersistenceBridge(get());
    },

    finalizeLayoutChange: (noteIds) => {
      const uniqueIds = [...new Set(noteIds)];
      if (uniqueIds.length === 0) return;

      const timestamp = Date.now();
      let changed = false;
      set((state) => {
        changed = applyFinalizeLayoutChange(state, uniqueIds, timestamp);
      });
      if (changed) notifyPersistenceBridge(get());
    },

    bringToFront: (id) => {
      let changed = false;
      set((state) => {
        const note = getNoteById(state, id);
        if (!note) return;

        state.config.maxZ += 1;
        note.z = state.config.maxZ;
        changed = true;
      });
      if (changed) notifyPersistenceBridge(get());
    },

    softDeleteNote: (id) => {
      get().softDeleteNotes([id]);
    },

    softDeleteNotes: (ids) => {
      const deletedAt = Date.now();
      let deletedIds: string[] = [];
      set((state) => {
        deletedIds = applySoftDeleteNotes(state, ids, deletedAt);
      });
      if (deletedIds.length > 0) notifyPersistenceBridge(get());
    },

    restoreNote: (id) => {
      get().restoreNotes([id]);
    },

    restoreNotes: (ids) => {
      let changed = false;
      set((state) => {
        ids.forEach((id) => {
          const note = getNoteById(state, id);
          if (!note || !note.deletedAt) return;

          note.deletedAt = null;
          if (!state.boards.some((board) => board.id === note.boardId)) {
            moveNoteBetweenBoards(state, id, state.currentBoardId);
          }
          state.config.maxZ += 1;
          note.z = state.config.maxZ;
          state.layoutNotesById[note.id] = extractLayoutNote(note);
          changed = true;
        });
      });
      if (changed) notifyPersistenceBridge(get());
    },

    deleteNotePermanently: (id) => {
      get().deleteNotesPermanently([id]);
    },

    deleteNotesPermanently: (ids) => {
      let removedIds: string[] = [];
      set((state) => {
        removedIds = applyDeleteNotesPermanently(state, ids);
      });
      if (removedIds.length > 0) notifyPersistenceBridge(get());
    },

    emptyTrash: () => {
      const trashIds = get().allNoteIds.filter((id) => get().notesById[id]?.deletedAt);
      get().deleteNotesPermanently(trashIds);
    },

    changeColor: (id, color) => {
      get().changeNotesColor([id], color);
    },

    changeNotesColor: (ids, color) => {
      let changed = false;
      set((state) => {
        ids.forEach((id) => {
          const note = getNoteById(state, id);
          if (!note) return;

          note.color = color;
          state.layoutNotesById[note.id] = extractLayoutNote(note);
          changed = true;
        });
      });
      if (changed) notifyPersistenceBridge(get());
    },

    toggleCollapse: (id) => {
      let changed = false;
      set((state) => {
        const note = getNoteById(state, id);
        if (!note) return;

        note.collapsed = !note.collapsed;
        changed = true;
      });
      if (changed) notifyPersistenceBridge(get());
    },

    batchToggleCollapse: (ids) => {
      if (ids.length === 0) return;

      let changed = false;
      set((state) => {
        const collapsedCount = ids.filter((id) => state.notesById[id]?.collapsed).length;
        const shouldExpand = collapsedCount >= ids.length / 2;

        ids.forEach((id) => {
          const note = getNoteById(state, id);
          if (!note) return;

          note.collapsed = shouldExpand ? false : true;
          changed = true;
        });
      });
      if (changed) notifyPersistenceBridge(get());
    },

    duplicateNote: (id) => {
      const newIds = get().duplicateNotes([id]);
      return newIds[0] ?? null;
    },

    duplicateNotes: (ids) => {
      const newIds: string[] = [];
      const createdAt = Date.now();
      set((state) => {
        ids.forEach((id) => {
          const note = getNoteById(state, id);
          if (!note) return;

          const newNote: Note = {
            ...note,
            id: crypto.randomUUID(),
            x: note.x + 20,
            y: note.y + 20,
            z: state.config.maxZ + 1,
            createdAt,
            updatedAt: createdAt,
          };
          appendNoteToDomainState(state, newNote);
          state.config.maxZ += 1;
          newIds.push(newNote.id);
        });
      });
      if (newIds.length > 0) notifyPersistenceBridge(get());
      return newIds;
    },

    moveNoteToBoard: (id, targetBoardId) => {
      get().moveNotesToBoard([id], targetBoardId);
    },

    moveNotesToBoard: (ids, targetBoardId) => {
      let changed = false;
      set((state) => {
        if (!state.boards.some((board) => board.id === targetBoardId)) return;

        ids.forEach((id) => {
          const note = getNoteById(state, id);
          if (!note) return;

          moveNoteBetweenBoards(state, id, targetBoardId);
          note.x += Math.floor(Math.random() * 30);
          note.y += Math.floor(Math.random() * 30);
          state.layoutNotesById[note.id] = extractLayoutNote(note);
          changed = true;
        });
      });
      if (changed) notifyPersistenceBridge(get());
    },

    copyNoteToBoard: (id, targetBoardId) => {
      const newIds = get().copyNotesToBoard([id], targetBoardId);
      return newIds[0] ?? null;
    },

    copyNotesToBoard: (ids, targetBoardId) => {
      const newIds: string[] = [];
      const createdAt = Date.now();
      set((state) => {
        if (!state.boards.some((board) => board.id === targetBoardId)) return;

        ids.forEach((id) => {
          const note = getNoteById(state, id);
          if (!note) return;

          const newNote: Note = {
            ...note,
            id: crypto.randomUUID(),
            boardId: targetBoardId,
            x: note.x + Math.floor(Math.random() * 30),
            y: note.y + Math.floor(Math.random() * 30),
            z: state.config.maxZ + 1,
            createdAt,
            updatedAt: createdAt,
          };
          appendNoteToDomainState(state, newNote);
          state.config.maxZ += 1;
          newIds.push(newNote.id);
        });
      });
      if (newIds.length > 0) notifyPersistenceBridge(get());
      return newIds;
    },

    batchBringToFront: (ids) => {
      let changed = false;
      set((state) => {
        const notesWithZ = ids
          .map((id) => ({ id, z: state.notesById[id]?.z ?? 0 }))
          .sort((a, b) => a.z - b.z);

        let currentMaxZ = state.config.maxZ;
        notesWithZ.forEach(({ id }) => {
          const note = getNoteById(state, id);
          if (!note) return;

          currentMaxZ += 1;
          note.z = currentMaxZ;
          changed = true;
        });
        state.config.maxZ = currentMaxZ;
      });
      if (changed) notifyPersistenceBridge(get());
    },

    batchSendToBack: (ids) => {
      let changed = false;
      set((state) => {
        const minZ = Math.min(...Object.values(state.notesById).map((note) => note.z), 0);
        const notesWithZ = ids
          .map((id) => ({ id, z: state.notesById[id]?.z ?? 0 }))
          .sort((a, b) => a.z - b.z);

        let currentMinZ = minZ - ids.length;
        notesWithZ.forEach(({ id }) => {
          const note = getNoteById(state, id);
          if (!note) return;

          currentMinZ += 1;
          note.z = currentMinZ;
          changed = true;
        });
      });
      if (changed) notifyPersistenceBridge(get());
    },
  })),
);
