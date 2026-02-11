import { useState, useMemo, useEffect, useRef } from "react";
import { useStore } from "../store/useStore";
import { Search, CornerDownLeft } from "lucide-react";
import { Note } from "../store/types";
import { cn } from "../utils/cn";
import { LAYOUT } from "../constants/layout";

export default function Spotlight() {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  
  // Use shallow state access to prevent rerenders on drag
  const notes = useStore((state) => state.notes);
  const boards = useStore((state) => state.boards);
  const currentBoardId = useStore((state) => state.currentBoardId);
  const isSpotlightOpen = useStore((state) => state.isSpotlightOpen);
  const setSpotlightOpen = useStore((state) => state.setSpotlightOpen);
  const setViewport = useStore((state) => state.setViewportPosition);
  const setSelectedIds = useStore((state) => state.setSelectedIds);
  const toggleCollapse = useStore((state) => state.toggleCollapse);
  // FIX: Use switchBoard instead of setCurrentBoardId
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
      if (e.key === "Escape") {
        setSpotlightOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setSpotlightOpen]);

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

  // Handle Selection / Navigation
  const handleSelect = (note: Note) => {
    // 1. Close Spotlight
    setSpotlightOpen(false);
    
    // 2. Switch Board if needed
    if (note.boardId !== currentBoardId) {
      // FIX: Use switchBoard to properly handle viewport saving/restoring
      switchBoard(note.boardId);
      // We might need a small delay or use useEffect to wait for board switch
      // But Zustand is synchronous, so state updates immediately. 
      // Components might take a frame to render.
    }

    // 3. Expand if collapsed
    if (note.collapsed) {
      toggleCollapse(note.id);
    }

    // 4. Calculate Center Position
    const nWidth = LAYOUT.NOTE_WIDTH;
    const nHeight = note.collapsed ? LAYOUT.NOTE_COLLAPSED_HEIGHT : Math.max(LAYOUT.NOTE_MIN_HEIGHT, note.height || LAYOUT.NOTE_MIN_HEIGHT);
    
    // Center viewport on note center
    // Viewport (0,0) is top-left. We want note center to be screen center.
    // Screen center = (winW/2, winH/2).
    // Note center = (note.x + w/2, note.y + h/2).
    // Target Viewport X = Note Center X - Screen Center X
    
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    
    const targetX = (note.x + nWidth / 2) - (winW / 2);
    const targetY = (note.y + nHeight / 2) - (winH / 2);

    // 5. Jump & Select
    // Use timeout to allow board switch render cycle to complete if needed
    setTimeout(() => {
      clearSelection();
      setViewport(targetX, targetY);
      setSelectedIds([note.id]);
      bringToFront(note.id);
    }, 10);
  };

  // Keyboard Navigation
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
    <div className="fixed inset-0 z-[9999] flex items-start justify-center pt-[15vh]">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/20 backdrop-blur-sm transition-opacity"
        onClick={() => setSpotlightOpen(false)}
      />

      {/* Container - Atmospheric Glass */}
      <div className="relative w-full max-w-2xl flex flex-col overflow-hidden rounded-2xl bg-white/80 backdrop-blur-2xl shadow-2xl ring-1 ring-white/20 animate-in fade-in zoom-in-95 duration-200">
        
        {/* Input Area */}
        <div className="flex items-center px-4 border-b border-gray-200/50">
          <Search className="w-5 h-5 text-gray-400 mr-3" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            className="flex-1 h-14 bg-transparent border-none outline-none text-lg text-gray-800 placeholder:text-gray-400"
            placeholder="搜索便签..."
          />
          <div className="text-xs text-gray-400 font-medium px-2 py-1 bg-gray-100/50 rounded border border-gray-200/50">
            ESC
          </div>
        </div>

        {/* Results List */}
        <div className="max-h-[60vh] overflow-y-auto py-2">
          {results.length > 0 ? (
            results.map((note, index) => (
              <div
                key={note.id}
                onClick={() => handleSelect(note)}
                onMouseEnter={() => setSelectedIndex(index)}
                className={cn(
                  "mx-2 px-4 py-3 rounded-xl cursor-pointer transition-all duration-100 flex items-center justify-between group",
                  index === selectedIndex ? "bg-indigo-50/80 shadow-sm translate-x-1" : "hover:bg-gray-50/50"
                )}
              >
                <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                  {/* Title */}
                  <div className={cn(
                    "text-sm font-medium truncate flex items-center gap-2",
                    index === selectedIndex ? "text-indigo-700" : "text-gray-700"
                  )}>
                    {index === selectedIndex && (
                      <div className="w-1 h-3 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.5)]" />
                    )}
                    {typeof note.title === 'string' && note.title ? note.title : <span className="italic opacity-50">无标题</span>}
                  </div>
                  
                  {/* Content Snippet */}
                  <div className="text-xs text-gray-400 truncate max-w-[500px] pl-3">
                    {typeof note.content === 'string' && note.content ? note.content : <span className="italic opacity-30">无内容</span>}
                  </div>
                </div>

                {/* Board Info Badge (if different board) */}
                {note.boardId !== currentBoardId && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-400 border border-gray-200 mr-2">
                    {boards.find(b => b.id === note.boardId)?.name || "其他看板"}
                  </span>
                )}

                {/* Enter Hint */}
                {index === selectedIndex && (
                  <CornerDownLeft className="w-4 h-4 text-indigo-400 opacity-50" />
                )}
              </div>
            ))
          ) : query ? (
            <div className="py-12 text-center text-gray-400 text-sm">
              未找到与 "{query}" 相关的便签
            </div>
          ) : (
            <div className="py-12 text-center text-gray-400 text-sm">
              输入关键词以搜索...
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 bg-gray-50/50 border-t border-gray-200/50 flex items-center justify-between text-[10px] text-gray-400">
          <div className="flex gap-4">
            <span>↑↓ 选择</span>
            <span>↵ 跳转</span>
          </div>
          <div>
            {results.length} 个结果
          </div>
        </div>
      </div>
    </div>
  );
}