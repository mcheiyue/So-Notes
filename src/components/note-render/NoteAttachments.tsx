import React, { useCallback, useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { X, RefreshCw, ImageIcon } from "lucide-react";
import type { AttachmentRef } from "../../store/types";
import { resolveAttachmentPath } from "../../services/storage/attachmentPersistence";
import { useStore } from "../../store/useStore";
import { cn } from "../../utils/cn";

/**
 * 允许预览的图片 MIME 类型白名单。
 * SVG 不在第一版预览范围内（安全与平台解析差异风险）。
 */
const PREVIEWABLE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** 单个附件的运行时预览状态 */
type AttachmentPreviewState =
  | { status: "loading" }
  | { status: "ready"; assetUrl: string }
  | { status: "missing" };

interface NoteAttachmentsProps {
  noteId: string;
  attachments: AttachmentRef[];
  readOnly?: boolean;
}

/**
 * 过滤出可预览的图片附件。
 * 仅允许 PNG / JPEG / GIF / WebP；SVG 与非图片类型不预览。
 */
function filterPreviewable(attachments: AttachmentRef[]): AttachmentRef[] {
  return attachments.filter((ref) => PREVIEWABLE_MIME_TYPES.has(ref.mimeType));
}

/**
 * 将单个附件的 relativePath 解析为运行时 asset URL。
 * 失败时返回可区分的错误状态。
 */
async function resolveAssetUrl(
  relativePath: string,
): Promise<{ ok: true; url: string } | { ok: false }> {
  try {
    const absPath = await resolveAttachmentPath(relativePath);
    const url = convertFileSrc(absPath);
    return { ok: true, url };
  } catch {
    return { ok: false };
  }
}

/**
 * 便签附件预览网格。
 *
 * - 过滤可预览图片类型（PNG/JPEG/GIF/WebP，不含 SVG）。
 * - 通过 resolveAttachmentPath + convertFileSrc 生成运行时 asset URL。
 * - 仅在组件本地 state 中维护 asset URL，不写入 store / data.json。
 * - 缺失附件显示占位提示与手动重试按钮。
 * - 非只读模式下提供移除引用按钮（调用 removeAttachmentFromNote）。
 * - 窗口重获焦点时对已失败项做一次轻量重试。
 */
export const NoteAttachments: React.FC<NoteAttachmentsProps> = ({
  noteId,
  attachments,
  readOnly = false,
}) => {
  const removeAttachmentFromNote = useStore(
    (state) => state.removeAttachmentFromNote,
  );

  const previewable = useMemo(
    () => filterPreviewable(attachments),
    [attachments],
  );

  const [previewStates, setPreviewStates] = useState<
    Record<string, AttachmentPreviewState>
  >({});
  const [activePreview, setActivePreview] = useState<{
    filename: string;
    assetUrl: string;
  } | null>(null);

  useEffect(() => {
    if (!activePreview) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActivePreview(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activePreview]);

  const loadSingle = useCallback(
    async (id: string, relativePath: string) => {
      const result = await resolveAssetUrl(relativePath);
      setPreviewStates((prev) => ({
        ...prev,
        [id]: result.ok
          ? { status: "ready", assetUrl: result.url }
          : { status: "missing" },
      }));
    },
    [],
  );

  // 初始化加载所有预览
  useEffect(() => {
    let disposed = false;

    const loadAll = async () => {
      const entries: Array<[string, AttachmentPreviewState]> = [];
      for (const ref of previewable) {
        const result = await resolveAssetUrl(ref.relativePath);
        if (disposed) return;
        entries.push([
          ref.id,
          result.ok
            ? { status: "ready", assetUrl: result.url }
            : { status: "missing" },
        ]);
      }
      if (!disposed) {
        setPreviewStates(Object.fromEntries(entries));
      }
    };

    loadAll();
    return () => {
      disposed = true;
    };
  }, [previewable]);

  // 窗口重获焦点时，对当前已失败项做一次轻量重试
  useEffect(() => {
    const handleFocus = () => {
      setPreviewStates((prev) => {
        for (const [id, state] of Object.entries(prev)) {
          if (state.status === "missing") {
            const ref = previewable.find((r) => r.id === id);
            if (ref) {
              loadSingle(id, ref.relativePath);
            }
          }
        }
        return prev;
      });
    };

    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [previewable, loadSingle]);

  const handleRetry = useCallback(
    (attachmentId: string) => {
      const ref = previewable.find((r) => r.id === attachmentId);
      if (!ref) return;
      setPreviewStates((prev) => ({
        ...prev,
        [attachmentId]: { status: "loading" },
      }));
      loadSingle(attachmentId, ref.relativePath);
    },
    [previewable, loadSingle],
  );

  const handleRemove = useCallback(
    (attachmentId: string) => {
      removeAttachmentFromNote(noteId, attachmentId);
    },
    [noteId, removeAttachmentFromNote],
  );

  if (previewable.length === 0) return null;

  return (
    <div
      data-testid="note-attachments"
      className="flex max-w-full flex-wrap gap-2 overflow-hidden px-4 pb-2"
    >
      {previewable.map((ref) => {
        const state = previewStates[ref.id] ?? { status: "loading" };
        return (
          <AttachmentPreviewItem
            key={ref.id}
            attachment={ref}
            state={state}
            readOnly={readOnly}
            onOpenPreview={setActivePreview}
            onRetry={handleRetry}
            onRemove={handleRemove}
          />
        );
      })}
      {activePreview && (
        <button
          type="button"
          data-testid="attachment-preview-overlay"
          className={cn(
            "fixed inset-0 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm",
            "cursor-zoom-out",
          )}
          style={{ zIndex: 9999 }}
          onClick={(event) => {
            event.stopPropagation();
            setActivePreview(null);
          }}
          aria-label="关闭图片预览"
        >
          <img
            src={activePreview.assetUrl}
            alt={activePreview.filename}
            className="max-h-full max-w-full rounded-xl border border-white/20 object-contain shadow-2xl"
          />
        </button>
      )}
    </div>
  );
};

/** 单个附件预览项 */
const AttachmentPreviewItem: React.FC<{
  attachment: AttachmentRef;
  state: AttachmentPreviewState;
  readOnly: boolean;
  onOpenPreview: (preview: { filename: string; assetUrl: string }) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
}> = ({ attachment, state, readOnly, onOpenPreview, onRetry, onRemove }) => {
  return (
    <div
      data-testid={`attachment-item-${attachment.id}`}
      className="group/att relative flex-shrink-0"
    >
      {state.status === "loading" && (
        <div
          className={cn(
            "flex items-center justify-center rounded-lg bg-black/5 dark:bg-white/5",
            "w-20 h-20",
          )}
          aria-label="加载中"
        >
          <RefreshCw className="w-5 h-5 text-text-tertiary animate-spin" />
        </div>
      )}

      {state.status === "ready" && (
        <div className="relative max-w-full">
          <button
            type="button"
            data-testid={`attachment-preview-${attachment.id}`}
            className="block max-w-full cursor-zoom-in rounded-lg text-left"
            onClick={(event) => {
              event.stopPropagation();
              onOpenPreview({ filename: attachment.filename, assetUrl: state.assetUrl });
            }}
            aria-label={`查看附件 ${attachment.filename}`}
          >
            <img
              src={state.assetUrl}
              alt={attachment.filename}
              className={cn(
                "w-20 h-20 max-w-full object-cover rounded-lg",
                "border border-border-subtle",
              )}
              loading="lazy"
              onError={() => onRetry(attachment.id)}
            />
          </button>
          {!readOnly && (
            <RemoveAttachmentButton
              attachmentId={attachment.id}
              onRemove={onRemove}
            />
          )}
        </div>
      )}

      {state.status === "missing" && (
        <div className="relative">
          <div
            className={cn(
              "flex flex-col items-center justify-center gap-1 rounded-lg",
              "w-20 h-20 bg-black/5 dark:bg-white/5",
              "border border-dashed border-text-tertiary/30",
            )}
            aria-label="附件缺失"
          >
            <ImageIcon className="w-5 h-5 text-text-tertiary/50" />
            <button
              type="button"
              data-testid={`attachment-retry-${attachment.id}`}
              className="text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                onRetry(attachment.id);
              }}
              aria-label="重试加载附件"
            >
              重试
            </button>
          </div>
          {!readOnly && (
            <RemoveAttachmentButton
              attachmentId={attachment.id}
              onRemove={onRemove}
            />
          )}
        </div>
      )}
    </div>
  );
};

const RemoveAttachmentButton: React.FC<{
  attachmentId: string;
  onRemove: (id: string) => void;
}> = ({ attachmentId, onRemove }) => {
  return (
    <button
      type="button"
      data-testid={`attachment-remove-${attachmentId}`}
      className={cn(
        "absolute -top-1.5 -right-1.5 z-10",
        "flex h-5 w-5 items-center justify-center rounded-full",
        "bg-red-500 text-white shadow-sm",
        "opacity-0 group-hover/att:opacity-100 transition-opacity duration-150",
        "hover:bg-red-600",
      )}
      onClick={(e) => {
        e.stopPropagation();
        onRemove(attachmentId);
      }}
      aria-label="移除附件引用"
    >
      <X className="w-3 h-3" />
    </button>
  );
};
