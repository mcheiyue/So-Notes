import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Canvas } from "./components/Canvas";
import { BoardDock } from "./components/BoardDock";
import { PinFab } from "./components/PinFab";
import { ContextMenu } from "./components/ContextMenu";

function App() {
  const isMouseDownRef = useRef(false);

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
       <Canvas />
       {/* UI Overlay Components - Moved out of Canvas to avoid filter/transform issues */}
       <BoardDock />
       <PinFab />
       <ContextMenu />
    </div>
  );
}

export default App;
