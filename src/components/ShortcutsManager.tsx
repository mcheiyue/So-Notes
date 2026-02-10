import { useHotkeys } from 'react-hotkeys-hook';
import { useStore } from '../store/useStore';
import { invoke } from '@tauri-apps/api/core';

export default function ShortcutsManager() {
  const deleteSelectedNotes = useStore((state) => state.deleteSelectedNotes);
  const selectAllNotes = useStore((state) => state.selectAllNotes);
  const duplicateSelectedNotes = useStore((state) => state.duplicateSelectedNotes);
  const setViewportPosition = useStore((state) => state.setViewportPosition);

  // Delete / Backspace: 删除选中笔记
  useHotkeys(['delete', 'backspace'], (e) => {
    e.preventDefault();
    deleteSelectedNotes();
  }, { enableOnFormTags: false }); // 输入框内不触发

  // Ctrl + A / Cmd + A: 全选
  useHotkeys('mod+a', (e) => {
    e.preventDefault();
    selectAllNotes();
  }, { enableOnFormTags: false });

  // Ctrl + D / Cmd + D: 复制副本
  useHotkeys('mod+d', (e) => {
    e.preventDefault();
    duplicateSelectedNotes();
  }, { enableOnFormTags: false });

  // Ctrl + 0 / Cmd + 0: 重置视图
  useHotkeys('mod+0', (e) => {
    e.preventDefault();
    setViewportPosition(0, 0);
    // 同时通知 Tauri 重置窗口大小（如果有相关逻辑的话，这里暂时只重置画布视口）
    invoke('reset').catch(() => {}); 
  }, { enableOnFormTags: true }); // 视图操作允许在任何地方触发

  return null;
}
