import { describe, expect, it } from 'vitest';

import {
  canRedo,
  canUndo,
  createUndoRedoHistory,
  pushHistoryEntry,
  redoCount,
  redoHistory,
  undoCount,
  undoHistory,
  type HistoryEntry,
} from './undoRedoHistory';

type Patch = Record<string, unknown>;

let seq = 0;

function makeEntry(label: string, id = label): HistoryEntry<Patch> {
  return {
    id,
    label,
    createdAt: ++seq,
    undo: { before: label },
    redo: { after: label },
  };
}

describe('createUndoRedoHistory', () => {
  it('默认创建空栈，容量为 100', () => {
    const stack = createUndoRedoHistory<Patch>();

    expect(stack.undoStack).toEqual([]);
    expect(stack.redoStack).toEqual([]);
    expect(stack.capacity).toBe(100);
  });

  it('接受自定义容量', () => {
    const stack = createUndoRedoHistory<Patch>(50);
    expect(stack.capacity).toBe(50);
  });

  it('容量小于 1 时标准化为 1', () => {
    expect(createUndoRedoHistory<Patch>(0).capacity).toBe(1);
    expect(createUndoRedoHistory<Patch>(-5).capacity).toBe(1);
  });

  it('非有限数容量标准化为 1', () => {
    expect(createUndoRedoHistory<Patch>(Infinity).capacity).toBe(1);
    expect(createUndoRedoHistory<Patch>(NaN).capacity).toBe(1);
  });

  it('小数容量向下取整', () => {
    expect(createUndoRedoHistory<Patch>(3.7).capacity).toBe(3);
  });
});

describe('pushHistoryEntry', () => {
  it('追加条目到 undo 栈尾部', () => {
    const stack = createUndoRedoHistory<Patch>();
    const entryA = makeEntry('A');
    const entryB = makeEntry('B');

    const s1 = pushHistoryEntry(stack, entryA);
    const s2 = pushHistoryEntry(s1, entryB);

    expect(s2.undoStack).toEqual([entryA, entryB]);
  });

  it('每次 push 都清空 redo 栈', () => {
    const stack = createUndoRedoHistory<Patch>();
    const entryA = makeEntry('A');
    const entryB = makeEntry('B');

    const s1 = pushHistoryEntry(stack, entryA);
    const { stack: afterUndo } = undoHistory(s1);
    expect(afterUndo.redoStack).toHaveLength(1);

    const s2 = pushHistoryEntry(afterUndo, entryB);
    expect(s2.redoStack).toEqual([]);
  });

  it('超过容量时裁剪最旧的条目', () => {
    const stack = createUndoRedoHistory<Patch>(3);
    const entries = ['A', 'B', 'C', 'D'].map((l) => makeEntry(l));

    let s = stack;
    for (const entry of entries) {
      s = pushHistoryEntry(s, entry);
    }

    expect(s.undoStack).toHaveLength(3);
    expect(s.undoStack.map((e) => e.id)).toEqual(['B', 'C', 'D']);
  });

  it('容量为 1 时只保留最新条目', () => {
    const stack = createUndoRedoHistory<Patch>(1);
    const s1 = pushHistoryEntry(stack, makeEntry('A'));
    const s2 = pushHistoryEntry(s1, makeEntry('B'));

    expect(s2.undoStack).toHaveLength(1);
    expect(s2.undoStack[0].id).toBe('B');
  });
});

describe('undoHistory', () => {
  it('将 undo 栈顶条目移至 redo 栈顶', () => {
    const stack = createUndoRedoHistory<Patch>();
    const entryA = makeEntry('A');
    const entryB = makeEntry('B');

    const s1 = pushHistoryEntry(pushHistoryEntry(stack, entryA), entryB);
    const result = undoHistory(s1);

    expect(result.entry).toEqual(entryB);
    expect(result.stack.undoStack).toEqual([entryA]);
    expect(result.stack.redoStack).toEqual([entryB]);
  });

  it('连续撤销依次将条目移入 redo', () => {
    const stack = createUndoRedoHistory<Patch>();
    const s1 = pushHistoryEntry(pushHistoryEntry(stack, makeEntry('A')), makeEntry('B'));

    const r1 = undoHistory(s1);
    const r2 = undoHistory(r1.stack);

    expect(r1.entry!.id).toBe('B');
    expect(r2.entry!.id).toBe('A');
    expect(r2.stack.undoStack).toEqual([]);
    expect(r2.stack.redoStack.map((e) => e.id)).toEqual(['B', 'A']);
  });

  it('undo 栈为空时返回 entry: null 且栈不变', () => {
    const stack = createUndoRedoHistory<Patch>();
    const result = undoHistory(stack);

    expect(result.entry).toBeNull();
    expect(result.stack).toBe(stack);
  });
});

describe('redoHistory', () => {
  it('将 redo 栈顶条目移回 undo 栈顶', () => {
    const stack = createUndoRedoHistory<Patch>();
    const entryA = makeEntry('A');
    const s1 = pushHistoryEntry(stack, entryA);
    const { stack: afterUndo } = undoHistory(s1);
    const result = redoHistory(afterUndo);

    expect(result.entry!.id).toBe('A');
    expect(result.stack.undoStack).toEqual([entryA]);
    expect(result.stack.redoStack).toEqual([]);
  });

  it('连续重做依次将条目移回 undo', () => {
    const stack = createUndoRedoHistory<Patch>();
    const s1 = pushHistoryEntry(pushHistoryEntry(stack, makeEntry('A')), makeEntry('B'));

    const { stack: afterUndo1 } = undoHistory(s1);
    const { stack: afterUndo2 } = undoHistory(afterUndo1);

    const r1 = redoHistory(afterUndo2);
    const r2 = redoHistory(r1.stack);

    expect(r1.entry!.id).toBe('A');
    expect(r2.entry!.id).toBe('B');
    expect(r2.stack.undoStack.map((e) => e.id)).toEqual(['A', 'B']);
    expect(r2.stack.redoStack).toEqual([]);
  });

  it('redo 栈为空时返回 entry: null 且栈不变', () => {
    const stack = createUndoRedoHistory<Patch>();
    const result = redoHistory(stack);

    expect(result.entry).toBeNull();
    expect(result.stack).toBe(stack);
  });
});

describe('redo 清空', () => {
  it('撤销后执行新 push 会清空 redo 栈', () => {
    const stack = createUndoRedoHistory<Patch>();
    const s1 = pushHistoryEntry(pushHistoryEntry(stack, makeEntry('A')), makeEntry('B'));
    const { stack: afterUndo } = undoHistory(s1);

    expect(afterUndo.redoStack).toHaveLength(1);

    const s2 = pushHistoryEntry(afterUndo, makeEntry('C'));

    expect(s2.redoStack).toEqual([]);
    expect(s2.undoStack.map((e) => e.id)).toEqual(['A', 'C']);
  });
});

describe('容量裁剪', () => {
  it('裁剪只影响 undo 栈，redo 栈由 push 清空', () => {
    const stack = createUndoRedoHistory<Patch>(2);
    const s1 = pushHistoryEntry(pushHistoryEntry(stack, makeEntry('A')), makeEntry('B'));
    const { stack: afterUndo } = undoHistory(s1);

    expect(afterUndo.redoStack).toHaveLength(1);

    const s2 = pushHistoryEntry(afterUndo, makeEntry('C'));

    expect(s2.undoStack).toHaveLength(2);
    expect(s2.undoStack.map((e) => e.id)).toEqual(['A', 'C']);
    expect(s2.redoStack).toEqual([]);
  });
});

describe('不可变性', () => {
  it('push 不变异原始栈', () => {
    const stack = createUndoRedoHistory<Patch>();
    const entryA = makeEntry('A');
    const frozen = { undoStack: [...stack.undoStack], redoStack: [...stack.redoStack] };

    pushHistoryEntry(stack, entryA);

    expect(stack.undoStack).toEqual(frozen.undoStack);
    expect(stack.redoStack).toEqual(frozen.redoStack);
  });

  it('undo 不变异原始栈', () => {
    const stack = createUndoRedoHistory<Patch>();
    const s1 = pushHistoryEntry(stack, makeEntry('A'));
    const frozen = { undoStack: [...s1.undoStack], redoStack: [...s1.redoStack] };

    undoHistory(s1);

    expect(s1.undoStack).toEqual(frozen.undoStack);
    expect(s1.redoStack).toEqual(frozen.redoStack);
  });

  it('redo 不变异原始栈', () => {
    const stack = createUndoRedoHistory<Patch>();
    const s1 = pushHistoryEntry(stack, makeEntry('A'));
    const { stack: afterUndo } = undoHistory(s1);
    const frozen = { undoStack: [...afterUndo.undoStack], redoStack: [...afterUndo.redoStack] };

    redoHistory(afterUndo);

    expect(afterUndo.undoStack).toEqual(frozen.undoStack);
    expect(afterUndo.redoStack).toEqual(frozen.redoStack);
  });

  it('push 后原始栈的 undoStack 引用不变', () => {
    const stack = createUndoRedoHistory<Patch>();
    const originalRef = stack.undoStack;

    pushHistoryEntry(stack, makeEntry('A'));

    expect(stack.undoStack).toBe(originalRef);
  });
});

describe('辅助查询', () => {
  it('canUndo / canRedo 正确反映栈状态', () => {
    const stack = createUndoRedoHistory<Patch>();

    expect(canUndo(stack)).toBe(false);
    expect(canRedo(stack)).toBe(false);

    const s1 = pushHistoryEntry(stack, makeEntry('A'));
    expect(canUndo(s1)).toBe(true);
    expect(canRedo(s1)).toBe(false);

    const { stack: afterUndo } = undoHistory(s1);
    expect(canUndo(afterUndo)).toBe(false);
    expect(canRedo(afterUndo)).toBe(true);
  });

  it('undoCount / redoCount 正确计数', () => {
    const stack = createUndoRedoHistory<Patch>();
    const s1 = pushHistoryEntry(pushHistoryEntry(stack, makeEntry('A')), makeEntry('B'));

    expect(undoCount(s1)).toBe(2);
    expect(redoCount(s1)).toBe(0);

    const { stack: afterUndo } = undoHistory(s1);
    expect(undoCount(afterUndo)).toBe(1);
    expect(redoCount(afterUndo)).toBe(1);
  });
});

describe('完整 undo/redo 往返', () => {
  it('push → undo → redo 恢复到 undo 前的状态', () => {
    const stack = createUndoRedoHistory<Patch>();
    const entry = makeEntry('A');
    const s1 = pushHistoryEntry(stack, entry);

    const undoResult = undoHistory(s1);
    const redoResult = redoHistory(undoResult.stack);

    expect(redoResult.stack.undoStack).toEqual(s1.undoStack);
    expect(redoResult.stack.redoStack).toEqual(s1.redoStack);
    expect(redoResult.entry).toEqual(entry);
  });

  it('push 多条 → 全部 undo → 全部 redo 恢复完整栈', () => {
    const stack = createUndoRedoHistory<Patch>();
    const labels = ['A', 'B', 'C'];
    let s = stack;
    for (const label of labels) {
      s = pushHistoryEntry(s, makeEntry(label));
    }

    const original = s;
    let current = s;
    const undone: string[] = [];

    for (let i = 0; i < labels.length; i++) {
      const r = undoHistory(current);
      undone.push(r.entry!.id);
      current = r.stack;
    }

    expect(undone).toEqual(['C', 'B', 'A']);
    expect(current.undoStack).toEqual([]);
    expect(current.redoStack.map((e) => e.id)).toEqual(['C', 'B', 'A']);

    for (let i = 0; i < labels.length; i++) {
      current = redoHistory(current).stack;
    }

    expect(current.undoStack).toEqual(original.undoStack);
    expect(current.redoStack).toEqual([]);
  });
});
