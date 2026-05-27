import React, { useState, useRef, useEffect } from "react";
import { useStore } from "../store/useStore";
import { cn } from "../utils/cn";
import { Plus, Trash2, Settings, Download, Upload, Share, ChevronRight, ChevronLeft, Moon, Sun, Monitor, Database, Check, Activity } from "lucide-react";
import { Z_INDEX } from "../constants/layout";
import { DiagnosticsPanel } from "./DiagnosticsPanel";

const BOARD_ICONS = ["📝", "🚀", "💡", "🎨", "📅", "✅", "🔥", "✨", "📚", "🧘"];
type StoreState = ReturnType<typeof useStore.getState>;
type ImportFeedback = Awaited<ReturnType<StoreState['importFromFile']>>;

const formatImportSummary = (summary: NonNullable<ImportFeedback['summary']>) => {
  const parts = [
    `导入 ${summary.importedBoardsCount} 个看板`,
    `${summary.importedNotesCount} 条便签`,
  ];

  if (summary.skippedNotesCount > 0) {
    parts.push(`跳过 ${summary.skippedNotesCount} 条异常便签`);
  }

  return parts.join(' · ');
};

const formatImportHighlights = (summary: NonNullable<ImportFeedback['summary']>) => {
  const highlights: string[] = [];

  if (summary.createdDefaultBoard) {
    highlights.push('已自动补建默认看板。');
  }

  if (summary.migratedNotesCount > 0) {
    highlights.push(`已兼容迁移 ${summary.migratedNotesCount} 条旧版便签。`);
  }

  if (summary.renamedBoardsCount > 0) {
    highlights.push(`有 ${summary.renamedBoardsCount} 个同名看板已按规则重命名。`);
  }

  if (summary.usedFallbackCurrentBoard) {
    highlights.push('导入主板无效，已回退到首个可用看板。');
  }

  return highlights;
};

export const BoardDock = () => {
  const store = useStore();
  const { 
    boards, boardNoteIds, notesById, currentBoardId, 
    switchBoard, createBoard, deleteBoard, updateBoard, reorderBoard,
    isDockVisible, setDockVisible, 
    viewMode, setViewMode, 
    clearSelection,
    exportAll, importFromFile,
    config, setThemeMode,
    saveStatus, isSaving, saveError, lastSavedAt
  } = store;
  const [isInputMode, setIsInputMode] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsView, setSettingsView] = useState<'MAIN' | 'DATA' | 'THEME' | 'DIAGNOSTICS'>('MAIN');
  const [newBoardName, setNewBoardName] = useState("");
  const [contextMenuBoard, setContextMenuBoard] = useState<{ id: string; name: string; x: number; y: number } | null>(null);
  
  // Delete Confirmation State
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; count: number } | null>(null);
  const [editingBoardId, setEditingBoardId] = useState<string | null>(null);
  const [reorderId, setReorderId] = useState<string | null>(null);
  const [importFeedback, setImportFeedback] = useState<ImportFeedback | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const dockContainerRef = useRef<HTMLDivElement>(null);

  // Focus input when adding mode starts
  useEffect(() => {
    if (isInputMode && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isInputMode]);

  // Focus rename input
  useEffect(() => {
    if (editingBoardId && editInputRef.current) {
        editInputRef.current.focus();
        editInputRef.current.select();
    }
  }, [editingBoardId]);

  // Reorder Keyboard Logic
  useEffect(() => {
    if (!reorderId) return;

    const handleReorderKey = (e: KeyboardEvent) => {
        e.preventDefault();
        e.stopPropagation();

        if (e.key === 'ArrowLeft') {
            reorderBoard(reorderId, 'left');
        } else if (e.key === 'ArrowRight') {
            reorderBoard(reorderId, 'right');
        } else if (e.key === 'Enter' || e.key === 'Escape') {
            setReorderId(null);
        }
    };

    window.addEventListener('keydown', handleReorderKey);
    return () => window.removeEventListener('keydown', handleReorderKey);
  }, [reorderId, reorderBoard]);

  // Reset state when dock closes
  useEffect(() => {
    if (!isDockVisible) {
      setIsInputMode(false);
      setNewBoardName("");
      setContextMenuBoard(null);
      setEditingBoardId(null);
      setDeleteConfirm(null);
      setReorderId(null);
      setShowSettings(false);
      setSettingsView('MAIN');
    }
  }, [isDockVisible]);

  // Reset settings view when closed
  useEffect(() => {
      if (!showSettings) {
          setImportFeedback(null);
          setSettingsView('MAIN');
      }
  }, [showSettings]);

  const onExportClick = async () => {
    try {
      setExportStatus('正在导出...');
      await exportAll();
      setExportStatus('导出成功');
      setTimeout(() => {
        setExportStatus(null);
        setShowSettings(false);
      }, 1500);
    } catch {
      setExportStatus('导出已取消或失败');
      setTimeout(() => setExportStatus(null), 2000);
    }
  };

  const onImportClick = async () => {
    setImportFeedback(null);
    const result = await importFromFile();
    setImportFeedback(result);
  };

  const importSummaryText = importFeedback?.summary && !importFeedback.rolledBack
    ? formatImportSummary(importFeedback.summary)
    : null;
  const importHighlightTexts = importFeedback?.summary && !importFeedback.rolledBack
    ? formatImportHighlights(importFeedback.summary)
    : [];
  const importFeedbackClassName = importFeedback?.status === 'error'
    ? 'mx-3 mt-2 rounded-md border border-red-100 bg-red-50 px-3 py-2 text-xs leading-5 text-red-600 dark:border-red-900/50 dark:bg-red-900/30 dark:text-red-400'
    : 'mx-3 mt-2 rounded-md border border-border-subtle bg-secondary-bg/70 px-3 py-2 text-xs leading-5 text-text-secondary';
  const saveStatusText = isSaving || saveStatus === 'saving'
    ? '保存中...'
    : saveStatus === 'error'
      ? '保存失败'
      : saveStatus === 'saved'
        ? `已保存 ${lastSavedAt ? new Date(lastSavedAt).toLocaleTimeString('zh-CN', { hour12: false }) : ''}`.trim()
        : '等待保存';
  const saveStatusClassName = saveStatus === 'error'
    ? 'mx-3 mt-2 rounded-md border border-red-100 bg-red-50 px-3 py-2 text-xs leading-5 text-red-600 dark:border-red-900/50 dark:bg-red-900/30 dark:text-red-400'
    : 'mx-3 mt-2 rounded-md border border-border-subtle bg-secondary-bg/70 px-3 py-2 text-xs leading-5 text-text-secondary';

  const handleDeleteClick = () => {
      if (!contextMenuBoard) return;
      
      if (deleteConfirm?.id === contextMenuBoard.id) {
          // Second click: Confirm Delete
          deleteBoard(contextMenuBoard.id);
          setContextMenuBoard(null);
          setDeleteConfirm(null);
      } else {
          // First click: Check count
          const count = getBoardActiveNoteCount(contextMenuBoard.id);
          if (count > 0) {
              setDeleteConfirm({ id: contextMenuBoard.id, count });
          } else {
              // No notes, delete immediately
              deleteBoard(contextMenuBoard.id);
              setContextMenuBoard(null);
          }
      }
  };

  const getBoardActiveNoteCount = (boardId: string) => (boardNoteIds[boardId] ?? []).filter((noteId) => {
      const note = notesById[noteId];
      return note && !note.deletedAt;
  }).length;

  const handleCreate = () => {
    if (newBoardName.trim()) {
      const randomIcon = BOARD_ICONS[Math.floor(Math.random() * BOARD_ICONS.length)];
      createBoard(newBoardName.trim(), randomIcon);
      setIsInputMode(false);
      setNewBoardName("");
      setDockVisible(false); // Close dock after creation
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleCreate();
    if (e.key === 'Escape') setIsInputMode(false);
  };

  const handleRenameSave = () => {
      if (editingBoardId && editName.trim()) {
          updateBoard(editingBoardId, { name: editName.trim() });
      }
      setEditingBoardId(null);
      setEditName("");
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleRenameSave();
      if (e.key === 'Escape') {
          setEditingBoardId(null);
          setEditName("");
      }
  };

  const resolveBoardMenuAnchor = (boardElement: HTMLElement) => {
      const fallbackCenterX = boardElement.offsetLeft + boardElement.offsetWidth / 2;
      const localTop = boardElement.offsetTop;
      const dockContainer = dockContainerRef.current;

      if (!dockContainer) {
          return {
              x: fallbackCenterX,
              y: localTop,
          };
      }

      const boardRect = boardElement.getBoundingClientRect();
      const dockRect = dockContainer.getBoundingClientRect();
      const layoutWidth = dockContainer.offsetWidth;

      if (layoutWidth <= 0 || dockRect.width <= 0 || boardRect.width <= 0) {
          return {
              x: fallbackCenterX,
              y: localTop,
          };
      }

      const scaleX = dockRect.width / layoutWidth;
      const renderedCenterX = boardRect.left - dockRect.left + boardRect.width / 2;

      return {
          x: renderedCenterX / scaleX,
          y: localTop,
      };
  };

  if (!isDockVisible && viewMode !== 'TRASH') return null;

  // Only show overlay when:
  // 1. In BOARD mode and dock is visible (to click-away close dock)
  // 2. OR any context menu/input is open (to click-away close menu)
  const hasDockPopoverOpen = Boolean(contextMenuBoard || isInputMode || showSettings);
  const showOverlay = (isDockVisible && viewMode === 'BOARD') || hasDockPopoverOpen;
  const dockLayerZIndex = hasDockPopoverOpen ? Z_INDEX.MENU : Z_INDEX.DOCK;

  return (
    <>
      {/* 1. Full-screen transparent overlay for "Click outside to close" */}
      {showOverlay && (
        <button
          type="button"
          aria-label="关闭浮层"
          className="pointer-events-auto absolute inset-0 bg-transparent"
          style={{ zIndex: Z_INDEX.DOCK_BACKDROP }}
          onClick={() => { 
            if (contextMenuBoard || isInputMode || showSettings) {
              setContextMenuBoard(null);
              setIsInputMode(false);
              setShowSettings(false);
            } else {
              setDockVisible(false); 
            }
          }}
          onContextMenu={(e) => { 
            e.preventDefault(); 
            setContextMenuBoard(null); 
            if (!contextMenuBoard && !isInputMode && !showSettings) setDockVisible(false); 
          }} 
        />
      )}

      {/* 2. Dock Container - Centered using Flexbox to avoid transform conflicts */}
      <div className="absolute inset-x-0 bottom-8 pointer-events-none flex justify-center" style={{ zIndex: dockLayerZIndex }}>
        <div ref={dockContainerRef} className="board-dock-container relative pointer-events-auto flex flex-col items-center transform transition-transform duration-300 origin-bottom scale-90 md:scale-100">
        
        {/* Context Menu for Deletion */}
        {contextMenuBoard && (
            <div 
                className="board-dock-context-menu absolute bottom-full mb-2 -translate-x-1/2 bg-secondary-bg rounded-lg shadow-xl border border-border-subtle overflow-hidden animate-in fade-in zoom-in-95 duration-100 origin-bottom"
                style={{ left: contextMenuBoard.x, zIndex: Z_INDEX.MENU }}
            >
                <div className="px-3 py-2 text-xs text-text-secondary border-b border-border-subtle font-medium bg-secondary-bg/50">
                    {contextMenuBoard.name}
                </div>
                
                <button
                    type="button"
                    onClick={() => {
                        setEditingBoardId(contextMenuBoard.id);
                        setEditName(contextMenuBoard.name);
                        setContextMenuBoard(null);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 transition-colors border-b border-border-subtle"
                >
                    <span>✏️</span> 重命名
                </button>

                <button
                    type="button"
                    onClick={handleDeleteClick}
                    className={cn(
                        "w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors rounded-b-lg",
                        deleteConfirm?.id === contextMenuBoard.id
                            ? "bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50"
                            : "text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                    )}
                >
                    <span>🗑️</span> 
                    {deleteConfirm?.id === contextMenuBoard.id 
                        ? `确认删除? (${deleteConfirm.count}便签)` 
                        : '删除看板'}
                </button>
            </div>
        )}

        {/* Settings Menu */}
        {showSettings && (
            <div 
                className="absolute bottom-full mb-2 bg-secondary-bg rounded-lg shadow-xl border border-border-subtle overflow-hidden animate-in fade-in zoom-in-95 duration-100 origin-bottom min-w-[200px]"
                style={{ zIndex: Z_INDEX.MENU }}
            >
                {settingsView === 'MAIN' && (
                    <div className="py-1">
                        <div className="px-3 py-2 text-xs text-text-tertiary font-medium border-b border-border-subtle mb-1 mx-1">
                            设置
                        </div>
                        <button
                            type="button"
                            onClick={() => setSettingsView('THEME')}
                            className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary transition-colors"
                        >
                            <div className="flex items-center gap-2">
                                <span className="text-text-tertiary"><Monitor className="w-4 h-4" /></span>
                                <span>主题模式</span>
                            </div>
                            <div className="flex items-center gap-1 text-text-tertiary">
                                <span className="text-xs opacity-70">
                                    {config.themeMode === 'system' ? '跟随系统' : config.themeMode === 'dark' ? '深色' : '浅色'}
                                </span>
                                <ChevronRight className="w-4 h-4" />
                            </div>
                        </button>
                        <button
                            type="button"
                            onClick={() => setSettingsView('DATA')}
                            className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary transition-colors"
                        >
                            <div className="flex items-center gap-2">
                                <span className="text-text-tertiary"><Database className="w-4 h-4" /></span>
                                <span>数据管理</span>
                            </div>
                            <ChevronRight className="w-4 h-4 text-text-tertiary" />
                        </button>
                    </div>
                )}

                {settingsView === 'THEME' && (
                    <div className="py-1">
                        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border-subtle mb-1">
                            <button 
                                type="button"
                                onClick={() => setSettingsView('MAIN')}
                                className="p-1 hover:bg-secondary-bg/50 dark:hover:bg-white/5 rounded text-text-secondary hover:text-text-primary transition-colors"
                            >
                                <ChevronLeft className="w-4 h-4" />
                            </button>
                            <span className="text-xs text-text-tertiary font-medium">主题模式</span>
                        </div>
                        {[
                            { id: 'light', label: '浅色', icon: Sun },
                            { id: 'dark', label: '深色', icon: Moon },
                            { id: 'system', label: '跟随系统', icon: Monitor },
                        ].map((item) => (
                            <button
                                key={item.id}
                                type="button"
                                onClick={() => setThemeMode(item.id as StoreState['config']['themeMode'])}
                                className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary transition-colors"
                            >
                                <div className="flex items-center gap-2">
                                    <item.icon className="w-4 h-4 text-text-tertiary" />
                                    <span>{item.label}</span>
                                </div>
                                {config.themeMode === item.id && <Check className="w-4 h-4 text-blue-500" />}
                            </button>
                        ))}
                    </div>
                )}

                {settingsView === 'DATA' && (
                    <div className="py-1">
                        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border-subtle mb-1">
                            <button 
                                type="button"
                                onClick={() => setSettingsView('MAIN')}
                                className="p-1 hover:bg-secondary-bg/50 dark:hover:bg-white/5 rounded text-text-secondary hover:text-text-primary transition-colors"
                            >
                                <ChevronLeft className="w-4 h-4" />
                            </button>
                            <span className="text-xs text-text-tertiary font-medium">数据管理</span>
                        </div>
                        
                        <button
                            type="button"
                            onClick={onExportClick}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary transition-colors"
                        >
                            <Download className="w-4 h-4 text-text-tertiary" />
                            <span>全量备份 (JSON)</span>
                        </button>

                        {viewMode === 'BOARD' && (
                        <button
                            type="button"
                            onClick={async () => {
                            await store.exportCurrentBoard();
                            setShowSettings(false);
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary transition-colors"
                        >
                            <Share className="w-4 h-4 text-text-tertiary" />
                            <span>导出当前看板</span>
                        </button>
                        )}

                        <button
                            type="button"
                            onClick={onImportClick}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary transition-colors"
                        >
        <Upload className="w-4 h-4 text-text-tertiary" />
          <span>恢复备份</span>
        </button>

        {exportStatus && (
          <div className="mx-3 mt-2 rounded-md border border-border-subtle bg-secondary-bg/70 px-3 py-2 text-xs leading-5 text-text-secondary">
            {exportStatus}
          </div>
        )}

        {importFeedback && (
                            <div
                                data-testid="board-import-feedback"
                                role={importFeedback.status === 'error' ? 'alert' : 'status'}
                                aria-live="polite"
                                className={importFeedbackClassName}
                            >
                                <p className={cn('font-medium', importFeedback.status === 'error' ? 'text-current' : 'text-text-primary')}>
                                    {importFeedback.status === 'cancelled'
                                        ? '已取消恢复备份。'
                                        : importFeedback.message || '恢复已完成。'}
                                </p>

                                {importFeedback.rolledBack && (
                                    <p className="mt-1 text-[11px] leading-4 opacity-90">
                                        已回滚到导入前状态，当前数据未被改动。
                                    </p>
                                )}

                                {importSummaryText && (
                                    <p className={cn('mt-1 text-[11px] leading-4', importFeedback.status === 'error' ? 'text-current/90' : 'text-text-tertiary')}>
                                        {importSummaryText}
                                    </p>
                                )}

                                {importHighlightTexts.length > 0 && (
                                    <div className={cn('mt-1 space-y-1 text-[11px] leading-4', importFeedback.status === 'error' ? 'text-current/90' : 'text-text-tertiary')}>
                                        {importHighlightTexts.map((text) => (
                                            <p key={text}>{text}</p>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        <div
                            data-testid="board-save-feedback"
                            role={saveStatus === 'error' ? 'alert' : 'status'}
                            aria-live="polite"
                            className={saveStatusClassName}
                        >
                            <p className={cn('font-medium', saveStatus === 'error' ? 'text-current' : 'text-text-primary')}>
                                {saveStatusText}
                            </p>
                            {saveStatus === 'error' && saveError && (
                                <p className="mt-1 text-[11px] leading-4 opacity-90">{saveError}</p>
                            )}
                        </div>

        <button
          type="button"
          onClick={() => setSettingsView('DIAGNOSTICS')}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary transition-colors"
                        >
                            <Activity className="w-4 h-4 text-text-tertiary" />
                            <span>性能诊断</span>
                            <ChevronRight className="w-4 h-4 ml-auto text-text-tertiary" />
                        </button>
                    </div>
                )}

                {settingsView === 'DIAGNOSTICS' && (
                    <div className="py-1">
                        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border-subtle mb-1">
                            <button
                                type="button"
                                onClick={() => setSettingsView('DATA')}
                                className="p-1 hover:bg-secondary-bg/50 dark:hover:bg-white/5 rounded text-text-secondary hover:text-text-primary transition-colors"
                            >
                                <ChevronLeft className="w-4 h-4" />
                            </button>
                            <span className="text-xs text-text-tertiary font-medium">性能诊断</span>
                        </div>
                        <DiagnosticsPanel />
                    </div>
                )}
            </div>
        )}

        {/* 3. Input Popover */}
        {isInputMode && (
          <div 
            className="mb-3 p-1.5 bg-secondary-bg rounded-xl shadow-xl border border-border-subtle flex items-center gap-1 animate-in slide-in-from-bottom-2 fade-in duration-200 origin-bottom"
            style={{ zIndex: Z_INDEX.MENU }}
          >
             <input
                ref={inputRef}
                type="text"
                placeholder="看板名称..."
                className="bg-transparent border-none outline-none text-sm px-2 py-1.5 w-32 text-text-secondary placeholder:text-text-tertiary font-medium"
                value={newBoardName}
                onChange={(e) => setNewBoardName(e.target.value)}
                onKeyDown={handleKeyDown}
             />
             <button 
               type="button"
               onClick={handleCreate} 
               className="p-1.5 hover:bg-secondary-bg/50 dark:hover:bg-white/5 rounded-lg text-text-secondary hover:text-text-primary transition-colors"
             >
                <Plus className="w-4 h-4" />
             </button>
          </div>
        )}

        {/* 4. The Main Dock (Pill) */}
        <div 
          className={cn(
            "flex items-center gap-1 p-1.5 rounded-full",
            "bg-secondary-bg", // 使用语义化背景色
            "border border-border-subtle", // 使用语义化边框
            "shadow-[0_8px_30px_rgb(0,0,0,0.12)]", // Slightly deeper shadow
            "animate-dock-slide-up" // Hand-written CSS animation
          )}
        >
          {boards.map((board) => {
            const isActive = currentBoardId === board.id;
            const isEditing = editingBoardId === board.id;
            const isReordering = reorderId === board.id;
            const activeNoteCount = getBoardActiveNoteCount(board.id);

            if (isEditing) {
                return (
                    <div 
                        key={board.id}
                        className="w-24 px-1 flex items-center justify-center"
                    >
                        <input
                            ref={editInputRef}
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onKeyDown={handleRenameKeyDown}
                            onBlur={handleRenameSave}
                            className="w-full bg-secondary-bg border-none outline-none text-xs px-2 py-1 rounded text-center text-text-primary font-medium shadow-inner"
                        />
                    </div>
                );
            }

            return (
              <button
                type="button"
                key={board.id}
                data-board-id={board.id}
                onClick={() => {
                   if (isReordering) {
                       setReorderId(null); // Click to confirm
                       return;
                   }
                   switchBoard(board.id);
                   setViewMode('BOARD');
                   setContextMenuBoard(null);
                }}
                onDoubleClick={() => {
                    if (isReordering) return;
                    setEditingBoardId(board.id);
                    setEditName(board.name);
                }}
                 onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (isReordering) return;
                    if (board.id !== 'default') {
                        const anchor = resolveBoardMenuAnchor(e.currentTarget);
                        setContextMenuBoard({ id: board.id, name: board.name, ...anchor });
                    }
                 }}
                 aria-label={`${board.name}，${activeNoteCount} 个便签`}
                 className={cn(
                   "relative group flex items-center justify-center w-9 h-9 rounded-full transition-all duration-200",
                  isActive 
                    ? "bg-secondary-bg text-text-primary" // Active状态的语义化背景和文字
                    : "text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary", // Hover状态的语义化背景和文字
                  isReordering && "ring-2 ring-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 z-10 scale-110 animate-pulse"
                )}
              >
                {/* Custom Tooltip */}
                <div className={cn(
                    "absolute -top-10 left-1/2 -translate-x-1/2 px-2 py-1 bg-tertiary-bg text-text-primary text-xs rounded transition-opacity pointer-events-none whitespace-nowrap shadow-sm",
                    isReordering ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                )} style={{ zIndex: Z_INDEX.TOOLTIP }}>
                    {isReordering ? "⬅️ 移动 ➡️" : `${board.name} · ${activeNoteCount} 个便签`}
                    {/* Tiny triangle */}
<div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-tertiary-bg" />
            </div>
            {/* Active Indicator: Dot below the icon */}
            {isActive && (
              <div className="absolute -bottom-1 w-1 h-1 rounded-full bg-text-tertiary" />
            )}
            
            {/* Board Icon */}
            <span className={cn(
              "text-lg leading-none filter drop-shadow-sm transform group-hover:scale-110 transition-transform",
              activeNoteCount === 0 && !isActive && "opacity-55"
            )}>
              {board.icon}
            </span>
            <span className={cn(
              "absolute -right-1 -top-1 min-w-4 rounded-full border border-border-subtle bg-primary-bg px-1 text-[10px] leading-4 text-text-tertiary shadow-sm",
              isActive && "text-text-primary",
              activeNoteCount === 0 && "opacity-50"
            )}>
              {activeNoteCount}
            </span>
          </button>
            )
          })}

          {/* Vertical Divider */}
          <div className="w-px h-5 bg-border-subtle mx-1.5" />

          {/* Add Button */}
          <button
            type="button"
            onClick={() => setIsInputMode(!isInputMode)}
            className={cn(
                "relative group flex items-center justify-center w-9 h-9 rounded-full transition-all duration-200",
                isInputMode 
                  ? "bg-secondary-bg text-text-primary rotate-45" 
                  : "text-text-tertiary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary"
            )}
          >
            {/* Tooltip for Add */}
            {!isInputMode && (
             <div className="absolute -top-10 left-1/2 -translate-x-1/2 px-2 py-1 bg-tertiary-bg text-text-primary text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap shadow-sm" style={{ zIndex: Z_INDEX.TOOLTIP }}>
               新建看板
               <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-tertiary-bg" />
             </div>
            )}
            <Plus className="w-5 h-5" />
          </button>

          {/* Vertical Divider */}
          <div className="w-px h-5 bg-border-subtle mx-1.5" />

          {/* Trash Button */}
          <button
            type="button"
            onClick={() => {
              clearSelection();
              setViewMode(viewMode === 'TRASH' ? 'BOARD' : 'TRASH');
            }}
            className={cn(
              "relative group flex items-center justify-center w-9 h-9 rounded-full transition-all duration-200",
              viewMode === 'TRASH'
                ? "bg-secondary-bg text-text-primary"
                : "text-text-tertiary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary"
            )}
          >
            {/* Tooltip for Trash */}
             <div className="absolute -top-10 left-1/2 -translate-x-1/2 px-2 py-1 bg-tertiary-bg text-text-primary text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap shadow-sm" style={{ zIndex: Z_INDEX.TOOLTIP }}>
               废纸篓
               <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-tertiary-bg" />
             </div>
            <Trash2 className="w-5 h-5" />
          </button>

          {/* Vertical Divider */}
          <div className="w-px h-5 bg-border-subtle mx-1.5" />

          {/* Settings Button */}
          <button
            type="button"
            onClick={() => setShowSettings(!showSettings)}
            aria-label="打开设置"
            className={cn(
              "relative group flex items-center justify-center w-9 h-9 rounded-full transition-all duration-200",
              showSettings
                ? "bg-secondary-bg text-text-primary"
                : "text-text-tertiary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary"
            )}
          >
            {/* Tooltip for Settings */}
            <div className="absolute -top-10 left-1/2 -translate-x-1/2 px-2 py-1 bg-tertiary-bg text-text-primary text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap shadow-sm" style={{ zIndex: Z_INDEX.TOOLTIP }}>
              设置
              <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-tertiary-bg" />
            </div>
            <Settings className="w-5 h-5" />
          </button>
        </div>
        </div>
      </div>
    </>
  );
};
