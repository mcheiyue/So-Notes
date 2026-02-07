import React, { useState, useRef, useEffect } from "react";
import { useStore } from "../store/useStore";
import { cn } from "../utils/cn";
import { Plus, Trash2, Settings, Download, Upload, Share } from "lucide-react";

const BOARD_ICONS = ["📝", "🚀", "💡", "🎨", "📅", "✅", "🔥", "✨", "📚", "🧘"];

export const BoardDock = () => {
  const store = useStore();
  const { 
    boards, notes, currentBoardId, 
    switchBoard, createBoard, deleteBoard, updateBoard, reorderBoard,
    isDockVisible, setDockVisible, 
    viewMode, setViewMode, 
    clearSelection,
    exportAll, importFromFile 
  } = store;
  const [isInputMode, setIsInputMode] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
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
    }
  }, [isDockVisible]);

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
                className="absolute bottom-full mb-2 bg-white dark:bg-zinc-800 rounded-lg shadow-xl border border-black/5 dark:border-white/10 overflow-hidden animate-in fade-in zoom-in-95 duration-100 origin-bottom"
                style={{ left: contextMenuBoard.x }}
            >
                <div className="px-3 py-2 text-xs text-zinc-500 border-b border-zinc-100 dark:border-zinc-700 font-medium bg-zinc-50/50 dark:bg-zinc-800/50">
                    {contextMenuBoard.name}
                </div>
                
                <button
                    onClick={() => {
                        setEditingBoardId(contextMenuBoard.id);
                        setEditName(contextMenuBoard.name);
                        setContextMenuBoard(null);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-700/50 transition-colors border-b border-zinc-50 dark:border-zinc-700/50"
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
                className="absolute bottom-full mb-2 bg-white dark:bg-zinc-800 rounded-lg shadow-xl border border-black/5 dark:border-white/10 overflow-hidden animate-in fade-in zoom-in-95 duration-100 origin-bottom z-[100000]"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="px-3 py-2 text-xs text-zinc-500 border-b border-zinc-100 dark:border-zinc-700 font-medium bg-zinc-50/50 dark:bg-zinc-800/50">
                    数据管理
                </div>
                
                <button
                    onClick={onExportClick}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-700/50 transition-colors border-b border-zinc-50 dark:border-zinc-700/50"
                >
                    <Download className="w-4 h-4" />
                    <span>全量备份 (JSON)</span>
                </button>

                {viewMode === 'BOARD' && (
                  <button
                    onClick={async () => {
                      await store.exportCurrentBoard();
                      setShowSettings(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-700/50 transition-colors border-b border-zinc-50 dark:border-zinc-700/50"
                  >
                    <Share className="w-4 h-4" />
                    <span>导出当前看板</span>
                  </button>
                )}

                <button
                    onClick={onImportClick}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-700/50 transition-colors"
                >
                    <Upload className="w-4 h-4" />
                    <span>恢复备份</span>
                </button>
            </div>
        )}

        {/* 3. Input Popover */}
        {isInputMode && (
          <div 
            className="mb-3 p-1.5 bg-white dark:bg-zinc-800 rounded-xl shadow-xl border border-black/5 dark:border-white/10 flex items-center gap-1 animate-in slide-in-from-bottom-2 fade-in duration-200 origin-bottom"
            onClick={(e) => e.stopPropagation()}
          >
             <input
                ref={inputRef}
                type="text"
                placeholder="看板名称..."
                className="bg-transparent border-none outline-none text-sm px-2 py-1.5 w-32 text-zinc-700 dark:text-zinc-200 placeholder:text-zinc-400 font-medium"
                value={newBoardName}
                onChange={(e) => setNewBoardName(e.target.value)}
                onKeyDown={handleKeyDown}
             />
             <button 
               onClick={handleCreate} 
               className="p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-700 rounded-lg text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
             >
                <Plus className="w-4 h-4" />
             </button>
          </div>
        )}

        {/* 4. The Main Dock (Pill) */}
        <div 
          className={cn(
            "flex items-center gap-1 p-1.5 rounded-full",
            "bg-white dark:bg-zinc-900",
            "border border-zinc-200/80 dark:border-zinc-800",
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
                            className="w-full bg-zinc-100 dark:bg-zinc-800 border-none outline-none text-xs px-2 py-1 rounded text-center text-zinc-900 dark:text-zinc-100 font-medium shadow-inner"
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
                    ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900" 
                    : "text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-200",
                  isReordering && "ring-2 ring-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 z-10 scale-110 animate-pulse"
                )}
              >
                {/* Custom Tooltip */}
                <div className={cn(
                    "absolute -top-10 left-1/2 -translate-x-1/2 px-2 py-1 bg-zinc-800 text-zinc-100 text-xs rounded transition-opacity pointer-events-none whitespace-nowrap shadow-sm z-[100000]",
                    isReordering ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                )}>
                    {isReordering ? "⬅️ 移动 ➡️" : board.name}
                    {/* Tiny triangle */}
<div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-zinc-800" />
            </div>
            {/* Active Indicator: Dot below the icon */}
            {isActive && (
              <div className="absolute -bottom-1 w-1 h-1 rounded-full bg-zinc-400 dark:bg-zinc-500" />
            )}
            
            {/* Board Icon */}
            <span className="text-lg leading-none filter drop-shadow-sm transform group-hover:scale-110 transition-transform">
              {board.icon}
            </span>
          </button>
            )
          })}

          {/* Vertical Divider */}
          <div className="w-px h-5 bg-zinc-200 dark:bg-zinc-700 mx-1.5" />

          {/* Add Button */}
          <button
            onClick={() => setIsInputMode(!isInputMode)}
            className={cn(
                "relative group flex items-center justify-center w-9 h-9 rounded-full transition-all duration-200",
                isInputMode 
                  ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 rotate-45" 
                  : "text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-200"
            )}
          >
             {/* Tooltip for Add */}
            {!isInputMode && (
                <div className="absolute -top-10 left-1/2 -translate-x-1/2 px-2 py-1 bg-zinc-800 text-zinc-100 text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap shadow-sm z-[100000]">
                    新建看板
                    <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-zinc-800" />
                </div>
            )}
            <Plus className="w-5 h-5" />
          </button>

          {/* Vertical Divider */}
          <div className="w-px h-5 bg-zinc-200 dark:bg-zinc-700 mx-1.5" />

          {/* Trash Button */}
          <button
            onClick={() => {
              clearSelection();
              setViewMode(viewMode === 'TRASH' ? 'BOARD' : 'TRASH');
            }}
            className={cn(
              "relative group flex items-center justify-center w-9 h-9 rounded-full transition-all duration-200",
              viewMode === 'TRASH'
                ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900"
                : "text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-200"
            )}
          >
            {/* Tooltip for Trash */}
            <div className="absolute -top-10 left-1/2 -translate-x-1/2 px-2 py-1 bg-zinc-800 text-zinc-100 text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap shadow-sm z-[100000]">
              废纸篓
              <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-zinc-800" />
            </div>
            <Trash2 className="w-5 h-5" />
          </button>

          {/* Vertical Divider */}
          <div className="w-px h-5 bg-zinc-200 dark:bg-zinc-700 mx-1.5" />

          {/* Settings Button */}
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={cn(
              "relative group flex items-center justify-center w-9 h-9 rounded-full transition-all duration-200",
              showSettings
                ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900"
                : "text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-200"
            )}
          >
            {/* Tooltip for Settings */}
            <div className="absolute -top-10 left-1/2 -translate-x-1/2 px-2 py-1 bg-zinc-800 text-zinc-100 text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap shadow-sm z-[100000]">
              设置
              <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-zinc-800" />
            </div>
            <Settings className="w-5 h-5" />
          </button>
        </div>
        </div>
      </div>
    </>
  );
};
