import { LAYOUT } from '../constants/layout';
import { LayoutNote, Note } from '../store/types';

type NoteVisualSource = Pick<Note, 'collapsed' | 'width' | 'height'> | null | undefined;
type LayoutVisualSource = Pick<LayoutNote, 'width' | 'height'> | null | undefined;

export const getNoteVisualWidth = (
  note: NoteVisualSource,
  layout?: LayoutVisualSource,
): number => {
  const rawWidth = layout?.width ?? note?.width ?? LAYOUT.NOTE_WIDTH;
  return Math.max(LAYOUT.NOTE_MIN_WIDTH, rawWidth);
};

export const getNoteVisualHeight = (
  note: NoteVisualSource,
  layout?: LayoutVisualSource,
): number => {
  if (note?.collapsed) {
    return LAYOUT.NOTE_COLLAPSED_HEIGHT;
  }

  const rawHeight = layout?.height ?? note?.height ?? LAYOUT.NOTE_MIN_HEIGHT;
  return Math.max(LAYOUT.NOTE_MIN_HEIGHT, rawHeight);
};
