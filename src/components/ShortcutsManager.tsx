import { useEffect } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { useStore } from '../store/useStore';
import { invoke } from '@tauri-apps/api/core';

export default function ShortcutsManager() {
  const deleteSelectedNotes = useStore((state) => state.deleteSelectedNotes);
  const selectAllNotes = useStore((state) => state.selectAllNotes);
  const duplicateSelectedNotes = useStore((state) => state.duplicateSelectedNotes);
  const setViewportPosition = useStore((state) => state.setViewportPosition);

  const isSpotlightOpen = useStore((state) => state.isSpotlightOpen);
  const setSpotlightOpen = useStore((state) => state.setSpotlightOpen);

  // Ctrl + P / Cmd + P: 全局搜索
  useHotkeys('mod+p', (e) => {
    e.preventDefault();
    setSpotlightOpen(!isSpotlightOpen);
  }, { enableOnFormTags: true }); // 输入框内也可唤起

  // Ctrl + A / Cmd + A: 全选
  useHotkeys('mod+a', (e) => {
    if (isSpotlightOpen) return;
    e.preventDefault();
    selectAllNotes();
  }, { enableOnFormTags: false });

  // Delete / Backspace: 删除选中笔记
  useHotkeys(['delete', 'backspace'], (e) => {
    if (isSpotlightOpen) return;
    e.preventDefault();
    deleteSelectedNotes();
  }, { enableOnFormTags: false });

  // Ctrl + D / Cmd + D: 复制副本
  useHotkeys('mod+d', (e) => {
    if (isSpotlightOpen) return;
    e.preventDefault();
    duplicateSelectedNotes();
  }, { enableOnFormTags: false });

  // Ctrl + 0 / Cmd + 0: 重置视图
  useHotkeys('mod+0', (e) => {
    if (isSpotlightOpen) return;
    e.preventDefault();
    setViewportPosition(0, 0);
    // 同时通知 Tauri 重置窗口大小（如果有相关逻辑的话，这里暂时只重置画布视口）
    invoke('reset').catch(() => {}); 
  }, { enableOnFormTags: true }); // 视图操作允许在任何地方触发

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
