import { Note, NormalizedNotesState } from './types';

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
