import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NOTE_UI_COLORS } from '../store/types';
import { useDomainStore, useUIStore } from '../store';
import { Z_INDEX } from '../constants/layout';
import { cn } from '../utils/cn';
import { appController } from '../controllers/appController';

const actionButtonClass = 'rounded-full px-2.5 py-1 text-[11px] font-semibold text-text-secondary transition-colors hover:bg-secondary-bg hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-sky-300 dark:hover:bg-white/10';

export const SelectionActionBar: React.FC = () => {
  const viewMode = useUIStore(state => state.viewMode);
  const selectedIds = useUIStore(state => state.selectedIds);
  const notesById = useDomainStore(state => state.notesById);
  const mergeSelectedNotes = appController.mergeSelectedNotes;
  const deleteSelectedNotes = appController.deleteSelectedNotes;
  const changeSelectedNotesColor = appController.changeSelectedNotesColor;
  const batchToggleCollapse = appController.toggleSelectedNotesCollapse;
  const arrangeNotes = appController.arrangeNotes;
  const duplicateSelectedNotes = appController.duplicateSelectedNotes;

  const [isColorPopoverOpen, setIsColorPopoverOpen] = useState(false);
  const colorPopoverRef = useRef<HTMLDivElement>(null);
  const colorTriggerRef = useRef<HTMLButtonElement>(null);

  const activeSelectedIds = useMemo(
    () =>
      selectedIds.filter((id) => {
        const note = notesById[id];
        return note && !note.deletedAt;
      }),
    [selectedIds, notesById],
  );

  const closeColorPopover = useCallback(() => {
    setIsColorPopoverOpen(false);
  }, []);

  const handleColorSelect = useCallback((color: string) => {
    changeSelectedNotesColor(color);
    closeColorPopover();
  }, [changeSelectedNotesColor, closeColorPopover]);

  useEffect(() => {
    if (!isColorPopoverOpen) return;

    const handleDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;

      if (colorPopoverRef.current?.contains(target) || colorTriggerRef.current?.contains(target)) {
        return;
      }

      closeColorPopover();
    };

    document.addEventListener('pointerdown', handleDocumentPointerDown);
    return () => document.removeEventListener('pointerdown', handleDocumentPointerDown);
  }, [closeColorPopover, isColorPopoverOpen]);

  if (viewMode !== 'BOARD' || activeSelectedIds.length < 2) {
    return null;
  }

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
  };

  return (
    <div
      className="selection-actionbar fixed left-1/2 bottom-20 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-y-1.5 rounded-full border border-border-subtle bg-primary-bg/95 px-2.5 py-1.5 text-sm text-text-primary shadow-2xl backdrop-blur-md dark:bg-secondary-bg/90"
      style={{ zIndex: Z_INDEX.MENU - 1 }}
      role="toolbar"
      aria-label={`已选中 ${activeSelectedIds.length} 个便签的快捷操作`}
      onPointerDown={handlePointerDown}
    >
      <div className="selection-actionbar__primary flex items-center gap-0.5 shrink-0">
        <div className="shrink-0 px-1.5 text-[11px] font-semibold text-text-tertiary">
          已选 {activeSelectedIds.length}
        </div>

        <button type="button" className={actionButtonClass} onClick={mergeSelectedNotes}>
          合并
        </button>
        <button type="button" className={actionButtonClass} onClick={deleteSelectedNotes}>
          删除
        </button>
      </div>

      <div className="mx-1 h-5 w-px bg-border-subtle self-center" aria-hidden="true" />

      <div className="selection-actionbar__colors relative flex items-center px-0.5">
        <button
          ref={colorTriggerRef}
          type="button"
          className={cn(actionButtonClass, isColorPopoverOpen && 'bg-secondary-bg')}
          aria-label="改色"
          aria-expanded={isColorPopoverOpen}
          onClick={() => setIsColorPopoverOpen((prev) => !prev)}
        >
          改色
        </button>
        {isColorPopoverOpen && (
          <div
            ref={colorPopoverRef}
            role="listbox"
            aria-label="选择颜色"
            className="absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-lg border border-border-subtle bg-primary-bg/95 p-2 shadow-lg backdrop-blur-md dark:bg-secondary-bg/95"
            style={{ zIndex: Z_INDEX.MENU }}
          >
            <div className="flex gap-1.5">
              {NOTE_UI_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="option"
                  className="h-5 w-5 rounded-full border border-border-subtle shadow-sm transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-sky-300"
                  style={{ backgroundColor: color }}
                  aria-label={`改色为 ${color}`}
                  onClick={() => handleColorSelect(color)}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="mx-1 h-5 w-px bg-border-subtle self-center" aria-hidden="true" />

      <div className="selection-actionbar__trailing flex items-center gap-0.5 shrink-0">
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
    </div>
  );
};
