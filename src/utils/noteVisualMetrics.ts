import { LAYOUT } from '../constants/layout';
import { LayoutNote, Note } from '../store/types';

type NoteVisualSource = Pick<Note, 'collapsed'> | null | undefined;
type LayoutVisualSource = Pick<LayoutNote, 'width' | 'height'> | null | undefined;

export const getNoteVisualWidth = (
  _note?: NoteVisualSource,
  _layout?: LayoutVisualSource,
): number => LAYOUT.NOTE_WIDTH;

export const getNoteVisualHeight = (
  note?: NoteVisualSource,
  _layout?: LayoutVisualSource,
): number => {
  if (note?.collapsed) {
    return LAYOUT.NOTE_COLLAPSED_HEIGHT;
  }

  return LAYOUT.NOTE_MIN_HEIGHT;
};
