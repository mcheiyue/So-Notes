import { useCallback, useEffect, useState } from "react";
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
import { SelectionActionBar } from "./components/SelectionActionBar";
import { WindowShell, WindowShellContentRect } from "./components/WindowShell";
import { Z_INDEX } from "./constants/layout";
import { useFPSMonitor } from "./utils/performance";
import { diagnostics } from "./utils/diagnostics";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { appController } from "./controllers/appController";

const getOrganizationUndoToastCopy = (action: 'arrange' | 'merge' | 'split', noteCount: number) => {
  if (action === 'merge') {
    return {
      title: `已合并 ${noteCount} 个便签`,
      description: '可删除本次新建的合并结果。',
      closeLabel: '关闭合并撤销提示',
    };
  }

  if (action === 'split') {
    return {
      title: `已拆分出 ${noteCount} 个便签`,
      description: '可删除本次新建的拆分结果。',
      closeLabel: '关闭拆分撤销提示',
    };
  }

  return {
    title: `已归拢 ${noteCount} 个便签`,
    description: '可恢复到本次归拢前的位置。',
    closeLabel: '关闭归拢撤销提示',
  };
};

function App() {
  const [globalShortcutError, setGlobalShortcutError] = useState<string | null>(null);
  const viewMode = useStore(state => state.viewMode);
  const isSpotlightOpen = useStore(state => state.isSpotlightOpen);
  const notesById = useStore(state => state.notesById);
  const allNoteIds = useStore(state => state.allNoteIds);
  const boardNoteIds = useStore(state => state.boardNoteIds);
  const currentBoardId = useStore(state => state.currentBoardId);
  const selectedIds = useStore(state => state.selectedIds);
  const arrangeUndoToast = useStore(state => state.arrangeUndoToast);

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

  useEffect(() => {
    if (!arrangeUndoToast) return undefined;

    const timeoutId = window.setTimeout(() => {
      appController.dismissArrangeUndoToast();
    }, 6000);

    return () => window.clearTimeout(timeoutId);
  }, [arrangeUndoToast]);

  const syncViewportToShell = useCallback((rect: WindowShellContentRect) => {
    appController.syncShellViewport(rect);
  }, []);

  useEffect(() => {
    const handleMouseLeave = () => {
       invoke('check_hide_on_leave');
    };

    document.addEventListener('mouseleave', handleMouseLeave);

    // Listen for reset-viewport event from backend tray menu
    const unlistenReset = listen('reset-viewport', () => {
        appController.resetViewport();
    });

    const unlistenPin = listen<boolean>('pin-state-changed', (event) => {
      appController.setPinned(event.payload);
    });

    const unlistenQuickCapture = listen('open-quick-capture', () => {
      appController.openQuickCapture();
    });

    const unlistenTrayNewNote = listen('tray-new-note', () => {
      appController.createNoteAtViewportOrigin();
    });

    const unlistenClipboardNote = listen('create-note-from-clipboard', async () => {
      const text = await readText().catch(() => '');
      appController.smartPasteFromTextAtViewportOrigin(text);
    });

    const unlistenGlobalShortcutError = listen<string>('global-shortcut-register-failed', (event) => {
      setGlobalShortcutError(event.payload);
    });

    invoke<boolean>('get_pin_mode')
      .then((pinned) => {
        appController.setPinned(pinned);
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
      document.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, []);

  const undoToastCopy = arrangeUndoToast
    ? getOrganizationUndoToastCopy(arrangeUndoToast.action, arrangeUndoToast.noteCount)
    : null;

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
      <SelectionActionBar />
      <QuickCaptureOverlay />
      {arrangeUndoToast && undoToastCopy && (
        <div
          className="fixed left-1/2 bottom-5 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-2xl border border-sky-200/70 bg-secondary-bg/95 px-4 py-3 text-sm text-text-primary shadow-2xl backdrop-blur-md dark:border-sky-400/25 dark:bg-secondary-bg/90"
          style={{ zIndex: Z_INDEX.QUICK_CAPTURE + 2 }}
          role="status"
          aria-live="polite"
        >
          <div className="min-w-0">
            <div className="font-medium">{undoToastCopy.title}</div>
            <div className="mt-0.5 text-xs text-text-tertiary">{undoToastCopy.description}</div>
          </div>
          <button
            type="button"
            className="shrink-0 rounded-full bg-sky-500 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-300"
            onClick={() => appController.undoLastArrange()}
          >
            撤销
          </button>
          <button
            type="button"
            className="shrink-0 rounded-full px-2 py-1 text-xs text-text-tertiary transition-colors hover:bg-secondary-bg hover:text-text-primary dark:hover:bg-white/10"
            aria-label={undoToastCopy.closeLabel}
            onClick={() => appController.dismissArrangeUndoToast()}
          >
            ×
          </button>
        </div>
      )}
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
