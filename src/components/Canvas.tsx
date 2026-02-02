import React, { useRef, useEffect } from "react";
import { useStore } from "../store/useStore";
import { NoteCard } from "./NoteCard";
import { Plus } from "lucide-react";
import { cn } from "../utils/cn";
import { Tooltip } from "./Tooltip";

export const Canvas: React.FC = () => {
  const { notes, addNote, init, isLoaded, stickyDrag, setStickyDrag, moveNote } = useStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const scale = 1;

  useEffect(() => {
    const bootstrap = async () => {
      await init();
    };
    bootstrap();
  }, [init]);

  const handleMouseMove = (e: React.MouseEvent) => {
      if (stickyDrag.id) {
          const newX = (e.clientX - stickyDrag.offsetX) / scale;
          const newY = (e.clientY - stickyDrag.offsetY) / scale;
          moveNote(stickyDrag.id, newX, newY);
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
  
  const handleAddNote = (e: React.MouseEvent) => {
      e.stopPropagation();
      const winW = window.innerWidth;
      const winH = window.innerHeight;
      addNote(winW / 2 - 130, winH / 2 - 80);
  };

  const applyBoundaryGuard = (id: string) => {
      const currentNote = notes.find(n => n.id === id);
      if (currentNote) {
          const winW = window.innerWidth;
          const winH = window.innerHeight;
          let newX = currentNote.x;
          let newY = currentNote.y;
          let corrected = false;

          // 1. Left/Top Walls (Prevent negative coordinates)
          if (newX < 0) { newX = 0; corrected = true; }
          if (newY < 0) { newY = 0; corrected = true; }

          // 2. Right/Bottom Walls (Ensure visibility)
          if (newX > winW - 50) { newX = winW - 220; corrected = true; }
          if (newY > winH - 50) { newY = winH - 100; corrected = true; }

          if (corrected) {
              moveNote(id, newX, newY);
          }
      }
  };

  // Handle Global Drop
  const handleGlobalDown = (e: React.MouseEvent) => {
      if (e.button !== 2 && stickyDrag.id) {
          applyBoundaryGuard(stickyDrag.id);
          setStickyDrag(null);
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
      onContextMenu={(e) => {
          if (stickyDrag.id) {
              e.preventDefault();
              applyBoundaryGuard(stickyDrag.id);
              setStickyDrag(null);
          } else {
              e.preventDefault(); 
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
      
      {notes.map((note) => (
        <NoteCard key={note.id} note={note} scale={scale} /> 
      ))}
      
      {notes.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none select-none">
          <p className="text-lg font-medium text-black/30">
            双击空白处新建便签
          </p>
          <p className="text-xs text-black/20 mt-1">
            或点击右下角按钮
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
      
      <div className="absolute bottom-6 right-6 z-[100]">
        <Tooltip content="新建便签">
          <button 
            onClick={handleAddNote}
            className={cn(
                "w-12 h-12 rounded-full",
                "bg-slate-900 text-white hover:bg-slate-800",
                "shadow-xl hover:shadow-2xl hover:scale-105 active:scale-95",
                "flex items-center justify-center",
                "transition-all duration-200 ease-out"
            )}
          >
            <Plus className="w-6 h-6" strokeWidth={2.5} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
};
