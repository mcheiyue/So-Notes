import React, { useRef, useEffect } from "react";
import { useStore } from "../store/useStore";
import { NoteCard } from "./NoteCard";

import { Plus } from "lucide-react";
import { cn } from "../utils/cn";
import { Tooltip } from "./Tooltip";

export const Canvas: React.FC = () => {
  const { notes, addNote, init, isLoaded } = useStore();
  const containerRef = useRef<HTMLDivElement>(null);

  // Initialize Store & Anti-Flash
  useEffect(() => {
    const bootstrap = async () => {
      await init();
      // Ensure window is hidden on start if not already
      // Commented out show() is correct.
      // But we might need to ensure backend doesn't show it.
    };
    bootstrap();
  }, [init]);

  const handleDoubleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    // Strict check to prevent accidental creation
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

  if (!isLoaded) return null;

  return (
    <div
      ref={containerRef}
      className={cn(
        "w-screen h-screen overflow-hidden relative select-none",
        // Minimalist White with Glassmorphism
        // Adapted for Deep Mode: More opaque in dark mode to prevent muddiness
        "bg-zinc-50/90 dark:bg-zinc-50/98 dark:brightness-[0.90] dark:contrast-[0.95] dark:grayscale-[0.05] transition-colors duration-300",
        "border border-black/10 dark:border-white/10 rounded-lg"
      )}
      onDoubleClick={handleDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Subtle Grid Pattern */}
      <div className="absolute inset-0 pointer-events-none opacity-[0.08]" 
           style={{
               backgroundImage: `radial-gradient(circle, #cbd5e1 1px, transparent 1px)`,
               backgroundSize: '20px 20px'
           }}
      />

      {/* Windows Title Bar / Drag Region */}
      <div 
          data-tauri-drag-region 
          className="drag-handle-area absolute top-0 left-0 w-full h-6 z-50 flex items-center justify-center group cursor-grab"
      >
          {/* Handle Pill */}
          <div className="w-12 h-1 bg-black/10 rounded-full mt-2 transition-colors group-hover:bg-black/20" />
      </div>
      
      {notes.map((note) => (
        <NoteCard key={note.id} note={note} scale={1} /> 
      ))}
      
      {/* Empty State - Localized */}
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
      
      {/* Solid High-Contrast FAB */}
      <div className="absolute bottom-6 right-6 z-[100]">
        <Tooltip content="新建便签">
          <button 
            onClick={handleAddNote}
            className={cn(
                "w-12 h-12 rounded-full",
                // Fixed Dark Slate style for minimalist look
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
