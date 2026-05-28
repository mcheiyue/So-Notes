import { useEffect, useCallback } from "react";
import { useStore } from "../store/useStore";
import { useViewportStore } from "../store";
import type { CanvasEngine } from "../canvas/CanvasEngine";

interface UseCanvasGlobalListenersOptions {
  engine: CanvasEngine;
  handleGlobalUp: (e: React.MouseEvent | MouseEvent) => void;
}

export function useCanvasGlobalListeners({
  engine,
  handleGlobalUp,
}: UseCanvasGlobalListenersOptions): void {
  const cancelStickyDrag = useCallback(() => {
    engine.cancelStickyDrag();
  }, [engine]);

  useEffect(() => {
    const handleWindowUp = (e: MouseEvent) => handleGlobalUp(e);

    const handleWindowBlur = () => {
      engine.resetAllInteractions();
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        engine.resetAllInteractions();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && useViewportStore.getState().stickyDrag.id) {
        event.preventDefault();
        cancelStickyDrag();
        return;
      }

      if (event.code === 'Space') {
        const active = document.activeElement;
        const isInput = active instanceof HTMLInputElement ||
                        active instanceof HTMLTextAreaElement ||
                        active?.getAttribute('contenteditable') === 'true';

        const isSpotlightOpen = useStore.getState().isSpotlightOpen;

        if (!isInput && !isSpotlightOpen) {
          event.preventDefault();

          if (!event.repeat) {
            const now = Date.now();
            const DOUBLE_PRESS_DELAY = 300;

            if (now - engine.lastSpacePressTime < DOUBLE_PRESS_DELAY) {
              useViewportStore.getState().setViewportPosition(0, 0);
              useViewportStore.getState().setPanMode(false);
              engine.lastSpacePressTime = 0;
            } else {
              const currentMode = useViewportStore.getState().interaction.isPanMode;
              useViewportStore.getState().setPanMode(!currentMode);
              engine.lastSpacePressTime = now;
            }
          }
        }
      }
    };

    window.addEventListener('mouseup', handleWindowUp);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('mouseup', handleWindowUp);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [engine, handleGlobalUp, cancelStickyDrag]);
}
