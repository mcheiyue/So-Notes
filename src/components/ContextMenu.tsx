import React, { useEffect, useRef, useState } from 'react';
import { useDomainStore, useUIStore, useViewportStore } from '../store';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { cn } from '../utils/cn';
import {
  ArrowDownToLine,
  ArrowUpRight,
  ArrowUpToLine,
  ChevronRight,
  ClipboardPaste,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FilePlus,
  Merge,
  MoveRight,
  Package,
  Palette,
  PanelLeft,
  Scissors,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { Z_INDEX } from '../constants/layout';
import { NOTE_UI_COLORS } from '../store/types';
import { splitParagraphs } from '../utils/smartPaste';
import { appController } from '../controllers/appController';

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
  const contextMenu = useUIStore((s) => s.contextMenu);
  const setContextMenu = useUIStore((s) => s.setContextMenu);
  const selectedIds = useUIStore((s) => s.selectedIds);
  const viewMode = useUIStore((s) => s.viewMode);
  const smartPasteSplitPanel = useUIStore((s) => s.smartPasteSplitPanel);
  const boards = useDomainStore((s) => s.boards);
  const currentBoardId = useDomainStore((s) => s.currentBoardId);
  const viewport = useViewportStore((s) => s.viewport);
  const shellRect = useViewportStore((s) => s.shellRect);
  const menuRef = useRef<HTMLDivElement>(null);
  const [hasClipboardText, setHasClipboardText] = useState(false);
  const [confirmArrange, setConfirmArrange] = useState(false);
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState(false);
  const [activeSubmenu, setActiveSubmenu] = useState<'MOVE' | 'COPY' | 'COLOR' | null>(null);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleArrangeAction = (strategy: 'position' | 'updatedAt' | 'color' = 'position') => {
    const arrangeScope = contextMenu.type === 'CANVAS' && selectedIds.length <= 1 ? 'board' : 'selection';
    const arrangeAtMenuPoint = () => appController.arrangeNotes(toWorldX(contextMenu.x), toWorldY(contextMenu.y), strategy, arrangeScope);

    if (selectedIds.length > 1) {
      handleAction(arrangeAtMenuPoint);
      return;
    }

    if (!confirmArrange) {
      setConfirmArrange(true);
      return;
    }

    handleAction(arrangeAtMenuPoint);
  };

  const handleSubmenuEnter = (menu: 'MOVE' | 'COPY' | 'COLOR') => {
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

  // Logic: Group Context if target is in selection and we have > 1 items
  const isGroupContext = contextMenu.type === 'NOTE' && 
                         contextMenu.targetId && 
                         selectedIds.includes(contextMenu.targetId) && 
                         selectedIds.length > 1;
  const targetNote = contextMenu.type === 'NOTE' && contextMenu.targetId
    ? useDomainStore.getState().notesById[contextMenu.targetId]
    : undefined;
  const canSplitTargetNote = !!targetNote && !targetNote.deletedAt && !smartPasteSplitPanel && splitParagraphs(targetNote.content).length > 1;

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="上下文菜单"
      className="fixed bg-secondary-bg text-text-primary rounded-lg shadow-xl border border-border-subtle py-1 min-w-[160px] select-none"
      style={{ left: menuX, top: menuY, zIndex: Z_INDEX.MENU }}
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
                   appController.showBoardDock();
                 })}
               >
                 <PanelLeft className="w-4 h-4" /> 显示菜单
               </MenuItemButton>
               
                <MenuItemButton
                 role="menuitem"
                 className="text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
                 onClick={() => handleAction(() => appController.createNoteAtWorldPosition({
                    x: toWorldX(contextMenu.x),
                    y: toWorldY(contextMenu.y),
                  }))}
               >
                 <FilePlus className="w-4 h-4" /> 新建便签
                </MenuItemButton>

                {hasClipboardText && (
                  <MenuItemButton
                    role="menuitem"
                    className="text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
                    onClick={() => handleAction(async () => {
                      const text = await readText().catch(() => '');
                      appController.smartPasteFromText(text, {
                        x: toWorldX(contextMenu.x),
                        y: toWorldY(contextMenu.y),
                      });
                    })}
                  >
                    <ClipboardPaste className="w-4 h-4" /> 粘贴并新建
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
                handleArrangeAction();
            }}
          >
            <Sparkles className="w-4 h-4" />
            {selectedIds.length > 1 
                ? '整理选中' 
                : (confirmArrange ? '确认归拢？' : '一键归拢')
            }
          </MenuItemButton>

          {confirmArrange && selectedIds.length <= 1 && (
            <>
              <MenuItemButton
                role="menuitem"
                className="text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
                onClick={() => handleArrangeAction('updatedAt')}
              >
                <Clock className="w-4 h-4" /> 按更新时间归拢
              </MenuItemButton>
              <MenuItemButton
                role="menuitem"
                className="text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
                onClick={() => handleArrangeAction('color')}
              >
                <Palette className="w-4 h-4" /> 按颜色归拢
              </MenuItemButton>
            </>
          )}
        </>
      )}

      {contextMenu.type === 'NOTE' && contextMenu.targetId && (
        <>
           <MenuItemButton
            role="menuitem"
            className="text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
            onClick={() => handleAction(() => {
                appController.startStickyDrag(contextMenu.targetId!, 0, 0);
            })}
          >
            <Package className="w-4 h-4" /> {isGroupContext ? '群组吸附' : '吸附移动'}
          </MenuItemButton>
          
          {isGroupContext && (
            <>
              <div className="h-px bg-border-subtle my-1" />
              <MenuItemButton
                role="menuitem"
                className="text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
                onClick={() => handleAction(() => appController.mergeSelectedNotes())}
              >
                <Merge className="w-4 h-4" /> 合并为一张
              </MenuItemButton>
              <MenuItemButton
                role="menuitem"
                className="text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
                onClick={() => handleAction(() => appController.toggleSelectedNotesCollapse(selectedIds))}
              >
                <Package className="w-4 h-4" /> 批量折叠/展开
              </MenuItemButton>
              <MenuItemButton
                role="menuitem"
                className="text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
                onClick={() => handleAction(() => appController.bringSelectedNotesToFront(selectedIds))}
              >
                <ArrowUpToLine className="w-4 h-4" /> 置顶
              </MenuItemButton>
              <MenuItemButton
                role="menuitem"
                className="text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
                onClick={() => handleAction(() => appController.sendSelectedNotesToBack(selectedIds))}
              >
                <ArrowDownToLine className="w-4 h-4" /> 置底
              </MenuItemButton>
            </>
          )}
          
          <div className="h-px bg-border-subtle my-1" />
          {!isGroupContext && canSplitTargetNote && (
            <>
              <MenuItemButton
                role="menuitem"
                className="text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
                onClick={() => handleAction(() => appController.splitNoteByParagraph(contextMenu.targetId!))}
              >
                <Scissors className="w-4 h-4" /> 按段拆分
              </MenuItemButton>
              <div className="h-px bg-border-subtle my-1" />
            </>
          )}
           
          <div className="relative">
            <MenuItemButton
              role="menuitem"
              aria-haspopup="menu"
              className="justify-between text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
              onMouseEnter={() => handleSubmenuEnter('COLOR')}
              onMouseLeave={handleSubmenuLeave}
            >
              <div className="flex items-center gap-2">
                <Palette className="w-4 h-4" /> {isGroupContext ? '批量改色' : '颜色'}
              </div>
              <ChevronRight className="w-4 h-4 text-text-tertiary" />
            </MenuItemButton>

            {activeSubmenu === 'COLOR' && (
              <div
                role="menu"
                className={cn(
                  'absolute top-0 bg-secondary-bg rounded-lg shadow-xl border border-border-subtle py-2 px-3 min-w-[120px]',
                  submenuOffsetClass,
                )}
                style={{ zIndex: Z_INDEX.MENU }}
                onMouseEnter={() => handleSubmenuEnter('COLOR')}
                onMouseLeave={handleSubmenuLeave}
              >
                <div className="flex gap-2 flex-wrap justify-center">
                  {NOTE_UI_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      role="menuitem"
                      className="w-6 h-6 rounded-full cursor-pointer border border-border-subtle hover:scale-110 transition-transform"
                      style={{ backgroundColor: c }}
                      onClick={() => handleAction(() => {
                        if (isGroupContext) {
                          appController.changeSelectedNotesColor(c);
                        } else {
                          appController.changeNoteColor(contextMenu.targetId!, c);
                        }
                      })}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
          
          <div className="h-px bg-border-subtle my-1" />
          
          {/* Duplicate */}
          {!isGroupContext && (
             <MenuItemButton
                role="menuitem"
                className="text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
                onClick={() => handleAction(() => appController.duplicateNote(contextMenu.targetId!))}
            >
                <Copy className="w-4 h-4" /> 创建副本
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
                        <MoveRight className="w-4 h-4" /> {isGroupContext ? '批量移动到…' : '移动到…'}
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
                                        appController.moveSelectedNotesToBoard(b.id);
                                    } else {
                                        appController.moveNoteToBoard(contextMenu.targetId!, b.id);
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
                        <ExternalLink className="w-4 h-4" /> {isGroupContext ? '批量复制到…' : '复制到…'}
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
                                        appController.copySelectedNotesToBoard(b.id);
                                    } else {
                                        appController.copyNoteToBoard(contextMenu.targetId!, b.id);
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
                appController.bringNoteToFront(contextMenu.targetId!);
            })}
          >
            <ArrowUpToLine className="w-4 h-4" /> 置顶
          </MenuItemButton>

          {viewMode === 'BOARD' && !isGroupContext && (
            <MenuItemButton
              role="menuitem"
              className="text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
              onClick={() => handleAction(() => {
                appController.detachNote(contextMenu.targetId!);
              })}
            >
              <ArrowUpRight className="w-4 h-4" /> 撕下便签
            </MenuItemButton>
          )}
          
          <MenuItemButton
            role="menuitem"
            className="text-text-secondary hover:text-text-primary hover:bg-secondary-bg/50 dark:hover:bg-white/5"
            onClick={() => handleAction(async () => {
                await appController.exportNoteSelection(contextMenu.targetId!);
            })}
          >
            <Download className="w-4 h-4" /> {isGroupContext ? `导出选中 (${selectedIds.length})` : '导出便签'}
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
                        handleAction(() => appController.deleteSelectedNotes());
                    }
                } else {
                    handleAction(() => appController.deleteNote(contextMenu.targetId!));
                }
            }}
          >
            <Trash2 className="w-4 h-4" />
            {isGroupContext 
                ? (confirmDeleteGroup ? `确认删除 ${selectedIds.length} 个便签？` : `批量删除 (${selectedIds.length})`)
                : '删除'}
          </MenuItemButton>
        </>
      )}
    </div>
  );
};

export const ContextMenu: React.FC = () => {
  const isOpen = useUIStore(state => state.contextMenu.isOpen);

  if (!isOpen) return null;

  return <ContextMenuContent />;
};
