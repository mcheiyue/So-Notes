import { DomainState, useDomainStore } from './domainStore';
import { useStore } from './useStore';

export const LEGACY_DOMAIN_BRIDGE_MODULE = 'legacyDomainBridge';

let unsubscribeLegacyDomainBridge: (() => void) | null = null;

const cloneDomainState = (state: DomainState): DomainState => ({
  notesById: { ...state.notesById },
  allNoteIds: [...state.allNoteIds],
  boardNoteIds: Object.fromEntries(
    Object.entries(state.boardNoteIds).map(([boardId, noteIds]) => [boardId, [...noteIds]]),
  ),
  layoutNotesById: { ...state.layoutNotesById },
  boards: state.boards.map((board) => ({ ...board, viewport: board.viewport ? { ...board.viewport } : undefined })),
  currentBoardId: state.currentBoardId,
  config: { ...state.config },
});

const readLegacyDomainState = (): DomainState => {
  const state = useStore.getState();

  return cloneDomainState({
    notesById: state.notesById,
    allNoteIds: state.allNoteIds,
    boardNoteIds: state.boardNoteIds,
    layoutNotesById: state.layoutNotesById,
    boards: state.boards,
    currentBoardId: state.currentBoardId,
    config: state.config,
  });
};

const hasLegacyDomainReferenceChanged = (
  state: ReturnType<typeof useStore.getState>,
  previousState: ReturnType<typeof useStore.getState>,
): boolean => (
  state.notesById !== previousState.notesById ||
  state.allNoteIds !== previousState.allNoteIds ||
  state.boardNoteIds !== previousState.boardNoteIds ||
  state.layoutNotesById !== previousState.layoutNotesById ||
  state.boards !== previousState.boards ||
  state.currentBoardId !== previousState.currentBoardId ||
  state.config !== previousState.config
);

export const syncLegacyDomainToDomainStore = () => {
  useDomainStore.getState().replaceDomainState(readLegacyDomainState());
};

export const detachLegacyDomainBridge = () => {
  unsubscribeLegacyDomainBridge?.();
  unsubscribeLegacyDomainBridge = null;
};

export const attachLegacyDomainBridge = (): (() => void) => {
  if (unsubscribeLegacyDomainBridge) {
    return detachLegacyDomainBridge;
  }

  syncLegacyDomainToDomainStore();
  unsubscribeLegacyDomainBridge = useStore.subscribe((state, previousState) => {
    if (hasLegacyDomainReferenceChanged(state, previousState)) {
      syncLegacyDomainToDomainStore();
    }
  });

  return detachLegacyDomainBridge;
};

attachLegacyDomainBridge();
