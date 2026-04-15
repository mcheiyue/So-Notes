import React from "react";
import { Z_INDEX } from "../constants/layout";

interface WindowShellProps {
  children: React.ReactNode;
  overlay?: React.ReactNode;
}

export const WindowShell: React.FC<WindowShellProps> = ({ children, overlay }) => {
  return (
    <section
      data-testid="window-shell"
      className="fixed inset-0 h-screen w-full overflow-hidden rounded-lg border border-border-subtle bg-primary-bg/90 transition-colors duration-300"
    >
      <div className="absolute inset-0 overflow-hidden rounded-[inherit]">
        {children}
      </div>

      {overlay ? (
        <div
          data-testid="window-shell-overlay"
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]"
        >
          {overlay}
        </div>
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center">
        <div
          data-tauri-drag-region
          className="drag-handle-area relative group pointer-events-auto flex h-6 w-40 cursor-grab items-start justify-center"
          style={{ zIndex: Z_INDEX.DRAG_HANDLE_AREA }}
        >
          <div className="mt-2 h-1 w-12 rounded-full bg-text-tertiary/20 transition-colors group-hover:bg-text-tertiary/40" />
        </div>
      </div>
    </section>
  );
};
