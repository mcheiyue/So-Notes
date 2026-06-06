import React, { useRef, useState, useLayoutEffect, useEffect } from "react";
import { DraggableCore, DraggableEvent } from "react-draggable";
import { X, GripHorizontal, Palette, RotateCcw, Trash2, Copy, Check } from "lucide-react";
import { NOTE_UI_COLORS } from "../store/types";
import { LAYOUT, Z_INDEX } from "../constants/layout";
import { useDomainStore, useUIStore } from "../store";
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
import { NoteVisuals } from "./note-render/NoteVisuals";
import { NoteAttachments } from "./note-render/NoteAttachments";
import { saveImageFromSystemClipboard } from "../services/storage/attachmentPersistence";
import type { AttachmentRef } from "../store/types";

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

export const NoteCard: React.FC<NoteCardProps> = React.memo(({ id, isStatic = false, scale = 1 }) => {
  // Selectors
  const note = useDomainStore(state => state.notesById[id]);

  const updateNote = useStore(state => state.updateNote);
  const updateTitle = useStore(state => state.updateTitle);
  const finalizeLayoutChange = useStore(state => state.finalizeLayoutChange);
  const commitNoteTextEdit = useStore(state => state.commitNoteTextEdit);
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
  const commitNoteEditingSize = useStore(state => state.commitNoteEditingSize);
  const addAttachmentToNote = useStore(state => state.addAttachmentToNote);
  
  const isStickyDragging = useStore(state => state.stickyDrag.id === id);
  const isSelected = useUIStore(state => state.selectedIds.includes(id));
  const isRecentlyCreated = useUIStore(state => state.recentlyCreatedIds.includes(id));
  const noteHighlight = useUIStore(state => state.noteHighlights[id]);
  const clearRecentlyCreated = useUIStore(state => state.clearRecentlyCreated);
  const markNoteHighlights = useUIStore(state => state.markNoteHighlights);
  const clearNoteHighlight = useUIStore(state => state.clearNoteHighlight);
  const isGroupSelection = useUIStore(state => state.selectedIds.length > 1);
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
  const [isResizing, setIsResizing] = useState(false);
  const titleBeforeEditRef = useRef(note?.title ?? '');
  const contentBeforeEditRef = useRef(note?.content ?? '');
  const updatedAtBeforeEditRef = useRef(note?.updatedAt ?? 0);

  const resizeStateRef = useRef<{
    startWidth: number;
    startHeight: number;
    startNoteEditingWidth: number | undefined;
    startNoteEditingHeight: number | undefined;
    startClientX: number;
    startClientY: number;
    startUpdatedAt: number;
    currentWidth: number;
    currentHeight: number;
    noteId: string;
    pointerId: number;
    handleElement: Element;
  } | null>(null);
  const isResizingRef = useRef(false);
  
  // Drag State (Hybrid Control)
  const isDragging = useRef(false);
  const groupBoundsRef = useRef<{ minX: number, minY: number, width: number, height: number } | null>(null);
  const shouldFinalizeOnMouseUpRef = useRef(false);

  // dragPos ref: tracks drag status without triggering React re-renders
  // react-draggable handles DOM transforms directly during drag
  const dragPosRef = useRef(false);

  // P0: 缓存 DOM 引用，避免组拖拽时每帧 querySelector
  const noteId = note?.id;

  const cancelResize = () => {
    const state = resizeStateRef.current;
    if (!state || !nodeRef.current) {
      resizeStateRef.current = null;
      isResizingRef.current = false;
      setIsResizing(false);
      return;
    }

    nodeRef.current.style.width = `${state.startWidth}px`;
    nodeRef.current.style.height = state.startNoteEditingHeight === undefined ? 'auto' : `${state.startHeight}px`;
    resizeStateRef.current = null;
    isResizingRef.current = false;
    setIsResizing(false);
  };

  useEffect(() => {
    const el = nodeRef.current;
    if (el && noteId) {
      registerNoteElement(noteId, el);
      return () => {
        if (isDragging.current) {
          finalizeActiveNoteDrag('unmount');
        }
        cancelResize();
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

  useEffect(() => {
    if (!isRecentlyCreated) return;

    const timer = window.setTimeout(() => clearRecentlyCreated(id), 850);
    return () => window.clearTimeout(timer);
  }, [clearRecentlyCreated, id, isRecentlyCreated]);

  useEffect(() => {
    if (!noteHighlight) return;

    const duration = noteHighlight.reason === 'located' ? 1100 : 900;
    const timer = window.setTimeout(() => clearNoteHighlight(id, noteHighlight.token), duration);
    return () => window.clearTimeout(timer);
  }, [clearNoteHighlight, id, noteHighlight]);

  const worldX = note ? note.x : 0;
  const worldY = note ? note.y : 0;

  // Auto-resize textarea
  useLayoutEffect(() => {
    if (note && textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [note, note?.content, note?.collapsed]);

  useEffect(() => {
    const handleResizeKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isResizingRef.current) {
        cancelResize();
      }
    };

    window.addEventListener('keydown', handleResizeKeyDown);
    return () => window.removeEventListener('keydown', handleResizeKeyDown);
  }, []);

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
  const isTemporarilyHighlighted = Boolean(noteHighlight) && !isStatic;
  const isMaterialAccentActive = isHoverActive || isDragActive || isStickyDragging || isSelected || isTemporarilyHighlighted;
  const shouldUseEditingSize = (isSelected || isEditing) && !isStatic && !note.collapsed;

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
    // 逻辑边界使用常量，不读取 DOM offsetWidth/offsetHeight，
    // 因为选中态可能渲染编辑尺寸而拖拽边界应使用布局尺寸。
    const noteWidth = LAYOUT.NOTE_WIDTH;
    const noteHeight = note.collapsed ? LAYOUT.NOTE_COLLAPSED_HEIGHT : LAYOUT.NOTE_MIN_HEIGHT;
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
              LAYOUT.NOTE_WIDTH,
              n.collapsed ? LAYOUT.NOTE_COLLAPSED_HEIGHT : LAYOUT.NOTE_MIN_HEIGHT,
              isPanMode,
              margin,
            );

        n.x = resolvedPosition.x;
        n.y = resolvedPosition.y;
        state.layoutNotesById[id] = { id: n.id, x: n.x, y: n.y, boardId: n.boardId, deletedAt: n.deletedAt ?? null, color: n.color };
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

      const moveSnapshotPositions: Record<string, { x: number; y: number; updatedAt: number }> = {};
      dragNotes.forEach((dragNote) => {
        moveSnapshotPositions[dragNote.id] = {
          x: dragNote.x,
          y: dragNote.y,
          updatedAt: dragNote.updatedAt,
        };
      });
      useStore.getState().captureMoveSnapshot(moveSnapshotPositions);

      beginEdgePushDragSession(note.id, dragIds, basePositions, clientPoint);
      registerActiveNoteDragFinalizer(handleFinalizeDragSession);

      if (dragNotes.length > 1) {
              let minX = Infinity, minY = Infinity;
              let maxX = -Infinity, maxY = -Infinity;
              
              const leaderX = note.x;
              const leaderY = note.y;

              dragNotes.forEach(n => {
                  const nW = LAYOUT.NOTE_WIDTH;
                  const nH = n.collapsed ? LAYOUT.NOTE_COLLAPSED_HEIGHT : LAYOUT.NOTE_MIN_HEIGHT;
                  
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
            LAYOUT.NOTE_WIDTH,
            note.collapsed ? LAYOUT.NOTE_COLLAPSED_HEIGHT : LAYOUT.NOTE_MIN_HEIGHT,
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
      if (isStatic) return; // TRASH 列表下禁用右键菜单
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
      const currentIndex = NOTE_UI_COLORS.indexOf(note.color);
      const nextIndex = (currentIndex + 1) % NOTE_UI_COLORS.length;
      changeColor(note.id, NOTE_UI_COLORS[nextIndex]);
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

  const handleTitleFocus = () => {
    titleBeforeEditRef.current = note.title;
    contentBeforeEditRef.current = note.content;
    updatedAtBeforeEditRef.current = note.updatedAt;
    setIsEditing(true);
  };

  const handleTitleBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    setIsEditing(false);
    if (event.currentTarget.value !== titleBeforeEditRef.current) {
      markNoteHighlights([note.id], 'edited');
    }
    commitNoteTextEdit(note.id, titleBeforeEditRef.current, contentBeforeEditRef.current, updatedAtBeforeEditRef.current);
  };

  const handleContentFocus = () => {
    contentBeforeEditRef.current = note.content;
    titleBeforeEditRef.current = note.title;
    updatedAtBeforeEditRef.current = note.updatedAt;
    setIsEditing(true);
  };

  const handleContentBlur = (event: React.FocusEvent<HTMLTextAreaElement>) => {
    setIsEditing(false);
    if (event.currentTarget.value !== contentBeforeEditRef.current) {
      markNoteHighlights([note.id], 'edited');
    }
    commitNoteTextEdit(note.id, titleBeforeEditRef.current, contentBeforeEditRef.current, updatedAtBeforeEditRef.current);
  };

  const handleInputPaste = async (event: React.ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (isStatic || note.deletedAt) return;

    const items = event.clipboardData.items;
    let hasRasterImage = false;
    for (let i = 0; i < items.length; i++) {
      const itemType = items[i].type;
      if (itemType.startsWith('image/') && itemType !== 'image/svg+xml') {
        hasRasterImage = true;
        break;
      }
    }

    if (!hasRasterImage) return;

    event.preventDefault();
    event.stopPropagation();

    try {
      const writeResult = await saveImageFromSystemClipboard();
      const attachmentRef: AttachmentRef = {
        id: crypto.randomUUID(),
        hash: writeResult.hash,
        filename: writeResult.filename,
        mimeType: writeResult.mimeType,
        size: writeResult.size,
        relativePath: writeResult.relativePath,
        createdAt: writeResult.createdAt,
      };
      addAttachmentToNote(note.id, attachmentRef);
    } catch (error) {
      console.warn('图片粘贴失败，已跳过附件创建。', error);
    }
  };

  const commitResize = () => {
    const state = resizeStateRef.current;
    if (!state) return;

    const clampedW = Math.max(LAYOUT.NOTE_MIN_WIDTH, state.currentWidth);
    const clampedH = Math.max(LAYOUT.NOTE_MIN_HEIGHT, state.currentHeight);

    commitNoteEditingSize(
      state.noteId,
      clampedW,
      clampedH,
      {
        editingWidth: state.startNoteEditingWidth,
        editingHeight: state.startNoteEditingHeight,
        renderedWidth: state.startWidth,
        renderedHeight: state.startHeight,
        updatedAt: state.startUpdatedAt,
      },
    );

    resizeStateRef.current = null;
    isResizingRef.current = false;
    setIsResizing(false);
  };

  const handleResizePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();

    const currentNote = useDomainStore.getState().notesById[note.id];
    if (!currentNote || currentNote.deletedAt || currentNote.collapsed) return;

    const el = nodeRef.current;
    if (!el) return;

    const startWidth = currentNote.editingWidth ?? LAYOUT.NOTE_WIDTH;
    const startHeight = currentNote.editingHeight ?? el.offsetHeight;
    const handleElement = e.currentTarget;

    resizeStateRef.current = {
      startWidth,
      startHeight,
      startNoteEditingWidth: currentNote.editingWidth,
      startNoteEditingHeight: currentNote.editingHeight,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startUpdatedAt: currentNote.updatedAt,
      currentWidth: startWidth,
      currentHeight: startHeight,
      noteId: note.id,
      pointerId: e.pointerId,
      handleElement,
    };
    isResizingRef.current = true;
    setIsResizing(true);

    handleElement.setPointerCapture(e.pointerId);
  };

  const handleResizePointerMove = (e: React.PointerEvent) => {
    const state = resizeStateRef.current;
    if (!state || !nodeRef.current) return;

    const scaleValue = scale || 1;
    const dx = (e.clientX - state.startClientX) / scaleValue;
    const dy = (e.clientY - state.startClientY) / scaleValue;

    const newWidth = Math.max(LAYOUT.NOTE_MIN_WIDTH, state.startWidth + dx);
    const newHeight = Math.max(LAYOUT.NOTE_MIN_HEIGHT, state.startHeight + dy);

    state.currentWidth = newWidth;
    state.currentHeight = newHeight;

    nodeRef.current.style.width = `${newWidth}px`;
    nodeRef.current.style.height = `${newHeight}px`;
  };

  const handleResizePointerUp = (e: React.PointerEvent) => {
    if (!isResizingRef.current) return;

    const state = resizeStateRef.current;
    if (state?.handleElement.hasPointerCapture(e.pointerId)) {
      state.handleElement.releasePointerCapture(e.pointerId);
    }
    commitResize();
  };

  const handleResizePointerCancel = () => {
    cancelResize();
  };

  const shouldShowResizeHandle = !isStatic && !note.collapsed && (isSelected || isEditing);

  // 拖拽时禁用尺寸过渡，避免 CSS transition 与 JS transform 拖拽产生冲突。
  const transitionClass = isDragActive || isStickyDragging || isResizing
    ? 'transition-[box-shadow,border-color,background-color]'
    : 'transition-[box-shadow,border-color,background-color,width,height]';

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
      <NoteVisuals
        ref={nodeRef}
        data-id={note.id}
        data-canvas-hit="blocked"
        title={note.title}
        content={note.content}
        color={note.color}
        isCollapsed={Boolean(note.collapsed)}
        isDark={isDarkMode}
        isActive={isMaterialAccentActive}
        isDragging={isDragActive || isStickyDragging}
        isSelected={isSelected}
        isGroupSelection={isGroupSelection}
        editingWidth={note.editingWidth}
        editingHeight={note.editingHeight}
        shouldUseEditingSize={shouldUseEditingSize}
        className={cn(
          "note-card absolute",
          'duration-200 ease-out',
          transitionClass,
          "group",
          isRecentlyCreated && !isStatic && "note-card-created",
          noteHighlight && !isStatic && "note-card-transient-highlight",
          noteHighlight?.reason === 'created' && !isStatic && "note-card-highlight-created",
          noteHighlight?.reason === 'located' && !isStatic && "note-card-highlight-located",
          noteHighlight?.reason === 'edited' && !isStatic && "note-card-highlight-edited",
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
          zIndex: isStickyDragging ? Z_INDEX.NOTE_DRAGGING : (isStatic ? undefined : note.z),
          transform: isStatic ? undefined : `translate(${worldX}px, ${worldY}px)`,
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
                <Tooltip content="还原便签">
                    <button
                      type="button"
                      className="note-action p-1.5 rounded-md hover:bg-green-100 dark:hover:bg-green-900/20 hover:text-green-600 transition-colors text-text-tertiary flex-shrink-0"
                      aria-label="还原便签"
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
                          if (window.confirm("确认永久删除此便签？此操作无法撤销。")) {
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
                    onFocus={handleTitleFocus}
                    onBlur={handleTitleBlur}
                    onPaste={handleInputPaste}
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
                placeholder="记点什么…"
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
                onFocus={handleContentFocus}
                onBlur={handleContentBlur}
                onPaste={handleInputPaste}
                onMouseDownCapture={handleMouseDown}
                spellCheck={false}
                rows={1}
                readOnly={isStatic}
              />
              {note.attachments && note.attachments.length > 0 && (
                <NoteAttachments
                  noteId={note.id}
                  attachments={note.attachments}
                  readOnly={isStatic}
                />
              )}
            </div>
        )}

        {shouldShowResizeHandle && (
          <div
            data-note-no-drag="true"
            aria-label="调整便签尺寸"
            className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize z-30 opacity-0 group-hover:opacity-100 transition-opacity duration-150"
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerUp}
            onPointerCancel={handleResizePointerCancel}
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              className="w-4 h-4 text-text-tertiary/50"
              aria-hidden="true"
            >
              <path d="M14 2L2 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M14 7L7 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M14 12L12 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
        )}
      </NoteVisuals>
    </DraggableCore>
  );
});

NoteCard.displayName = "NoteCard";
