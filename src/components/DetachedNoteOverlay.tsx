import React, { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Crosshair, Pin, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useUIStore, uiSelectors } from '../store/uiStore';
import { useStore } from '../store/useStore';
import { appController } from '../controllers/appController';
import { NoteVisuals } from './note-render/NoteVisuals';
import { Z_INDEX } from '../constants/layout';
import { cn } from '../utils/cn';
import { useDarkMode } from '../hooks/useDarkMode';

interface DragState {
  noteId: string;
  startMouseX: number;
  startMouseY: number;
  startPositionX: number;
  startPositionY: number;
}

const DetachedNoteShell: React.FC<{
  noteId: string;
  position: { x: number; y: number };
  isPinned: boolean;
}> = ({ noteId, position, isPinned }) => {
  const updatePosition = useUIStore((s) => s.updateDetachedNotePosition);
  const dragRef = useRef<DragState | null>(null);

  const handleMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragRef.current = {
        noteId,
        startMouseX: event.clientX,
        startMouseY: event.clientY,
        startPositionX: position.x,
        startPositionY: position.y,
      };

      const handleMouseMove = (e: MouseEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const dx = e.clientX - drag.startMouseX;
        const dy = e.clientY - drag.startMouseY;
        updatePosition(drag.noteId, {
          x: drag.startPositionX + dx,
          y: drag.startPositionY + dy,
        });
      };

      const handleMouseUp = () => {
        dragRef.current = null;
        document.removeEventListener('mousemove', handleMouseMove, true);
        document.removeEventListener('mouseup', handleMouseUp, true);
      };

      document.addEventListener('mousemove', handleMouseMove, true);
      document.addEventListener('mouseup', handleMouseUp, true);
    },
    [noteId, position.x, position.y, updatePosition],
  );

  const handleFocusCapture = useCallback(() => {
    appController.focusDetachedNote(noteId);
  }, [noteId]);

  const handleLocate = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      appController.locateDetachedNote(noteId);
    },
    [noteId],
  );

  const handlePin = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      appController.toggleDetachedNotePin(noteId);
    },
    [noteId],
  );

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      appController.closeDetachedNote(noteId);
    },
    [noteId],
  );

  const stopButtonMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  const stopOverlayEvent = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation();
  }, []);

  const handleOverlayContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const noteSnapshot = useStore(
    useShallow((state) => {
      const note = state.notesById[noteId];
      if (!note) {
        return {
          available: false,
          title: '',
          content: '',
          color: '',
          isCollapsed: false,
        };
      }
      return {
        available: note.deletedAt == null,
        title: note.title,
        content: note.content,
        color: note.color,
        isCollapsed: note.collapsed ?? false,
      };
    }),
  );

  const removeDetachedNote = useUIStore((s) => s.removeDetachedNote);
  useEffect(() => {
    if (!noteSnapshot.available) {
      removeDetachedNote(noteId);
    }
  }, [noteSnapshot.available, noteId, removeDetachedNote]);

  const isDark = useDarkMode();

  if (!noteSnapshot.available) return null;

  return (
    <div
      data-testid={`detached-note-shell-${noteId}`}
      className="absolute"
      onMouseDownCapture={handleFocusCapture}
      onMouseDown={stopOverlayEvent}
      onMouseUp={stopOverlayEvent}
      onClick={stopOverlayEvent}
      onDoubleClick={stopOverlayEvent}
      onContextMenu={handleOverlayContextMenu}
      style={{
        left: position.x,
        top: position.y,
        zIndex: isPinned ? Z_INDEX.DETACHED_NOTE + 1 : Z_INDEX.DETACHED_NOTE,
      }}
    >
      <div className="pointer-events-auto">
        <div
          data-testid={`detached-note-drag-handle-${noteId}`}
          className={cn(
            'mb-1.5 flex h-8 w-fit cursor-grab items-center justify-between gap-1 rounded-lg border border-border-subtle px-1.5',
            'bg-secondary-bg/95 shadow-lg backdrop-blur-md active:cursor-grabbing',
          )}
          onMouseDown={handleMouseDown}
        >
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              data-testid={`detached-note-locate-${noteId}`}
              aria-label="定位到画布所在"
              className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-secondary"
              onMouseDown={stopButtonMouseDown}
              onClick={handleLocate}
            >
              <Crosshair size={14} />
            </button>
            <button
              type="button"
              data-testid={`detached-note-pin-${noteId}`}
              aria-label={isPinned ? '取消置顶' : '置顶'}
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/10',
                isPinned ? 'text-accent' : 'text-text-tertiary hover:text-text-secondary',
              )}
              onMouseDown={stopButtonMouseDown}
              onClick={handlePin}
            >
              <Pin size={14} />
            </button>
            <button
              type="button"
              data-testid={`detached-note-stick-back-${noteId}`}
              aria-label="贴回画布"
              className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-secondary"
              onMouseDown={stopButtonMouseDown}
              onClick={handleClose}
            >
              <X size={14} />
            </button>
          </div>
          {isPinned && <Pin size={12} className="text-accent" />}
        </div>
        <NoteVisuals
          title={noteSnapshot.title}
          content={noteSnapshot.content}
          color={noteSnapshot.color}
          isCollapsed={noteSnapshot.isCollapsed}
          isDark={isDark}
          className="shadow-xl"
        />
      </div>
    </div>
  );
};

export const DetachedNoteOverlay: React.FC = () => {
  const detachedNotes = useUIStore(uiSelectors.detachedNotes);
  const overlayRoot =
    typeof document !== 'undefined'
      ? document.getElementById('overlay-root')
      : null;

  if (!overlayRoot || detachedNotes.length === 0) return null;

  return createPortal(
    <div
      data-testid="detached-note-overlay"
      className="pointer-events-none fixed inset-0"
    >
      {detachedNotes.map((entry) => (
        <DetachedNoteShell
          key={entry.noteId}
          noteId={entry.noteId}
          position={entry.position}
          isPinned={entry.isPinned}
        />
      ))}
    </div>,
    overlayRoot,
  );
};
