import { LayoutNote, Note, NormalizedNotesState } from './types';

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

const extractLayoutNote = (note: Note): LayoutNote => ({
  id: note.id,
  x: note.x,
  y: note.y,
  boardId: note.boardId,
  deletedAt: note.deletedAt ?? null,
  color: note.color,
  width: note.width,
  height: note.height,
});

export const createLayoutNotesById = (notesById: Record<string, Note>): Record<string, LayoutNote> => {
  const layoutNotesById: Record<string, LayoutNote> = {};

  Object.values(notesById).forEach((note) => {
    layoutNotesById[note.id] = extractLayoutNote(note);
  });

  return layoutNotesById;
};

export const updateLayoutNote = (
  layoutNotesById: Record<string, LayoutNote>,
  note: Note,
): Record<string, LayoutNote> => ({
  ...layoutNotesById,
  [note.id]: extractLayoutNote(note),
});

export const removeLayoutNote = (
  layoutNotesById: Record<string, LayoutNote>,
  noteId: string,
): Record<string, LayoutNote> => {
  if (!(noteId in layoutNotesById)) {
    return layoutNotesById;
  }

  const { [noteId]: _removed, ...rest } = layoutNotesById;
  return rest;
};
