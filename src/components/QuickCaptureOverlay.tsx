import React, { useCallback, useEffect, useRef, useState } from 'react';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { useStore } from '../store/useStore';
import { useUIStore, useViewportStore } from '../store';
import { Z_INDEX } from '../constants/layout';
import { createSmartPasteNoteInputs } from '../utils/smartPaste';
import { getViewportSpawnOrigin } from '../utils/spawnPosition';

const getCaptureOrigin = () => {
  const { viewport } = useViewportStore.getState();
  return getViewportSpawnOrigin(viewport);
};

/**
 * 快速捕获 header 看板 label 解析（C16 / C26）。
 * 必须与本组件同文件；禁止抽到 src/utils/**。
 * null / undefined / '' / 仅空白 →「当前看板」；非空名原样返回（含禁用词子串、emoji）。
 */
function resolveQuickCaptureBoardLabel(name: string | null | undefined): string {
  if (name == null || name.trim() === '') return '当前看板';
  return name;
}

const DIALOG_FOCUSABLE_SELECTOR = 'textarea, button:not([disabled])';

export const QuickCaptureOverlay: React.FC = () => {
  const isOpen = useUIStore((state) => state.isQuickCaptureOpen);
  const setQuickCaptureOpen = useUIStore((state) => state.setQuickCaptureOpen);
  const addNotesWithContentBatch = useStore((state) => state.addNotesWithContentBatch);
  const boards = useStore((state) => state.boards);
  const currentBoardId = useStore((state) => state.currentBoardId);
  const currentBoardName = resolveQuickCaptureBoardLabel(
    boards.find((b) => b.id === currentBoardId)?.name,
  );
  const [value, setValue] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  // 关闭时在渲染期清空输入/错误态，避免 effect 同步 setState（react-hooks/set-state-in-effect）
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    if (!isOpen) {
      setValue('');
      setSubmitError(null);
    }
  }
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;

    requestAnimationFrame(() => {
      if (cancelled) return;
      inputRef.current?.focus();

      readText()
        .then((text) => {
          if (cancelled || !text?.trim()) return;
          setValue(text);
          requestAnimationFrame(() => {
            if (!cancelled && inputRef.current) {
              inputRef.current.select();
            }
          });
        })
        .catch(() => {});
    });

    return () => {
      cancelled = true;
    };
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

  const submit = useCallback(() => {
    const origin = getCaptureOrigin();
    const notes = createSmartPasteNoteInputs(value, origin.x, origin.y);
    if (notes.length === 0) return;

    try {
      addNotesWithContentBatch(notes);
      setValue('');
      setSubmitError(null);
      setQuickCaptureOpen(false);
    } catch {
      // C24：失败保留草稿与浮层，展示固定可感知错误
      setSubmitError('创建失败，输入已保留');
    }
  }, [value, addNotesWithContentBatch, setQuickCaptureOpen]);

  const trapDialogFocus = (event: React.KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== 'Tab') return;

    const focusable = Array.from(
      formRef.current?.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR) ?? [],
    );
    if (focusable.length === 0) return;

    event.preventDefault();
    const activeIndex = focusable.findIndex((element) => element === document.activeElement);
    const currentIndex = activeIndex >= 0 ? activeIndex : 0;
    const offset = event.shiftKey ? -1 : 1;
    const nextIndex = (currentIndex + offset + focusable.length) % focusable.length;
    focusable[nextIndex]?.focus();
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
        ref={formRef}
        className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-border-subtle bg-secondary-bg/95 shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onKeyDown={trapDialogFocus}
      >
        <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3 text-sm font-medium text-text-secondary">
          <span>快速捕获</span>
          <span className="truncate text-xs text-text-tertiary">· {currentBoardName}</span>
        </div>
        <textarea
          ref={inputRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              if (event.nativeEvent.isComposing) {
                event.stopPropagation();
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              setQuickCaptureOpen(false);
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
        {submitError ? (
          <div role="alert" className="border-t border-border-subtle px-4 py-2 text-xs text-red-500">
            {submitError}
          </div>
        ) : null}
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
