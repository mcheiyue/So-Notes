import React from "react";
import { getNoteColor, getNoteDarkSpectrum } from "../../store/types";
import { LAYOUT } from "../../constants/layout";
import { cn } from "../../utils/cn";
import {
  buildNoteSurfaceBackground,
  getDarkBorderColor,
  buildNoteMaterialShadow,
} from "./noteVisualStyles";

export interface NoteVisualsProps {
  title: string;
  content: string;
  color: string;
  isCollapsed: boolean;
  isDark: boolean;
  isActive?: boolean;
  isDragging?: boolean;
  isSelected?: boolean;
  isGroupSelection?: boolean;
  width?: number;
  editingWidth?: number;
  editingHeight?: number;
  shouldUseEditingSize?: boolean;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

export const NoteVisuals = React.memo(React.forwardRef<HTMLElement, NoteVisualsProps & React.HTMLAttributes<HTMLElement>>((
  {
    title,
    content,
    color,
    isCollapsed,
    isDark,
    isActive = false,
    isDragging = false,
    isSelected = false,
    isGroupSelection = false,
    width,
    editingWidth,
    editingHeight,
    shouldUseEditingSize = false,
    className,
    style,
    children,
    ...rest
  },
  ref,
) => {
  const displayTitle = title || "无标题";
  const darkSpectrum = getNoteDarkSpectrum(color ?? '#FFFFFF');
  const darkBorderColor = getDarkBorderColor(
    darkSpectrum.accent,
    darkSpectrum.border,
    isActive,
    isDragging,
    isSelected,
    isGroupSelection,
  );

  return (
    <article
      ref={ref as React.Ref<HTMLElement>}
      data-note-visuals="true"
      className={cn(
        "flex flex-col",
        isCollapsed ? "overflow-hidden" : "h-auto",
        "rounded-xl",
        "border border-border-subtle",
        className,
      )}
      style={{
        width: shouldUseEditingSize ? (editingWidth ?? LAYOUT.NOTE_WIDTH) : (width ?? LAYOUT.NOTE_WIDTH),
        height: isCollapsed ? LAYOUT.NOTE_COLLAPSED_HEIGHT : (shouldUseEditingSize ? (editingHeight ?? 'auto') : 'auto'),
        minHeight: isCollapsed ? undefined : LAYOUT.NOTE_MIN_HEIGHT,
        backgroundColor: getNoteColor(color, isDark),
        borderColor: isDark ? darkBorderColor : undefined,
        backgroundImage: buildNoteSurfaceBackground(
          isDark,
          darkSpectrum.accent,
          isActive,
        ),
        boxShadow: buildNoteMaterialShadow(
          isDark,
          darkSpectrum.accent,
          isActive,
          isDragging,
          isSelected,
          isGroupSelection,
        ),
        ...style,
      }}
      {...rest}
    >
      {isCollapsed && (
        <div className="flex h-9 w-full items-center justify-center px-10">
          <span
            className={cn(
              "block max-w-full truncate rounded-md px-2 py-1 text-center text-sm font-bold select-none",
              title ? "text-text-primary" : "text-text-secondary italic opacity-70",
            )}
          >
            {displayTitle}
          </span>
        </div>
      )}
      {children ?? (
        !isCollapsed && (
          <>
            <div className="px-4 pt-3 pb-1">
              <div
                className={cn(
                  "w-full truncate",
                  "text-text-primary font-bold text-[16px]",
                  title ? "block" : "hidden",
                )}
              >
                {title}
              </div>
            </div>
            <div className="flex-1 pb-4 pt-0 min-h-0">
              <div
                className={cn(
                  "w-full px-4",
                  "text-text-secondary dark:text-text-primary",
                  "font-normal text-[15px] leading-relaxed",
                )}
              >
                {content || <span className="text-text-tertiary">记点什么…</span>}
              </div>
            </div>
          </>
        )
      )}
    </article>
  );
}));

NoteVisuals.displayName = "NoteVisuals";
