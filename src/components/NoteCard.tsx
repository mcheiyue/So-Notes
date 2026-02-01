import React, { useRef, useState, useEffect } from "react";
import Draggable, { DraggableData, DraggableEvent } from "react-draggable";
import { X, GripHorizontal, Palette } from "lucide-react";
import { Note, NOTE_COLORS } from "../store/types";
import { useStore } from "../store/useStore";
import { cn } from "../utils/cn";

interface NoteCardProps {
  note: Note;
  scale: number;
}

export const NoteCard: React.FC<NoteCardProps> = ({ note, scale }) => {
  const { updateNote, moveNote, deleteNote, bringToFront, changeColor } = useStore();
  const nodeRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  // Auto-focus on mount if empty
  useEffect(() => {
    if (!note.content && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [note.content]);

  const handleStop = (_e: DraggableEvent, data: DraggableData) => {
    moveNote(note.id, data.x, data.y);
  };

  const handleMouseDown = () => {
    bringToFront(note.id);
  };
  
  const cycleColor = (e: React.MouseEvent) => {
      e.stopPropagation();
      const currentIndex = NOTE_COLORS.indexOf(note.color);
      const nextIndex = (currentIndex + 1) % NOTE_COLORS.length;
      changeColor(note.id, NOTE_COLORS[nextIndex]);
  };

  return (
    <Draggable
      nodeRef={nodeRef}
      handle=".drag-handle"
      defaultPosition={{ x: note.x, y: note.y }}
      position={{ x: note.x, y: note.y }}
      scale={scale}
      onStart={handleMouseDown}
      onStop={handleStop}
    >
      <div
        ref={nodeRef}
        className={cn(
          "note-card absolute flex flex-col w-[260px] h-auto min-h-[100px]", // Changed min-h to 100px and added h-auto
          "rounded-xl transition-all duration-200 ease-out",
          "shadow-sm hover:shadow-xl",
          "border border-black/5 dark:border-white/5",
          "group"
        )}
        style={{ 
            backgroundColor: note.color,
            zIndex: note.z,
        }}
        onMouseDown={handleMouseDown}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Header / Control Bar - Only visible on hover */}
        <div 
            className={cn(
                "drag-handle h-9 flex items-center justify-between px-3 pt-1 cursor-grab active:cursor-grabbing",
                "transition-opacity duration-200",
                isHovered || isEditing ? "opacity-100" : "opacity-0"
            )}
        >
          {/* Color Button */}
          <button
            onClick={cycleColor}
            className="p-1.5 rounded-md hover:bg-black/5 transition-colors text-black/40 hover:text-black/70"
            title="切换颜色"
          >
             <Palette className="w-4 h-4" />
          </button>
          
          {/* Drag Indicator (Center) */}
          <GripHorizontal className="w-4 h-4 text-black/20" />

          {/* Delete Button */}
          <button
            onClick={(e) => {
                e.stopPropagation();
                deleteNote(note.id);
            }}
            className="p-1.5 rounded-md hover:bg-red-100 hover:text-red-500 transition-colors text-black/40"
            title="删除便签"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Area */}
        <div className="flex-1 px-4 pb-4 pt-0 flex flex-col">
          <textarea
            ref={textareaRef}
            className={cn(
                "w-full resize-none bg-transparent outline-none overflow-hidden",
                "text-gray-800",
                "placeholder-gray-400 font-normal text-[15px] leading-relaxed",
                "selection:bg-black/10"
            )}
            placeholder="记点什么..."
            value={note.content}
            onChange={(e) => {
                updateNote(note.id, e.target.value);
                // Auto-resize
                e.target.style.height = 'auto';
                e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            // Trigger resize on mount/focus too
            onInput={(e) => {
                const target = e.target as HTMLTextAreaElement;
                target.style.height = 'auto';
                target.style.height = `${target.scrollHeight}px`;
            }}
            onFocus={() => setIsEditing(true)}
            onBlur={() => setIsEditing(false)}
            spellCheck={false}
            rows={1}
          />
        </div>
      </div>
    </Draggable>
  );
};
