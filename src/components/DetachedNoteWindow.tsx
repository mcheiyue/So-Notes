import React, { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Crosshair, Pin, X } from "lucide-react";
import { NoteVisuals } from "./note-render/NoteVisuals";
import type { DetachedNoteSnapshot, DetachedNoteMissingPayload } from "../types/detachedNoteSnapshot";
import { DETACHED_NOTE_EVENTS } from "../types/detachedNoteSnapshot";

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

  useEffect(() => {
    const unlistenSnapshot = listen<DetachedNoteSnapshot>(
      DETACHED_NOTE_EVENTS.SNAPSHOT,
      (event) => {
        if (event.payload.noteId === noteId) {
          setSnapshot(event.payload);
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
  }, [noteId]);

  const stopContextMenu = (e: React.SyntheticEvent) => {
    e.stopPropagation();
  };

  if (!snapshot) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-primary-bg">
        <span className="text-sm text-text-tertiary">加载中…</span>
      </div>
    );
  }

  return (
    <div
      className="flex h-screen w-screen items-center justify-center bg-primary-bg overflow-auto p-4"
      onContextMenu={stopContextMenu}
    >
      <div className="pointer-events-auto">
        <NoteVisuals
          title={snapshot.title}
          content={snapshot.content}
          color={snapshot.color}
          isCollapsed={snapshot.isCollapsed}
          isDark={isDark}
          className="shadow-xl group/detached-note"
          surfaceOverlay={
            <div
              className="absolute right-2 top-1.5 z-20 flex items-center gap-0.5 opacity-0 pointer-events-none transition-opacity duration-200 group-hover/detached-note:pointer-events-auto group-hover/detached-note:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100"
            >
              <button
                type="button"
                aria-label="定位到画布所在"
                className="flex h-6 w-6 items-center justify-center rounded bg-transparent text-text-tertiary transition-colors hover:bg-black/5 hover:text-text-secondary dark:hover:bg-white/10"
              >
                <Crosshair size={14} />
              </button>
              <button
                type="button"
                aria-label="置顶"
                className="flex h-6 w-6 items-center justify-center rounded bg-transparent text-text-tertiary transition-colors hover:bg-black/5 hover:text-text-secondary dark:hover:bg-white/10"
              >
                <Pin size={14} />
              </button>
              <button
                type="button"
                aria-label="贴回画布"
                className="flex h-6 w-6 items-center justify-center rounded bg-transparent text-text-tertiary transition-colors hover:bg-black/5 hover:text-text-secondary dark:hover:bg-white/10"
              >
                <X size={14} />
              </button>
            </div>
          }
        />
      </div>
    </div>
  );
};
