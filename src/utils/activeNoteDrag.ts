export type NoteDragAbortReason = 'window-blur' | 'switch-board' | 'unmount';

type ActiveNoteDragFinalizer = (reason: NoteDragAbortReason) => void;

let activeFinalizer: ActiveNoteDragFinalizer | null = null;

export function registerActiveNoteDragFinalizer(finalizer: ActiveNoteDragFinalizer): void {
  activeFinalizer = finalizer;
}

export function unregisterActiveNoteDragFinalizer(finalizer: ActiveNoteDragFinalizer): void {
  if (activeFinalizer === finalizer) {
    activeFinalizer = null;
  }
}

export function finalizeActiveNoteDrag(reason: NoteDragAbortReason): boolean {
  if (!activeFinalizer) {
    return false;
  }

  const finalizer = activeFinalizer;
  activeFinalizer = null;
  finalizer(reason);
  return true;
}

export function hasActiveNoteDragFinalizer(): boolean {
  return activeFinalizer !== null;
}

export function resetActiveNoteDrag(reason: NoteDragAbortReason = 'window-blur'): void {
  if (activeFinalizer) {
    finalizeActiveNoteDrag(reason);
  }
}
