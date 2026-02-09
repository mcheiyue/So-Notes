import React, { useRef, useState, useLayoutEffect } from "react";
import Draggable, { DraggableData, DraggableEvent } from "react-draggable";
import { X, GripHorizontal, Palette, RotateCcw, Trash2 } from "lucide-react";
import { NOTE_COLORS } from "../store/types";
import { LAYOUT, Z_INDEX } from "../constants/layout";
import { useStore } from "../store/useStore";
import { useEdgePush } from "../hooks/useEdgePush";
import { cn } from "../utils/cn";
import { Tooltip } from "./Tooltip";

interface NoteCardProps {
  id: string;
  isStatic?: boolean;
  scale?: number;
}

export const NoteCard: React.FC<NoteCardProps> = React.memo(({ id, isStatic = false, scale = 1 }) => {
  // Selectors
  const note = useStore(state => state.notes.find(n => n.id === id));
  
  // Guard: If note doesn't exist
  if (!note) return null;

  const updateNote = useStore(state => state.updateNote);
  const updateTitle = useStore(state => state.updateTitle);
  const moveNote = useStore(state => state.moveNote);
  const moveSelectedNotes = useStore(state => state.moveSelectedNotes);
  const deleteNote = useStore(state => state.deleteNote);
  const bringToFront = useStore(state => state.bringToFront);
  const changeColor = useStore(state => state.changeColor);
  const toggleCollapse = useStore(state => state.toggleCollapse);
  const setContextMenu = useStore(state => state.setContextMenu);
  const toggleSelection = useStore(state => state.toggleSelection);
  const setSelectedIds = useStore(state => state.setSelectedIds);
  const restoreNote = useStore(state => state.restoreNote);
  const deleteNotePermanently = useStore(state => state.deleteNotePermanently);
  
  const isStickyDragging = useStore(state => state.stickyDrag.id === note.id);
  const isSelected = useStore(state => state.selectedIds.includes(note.id));
  const isGroupSelection = useStore(state => state.selectedIds.length > 1);
  const viewport = useStore(state => state.viewport);
  const isPanMode = useStore(state => state.interaction.isPanMode);
  
  // Custom Hooks
  const { checkEdge, clearEdge } = useEdgePush();

  // Refs & Local State
  const nodeRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  
  const [isHovered, setIsHovered] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  
  // Drag State (Hybrid Control)
  const isDragging = useRef(false);
  // We use dragPos to control position ONLY during drag to prevent jitter/re-renders
  // Initial value is null, meaning "use Store position"
  const [dragPos, setDragPos] = useState<{x: number, y: number} | null>(null);

  // Calculated Screen Position (from Store)
  const screenX = note.x - viewport.x;
  const screenY = note.y - viewport.y;

  // Determine Final Position for Draggable
  // If dragging, use local state (follows mouse, ignores viewport shift for stability)
  // If idle, use calculated screen position (follows viewport)
  const finalX = (isDragging.current && dragPos) ? dragPos.x : screenX;
  const finalY = (isDragging.current && dragPos) ? dragPos.y : screenY;

  // Derived Values
  const displayTitle = note.title || "无标题";

  // Auto-resize textarea
  useLayoutEffect(() => {
    if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [note.content, note.collapsed, isEditing]);

  const handleDrag = (_e: DraggableEvent, data: DraggableData) => {
      // 1. Sync Local State (Hybrid Control)
      if (!isDragging.current) isDragging.current = true;
      setDragPos({ x: data.x, y: data.y });

      // Group Drag Logic
      if (isSelected && isGroupSelection) {
          const deltaX = data.deltaX;
          const deltaY = data.deltaY;
          moveSelectedNotes(deltaX, deltaY, note.id);
      }

      // 2. Edge Push Logic (Delegated to Hook)
      const nW = nodeRef.current?.offsetWidth || LAYOUT.NOTE_WIDTH;
      const nH = nodeRef.current?.offsetHeight || LAYOUT.NOTE_MIN_HEIGHT;
      checkEdge(data.x, data.y, nW, nH);
  };
  
  const handleStop = (_e: DraggableEvent, data: DraggableData) => {
    isDragging.current = false;
    setDragPos(null); // Switch back to Store control
    
    // Cleanup Edge Push
    clearEdge();
    
    // Was this an edge push? If so, apply a small "bounce back" margin for physical feel
    // Check if we are currently at the edge (using the edge state is tricky as we just cleared it)
    // We check coordinates instead.
    
    const winW = viewport.w;
    const winH = viewport.h;
    const noteWidth = nodeRef.current?.offsetWidth || LAYOUT.NOTE_WIDTH;
    const noteHeight = nodeRef.current?.offsetHeight || LAYOUT.NOTE_MIN_HEIGHT;
    
    // Use data.x (final drag pos)
    let finalScreenX = data.x;
    let finalScreenY = data.y;

    // 1. Calculate World Coordinates
    let worldX = finalScreenX + viewport.x;
    let worldY = finalScreenY + viewport.y;

    // 2. Safe Mode: Viewport Constraints (Cage Mode)
    // Only applied when NOT in Pan Mode
    if (!isPanMode) {
        const MARGIN = 10;
        
        // Right / Bottom with Snapback Margin
        if (finalScreenX > winW - noteWidth) finalScreenX = winW - noteWidth - MARGIN;
        if (finalScreenY > winH - noteHeight) finalScreenY = winH - noteHeight - MARGIN;

        // Left / Top Hard Clamp
        if (finalScreenX < 0) finalScreenX = 0;
        if (finalScreenY < 0) finalScreenY = 0;
        
        // Recalculate World Coordinates based on clamped Screen Coordinates
        worldX = finalScreenX + viewport.x;
        worldY = finalScreenY + viewport.y;
    }

    // 3. HARD CONSTRAINT: World Origin (0,0) is impassable
    if (worldX < 0) worldX = 0;
    if (worldY < 0) worldY = 0;

    moveNote(note.id, worldX, worldY);

    // 4. Group Distributed Clamp
    if (isSelected && isGroupSelection) {
        const state = useStore.getState();
        state.selectedIds.forEach(id => {
            if (id === note.id) return;
            const n = state.notes.find(item => item.id === id);
            if (n) {
                let nWorldX = n.x;
                let nWorldY = n.y;
                let changed = false;

                // Hard Limit for Group Members
                if (nWorldX < 0) { nWorldX = 0; changed = true; }
                if (nWorldY < 0) { nWorldY = 0; changed = true; }

                if (changed) {
                    moveNote(id, nWorldX, nWorldY);
                }
            }
        });
    }
  };

  const handleMouseDown = (e: DraggableEvent) => {
    const mouseEvent = e as unknown as React.MouseEvent;
    if (useStore.getState().stickyDrag.id) return;

    if (mouseEvent.ctrlKey || mouseEvent.shiftKey) {
        toggleSelection(note.id);
        mouseEvent.stopPropagation(); 
        return;
    }

    if (!isSelected) {
        setSelectedIds([note.id]);
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

  const handleTextareaClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      // Allow focus
  };

  return (
      <Draggable
        nodeRef={nodeRef}
        handle=".drag-handle"
        defaultPosition={undefined} // Controlled via position prop
        position={{ x: finalX, y: finalY }}
        scale={scale}
        onStart={(e) => {
            isDragging.current = true;
            handleMouseDown(e);
        }}
        onDrag={handleDrag}
        onStop={handleStop}
        disabled={isStickyDragging || isStatic}
      >
      <div
        ref={nodeRef}
        data-id={note.id}
          className={cn(
          "note-card absolute flex flex-col",
          note.collapsed ? "overflow-hidden" : "h-auto",
          "rounded-xl transition-all duration-200 ease-out",
          "shadow-sm hover:shadow-xl",
          "border border-black/5",
          "group",
          isStickyDragging && "shadow-2xl scale-[1.02] cursor-move",
          isSelected && !isStickyDragging && (isGroupSelection ? "ring-2 ring-blue-500/50 border-blue-500/50" : "border-2 border-white/80 shadow-sm"),
          isStatic && "relative !transform-none !left-auto !top-auto opacity-90 grayscale-[0.1] hover:grayscale-0 pointer-events-auto"
        )}
        style={{ 
            width: LAYOUT.NOTE_WIDTH,
            height: note.collapsed ? LAYOUT.NOTE_COLLAPSED_HEIGHT : 'auto',
            minHeight: note.collapsed ? undefined : LAYOUT.NOTE_MIN_HEIGHT,
            backgroundColor: note.color,
            zIndex: isStickyDragging ? Z_INDEX.NOTE_DRAGGING : (isStatic ? undefined : note.z),
        }}
        onMouseDownCapture={handleMouseDown}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <div 
            className={cn(
                "drag-handle h-9 flex items-center justify-between px-3 pt-1 cursor-grab active:cursor-grabbing",
                "transition-opacity duration-200",
                note.collapsed || isHovered || isEditing || note.title ? "opacity-100" : "opacity-0",
                isStatic && "!cursor-default"
            )}
            onContextMenu={handleContextMenu}
            onDoubleClick={isStatic ? undefined : handleDoubleClick}
        >
          {/* Left: Palette or Restore */}
          {isStatic ? (
              <Tooltip content="还原笔记">
                  <button
                    onClick={(e) => {
                        e.stopPropagation();
                        restoreNote(note.id);
                    }}
                    className="p-1.5 rounded-md hover:bg-green-100 hover:text-green-600 transition-colors text-black/40 flex-shrink-0"
                  >
                      <RotateCcw className="w-4 h-4" />
                  </button>
              </Tooltip>
          ) : (
            <Tooltip content="切换颜色" disabled={isStickyDragging}>
                <button
                onClick={cycleColor}
                className="p-1.5 rounded-md hover:bg-black/5 transition-colors text-black/40 hover:text-black/70 flex-shrink-0"
                >
                <Palette className="w-4 h-4" />
                </button>
            </Tooltip>
          )}
          
          {/* Center: Title or Grip */}
          <div className="flex-1 flex justify-center cursor-grab active:cursor-grabbing h-full items-center px-2 overflow-hidden">
             {note.collapsed ? (
                 <Tooltip content="双击展开" delay={500} disabled={isStickyDragging || isStatic}>
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
                <Tooltip content="双击折叠 / 拖拽移动" delay={1000} disabled={isStickyDragging || isStatic}>
                    <GripHorizontal className={cn("w-4 h-4 text-black/20", isStatic && "opacity-0")} />
                </Tooltip>
             )}
          </div>

          {/* Right: Delete */}
          <Tooltip content={isStatic ? "永久删除" : "删除便签"} disabled={isStickyDragging}>
            <button
              onClick={(e) => {
                  e.stopPropagation();
                  if (isStatic) {
                      if (window.confirm("确定要永久删除吗？无法找回。")) {
                          deleteNotePermanently(note.id);
                      }
                  } else {
                      deleteNote(note.id);
                  }
              }}
              className="p-1.5 rounded-md hover:bg-red-100 hover:text-red-500 transition-colors text-black/40 flex-shrink-0"
            >
              {isStatic ? <Trash2 className="w-4 h-4" /> : <X className="w-4 h-4" />}
            </button>
          </Tooltip>
        </div>

        {/* Content */}
        {!note.collapsed && (
            <div className="flex-1 pb-4 pt-0 flex flex-col gap-1 min-h-0 relative">
              <div className="px-4">
                  <input 
                    ref={titleRef}
                    type="text"
                    className={cn(
                        "w-full bg-transparent outline-none transition-all duration-200 flex-shrink-0",
                        "text-gray-900 font-bold text-[16px]",
                        "placeholder-gray-400/50",
                        (!note.title && !isHovered && !isEditing) ? "hidden" : "block",
                        isStatic && "pointer-events-none"
                    )}
                    placeholder="标题"
                    value={note.title}
                    onChange={(e) => updateTitle(note.id, e.target.value)}
                    onFocus={() => setIsEditing(true)}
                    onBlur={() => setIsEditing(false)}
                    onMouseDownCapture={handleMouseDown}
                    readOnly={isStatic}
                />
              </div>
              
              <textarea
                ref={textareaRef}
                className={cn(
                    "w-full resize-none bg-transparent outline-none px-4",
                    "text-gray-800",
                    "placeholder-gray-400 font-normal text-[15px] leading-relaxed",
                    "selection:bg-black/10",
                    "scrollbar-thin scrollbar-thumb-black/10 scrollbar-track-transparent hover:scrollbar-thumb-black/20",
                    "transition-all duration-300 ease-in-out"
                )}
                style={{
                    maxHeight: (isSelected || isEditing) ? '60vh' : '200px',
                    overflowY: (isSelected || isEditing) ? 'auto' : 'hidden',
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
                readOnly={isStatic}
              />
            </div>
        )}
      </div>
    </Draggable>
  );
});

NoteCard.displayName = "NoteCard";