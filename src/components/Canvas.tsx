import React, { useRef, useEffect, useCallback, useMemo, Profiler } from "react";
import { useStore } from "../store/useStore";
import { NoteCard } from "./NoteCard";
import { cn } from "../utils/cn";
import { LAYOUT, Z_INDEX } from "../constants/layout";
import { diagnostics } from "../utils/diagnostics";
import { useFPSMonitor } from "../utils/performance";
import {
  getEdgePushDragLeader,
  hasActiveEdgePushDragSession,
  accumulateEdgePushDelta,
  applyActiveDragSessionTransforms,
  setEdgePushDragLeader,
} from "../utils/edgePushDragCompensation";
import { getNoteVisualHeight, getNoteVisualWidth } from "../utils/noteVisualMetrics";
import { getNoteElement } from "../utils/noteElementRegistry";
import { resolveDragStopWorldPosition } from "../utils/dragCoordinates";



const VIEWPORT_BUFFER = 500;
const EMPTY_NOTE_IDS: string[] = [];

const CANVAS_NON_BLANK_SELECTOR = [
  '[data-canvas-hit="blocked"]',
  '.minimap-interaction-area',
].join(', ');

const getEventTargetElement = (target: EventTarget | null): Element | null => {
  if (target instanceof Element) {
    return target;
  }

  if (target instanceof Node) {
    return target.parentElement;
  }

  return null;
};

const isBlankCanvasTarget = (target: EventTarget | null): boolean => {
  const targetElement = getEventTargetElement(target);
  return !targetElement || !targetElement.closest(CANVAS_NON_BLANK_SELECTOR);
};

const isDragInteractionLocked = (): boolean => {
  const state = useStore.getState();
  return state.interaction.isDragging || getEdgePushDragLeader() !== null || state.stickyDrag.id !== null;
};

export const Canvas: React.FC = () => {
  // 细粒度订阅：只订阅渲染路径真正需要的状态
  const isLoaded = useStore((s) => s.isLoaded);
  const currentBoardId = useStore((s) => s.currentBoardId);
  const stickyDragId = useStore((s) => s.stickyDrag.id);
  const stickyDragStatus = useStore((s) => s.stickyDrag.status);
  const isPanMode = useStore((s) => s.interaction.isPanMode);
  const isDragging = useStore((s) => s.interaction.isDragging);
  const edgePush = useStore((s) => s.interaction.edgePush);
  const viewport = useStore((s) => s.viewport);

  const notesById = useStore((s) => s.notesById);
  const layoutNotesById = useStore((s) => s.layoutNotesById);
  const currentBoardNoteIds = useStore((s) => s.boardNoteIds[s.currentBoardId] ?? EMPTY_NOTE_IDS);

  const throttledViewportX = Math.floor(viewport.x / 100) * 100;
  const throttledViewportY = Math.floor(viewport.y / 100) * 100;

  const throttledViewportRect = useMemo(() => ({
    x: throttledViewportX - VIEWPORT_BUFFER,
    y: throttledViewportY - VIEWPORT_BUFFER,
    w: viewport.w + VIEWPORT_BUFFER * 2,
    h: viewport.h + VIEWPORT_BUFFER * 2,
  }), [
    throttledViewportX,
    throttledViewportY,
    viewport.w,
    viewport.h
  ]);

  const visibleNoteIds = useMemo(() => {
    const liveNoteIds = currentBoardNoteIds.filter((id) => !layoutNotesById[id]?.deletedAt);

    // v1.3.1 引入视口虚拟化后，持续交互中的便签可能因为旧 layout 位置被裁剪而卸载，
    // 造成 edgePush 中断、小地图收起、拖拽会话残留。拖拽 / sticky drag 期间必须保留稳定 DOM。
    if (isDragging || stickyDragId || getEdgePushDragLeader()) {
      return liveNoteIds;
    }

    const viewportRight = throttledViewportRect.x + throttledViewportRect.w;
    const viewportBottom = throttledViewportRect.y + throttledViewportRect.h;

    return liveNoteIds.filter((id) => {
      const ln = layoutNotesById[id];
      if (!ln) return false;

      const note = notesById[id];
      const noteWidth = getNoteVisualWidth(note, ln);
      const noteHeight = getNoteVisualHeight(note, ln);
      const noteRight = ln.x + noteWidth;
      const noteBottom = ln.y + noteHeight;

      return (
        noteRight >= throttledViewportRect.x &&
        ln.x <= viewportRight &&
        noteBottom >= throttledViewportRect.y &&
        ln.y <= viewportBottom
      );
    });
  }, [currentBoardNoteIds, isDragging, layoutNotesById, notesById, stickyDragId, throttledViewportRect]);

  const currentBoardVisibleCount = useMemo(
    () => currentBoardNoteIds.filter((id) => !layoutNotesById[id]?.deletedAt).length,
    [currentBoardNoteIds, layoutNotesById],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const worldLayerRef = useRef<HTMLDivElement>(null);
  const panOffsetRef = useRef({ x: 0, y: 0 });
  const scale = 1;

  const getCanvasBounds = () => {
    return containerRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
  };

  const getStickyDragIds = useCallback((state = useStore.getState()) => {
    const leaderId = state.stickyDrag.id;
    if (!leaderId) {
      return [] as string[];
    }

    if (state.selectedIds.includes(leaderId) && state.selectedIds.length > 1) {
      return state.selectedIds;
    }

    return [leaderId];
  }, []);

  const restoreStickyDragPreview = useCallback((state = useStore.getState()) => {
    const ids = getStickyDragIds(state);
    ids.forEach((id) => {
      const el = getNoteElement(id);
      const note = state.notesById[id];
      if (!el || !note) return;
      el.style.transform = `translate(${note.x}px, ${note.y}px)`;
    });
  }, [getStickyDragIds]);

  const commitStickyDragPlacement = useCallback(() => {
    const state = useStore.getState();
    const idsToCommit = getStickyDragIds(state);
    if (idsToCommit.length === 0) {
      state.setStickyDrag(null);
      return;
    }

    const rawPositions = Object.fromEntries(
      idsToCommit.flatMap((id) => {
        const note = state.notesById[id];
        if (!note) return [];

        const el = getNoteElement(id);
        const match = el?.style.transform.match(/translate\(\s*([-\d.]+)px\s*,\s*([-\d.]+)px\s*\)/);
        if (match) {
          return [[id, { x: parseFloat(match[1]), y: parseFloat(match[2]) }]];
        }

        return [[id, { x: note.x, y: note.y }]];
      }),
    ) as Record<string, { x: number; y: number }>;

    const finalPositions = Object.fromEntries(
      idsToCommit.flatMap((id) => {
        const note = state.notesById[id];
        const layout = state.layoutNotesById[id];
        const rawPosition = rawPositions[id];
        if (!note || !layout || !rawPosition) {
          return [];
        }

        return [[
          id,
          resolveDragStopWorldPosition(
            rawPosition.x,
            rawPosition.y,
            state.viewport,
            getNoteVisualWidth(note, layout),
            getNoteVisualHeight(note, layout),
            state.interaction.isPanMode,
            10,
          ),
        ]];
      }),
    ) as Record<string, { x: number; y: number }>;

    const timestamp = Date.now();
    useStore.setState((draft) => {
      idsToCommit.forEach((id) => {
        const note = draft.notesById[id];
        const position = finalPositions[id];
        if (!note || !position) return;

        note.x = position.x;
        note.y = position.y;
        note.updatedAt = timestamp;
        draft.layoutNotesById[id] = {
          id: note.id,
          x: note.x,
          y: note.y,
          boardId: note.boardId,
          deletedAt: note.deletedAt ?? null,
          color: note.color,
          width: note.width,
          height: note.height,
        };
      });
      draft.stickyDrag = { id: null, offsetX: 0, offsetY: 0, status: 'active' };
    });

    state.finalizeLayoutChange(idsToCommit);
  }, [getStickyDragIds]);

  const cancelStickyDrag = useCallback(() => {
    const state = useStore.getState();
    if (!state.stickyDrag.id) return;
    restoreStickyDragPreview(state);
    state.setStickyDrag(null);
  }, [restoreStickyDragPreview]);

  const suspendStickyDrag = useCallback(() => {
    const state = useStore.getState();
    if (!state.stickyDrag.id || state.stickyDrag.status === 'suspended') return;
    state.setStickyDrag(
      state.stickyDrag.id,
      state.stickyDrag.offsetX,
      state.stickyDrag.offsetY,
      'suspended',
    );
  }, []);

  const toCanvasLocalPoint = (clientX: number, clientY: number) => {
    const bounds = getCanvasBounds();
    return {
      x: clientX - bounds.left,
      y: clientY - bounds.top,
    };
  };

  // Selection Logic Refs
  const isSelecting = useRef(false);
  const selectionStart = useRef({ x: 0, y: 0 });
  const selectionBoxRef = useRef<HTMLDivElement>(null);

  // Pan Logic Refs
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  const panDeltaRef = useRef({ dx: 0, dy: 0 });
  const panFlushFrameRef = useRef<number>(0);
  const lastSpacePressTime = useRef<number>(0);
  
  // Edge Push Loop
  const edgePushFrameRef = useRef<number>(0);

  const stopPanFlushLoop = useCallback(() => {
    if (panFlushFrameRef.current) {
      cancelAnimationFrame(panFlushFrameRef.current);
      panFlushFrameRef.current = 0;
    }
  }, []);

  const schedulePanFlushLoop = useCallback(() => {
    if (panFlushFrameRef.current) {
      return;
    }

    const flushPanDelta = () => {
      panFlushFrameRef.current = 0;

      const { dx, dy } = panDeltaRef.current;
      if (dx === 0 && dy === 0) {
        return;
      }

      panOffsetRef.current.x += dx;
      panOffsetRef.current.y += dy;

      if (panOffsetRef.current.x < 0) panOffsetRef.current.x = 0;
      if (panOffsetRef.current.y < 0) panOffsetRef.current.y = 0;

      if (worldLayerRef.current) {
        worldLayerRef.current.style.transform = `translate3d(${-panOffsetRef.current.x}px, ${-panOffsetRef.current.y}px, 0)`;
      }

      useStore.getState().setViewportPosition(panOffsetRef.current.x, panOffsetRef.current.y);

      panDeltaRef.current = { dx: 0, dy: 0 };
    };

    panFlushFrameRef.current = requestAnimationFrame(flushPanDelta);
  }, []);

  useEffect(() => {
    return () => {
      stopPanFlushLoop();
    };
  }, [stopPanFlushLoop]);

  useEffect(() => {
    const bootstrap = async () => {
      await useStore.getState().init();
    };
    bootstrap();
  }, []);

  // Space Key Listener (Pan Mode)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        const active = document.activeElement;
        const isInput = active instanceof HTMLInputElement || 
                        active instanceof HTMLTextAreaElement || 
                        active?.getAttribute('contenteditable') === 'true';
        
        const isSpotlightOpen = useStore.getState().isSpotlightOpen;

          if (!isInput && !isSpotlightOpen) {
             e.preventDefault(); 
             
             if (!e.repeat) {
                 const now = Date.now();
                 const DOUBLE_PRESS_DELAY = 300;
                 
                 if (now - lastSpacePressTime.current < DOUBLE_PRESS_DELAY) {
                     const s = useStore.getState();
                     s.setViewportPosition(0, 0);
                     s.setPanMode(false);
                     lastSpacePressTime.current = 0;
                 } else {
                     const currentMode = useStore.getState().interaction.isPanMode;
                     useStore.getState().setPanMode(!currentMode);
                     lastSpacePressTime.current = now;
                 }
             }
          }
      }
    };

    window.removeEventListener('keydown', handleKeyDown);
    window.addEventListener('keydown', handleKeyDown);
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // Edge Push Animation Loop
  useEffect(() => {
    const { top, bottom, left, right } = edgePush;
    if (!top && !bottom && !left && !right) {
        if (edgePushFrameRef.current) {
            cancelAnimationFrame(edgePushFrameRef.current);
            edgePushFrameRef.current = 0;
            useStore.getState().setViewportPosition(panOffsetRef.current.x, panOffsetRef.current.y);
        }
        return;
    }

    const viewport = useStore.getState().viewport;
    panOffsetRef.current = { x: viewport.x, y: viewport.y };

    const pushLoop = () => {
        let dx = 0;
        let dy = 0;
        const SPEED = LAYOUT.EDGE_PUSH_SPEED;

        if (left) dx -= SPEED;
        if (right) dx += SPEED;
        if (top) dy -= SPEED;
        if (bottom) dy += SPEED;

        if (dx !== 0 || dy !== 0) {
            panOffsetRef.current.x += dx;
            panOffsetRef.current.y += dy;
            if (panOffsetRef.current.x < 0) panOffsetRef.current.x = 0;
            if (panOffsetRef.current.y < 0) panOffsetRef.current.y = 0;

            useStore.getState().setViewportPosition(panOffsetRef.current.x, panOffsetRef.current.y);

            if (worldLayerRef.current) {
                worldLayerRef.current.style.transform = `translate3d(${-panOffsetRef.current.x}px, ${-panOffsetRef.current.y}px, 0)`;
            }

            const leaderId = getEdgePushDragLeader();
            if (leaderId && hasActiveEdgePushDragSession()) {
                 accumulateEdgePushDelta(dx, dy);
                applyActiveDragSessionTransforms();
            } else {
                useStore.getState().moveSelectedNotes(dx, dy, leaderId ?? undefined);
            }
        }
        edgePushFrameRef.current = requestAnimationFrame(pushLoop);
    };

    edgePushFrameRef.current = requestAnimationFrame(pushLoop);
    return () => {
        if (edgePushFrameRef.current) {
            cancelAnimationFrame(edgePushFrameRef.current);
            edgePushFrameRef.current = 0;
        }
    };
  }, [edgePush]);

  const handleMouseMove = (e: React.MouseEvent) => {
      // Safety check: If no mouse button is pressed, stop any active drag
      // This fixes the issue where releasing mouse outside window keeps drag active
      if (e.buttons === 0) {
          if (isPanning.current) isPanning.current = false;
          if (isSelecting.current) {
              isSelecting.current = false;
              if (selectionBoxRef.current) {
                  selectionBoxRef.current.style.display = 'none';
              }
          }
      }

      // 0. Pan Viewport (Background Drag)
      if (isPanning.current) {
          const dx = e.clientX - panStart.current.x;
          const dy = e.clientY - panStart.current.y;
          // Dragging background moves viewport in OPPOSITE direction
          panDeltaRef.current.dx -= dx;
          panDeltaRef.current.dy -= dy;
          panStart.current = { x: e.clientX, y: e.clientY };
          schedulePanFlushLoop();
          return;
      }

      // 1. Sticky Drag Logic
      if (stickyDragId) {
          const localPoint = toCanvasLocalPoint(e.clientX, e.clientY);
          const state = useStore.getState();
          if (state.stickyDrag.status === 'suspended') {
            return;
          }
          const vp = state.viewport;
          const newX = (localPoint.x - state.stickyDrag.offsetX) / scale + vp.x;
          const newY = (localPoint.y - state.stickyDrag.offsetY) / scale + vp.y;
          
          const currentNote = state.notesById[stickyDragId];
          const isSelected = state.selectedIds.includes(stickyDragId);
          const ids = getStickyDragIds(state);
          
          if (isSelected && ids.length > 1 && currentNote) {
              const dx = newX - currentNote.x;
              const dy = newY - currentNote.y;
              ids.forEach((id) => {
                  if (id === stickyDragId) return;
                  const el = getNoteElement(id);
                  if (!el) return;
                  const note = state.notesById[id];
                  if (!note) return;
                  el.style.transform = `translate(${note.x + dx}px, ${note.y + dy}px)`;
              });
              const leaderEl = getNoteElement(stickyDragId);
              if (leaderEl) leaderEl.style.transform = `translate(${newX}px, ${newY}px)`;
          } else {
              const el = getNoteElement(stickyDragId);
              if (el) el.style.transform = `translate(${newX}px, ${newY}px)`;
          }
          return;
      }
      
      // 2. Marquee Selection Logic
      if (isSelecting.current && selectionBoxRef.current) {
           const currentPoint = toCanvasLocalPoint(e.clientX, e.clientY);
           const startPoint = toCanvasLocalPoint(selectionStart.current.x, selectionStart.current.y);
           const currentX = currentPoint.x;
           const currentY = currentPoint.y;
           const startX = startPoint.x;
           const startY = startPoint.y;
          
          const left = Math.min(startX, currentX);
          const top = Math.min(startY, currentY);
          const width = Math.abs(currentX - startX);
          const height = Math.abs(currentY - startY);
          
          selectionBoxRef.current.style.left = `${left}px`;
          selectionBoxRef.current.style.top = `${top}px`;
          selectionBoxRef.current.style.width = `${width}px`;
          selectionBoxRef.current.style.height = `${height}px`;
          // Ensure it's visible if mouse moves (in case down didn't show it for some reason?)
          if (selectionBoxRef.current.style.display === 'none') {
               selectionBoxRef.current.style.display = 'block';
          }
      }
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    if (isDragInteractionLocked()) {
      return;
    }

    if (!isBlankCanvasTarget(e.target)) {
      return;
    }

    // Fix: Convert Screen Coordinates to World Coordinates
    // The click (e.clientX) is in screen space.
    // The note needs to be placed in world space.
    const localPoint = toCanvasLocalPoint(e.clientX, e.clientY);
    const vp = useStore.getState().viewport;
    const x = localPoint.x + vp.x;
    const y = localPoint.y + vp.y;
    useStore.getState().addNote(x, y);
  };
  
    const handleGlobalDown = (e: React.MouseEvent) => {
    const isBlankTarget = isBlankCanvasTarget(e.target);

      // 0. Handle Sticky Drag Commit (explicit placement mode)
      if (e.button !== 2 && stickyDragId) {
          commitStickyDragPlacement();
          return;
      }

      if (isDragInteractionLocked()) {
          return;
      }

      // 0. Start Panning (Space Mode + Left Click on Background)
      if (useStore.getState().interaction.isPanMode && e.button === 0 && isBlankTarget) {
          isPanning.current = true;
          panStart.current = { x: e.clientX, y: e.clientY };
          const vp = useStore.getState().viewport;
          panOffsetRef.current = { x: vp.x, y: vp.y };
          return;
      }

      if (useStore.getState().interaction.isDragging) {
          return;
      }

      // 2. Start Marquee Selection (Left Click on Canvas)
      if (e.button === 0 && !stickyDragId && isBlankTarget) {
          isSelecting.current = true;
          selectionStart.current = { x: e.clientX, y: e.clientY };
          const localPoint = toCanvasLocalPoint(e.clientX, e.clientY);
          
          if (selectionBoxRef.current) {
              selectionBoxRef.current.style.left = `${localPoint.x}px`;
              selectionBoxRef.current.style.top = `${localPoint.y}px`;
              selectionBoxRef.current.style.width = '0px';
              selectionBoxRef.current.style.height = '0px';
              selectionBoxRef.current.style.display = 'block';
          }
          
          // Clear existing selection if not holding shift/ctrl (optional, for now simple clear)
          if (!e.shiftKey && !e.ctrlKey) {
             useStore.getState().clearSelection();
          }
      }
  };

  const handleGlobalUp = useCallback((e: React.MouseEvent | MouseEvent) => {
      if (isPanning.current) {
          isPanning.current = false;
          stopPanFlushLoop();
          useStore.getState().setViewportPosition(panOffsetRef.current.x, panOffsetRef.current.y);
          return;
      }

      if (isSelecting.current) {
          isSelecting.current = false;
          if (selectionBoxRef.current) {
              selectionBoxRef.current.style.display = 'none';
          }

          const bounds = getCanvasBounds();
          const startX = selectionStart.current.x - bounds.left;
          const startY = selectionStart.current.y - bounds.top;
          const endX = e.clientX - bounds.left;
          const endY = e.clientY - bounds.top;

          // 最小位移阈值：小于 3px 视为空白单击，不跑 AABB 命中
          const dx = Math.abs(endX - startX);
          const dy = Math.abs(endY - startY);
          if (dx < 3 && dy < 3) {
              return;
          }

          const screenRect = {
              left: Math.min(startX, endX),
              top: Math.min(startY, endY),
              right: Math.max(startX, endX),
              bottom: Math.max(startY, endY)
          };

          const vp = useStore.getState().viewport;
          const worldRect = {
              left: screenRect.left + vp.x,
              top: screenRect.top + vp.y,
              right: screenRect.right + vp.x,
              bottom: screenRect.bottom + vp.y
          };
          
          const boardNoteIds = useStore.getState().boardNoteIds[useStore.getState().currentBoardId] ?? [];
          const layoutNotesById = useStore.getState().layoutNotesById;
          const notesById = useStore.getState().notesById;
          const newSelectedIds: string[] = [];
          
          for (const id of boardNoteIds) {
              const ln = layoutNotesById[id];
              if (!ln || ln.deletedAt) continue;
              
              const note = notesById[id];
              const noteWidth = getNoteVisualWidth(note, ln);
              const noteHeight = getNoteVisualHeight(note, ln);
              
              const isIntersecting = !(
                  worldRect.right < ln.x || 
                  worldRect.left > ln.x + noteWidth || 
                  worldRect.bottom < ln.y || 
                  worldRect.top > ln.y + noteHeight
              );
              
              if (isIntersecting) {
                  newSelectedIds.push(id);
              }
          }
          
          const existingIds = useStore.getState().selectedIds;
          if (newSelectedIds.length > 0) {
              if (e.shiftKey) {
                  const mergedIds = [...new Set([...existingIds, ...newSelectedIds])];
                  useStore.getState().setSelectedIds(mergedIds);
              } else {
                  useStore.getState().setSelectedIds(newSelectedIds);
              }
          }
      }
  }, [stopPanFlushLoop]);

  // Global Mouse Up & Blur Handler to prevent sticky drag
  useEffect(() => {
      const handleWindowUp = (e: MouseEvent) => handleGlobalUp(e);
      const handleWindowBlur = () => {
          isPanning.current = false;
          isSelecting.current = false;
          panDeltaRef.current = { dx: 0, dy: 0 };
          stopPanFlushLoop();
          useStore.getState().setEdgePush({ top: false, bottom: false, left: false, right: false });
          useStore.getState().setIsDragging(false);
          setEdgePushDragLeader(null);
          suspendStickyDrag();
          if (selectionBoxRef.current) {
              selectionBoxRef.current.style.display = 'none';
          }
      };

      const handleKeyDown = (event: KeyboardEvent) => {
          if (event.key === 'Escape' && useStore.getState().stickyDrag.id) {
              event.preventDefault();
              cancelStickyDrag();
          }
      };

      window.addEventListener('mouseup', handleWindowUp);
      window.addEventListener('blur', handleWindowBlur);
      window.addEventListener('keydown', handleKeyDown);
      
      return () => {
          window.removeEventListener('mouseup', handleWindowUp);
          window.removeEventListener('blur', handleWindowBlur);
          window.removeEventListener('keydown', handleKeyDown);
      };
  }, [cancelStickyDrag, handleGlobalUp, stopPanFlushLoop, suspendStickyDrag]);

  if (!isLoaded) return null;

  return (
    <section
      ref={containerRef}
      role="application"
      className={cn(
        "w-full h-full overflow-hidden relative select-none outline-none focus:outline-none focus-visible:outline-none",
        isPanMode ? "cursor-grab active:cursor-grabbing" : "cursor-default"
      )}
      onDoubleClick={handleDoubleClick}
      onMouseMove={handleMouseMove}
      onMouseDown={handleGlobalDown}
      onMouseUp={handleGlobalUp}
      onContextMenu={(e) => {
          e.preventDefault();
          if (stickyDragId) {
              return;
          } else {
              useStore.getState().setContextMenu({
                  isOpen: true,
                  x: e.clientX,
                  y: e.clientY,
                  type: 'CANVAS'
              });
          }
      }}
    >
      <div className="absolute inset-0 pointer-events-none opacity-[0.08]" 
           style={{
               backgroundImage: `radial-gradient(circle, var(--color-border-subtle) 1px, transparent 1px)`, // 使用语义化边框颜色作为网格点
               backgroundSize: '20px 20px',
               backgroundPosition: `-${viewport.x}px -${viewport.y}px`
           }}
      />
      
      {/* Edge Push Indicators */}
      <div className={cn("absolute top-0 left-0 right-0 h-8 bg-gradient-to-b from-blue-500/20 to-transparent pointer-events-none transition-opacity duration-300", edgePush.top ? "opacity-100" : "opacity-0")} />
      <div className={cn("absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-blue-500/20 to-transparent pointer-events-none transition-opacity duration-300", edgePush.bottom ? "opacity-100" : "opacity-0")} />
      <div className={cn("absolute top-0 bottom-0 left-0 w-8 bg-gradient-to-r from-blue-500/20 to-transparent pointer-events-none transition-opacity duration-300", edgePush.left ? "opacity-100" : "opacity-0")} />
      <div className={cn("absolute top-0 bottom-0 right-0 w-8 bg-gradient-to-l from-blue-500/20 to-transparent pointer-events-none transition-opacity duration-300", edgePush.right ? "opacity-100" : "opacity-0")} />
      
      {/* Board Badge moved to App.tsx for better reactivity */}

      {/* Selection Box */}
      <div
        ref={selectionBoxRef}
        className="absolute bg-blue-500/10 border border-blue-500/55 border-dashed shadow-[0_0_0_1px_rgba(59,130,246,0.12)] pointer-events-none dark:bg-blue-200/15 dark:border-blue-200/80 dark:shadow-[0_0_0_1px_rgba(191,219,254,0.3)]"
        style={{ display: 'none', zIndex: Z_INDEX.SELECTION_BOX }}
      />
      
      <div
        ref={worldLayerRef}
        className="absolute top-0 left-0"
        style={{ transform: `translate3d(${-viewport.x}px, ${-viewport.y}px, 0)` }}
      >
        {visibleNoteIds.map((id) => (
          <NoteCard key={id} id={id} scale={scale} />
        ))}
      </div>
      
      {visibleNoteIds.length === 0 && currentBoardVisibleCount > 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none select-none">
          <p className="text-lg font-medium text-text-tertiary">
            当前视口外有 {currentBoardVisibleCount} 个便签
          </p>
          <p className="text-xs text-text-tertiary mt-1">
            拖拽或平移查看
          </p>
        </div>
      )}
      
      {visibleNoteIds.length === 0 && currentBoardVisibleCount === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none select-none">
          <p className="text-lg font-medium text-text-tertiary">
            {currentBoardId === 'default' ? '双击空白处新建便签' : '当前看板为空'}
          </p>
          <p className="text-xs text-text-tertiary mt-1">
            或右键点击 &rarr; 新建
          </p>
        </div>
      )}
      
      {isPanMode && (
        <div 
            className="fixed top-6 left-1/2 -translate-x-1/2 px-4 py-2 bg-secondary-bg/60 text-text-secondary border border-border-subtle shadow-lg rounded-full text-xs font-medium backdrop-blur-xl pointer-events-none transition-all animate-in fade-in zoom-in-95 duration-300 select-none flex items-center gap-2"
            style={{ zIndex: Z_INDEX.PAN_MODE_BADGE }}
        >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.5)]" />
            按 Space 退出
        </div>
      )}
      
      {stickyDragId && (
        <div 
            className="fixed bottom-10 left-0 w-full text-center pointer-events-none"
            style={{ zIndex: Z_INDEX.STICKY_DRAG_MSG }}
        >
            <span className="bg-tertiary-bg/80 text-text-primary text-xs px-4 py-1.5 rounded-full shadow-lg backdrop-blur-md">
                {stickyDragStatus === 'suspended'
                  ? '吸附移动已暂停，点击落位 / Esc 取消'
                  : '再次点击放置便签，Esc 取消'}
            </span>
        </div>
      )}
    </section>
  );
};

// Wrapped Canvas with Profiler and FPS Monitor
export const CanvasWithProfiler: React.FC = () => {
  // Activate FPS monitoring for the canvas
  useFPSMonitor();

  const handleProfilerRender: React.ProfilerOnRenderCallback = useCallback(
    (_id, phase, actualDuration) => {
      diagnostics.updateMetrics({ lastRenderDuration: Math.round(actualDuration) });
      if (actualDuration > 50) {
        diagnostics.recordSlowPath(`Canvas render (${phase})`, actualDuration);
      }
    },
    []
  );

  return (
    <Profiler id="Canvas" onRender={handleProfilerRender}>
      <Canvas />
    </Profiler>
  );
};
