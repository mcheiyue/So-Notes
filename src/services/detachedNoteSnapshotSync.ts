import { emitTo, listen } from '@tauri-apps/api/event';
import { useStore } from '../store/useStore';
import type { DetachedNoteReadyPayload, DetachedNoteSnapshot, DetachedNoteThemePayload } from '../types/detachedNoteSnapshot';
import { DETACHED_NOTE_EVENTS } from '../types/detachedNoteSnapshot';
import type { ThemeMode } from '../store/types';

const SNAPSHOT_THROTTLE_MS = 100;

const detachedNoteLabel = (noteId: string): string =>
  `detached-note-${noteId}`;

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
let unsubscribe: (() => void) | null = null;
let unlistenReadyPromise: Promise<() => void> | null = null;

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

const resolveIsDark = (themeMode: ThemeMode): boolean => {
  if (themeMode === 'dark') return true;
  if (themeMode === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
};

const buildThemePayload = (): DetachedNoteThemePayload => {
  const themeMode = useStore.getState().config.themeMode ?? 'system';
  return { themeMode, isDark: resolveIsDark(themeMode) };
};

const emitTheme = (noteId: string): Promise<void> =>
  emitTo(detachedNoteLabel(noteId), DETACHED_NOTE_EVENTS.THEME, buildThemePayload()).catch(() => undefined);

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

const syncAllDetachedThemes = (): void => {
  const { detachedNotes } = useStore.getState();

  for (const entry of detachedNotes) {
    emitTheme(entry.noteId);
  }
};

export const startDetachedNoteSnapshotSync = (): (() => void) => {
  if (unsubscribe) {
    return stopDetachedNoteSnapshotSync;
  }

  unsubscribe = useStore.subscribe((state, prevState) => {
    const detachedChanged = state.detachedNotes !== prevState.detachedNotes;
    const notesChanged = state.notesById !== prevState.notesById;
    const themeChanged = state.config.themeMode !== prevState.config.themeMode;

    if (!detachedChanged && !notesChanged && !themeChanged) {
      return;
    }

    if (detachedChanged || notesChanged) {
      syncAllDetachedNotes();
    }

    if (detachedChanged || themeChanged) {
      syncAllDetachedThemes();
    }
  });

  if (!unlistenReadyPromise) {
    unlistenReadyPromise = listen<DetachedNoteReadyPayload>(
      DETACHED_NOTE_EVENTS.READY,
      (event) => {
        const { noteId } = event.payload;
        clearPendingTimer(noteId);
        emitTheme(noteId);
        const { notesById } = useStore.getState();
        const note = notesById[noteId];
        if (!note || note.deletedAt) {
          emitMissing(noteId);
        } else {
          const snapshot: DetachedNoteSnapshot = {
            noteId,
            title: note.title,
            content: note.content,
            color: note.color,
            isCollapsed: note.collapsed ?? false,
            deletedAt: note.deletedAt,
          };
          emitSnapshot(noteId, snapshot);
        }
      },
    );
  }

  return stopDetachedNoteSnapshotSync;
};

export const stopDetachedNoteSnapshotSync = (): void => {
  unsubscribe?.();
  unsubscribe = null;
  clearAllPendingTimers();
  if (unlistenReadyPromise) {
    unlistenReadyPromise.then((unlisten) => unlisten()).catch(() => undefined);
    unlistenReadyPromise = null;
  }
};
