import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  finalizeActiveNoteDrag,
  hasActiveNoteDragFinalizer,
  registerActiveNoteDragFinalizer,
  unregisterActiveNoteDragFinalizer,
} from './activeNoteDrag';

describe('activeNoteDrag', () => {
  afterEach(() => {
    finalizeActiveNoteDrag('unmount');
  });

  it('注册后可由异常原因触发一次性收口', () => {
    const finalizer = vi.fn();

    registerActiveNoteDragFinalizer(finalizer);

    expect(hasActiveNoteDragFinalizer()).toBe(true);
    expect(finalizeActiveNoteDrag('window-blur')).toBe(true);
    expect(finalizer).toHaveBeenCalledTimes(1);
    expect(finalizer).toHaveBeenCalledWith('window-blur');
    expect(hasActiveNoteDragFinalizer()).toBe(false);
    expect(finalizeActiveNoteDrag('window-blur')).toBe(false);
    expect(finalizer).toHaveBeenCalledTimes(1);
  });

  it('只允许当前注册的收口函数注销自己', () => {
    const firstFinalizer = vi.fn();
    const secondFinalizer = vi.fn();

    registerActiveNoteDragFinalizer(firstFinalizer);
    unregisterActiveNoteDragFinalizer(secondFinalizer);

    expect(hasActiveNoteDragFinalizer()).toBe(true);
    expect(finalizeActiveNoteDrag('switch-board')).toBe(true);
    expect(firstFinalizer).toHaveBeenCalledWith('switch-board');
    expect(secondFinalizer).not.toHaveBeenCalled();
  });
});
