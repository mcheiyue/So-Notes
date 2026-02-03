import React, { useEffect, useRef } from 'react';
import { useStore } from '../store/useStore';

export const ContextMenu: React.FC = () => {
  const { contextMenu, setContextMenu, deleteNote, changeColor, bringToFront, addNote, setStickyDrag, deleteSelectedNotes, selectedIds, arrangeNotes } = useStore();
  const menuRef = useRef<HTMLDivElement>(null);

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

  const handleAction = (action: () => void) => {
    action();
    setContextMenu({ ...contextMenu, isOpen: false });
  };

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

  return (
    <div
      ref={menuRef}
      className="fixed z-[9999] bg-white rounded-lg shadow-xl border border-gray-200 py-1 min-w-[160px] select-none"
      style={{ left: menuX, top: menuY }}
      onMouseDown={(e) => e.stopPropagation()} // Prevent closing immediately or triggering canvas click
    >
      {contextMenu.type === 'CANVAS' && (
        <>
          <div
            className="px-4 py-2 hover:bg-gray-100 cursor-pointer text-sm text-gray-700 flex items-center gap-2"
            onClick={() => handleAction(() => addNote(contextMenu.x, contextMenu.y))}
          >
            <span>📝</span> 新建便签
          </div>
          {/* Future: Paste to Create */}
           <div className="h-px bg-gray-200 my-1" />
           <div
            className="px-4 py-2 hover:bg-gray-100 cursor-pointer text-sm text-gray-700 flex items-center gap-2"
            onClick={() => handleAction(() => arrangeNotes())}
          >
            <span>🧹</span> 整理便签 (Snap Grid)
          </div>
        </>
      )}

      {contextMenu.type === 'NOTE' && contextMenu.targetId && (
        <>
           <div
            className="px-4 py-2 hover:bg-gray-100 cursor-pointer text-sm text-gray-700 flex items-center gap-2"
            onClick={() => handleAction(() => {
                // Trigger Sticky Drag for this note
                // We need to calculate offset, but for now center it or use 0,0
                // Ideally we should pass offset when opening context menu, but simplified for now.
                setStickyDrag(contextMenu.targetId!, 0, 0); 
            })}
          >
            <span>🧲</span> 吸附移动
          </div>
          <div className="h-px bg-gray-200 my-1" />
          
          <div className="px-4 py-2 text-xs text-gray-500 font-semibold">颜色</div>
          <div className="px-4 py-1 flex gap-2 flex-wrap">
            {colors.map((c) => (
              <div
                key={c.value}
                className="w-5 h-5 rounded-full cursor-pointer border border-gray-300 hover:scale-110 transition-transform"
                style={{ backgroundColor: c.value }}
                title={c.name}
                onClick={() => handleAction(() => changeColor(contextMenu.targetId!, c.value))}
              />
            ))}
          </div>
          
          <div className="h-px bg-gray-200 my-1" />
          
          <div
            className="px-4 py-2 hover:bg-gray-100 cursor-pointer text-sm text-gray-700 flex items-center gap-2"
            onClick={() => handleAction(() => bringToFront(contextMenu.targetId!))}
          >
            <span>🔝</span> 置顶
          </div>
          
          <div
            className="px-4 py-2 hover:bg-red-50 cursor-pointer text-sm text-red-600 flex items-center gap-2"
            onClick={() => handleAction(() => {
                if (selectedIds.includes(contextMenu.targetId!)) {
                    deleteSelectedNotes();
                } else {
                    deleteNote(contextMenu.targetId!);
                }
            })}
          >
            <span>🗑️</span> 删除
            {selectedIds.includes(contextMenu.targetId!) && selectedIds.length > 1 && ` (${selectedIds.length})`}
          </div>
        </>
      )}
    </div>
  );
};
