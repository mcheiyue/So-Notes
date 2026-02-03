import React, { useRef, useEffect } from "react";
import { useStore } from "../store/useStore";
import { NoteCard } from "./NoteCard";
import { ContextMenu } from "./ContextMenu";
import { cn } from "../utils/cn";

export const Canvas: React.FC = () => {
  const { notes, addNote, init, isLoaded, stickyDrag, setStickyDrag, moveNote, setContextMenu, setSelectedIds, selectedIds, moveSelectedNotes, clearSelection } = useStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const scale = 1;

  // Selection Logic Refs
  const isSelecting = useRef(false);
  const selectionStart = useRef({ x: 0, y: 0 });
  const selectionBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const bootstrap = async () => {
      await init();
    };
    bootstrap();
  }, [init]);

  const handleMouseMove = (e: React.MouseEvent) => {
      // 1. Sticky Drag Logic
      if (stickyDrag.id) {
          const newX = (e.clientX - stickyDrag.offsetX) / scale;
          const newY = (e.clientY - stickyDrag.offsetY) / scale;
          
          const currentNote = notes.find(n => n.id === stickyDrag.id);
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
        const x = e.clientX;
        const y = e.clientY;
        addNote(x, y);
    }
  };
  
  const applyBoundaryGuard = (id: string) => {
      const winW = window.innerWidth;
      const winH = window.innerHeight;
      
      // Determine if we are guarding a group or single note
      const isSelected = selectedIds.includes(id);
      const idsToCheck = (isSelected && selectedIds.length > 0) ? selectedIds : [id];
      
      idsToCheck.forEach(noteId => {
          // Note: We need to access LATEST state? 'notes' prop is from useStore hook, which updates on re-render.
          // handleGlobalDown triggers a re-render? No, it's an event handler.
          // 'notes' inside this closure might be stale if handleMouseMove updated store but component didn't re-render yet?
          // Sticky Drag is high frequency. React state updates might be batched.
          // Safer to use useStore.getState().notes
          const state = useStore.getState();
          const n = state.notes.find(item => item.id === noteId);
          
          if (n) {
              let finalX = n.x;
              let finalY = n.y;
              let changed = false;

              if (finalX < 0) { finalX = 0; changed = true; }
              if (finalY < 0) { finalY = 0; changed = true; }
              if (finalX > winW - 100) { finalX = winW - 100; changed = true; }
              if (finalY > winH - 50) { finalY = winH - 50; changed = true; }

              if (changed) {
                  moveNote(noteId, finalX, finalY);
              }
          }
      });
  };

  const handleGlobalDown = (e: React.MouseEvent) => {
      // 1. Handle Sticky Drag Drop
      if (e.button !== 2 && stickyDrag.id) {
          applyBoundaryGuard(stickyDrag.id);
          setStickyDrag(null);
          return;
      }

      // 2. Start Marquee Selection (Left Click on Canvas)
      const target = e.target as HTMLElement;
      if (
          e.button === 0 && 
          !stickyDrag.id &&
          !target.closest('.note-card') && 
          !target.closest('button') && 
          !target.closest('.drag-handle-area')
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

  const handleGlobalUp = (e: React.MouseEvent) => {
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

  if (!isLoaded) return null;

  return (
    <div
      ref={containerRef}
      className={cn(
        "w-screen h-screen overflow-hidden relative select-none",
        "bg-zinc-50/90 dark:bg-zinc-50/98 dark:brightness-[0.90] dark:contrast-[0.95] dark:grayscale-[0.05] transition-colors duration-300",
        "border border-black/10 dark:border-white/10 rounded-lg"
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
               backgroundSize: '20px 20px'
           }}
      />

      <div 
          data-tauri-drag-region 
          className="drag-handle-area absolute top-0 left-0 w-full h-6 z-50 flex items-center justify-center group cursor-grab"
      >
          <div className="w-12 h-1 bg-black/10 rounded-full mt-2 transition-colors group-hover:bg-black/20" />
      </div>
      
      {/* Selection Box */}
      <div
        ref={selectionBoxRef}
        className="absolute z-[9999] bg-blue-500/10 border border-blue-500/50 border-dashed pointer-events-none"
        style={{ display: 'none' }}
      />
      
      {notes.map((note) => (
        <NoteCard key={note.id} note={note} scale={scale} /> 
      ))}
      
      <ContextMenu />

      {notes.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none select-none">
          <p className="text-lg font-medium text-black/30">
            双击空白处新建便签
          </p>
          <p className="text-xs text-black/20 mt-1">
            或右键点击 &rarr; 新建
          </p>
        </div>
      )}
      
      {stickyDrag.id && (
        <div className="fixed bottom-10 left-0 w-full text-center pointer-events-none z-[99999]">
            <span className="bg-black/80 text-white text-xs px-4 py-1.5 rounded-full shadow-lg backdrop-blur-md">
                再次点击放置便签
            </span>
        </div>
      )}
    </div>
  );
};
