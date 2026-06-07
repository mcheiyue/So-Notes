import { emitTo, listen } from '@tauri-apps/api/event';
import { useStore } from '../store/useStore';
import type { DetachedNoteReadyPayload, DetachedNoteSnapshot, DetachedNoteThemePayload } from '../types/detachedNoteSnapshot';
import { DETACHED_NOTE_EVENTS } from '../types/detachedNoteSnapshot';
import type { AttachmentRef, ThemeMode } from '../store/types';

const SNAPSHOT_THROTTLE_MS = 100;
const DETACHED_OPEN_RETRY_MS = 350;

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

const cloneAttachments = (attachments: AttachmentRef[] | undefined): AttachmentRef[] | undefined =>
  attachments && attachments.length > 0 ? attachments.map((attachment) => ({ ...attachment })) : undefined;

const buildSnapshot = (
  noteId: string,
  note: { kind?: 'text' | 'image'; title: string; content: string; color: string; collapsed?: boolean; attachments?: AttachmentRef[]; deletedAt?: number | null },
): DetachedNoteSnapshot => ({
  noteId,
  kind: note.kind,
  title: note.title,
  content: note.content,
  color: note.color,
  isCollapsed: note.collapsed ?? false,
  attachments: cloneAttachments(note.attachments),
  deletedAt: note.deletedAt,
});

const syncDetachedNote = (
  noteId: string,
  note: { kind?: 'text' | 'image'; title: string; content: string; color: string; collapsed?: boolean; attachments?: AttachmentRef[]; deletedAt?: number | null } | undefined,
  options: { retryAfterOpen?: boolean } = {},
): void => {
  if (!note || note.deletedAt) {
    clearPendingTimer(noteId);
    emitMissing(noteId);
    return;
  }

  clearPendingTimer(noteId);

  const timer = setTimeout(() => {
    pendingTimers.delete(noteId);
    const snapshot = buildSnapshot(noteId, note);
    emitSnapshot(noteId, snapshot);

    if (options.retryAfterOpen) {
      setTimeout(() => {
        const currentNote = useStore.getState().notesById[noteId];
        if (!currentNote || currentNote.deletedAt) {
          emitMissing(noteId);
          return;
        }
        emitSnapshot(noteId, buildSnapshot(noteId, currentNote));
      }, DETACHED_OPEN_RETRY_MS);
    }
  }, SNAPSHOT_THROTTLE_MS);

  pendingTimers.set(noteId, timer);
};

const syncAllDetachedNotes = (options: { retryAfterOpen?: boolean } = {}): void => {
  const { notesById, detachedNotes } = useStore.getState();

  for (const entry of detachedNotes) {
    const note = notesById[entry.noteId];
    syncDetachedNote(entry.noteId, note, options);
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
      syncAllDetachedNotes({ retryAfterOpen: detachedChanged });
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
          const snapshot = buildSnapshot(noteId, note);
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
