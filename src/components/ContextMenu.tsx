import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { cn } from '../utils/cn';
import { ChevronRight } from 'lucide-react';

export const ContextMenu: React.FC = () => {
  const { 
    contextMenu, 
    setContextMenu, 
    deleteNote, 
    changeColor, 
    changeSelectedNotesColor,
    bringToFront, 
    addNote, 
    addNoteWithContent,
    setStickyDrag, 
    deleteSelectedNotes, 
    selectedIds, 
    arrangeNotes,
    setDockVisible,
    boards,
    currentBoardId,
    duplicateNote,
    moveNoteToBoard,
    copyNoteToBoard,
    moveSelectedNotesToBoard,
    copySelectedNotesToBoard
  } = useStore();
  const menuRef = useRef<HTMLDivElement>(null);
  const [hasClipboardText, setHasClipboardText] = useState(false);
  const [confirmArrange, setConfirmArrange] = useState(false);
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState(false);
  const [activeSubmenu, setActiveSubmenu] = useState<'MOVE' | 'COPY' | null>(null);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSubmenuEnter = (menu: 'MOVE' | 'COPY') => {
      if (closeTimeoutRef.current) {
          clearTimeout(closeTimeoutRef.current);
          closeTimeoutRef.current = null;
      }
      setActiveSubmenu(menu);
  };

  const handleSubmenuLeave = () => {
      closeTimeoutRef.current = setTimeout(() => {
          setActiveSubmenu(null);
      }, 300); // 300ms delay to allow diagonal movement
  };

  // Check clipboard content when menu opens
  useEffect(() => {
    if (contextMenu.isOpen) {
      // Reset states on open
      setConfirmArrange(false);
      setConfirmDeleteGroup(false);
      setActiveSubmenu(null);
      
      if (contextMenu.type === 'CANVAS') {
        readText().then(text => {
            setHasClipboardText(!!text && text.trim().length > 0);
        }).catch(err => {
            console.error('Clipboard read failed:', err);
            setHasClipboardText(false);
        });
      }
    }
  }, [contextMenu.isOpen, contextMenu.type]);

  const handleAction = (action: () => void) => {
    action();
    setContextMenu({ ...contextMenu, isOpen: false });
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setContextMenu({ ...contextMenu, isOpen: false });
      }
    };

    if (contextMenu.isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [contextMenu, setContextMenu]);

  if (!contextMenu.isOpen) return null;

  // Adjust position to keep menu within viewport
  // Simple clamping logic (can be improved with measuring actual height)
  const menuX = Math.min(contextMenu.x, window.innerWidth - 160);
  const menuY = Math.min(contextMenu.y, window.innerHeight - 200);

  const colors = [
    { name: 'Yellow', value: '#FEF3C7' },
    { name: 'Green', value: '#D1FAE5' },
    { name: 'Blue', value: '#DBEAFE' },
    { name: 'Red', value: '#FEE2E2' },
    { name: 'Purple', value: '#E9D5FF' },
    { name: 'Gray', value: '#F3F4F6' },
  ];

  // Logic: Group Context if target is in selection and we have > 1 items
  const isGroupContext = contextMenu.type === 'NOTE' && 
                         contextMenu.targetId && 
                         selectedIds.includes(contextMenu.targetId) && 
                         selectedIds.length > 1;

  return (
    <div
      ref={menuRef}
      className="fixed z-[9999] bg-white rounded-lg shadow-xl border border-gray-200 py-1 min-w-[160px] select-none"
      style={{ left: menuX, top: menuY }}
      onMouseDown={(e) => e.stopPropagation()} // Prevent closing immediately or triggering canvas click
    >
      {contextMenu.type === 'CANVAS' && (
        <>
          {/* Global Mode: No selection OR Single Selection (treat as global for canvas actions) */}
          {selectedIds.length <= 1 && (
            <>
               <div
                className="px-4 py-2 hover:bg-gray-100 cursor-pointer text-sm text-gray-700 flex items-center gap-2"
                onClick={() => handleAction(() => {
                    setDockVisible(true);
                    // No need to set isOpen:false manually as handleAction does it
                })}
              >
                <span>📑</span> 显示菜单
              </div>
              
              <div
                className="px-4 py-2 hover:bg-gray-100 cursor-pointer text-sm text-gray-700 flex items-center gap-2"
                onClick={() => handleAction(() => addNote(contextMenu.x, contextMenu.y))}
              >
                <span>📝</span> 新建便签
              </div>
              
              {hasClipboardText && (
                 <div
                    className="px-4 py-2 hover:bg-gray-100 cursor-pointer text-sm text-gray-700 flex items-center gap-2"
                    onClick={() => handleAction(async () => {
                        const text = await readText();
                        if (text) {
                            addNoteWithContent(contextMenu.x, contextMenu.y, text);
                        }
                    })}
                  >
                    <span>📋</span> 粘贴并新建
                  </div>
              )}
              
               <div className="h-px bg-gray-200 my-1" />
           </>
          )}

           <div
            className={cn(
                "px-4 py-2 cursor-pointer text-sm flex items-center gap-2 transition-colors duration-200",
                confirmArrange 
                    ? "bg-red-50 text-red-600 font-medium hover:bg-red-100" 
                    : "hover:bg-gray-100 text-gray-700"
            )}
            onClick={(e) => {
                e.stopPropagation(); // Prevent menu close on first click
                // Only treat as Group Mode if > 1 items selected
                if (selectedIds.length > 1) {
                    // Group arrange: No confirmation needed (safe operation)
                    handleAction(() => arrangeNotes(contextMenu.x, contextMenu.y));
                } else {
                    // Global arrange: Require confirmation
                    if (!confirmArrange) {
                        setConfirmArrange(true);
                    } else {
                        handleAction(() => arrangeNotes(contextMenu.x, contextMenu.y));
                    }
                }
            }}
          >
            <span>🧹</span> 
            {selectedIds.length > 1 
                ? '整理选中 (Arrange)' 
                : (confirmArrange ? '确认归拢? (Click Again)' : '一键归拢 (Smart Arrange)')
            }
          </div>
        </>
      )}

      {contextMenu.type === 'NOTE' && contextMenu.targetId && (
        <>
           <div
            className="px-4 py-2 hover:bg-gray-100 cursor-pointer text-sm text-gray-700 flex items-center gap-2"
            onClick={() => handleAction(() => {
                setStickyDrag(contextMenu.targetId!, 0, 0); 
            })}
          >
            <span>🧲</span> {isGroupContext ? '群组吸附' : '吸附移动'}
          </div>
          <div className="h-px bg-gray-200 my-1" />
          
          <div className="px-4 py-2 text-xs text-gray-500 font-semibold">
            {isGroupContext ? '批量改色' : '颜色'}
          </div>
          <div className="px-4 py-1 flex gap-2 flex-wrap">
            {colors.map((c) => (
              <div
                key={c.value}
                className="w-5 h-5 rounded-full cursor-pointer border border-gray-300 hover:scale-110 transition-transform"
                style={{ backgroundColor: c.value }}
                title={c.name}
                onClick={() => handleAction(() => {
                    if (isGroupContext) {
                        changeSelectedNotesColor(c.value);
                    } else {
                        changeColor(contextMenu.targetId!, c.value);
                    }
                })}
              />
            ))}
          </div>
          
          <div className="h-px bg-gray-200 my-1" />
          
          {/* Duplicate */}
          {!isGroupContext && (
             <div
                className="px-4 py-2 hover:bg-gray-100 cursor-pointer text-sm text-gray-700 flex items-center gap-2"
                onClick={() => handleAction(() => duplicateNote(contextMenu.targetId!))}
            >
                <span>📄</span> 创建副本
            </div>
          )}

          {/* Move To Board */}
          {boards.length > 1 && (
            <div 
                className="relative"
                onMouseEnter={() => handleSubmenuEnter('MOVE')}
                onMouseLeave={handleSubmenuLeave}
            >
                <div className="px-4 py-2 hover:bg-gray-100 cursor-pointer text-sm text-gray-700 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span>➡️</span> {isGroupContext ? '批量移动到...' : '移动到...'}
                    </div>
                    <ChevronRight className="w-4 h-4 text-gray-400" />
                </div>
                
                {/* Submenu */}
                {activeSubmenu === 'MOVE' && (
                    <div 
                        className="absolute left-full top-0 ml-2 bg-white rounded-lg shadow-xl border border-gray-200 py-1 min-w-[140px] z-[10000]"
                        onMouseEnter={() => handleSubmenuEnter('MOVE')}
                        onMouseLeave={handleSubmenuLeave}
                    >
                        {boards.filter(b => b.id !== currentBoardId).map(b => (
                            <div
                                key={b.id}
                                className="px-4 py-2 hover:bg-gray-100 cursor-pointer text-sm text-gray-700 flex items-center gap-2"
                                onClick={() => handleAction(() => {
                                    if (isGroupContext) {
                                        moveSelectedNotesToBoard(b.id);
                                    } else {
                                        moveNoteToBoard(contextMenu.targetId!, b.id);
                                    }
                                })}
                            >
                                <span className="text-xs">{b.icon}</span> {b.name}
                            </div>
                        ))}
                    </div>
                )}
            </div>
          )}

          {/* Copy To Board */}
          {boards.length > 1 && (
            <div 
                className="relative"
                onMouseEnter={() => handleSubmenuEnter('COPY')}
                onMouseLeave={handleSubmenuLeave}
            >
                <div className="px-4 py-2 hover:bg-gray-100 cursor-pointer text-sm text-gray-700 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span>⤴️</span> {isGroupContext ? '批量复制到...' : '复制到...'}
                    </div>
                    <ChevronRight className="w-4 h-4 text-gray-400" />
                </div>
                
                {/* Submenu */}
                {activeSubmenu === 'COPY' && (
                    <div 
                        className="absolute left-full top-0 ml-2 bg-white rounded-lg shadow-xl border border-gray-200 py-1 min-w-[140px] z-[10000]"
                        onMouseEnter={() => handleSubmenuEnter('COPY')}
                        onMouseLeave={handleSubmenuLeave}
                    >
                        {boards.filter(b => b.id !== currentBoardId).map(b => (
                            <div
                                key={b.id}
                                className="px-4 py-2 hover:bg-gray-100 cursor-pointer text-sm text-gray-700 flex items-center gap-2"
                                onClick={() => handleAction(() => {
                                    if (isGroupContext) {
                                        copySelectedNotesToBoard(b.id);
                                    } else {
                                        copyNoteToBoard(contextMenu.targetId!, b.id);
                                    }
                                })}
                            >
                                <span className="text-xs">{b.icon}</span> {b.name}
                            </div>
                        ))}
                    </div>
                )}
            </div>
          )}

          <div className="h-px bg-gray-200 my-1" />
          
          <div
            className="px-4 py-2 hover:bg-gray-100 cursor-pointer text-sm text-gray-700 flex items-center gap-2"
            onClick={() => handleAction(() => bringToFront(contextMenu.targetId!))}
          >
            <span>🔝</span> 置顶
          </div>
          
          <div className="h-px bg-gray-200 my-1" />

          <div
            className={cn(
                "px-4 py-2 cursor-pointer text-sm flex items-center gap-2 transition-colors",
                (isGroupContext && confirmDeleteGroup) ? "bg-red-50 text-red-600 hover:bg-red-100 font-medium" : "hover:bg-red-50 text-red-600"
            )}
            onClick={(e) => {
                if (isGroupContext) {
                    e.stopPropagation();
                    if (!confirmDeleteGroup) {
                        setConfirmDeleteGroup(true);
                    } else {
                        handleAction(() => deleteSelectedNotes());
                    }
                } else {
                    handleAction(() => deleteNote(contextMenu.targetId!));
                }
            }}
          >
            <span>🗑️</span> 
            {isGroupContext 
                ? (confirmDeleteGroup ? `确认删除 ${selectedIds.length} 个便签?` : `批量删除 (${selectedIds.length})`)
                : '删除'}
          </div>
        </>
      )}
    </div>
  );
};
