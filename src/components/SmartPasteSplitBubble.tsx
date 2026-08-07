import React, { useEffect, useMemo, useRef } from 'react';
import { LAYOUT, Z_INDEX } from '../constants/layout';
import { useStore } from '../store/useStore';
import { useUIStore } from '../store';
import { useViewportStore } from '../store/viewportStore';
import { cn } from '../utils/cn';
import type { SmartPasteOption } from '../utils/smartPaste';

const BUBBLE_WIDTH = 224;
const BUBBLE_GAP = 12;
const VIEWPORT_PADDING = 12;

const getSplitOptionPreview = (option: SmartPasteOption) => {
  const preview = option.contents.slice(0, 2).join(' / ');
  return preview.length > 34 ? `${preview.slice(0, 34)}…` : preview;
};

export const SmartPasteSplitBubble: React.FC = () => {
  const viewMode = useUIStore((state) => state.viewMode);
  const panel = useUIStore((state) => state.smartPasteSplitPanel);
  const note = useStore((state) => panel ? state.notesById[panel.noteId] : undefined);
  const viewport = useViewportStore((state) => state.viewport);
  const shellRect = useViewportStore((state) => state.shellRect);
  const closeSmartPasteSplitPanel = useStore((state) => state.closeSmartPasteSplitPanel);
  const applySmartPasteSplit = useStore((state) => state.applySmartPasteSplit);
  const bubbleRef = useRef<HTMLDivElement>(null);

  const splitOptions = useMemo(
    () => panel?.result.options.filter((option) => option.id !== 'keep') ?? [],
    [panel],
  );

  useEffect(() => {
    if (!panel) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && bubbleRef.current?.contains(target)) {
        return;
      }
      closeSmartPasteSplitPanel();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSmartPasteSplitPanel();
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeSmartPasteSplitPanel, panel]);

  if (viewMode === 'TRASH' || !panel || !note || splitOptions.length === 0) {
    return null;
  }

  const noteScreenLeft = shellRect.left + note.x - viewport.x;
  const noteScreenTop = shellRect.top + note.y - viewport.y;
  const rightCandidate = noteScreenLeft + LAYOUT.NOTE_WIDTH + BUBBLE_GAP;
  const leftCandidate = noteScreenLeft - BUBBLE_WIDTH - BUBBLE_GAP;
  const maxLeft = shellRect.right - BUBBLE_WIDTH - VIEWPORT_PADDING;
  const left = rightCandidate <= maxLeft
    ? rightCandidate
    : Math.max(shellRect.left + VIEWPORT_PADDING, leftCandidate);
  const top = Math.min(
    Math.max(shellRect.top + VIEWPORT_PADDING, noteScreenTop + 4),
    shellRect.bottom - 160,
  );

  return (
    <div
      ref={bubbleRef}
      role="dialog"
      aria-label="智能粘贴拆分选项"
      className="fixed w-56 rounded-2xl border border-border-subtle bg-secondary-bg/95 p-2.5 text-text-primary shadow-[0_18px_42px_rgba(15,23,42,0.18)] backdrop-blur-md dark:shadow-[0_18px_44px_rgba(0,0,0,0.42)]"
      style={{ left, top, zIndex: Z_INDEX.SMART_PASTE }}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="px-2 pb-2">
        <div className="text-xs font-semibold text-text-primary">粘贴为多段内容</div>
        <div className="mt-0.5 text-[11px] leading-4 text-text-tertiary">已先保留为一张，可选择拆分。</div>
      </div>

      <div className="space-y-1">
        <button
          type="button"
          className="w-full rounded-xl px-2.5 py-2 text-left text-xs text-text-secondary transition-colors hover:bg-secondary-bg/70 hover:text-text-primary dark:hover:bg-white/5"
          onClick={closeSmartPasteSplitPanel}
        >
          保留一张
        </button>

        {splitOptions.map((option) => (
          <button
            key={option.id}
            type="button"
            className={cn(
              'w-full rounded-xl px-2.5 py-2 text-left transition-colors',
              'bg-blue-500/8 text-text-primary hover:bg-blue-500/14 dark:bg-blue-300/10 dark:hover:bg-blue-300/15',
            )}
            onClick={() => applySmartPasteSplit(option.id)}
          >
            <span className="block text-xs font-medium">{option.label}</span>
            <span className="mt-0.5 block text-[11px] leading-4 text-text-tertiary">
              生成 {option.contents.length} 张 · {getSplitOptionPreview(option)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};
