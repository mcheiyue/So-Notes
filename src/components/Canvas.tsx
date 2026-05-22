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
  return state.interaction.isDragging || getEdgePushDragLeader() !== null;
};

export const Canvas: React.FC = () => {
  // 细粒度订阅：只订阅渲染路径真正需要的状态
  const isLoaded = useStore((s) => s.isLoaded);
  const currentBoardId = useStore((s) => s.currentBoardId);
  const stickyDragId = useStore((s) => s.stickyDrag.id);
  const selectedIds = useStore((s) => s.selectedIds);
  const isPanMode = useStore((s) => s.interaction.isPanMode);
  const edgePush = useStore((s) => s.interaction.edgePush);
  const viewport = useStore((s) => s.viewport);

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
    return currentBoardNoteIds.filter((id) => {
      const ln = layoutNotesById[id];
      if (!ln || ln.deletedAt) return false;
      return (
        ln.x >= throttledViewportRect.x - LAYOUT.NOTE_WIDTH &&
        ln.x <= throttledViewportRect.x + throttledViewportRect.w &&
        ln.y >= throttledViewportRect.y - LAYOUT.NOTE_MIN_HEIGHT &&
        ln.y <= throttledViewportRect.y + throttledViewportRect.h
      );
    });
  }, [currentBoardNoteIds, layoutNotesById, throttledViewportRect]);

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
          const vp = state.viewport;
          const newX = (localPoint.x - state.stickyDrag.offsetX) / scale + vp.x;
          const newY = (localPoint.y - state.stickyDrag.offsetY) / scale + vp.y;
          
          const currentNote = state.notesById[stickyDragId];
          const isSelected = state.selectedIds.includes(stickyDragId);
          
          if (isSelected && state.selectedIds.length > 1 && currentNote) {
              const dx = newX - currentNote.x;
              const dy = newY - currentNote.y;
              state.selectedIds.forEach((id) => {
                  if (id === stickyDragId) return;
                  const el = document.querySelector(`[data-id="${id}"]`) as HTMLElement | null;
                  if (!el) return;
                  const note = state.notesById[id];
                  if (!note) return;
                  el.style.transform = `translate(${note.x + dx}px, ${note.y + dy}px)`;
              });
              const leaderEl = document.querySelector(`[data-id="${stickyDragId}"]`) as HTMLElement | null;
              if (leaderEl) leaderEl.style.transform = `translate(${newX}px, ${newY}px)`;
          } else {
              const el = document.querySelector(`[data-id="${stickyDragId}"]`) as HTMLElement | null;
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
  
  const applyBoundaryGuard = (id: string) => {
      // Use useStore.getState() to access the latest viewport state
      const state = useStore.getState();
      
      // Determine if we are guarding a group or single note
      const isSelected = selectedIds.includes(id);
      const idsToCheck = (isSelected && selectedIds.length > 0) ? selectedIds : [id];
      
      idsToCheck.forEach(noteId => {
          const n = state.notesById[noteId];
          
          if (n) {
              let finalX = n.x;
              let finalY = n.y;
              let changed = false;

              // Infinite Canvas: Only enforce positive coordinates
              if (finalX < 0) { finalX = 0; changed = true; }
              if (finalY < 0) { finalY = 0; changed = true; }

              // Safe Mode Constraints (Consistent with Normal Drag)
                if (!state.interaction.isPanMode) {
                    const { x: vx, y: vy, w: vw, h: vh } = state.viewport;
                    // Match NoteCard.tsx logic: Keep note strictly inside viewport with 10px margin
                    // Assuming default dimensions since we don't have exact note size here
                    const ESTIMATED_W = LAYOUT.NOTE_WIDTH; 
                    const ESTIMATED_H = LAYOUT.NOTE_MIN_HEIGHT; 
                    const MARGIN = 10;
                    
                    const LIMIT_RIGHT = vx + vw - ESTIMATED_W - MARGIN;
                    const LIMIT_BOTTOM = vy + vh - ESTIMATED_H - MARGIN;
                    
                    // Clamp to Viewport
                    // Right Edge
                    if (finalX > LIMIT_RIGHT) { 
                        finalX = LIMIT_RIGHT; 
                        changed = true; 
                    }
                    // Bottom Edge
                    if (finalY > LIMIT_BOTTOM) { 
                        finalY = LIMIT_BOTTOM; 
                        changed = true; 
                    }
                    // Left/Top Viewport Edge
                    if (finalX < vx) { finalX = vx; changed = true; }
                    if (finalY < vy) { finalY = vy; changed = true; }
                }

              if (changed) {
                  useStore.getState().moveNote(noteId, finalX, finalY);
              }
          }
      });

      if (idsToCheck.length > 0) {
          useStore.getState().finalizeLayoutChange(idsToCheck);
      }
  };

    const handleGlobalDown = (e: React.MouseEvent) => {
    const isBlankTarget = isBlankCanvasTarget(e.target);

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

      // 1. Handle Sticky Drag Drop
      if (e.button !== 2 && stickyDragId) {
          const state = useStore.getState();
          const idsToCommit = (state.selectedIds.includes(stickyDragId) && state.selectedIds.length > 1)
            ? state.selectedIds
            : [stickyDragId];
          idsToCommit.forEach((id) => {
              const el = document.querySelector(`[data-id="${id}"]`) as HTMLElement | null;
              if (!el) return;
              const match = el.style.transform.match(/translate\(\s*([-\d.]+)px\s*,\s*([-\d.]+)px\s*\)/);
              if (match) {
                  state.moveNote(id, parseFloat(match[1]), parseFloat(match[2]));
              }
          });
          applyBoundaryGuard(stickyDragId);
          state.setStickyDrag(null);
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
          const newSelectedIds: string[] = [];
          
          for (const id of boardNoteIds) {
              const ln = layoutNotesById[id];
              if (!ln || ln.deletedAt) continue;
              
              const noteWidth = ln.width ?? LAYOUT.NOTE_WIDTH;
              const noteHeight = ln.height ?? LAYOUT.NOTE_MIN_HEIGHT;
              
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
          if (selectionBoxRef.current) {
              selectionBoxRef.current.style.display = 'none';
          }
      };

      window.addEventListener('mouseup', handleWindowUp);
      window.addEventListener('blur', handleWindowBlur);
      
      return () => {
          window.removeEventListener('mouseup', handleWindowUp);
          window.removeEventListener('blur', handleWindowBlur);
      };
  }, [handleGlobalUp, stopPanFlushLoop]);

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
              applyBoundaryGuard(stickyDragId);
              useStore.getState().setStickyDrag(null);
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
                再次点击放置便签
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
