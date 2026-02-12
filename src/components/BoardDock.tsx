import React, { useState, useRef, useEffect } from "react";
import { useStore } from "../store/useStore";
import { cn } from "../utils/cn";
import { Plus, Trash2, Settings, Download, Upload, Share, ChevronRight, ChevronLeft, Moon, Sun, Monitor, Database, Check } from "lucide-react";

const BOARD_ICONS = ["📝", "🚀", "💡", "🎨", "📅", "✅", "🔥", "✨", "📚", "🧘"];

export const BoardDock = () => {
  const store = useStore();
  const { 
    boards, notes, currentBoardId, 
    switchBoard, createBoard, deleteBoard, updateBoard, reorderBoard,
    isDockVisible, setDockVisible, 
    viewMode, setViewMode, 
    clearSelection,
    exportAll, importFromFile,
    config, setThemeMode
  } = store;
  const [isInputMode, setIsInputMode] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsView, setSettingsView] = useState<'MAIN' | 'DATA' | 'THEME'>('MAIN');
  const [newBoardName, setNewBoardName] = useState("");
  const [contextMenuBoard, setContextMenuBoard] = useState<{ id: string; name: string; x: number; y: number } | null>(null);
  
  // Delete Confirmation State
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; count: number } | null>(null);
  const [editingBoardId, setEditingBoardId] = useState<string | null>(null);
  const [reorderId, setReorderId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

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
          // Small delay to allow animation to finish if we had one, but instant is fine
          setSettingsView('MAIN');
      }
  }, [showSettings]);

  const onExportClick = async () => {
    await exportAll();
    setShowSettings(false);
  };

  const onImportClick = async () => {
    await importFromFile();
    setShowSettings(false);
  };

  const handleDeleteClick = () => {
      if (!contextMenuBoard) return;
      
      if (deleteConfirm?.id === contextMenuBoard.id) {
          // Second click: Confirm Delete
          deleteBoard(contextMenuBoard.id);
          setContextMenuBoard(null);
          setDeleteConfirm(null);
      } else {
          // First click: Check count
          const count = notes.filter(n => n.boardId === contextMenuBoard.id).length;
          if (count > 0) {
              setDeleteConfirm({ id: contextMenuBoard.id, count });
          } else {
              // No notes, delete immediately
              deleteBoard(contextMenuBoard.id);
              setContextMenuBoard(null);
          }
      }
  };

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

  if (!isDockVisible && viewMode !== 'TRASH') return null;

  // Only show overlay when:
  // 1. In BOARD mode and dock is visible (to click-away close dock)
  // 2. OR any context menu/input is open (to click-away close menu)
  const showOverlay = (isDockVisible && viewMode === 'BOARD') || contextMenuBoard || isInputMode || showSettings;

  return (
    <>
      {/* 1. Full-screen transparent overlay for "Click outside to close" */}
      {showOverlay && (
        <div 
          className="fixed inset-0 z-[99998] bg-transparent"
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
      <div className="fixed bottom-8 left-0 w-full z-[99999] pointer-events-none flex justify-center">
        <div className="pointer-events-auto flex flex-col items-center transform transition-transform duration-300 origin-bottom scale-90 md:scale-100">
        
        {/* Context Menu for Deletion */}
        {contextMenuBoard && (
            <div 
                className="absolute bottom-full mb-2 bg-secondary-bg rounded-lg shadow-xl border border-border-subtle overflow-hidden animate-in fade-in zoom-in-95 duration-100 origin-bottom"
                style={{ left: contextMenuBoard.x }}
            >
                <div className="px-3 py-2 text-xs text-text-secondary border-b border-border-subtle font-medium bg-secondary-bg/50">
                    {contextMenuBoard.name}
                </div>
                
                <button
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
                    onClick={() => {
                      // Export this specific board (using current logic, we need to temporarily switch or just export by ID)
                      // Since store only has exportCurrentBoard, we might need to rely on that or add exportBoard(id).
                      // But for now, let's just use exportCurrentBoard if it matches, or disable it?
                      // Actually, the store has exportBoard(id). Let's use that if we can access it.
                      // But we can't easily access non-exported actions from here without exposing them.
                      // Let's stick to what we have: if right-clicked board is current, we can export.
                      // If not, we switch then export? That's intrusive.
                      // Let's just remove export from here for simplicity, or keep it if it's the current board.
                      // Wait, I previously added exportCurrentBoard to Context Menu.
                      // Let's REMOVE it from here to simplify. Right click = Manage Board (Rename/Delete).
                      // Exporting is a "Data" operation, best in Settings or specific menu.
                      setContextMenuBoard(null);
                    }}
                    className="hidden" 
                >
                </button>

                <button
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
                className="absolute bottom-full mb-2 bg-secondary-bg rounded-lg shadow-xl border border-border-subtle overflow-hidden animate-in fade-in zoom-in-95 duration-100 origin-bottom z-[100000] min-w-[200px]"
                onClick={(e) => e.stopPropagation()}
            >
                {settingsView === 'MAIN' && (
                    <div className="py-1">
                        <div className="px-3 py-2 text-xs text-text-tertiary font-medium border-b border-border-subtle mb-1 mx-1">
                            设置
                        </div>
                        <button
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
                                onClick={() => setThemeMode(item.id as any)}
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
                                onClick={() => setSettingsView('MAIN')}
                                className="p-1 hover:bg-secondary-bg/50 dark:hover:bg-white/5 rounded text-text-secondary hover:text-text-primary transition-colors"
                            >
                                <ChevronLeft className="w-4 h-4" />
                            </button>
                            <span className="text-xs text-text-tertiary font-medium">数据管理</span>
                        </div>
                        
                        <button
                            onClick={onExportClick}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary transition-colors"
                        >
                            <Download className="w-4 h-4 text-text-tertiary" />
                            <span>全量备份 (JSON)</span>
                        </button>

                        {viewMode === 'BOARD' && (
                        <button
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
                            onClick={onImportClick}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary transition-colors"
                        >
                            <Upload className="w-4 h-4 text-text-tertiary" />
                            <span>恢复备份</span>
                        </button>
                    </div>
                )}
            </div>
        )}

        {/* 3. Input Popover */}
        {isInputMode && (
          <div 
            className="mb-3 p-1.5 bg-secondary-bg rounded-xl shadow-xl border border-border-subtle flex items-center gap-1 animate-in slide-in-from-bottom-2 fade-in duration-200 origin-bottom"
            onClick={(e) => e.stopPropagation()}
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
          onClick={(e) => e.stopPropagation()} // Prevent closing when interacting with dock
        >
          {boards.map((board) => {
            const isActive = currentBoardId === board.id;
            const isEditing = editingBoardId === board.id;
            const isReordering = reorderId === board.id;

            if (isEditing) {
                return (
                    <div 
                        key={board.id}
                        className="w-24 px-1 flex items-center justify-center"
                        onClick={(e) => e.stopPropagation()}
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
                key={board.id}
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
                        setContextMenuBoard({ id: board.id, name: board.name, x: 0, y: 0 });
                    }
                }}
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
                    "absolute -top-10 left-1/2 -translate-x-1/2 px-2 py-1 bg-tertiary-bg text-text-primary text-xs rounded transition-opacity pointer-events-none whitespace-nowrap shadow-sm z-[100000]",
                    isReordering ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                )}>
                    {isReordering ? "⬅️ 移动 ➡️" : board.name}
                    {/* Tiny triangle */}
<div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-tertiary-bg" />
            </div>
            {/* Active Indicator: Dot below the icon */}
            {isActive && (
              <div className="absolute -bottom-1 w-1 h-1 rounded-full bg-text-tertiary" />
            )}
            
            {/* Board Icon */}
            <span className="text-lg leading-none filter drop-shadow-sm transform group-hover:scale-110 transition-transform">
              {board.icon}
            </span>
          </button>
            )
          })}

          {/* Vertical Divider */}
          <div className="w-px h-5 bg-border-subtle mx-1.5" />

          {/* Add Button */}
          <button
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
             <div className="absolute -top-10 left-1/2 -translate-x-1/2 px-2 py-1 bg-tertiary-bg text-text-primary text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap shadow-sm z-[100000]">
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
             <div className="absolute -top-10 left-1/2 -translate-x-1/2 px-2 py-1 bg-tertiary-bg text-text-primary text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap shadow-sm z-[100000]">
               废纸篓
               <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-tertiary-bg" />
             </div>
            <Trash2 className="w-5 h-5" />
          </button>

          {/* Vertical Divider */}
          <div className="w-px h-5 bg-border-subtle mx-1.5" />

          {/* Settings Button */}
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={cn(
              "relative group flex items-center justify-center w-9 h-9 rounded-full transition-all duration-200",
              showSettings
                ? "bg-secondary-bg text-text-primary"
                : "text-text-tertiary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary"
            )}
          >
            {/* Tooltip for Settings */}
            <div className="absolute -top-10 left-1/2 -translate-x-1/2 px-2 py-1 bg-tertiary-bg text-text-primary text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap shadow-sm z-[100000]">
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
