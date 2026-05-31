export interface HistoryEntry<TPatch> {
  id: string;
  label: string;
  createdAt: number;
  undo: TPatch;
  redo: TPatch;
}

export interface HistoryStack<TPatch> {
  readonly undoStack: ReadonlyArray<HistoryEntry<TPatch>>;
  readonly redoStack: ReadonlyArray<HistoryEntry<TPatch>>;
  readonly capacity: number;
}

export interface HistoryMutationResult<TPatch> {
  stack: HistoryStack<TPatch>;
  entry: HistoryEntry<TPatch> | null;
}

const DEFAULT_CAPACITY = 100;

function normalizeCapacity(capacity: number): number {
  if (!Number.isFinite(capacity) || capacity < 1) {
    return 1;
  }
  return Math.floor(capacity);
}

export function createUndoRedoHistory<TPatch>(
  capacity: number = DEFAULT_CAPACITY,
): HistoryStack<TPatch> {
  return {
    undoStack: [],
    redoStack: [],
    capacity: normalizeCapacity(capacity),
  };
}

export function pushHistoryEntry<TPatch>(
  stack: HistoryStack<TPatch>,
  entry: HistoryEntry<TPatch>,
): HistoryStack<TPatch> {
  const nextUndo = [...stack.undoStack, entry];
  const trimmedUndo =
    nextUndo.length > stack.capacity
      ? nextUndo.slice(nextUndo.length - stack.capacity)
      : nextUndo;

  return {
    undoStack: trimmedUndo,
    redoStack: [],
    capacity: stack.capacity,
  };
}

export function undoHistory<TPatch>(
  stack: HistoryStack<TPatch>,
): HistoryMutationResult<TPatch> {
  if (stack.undoStack.length === 0) {
    return { stack, entry: null };
  }

  const lastIdx = stack.undoStack.length - 1;
  const entry = stack.undoStack[lastIdx];

  return {
    stack: {
      undoStack: stack.undoStack.slice(0, lastIdx),
      redoStack: [...stack.redoStack, entry],
      capacity: stack.capacity,
    },
    entry,
  };
}

export function redoHistory<TPatch>(
  stack: HistoryStack<TPatch>,
): HistoryMutationResult<TPatch> {
  if (stack.redoStack.length === 0) {
    return { stack, entry: null };
  }

  const lastIdx = stack.redoStack.length - 1;
  const entry = stack.redoStack[lastIdx];

  return {
    stack: {
      undoStack: [...stack.undoStack, entry],
      redoStack: stack.redoStack.slice(0, lastIdx),
      capacity: stack.capacity,
    },
    entry,
  };
}

export function canUndo<TPatch>(stack: HistoryStack<TPatch>): boolean {
  return stack.undoStack.length > 0;
}

export function canRedo<TPatch>(stack: HistoryStack<TPatch>): boolean {
  return stack.redoStack.length > 0;
}

export function undoCount<TPatch>(stack: HistoryStack<TPatch>): number {
  return stack.undoStack.length;
}

export function redoCount<TPatch>(stack: HistoryStack<TPatch>): number {
  return stack.redoStack.length;
}
