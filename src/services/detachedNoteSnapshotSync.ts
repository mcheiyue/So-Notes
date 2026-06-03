import { emitTo } from '@tauri-apps/api/event';
import { useStore } from '../store/useStore';
import type { DetachedNoteSnapshot } from '../types/detachedNoteSnapshot';
import { DETACHED_NOTE_EVENTS } from '../types/detachedNoteSnapshot';

const SNAPSHOT_THROTTLE_MS = 100;

const detachedNoteLabel = (noteId: string): string =>
  `detached-note-${noteId}`;

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
let unsubscribe: (() => void) | null = null;

const clearPendingTimer = (noteId: string): void => {
  const timer = pendingTimers.get(noteId);
  if (timer !== undefined) {
    clearTimeout(timer);
    pendingTimers.delete(noteId);
  }
};

const clearAllPendingTimers = (): void => {
  for (const timer of pendingTimers.values()) {
    clearTimeout(timer);
  }
  pendingTimers.clear();
};

const emitSnapshot = (noteId: string, snapshot: DetachedNoteSnapshot): Promise<void> =>
  emitTo(detachedNoteLabel(noteId), DETACHED_NOTE_EVENTS.SNAPSHOT, snapshot).catch(() => undefined);

const emitMissing = (noteId: string): Promise<void> =>
  emitTo(detachedNoteLabel(noteId), DETACHED_NOTE_EVENTS.MISSING, { noteId }).catch(() => undefined);

const syncDetachedNote = (noteId: string, note: { title: string; content: string; color: string; collapsed?: boolean; deletedAt?: number | null } | undefined): void => {
  if (!note || note.deletedAt) {
    clearPendingTimer(noteId);
    emitMissing(noteId);
    return;
  }

  clearPendingTimer(noteId);

  const timer = setTimeout(() => {
    pendingTimers.delete(noteId);
    const snapshot: DetachedNoteSnapshot = {
      noteId,
      title: note.title,
      content: note.content,
      color: note.color,
      isCollapsed: note.collapsed ?? false,
      deletedAt: note.deletedAt,
    };
    emitSnapshot(noteId, snapshot);
  }, SNAPSHOT_THROTTLE_MS);

  pendingTimers.set(noteId, timer);
};

const syncAllDetachedNotes = (): void => {
  const { notesById, detachedNotes } = useStore.getState();

  for (const entry of detachedNotes) {
    const note = notesById[entry.noteId];
    syncDetachedNote(entry.noteId, note);
  }
};

export const startDetachedNoteSnapshotSync = (): (() => void) => {
  if (unsubscribe) {
    return stopDetachedNoteSnapshotSync;
  }

  unsubscribe = useStore.subscribe((state, prevState) => {
    if (state.detachedNotes === prevState.detachedNotes && state.notesById === prevState.notesById) {
      return;
    }
    syncAllDetachedNotes();
  });

  return stopDetachedNoteSnapshotSync;
};

export const stopDetachedNoteSnapshotSync = (): void => {
  unsubscribe?.();
  unsubscribe = null;
  clearAllPendingTimers();
};
