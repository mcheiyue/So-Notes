import { create } from 'zustand';
import { AppConfig, Board, DEFAULT_BOARD, DEFAULT_CONFIG, LayoutNote, Note } from './types';
import { createEmptyNormalizedNotesState } from './normalization';

export const DOMAIN_STORE_MODULE = 'domainStore';

export interface DomainState {
  notesById: Record<string, Note>;
  allNoteIds: string[];
  boardNoteIds: Record<string, string[]>;
  layoutNotesById: Record<string, LayoutNote>;
  boards: Board[];
  currentBoardId: string;
  config: AppConfig;
}

export type DomainStoreState = DomainState;

export const createInitialDomainState = (): DomainState => ({
  ...createEmptyNormalizedNotesState(),
  layoutNotesById: {},
  boards: [DEFAULT_BOARD],
  currentBoardId: DEFAULT_BOARD.id,
  config: DEFAULT_CONFIG,
});

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

export const useDomainStore = create<DomainStoreState>(() => createInitialDomainState());
