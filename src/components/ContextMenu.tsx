import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { cn } from '../utils/cn';
import { ChevronRight } from 'lucide-react';
import { Z_INDEX } from '../constants/layout';

type MenuItemButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

const MenuItemButton: React.FC<MenuItemButtonProps> = ({ className, type, ...props }) => (
  <button
    type={type ?? 'button'}
    className={cn(
      'w-full px-4 py-2 text-left text-sm flex items-center gap-2 transition-colors duration-200',
      className,
    )}
    {...props}
  />
);

const ContextMenuContent: React.FC = () => {
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
    finalizeLayoutChange,
    setDockVisible,
    boards,
    currentBoardId,
    duplicateNote,
    moveNoteToBoard,
    copyNoteToBoard,
    moveSelectedNotesToBoard,
    copySelectedNotesToBoard,
    batchToggleCollapse,
    batchBringToFront,
    batchSendToBack,
    viewport,
    shellRect,
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
    if (contextMenu.type === 'CANVAS') {
      readText().then(text => {
          setHasClipboardText(!!text && text.trim().length > 0);
      }).catch(err => {
          console.error('Clipboard read failed:', err);
          setHasClipboardText(false);
      });
    }
  }, [contextMenu.type]);

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

  const MENU_WIDTH = 160;
  const MENU_HEIGHT = 200;
  const SUBMENU_WIDTH = 140;
  const SUBMENU_GAP = 8;
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
  const maxMenuX = Math.max(shellRect.left, shellRect.right - MENU_WIDTH);
  const maxMenuY = Math.max(shellRect.top, shellRect.bottom - MENU_HEIGHT);
  const menuX = clamp(contextMenu.x, shellRect.left, maxMenuX);
  const menuY = clamp(contextMenu.y, shellRect.top, maxMenuY);
  const toWorldX = (clientX: number) => clientX - shellRect.left + viewport.x;
  const toWorldY = (clientY: number) => clientY - shellRect.top + viewport.y;
  const shouldFlipSubmenuLeft = menuX + MENU_WIDTH + SUBMENU_GAP + SUBMENU_WIDTH > shellRect.right;
  const submenuOffsetClass = shouldFlipSubmenuLeft ? 'right-full mr-2' : 'left-full ml-2';
  const submenuMaxHeight = Math.max(120, shellRect.bottom - menuY - 8);

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
      role="menu"
      aria-label="上下文菜单"
      className="fixed bg-secondary-bg text-text-primary rounded-lg shadow-xl border border-border-subtle py-1 min-w-[160px] select-none"
      style={{ left: menuX, top: menuY, zIndex: Z_INDEX.MENU }}
      onMouseDown={(e) => e.stopPropagation()} // Prevent closing immediately or triggering canvas click
    >
      {contextMenu.type === 'CANVAS' && (
        <>
          {/* Global Mode: No selection OR Single Selection (treat as global for canvas actions) */}
          {selectedIds.length <= 1 && (
            <>
               <MenuItemButton
                role="menuitem"
                className="text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
                 onClick={() => handleAction(() => {
                     setDockVisible(true);
                     // No need to set isOpen:false manually as handleAction does it
                 })}
               >
                 <span>📑</span> 显示菜单
               </MenuItemButton>
               
               <MenuItemButton
                role="menuitem"
                className="text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
                 onClick={() => handleAction(() => addNote(toWorldX(contextMenu.x), toWorldY(contextMenu.y)))}
               >
                 <span>📝</span> 新建便签
               </MenuItemButton>
               
               {hasClipboardText && (
                  <MenuItemButton
                    role="menuitem"
                    className="text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
                     onClick={() => handleAction(async () => {
                         const text = await readText();
                         if (text) {
                             addNoteWithContent(toWorldX(contextMenu.x), toWorldY(contextMenu.y), text);
                         }
                     })}
                  >
                     <span>📋</span> 粘贴并新建
                  </MenuItemButton>
               )}
              
               <div className="h-px bg-border-subtle my-1" />
           </>
          )}

           <MenuItemButton
            role="menuitem"
            className={cn(
                "",
                confirmArrange 
                    ? "bg-red-50 text-red-600 font-medium hover:bg-red-100 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50" 
                    : "hover:bg-secondary-bg/50 dark:hover:bg-white/5 text-text-secondary hover:text-text-primary"
            )}
            onClick={(e) => {
                e.stopPropagation(); // Prevent menu close on first click
                // Only treat as Group Mode if > 1 items selected
                if (selectedIds.length > 1) {
                    // Group arrange: No confirmation needed (safe operation)
                    handleAction(() => arrangeNotes(toWorldX(contextMenu.x), toWorldY(contextMenu.y)));
                } else {
                    // Global arrange: Require confirmation
                    if (!confirmArrange) {
                        setConfirmArrange(true);
                    } else {
                        handleAction(() => arrangeNotes(toWorldX(contextMenu.x), toWorldY(contextMenu.y)));
                    }
                }
            }}
          >
            <span>🧹</span> 
            {selectedIds.length > 1 
                ? '整理选中 (Arrange)' 
                : (confirmArrange ? '确认归拢? (Click Again)' : '一键归拢 (Smart Arrange)')
            }
          </MenuItemButton>
        </>
      )}

      {contextMenu.type === 'NOTE' && contextMenu.targetId && (
        <>
           <MenuItemButton
            role="menuitem"
            className="text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
            onClick={() => handleAction(() => {
                setStickyDrag(contextMenu.targetId!, 0, 0); 
            })}
          >
            <span>🧲</span> {isGroupContext ? '群组吸附' : '吸附移动'}
          </MenuItemButton>
          
          {isGroupContext && (
            <>
              <div className="h-px bg-border-subtle my-1" />
              <MenuItemButton
                role="menuitem"
                className="text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
                onClick={() => handleAction(() => batchToggleCollapse(selectedIds))}
              >
                <span>📦</span> 批量折叠/展开
              </MenuItemButton>
              <MenuItemButton
                role="menuitem"
                className="text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
                onClick={() => handleAction(() => batchBringToFront(selectedIds))}
              >
                <span>⬆️</span> 置顶
              </MenuItemButton>
              <MenuItemButton
                role="menuitem"
                className="text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
                onClick={() => handleAction(() => batchSendToBack(selectedIds))}
              >
                <span>⬇️</span> 置底
              </MenuItemButton>
            </>
          )}
          
          <div className="h-px bg-border-subtle my-1" />
          
          <div className="px-4 py-2 text-xs text-text-tertiary font-semibold">
            {isGroupContext ? '批量改色' : '颜色'}
          </div>
          <div className="px-4 py-1 flex gap-2 flex-wrap">
            {colors.map((c) => (
              <button
                key={c.value}
                type="button"
                role="menuitem"
                className="w-5 h-5 rounded-full cursor-pointer border border-border-subtle hover:scale-110 transition-transform"
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
          
          <div className="h-px bg-border-subtle my-1" />
          
          {/* Duplicate */}
          {!isGroupContext && (
             <MenuItemButton
                role="menuitem"
                className="text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
                onClick={() => handleAction(() => duplicateNote(contextMenu.targetId!))}
            >
                <span>📄</span> 创建副本
            </MenuItemButton>
          )}

          {/* Move To Board */}
          {boards.length > 1 && (
            <div className="relative">
                <MenuItemButton
                    role="menuitem"
                    aria-haspopup="menu"
                    className="justify-between text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
                    onMouseEnter={() => handleSubmenuEnter('MOVE')}
                    onMouseLeave={handleSubmenuLeave}
                >
                    <div className="flex items-center gap-2">
                        <span>➡️</span> {isGroupContext ? '批量移动到...' : '移动到...'}
                    </div>
                    <ChevronRight className="w-4 h-4 text-text-tertiary" />
                </MenuItemButton>
                
                {/* Submenu */}
                {activeSubmenu === 'MOVE' && (
                    <div 
                        role="menu"
                        className={cn(
                          'absolute top-0 bg-secondary-bg rounded-lg shadow-xl border border-border-subtle py-1 min-w-[140px] overflow-y-auto',
                          submenuOffsetClass,
                        )}
                        style={{ zIndex: Z_INDEX.MENU, maxHeight: `${submenuMaxHeight}px` }}
                        onMouseEnter={() => handleSubmenuEnter('MOVE')}
                        onMouseLeave={handleSubmenuLeave}
                    >
                        {boards.filter(b => b.id !== currentBoardId).map(b => (
                            <MenuItemButton
                                key={b.id}
                                role="menuitem"
                                className="text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
                                onClick={() => handleAction(() => {
                                    if (isGroupContext) {
                                        moveSelectedNotesToBoard(b.id);
                                    } else {
                                        moveNoteToBoard(contextMenu.targetId!, b.id);
                                    }
                                })}
                            >
                                <span className="text-xs">{b.icon}</span> {b.name}
                            </MenuItemButton>
                        ))}
                    </div>
                )}
            </div>
          )}

          {/* Copy To Board */}
          {boards.length > 1 && (
            <div className="relative">
                <MenuItemButton
                    role="menuitem"
                    aria-haspopup="menu"
                    className="justify-between text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
                    onMouseEnter={() => handleSubmenuEnter('COPY')}
                    onMouseLeave={handleSubmenuLeave}
                >
                    <div className="flex items-center gap-2">
                        <span>⤴️</span> {isGroupContext ? '批量复制到...' : '复制到...'}
                    </div>
                    <ChevronRight className="w-4 h-4 text-text-tertiary" />
                </MenuItemButton>
                
                {/* Submenu */}
                {activeSubmenu === 'COPY' && (
                    <div 
                        role="menu"
                        className={cn(
                          'absolute top-0 bg-secondary-bg rounded-lg shadow-xl border border-border-subtle py-1 min-w-[140px] overflow-y-auto',
                          submenuOffsetClass,
                        )}
                        style={{ zIndex: Z_INDEX.MENU, maxHeight: `${submenuMaxHeight}px` }}
                        onMouseEnter={() => handleSubmenuEnter('COPY')}
                        onMouseLeave={handleSubmenuLeave}
                    >
                        {boards.filter(b => b.id !== currentBoardId).map(b => (
                            <MenuItemButton
                                key={b.id}
                                role="menuitem"
                                className="text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
                                onClick={() => handleAction(() => {
                                    if (isGroupContext) {
                                        copySelectedNotesToBoard(b.id);
                                    } else {
                                        copyNoteToBoard(contextMenu.targetId!, b.id);
                                    }
                                })}
                            >
                                <span className="text-xs">{b.icon}</span> {b.name}
                            </MenuItemButton>
                        ))}
                    </div>
                )}
            </div>
          )}

          <div className="h-px bg-border-subtle my-1" />
          
          <MenuItemButton
            role="menuitem"
            className="text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
            onClick={() => handleAction(() => {
                bringToFront(contextMenu.targetId!);
                finalizeLayoutChange([contextMenu.targetId!]);
            })}
          >
            <span>🔝</span> 置顶
          </MenuItemButton>
          
          <div className="h-px bg-border-subtle my-1" />

          <MenuItemButton
            role="menuitem"
            className={cn(
                "",
                (isGroupContext && confirmDeleteGroup) ? "bg-red-50 text-red-600 hover:bg-red-100 font-medium dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50" : "text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
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
          </MenuItemButton>
        </>
      )}
    </div>
  );
};

export const ContextMenu: React.FC = () => {
  const isOpen = useStore(state => state.contextMenu.isOpen);

  if (!isOpen) return null;

  return <ContextMenuContent />;
};
