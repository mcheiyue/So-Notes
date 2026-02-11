import React, { useRef, useEffect } from "react";
import { useStore } from "../store/useStore";
import { NoteCard } from "./NoteCard";
import { cn } from "../utils/cn";
import { LAYOUT, Z_INDEX } from "../constants/layout";

export const Canvas: React.FC = () => {
  const { 
    notes, currentBoardId, addNote, init, isLoaded, 
    stickyDrag, setStickyDrag, moveNote, setContextMenu, 
    setSelectedIds, selectedIds, moveSelectedNotes, clearSelection,
    interaction, viewport, setPanMode, panViewport, setViewportPosition
  } = useStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const scale = 1;

  // Selection Logic Refs
  const isSelecting = useRef(false);
  const selectionStart = useRef({ x: 0, y: 0 });
  const selectionBoxRef = useRef<HTMLDivElement>(null);

  // Pan Logic Refs
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  const panDeltaRef = useRef({ dx: 0, dy: 0 });
  const lastSpacePressTime = useRef<number>(0);
  
  // Edge Push Loop
  const edgePushFrameRef = useRef<number>(0);

  useEffect(() => {
    let frameId: number;
    const updateLoop = () => {
      if (panDeltaRef.current.dx !== 0 || panDeltaRef.current.dy !== 0) {
        panViewport(panDeltaRef.current.dx, panDeltaRef.current.dy);
        panDeltaRef.current = { dx: 0, dy: 0 };
      }
      frameId = requestAnimationFrame(updateLoop);
    };
    frameId = requestAnimationFrame(updateLoop);
    return () => cancelAnimationFrame(frameId);
  }, [panViewport]);

  useEffect(() => {
    const bootstrap = async () => {
      await init();
    };
    bootstrap();
  }, [init]);

  // Space Key Listener (Pan Mode)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check for Space key
      if (e.code === 'Space') {
        // Ignore input fields
        const active = document.activeElement;
        const isInput = active instanceof HTMLInputElement || 
                        active instanceof HTMLTextAreaElement || 
                        active?.getAttribute('contenteditable') === 'true';
        
          if (!isInput) {
             e.preventDefault(); 
             
             // Only toggle on initial press (ignore repeat events)
             if (!e.repeat) {
                 const now = Date.now();
                 const DOUBLE_PRESS_DELAY = 300;
                 
                 if (now - lastSpacePressTime.current < DOUBLE_PRESS_DELAY) {
                     // Double Press Detected: Reset Viewport
                     console.log('Space Double Press: Reset Viewport');
                     setViewportPosition(0, 0);
                     setPanMode(false); // Exit pan mode
                     lastSpacePressTime.current = 0; // Reset timer
                 } else {
                     // Single Press: Toggle Pan Mode
                     const currentMode = useStore.getState().interaction.isPanMode;
                     console.log('Space Toggle:', !currentMode); 
                     setPanMode(!currentMode);
                     lastSpacePressTime.current = now;
                 }
             }
          }
      }
    };

    // Ensure no stale listeners
    window.removeEventListener('keydown', handleKeyDown);
    window.addEventListener('keydown', handleKeyDown);
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [setPanMode, setViewportPosition]);

  // Edge Push Animation Loop
  useEffect(() => {
    const { top, bottom, left, right } = interaction.edgePush;
    if (!top && !bottom && !left && !right) {
        if (edgePushFrameRef.current) cancelAnimationFrame(edgePushFrameRef.current);
        return;
    }

    const pushLoop = () => {
        let dx = 0;
        let dy = 0;
        const SPEED = 5; // Pixels per frame (~300px/s)

        if (left) dx -= SPEED;
        if (right) dx += SPEED;
        if (top) dy -= SPEED;
        if (bottom) dy += SPEED;

        if (dx !== 0 || dy !== 0) {
            panViewport(dx, dy);
            // Move selected notes along with viewport to keep them static relative to screen
            // This prevents them from "drifting" away from the cursor during edge push
            if (selectedIds.length > 0) {
                moveSelectedNotes(dx, dy);
            }
        }
        edgePushFrameRef.current = requestAnimationFrame(pushLoop);
    };

    edgePushFrameRef.current = requestAnimationFrame(pushLoop);
    return () => {
        if (edgePushFrameRef.current) cancelAnimationFrame(edgePushFrameRef.current);
    };
  }, [interaction.edgePush, panViewport]);

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
          return;
      }

      // 1. Sticky Drag Logic
      if (stickyDrag.id) {
          const newX = (e.clientX - stickyDrag.offsetX) / scale + viewport.x;
          const newY = (e.clientY - stickyDrag.offsetY) / scale + viewport.y;
          
          const currentNote = useStore.getState().notes.find(n => n.id === stickyDrag.id);
          const isSelected = selectedIds.includes(stickyDrag.id);
          
          if (isSelected && selectedIds.length > 1 && currentNote) {
              const dx = newX - currentNote.x;
              const dy = newY - currentNote.y;
              moveSelectedNotes(dx, dy);
          } else {
              moveNote(stickyDrag.id, newX, newY);
          }
          return;
      }
      
      // 2. Marquee Selection Logic
      if (isSelecting.current && selectionBoxRef.current) {
          const currentX = e.clientX;
          const currentY = e.clientY;
          
          const startX = selectionStart.current.x;
          const startY = selectionStart.current.y;
          
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
    const target = e.target as HTMLElement;
    if (
        !target.closest('.note-card') && 
        !target.closest('button') && 
        !target.closest('.drag-handle-area')
    ) {
        // Fix: Convert Screen Coordinates to World Coordinates
        // The click (e.clientX) is in screen space.
        // The note needs to be placed in world space.
        const x = e.clientX + viewport.x;
        const y = e.clientY + viewport.y;
        addNote(x, y);
    }
  };
  
  const applyBoundaryGuard = (id: string) => {
      // Use useStore.getState() to access the latest viewport state
      const state = useStore.getState();
      
      // Determine if we are guarding a group or single note
      const isSelected = selectedIds.includes(id);
      const idsToCheck = (isSelected && selectedIds.length > 0) ? selectedIds : [id];
      
      idsToCheck.forEach(noteId => {
          const n = state.notes.find(item => item.id === noteId);
          
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
                  moveNote(noteId, finalX, finalY);
              }
          }
      });
  };

  const handleGlobalDown = (e: React.MouseEvent) => {
      // 0. Start Panning (Space Mode + Left Click on Background)
      const targetEl = e.target as HTMLElement;
      const isInteractive = targetEl.closest('.note-card') || targetEl.closest('button') || targetEl.closest('.drag-handle-area');

      if (interaction.isPanMode && e.button === 0 && !isInteractive) {
          isPanning.current = true;
          panStart.current = { x: e.clientX, y: e.clientY };
          return;
      }

      // 1. Handle Sticky Drag Drop
      if (e.button !== 2 && stickyDrag.id) {
          applyBoundaryGuard(stickyDrag.id);
          setStickyDrag(null);
          return;
      }

      // 2. Start Marquee Selection (Left Click on Canvas)
      const targetEl2 = e.target as HTMLElement;
      if (
          e.button === 0 && 
          !stickyDrag.id &&
          !targetEl2.closest('.note-card') && 
          !targetEl2.closest('button') && 
          !targetEl2.closest('.drag-handle-area')
      ) {
          isSelecting.current = true;
          selectionStart.current = { x: e.clientX, y: e.clientY };
          
          if (selectionBoxRef.current) {
              selectionBoxRef.current.style.left = `${e.clientX}px`;
              selectionBoxRef.current.style.top = `${e.clientY}px`;
              selectionBoxRef.current.style.width = '0px';
              selectionBoxRef.current.style.height = '0px';
              selectionBoxRef.current.style.display = 'block';
          }
          
          // Clear existing selection if not holding shift/ctrl (optional, for now simple clear)
          if (!e.shiftKey && !e.ctrlKey) {
             clearSelection();
          }
      }
  };

  const handleGlobalUp = (e: React.MouseEvent | MouseEvent) => {
      if (isPanning.current) {
          isPanning.current = false;
          return;
      }

      if (isSelecting.current) {
          isSelecting.current = false;
          if (selectionBoxRef.current) {
              selectionBoxRef.current.style.display = 'none';
          }
          
          // Calculate Selection
          const startX = selectionStart.current.x;
          const startY = selectionStart.current.y;
          const endX = e.clientX;
          const endY = e.clientY;
          
          const rect = {
              left: Math.min(startX, endX),
              top: Math.min(startY, endY),
              right: Math.max(startX, endX),
              bottom: Math.max(startY, endY)
          };
          
          // AABB Collision Detection
          // Note: Notes coordinates are in screen space (since scale=1)
          // But we need to account for note width/height.
          // NoteCard default size is roughly min-w-[200px] min-h-[100px] but variable.
          // Since we don't store w/h in store, we might need DOM lookup or assume default size for now?
          // Better: Use DOM elements to check collision since we are in React.
          
          const noteElements = document.querySelectorAll('.note-card');
          const newSelectedIds: string[] = [];
          
          noteElements.forEach((el) => {
              const domRect = el.getBoundingClientRect();
              
              // Check intersection
              const isIntersecting = !(
                  rect.right < domRect.left || 
                  rect.left > domRect.right || 
                  rect.bottom < domRect.top || 
                  rect.top > domRect.bottom
              );
              
              if (isIntersecting) {
                  const id = el.getAttribute('data-id');
                  if (id) newSelectedIds.push(id);
              }
          });
          
          if (newSelectedIds.length > 0) {
              setSelectedIds(newSelectedIds);
          }
      }
  };

  // Global Mouse Up & Blur Handler to prevent sticky drag
  useEffect(() => {
      const handleWindowUp = (e: MouseEvent) => handleGlobalUp(e);
      const handleWindowBlur = () => {
          isPanning.current = false;
          isSelecting.current = false;
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
  }, []);

  if (!isLoaded) return null;

  return (
    <div
      ref={containerRef}
      className={cn(
        "w-full h-full overflow-hidden relative select-none",
        "bg-zinc-50/90 dark:bg-zinc-50/98 dark:brightness-[0.90] dark:contrast-[0.95] dark:grayscale-[0.05] transition-colors duration-300",
        "border border-black/10 dark:border-white/10 rounded-lg",
        interaction.isPanMode ? "cursor-grab active:cursor-grabbing" : "cursor-default"
      )}
      onDoubleClick={handleDoubleClick}
      onMouseMove={handleMouseMove}
      onMouseDown={handleGlobalDown}
      onMouseUp={handleGlobalUp}
      onContextMenu={(e) => {
          e.preventDefault();
          if (stickyDrag.id) {
              applyBoundaryGuard(stickyDrag.id);
              setStickyDrag(null);
          } else {
              setContextMenu({
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
               backgroundImage: `radial-gradient(circle, #cbd5e1 1px, transparent 1px)`,
               backgroundSize: '20px 20px',
               backgroundPosition: `-${viewport.x}px -${viewport.y}px`
           }}
      />
      
      {/* Edge Push Indicators */}
      <div className={cn("absolute top-0 left-0 right-0 h-8 bg-gradient-to-b from-blue-500/20 to-transparent pointer-events-none transition-opacity duration-300", interaction.edgePush.top ? "opacity-100" : "opacity-0")} />
      <div className={cn("absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-blue-500/20 to-transparent pointer-events-none transition-opacity duration-300", interaction.edgePush.bottom ? "opacity-100" : "opacity-0")} />
      <div className={cn("absolute top-0 bottom-0 left-0 w-8 bg-gradient-to-r from-blue-500/20 to-transparent pointer-events-none transition-opacity duration-300", interaction.edgePush.left ? "opacity-100" : "opacity-0")} />
      <div className={cn("absolute top-0 bottom-0 right-0 w-8 bg-gradient-to-l from-blue-500/20 to-transparent pointer-events-none transition-opacity duration-300", interaction.edgePush.right ? "opacity-100" : "opacity-0")} />
      
      {/* Board Badge moved to App.tsx for better reactivity */}

      <div 
          data-tauri-drag-region 
          className="drag-handle-area absolute top-0 left-0 w-full h-6 flex items-center justify-center group cursor-grab"
          style={{ zIndex: Z_INDEX.DRAG_HANDLE_AREA }}
      >
          <div className="w-12 h-1 bg-black/10 rounded-full mt-2 transition-colors group-hover:bg-black/20" />
      </div>
      
      {/* Selection Box */}
      <div
        ref={selectionBoxRef}
        className="absolute bg-blue-500/10 border border-blue-500/50 border-dashed pointer-events-none"
        style={{ display: 'none', zIndex: Z_INDEX.SELECTION_BOX }}
      />
      
      {notes
        .filter(note => note.boardId === currentBoardId && !note.deletedAt) // Filter by current board and not deleted
        .map((note) => (
        <NoteCard key={note.id} id={note.id} scale={scale} /> 
      ))}
      
      {notes.filter(n => n.boardId === currentBoardId && !n.deletedAt).length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none select-none">
          <p className="text-lg font-medium text-black/30">
            {currentBoardId === 'default' ? '双击空白处新建便签' : '当前看板为空'}
          </p>
          <p className="text-xs text-black/20 mt-1">
            或右键点击 &rarr; 新建
          </p>
        </div>
      )}
      
      {interaction.isPanMode && (
        <div 
            className="fixed top-6 left-1/2 -translate-x-1/2 px-4 py-2 bg-white/60 dark:bg-zinc-800/60 text-zinc-600 dark:text-zinc-300 border border-white/20 dark:border-zinc-700/50 shadow-lg rounded-full text-xs font-medium backdrop-blur-xl pointer-events-none transition-all animate-in fade-in zoom-in-95 duration-300 select-none flex items-center gap-2"
            style={{ zIndex: Z_INDEX.PAN_MODE_BADGE }}
        >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.5)]" />
            按 Space 退出
        </div>
      )}
      
      {stickyDrag.id && (
        <div 
            className="fixed bottom-10 left-0 w-full text-center pointer-events-none"
            style={{ zIndex: Z_INDEX.STICKY_DRAG_MSG }}
        >
            <span className="bg-black/80 text-white text-xs px-4 py-1.5 rounded-full shadow-lg backdrop-blur-md">
                再次点击放置便签
            </span>
        </div>
      )}
    </div>
  );
};
