import React, { useRef, useState, useEffect, useLayoutEffect } from "react";
import Draggable, { DraggableData, DraggableEvent } from "react-draggable";
import { X, GripHorizontal, Palette } from "lucide-react";
import { Note, NOTE_COLORS } from "../store/types";
import { useStore } from "../store/useStore";
import { cn } from "../utils/cn";
import { Tooltip } from "./Tooltip";

interface NoteCardProps {
  note: Note;
  scale: number;
}

export const NoteCard: React.FC<NoteCardProps> = ({ note, scale }) => {
  const { updateNote, moveNote, deleteNote, bringToFront, changeColor, stickyDrag, setStickyDrag } = useStore();
  const nodeRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  
  const isStickyDragging = stickyDrag.id === note.id;

  useEffect(() => {
    if (!note.content && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, []); 

  useLayoutEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [note.content]);

  const handleStop = (_e: DraggableEvent, data: DraggableData) => {
    let newX = data.x;
    let newY = data.y;
    const winW = window.innerWidth;
    const winH = window.innerHeight;

    // Boundary Guard
    if (newX < 0) newX = 0;
    if (newY < 0) newY = 0;
    // Ensure visibility (prevent losing right/bottom)
    if (newX > winW - 50) newX = winW - 220;
    if (newY > winH - 50) newY = winH - 100;

    moveNote(note.id, newX, newY);
  };

  const handleMouseDown = () => {
    bringToFront(note.id);
  };
  
  const handleContextMenu = (e: React.MouseEvent) => {
      if (!stickyDrag.id) {
          e.preventDefault(); 
          e.stopPropagation();
          
          if (nodeRef.current) {
              const rect = nodeRef.current.getBoundingClientRect();
              const offsetX = e.clientX - rect.left;
              const offsetY = e.clientY - rect.top;
              
              bringToFront(note.id);
              setStickyDrag(note.id, offsetX, offsetY);
          }
      }
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
      disabled={isStickyDragging}
    >
      <div
        ref={nodeRef}
        className={cn(
          "note-card absolute flex flex-col w-[260px] h-auto min-h-[100px]",
          "rounded-xl transition-all duration-200 ease-out",
          "shadow-sm hover:shadow-xl",
          "border border-black/5",
          "group",
          isStickyDragging && "shadow-2xl scale-[1.02] cursor-move z-[9999]"
        )}
        style={{ 
            backgroundColor: note.color,
            zIndex: isStickyDragging ? 99999 : note.z,
        }}
        onMouseDownCapture={handleMouseDown}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <div 
            className={cn(
                "drag-handle h-9 flex items-center justify-between px-3 pt-1 cursor-grab active:cursor-grabbing",
                "transition-opacity duration-200",
                isHovered || isEditing ? "opacity-100" : "opacity-0"
            )}
            onContextMenu={handleContextMenu}
        >
          <Tooltip content="切换颜色">
            <button
              onClick={cycleColor}
              className="p-1.5 rounded-md hover:bg-black/5 transition-colors text-black/40 hover:text-black/70"
            >
               <Palette className="w-4 h-4" />
            </button>
          </Tooltip>
          
          <Tooltip content="右键点击吸附拖动" delay={1000}>
            <div className="flex-1 flex justify-center cursor-grab active:cursor-grabbing h-full items-center">
                 <GripHorizontal className="w-4 h-4 text-black/20" />
            </div>
          </Tooltip>

          <Tooltip content="删除便签">
            <button
              onClick={(e) => {
                  e.stopPropagation();
                  deleteNote(note.id);
              }}
              className="p-1.5 rounded-md hover:bg-red-100 hover:text-red-500 transition-colors text-black/40"
            >
              <X className="w-4 h-4" />
            </button>
          </Tooltip>
        </div>

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
                e.target.style.height = 'auto';
                e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            onInput={(e) => {
                const target = e.target as HTMLTextAreaElement;
                target.style.height = 'auto';
                target.style.height = `${target.scrollHeight}px`;
            }}
            onFocus={() => setIsEditing(true)}
            onBlur={() => setIsEditing(false)}
            onMouseDownCapture={handleMouseDown}
            spellCheck={false}
            rows={1}
          />
        </div>
      </div>
    </Draggable>
  );
};
