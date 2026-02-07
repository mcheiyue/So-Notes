import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store/useStore";
import { Canvas } from "./components/Canvas";
import { TrashGrid } from "./components/TrashGrid";
import { BoardDock } from "./components/BoardDock";
import { PinFab } from "./components/PinFab";
import { ContextMenu } from "./components/ContextMenu";

function App() {
  const isMouseDownRef = useRef(false);
  const viewMode = useStore(state => state.viewMode);

  useEffect(() => {
    const handleMouseDown = () => { isMouseDownRef.current = true; };
    const handleMouseUp = () => { isMouseDownRef.current = false; };
    
    const handleBlur = () => {
      if (!isMouseDownRef.current) {
        invoke('check_hide_on_leave');
      }
    };

    const handleMouseLeave = () => {
       invoke('check_hide_on_leave');
    };

    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('mouseleave', handleMouseLeave);

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    
    const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
      if (e.matches) {
        document.documentElement.classList.add('dark');
        document.documentElement.classList.add('os-dark'); 
      } else {
        document.documentElement.classList.remove('dark');
        document.documentElement.classList.remove('os-dark');
      }
    };

    handleChange(mediaQuery);

    mediaQuery.addEventListener('change', handleChange);
    return () => {
      mediaQuery.removeEventListener('change', handleChange);
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, []);

  return (
    <div className="w-full h-screen fixed inset-0 overflow-hidden">
       {viewMode === 'BOARD' ? (
         <>
           <Canvas />
           {/* UI Overlay Components - Moved out of Canvas to avoid filter/transform issues */}
           
           {/* Board Indicator (Top Left) */}
           <div className="fixed top-8 left-4 pointer-events-none z-[50]">
              <BoardBadge />
           </div>
           
           <PinFab />
           <ContextMenu />
         </>
       ) : (
         <TrashGrid />
       )}
       
       <BoardDock />
    </div>
  );
}

// Extracted for cleaner re-renders
const BoardBadge = () => {
    const { boards, currentBoardId } = useStore();
    const board = boards.find(b => b.id === currentBoardId);
    
    return (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-black/5 dark:bg-white/5 rounded-lg text-xs font-medium text-black/30 dark:text-white/30 backdrop-blur-sm transition-all duration-300">
            <span>{board?.icon || '📌'}</span>
            <span>{board?.name || 'Main'}</span>
        </div>
    );
};

export default App;
