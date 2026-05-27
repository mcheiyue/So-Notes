import React from 'react';
import { NOTE_COLORS } from '../store/types';
import { useStore } from '../store/useStore';
import { Z_INDEX } from '../constants/layout';
import { cn } from '../utils/cn';

const actionButtonClass = 'rounded-full px-3 py-1.5 text-xs font-semibold text-text-secondary transition-colors hover:bg-secondary-bg hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-sky-300 dark:hover:bg-white/10';

export const SelectionActionBar: React.FC = () => {
  const viewMode = useStore(state => state.viewMode);
  const selectedIds = useStore(state => state.selectedIds);
  const notesById = useStore(state => state.notesById);
  const mergeSelectedNotes = useStore(state => state.mergeSelectedNotes);
  const deleteSelectedNotes = useStore(state => state.deleteSelectedNotes);
  const changeSelectedNotesColor = useStore(state => state.changeSelectedNotesColor);
  const batchToggleCollapse = useStore(state => state.batchToggleCollapse);
  const arrangeNotes = useStore(state => state.arrangeNotes);
  const duplicateSelectedNotes = useStore(state => state.duplicateSelectedNotes);

  const activeSelectedIds = selectedIds.filter((id) => {
    const note = notesById[id];
    return note && !note.deletedAt;
  });

  if (viewMode !== 'BOARD' || activeSelectedIds.length < 2) {
    return null;
  }

  return (
    <div
      className="fixed left-1/2 bottom-20 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-1 rounded-full border border-border-subtle bg-primary-bg/95 px-2 py-2 text-sm text-text-primary shadow-2xl backdrop-blur-md dark:bg-secondary-bg/90"
      style={{ zIndex: Z_INDEX.MENU - 1 }}
      role="toolbar"
      aria-label={`已选中 ${activeSelectedIds.length} 个便签的快捷操作`}
    >
      <div className="shrink-0 px-2 text-xs font-semibold text-text-tertiary">
        已选 {activeSelectedIds.length}
      </div>

      <button type="button" className={actionButtonClass} onClick={mergeSelectedNotes}>
        合并
      </button>
      <button type="button" className={actionButtonClass} onClick={deleteSelectedNotes}>
        删除
      </button>

      <div className="mx-1 h-5 w-px bg-border-subtle" aria-hidden="true" />
      <div className="flex items-center gap-1 px-1" aria-label="改色">
        {NOTE_COLORS.slice(0, 6).map((color) => (
          <button
            key={color}
            type="button"
            className="h-5 w-5 rounded-full border border-border-subtle shadow-sm transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-sky-300"
            style={{ backgroundColor: color }}
            aria-label={`改色为 ${color}`}
            onClick={() => changeSelectedNotesColor(color)}
          />
        ))}
      </div>
      <div className="mx-1 h-5 w-px bg-border-subtle" aria-hidden="true" />

      <button type="button" className={actionButtonClass} onClick={() => batchToggleCollapse(activeSelectedIds)}>
        折叠
      </button>
      <button type="button" className={actionButtonClass} onClick={() => arrangeNotes(undefined, undefined, 'position', 'selection')}>
        归拢
      </button>
      <button type="button" className={cn(actionButtonClass, 'text-sky-600 dark:text-sky-300')} onClick={duplicateSelectedNotes}>
        复制
      </button>
    </div>
  );
};
