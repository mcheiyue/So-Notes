import { useEffect } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { useStore, useUIStore } from '../store';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { buildSmartPasteNoteInputs, parseSmartPaste } from '../utils/smartPaste';
import { getViewportSpawnOrigin } from '../utils/spawnPosition';

export default function ShortcutsManager() {
  const deleteSelectedNotes = useStore((state) => state.deleteSelectedNotes);
  const selectAllNotes = useStore((state) => state.selectAllNotes);
  const duplicateSelectedNotes = useStore((state) => state.duplicateSelectedNotes);
  const setViewportPosition = useStore((state) => state.setViewportPosition);

  const isSpotlightOpen = useUIStore((state) => state.isSpotlightOpen);
  const isQuickCaptureOpen = useUIStore((state) => state.isQuickCaptureOpen);
  const setSpotlightOpen = useUIStore((state) => state.setSpotlightOpen);
  const viewMode = useUIStore((state) => state.viewMode);
  const areCanvasShortcutsBlocked = isSpotlightOpen || isQuickCaptureOpen;

  // Ctrl + P / Cmd + P: 全局搜索
  useHotkeys('mod+p', (e) => {
    if (isQuickCaptureOpen) {
      e.preventDefault();
      return;
    }

    e.preventDefault();
    setSpotlightOpen(!isSpotlightOpen);
  }, { enableOnFormTags: true }); // 输入框内也可唤起

  // Ctrl + A / Cmd + A: 全选
  useHotkeys('mod+a', (e) => {
    if (viewMode === 'TRASH') return;
    if (areCanvasShortcutsBlocked) return;
    e.preventDefault();
    selectAllNotes();
  }, { enableOnFormTags: false });

  // Delete / Backspace: 删除选中笔记
  useHotkeys(['delete', 'backspace'], (e) => {
    if (viewMode === 'TRASH') return;
    if (areCanvasShortcutsBlocked) return;
    e.preventDefault();
    deleteSelectedNotes();
  }, { enableOnFormTags: false });

  // Ctrl + D / Cmd + D: 复制副本
  useHotkeys('mod+d', (e) => {
    if (viewMode === 'TRASH') return;
    if (areCanvasShortcutsBlocked) return;
    e.preventDefault();
    duplicateSelectedNotes();
  }, { enableOnFormTags: false });

  // Ctrl + 0 / Cmd + 0: 重置视图
  useHotkeys('mod+0', (e) => {
    if (viewMode === 'TRASH') return;
    if (areCanvasShortcutsBlocked) {
      e.preventDefault();
      return;
    }

    e.preventDefault();
    setViewportPosition(0, 0);
  }, { enableOnFormTags: true }); // 视图操作允许在任何地方触发

  // Ctrl + V / Cmd + V: 画布级智能粘贴（输入框内不拦截）
  useHotkeys('mod+v', async (e) => {
    if (viewMode === 'TRASH') return;
    if (areCanvasShortcutsBlocked) return;
    e.preventDefault();
    const text = await readText().catch(() => '');
    const { viewport, addNotesWithContentBatch, openSmartPasteSplitPanel } = useStore.getState();
    const result = parseSmartPaste(text);
    const origin = getViewportSpawnOrigin(viewport);
    const notes = buildSmartPasteNoteInputs(
      result.source ? [result.source] : [],
      origin.x,
      origin.y,
    );
    if (notes.length > 0) {
      const createdIds = addNotesWithContentBatch(notes) ?? [];
      if (createdIds.length > 0 && result.options.length > 1) {
        openSmartPasteSplitPanel({ noteId: createdIds[0], result });
      }
    }
  }, { enableOnFormTags: false });

  // --- Native Behavior Guard (UX Protection) ---
  
  // 1. Block browser default shortcuts (Refresh, Find, Save, Zoom) - PROD ONLY
  useHotkeys([
    'f5', 'mod+r',         // Refresh
    'mod+s',               // Save Page
    'mod+f', 'mod+g',      // Find
    'mod+shift+r',         // Hard Refresh
    'mod+=', 'mod+-',      // Zoom In/Out
    'mod+o'                // Open File
  ], (e) => {
    if (import.meta.env.PROD) {
      e.preventDefault();
    }
  }, { enableOnFormTags: true });

  // 2. Block Ctrl+Wheel Zoom & Default Context Menu - PROD ONLY
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (import.meta.env.PROD && e.ctrlKey) {
        e.preventDefault();
      }
    };

    const handleContextMenu = (e: MouseEvent) => {
        if (import.meta.env.PROD) {
            e.preventDefault();
        }
    };

    window.addEventListener('wheel', handleWheel, { passive: false });
    window.addEventListener('contextmenu', handleContextMenu);
    
    return () => {
      window.removeEventListener('wheel', handleWheel);
      window.removeEventListener('contextmenu', handleContextMenu);
    };
  }, []);

  return null;
}
