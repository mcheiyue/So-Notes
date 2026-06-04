import { AttachmentRef, LayoutNote, Note, NormalizedNotesState } from './types';

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isSha256Hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);

const isSafeAttachmentRelativePath = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  if (!value.startsWith('attachments/') || value.includes('\\') || value.startsWith('/')) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
};

const toCleanAttachmentRef = (entry: unknown): AttachmentRef | null => {
  if (!entry || typeof entry !== 'object') return null;
  const ref = entry as Record<string, unknown>;
  if (!(
    isNonEmptyString(ref.id) &&
    isSha256Hash(ref.hash) &&
    isNonEmptyString(ref.filename) &&
    isNonEmptyString(ref.mimeType) &&
    typeof ref.size === 'number' &&
    Number.isFinite(ref.size) &&
    isSafeAttachmentRelativePath(ref.relativePath) &&
    typeof ref.createdAt === 'number' &&
    Number.isFinite(ref.createdAt)
  )) {
    return null;
  }

  return {
    id: ref.id,
    hash: ref.hash.toLowerCase(),
    filename: ref.filename,
    mimeType: ref.mimeType,
    size: ref.size,
    relativePath: ref.relativePath,
    createdAt: ref.createdAt,
  };
};

export const sanitizeAttachments = (attachments: unknown): AttachmentRef[] =>
  Array.isArray(attachments)
    ? attachments.flatMap((entry) => {
      const cleaned = toCleanAttachmentRef(entry);
      return cleaned ? [cleaned] : [];
    })
    : [];

export const createEmptyNormalizedNotesState = (): NormalizedNotesState => ({
  notesById: {},
  allNoteIds: [],
  boardNoteIds: {},
});

export const normalizeNotes = (notes: Note[]): NormalizedNotesState => {
  const normalized = createEmptyNormalizedNotesState();

  notes.forEach((note) => {
    normalized.notesById[note.id] = note;
    normalized.allNoteIds.push(note.id);

    if (!normalized.boardNoteIds[note.boardId]) {
      normalized.boardNoteIds[note.boardId] = [];
    }

    normalized.boardNoteIds[note.boardId].push(note.id);
  });

  return normalized;
};

export const denormalizeNotes = ({ notesById, allNoteIds }: NormalizedNotesState): Note[] => {
  return allNoteIds.flatMap((id) => {
    const note = notesById[id];
    return note ? [note] : [];
  });
};

export const extractLayoutNote = (note: Note): LayoutNote => ({
  id: note.id,
  x: note.x,
  y: note.y,
  boardId: note.boardId,
  deletedAt: note.deletedAt ?? null,
  color: note.color,
});

export const createLayoutNotesById = (notesById: Record<string, Note>): Record<string, LayoutNote> => {
  const layoutNotesById: Record<string, LayoutNote> = {};

  Object.values(notesById).forEach((note) => {
    layoutNotesById[note.id] = extractLayoutNote(note);
  });

  return layoutNotesById;
};


