import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { PinOff } from "lucide-react";
import { useUIStore } from "../store";
import { Z_INDEX } from "../constants/layout";
import { cn } from "../utils/cn";

export const PinFab = () => {
  const isPinned = useUIStore((state) => state.isPinned);

  const handleUnpin = async (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent canvas click events
    await invoke("frontend_unpin");
  };

  if (!isPinned) return null;

  return (
    <button
      type="button"
      onClick={handleUnpin}
      onDoubleClick={(e) => e.stopPropagation()} // Prevent creating note on double click
      className={cn(
        "pointer-events-auto absolute top-4 right-4",
        "w-8 h-8 flex items-center justify-center rounded-full",
        "bg-secondary-bg/80 backdrop-blur-md",
        "text-text-tertiary hover:text-red-500 dark:hover:text-red-400",
        "shadow-sm hover:shadow-md transition-all duration-200",
        "border border-border-subtle",
        "group cursor-pointer"
      )}
      style={{ zIndex: Z_INDEX.PIN_FAB }}
      title="取消钉住 (Unpin)"
    >
      <PinOff size={14} className="group-hover:scale-110 transition-transform" />
    </button>
  );
};
