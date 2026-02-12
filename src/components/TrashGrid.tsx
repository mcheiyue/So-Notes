import React from 'react';
import { useStore } from '../store/useStore';
import { NoteCard } from './NoteCard';
import { Trash2, RotateCcw, X } from 'lucide-react';

export const TrashGrid: React.FC = () => {
    const notes = useStore(state => state.notes);
    const boards = useStore(state => state.boards);
    const restoreNote = useStore(state => state.restoreNote);
    const deleteNotePermanently = useStore(state => state.deleteNotePermanently);
    const emptyTrash = useStore(state => state.emptyTrash);
    const restoreAllTrash = useStore(state => state.restoreAllTrash);

    // Filter deleted notes
    const deletedNotes = notes.filter(n => n.deletedAt).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));

    // Get board name helper
    const getBoardName = (boardId: string) => {
        return boards.find(b => b.id === boardId)?.name || 'Unknown Board';
    };

    const setViewMode = useStore(state => state.setViewMode);

    if (deletedNotes.length === 0) {
        return (
            <div className="w-full h-screen flex flex-col items-center justify-center bg-primary-bg/90 backdrop-blur-sm animate-in fade-in duration-300">
                <div className="text-text-tertiary mb-4">
                    <Trash2 size={64} strokeWidth={1} />
                </div>
                <h2 className="text-xl font-medium text-text-secondary">废纸篓是空的</h2>
                <p className="text-sm text-text-tertiary mt-2">这里没有已删除的便签</p>
                <button
                    onClick={() => setViewMode('BOARD')}
                    className="mt-6 px-6 py-2.5 bg-secondary-bg border border-border-subtle text-text-primary rounded-lg hover:bg-secondary-bg/80 transition-colors text-sm font-medium shadow-sm"
                >
                    返回看板
                </button>
            </div>
        );
    }

    return (
        <div className="w-full h-screen bg-primary-bg/95 backdrop-blur-sm overflow-y-auto animate-in fade-in duration-300 z-40 relative">
            
            {/* Header with Drag Region */}
            <div 
                data-tauri-drag-region 
                className="sticky top-0 z-50 bg-secondary-bg/80 backdrop-blur-md border-b border-border-subtle px-8 py-4 flex items-center justify-between"
            >
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg">
                        <Trash2 size={24} />
                    </div>
                    <div>
                        <h1 className="text-xl font-bold text-text-primary">废纸篓</h1>
                        <p className="text-xs text-text-secondary">{deletedNotes.length} 个已删除的便签</p>
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    <button 
                        onClick={() => {
                            if (window.confirm('确认还原所有便签吗?')) restoreAllTrash();
                        }}
                        className="flex items-center gap-2 px-4 py-2 bg-secondary-bg border border-border-subtle text-text-primary rounded-lg hover:bg-secondary-bg/80 transition-colors text-sm font-medium shadow-sm"
                    >
                        <RotateCcw size={16} />
                        全部还原
                    </button>
                    <button 
                        onClick={() => {
                            if (window.confirm('确认清空废纸篓吗? 此操作无法撤销。')) emptyTrash();
                        }}
                        className="flex items-center gap-2 px-4 py-2 bg-red-50 text-red-600 border border-red-100 rounded-lg hover:bg-red-100 dark:bg-red-900/30 dark:text-red-400 dark:border-red-900/50 dark:hover:bg-red-900/50 transition-colors text-sm font-medium shadow-sm"
                    >
                        <Trash2 size={16} />
                        清空废纸篓
                    </button>
                    <div className="w-px h-6 bg-border-subtle"></div>
                    <button 
                        onClick={() => setViewMode('BOARD')}
                        className="p-2 bg-secondary-bg border border-border-subtle text-text-secondary rounded-lg hover:bg-secondary-bg/80 transition-colors shadow-sm"
                        title="返回看板"
                    >
                        <X size={18} />
                    </button>
                </div>
            </div>

            {/* Grid Content */}
            <div className="p-8 grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-6 pb-32">
                {deletedNotes.map(note => (
                    <div key={note.id} className="relative group flex flex-col">
                        {/* Wrapper to overlay actions */}
                        <div className="relative">
                            <NoteCard 
                                id={note.id}
                                isStatic={true} // Disable DnD
                            />
                            
                            {/* Overlay Mask */}
                            <div className="absolute inset-0 bg-white/10 dark:bg-black/10 group-hover:bg-white/0 dark:group-hover:bg-black/0 transition-colors pointer-events-none rounded-2xl" />
                        </div>

                        {/* Metadata & Actions Footer */}
                        <div className="mt-2 flex items-center justify-between px-1">
                            <div className="flex flex-col">
                                <span className="text-[10px] text-text-tertiary font-medium uppercase tracking-wider">
                                    来自: {getBoardName(note.boardId)}
                                </span>
                                <span className="text-[10px] text-text-tertiary">
                                    删除: {new Date(note.deletedAt!).toLocaleDateString()}
                                </span>
                            </div>

                            <div className="flex items-center gap-1 opacity-100 md:opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                    onClick={() => restoreNote(note.id)}
                                    className="p-1.5 bg-blue-50 text-blue-600 rounded-md hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400 dark:hover:bg-blue-900/50 transition-colors"
                                    title="还原"
                                >
                                    <RotateCcw size={14} />
                                </button>
                                <button
                                    onClick={() => {
                                        if (window.confirm('确认永久删除此便签?')) deleteNotePermanently(note.id);
                                    }}
                                    className="p-1.5 bg-red-50 text-red-600 rounded-md hover:bg-red-100 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50 transition-colors"
                                    title="永久删除"
                                >
                                    <Trash2 size={14} />
                                </button>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};
