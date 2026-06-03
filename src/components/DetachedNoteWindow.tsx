import React, { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { Crosshair, Pin, X } from "lucide-react";
import { NoteVisuals } from "./note-render/NoteVisuals";
import type { DetachedNoteSnapshot, DetachedNoteMissingPayload } from "../types/detachedNoteSnapshot";
import { DETACHED_NOTE_EVENTS } from "../types/detachedNoteSnapshot";
import { cn } from "../utils/cn";
import { LAYOUT } from "../constants/layout";

const DETACHED_MAX_HEIGHT_RATIO = 0.7;
const DETACHED_MAX_HEIGHT_FALLBACK = 520;

function computeMaxHeight(): number {
  const screen = typeof window !== "undefined" ? window.screen : undefined;
  const availHeight = screen?.availHeight;
  if (typeof availHeight === "number" && availHeight > 0) {
    return Math.min(Math.round(availHeight * DETACHED_MAX_HEIGHT_RATIO), DETACHED_MAX_HEIGHT_FALLBACK);
  }
  return DETACHED_MAX_HEIGHT_FALLBACK;
}

function useLocalDarkMode(): boolean {
  const [isDark, setIsDark] = useState(() => {
    const savedTheme = localStorage.getItem("theme");
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (savedTheme === "dark") return true;
    if (!savedTheme || savedTheme === "system") return systemDark;
    return false;
  });

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      const savedTheme = localStorage.getItem("theme");
      if (!savedTheme || savedTheme === "system") {
        setIsDark(e.matches);
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return isDark;
}

export const DetachedNoteWindow: React.FC<{ noteId: string }> = ({ noteId }) => {
  const isDark = useLocalDarkMode();
  const [snapshot, setSnapshot] = useState<DetachedNoteSnapshot | null>(null);
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(false);
  const hasShownRef = useRef(false);
  const noteRef = useRef<HTMLElement>(null);
  const lastSentSizeRef = useRef({ width: 0, height: 0 });
  const rafRef = useRef(0);
  const isCappedRef = useRef(false);
  const [isHeightCapped, setIsHeightCapped] = useState(false);
  const maxHeightRef = useRef(computeMaxHeight());

  const resizeWindowToNote = useCallback((entry?: ResizeObserverEntry) => {
    const el = noteRef.current;
    if (!el) return;

    const maxHeight = maxHeightRef.current;
    const borderBox = entry?.borderBoxSize?.[0];
    const measuredHeight = Math.round(
      borderBox ? borderBox.blockSize : el.getBoundingClientRect().height,
    );
    const naturalHeight = Math.max(Math.round(el.scrollHeight), measuredHeight);
    if (naturalHeight <= 0) return;

    const capped = naturalHeight > maxHeight;
    const targetHeight = capped ? maxHeight : naturalHeight;
    const targetWidth = LAYOUT.NOTE_WIDTH;

    if (capped !== isCappedRef.current) {
      isCappedRef.current = capped;
      setIsHeightCapped(capped);
    }

    if (lastSentSizeRef.current.width === targetWidth && lastSentSizeRef.current.height === targetHeight) {
      return;
    }
    lastSentSizeRef.current = { width: targetWidth, height: targetHeight };

    getCurrentWindow()
      .setSize(new LogicalSize(targetWidth, targetHeight))
      .catch(() => undefined);
  }, []);

  /** 幂等显示窗口：确保只调用一次 show_detached_note_window */
  const showWindowOnce = useCallback(() => {
    if (hasShownRef.current) return;
    hasShownRef.current = true;
    invoke('show_detached_note_window', { noteId }).catch((err) => {
      console.warn('显示撕下窗口失败:', err);
      // 调用失败时重置标记，允许后续重试
      hasShownRef.current = false;
    });
  }, [noteId]);

  useEffect(() => {
    showWindowOnce();
  }, [showWindowOnce]);

  useEffect(() => {
    const unlistenSnapshot = listen<DetachedNoteSnapshot>(
      DETACHED_NOTE_EVENTS.SNAPSHOT,
      (event) => {
        if (event.payload.noteId === noteId) {
          setSnapshot(event.payload);
          showWindowOnce();
        }
      },
    );

    const unlistenMissing = listen<DetachedNoteMissingPayload>(
      DETACHED_NOTE_EVENTS.MISSING,
      (event) => {
        if (event.payload.noteId === noteId) {
          window.close();
        }
      },
    );

    return () => {
      unlistenSnapshot.then((f) => f());
      unlistenMissing.then((f) => f());
    };
  }, [noteId, showWindowOnce]);

  useEffect(() => {
    const el = noteRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
      rafRef.current = requestAnimationFrame(() => {
        resizeWindowToNote(entries[0]);
      });
    });

    observer.observe(el);
    return () => {
      observer.disconnect();
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [!!snapshot, resizeWindowToNote]);

  useEffect(() => {
    if (!snapshot) return;
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = requestAnimationFrame(() => {
      resizeWindowToNote();
    });
  }, [snapshot, resizeWindowToNote]);

  const handleLocate = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      emit(DETACHED_NOTE_EVENTS.LOCATE, { noteId }).catch(() => undefined);
    },
    [noteId],
  );

  const handlePin = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const nextValue = !isAlwaysOnTop;
      invoke<boolean>('set_detached_note_always_on_top', {
        noteId,
        alwaysOnTop: nextValue,
      })
        .then((result) => {
          setIsAlwaysOnTop(result);
        })
        .catch(() => undefined);
    },
    [noteId, isAlwaysOnTop],
  );

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      invoke('close_detached_note_window', { noteId }).catch(() => undefined);
    },
    [noteId],
  );

  const stopContextMenu = (e: React.SyntheticEvent) => {
    e.stopPropagation();
  };

  const handleDragStart = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (e.button !== 0) return;

    const target = e.target;
    if (target instanceof Element && target.closest('[data-detached-note-control="true"]')) {
      return;
    }

    getCurrentWindow().startDragging().catch(() => undefined);
  }, []);

  if (!snapshot) {
    return (
      <div className="h-screen w-screen bg-transparent" />
    );
  }

  return (
    <div className="h-screen w-screen bg-transparent" onContextMenu={stopContextMenu}>
      <div
        className={cn(
          "pointer-events-auto",
        )}
        data-tauri-drag-region
        onMouseDown={handleDragStart}
      >
        <NoteVisuals
          ref={noteRef}
          title={snapshot.title}
          content={snapshot.content}
          color={snapshot.color}
          isCollapsed={snapshot.isCollapsed}
          isDark={isDark}
          className={cn(
            "shadow-xl group/detached-note",
            isHeightCapped && "overflow-hidden",
          )}
          style={isHeightCapped ? { height: maxHeightRef.current, maxHeight: maxHeightRef.current } : undefined}
          surfaceOverlay={
            <div
              data-detached-note-control="true"
              className="absolute right-2 top-1.5 z-20 flex items-center gap-0.5 opacity-0 pointer-events-none transition-opacity duration-200 group-hover/detached-note:pointer-events-auto group-hover/detached-note:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                aria-label="定位到画布所在"
                className="flex h-6 w-6 items-center justify-center rounded bg-transparent text-text-tertiary transition-colors hover:bg-black/5 hover:text-text-secondary dark:hover:bg-white/10"
                onClick={handleLocate}
              >
                <Crosshair size={14} />
              </button>
              <button
                type="button"
                aria-label={isAlwaysOnTop ? '取消置顶' : '置顶'}
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded bg-transparent transition-colors hover:bg-black/5 dark:hover:bg-white/10',
                  isAlwaysOnTop ? 'text-accent' : 'text-text-tertiary hover:text-text-secondary',
                )}
                onClick={handlePin}
              >
                <Pin size={14} />
              </button>
              <button
                type="button"
                aria-label="贴回画布"
                className="flex h-6 w-6 items-center justify-center rounded bg-transparent text-text-tertiary transition-colors hover:bg-black/5 hover:text-text-secondary dark:hover:bg-white/10"
                onClick={handleClose}
              >
                <X size={14} />
              </button>
            </div>
          }
        >
          {!snapshot.isCollapsed && (
            <>
              <div
                data-note-title-region="true"
                className={cn("px-4 pt-3 pb-1", "min-h-9 pr-24")}
              >
                <div
                  className={cn(
                    "w-full truncate",
                    "text-text-primary font-bold text-[16px]",
                    snapshot.title ? "block" : "hidden",
                  )}
                >
                  {snapshot.title}
                </div>
              </div>
              <div
                data-note-content-region="true"
                className={cn(
                  "flex-1 pb-4 pt-0 min-h-0",
                  isHeightCapped && "overflow-y-auto scrollbar-thin scrollbar-thumb-text-tertiary/20 scrollbar-track-transparent hover:scrollbar-thumb-text-secondary/20",
                )}
              >
                <div
                  className={cn(
                    "w-full px-4",
                    "text-text-secondary dark:text-text-primary",
                    "font-normal text-[15px] leading-relaxed",
                  )}
                >
                  {snapshot.content || <span className="text-text-tertiary">记点什么…</span>}
                </div>
              </div>
            </>
          )}
        </NoteVisuals>
      </div>
    </div>
  );
};
