import React, { useState, useMemo } from 'react';
import { confirm } from '../store/confirmStore';
import { useDomainStore } from '../store';
import { useStore } from '../store/useStore';
import { useShallow } from 'zustand/react/shallow';
import { NoteCard } from './NoteCard';
import { Trash2, RotateCcw, X, Search } from 'lucide-react';
import { appController } from '../controllers/appController';

export const TrashGrid: React.FC = () => {
    const { notesById, allNoteIds, boards } = useDomainStore(useShallow(state => ({
        notesById: state.notesById,
        allNoteIds: state.allNoteIds,
        boards: state.boards,
    })));
    const restoreNote = useStore(state => state.restoreNote);
    const deleteNotePermanently = useStore(state => state.deleteNotePermanently);
    const emptyTrash = useStore(state => state.emptyTrash);
    const restoreAllTrash = useStore(state => state.restoreAllTrash);
    const restoreSelectedTrash = useStore(state => state.restoreSelectedTrash);
    const deleteSelectedPermanently = useStore(state => state.deleteSelectedPermanently);

    const [selectedTrashIds, setSelectedTrashIds] = useState<string[]>([]);
    const [searchQuery, setSearchQuery] = useState('');

    const deletedNotes = useMemo(() => allNoteIds
            .flatMap((id) => {
                const note = notesById[id];
                return note?.deletedAt ? [note] : [];
            })
            .sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0)),
        [allNoteIds, notesById]
    );

    const filteredNotes = useMemo(() => {
        const trimmed = searchQuery.trim().toLowerCase();
        if (!trimmed) return deletedNotes;
        return deletedNotes.filter(
            (note) =>
                note.title.toLowerCase().includes(trimmed) ||
                note.content.toLowerCase().includes(trimmed),
        );
    }, [deletedNotes, searchQuery]);

    const getBoardName = (boardId: string) => {
        return boards.find(b => b.id === boardId)?.name || '未知看板';
    };

    const handleTrashNoteClick = (noteId: string, e: React.MouseEvent) => {
        if (e.ctrlKey || e.shiftKey) {
            setSelectedTrashIds(prev => 
                prev.includes(noteId) 
                    ? prev.filter(id => id !== noteId)
                    : [...prev, noteId]
            );
        } else {
            setSelectedTrashIds([noteId]);
        }
    };

    const handleBatchRestore = () => {
        if (selectedTrashIds.length === 0) return;
        restoreSelectedTrash(selectedTrashIds);
        setSelectedTrashIds([]);
    };

    const handleBatchDelete = async () => {
        if (selectedTrashIds.length === 0) return;
        if (await confirm({ title: '永久删除', message: `确认永久删除选中的 ${selectedTrashIds.length} 个便签？此操作无法撤销。`, kind: 'danger' })) {
            deleteSelectedPermanently(selectedTrashIds);
            setSelectedTrashIds([]);
        }
    };

    if (deletedNotes.length === 0) {
        return (
            <div className="w-full h-full flex flex-col items-center justify-center animate-in fade-in duration-300">
                <div className="text-text-tertiary mb-4">
                    <Trash2 size={64} strokeWidth={1} />
                </div>
                <h2 className="text-xl font-medium text-text-secondary">废纸篓是空的</h2>
                <p className="text-sm text-text-tertiary mt-2">这里没有已删除的便签</p>
                <button
                    type="button"
                    onClick={() => appController.enterBoardMode()}
                    className="mt-6 px-6 py-2.5 bg-secondary-bg border border-border-subtle text-text-primary rounded-lg hover:bg-secondary-bg/80 transition-colors text-sm font-medium shadow-sm"
                >
                    返回看板
                </button>
            </div>
        );
    }

    return (
        <div className="w-full h-full overflow-y-auto animate-in fade-in duration-300 relative">
            
            {/* Header */}
            <div 
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
                    {selectedTrashIds.length > 0 && (
                        <>
                            <button 
                                type="button"
                                onClick={handleBatchRestore}
                                className="flex items-center gap-2 px-4 py-2 bg-blue-50 text-blue-600 border border-blue-100 rounded-lg hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-900/50 dark:hover:bg-blue-900/50 transition-colors text-sm font-medium shadow-sm"
                            >
                                <RotateCcw size={16} />
                                还原选中 ({selectedTrashIds.length})
                            </button>
                            <button 
                                type="button"
                                onClick={handleBatchDelete}
                                className="flex items-center gap-2 px-4 py-2 bg-red-50 text-red-600 border border-red-100 rounded-lg hover:bg-red-100 dark:bg-red-900/30 dark:text-red-400 dark:border-red-900/50 dark:hover:bg-red-900/50 transition-colors text-sm font-medium shadow-sm"
                            >
                                <Trash2 size={16} />
                                永久删除选中 ({selectedTrashIds.length})
                            </button>
                            <div className="w-px h-6 bg-border-subtle"></div>
                        </>
                    )}
                    <button 
                        type="button"
                        onClick={async () => {
                            if (await confirm({ title: '全部还原', message: '确认还原所有便签？' })) restoreAllTrash();
                        }}
                        className="flex items-center gap-2 px-4 py-2 bg-secondary-bg border border-border-subtle text-text-primary rounded-lg hover:bg-secondary-bg/80 transition-colors text-sm font-medium shadow-sm"
                    >
                        <RotateCcw size={16} />
                        全部还原
                    </button>
                    <button 
                        type="button"
                        onClick={async () => {
                            if (await confirm({ title: '清空废纸篓', message: '确认清空废纸篓？此操作无法撤销。', kind: 'danger' })) emptyTrash();
                        }}
                        className="flex items-center gap-2 px-4 py-2 bg-red-50 text-red-600 border border-red-100 rounded-lg hover:bg-red-100 dark:bg-red-900/30 dark:text-red-400 dark:border-red-900/50 dark:hover:bg-red-900/50 transition-colors text-sm font-medium shadow-sm"
                    >
                        <Trash2 size={16} />
                        清空废纸篓
                    </button>
                    <div className="w-px h-6 bg-border-subtle"></div>
                    <button 
                        type="button"
                        onClick={() => appController.enterBoardMode()}
                        className="p-2 bg-secondary-bg border border-border-subtle text-text-secondary rounded-lg hover:bg-secondary-bg/80 transition-colors shadow-sm"
                        title="返回看板"
                    >
                        <X size={18} />
                    </button>
                </div>
            </div>

            {/* Search Bar */}
            <div className="sticky top-[73px] z-40 bg-secondary-bg/80 backdrop-blur-md border-b border-border-subtle px-8 py-3">
                <div className="flex items-center gap-3 max-w-xl mx-auto px-4 py-2.5 bg-secondary-bg/60 border border-border-subtle rounded-xl transition-colors focus-within:border-blue-400/50 focus-within:ring-1 focus-within:ring-blue-400/30">
                    <Search size={16} className="text-text-tertiary shrink-0" />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="flex-1 bg-transparent border-none outline-none text-sm text-text-primary placeholder:text-text-tertiary"
                        placeholder="在废纸篓中搜索…"
                        aria-label="在废纸篓中搜索"
                    />
                    {searchQuery && (
                        <button
                            type="button"
                            onClick={() => setSearchQuery('')}
                            className="p-0.5 text-text-tertiary hover:text-text-secondary transition-colors"
                            aria-label="清除搜索"
                        >
                            <X size={14} />
                        </button>
                    )}
                </div>
            </div>

            {/* Grid Content */}
            <div className="p-8 grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-6 pb-32">
                {filteredNotes.map(note => (
                    <div 
                        key={note.id} 
                        className={`relative group flex flex-col cursor-pointer rounded-2xl transition-all ${
                            selectedTrashIds.includes(note.id) 
                                ? 'ring-2 ring-blue-500 ring-offset-2 ring-offset-secondary-bg' 
                                : ''
                        }`}
                        onClick={(e) => handleTrashNoteClick(note.id, e)}
                    >
                        {/* Wrapper to overlay actions */}
                        <div className="relative">
                            <NoteCard 
                                id={note.id}
                                isStatic={true}
                            />
                            
                            {/* Overlay Mask */}
                            <div className={`absolute inset-0 transition-colors pointer-events-none rounded-2xl ${
                                selectedTrashIds.includes(note.id)
                                    ? 'bg-blue-500/10'
                                    : 'bg-white/10 dark:bg-black/10 group-hover:bg-white/0 dark:group-hover:bg-black/0'
                            }`} />
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
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        restoreNote(note.id);
                                    }}
                                    className="p-1.5 bg-blue-50 text-blue-600 rounded-md hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400 dark:hover:bg-blue-900/50 transition-colors"
                                    title="还原"
                                >
                                    <RotateCcw size={14} />
                                </button>
                                <button
                                    type="button"
                                    onClick={async (e) => {
                                        e.stopPropagation();
                                        if (await confirm({ title: '永久删除', message: '确认永久删除此便签？此操作无法撤销。', kind: 'danger' })) deleteNotePermanently(note.id);
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
