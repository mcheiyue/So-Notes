import React, { useRef, useState, useLayoutEffect } from "react";
import Draggable, { DraggableData, DraggableEvent } from "react-draggable";
import { X, GripHorizontal, Palette, RotateCcw, Trash2, Copy, Check } from "lucide-react";
import { NOTE_COLORS, getNoteColor } from "../store/types";
import { LAYOUT, Z_INDEX } from "../constants/layout";
import { useStore } from "../store/useStore";
import { useEdgePush } from "../hooks/useEdgePush";
import { useDarkMode } from "../hooks/useDarkMode";
import { cn } from "../utils/cn";
import { Tooltip } from "./Tooltip";

interface NoteCardProps {
  id: string;
  isStatic?: boolean;
  scale?: number;
}

export const NoteCard: React.FC<NoteCardProps> = React.memo(({ id, isStatic = false, scale = 1 }) => {
  // Selectors
  const note = useStore(state => state.notesById[id]);

  const updateNote = useStore(state => state.updateNote);
  const updateTitle = useStore(state => state.updateTitle);
  const moveNote = useStore(state => state.moveNote);
  const moveSelectedNotes = useStore(state => state.moveSelectedNotes);
  const finalizeLayoutChange = useStore(state => state.finalizeLayoutChange);
  const deleteNote = useStore(state => state.deleteNote);
  const bringToFront = useStore(state => state.bringToFront);
  const changeColor = useStore(state => state.changeColor);
  const toggleCollapse = useStore(state => state.toggleCollapse);
  const setContextMenu = useStore(state => state.setContextMenu);
  const toggleSelection = useStore(state => state.toggleSelection);
  const setSelectedIds = useStore(state => state.setSelectedIds);
  const restoreNote = useStore(state => state.restoreNote);
  const deleteNotePermanently = useStore(state => state.deleteNotePermanently);
  const setIsDragging = useStore(state => state.setIsDragging);
  
  const isStickyDragging = useStore(state => state.stickyDrag.id === id);
  const isSelected = useStore(state => state.selectedIds.includes(id));
  const isGroupSelection = useStore(state => state.selectedIds.length > 1);
  const viewport = useStore(state => state.viewport);
  const isPanMode = useStore(state => state.interaction.isPanMode);
  const isGlobalDragging = useStore(state => state.interaction.isDragging);
  const isDarkMode = useDarkMode();
  
  // Custom Hooks
  const { checkEdge, clearEdge } = useEdgePush();

  // Refs & Local State
  const nodeRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  
  const [isHovered, setIsHovered] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  
  // Drag State (Hybrid Control)
  const isDragging = useRef(false);
  const groupBoundsRef = useRef<{ minX: number, minY: number, width: number, height: number } | null>(null);
  const shouldFinalizeOnMouseUpRef = useRef(false);

  // dragPos ref: tracks drag status without triggering React re-renders
  // react-draggable handles DOM transforms directly during drag
  const dragPosRef = useRef(false);

  // Calculated Screen Position (from Store)
  const screenX = note ? note.x - viewport.x : 0;
  const screenY = note ? note.y - viewport.y : 0;

  // Auto-resize textarea
  useLayoutEffect(() => {
    if (note && textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [note, note?.content, note?.collapsed]);

  if (!note) return null;

  // Derived Values
  const displayTitle = note.title || "无标题";
  const shouldShowHeaderChrome = note.collapsed || isHovered || isEditing;
  const shouldShowBodyTitle = !note.collapsed && (Boolean(note.title) || isHovered || isEditing);
  const shouldRenderCopyButton = !isStatic && !note.collapsed && (isHovered || isEditing);
  const shouldShowExpandedActions = !isStatic && !note.collapsed && (isHovered || isEditing);
  const shouldShowCollapsedActions = note.collapsed && !isStatic;
  const shouldExpandContent = isEditing || (isSelected && !isGlobalDragging);
  const disableHeaderTooltips = isStickyDragging || dragPosRef.current;
  const disableCollapseTooltip = disableHeaderTooltips || isStatic;

  const handleStart = () => {
      isDragging.current = true;
      setIsDragging(true);
      shouldFinalizeOnMouseUpRef.current = false;

      if (isSelected && isGroupSelection) {
          const state = useStore.getState();
          const selectedNotes = state.selectedIds.flatMap((selectedId) => {
              const selectedNote = state.notesById[selectedId];
              return selectedNote ? [selectedNote] : [];
          });
          
          if (selectedNotes.length > 0) {
              let minX = Infinity, minY = Infinity;
              let maxX = -Infinity, maxY = -Infinity;
              
              const leaderX = note.x;
              const leaderY = note.y;

              selectedNotes.forEach(n => {
                  const nW = n.width || LAYOUT.NOTE_WIDTH;
                  const nH = n.height || (n.collapsed ? LAYOUT.NOTE_COLLAPSED_HEIGHT : LAYOUT.NOTE_MIN_HEIGHT);
                  
                  const relX = n.x - leaderX;
                  const relY = n.y - leaderY;
                  
                  if (relX < minX) minX = relX;
                  if (relY < minY) minY = relY;
                  if (relX + nW > maxX) maxX = relX + nW;
                  if (relY + nH > maxY) maxY = relY + nH;
              });
              
              groupBoundsRef.current = {
                  minX,
                  minY,
                  width: maxX - minX,
                  height: maxY - minY
              };
          }
      } else {
          groupBoundsRef.current = null;
      }
  };

  const handleDrag = (_e: DraggableEvent, data: DraggableData) => {
      if (!isDragging.current) isDragging.current = true;
      dragPosRef.current = true;

      if (isSelected && isGroupSelection) {
          const deltaX = data.deltaX;
          const deltaY = data.deltaY;
          moveSelectedNotes(deltaX, deltaY, note.id);
      }

      // 2. Edge Push Logic (Delegated to Hook)
      let checkX = data.x;
      let checkY = data.y;
      let checkW = nodeRef.current?.offsetWidth || LAYOUT.NOTE_WIDTH;
      let checkH = nodeRef.current?.offsetHeight || LAYOUT.NOTE_MIN_HEIGHT;

      // Use Group Bounding Box if available
      if (groupBoundsRef.current) {
          checkX = data.x + groupBoundsRef.current.minX;
          checkY = data.y + groupBoundsRef.current.minY;
          checkW = groupBoundsRef.current.width;
          checkH = groupBoundsRef.current.height;
      }

      checkEdge(checkX, checkY, checkW, checkH);
  };
  
  const handleStop = (_e: DraggableEvent, data: DraggableData) => {
    isDragging.current = false;
    dragPosRef.current = false;
    setIsDragging(false);
    
    // Cleanup Edge Push
    clearEdge();
    
    // Was this an edge push? If so, apply a small "bounce back" margin for physical feel
    // Check if we are currently at the edge (using the edge state is tricky as we just cleared it)
    // We check coordinates instead.
    
    const winW = viewport.w;
    const winH = viewport.h;
    const noteWidth = nodeRef.current?.offsetWidth || LAYOUT.NOTE_WIDTH;
    const noteHeight = nodeRef.current?.offsetHeight || LAYOUT.NOTE_MIN_HEIGHT;
    const MARGIN = 10;
    
    // Use data.x (final drag pos)
    let finalScreenX = data.x;
    let finalScreenY = data.y;

    // 1. Calculate World Coordinates
    let worldX = finalScreenX + viewport.x;
    let worldY = finalScreenY + viewport.y;

    // 2. Safe Mode: Viewport Constraints (Cage Mode)
    // Only applied when NOT in Pan Mode
    if (!isPanMode) {
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

    const affectedIds = (isSelected && isGroupSelection)
      ? [...useStore.getState().selectedIds]
      : [note.id];

    // 4. Group Distributed Clamp
    if (isSelected && isGroupSelection) {
        const state = useStore.getState();
        state.selectedIds.forEach(id => {
            if (id === note.id) return;
            const n = state.notesById[id];
            if (n) {
                let nWorldX = n.x;
                let nWorldY = n.y;
                let changed = false;

                // Hard Limit for Group Members (Absolute World 0,0)
                if (nWorldX < 0) { nWorldX = 0; changed = true; }
                if (nWorldY < 0) { nWorldY = 0; changed = true; }

                // Viewport Constraints (Independent Clamp)
                // Only if NOT in Pan Mode
                if (!isPanMode) {
                    // Right Limit
                    const maxWorldX = viewport.x + winW - (n.width || LAYOUT.NOTE_WIDTH) - MARGIN;
                    if (nWorldX > maxWorldX) { nWorldX = maxWorldX; changed = true; }

                    // Bottom Limit
                    if (n.height) {
                        const maxWorldY = viewport.y + winH - n.height - MARGIN;
                        if (nWorldY > maxWorldY) { nWorldY = maxWorldY; changed = true; }
                    }

                    // Left Limit (Viewport)
                    if (nWorldX < viewport.x) { nWorldX = viewport.x; changed = true; }
                    
                    // Top Limit (Viewport)
                    if (nWorldY < viewport.y) { nWorldY = viewport.y; changed = true; }
                }

                if (changed) {
                    moveNote(id, nWorldX, nWorldY);
                }
            }
        });
    }

    finalizeLayoutChange(affectedIds);
  };

  const handleMouseDown = (e: DraggableEvent) => {
    const mouseEvent = e as unknown as React.MouseEvent;
    if (useStore.getState().stickyDrag.id) return;

    const targetElement = mouseEvent.target instanceof Element ? mouseEvent.target : null;
    const clickedHeaderAction = !!targetElement?.closest('.note-action');
    const clickedDragSurface = !!targetElement?.closest('.drag-handle');

    if (mouseEvent.ctrlKey || mouseEvent.shiftKey) {
        toggleSelection(note.id);
        mouseEvent.stopPropagation(); 
        return;
    }

    if (clickedHeaderAction || clickedDragSurface) {
        bringToFront(note.id);
        shouldFinalizeOnMouseUpRef.current = false;
        return;
    }

    if (!isSelected) {
        setSelectedIds([note.id]);
    }
    
    bringToFront(note.id);
    shouldFinalizeOnMouseUpRef.current = true;
  };

  const handleMouseUpCapture = () => {
    if (!shouldFinalizeOnMouseUpRef.current) return;

    shouldFinalizeOnMouseUpRef.current = false;
    finalizeLayoutChange([note.id]);
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
      if (isGlobalDragging) return;
      const currentIndex = NOTE_COLORS.indexOf(note.color);
      const nextIndex = (currentIndex + 1) % NOTE_COLORS.length;
      changeColor(note.id, NOTE_COLORS[nextIndex]);
  };

  const handleCollapseToggle = () => {
      if (isGlobalDragging) return;
      toggleCollapse(note.id);
  };

  const handleHeaderDoubleClick = (e: React.MouseEvent) => {
      if (isGlobalDragging) return;
      const targetElement = e.target instanceof Element ? e.target : null;
      if (!targetElement?.closest('.drag-handle')) return;
      if (targetElement?.closest('.note-action')) return;
      handleCollapseToggle();
  };

  const handleTextareaClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      // Allow focus
  };

  const handleCopy = async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (isGlobalDragging) return;
      try {
        await navigator.clipboard.writeText(note.title ? `${note.title}\n${note.content}` : note.content);
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 2000);
      } catch (err) {
        console.error('Failed to copy note:', err);
      }
  };

  return (
      <Draggable
        nodeRef={nodeRef}
        handle=".drag-handle"
        cancel={'.note-action, input, textarea, [data-note-no-drag="true"]'}
        position={{ x: screenX, y: screenY }}
        scale={scale}
        onStart={handleStart}
        onDrag={handleDrag}
        onStop={handleStop}
        disabled={isStickyDragging || isStatic}
      >
      <article
         ref={nodeRef}
          data-id={note.id}
          data-canvas-hit="blocked"
          className={cn(
          "note-card absolute flex flex-col",
          note.collapsed ? "overflow-hidden" : "h-auto",
          "rounded-xl transition-all duration-200 ease-out",
          "shadow-sm hover:shadow-xl dark:hover:bg-white/5",
          "backdrop-blur-2xl backdrop-saturate-[1.8]",
          "border border-border-subtle dark:border-white/10",
          "group",
          isStickyDragging && "shadow-2xl scale-[1.02] cursor-move",
          isSelected && !isStickyDragging && (
            isGroupSelection
              ? "ring-2 ring-blue-500/55 dark:ring-blue-300/60 border-blue-500/60 dark:border-blue-300/55 shadow-[0_0_0_1px_rgba(59,130,246,0.12)] dark:shadow-[0_0_0_1px_rgba(191,219,254,0.18)]"
              : "ring-2 ring-blue-500/30 dark:ring-blue-300/45 border-blue-500/40 dark:border-blue-300/45 shadow-[0_0_0_1px_rgba(59,130,246,0.08)] dark:shadow-[0_0_0_1px_rgba(191,219,254,0.14)]"
          ),
          isStatic && "relative !transform-none !left-auto !top-auto opacity-90 grayscale-[0.1] hover:grayscale-0 pointer-events-auto",
          isPanMode && "pointer-events-none"
        )}
        style={{ 
            width: LAYOUT.NOTE_WIDTH,
            height: note.collapsed ? LAYOUT.NOTE_COLLAPSED_HEIGHT : 'auto',
            minHeight: note.collapsed ? undefined : LAYOUT.NOTE_MIN_HEIGHT,
            backgroundColor: getNoteColor(note.color, isDarkMode),
            zIndex: isStickyDragging ? Z_INDEX.NOTE_DRAGGING : (isStatic ? undefined : note.z),
        }}
        onMouseDownCapture={handleMouseDown}
        onMouseUpCapture={handleMouseUpCapture}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onContextMenu={handleContextMenu}
        onDoubleClick={handleHeaderDoubleClick}
      >
        <header 
            className={cn(
                "drag-handle relative h-9 flex items-center justify-between px-2 pt-1 select-none",
                isStatic ? "cursor-default" : "cursor-grab active:cursor-grabbing",
                "transition-opacity duration-200",
                shouldShowHeaderChrome ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
            )}
        >
          {(!note.collapsed || isStatic) && (
          <div className={cn("flex items-center gap-0.5 z-20", !shouldShowExpandedActions && !isStatic && "pointer-events-none opacity-0") }>
            {isStatic ? (
                <Tooltip content="还原笔记">
                    <button
                      type="button"
                      className="note-action p-1.5 rounded-md hover:bg-green-100 dark:hover:bg-green-900/20 hover:text-green-600 transition-colors text-text-tertiary flex-shrink-0"
                      aria-label="还原笔记"
                      onClick={(e) => {
                            e.stopPropagation();
                            restoreNote(note.id);
                        }}
                    >
                        <RotateCcw className="w-4 h-4" />
                    </button>
                </Tooltip>
            ) : (
                <Tooltip content="切换颜色" disabled={disableHeaderTooltips}>
                    <button
                      type="button"
                      className="note-action p-1.5 rounded-md hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-text-tertiary hover:text-text-secondary flex-shrink-0"
                      aria-label="切换颜色"
                      onClick={cycleColor}
                    >
                      <Palette className="w-4 h-4" />
                    </button>
                </Tooltip>
            )}

            {shouldRenderCopyButton && (
                <Tooltip content={isCopied ? "已复制" : "复制内容"} disabled={disableHeaderTooltips}>
                    <button
                        type="button"
                        className={cn(
                            "note-action p-1.5 rounded-md transition-all duration-200 flex-shrink-0",
                            isCopied 
                                ? "text-text-secondary" 
                                : "hover:bg-black/5 dark:hover:bg-white/5 text-text-tertiary hover:text-text-secondary"
                        )}
                        aria-label="复制内容"
                        onClick={handleCopy}
                    >
                        {isCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                </Tooltip>
            )}
          </div>
          )}

          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
            {note.collapsed ? (
              <div className="flex w-full justify-center px-10">
                <Tooltip content="双击展开" delay={500} disabled={disableCollapseTooltip}>
                  <span
                    className={cn(
                      "pointer-events-auto block max-w-full truncate rounded-md px-2 py-1 text-center text-sm font-bold select-none",
                      note.title ? "text-text-primary" : "text-text-secondary italic opacity-70"
                    )}
                  >
                    {displayTitle}
                  </span>
                </Tooltip>
              </div>
            ) : (
              <div className="pointer-events-auto px-2 max-w-[60%] flex justify-center">
                <Tooltip content="拖拽移动" delay={1000} disabled={disableHeaderTooltips || isStatic}>
                  <GripHorizontal
                    className={cn(
                      "w-4 h-4 text-text-tertiary transition-colors",
                      isStatic ? "opacity-0" : "group-hover:text-text-secondary"
                    )}
                    aria-hidden="true"
                  />
                </Tooltip>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-0.5 z-20">
            <Tooltip content={isStatic ? "永久删除" : "删除便签"} disabled={disableHeaderTooltips}>
                <button
                  type="button"
                  className={cn(
                    "note-action p-1.5 rounded-md hover:bg-red-100 dark:hover:bg-red-900/20 hover:text-red-500 transition-colors text-text-tertiary flex-shrink-0",
                    !isStatic && !shouldShowCollapsedActions && !shouldShowExpandedActions && "pointer-events-none opacity-0"
                  )}
                  aria-label={isStatic ? "永久删除" : "删除便签"}
                  onClick={(e) => {
                      e.stopPropagation();
                      if (isGlobalDragging) return;
                      if (isStatic) {
                          if (window.confirm("确定要永久删除吗？无法找回。")) {
                              deleteNotePermanently(note.id);
                          }
                      } else {
                          deleteNote(note.id);
                      }
                  }}
                >
                  {isStatic ? <Trash2 className="w-4 h-4" /> : <X className="w-4 h-4" />}
                </button>
            </Tooltip>
          </div>
        </header>

        {/* Content */}
        {!note.collapsed && (
            <div className="flex-1 pb-4 pt-0 flex flex-col gap-1 min-h-0 relative">
              <div className="px-4">
                  <input 
                    ref={titleRef}
                    type="text"
                    className={cn(
                        "w-full bg-transparent outline-none transition-all duration-200 flex-shrink-0",
                        "text-text-primary font-bold text-[16px]",
                        "placeholder-text-secondary/50 dark:placeholder-text-secondary/75",
                        "selection:bg-blue-500/20 dark:selection:bg-blue-200/35",
                        shouldShowBodyTitle ? "block" : "hidden",
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
                    "text-text-secondary dark:text-text-primary",
                    "placeholder-text-tertiary dark:placeholder-text-secondary/75 font-normal text-[15px] leading-relaxed",
                    "selection:bg-blue-500/20 dark:selection:bg-blue-200/35",
                    "scrollbar-thin scrollbar-thumb-text-tertiary/20 scrollbar-track-transparent hover:scrollbar-thumb-text-secondary/20",
                    "transition-all duration-300 ease-in-out"
                )}
                style={{
                    maxHeight: shouldExpandContent ? '60vh' : '200px',
                    overflowY: shouldExpandContent ? 'auto' : 'hidden',
                    maskImage: shouldExpandContent 
                        ? 'none' 
                        : 'linear-gradient(to bottom, black 0%, black 70%, transparent 100%)',
                    WebkitMaskImage: shouldExpandContent 
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
      </article>
    </Draggable>
  );
});

NoteCard.displayName = "NoteCard";
