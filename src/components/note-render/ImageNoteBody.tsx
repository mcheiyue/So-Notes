import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ImageIcon, RefreshCw } from "lucide-react";
import type { AttachmentRef } from "../../store/types";
import { resolveAttachmentPath } from "../../services/storage/attachmentPersistence";
import { cn } from "../../utils/cn";
import { Z_INDEX } from "../../constants/layout";

type ImageBodyState =
  | { status: "loading" }
  | { status: "ready"; assetUrl: string }
  | { status: "missing" };

interface ImageNoteBodyProps {
  attachment?: AttachmentRef;
  alt: string;
  isFocused?: boolean;
}

export const ImageNoteBody: React.FC<ImageNoteBodyProps> = ({ attachment, alt, isFocused = false }) => {
  const [state, setState] = useState<ImageBodyState>({ status: "loading" });
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const pointerDownStartedFocusedRef = useRef<boolean | null>(null);

  useEffect(() => {
    let disposed = false;

    const load = async () => {
      if (!attachment) {
        setState({ status: "missing" });
        return;
      }

      setState({ status: "loading" });
      try {
        const absPath = await resolveAttachmentPath(attachment.relativePath);
        if (!disposed) {
          setState({ status: "ready", assetUrl: convertFileSrc(absPath) });
        }
      } catch {
        if (!disposed) {
          setState({ status: "missing" });
        }
      }
    };

    load();
    return () => {
      disposed = true;
    };
  }, [attachment]);

  useEffect(() => {
    if (!isPreviewOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsPreviewOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPreviewOpen]);

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-3 pb-3">
      {state.status === "loading" && (
        <div className="flex h-full min-h-40 w-full items-center justify-center rounded-lg bg-black/5 dark:bg-white/5">
          <RefreshCw className="h-6 w-6 animate-spin text-text-tertiary" />
        </div>
      )}

      {state.status === "ready" && (
        <>
          <button
            type="button"
            data-testid="image-note-preview-trigger"
            className={cn(
              "h-full min-h-40 w-full overflow-hidden rounded-xl border border-border-subtle bg-black/5 text-left shadow-sm dark:bg-white/5",
              isFocused ? "cursor-zoom-in" : "cursor-default",
            )}
            onPointerDown={() => {
              pointerDownStartedFocusedRef.current = isFocused;
            }}
            onClick={(event) => {
              event.stopPropagation();
              const pointerDownStartedFocused = pointerDownStartedFocusedRef.current ?? isFocused;
              pointerDownStartedFocusedRef.current = null;
              if (!isFocused || !pointerDownStartedFocused) return;
              setIsPreviewOpen(true);
            }}
            aria-label={`查看图片 ${alt}`}
          >
            <img
              src={state.assetUrl}
              alt={alt}
              className={cn(
                "h-full min-h-40 w-full object-contain",
                "bg-black/5 dark:bg-white/5",
              )}
              loading="lazy"
            />
          </button>

          {isPreviewOpen &&
            createPortal(
              <button
                type="button"
                data-testid="image-note-preview-overlay"
                className="fixed inset-2 flex cursor-zoom-out items-center justify-center rounded-2xl bg-black/65 p-6 backdrop-blur-sm"
                style={{ zIndex: Z_INDEX.SPOTLIGHT }}
                onClick={(event) => {
                  event.stopPropagation();
                  setIsPreviewOpen(false);
                }}
                aria-label="关闭图片预览"
              >
                <img
                  src={state.assetUrl}
                  alt={alt}
                  className="block max-h-[85vh] max-w-[85vw] rounded-xl border border-white/15 object-contain shadow-2xl"
                />
              </button>,
              document.body,
            )}
        </>
      )}

      {state.status === "missing" && (
        <div className="flex h-full min-h-40 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-text-tertiary/30 bg-black/5 text-text-tertiary dark:bg-white/5">
          <ImageIcon className="h-7 w-7 opacity-60" />
          <span className="text-xs">图片不可用</span>
        </div>
      )}
    </div>
  );
};
