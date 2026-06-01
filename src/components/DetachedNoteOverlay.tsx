import React, { useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useUIStore, uiSelectors } from '../store/uiStore';
import { useStore } from '../store/useStore';
import { NoteVisuals } from './note-render/NoteVisuals';
import { Z_INDEX } from '../constants/layout';
import { cn } from '../utils/cn';

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
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [noteId, position.x, position.y, updatePosition],
  );

  const note = useStore((s) => s.notesById[noteId]);
  const isDark =
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('dark');

  if (!note) return null;

  return (
    <div
      data-testid={`detached-note-shell-${noteId}`}
      className="absolute"
      style={{
        left: position.x,
        top: position.y,
        zIndex: isPinned ? Z_INDEX.DETACHED_NOTE + 1 : Z_INDEX.DETACHED_NOTE,
      }}
    >
      <div
        className={cn(
          'rounded-xl border border-border-subtle bg-secondary-bg/80 shadow-xl',
          'pointer-events-auto',
        )}
      >
        <div
          data-testid={`detached-note-drag-handle-${noteId}`}
          className="flex h-9 cursor-grab items-center justify-between px-3 active:cursor-grabbing"
          onMouseDown={handleMouseDown}
        >
          <span className="text-xs text-text-tertiary select-none">拖拽移动</span>
          {isPinned && (
            <span className="text-xs text-accent select-none">📌</span>
          )}
        </div>
        <NoteVisuals
          title={note.title}
          content={note.content}
          color={note.color}
          isCollapsed={note.collapsed ?? false}
          isDark={isDark}
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
