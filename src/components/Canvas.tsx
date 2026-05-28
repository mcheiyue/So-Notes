import React, { useRef, useEffect, useCallback, useMemo, Profiler } from "react";
import { useStore } from "../store/useStore";
import { useViewportStore } from "../store";
import { NoteCard } from "./NoteCard";
import { cn } from "../utils/cn";
import { Z_INDEX } from "../constants/layout";
import { diagnostics } from "../utils/diagnostics";
import { useFPSMonitor } from "../utils/performance";
import {
  getEdgePushDragLeader,
} from "../utils/edgePushDragCompensation";
import { getNoteVisualHeight, getNoteVisualWidth } from "../utils/noteVisualMetrics";
import { getNoteElement } from "../utils/noteElementRegistry";
import { buildSmartPasteNoteInputs, parseSmartPaste } from "../utils/smartPaste";
import { getViewportSpawnOrigin } from "../utils/spawnPosition";
import { attach } from "../services/storage/StorageService";
import { CanvasEngine } from "../canvas/CanvasEngine";
import { useCanvasGlobalListeners } from "../hooks/useCanvasGlobalListeners";



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
  const vpState = useViewportStore.getState();
  return vpState.interaction.isDragging || getEdgePushDragLeader() !== null || vpState.stickyDrag.id !== null;
};

export const Canvas: React.FC = () => {
  const isLoaded = useStore((s) => s.isLoaded);
  const currentBoardId = useStore((s) => s.currentBoardId);

  const stickyDragId = useViewportStore((s) => s.stickyDrag.id);
  const stickyDragStatus = useViewportStore((s) => s.stickyDrag.status);
  const isPanMode = useViewportStore((s) => s.interaction.isPanMode);
  const isDragging = useViewportStore((s) => s.interaction.isDragging);
  const edgePush = useViewportStore((s) => s.interaction.edgePush);
  const viewport = useViewportStore((s) => s.viewport);

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
  const selectionBoxRef = useRef<HTMLDivElement>(null);
  const storageHandleRef = useRef<ReturnType<typeof attach> | null>(null);
  const engineRef = useRef<CanvasEngine>(null);
  if (!engineRef.current) {
    engineRef.current = new CanvasEngine();
  }
  const engine = engineRef.current;
  const scale = 1;

  useEffect(() => {
    engine.bindRefs(worldLayerRef, selectionBoxRef);
  }, [engine]);

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

  const handleGlobalUp = useCallback((e: React.MouseEvent | MouseEvent) => {
    if (engine.isPanning.current) {
      engine.isPanning.current = false;
      engine.stopPanFlushLoop();
      const vp = useViewportStore.getState().viewport;
      useViewportStore.getState().setViewportPosition(vp.x, vp.y);
      return;
    }

    if (engine.isSelecting.current) {
      engine.isSelecting.current = false;
      if (selectionBoxRef.current) {
        selectionBoxRef.current.style.display = 'none';
      }

      const bounds = getCanvasBounds();
      const startX = engine.selectionStart.x - bounds.left;
      const startY = engine.selectionStart.y - bounds.top;
      const endX = e.clientX - bounds.left;
      const endY = e.clientY - bounds.top;

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

      const vp = useViewportStore.getState().viewport;
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
  }, [engine]);

  useCanvasGlobalListeners({ engine, handleGlobalUp });

  useEffect(() => {
    return () => {
      engine.dispose();
    };
  }, [engine]);

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      await useStore.getState().init();
      if (cancelled) return;

      const handle = attach({
        onStatusChange: (status) => {
          switch (status) {
            case 'writing-wal':
            case 'writing-disk':
              useStore.setState({ isSaving: true, saveStatus: 'saving', saveError: null });
              break;
            case 'idle':
              useStore.setState({ isSaving: false, saveStatus: 'saved', saveError: null, lastSavedAt: Date.now() });
              break;
            case 'error':
              useStore.setState({ isSaving: false, saveStatus: 'error', saveError: '持久化写入失败。' });
              break;
          }
        },
      });
      storageHandleRef.current = handle;
    };
    bootstrap();

    return () => {
      cancelled = true;
      storageHandleRef.current?.detach();
      storageHandleRef.current = null;
    };
  }, []);

  useEffect(() => {
    engine.syncEdgePushLoop();
    return () => {
      engine.stopEdgePushLoop();
    };
  }, [engine, edgePush]);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (e.buttons === 0) {
      engine.resetPointerInteractions();
    }

    if (engine.isPanning.current) {
      const dx = e.clientX - engine.panStart.x;
      const dy = e.clientY - engine.panStart.y;
      engine.panDelta.x -= dx;
      engine.panDelta.y -= dy;
      engine.panStart.x = e.clientX;
      engine.panStart.y = e.clientY;
      engine.schedulePanFlushLoop();
      return;
    }

    if (stickyDragId) {
      const localPoint = toCanvasLocalPoint(e.clientX, e.clientY);
      const vpState = useViewportStore.getState();
      const legacyState = useStore.getState();
      if (vpState.stickyDrag.status === 'suspended') {
        return;
      }
      const vp = vpState.viewport;
      const newX = (localPoint.x - vpState.stickyDrag.offsetX) / scale + vp.x;
      const newY = (localPoint.y - vpState.stickyDrag.offsetY) / scale + vp.y;

      const currentNote = legacyState.notesById[stickyDragId];
      const isSelected = legacyState.selectedIds.includes(stickyDragId);
      const ids = engine.getStickyDragIds();

      if (isSelected && ids.length > 1 && currentNote) {
        const dx = newX - currentNote.x;
        const dy = newY - currentNote.y;
        ids.forEach((id) => {
          if (id === stickyDragId) return;
          const el = getNoteElement(id);
          if (!el) return;
          const note = legacyState.notesById[id];
          if (!note) return;
          const previewX = note.x + dx;
          const previewY = note.y + dy;
          el.style.transform = `translate(${previewX}px, ${previewY}px)`;
          engine.setStickyDragPreviewPosition(id, previewX, previewY);
        });
        const leaderEl = getNoteElement(stickyDragId);
        if (leaderEl) leaderEl.style.transform = `translate(${newX}px, ${newY}px)`;
        engine.setStickyDragPreviewPosition(stickyDragId, newX, newY);
      } else {
        const el = getNoteElement(stickyDragId);
        if (el) el.style.transform = `translate(${newX}px, ${newY}px)`;
        engine.setStickyDragPreviewPosition(stickyDragId, newX, newY);
      }
      return;
    }

    if (engine.isSelecting.current && selectionBoxRef.current) {
      const currentPoint = toCanvasLocalPoint(e.clientX, e.clientY);
      const startPoint = toCanvasLocalPoint(engine.selectionStart.x, engine.selectionStart.y);
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

    const localPoint = toCanvasLocalPoint(e.clientX, e.clientY);
    const vp = useViewportStore.getState().viewport;
    const x = localPoint.x + vp.x;
    const y = localPoint.y + vp.y;
    useStore.getState().addNote(x, y);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    if (isDragInteractionLocked()) {
      return;
    }

    const target = getEventTargetElement(e.target);
    if (target && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable))) {
      return;
    }

    const state = useStore.getState();
    if (state.isSpotlightOpen || state.isQuickCaptureOpen || state.smartPasteSplitPanel || state.contextMenu.isOpen) {
      return;
    }

    const text = e.clipboardData.getData('text/plain');
    const vp = useViewportStore.getState().viewport;
    const origin = getViewportSpawnOrigin(vp);
    const result = parseSmartPaste(text);
    const notes = buildSmartPasteNoteInputs(result.source ? [result.source] : [], origin.x, origin.y);

    if (notes.length === 0) {
      return;
    }

    e.preventDefault();
    const store = useStore.getState();
    const createdIds = store.addNotesWithContentBatch(notes) ?? [];
    if (createdIds.length > 0 && result.options.length > 1) {
      store.openSmartPasteSplitPanel({ noteId: createdIds[0], result });
    }
  };

  const handleGlobalDown = (e: React.MouseEvent) => {
    const isBlankTarget = isBlankCanvasTarget(e.target);

    if (e.button !== 2 && stickyDragId) {
      engine.commitStickyDragPlacement();
      return;
    }

    if (isDragInteractionLocked()) {
      return;
    }

    if (useViewportStore.getState().interaction.isPanMode && e.button === 0 && isBlankTarget) {
      engine.isPanning.current = true;
      engine.panStart.x = e.clientX;
      engine.panStart.y = e.clientY;
      return;
    }

    if (useViewportStore.getState().interaction.isDragging) {
      return;
    }

    if (e.button === 0 && !stickyDragId && isBlankTarget) {
      engine.isSelecting.current = true;
      engine.selectionStart.x = e.clientX;
      engine.selectionStart.y = e.clientY;
      const localPoint = toCanvasLocalPoint(e.clientX, e.clientY);

      if (selectionBoxRef.current) {
        selectionBoxRef.current.style.left = `${localPoint.x}px`;
        selectionBoxRef.current.style.top = `${localPoint.y}px`;
        selectionBoxRef.current.style.width = '0px';
        selectionBoxRef.current.style.height = '0px';
        selectionBoxRef.current.style.display = 'block';
      }
      
      if (!e.shiftKey && !e.ctrlKey) {
        useStore.getState().clearSelection();
      }
    }
  };

  if (!isLoaded) return null;

  return (
    <section
      ref={containerRef}
      role="application"
      tabIndex={0}
      className={cn(
        "w-full h-full overflow-hidden relative select-none outline-none focus:outline-none focus-visible:outline-none",
        isPanMode ? "cursor-grab active:cursor-grabbing" : "cursor-default"
      )}
      onDoubleClick={handleDoubleClick}
      onPaste={handlePaste}
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
               backgroundImage: `radial-gradient(circle, var(--color-border-subtle) 1px, transparent 1px)`,
               backgroundSize: '20px 20px',
               backgroundPosition: `-${viewport.x}px -${viewport.y}px`
           }}
      />
      
      <div className={cn("absolute top-0 left-0 right-0 h-8 bg-gradient-to-b from-blue-500/20 to-transparent pointer-events-none transition-opacity duration-300", edgePush.top ? "opacity-100" : "opacity-0")} />
      <div className={cn("absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-blue-500/20 to-transparent pointer-events-none transition-opacity duration-300", edgePush.bottom ? "opacity-100" : "opacity-0")} />
      <div className={cn("absolute top-0 bottom-0 left-0 w-8 bg-gradient-to-r from-blue-500/20 to-transparent pointer-events-none transition-opacity duration-300", edgePush.left ? "opacity-100" : "opacity-0")} />
      <div className={cn("absolute top-0 bottom-0 right-0 w-8 bg-gradient-to-l from-blue-500/20 to-transparent pointer-events-none transition-opacity duration-300", edgePush.right ? "opacity-100" : "opacity-0")} />

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

export const CanvasWithProfiler: React.FC = () => {
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
