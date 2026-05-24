import React, { useState, useEffect, useRef, useCallback } from "react";
import { useStore } from "../store/useStore";
import { Search, CornerDownLeft, Command, FileText, Filter } from "lucide-react";
import { cn } from "../utils/cn";
import { Note } from "../store/types";
import { LAYOUT, Z_INDEX } from "../constants/layout";
import { useSearchWorker } from "../hooks/useSearchWorker";
import type { SearchFilter } from "../workers/searchWorker";

export const Spotlight = () => {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filter, setFilter] = useState<SearchFilter>({ scope: 'all-boards' });
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const boards = useStore((state) => state.boards);
  const currentBoardId = useStore((state) => state.currentBoardId);
  const isSpotlightOpen = useStore((state) => state.isSpotlightOpen);
  const setSpotlightOpen = useStore((state) => state.setSpotlightOpen);
  const toggleCollapse = useStore((state) => state.toggleCollapse);
  const switchBoard = useStore((state) => state.switchBoard);

  const {
    isSearching,
    groups,
    total,
    search: workerSearch,
    clearSearch,
  } = useSearchWorker();

  const [flatResults, setFlatResults] = useState<Note[]>([]);

  useEffect(() => {
    const allItems = groups.flatMap(g => g.items);
    setFlatResults(allItems.map(item => item.note));
  }, [groups]);

  const handleSearch = useCallback((searchQuery: string) => {
    if (!searchQuery.trim()) {
      setFlatResults([]);
      return;
    }

    workerSearch(searchQuery, {
      ...filter,
      currentBoardId: currentBoardId || undefined,
    });
  }, [workerSearch, filter, currentBoardId]);

  useEffect(() => {
    if (isSpotlightOpen) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        setQuery("");
        setSelectedIndex(0);
        setFilter({ scope: 'all-boards' });
      });
    } else {
      setQuery("");
      setSelectedIndex(0);
      setFlatResults([]);
      clearSearch();
    }
  }, [clearSearch, isSpotlightOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isSpotlightOpen) return;
      if (e.key === "Escape") {
        setSpotlightOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSpotlightOpen, setSpotlightOpen]);

  useEffect(() => {
    if (resultsRef.current) {
      const activeItem = resultsRef.current.children[selectedIndex] as HTMLElement;
      if (activeItem) {
        activeItem.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex]);

  const handleSelect = (note: Note) => {
    setSpotlightOpen(false);

    if (note.boardId !== currentBoardId) {
      switchBoard(note.boardId);
    }

    if (note.collapsed) {
      toggleCollapse(note.id);
    }

    requestAnimationFrame(() => {
      const state = useStore.getState();
      const targetNote = state.notesById[note.id];

      if (!targetNote || targetNote.deletedAt || targetNote.boardId !== state.currentBoardId || targetNote.collapsed) {
        return;
      }

      const nWidth = LAYOUT.NOTE_WIDTH;
      const nHeight = Math.max(LAYOUT.NOTE_MIN_HEIGHT, targetNote.height || LAYOUT.NOTE_MIN_HEIGHT);
      const targetX = (targetNote.x + nWidth / 2) - (state.viewport.w / 2);
      const targetY = (targetNote.y + nHeight / 2) - (state.viewport.h / 2);

      state.clearSelection();
      state.setViewportPosition(targetX, targetY);
      state.setSelectedIds([targetNote.id]);
      state.bringToFront(targetNote.id);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex(prev => (prev + 1) % flatResults.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex(prev => (prev - 1 + flatResults.length) % flatResults.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (flatResults[selectedIndex]) {
        handleSelect(flatResults[selectedIndex]);
      }
    }
  };

  const toggleFilter = () => {
    setFilter(prev => {
      const next = prev.scope === 'all-boards'
        ? { scope: 'current-board' as const, currentBoardId: currentBoardId || undefined }
        : prev.scope === 'current-board'
          ? { scope: 'exclude-deleted' as const }
          : { scope: 'all-boards' as const };
      return next;
    });
  };

  const filterLabel = filter.scope === 'all-boards'
    ? '全部看板'
    : filter.scope === 'current-board'
      ? '当前看板'
      : '已删除';

  if (!isSpotlightOpen) return null;

  return (
    <div
      className="pointer-events-auto absolute inset-0 flex items-start justify-center pt-[20vh] px-4"
      style={{ zIndex: Z_INDEX.SPOTLIGHT }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button 
        type="button"
        className="pointer-events-auto absolute inset-0 bg-black/20 backdrop-blur-sm transition-opacity" 
        onClick={() => setSpotlightOpen(false)}
        aria-label="关闭搜索"
      />

      <div className="pointer-events-auto relative w-full max-w-2xl flex flex-col overflow-hidden rounded-2xl bg-secondary-bg/80 backdrop-blur-2xl shadow-2xl ring-1 ring-border-subtle animate-in fade-in zoom-in-95 duration-200">
        
        <div className="flex items-center px-4 border-b border-border-subtle/50">
          <Search className="w-5 h-5 text-text-tertiary mr-3" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
              handleSearch(e.target.value);
            }}
            onKeyDown={handleKeyDown}
            className="flex-1 h-14 bg-transparent border-none outline-none text-lg text-text-primary placeholder:text-text-tertiary"
            placeholder="搜索便签..."
          />
          <button
            type="button"
            onClick={toggleFilter}
            className={cn(
              "flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors",
              filter.scope === 'all-boards'
                ? "text-text-tertiary bg-tertiary-bg/50 border-border-subtle/50"
                : "text-indigo-500 bg-indigo-50/50 border-indigo-200"
            )}
          >
            <Filter className="w-3 h-3" />
            {filterLabel}
          </button>
          <div className="text-xs text-text-tertiary font-medium px-2 py-1 bg-tertiary-bg/50 rounded border border-border-subtle/50 ml-2">
            ESC
          </div>
        </div>

        <div 
            ref={resultsRef}
            className="flex-1 overflow-y-auto max-h-[60vh] scrollbar-thin scrollbar-thumb-gray-200 scrollbar-track-transparent p-2"
        >
          {isSearching ? (
            <div className="py-12 text-center text-text-tertiary text-sm">
              搜索中...
            </div>
          ) : groups.length > 0 ? (
            groups.map((group) => (
              <div key={group.type} className="mb-2">
                <div className="text-xs font-medium text-text-tertiary px-3 py-1.5 uppercase tracking-wider">
                  {group.label}
                </div>
                {group.items.map((item) => {
                  const note = item.note;
                  const board = boards.find(b => b.id === note.boardId);
                  const globalIndex = flatResults.indexOf(note);
                  
                  return (
                    <button
                      type="button"
                      key={note.id}
                      onClick={() => handleSelect(note)}
                      onMouseEnter={() => setSelectedIndex(globalIndex)}
                      className={cn(
                        "group flex w-full items-center p-3 rounded-xl cursor-pointer transition-all duration-200 text-left",
                        globalIndex === selectedIndex 
                          ? "bg-indigo-50/80 dark:bg-indigo-500/20 shadow-sm translate-x-1" 
                          : "hover:bg-secondary-bg/50 dark:hover:bg-white/5"
                      )}
                    >
                      <div className={cn(
                          "flex items-center justify-center w-8 h-8 rounded-lg mr-4 transition-colors",
                          globalIndex === selectedIndex 
                              ? "bg-secondary-bg text-indigo-500 shadow-sm" 
                              : "bg-tertiary-bg text-text-tertiary group-hover:bg-secondary-bg group-hover:text-text-secondary"
                      )}>
                          <FileText className="w-4 h-4" />
                      </div>

                      <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-0.5">
                              <span className={cn(
                                  "font-medium truncate",
                                  globalIndex === selectedIndex ? "text-indigo-700 dark:text-indigo-300" : "text-text-secondary"
                              )}>
                                  {note.title || <span className="italic opacity-50">无标题</span>}
                              </span>
                              {globalIndex === selectedIndex && (
                                  <CornerDownLeft className="w-3 h-3 text-indigo-400 dark:text-indigo-300 opacity-50" />
                              )}
                          </div>
                          
                          <div className="flex items-center">
                              {note.boardId !== currentBoardId && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-tertiary-bg text-text-tertiary border border-border-subtle mr-2">
                                  {board?.name || "其他看板"}
                                </span>
                              )}
                              <span className="text-xs text-text-tertiary truncate max-w-[500px] pl-3">
                                  {note.content ? note.content.replace(/\n/g, ' ') : <span className="italic opacity-30">无内容</span>}
                              </span>
                          </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            ))
          ) : query ? (
            <div className="py-12 text-center text-text-tertiary text-sm">
              未找到与 "{query}" 相关的便签
            </div>
          ) : (
            <div className="py-12 text-center text-text-tertiary text-sm">
              输入关键词以搜索...
            </div>
          )}
        </div>

        <div className="px-4 py-2 bg-tertiary-bg/30 border-t border-border-subtle/50 flex items-center justify-between text-[10px] text-text-tertiary">
            <div className="flex gap-4">
                <span className="flex items-center"><Command className="w-3 h-3 mr-1" /> K 搜索</span>
                <span className="flex items-center"><span className="mr-1">↑↓</span> 导航</span>
                <span className="flex items-center"><CornerDownLeft className="w-3 h-3 mr-1" /> 打开</span>
            </div>
            <div>
                {total} 个结果
            </div>
        </div>

      </div>
    </div>
  );
}
