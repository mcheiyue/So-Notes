/**
 * 单向桥：useStore domain 切片 → domainStore 镜像。
 * P0-07：单 note 热更新走 patch，禁止默认 clone+replaceDomainState 全表。
 * 低频（attach / boards / 结构变化）仍全表。退役条件见依赖地图（C-S11）。
 */
import { DomainState, useDomainStore } from './domainStore';
import { useStore } from './useStore';

export const LEGACY_DOMAIN_BRIDGE_MODULE = 'legacyDomainBridge';

type LegacyStoreState = ReturnType<typeof useStore.getState>;

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
  state: LegacyStoreState,
  previousState: LegacyStoreState,
): boolean => (
  state.notesById !== previousState.notesById ||
  state.allNoteIds !== previousState.allNoteIds ||
  state.boardNoteIds !== previousState.boardNoteIds ||
  state.layoutNotesById !== previousState.layoutNotesById ||
  state.boards !== previousState.boards ||
  state.currentBoardId !== previousState.currentBoardId ||
  state.config !== previousState.config
);

const collectChangedRecordIds = <TValue>(
  next: Record<string, TValue>,
  prev: Record<string, TValue>,
): readonly string[] | null => {
  const nextIds = Object.keys(next);
  if (nextIds.length !== Object.keys(prev).length) {
    return null;
  }

  const changed: string[] = [];
  for (const id of nextIds) {
    if (!Object.prototype.hasOwnProperty.call(prev, id)) {
      return null;
    }
    if (next[id] !== prev[id]) {
      changed.push(id);
      if (changed.length > 1) {
        return null;
      }
    }
  }
  return changed;
};

const resolveSingleNotePatchId = (
  state: LegacyStoreState,
  previousState: LegacyStoreState,
): string | null => {
  if (
    state.allNoteIds !== previousState.allNoteIds ||
    state.boardNoteIds !== previousState.boardNoteIds ||
    state.boards !== previousState.boards ||
    state.currentBoardId !== previousState.currentBoardId ||
    state.config !== previousState.config
  ) {
    return null;
  }

  const noteIds = state.notesById === previousState.notesById
    ? []
    : collectChangedRecordIds(state.notesById, previousState.notesById);
  const layoutIds = state.layoutNotesById === previousState.layoutNotesById
    ? []
    : collectChangedRecordIds(state.layoutNotesById, previousState.layoutNotesById);

  if (noteIds === null || layoutIds === null) {
    return null;
  }

  const changed = new Set([...noteIds, ...layoutIds]);
  if (changed.size !== 1) {
    return null;
  }

  const [noteId] = changed;
  return noteId ?? null;
};

const patchSingleNoteIntoDomainStore = (state: LegacyStoreState, noteId: string): boolean => {
  const note = state.notesById[noteId];
  const domainHasNote = Object.prototype.hasOwnProperty.call(
    useDomainStore.getState().notesById,
    noteId,
  );
  if (!note || !domainHasNote) {
    return false;
  }

  const layout = state.layoutNotesById[noteId];
  useDomainStore.getState().mirrorPatchNote(note, layout ?? null);
  return true;
};

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
    if (!hasLegacyDomainReferenceChanged(state, previousState)) {
      return;
    }

    const noteId = resolveSingleNotePatchId(state, previousState);
    if (noteId && patchSingleNoteIntoDomainStore(state, noteId)) {
      return;
    }

    syncLegacyDomainToDomainStore();
  });

  return detachLegacyDomainBridge;
};

attachLegacyDomainBridge();
