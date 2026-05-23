import React, { useRef, useState, useLayoutEffect, useEffect } from "react";
import { DraggableCore, DraggableEvent } from "react-draggable";
import { X, GripHorizontal, Palette, RotateCcw, Trash2, Copy, Check } from "lucide-react";
import { NOTE_COLORS, getNoteColor, getNoteDarkSpectrum } from "../store/types";
import { LAYOUT, Z_INDEX } from "../constants/layout";
import { useStore } from "../store/useStore";
import { useEdgePush } from "../hooks/useEdgePush";
import { useDarkMode } from "../hooks/useDarkMode";
import { cn } from "../utils/cn";
import { Tooltip } from "./Tooltip";
import { registerNoteElement, unregisterNoteElement } from "../utils/noteElementRegistry";
import { getEdgeCheckRect, resolveDragStopWorldPosition } from "../utils/dragCoordinates";
import { finalizeActiveNoteDrag, registerActiveNoteDragFinalizer, unregisterActiveNoteDragFinalizer } from "../utils/activeNoteDrag";
import {
  beginEdgePushDragSession,
  setEdgePushDragLeader,
  updateEdgePushPointerFromClient,
  getEffectiveLeaderPosition,
  getEdgePushDragSessionNoteIds,
  getEdgePushDragSessionPosition,
  applyActiveDragSessionTransforms,
} from "../utils/edgePushDragCompensation";

interface NoteCardProps {
  id: string;
  isStatic?: boolean;
  scale?: number;
}

const getClientPoint = (event: DraggableEvent): { x: number; y: number } | null => {
  if ('clientX' in event && 'clientY' in event) {
    return { x: event.clientX, y: event.clientY };
  }

  const touchEvent = event as TouchEvent;
  const touch = touchEvent.touches[0] ?? touchEvent.changedTouches[0];
  return touch ? { x: touch.clientX, y: touch.clientY } : null;
};

function hexToRgbChannels(hex: string): { red: number; green: number; blue: number } {
  const normalized = hex.replace('#', '');
  const expanded = normalized.length === 3
    ? normalized
        .split('')
        .map((channel) => `${channel}${channel}`)
        .join('')
    : normalized;

  if (expanded.length !== 6) {
    return { red: 59, green: 130, blue: 246 };
  }

  const red = Number.parseInt(expanded.slice(0, 2), 16);
  const green = Number.parseInt(expanded.slice(2, 4), 16);
  const blue = Number.parseInt(expanded.slice(4, 6), 16);

  if (Number.isNaN(red) || Number.isNaN(green) || Number.isNaN(blue)) {
    return { red: 59, green: 130, blue: 246 };
  }

  return { red, green, blue };
}

function toRgba(hex: string, alpha: number): string {
  const { red, green, blue } = hexToRgbChannels(hex);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function buildNoteSurfaceBackground(
  isDark: boolean,
  accentHex: string,
  isEmphasized: boolean,
): string {
  if (!isDark) {
    return 'linear-gradient(180deg, rgba(255,255,255,0.3) 0%, rgba(255,255,255,0) 50%)';
  }

  const radialLead = isEmphasized ? 0.28 : 0.22;
  const radialMid = isEmphasized ? 0.1 : 0.075;

  return [
    `radial-gradient(138% 112% at 15% 0%, ${toRgba(accentHex, radialLead)} 0%, ${toRgba(accentHex, radialMid)} 36%, ${toRgba(accentHex, 0.018)} 62%, transparent 82%)`,
    'linear-gradient(155deg, rgba(255,255,255,0.11) 0%, rgba(255,255,255,0.034) 20%, transparent 54%)',
    'linear-gradient(180deg, rgba(255,255,255,0.038) 0%, rgba(0,0,0,0.045) 76%, rgba(0,0,0,0.15) 100%)',
  ].join(', ');
}

function getDarkBorderColor(
  accentHex: string,
  fallbackBorder: string,
  isActive: boolean,
  isDragging: boolean,
  isSelected: boolean,
  isGroupSelection: boolean,
): string {
  if (isDragging) {
    return toRgba(accentHex, 0.64);
  }

  if (isSelected) {
    return toRgba(accentHex, isGroupSelection ? 0.58 : 0.48);
  }

  if (isActive) {
    return toRgba(accentHex, 0.4);
  }

  return fallbackBorder;
}

function buildNoteMaterialShadow(
  isDark: boolean,
  accentHex: string,
  isActive: boolean,
  isDragging: boolean,
  isSelected: boolean,
  isGroupSelection: boolean,
): string {
  if (!isDark) {
    const inset = isActive
      ? 'inset 0 1px 1px rgba(255,255,255,0.4)'
      : 'inset 0 1px 1px rgba(255,255,255,0.3)';
    const outer = isDragging
      ? '0 12px 24px rgba(0,0,0,0.08)'
      : isActive
        ? '0 4px 14px rgba(0,0,0,0.08)'
        : '0 2px 8px rgba(0,0,0,0.05)';

    let shadow = `${inset}, ${outer}`;

    if (isSelected && !isDragging) {
      const ringColor = isGroupSelection ? 'rgba(59,130,246,0.55)' : 'rgba(59,130,246,0.3)';
      const glowColor = isGroupSelection ? 'rgba(59,130,246,0.12)' : 'rgba(59,130,246,0.08)';
      shadow += `, 0 0 0 2px ${ringColor}, 0 0 0 1px ${glowColor}`;
    }

    return shadow;
  }

  const outer = isDragging
    ? '0 14px 30px -14px rgba(0,0,0,0.82)'
    : isActive || isSelected
      ? '0 10px 24px -12px rgba(0,0,0,0.78)'
      : '0 8px 20px -12px rgba(0,0,0,0.72)';

  const accentEdgeAlpha = isDragging
    ? 0.18
    : isSelected
      ? (isGroupSelection ? 0.2 : 0.14)
      : isActive
        ? 0.1
        : 0.035;

  const accentGlowAlpha = isDragging
    ? 0.28
    : isSelected
      ? (isGroupSelection ? 0.36 : 0.28)
      : isActive
        ? 0.22
        : 0;

  const layers = [
    `inset 0 1px 0 ${isActive || isSelected ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.14)'}`,
    'inset 1px 0 0 rgba(255,255,255,0.045)',
    'inset 0 -1px 0 rgba(0,0,0,0.3)',
    outer,
    `0 0 0 1px ${toRgba(accentHex, accentEdgeAlpha)}`,
  ];

  if (accentGlowAlpha > 0) {
    layers.push(`0 0 24px -10px ${toRgba(accentHex, accentGlowAlpha)}`);
  }

  return layers.join(', ');
}

export const NoteCard: React.FC<NoteCardProps> = React.memo(({ id, isStatic = false, scale = 1 }) => {
  // Selectors
  const note = useStore(state => state.notesById[id]);

  const updateNote = useStore(state => state.updateNote);
  const updateTitle = useStore(state => state.updateTitle);
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
  const isPanMode = useStore(state => state.interaction.isPanMode);
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
  const [isDragActive, setIsDragActive] = useState(false);
  
  // Drag State (Hybrid Control)
  const isDragging = useRef(false);
  const groupBoundsRef = useRef<{ minX: number, minY: number, width: number, height: number } | null>(null);
  const shouldFinalizeOnMouseUpRef = useRef(false);

  // dragPos ref: tracks drag status without triggering React re-renders
  // react-draggable handles DOM transforms directly during drag
  const dragPosRef = useRef(false);

  // P0: 缓存 DOM 引用，避免组拖拽时每帧 querySelector
  const noteId = note?.id;
  useEffect(() => {
    const el = nodeRef.current;
    if (el && noteId) {
      registerNoteElement(noteId, el);
      return () => {
        if (isDragging.current) {
          finalizeActiveNoteDrag('unmount');
        }
        unregisterNoteElement(noteId);
      };
    }
  }, [noteId]);

  // 窗口失焦或标签页隐藏时，指针可能不会触发离开事件，需要兜底清除悬浮态。
  useEffect(() => {
    const clearHover = () => setIsHovered(false);
    window.addEventListener('blur', clearHover);
    document.addEventListener('visibilitychange', clearHover);
    return () => {
      window.removeEventListener('blur', clearHover);
      document.removeEventListener('visibilitychange', clearHover);
    };
  }, []);

  const worldX = note ? note.x : 0;
  const worldY = note ? note.y : 0;
  const darkSpectrum = getNoteDarkSpectrum(note?.color ?? '#FFFFFF');

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
  const shouldExpandContent = isEditing || isSelected;
  const disableHeaderTooltips = isStickyDragging || isDragActive;
  const disableCollapseTooltip = disableHeaderTooltips || isStatic;
  const isHoverActive = isHovered && !isDragActive && !isPanMode && !isStickyDragging;
  const isMaterialAccentActive = isHoverActive || isDragActive || isStickyDragging || isSelected;
  const darkBorderColor = getDarkBorderColor(
    darkSpectrum.accent,
    darkSpectrum.border,
    isHoverActive,
    isDragActive || isStickyDragging,
    isSelected,
    isGroupSelection,
  );

  const handleFinalizeDragSession = (reason: 'stop' | 'window-blur' | 'switch-board' | 'unmount') => {
    if (!isDragging.current) return;

    const shouldUpdateLocalState = reason !== 'unmount';
    const sessionIds = getEdgePushDragSessionNoteIds();
    const sessionPositions = Object.fromEntries(
      sessionIds.flatMap((sessionId) => {
        const sessionPosition = getEdgePushDragSessionPosition(sessionId);
        return sessionPosition ? [[sessionId, sessionPosition]] : [];
      }),
    );
    const effectivePos = getEffectiveLeaderPosition();
    const dragIds = sessionIds.length > 0 ? sessionIds : [note.id];
    const viewport = useStore.getState().viewport;
    const noteWidth = nodeRef.current?.offsetWidth || LAYOUT.NOTE_WIDTH;
    const noteHeight = nodeRef.current?.offsetHeight || LAYOUT.NOTE_MIN_HEIGHT;
    const margin = 10;

    const finalPosition = resolveDragStopWorldPosition(
      effectivePos.x,
      effectivePos.y,
      viewport,
      noteWidth,
      noteHeight,
      isPanMode,
      margin,
    );

    isDragging.current = false;
    dragPosRef.current = false;
    shouldFinalizeOnMouseUpRef.current = false;
    if (shouldUpdateLocalState) {
      setIsDragActive(false);
      setIsHovered(false);
    }
    setIsDragging(false);
    document.body.classList.remove('is-dragging');
    clearEdge();
    setEdgePushDragLeader(null);
    unregisterActiveNoteDragFinalizer(handleFinalizeDragSession);

    useStore.setState((state) => {
      dragIds.forEach((id) => {
        const n = state.notesById[id];
        if (!n) return;

        const rawPosition = id === note.id
          ? finalPosition
          : sessionPositions[id];
        if (!rawPosition) return;

        const resolvedPosition = id === note.id
          ? finalPosition
          : resolveDragStopWorldPosition(
              rawPosition.x,
              rawPosition.y,
              viewport,
              n.width || LAYOUT.NOTE_WIDTH,
              n.height || (n.collapsed ? LAYOUT.NOTE_COLLAPSED_HEIGHT : LAYOUT.NOTE_MIN_HEIGHT),
              isPanMode,
              margin,
            );

        n.x = resolvedPosition.x;
        n.y = resolvedPosition.y;
        state.layoutNotesById[id] = { id: n.id, x: n.x, y: n.y, boardId: n.boardId, deletedAt: n.deletedAt ?? null, color: n.color, width: n.width, height: n.height };
      });
    });

    finalizeLayoutChange(dragIds);
  };

  const handleStart = (e: DraggableEvent) => {
      isDragging.current = true;
      setIsDragging(true);
      setIsHovered(false);
      document.body.classList.add('is-dragging');
      shouldFinalizeOnMouseUpRef.current = false;
      const clientPoint = getClientPoint(e) ?? { x: 0, y: 0 };
      const state = useStore.getState();
      const dragIds = state.selectedIds.includes(note.id) ? state.selectedIds : [note.id];
      const dragNotes = dragIds.flatMap((dragId) => {
          const dragNote = state.notesById[dragId];
          return dragNote ? [dragNote] : [];
      });
      const basePositions = Object.fromEntries(
          dragNotes.map((dragNote) => [dragNote.id, { x: dragNote.x, y: dragNote.y }]),
      );
      beginEdgePushDragSession(note.id, dragIds, basePositions, clientPoint);
      registerActiveNoteDragFinalizer(handleFinalizeDragSession);

      if (dragNotes.length > 1) {
              let minX = Infinity, minY = Infinity;
              let maxX = -Infinity, maxY = -Infinity;
              
              const leaderX = note.x;
              const leaderY = note.y;

              dragNotes.forEach(n => {
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
      } else {
          groupBoundsRef.current = null;
      }
  };

  const handleDrag = (e: DraggableEvent) => {
      if (!isDragging.current) isDragging.current = true;
      dragPosRef.current = true;
      if (!isDragActive) setIsDragActive(true);

      const clientPoint = getClientPoint(e);
      if (clientPoint) {
        updateEdgePushPointerFromClient(clientPoint.x, clientPoint.y);
      }
      applyActiveDragSessionTransforms();

      // 旧版推动手感的关键约束：拖拽中只有 DragSession 这一套位置真相。
      // DraggableCore 只作为事件入口；pointerDelta 只来自原始 clientX/Y，避免 worldLayer transform 污染 data.deltaX/Y。
      const effectivePos = getEffectiveLeaderPosition();
      const viewport = useStore.getState().viewport;
      const edgeRect = getEdgeCheckRect(
            effectivePos.x,
            effectivePos.y,
            viewport,
            nodeRef.current?.offsetWidth || LAYOUT.NOTE_WIDTH,
            nodeRef.current?.offsetHeight || LAYOUT.NOTE_MIN_HEIGHT,
            groupBoundsRef.current,
        );

       checkEdge(edgeRect.x, edgeRect.y, edgeRect.width, edgeRect.height);
    };
  
  const handleStop = (e: DraggableEvent) => {
    const clientPoint = getClientPoint(e);
    if (clientPoint) {
      updateEdgePushPointerFromClient(clientPoint.x, clientPoint.y);
    }
    handleFinalizeDragSession('stop');
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
      const currentIndex = NOTE_COLORS.indexOf(note.color);
      const nextIndex = (currentIndex + 1) % NOTE_COLORS.length;
      changeColor(note.id, NOTE_COLORS[nextIndex]);
  };

  const handleCollapseToggle = () => {
      toggleCollapse(note.id);
  };

  const handleHeaderDoubleClick = (e: React.MouseEvent) => {
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
      try {
        await navigator.clipboard.writeText(note.title ? `${note.title}\n${note.content}` : note.content);
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 2000);
      } catch (err) {
        console.error('Failed to copy note:', err);
      }
  };

  return (
      <DraggableCore
        nodeRef={nodeRef}
        handle=".drag-handle"
        cancel={'.note-action, input, textarea, [data-note-no-drag="true"]'}
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
           "rounded-xl transition-[box-shadow,border-color,background-color] duration-200 ease-out",
           "border border-border-subtle",
           "group",
           isStickyDragging && "scale-[1.02] cursor-move",
           isSelected && !isStickyDragging && !isDarkMode && (
             isGroupSelection
               ? "border-blue-500/60"
               : "border-blue-500/40"
           ),
           isStatic && "relative !transform-none !left-auto !top-auto opacity-90 grayscale-[0.1] hover:grayscale-0 pointer-events-auto",
           isPanMode && "pointer-events-none"
        )}
        style={{ 
             width: LAYOUT.NOTE_WIDTH,
             height: note.collapsed ? LAYOUT.NOTE_COLLAPSED_HEIGHT : 'auto',
             minHeight: note.collapsed ? undefined : LAYOUT.NOTE_MIN_HEIGHT,
             backgroundColor: getNoteColor(note.color, isDarkMode),
             borderColor: isDarkMode ? darkBorderColor : undefined,
             zIndex: isStickyDragging ? Z_INDEX.NOTE_DRAGGING : (isStatic ? undefined : note.z),
             transform: isStatic ? undefined : `translate(${worldX}px, ${worldY}px)`,
             backgroundImage: buildNoteSurfaceBackground(
               isDarkMode,
               darkSpectrum.accent,
               isMaterialAccentActive,
             ),
             boxShadow: buildNoteMaterialShadow(
               isDarkMode,
               darkSpectrum.accent,
               isHoverActive,
               isDragActive || isStickyDragging,
               isSelected,
               isGroupSelection,
             ),
        }}
        onMouseDownCapture={handleMouseDown}
        onMouseUpCapture={handleMouseUpCapture}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onPointerCancel={() => setIsHovered(false)}
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
    </DraggableCore>
  );
});

NoteCard.displayName = "NoteCard";
