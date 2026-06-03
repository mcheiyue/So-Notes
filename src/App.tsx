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
import { startDetachedNoteSnapshotSync } from "./services/detachedNoteSnapshotSync";
import { DETACHED_NOTE_EVENTS } from "./types/detachedNoteSnapshot";
import type { DetachedNoteLocatePayload, DetachedNoteClosedPayload } from "./types/detachedNoteSnapshot";

const getTraySaveStatusCopy = (saveStatus: string, saveError: string | null): string | null => {
  if (saveStatus === 'saving') {
    return '保存中';
  }

  if (saveStatus === 'error') {
    const detail = saveError?.trim();
    if (!detail) {
      return '保存失败';
    }

    const clippedDetail = detail.length > 24 ? `${detail.slice(0, 24)}…` : detail;
    return `保存失败：${clippedDetail}`;
  }

  return null;
};

const buildTrayTooltip = (boardName: string, saveStatus: string, saveError: string | null) => {
  const normalizedBoardName = boardName.trim() || '主板';
  const statusCopy = getTraySaveStatusCopy(saveStatus, saveError);
  if (!statusCopy) {
    return `SoNotes · 当前看板：${normalizedBoardName}`;
  }
  return `SoNotes · 当前看板：${normalizedBoardName} · ${statusCopy}`;
};

function App() {
  const [globalShortcutError, setGlobalShortcutError] = useState<string | null>(null);
  const viewMode = useStore(state => state.viewMode);
  const boards = useStore(state => state.boards);
  const isSpotlightOpen = useStore(state => state.isSpotlightOpen);
  const notesById = useStore(state => state.notesById);
  const allNoteIds = useStore(state => state.allNoteIds);
  const boardNoteIds = useStore(state => state.boardNoteIds);
  const currentBoardId = useStore(state => state.currentBoardId);
  const saveStatus = useStore(state => state.saveStatus);
  const saveError = useStore(state => state.saveError);
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

  useEffect(() => {
    const currentBoard = boards.find(board => board.id === currentBoardId);
    const tooltip = buildTrayTooltip(currentBoard?.name ?? '主板', saveStatus, saveError);

    invoke('set_tray_tooltip', { tooltip }).catch((error) => {
      console.warn('Failed to update tray tooltip:', error);
    });
  }, [boards, currentBoardId, saveError, saveStatus]);

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

    const unlistenLocateDetached = listen<DetachedNoteLocatePayload>(
      DETACHED_NOTE_EVENTS.LOCATE,
      (event) => {
        appController.locateDetachedNote(event.payload.noteId);
      },
    );

    const unlistenClosedDetached = listen<DetachedNoteClosedPayload>(
      DETACHED_NOTE_EVENTS.CLOSED,
      (event) => {
        appController.closeDetachedNote(event.payload.noteId);
      },
    );

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
      unlistenLocateDetached.then(f => f());
      unlistenClosedDetached.then(f => f());
      document.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, []);

  useEffect(() => startDetachedNoteSnapshotSync(), []);

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
      <QuickCaptureOverlay />
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
            <span>{board?.name || '主板'}</span>
        </div>
    );
};

export default App;
