import React, { useState, useMemo, useEffect, useRef } from "react";
import { useStore } from "../store/useStore";
import { Search, CornerDownLeft, Command, FileText } from "lucide-react";
import { cn } from "../utils/cn";
import { Note } from "../store/types";
import { LAYOUT } from "../constants/layout";

export const Spotlight = () => {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // Use granular state access to prevent rerenders on unrelated changes
  const notes = useStore((state) => state.notes);
  const boards = useStore((state) => state.boards);
  const currentBoardId = useStore((state) => state.currentBoardId);
  const isSpotlightOpen = useStore((state) => state.isSpotlightOpen);
  const setSpotlightOpen = useStore((state) => state.setSpotlightOpen);
  const setViewportPosition = useStore((state) => state.setViewportPosition);
  const setSelectedIds = useStore((state) => state.setSelectedIds);
  const toggleCollapse = useStore((state) => state.toggleCollapse);
  const switchBoard = useStore((state) => state.switchBoard);
  const clearSelection = useStore((state) => state.clearSelection);
  const bringToFront = useStore((state) => state.bringToFront);

  // Auto-focus input on open
  useEffect(() => {
    if (isSpotlightOpen) {
      // Small delay to ensure render
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
      setQuery("");
      setSelectedIndex(0);
    }
  }, [isSpotlightOpen]);

  // Close on Escape
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

  // Search Logic (Weighted)
  const results = useMemo(() => {
    if (!query.trim()) return [];

    const q = query.toLowerCase();
    
    return notes
      .filter(note => !note.deletedAt) // Exclude trash
      .map(note => {
        const title = String(note.title || "").toLowerCase();
        const content = String(note.content || "").toLowerCase();
        
        let score = 0;
        
        // Exact title match (highest)
        if (title === q) score += 100;
        // Title starts with
        else if (title.startsWith(q)) score += 80;
        // Title includes
        else if (title.includes(q)) score += 60;
        // Content includes
        else if (content.includes(q)) score += 40;
        
        return { note, score };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50) // Limit results
      .map(item => item.note);
  }, [query, notes]);

  // Scroll active item into view
  useEffect(() => {
      if (resultsRef.current) {
          const activeItem = resultsRef.current.children[selectedIndex] as HTMLElement;
          if (activeItem) {
              activeItem.scrollIntoView({ block: 'nearest' });
          }
      }
  }, [selectedIndex, results]);

  // Handle Selection / Navigation
  const handleSelect = (note: Note) => {
    // 1. Close Spotlight
    setSpotlightOpen(false);
    
    // 2. Switch Board if needed
    if (note.boardId !== currentBoardId) {
      switchBoard(note.boardId);
    }

    // 3. Expand if collapsed
    if (note.collapsed) {
      toggleCollapse(note.id);
    }

    // 4. Calculate Center Position
    const nWidth = LAYOUT.NOTE_WIDTH;
    const nHeight = note.collapsed ? LAYOUT.NOTE_COLLAPSED_HEIGHT : Math.max(LAYOUT.NOTE_MIN_HEIGHT, note.height || LAYOUT.NOTE_MIN_HEIGHT);
    
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    
    const targetX = (note.x + nWidth / 2) - (winW / 2);
    const targetY = (note.y + nHeight / 2) - (winH / 2);

    // 5. Jump & Select
    // Use timeout to allow board switch render cycle to complete if needed
    setTimeout(() => {
      clearSelection();
      setViewportPosition(targetX, targetY);
      setSelectedIds([note.id]);
      bringToFront(note.id);
    }, 10);
  };

  // Keyboard Navigation inside Input
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex(prev => (prev + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex(prev => (prev - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results[selectedIndex]) {
        handleSelect(results[selectedIndex]);
      }
    }
  };

  if (!isSpotlightOpen) return null;

  return (
    <div className="fixed inset-0 z-[100000] flex items-start justify-center pt-[20vh] px-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/20 backdrop-blur-sm transition-opacity" 
        onClick={() => setSpotlightOpen(false)}
      />

      {/* Container - Styled with Semantic Colors */}
      <div className="relative w-full max-w-2xl flex flex-col overflow-hidden rounded-2xl bg-secondary-bg/80 backdrop-blur-2xl shadow-2xl ring-1 ring-border-subtle animate-in fade-in zoom-in-95 duration-200">
        
        {/* Input Area */}
        <div className="flex items-center px-4 border-b border-border-subtle/50">
          <Search className="w-5 h-5 text-text-tertiary mr-3" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            className="flex-1 h-14 bg-transparent border-none outline-none text-lg text-text-primary placeholder:text-text-tertiary"
            placeholder="搜索便签..."
          />
          <div className="text-xs text-text-tertiary font-medium px-2 py-1 bg-tertiary-bg/50 rounded border border-border-subtle/50">
            ESC
          </div>
        </div>

        {/* Results List */}
        <div 
            ref={resultsRef}
            className="flex-1 overflow-y-auto max-h-[60vh] scrollbar-thin scrollbar-thumb-gray-200 scrollbar-track-transparent p-2"
        >
          {results.length > 0 ? (
            results.map((note, index) => {
                const board = boards.find(b => b.id === note.boardId);
                return (
                  <div
                    key={note.id}
                    onClick={() => handleSelect(note)}
                    onMouseEnter={() => setSelectedIndex(index)}
                    className={cn(
                      "group flex items-center p-3 rounded-xl cursor-pointer transition-all duration-200",
                      index === selectedIndex 
                        ? "bg-indigo-50/80 dark:bg-indigo-500/20 shadow-sm translate-x-1" 
                        : "hover:bg-secondary-bg/50 dark:hover:bg-white/5"
                    )}
                  >
                    <div className={cn(
                        "flex items-center justify-center w-8 h-8 rounded-lg mr-4 transition-colors",
                        index === selectedIndex 
                            ? "bg-secondary-bg text-indigo-500 shadow-sm" 
                            : "bg-tertiary-bg text-text-tertiary group-hover:bg-secondary-bg group-hover:text-text-secondary"
                    )}>
                        <FileText className="w-4 h-4" />
                    </div>

                    <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-0.5">
                            <span className={cn(
                                "font-medium truncate",
                                index === selectedIndex ? "text-indigo-700 dark:text-indigo-300" : "text-text-secondary"
                            )}>
                                {note.title || <span className="italic opacity-50">无标题</span>}
                            </span>
                            {index === selectedIndex && (
                                <CornerDownLeft className="w-3 h-3 text-indigo-400 dark:text-indigo-300 opacity-50" />
                            )}
                        </div>
                        
                        <div className="flex items-center">
                            {/* Board Badge */}
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
                  </div>
                );
            })
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

        {/* Footer */}
        <div className="px-4 py-2 bg-tertiary-bg/30 border-t border-border-subtle/50 flex items-center justify-between text-[10px] text-text-tertiary">
            <div className="flex gap-4">
                <span className="flex items-center"><Command className="w-3 h-3 mr-1" /> K 搜索</span>
                <span className="flex items-center"><span className="mr-1">↑↓</span> 导航</span>
                <span className="flex items-center"><CornerDownLeft className="w-3 h-3 mr-1" /> 打开</span>
            </div>
            <div>
                {results.length} 个结果
            </div>
        </div>

      </div>
    </div>
  );
}