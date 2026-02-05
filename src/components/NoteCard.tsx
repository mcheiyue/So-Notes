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
  const { updateNote, updateTitle, moveNote, moveSelectedNotes, deleteNote, bringToFront, changeColor, toggleCollapse, stickyDrag, setContextMenu, selectedIds, toggleSelection } = useStore();
  const nodeRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  
  const isStickyDragging = stickyDrag.id === note.id;
  const isSelected = selectedIds.includes(note.id);
  
  const displayTitle = note.title || "未命名便签";

  useEffect(() => {
    // Auto-focus logic:
    // 1. New empty note (standard)
    // 2. Just created note (pasted content) - checking createdAt < 1000ms
    const isJustCreated = Date.now() - note.createdAt < 1000;
    
    // Fix: Only auto-focus if the note was JUST created (New or Paste).
    // Prevents old empty notes from stealing focus on board switch.
    if (isJustCreated) {
        if (!note.collapsed) {
             // Only focus Title if we have content (Paste & Create scenario)
             if (note.content && titleRef.current) {
                 setIsEditing(true);
                 setTimeout(() => {
                    titleRef.current?.focus();
                 }, 0);
             } else if (textareaRef.current) {
                 // Standard New Note (Empty) -> Focus Textarea
                 textareaRef.current.focus();
             }
        }
    }
  }, []); 

  useLayoutEffect(() => {
    if (textareaRef.current && !note.collapsed) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [note.content, note.collapsed]);

  // Interactive Todo Logic
  const handleTextareaClick = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    const textarea = e.currentTarget;
    const cursor = textarea.selectionStart;
    const content = note.content;

    // 1. Find line boundaries
    const before = content.substring(0, cursor);
    const after = content.substring(cursor);
    const lineStart = before.lastIndexOf('\n') + 1;
    const lineEndOffset = after.indexOf('\n');
    const lineEnd = lineEndOffset === -1 ? content.length : cursor + lineEndOffset;
    
    const line = content.substring(lineStart, lineEnd);

    // 2. Regex to match markdown checkbox: - [ ] or * [x]
    // Group 1: Prefix ("- " or "* ")
    // Group 2: State (" " or "x")
    const match = line.match(/^(\s*[-*]\s*)\[([ xX])\]/);

    if (match) {
        const prefix = match[1];
        const state = match[2];
        
        // 3. Calculate Checkbox range
        const checkboxStart = lineStart + prefix.length;
        const checkboxEnd = checkboxStart + 3; // "[ ]" is 3 chars

        // 4. Check if click is inside [ ]
        if (cursor >= checkboxStart && cursor <= checkboxEnd) {
             e.preventDefault(); // Stop normal selection behavior
             
             // Toggle State
             const newState = (state === ' ' ? 'x' : ' ');
             
             // Replace content
             const newContent = 
                content.substring(0, checkboxStart + 1) + 
                newState + 
                content.substring(checkboxStart + 2);

             updateNote(note.id, newContent);

             // Restore cursor position
             requestAnimationFrame(() => {
                 if (textareaRef.current) {
                    textareaRef.current.setSelectionRange(cursor, cursor);
                 }
             });
        }
    }
  };

  const handleStop = (_e: DraggableEvent, data: DraggableData) => {
    // 1. Calculate Delta (Since handleDrag updates store, we can't rely on data.x - note.x?)
    // Actually, data.x is the final position of THIS drag operation.
    // note.x might be updated by handleDrag?
    // Let's rely on data.x/y as the source of truth for THIS note.
    
    let newX = data.x;
    let newY = data.y;
    const winW = window.innerWidth;
    const winH = window.innerHeight;

    // 2. Individual Clamp (This Note)
    if (newX < 0) newX = 0;
    if (newY < 0) newY = 0;
    if (newX > winW - 100) newX = winW - 100;
    if (newY > winH - 50) newY = winH - 50;

    moveNote(note.id, newX, newY);

    // 3. Group Distributed Clamp (Other Notes)
    // Since handleDrag already moved them to their raw positions (potentially out of bounds),
    // we now check and clamp them one by one.
    if (isSelected && selectedIds.length > 1) {
        // We need to access the LATEST state because handleDrag updated it.
        const state = useStore.getState();
        
        state.selectedIds.forEach(id => {
            if (id === note.id) return; // Already handled above
            
            const n = state.notes.find(item => item.id === id);
            if (n) {
                let finalX = n.x;
                let finalY = n.y;
                let changed = false;

                if (finalX < 0) { finalX = 0; changed = true; }
                if (finalY < 0) { finalY = 0; changed = true; }
                if (finalX > winW - 100) { finalX = winW - 100; changed = true; }
                if (finalY > winH - 50) { finalY = winH - 50; changed = true; }

                if (changed) {
                    moveNote(id, finalX, finalY);
                }
            }
        });
    }
  };

  const handleDrag = (_e: DraggableEvent, data: DraggableData) => {
      if (isSelected && selectedIds.length > 1) {
          const deltaX = data.deltaX;
          const deltaY = data.deltaY;
          moveSelectedNotes(deltaX, deltaY, note.id);
      }
  };

  const handleMouseDown = (e: DraggableEvent) => {
    // Cast to React.MouseEvent-like object or use native event properties
    // DraggableEvent is MouseEvent | TouchEvent (native)
    const mouseEvent = e as unknown as React.MouseEvent;

    // 0. Sticky Drag Lock: If any note is sticky dragging, ignore interactions
    // This allows the click to propagate (if not captured) or just do nothing.
    // Ideally, clicking another note should probably DROP the sticky note (handled by Canvas global click?)
    // But since this is Capture phase, we run first.
    // If we do nothing, event bubbles. Canvas onClick might handle it.
    if (stickyDrag.id) return;

    // Selection Logic
    if (mouseEvent.ctrlKey || mouseEvent.shiftKey) {
        toggleSelection(note.id);
        mouseEvent.stopPropagation(); 
        return;
    }

    if (!isSelected) {
        useStore.getState().setSelectedIds([note.id]);
    }
    
    bringToFront(note.id);
  };
  
  const handleContextMenu = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({
          isOpen: true,
          x: e.clientX,
          y: e.clientY,
          type: 'NOTE',
          targetId: note.id
      });
  };
  
  const cycleColor = (e: React.MouseEvent) => {
      e.stopPropagation();
      const currentIndex = NOTE_COLORS.indexOf(note.color);
      const nextIndex = (currentIndex + 1) % NOTE_COLORS.length;
      changeColor(note.id, NOTE_COLORS[nextIndex]);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      toggleCollapse(note.id);
  };

  return (
    <Draggable
      nodeRef={nodeRef}
      handle=".drag-handle"
      defaultPosition={{ x: note.x, y: note.y }}
      position={{ x: note.x, y: note.y }}
      scale={scale}
      onStart={handleMouseDown}
      onDrag={handleDrag}
      onStop={handleStop}
      disabled={isStickyDragging}
    >
      <div
        ref={nodeRef}
        data-id={note.id}
        className={cn(
          "note-card absolute flex flex-col w-[260px]",
          note.collapsed ? "h-[36px] overflow-hidden" : "h-auto min-h-[100px]",
          "rounded-xl transition-all duration-200 ease-out",
          "shadow-sm hover:shadow-xl",
          "border border-black/5",
          "group",
          isStickyDragging && "shadow-2xl scale-[1.02] cursor-move z-[9999]",
          isSelected && !isStickyDragging && (selectedIds.length === 1 ? "border-2 border-white/80 shadow-sm" : "ring-2 ring-blue-500/50 border-blue-500/50")
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
                note.collapsed || isHovered || isEditing || note.title ? "opacity-100" : "opacity-0"
            )}
            onContextMenu={handleContextMenu}
            onDoubleClick={handleDoubleClick}
        >
          {/* Left: Palette */}
          <Tooltip content="切换颜色">
            <button
              onClick={cycleColor}
              className="p-1.5 rounded-md hover:bg-black/5 transition-colors text-black/40 hover:text-black/70 flex-shrink-0"
            >
               <Palette className="w-4 h-4" />
            </button>
          </Tooltip>
          
          {/* Center: Title (Collapsed) or Grip (Expanded) */}
          <div className="flex-1 flex justify-center cursor-grab active:cursor-grabbing h-full items-center px-2 overflow-hidden">
             {note.collapsed ? (
                 <Tooltip content="双击展开" delay={500}>
                    <span 
                        className={cn(
                            "text-sm font-bold truncate select-none w-full text-center block",
                            note.title ? "text-gray-800 opacity-90" : "text-gray-500 italic opacity-70"
                        )}
                    >
                        {displayTitle}
                    </span>
                 </Tooltip>
             ) : (
                <Tooltip content="双击折叠 / 拖拽移动" delay={1000}>
                    <GripHorizontal className="w-4 h-4 text-black/20" />
                </Tooltip>
             )}
          </div>

          {/* Right: Delete */}
          <Tooltip content="删除便签">
            <button
              onClick={(e) => {
                  e.stopPropagation();
                  deleteNote(note.id);
              }}
              className="p-1.5 rounded-md hover:bg-red-100 hover:text-red-500 transition-colors text-black/40 flex-shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </Tooltip>
        </div>

            {/* Expanded Content: Auto-Hiding Title Input + Textarea */}
        {!note.collapsed && (
            <div className="flex-1 pb-4 pt-0 flex flex-col gap-1 min-h-0 relative">
              {/* Explicit Title Input - Add padding here since parent lost it */}
              <div className="px-4">
                  <input 
                    ref={titleRef}
                    type="text"
                    className={cn(
                        "w-full bg-transparent outline-none transition-all duration-200 flex-shrink-0",
                        "text-gray-900 font-bold text-[16px]",
                        "placeholder-gray-400/50",
                        (!note.title && !isHovered && !isEditing) ? "hidden" : "block"
                    )}
                    placeholder="标题"
                    value={note.title}
                    onChange={(e) => updateTitle(note.id, e.target.value)}
                    onFocus={() => setIsEditing(true)}
                    onBlur={() => setIsEditing(false)}
                    onMouseDownCapture={handleMouseDown}
                />
              </div>
              
              {/* Content Textarea */}
              <textarea
                ref={textareaRef}
                className={cn(
                    "w-full resize-none bg-transparent outline-none px-4", // Add padding back here
                    "text-gray-800",
                    "placeholder-gray-400 font-normal text-[15px] leading-relaxed",
                    "selection:bg-black/10",
                    // Scrollbar styling - thin and rounded
                    "scrollbar-thin scrollbar-thumb-black/10 scrollbar-track-transparent hover:scrollbar-thumb-black/20",
                    "transition-all duration-300 ease-in-out" // Smooth height transition
                )}
                style={{
                    // Dynamic Height Logic:
                    // If selected or editing: Max 60vh, scrollable
                    // If inactive: Max 200px, hidden overflow (masked)
                    maxHeight: (isSelected || isEditing) ? '60vh' : '200px',
                    overflowY: (isSelected || isEditing) ? 'auto' : 'hidden',
                    
                    // Gradient Mask for inactive state
                    maskImage: (isSelected || isEditing) 
                        ? 'none' 
                        : 'linear-gradient(to bottom, black 0%, black 70%, transparent 100%)',
                    WebkitMaskImage: (isSelected || isEditing) 
                        ? 'none' 
                        : 'linear-gradient(to bottom, black 0%, black 70%, transparent 100%)'
                }}
                placeholder="记点什么..."
                value={note.content}
                onClick={handleTextareaClick}
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
        )}
      </div>
    </Draggable>
  );
};
