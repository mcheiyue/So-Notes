import { useEffect } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { useUIStore } from '../store';
import { useStore } from '../store/useStore';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { appController } from '../controllers/appController';

export default function ShortcutsManager() {
  const isSpotlightOpen = useUIStore((state) => state.isSpotlightOpen);
  const isQuickCaptureOpen = useUIStore((state) => state.isQuickCaptureOpen);
  const viewMode = useUIStore((state) => state.viewMode);
  const areCanvasShortcutsBlocked = isSpotlightOpen || isQuickCaptureOpen;

  useHotkeys('mod+p', (e) => {
    if (isQuickCaptureOpen) {
      e.preventDefault();
      return;
    }

    e.preventDefault();
    appController.toggleSpotlight();
  }, { enableOnFormTags: true });

  useHotkeys('mod+a', (e) => {
    if (viewMode === 'TRASH') return;
    if (areCanvasShortcutsBlocked) return;
    e.preventDefault();
    appController.selectAllNotes();
  }, { enableOnFormTags: false });

  useHotkeys(['delete', 'backspace'], (e) => {
    if (viewMode === 'TRASH') return;
    if (areCanvasShortcutsBlocked) return;
    e.preventDefault();
    appController.deleteSelectedNotes();
  }, { enableOnFormTags: false });

  useHotkeys('mod+d', (e) => {
    if (viewMode === 'TRASH') return;
    if (areCanvasShortcutsBlocked) return;
    e.preventDefault();
    appController.duplicateSelectedNotes();
  }, { enableOnFormTags: false });

  useHotkeys('mod+0', (e) => {
    if (viewMode === 'TRASH') return;
    if (areCanvasShortcutsBlocked) {
      e.preventDefault();
      return;
    }

    e.preventDefault();
    appController.resetViewport();
  }, { enableOnFormTags: true });

  useHotkeys('mod+v', async (e) => {
    if (viewMode === 'TRASH') return;
    if (areCanvasShortcutsBlocked) return;
    e.preventDefault();
    const text = await readText().catch(() => '');
    appController.smartPasteFromText(text);
  }, { enableOnFormTags: false });

  useHotkeys('mod+z', (e) => {
    if (viewMode === 'TRASH') return;
    if (areCanvasShortcutsBlocked) return;
    e.preventDefault();
    useStore.getState().undoDomainChange();
  }, { enableOnFormTags: false });

  useHotkeys(['mod+y', 'mod+shift+z'], (e) => {
    if (viewMode === 'TRASH') return;
    if (areCanvasShortcutsBlocked) return;
    e.preventDefault();
    useStore.getState().redoDomainChange();
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
