import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "./store/useStore";
import { Canvas } from "./components/Canvas";
import { TrashGrid } from "./components/TrashGrid";
import { BoardDock } from "./components/BoardDock";
import { PinFab } from "./components/PinFab";
import { ContextMenu } from "./components/ContextMenu";
import { MiniMap } from "./components/MiniMap";
import ShortcutsManager from "./components/ShortcutsManager";
import { Spotlight } from "./components/Spotlight";

function App() {
  const isMouseDownRef = useRef(false);
  const viewMode = useStore(state => state.viewMode);
  const isSpotlightOpen = useStore(state => state.isSpotlightOpen);

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

    const handleResize = () => {
        const setViewportSize = useStore.getState().setViewportSize;
        setViewportSize(window.innerWidth, window.innerHeight);
    };

    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('mouseleave', handleMouseLeave);
    window.addEventListener('resize', handleResize);

    // Listen for reset-viewport event from backend tray menu
    const unlistenReset = listen('reset-viewport', () => {
        useStore.getState().setViewportPosition(0, 0);
    });

    return () => {
      unlistenReset.then(f => f());
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('mouseleave', handleMouseLeave);
      window.removeEventListener('resize', handleResize);
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
           <MiniMap />
           <ShortcutsManager />
           {isSpotlightOpen && <Spotlight />}
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
        <div className="flex items-center gap-2 px-3 py-1.5 bg-secondary-bg/50 backdrop-blur-sm rounded-lg text-xs font-medium text-text-tertiary transition-all duration-300 border border-border-subtle/20">
            <span>{board?.icon || '📌'}</span>
            <span>{board?.name || 'Main'}</span>
        </div>
    );
};

export default App;
