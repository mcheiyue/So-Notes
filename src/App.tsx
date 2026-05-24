import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "./store/useStore";
import { CanvasWithProfiler } from "./components/Canvas";
import { TrashGrid } from "./components/TrashGrid";
import { BoardDock } from "./components/BoardDock";
import { PinFab } from "./components/PinFab";
import { ContextMenu } from "./components/ContextMenu";
import { MiniMap } from "./components/MiniMap";
import ShortcutsManager from "./components/ShortcutsManager";
import { Spotlight } from "./components/Spotlight";
import { QuickCaptureOverlay } from "./components/QuickCaptureOverlay";
import { SmartPasteSplitBubble } from "./components/SmartPasteSplitBubble";
import { WindowShell, WindowShellContentRect } from "./components/WindowShell";
import { Z_INDEX } from "./constants/layout";
import { useFPSMonitor } from "./utils/performance";
import { diagnostics } from "./utils/diagnostics";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { createSmartPasteNoteInputs } from "./utils/smartPaste";

function App() {
  const isMouseDownRef = useRef(false);
  const [globalShortcutError, setGlobalShortcutError] = useState<string | null>(null);
  const viewMode = useStore(state => state.viewMode);
  const isSpotlightOpen = useStore(state => state.isSpotlightOpen);
  const notesById = useStore(state => state.notesById);
  const allNoteIds = useStore(state => state.allNoteIds);
  const boardNoteIds = useStore(state => state.boardNoteIds);
  const currentBoardId = useStore(state => state.currentBoardId);
  const selectedIds = useStore(state => state.selectedIds);

  const { start: startFPS, stop: stopFPS } = useFPSMonitor();

  useEffect(() => {
    startFPS((data) => {
      diagnostics.updateFPS(data.fps, data.jankCount);
    });
    return stopFPS;
  }, [startFPS, stopFPS]);

  useEffect(() => {
    const totalNotes = allNoteIds.length;
    const currentBoardNotes = (boardNoteIds[currentBoardId] ?? []).filter((id) => !notesById[id]?.deletedAt).length;
    const trashNotes = allNoteIds.filter((id) => notesById[id]?.deletedAt).length;
    diagnostics.updateNoteStats(totalNotes, currentBoardNotes, selectedIds.length, trashNotes);
  }, [allNoteIds, boardNoteIds, currentBoardId, notesById, selectedIds]);

  const syncViewportToShell = useCallback((rect: WindowShellContentRect) => {
    const nextWidth = Math.max(0, rect.width);
    const nextHeight = Math.max(0, rect.height);
    const { viewport, shellRect, setViewportSize, setShellRect } = useStore.getState();

    if (viewport.w !== nextWidth || viewport.h !== nextHeight) {
      setViewportSize(nextWidth, nextHeight);
    }

    if (
      shellRect.left !== rect.left ||
      shellRect.top !== rect.top ||
      shellRect.right !== rect.right ||
      shellRect.bottom !== rect.bottom
    ) {
      setShellRect({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      });
    }
  }, []);

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

    // Listen for reset-viewport event from backend tray menu
    const unlistenReset = listen('reset-viewport', () => {
        useStore.getState().setViewportPosition(0, 0);
    });

    const unlistenPin = listen<boolean>('pin-state-changed', (event) => {
      useStore.getState().setPinned(event.payload);
    });

    const unlistenQuickCapture = listen('open-quick-capture', () => {
      useStore.getState().setQuickCaptureOpen(true);
    });

    const unlistenTrayNewNote = listen('tray-new-note', () => {
      const { viewport, addNote } = useStore.getState();
      addNote(viewport.x + 40, viewport.y + 40);
    });

    const unlistenClipboardNote = listen('create-note-from-clipboard', async () => {
      const text = await readText().catch(() => '');
      const { viewport, addNotesWithContentBatch } = useStore.getState();
      const notes = createSmartPasteNoteInputs(text, viewport.x + 40, viewport.y + 40);
      if (notes.length > 0) {
        addNotesWithContentBatch(notes);
      }
    });

    const unlistenGlobalShortcutError = listen<string>('global-shortcut-register-failed', (event) => {
      setGlobalShortcutError(event.payload);
    });

    invoke<boolean>('get_pin_mode')
      .then((pinned) => {
        useStore.getState().setPinned(pinned);
      })
      .catch((error) => {
        console.warn('Failed to sync pin mode on startup:', error);
      });

    invoke<string | null>('get_global_shortcut_error')
      .then((error) => {
        setGlobalShortcutError(error ?? null);
      })
      .catch((error) => {
        console.warn('Failed to sync global shortcut status on startup:', error);
      });

    return () => {
      unlistenReset.then(f => f());
      unlistenPin.then(f => f());
      unlistenQuickCapture.then(f => f());
      unlistenTrayNewNote.then(f => f());
      unlistenClipboardNote.then(f => f());
      unlistenGlobalShortcutError.then(f => f());
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, []);

  const shellOverlay = (
    <>
      {viewMode === 'BOARD' && (
        <>
          <div className="pointer-events-none absolute top-8 left-4" style={{ zIndex: Z_INDEX.BOARD_BADGE }}>
            <BoardBadge />
          </div>

          <PinFab />
          <MiniMap />
          {isSpotlightOpen && <Spotlight />}
        </>
      )}

      <BoardDock />
    </>
  );

  return (
    <>
      <WindowShell overlay={shellOverlay} onContentRectChange={syncViewportToShell}>
        {viewMode === 'BOARD' ? <CanvasWithProfiler /> : <TrashGrid />}
      </WindowShell>

      <ContextMenu />
      <ShortcutsManager />
      <SmartPasteSplitBubble />
      <QuickCaptureOverlay />
      {globalShortcutError && (
        <div
          className="fixed left-1/2 top-4 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-900 shadow-xl"
          style={{ zIndex: Z_INDEX.QUICK_CAPTURE + 1 }}
          role="status"
        >
          <div className="font-medium">全局快捷键不可用</div>
          <div className="mt-1 text-xs leading-relaxed">
            {globalShortcutError}。请检查快捷键是否被其他应用占用，或系统是否限制了全局快捷键权限。
          </div>
        </div>
      )}
    </>
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
