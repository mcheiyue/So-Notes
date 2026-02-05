import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PinOff } from "lucide-react";
import { cn } from "../utils/cn";

export const PinFab = () => {
  const [isPinned, setIsPinned] = useState(false);

  useEffect(() => {
    let unlistenFn: (() => void) | undefined;

    const setupListener = async () => {
      unlistenFn = await listen<boolean>("pin-state-changed", (event) => {
        setIsPinned(event.payload);
      });
    };

    setupListener();

    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, []);

  const handleUnpin = async (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent canvas click events
    await invoke("frontend_unpin");
  };

  if (!isPinned) return null;

  return (
    <button
      onClick={handleUnpin}
      onDoubleClick={(e) => e.stopPropagation()} // Prevent creating note on double click
      className={cn(
        "absolute top-3 right-3 z-[9999]",
        "w-8 h-8 flex items-center justify-center rounded-full",
        "bg-white/80 dark:bg-zinc-800/80 backdrop-blur-md",
        "text-zinc-500 hover:text-red-500 dark:text-zinc-400 dark:hover:text-red-400",
        "shadow-sm hover:shadow-md transition-all duration-200",
        "border border-black/5 dark:border-white/10",
        "group cursor-pointer"
      )}
      title="取消钉住 (Unpin)"
    >
      <PinOff size={14} className="group-hover:scale-110 transition-transform" />
    </button>
  );
};
