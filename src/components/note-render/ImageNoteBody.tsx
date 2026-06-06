import React, { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ImageIcon, RefreshCw } from "lucide-react";
import type { AttachmentRef } from "../../store/types";
import { resolveAttachmentPath } from "../../services/storage/attachmentPersistence";
import { cn } from "../../utils/cn";

type ImageBodyState =
  | { status: "loading" }
  | { status: "ready"; assetUrl: string }
  | { status: "missing" };

interface ImageNoteBodyProps {
  attachment?: AttachmentRef;
  alt: string;
}

export const ImageNoteBody: React.FC<ImageNoteBodyProps> = ({ attachment, alt }) => {
  const [state, setState] = useState<ImageBodyState>({ status: "loading" });

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

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-3 pb-3">
      {state.status === "loading" && (
        <div className="flex h-full min-h-40 w-full items-center justify-center rounded-lg bg-black/5 dark:bg-white/5">
          <RefreshCw className="h-6 w-6 animate-spin text-text-tertiary" />
        </div>
      )}

      {state.status === "ready" && (
        <img
          src={state.assetUrl}
          alt={alt}
          className={cn(
            "h-full min-h-40 w-full rounded-lg border border-border-subtle object-contain",
            "bg-black/5 dark:bg-white/5",
          )}
          loading="lazy"
        />
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
