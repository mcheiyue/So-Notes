import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { useUIStore, useViewportStore } from '../store';
import { Z_INDEX } from '../constants/layout';
import { createSmartPasteNoteInputs } from '../utils/smartPaste';
import { getViewportSpawnOrigin } from '../utils/spawnPosition';

const getCaptureOrigin = () => {
  const { viewport } = useViewportStore.getState();
  return getViewportSpawnOrigin(viewport);
};

export const QuickCaptureOverlay: React.FC = () => {
  const isOpen = useUIStore((state) => state.isQuickCaptureOpen);
  const setQuickCaptureOpen = useUIStore((state) => state.setQuickCaptureOpen);
  const addNotesWithContentBatch = useStore((state) => state.addNotesWithContentBatch);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        setQuickCaptureOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, setQuickCaptureOpen]);

  const submit = () => {
    const origin = getCaptureOrigin();
    const notes = createSmartPasteNoteInputs(value, origin.x, origin.y);
    if (notes.length === 0) return;

    addNotesWithContentBatch(notes);
    setValue('');
    setQuickCaptureOpen(false);
  };

  if (!isOpen) return null;

  return (
    <div
      className="pointer-events-auto absolute inset-0 flex items-start justify-center bg-black/20 px-4 pt-[18vh] backdrop-blur-sm"
      style={{ zIndex: Z_INDEX.QUICK_CAPTURE }}
      role="dialog"
      aria-modal="true"
      aria-label="快速捕获"
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label="关闭快速捕获"
        onClick={() => setQuickCaptureOpen(false)}
      />

      <form
        className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-border-subtle bg-secondary-bg/95 shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="border-b border-border-subtle px-4 py-3 text-sm font-medium text-text-secondary">
          快速捕获
        </div>
        <textarea
          ref={inputRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              return;
            }

            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          className="h-40 w-full resize-none bg-transparent px-4 py-3 text-sm text-text-primary outline-none placeholder:text-text-tertiary"
          placeholder="输入内容后按 Enter 创建便签，Shift+Enter 换行"
        />
        <div className="flex items-center justify-between border-t border-border-subtle px-4 py-3 text-xs text-text-tertiary">
          <span>多行内容会保留在同一张便签里</span>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md px-3 py-1.5 text-text-secondary hover:bg-primary-bg"
              onClick={() => setQuickCaptureOpen(false)}
            >
              取消
            </button>
            <button
              type="submit"
              className="rounded-md bg-blue-500 px-3 py-1.5 text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-blue-500"
              disabled={value.trim().length === 0}
            >
              创建
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};
