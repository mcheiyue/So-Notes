import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useQuitConfirmStore, promptQuitConfirm } from './quitConfirmStore';

describe('quitConfirmStore', () => {
  beforeEach(() => {
    // 重置 store 状态
    useQuitConfirmStore.getState().close();
  });

  it('初始状态为关闭', () => {
    const state = useQuitConfirmStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.resolve).toBeNull();
    expect(state.isBackingUp).toBe(false);
  });

  it('open 设置 isOpen 为 true 并保存 resolve', () => {
    const resolve = vi.fn();
    useQuitConfirmStore.getState().open(resolve);

    const state = useQuitConfirmStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.resolve).toBe(resolve);
  });

  it('close 重置所有状态', () => {
    const resolve = vi.fn();
    useQuitConfirmStore.getState().open(resolve);
    useQuitConfirmStore.getState().close();

    const state = useQuitConfirmStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.resolve).toBeNull();
    expect(state.isBackingUp).toBe(false);
  });

  it('setBackingUp 设置备份中标志', () => {
    useQuitConfirmStore.getState().setBackingUp(true);
    expect(useQuitConfirmStore.getState().isBackingUp).toBe(true);

    useQuitConfirmStore.getState().setBackingUp(false);
    expect(useQuitConfirmStore.getState().isBackingUp).toBe(false);
  });

  it('open 时取消已有的 resolve', () => {
    const previousResolve = vi.fn();
    useQuitConfirmStore.getState().open(previousResolve);

    const newResolve = vi.fn();
    useQuitConfirmStore.getState().open(newResolve);

    expect(previousResolve).toHaveBeenCalledWith('cancel');
  });

  it('promptQuitConfirm 返回 Promise 并在选择后 resolve', async () => {
    const promise = promptQuitConfirm();

    expect(useQuitConfirmStore.getState().isOpen).toBe(true);

    // 模拟用户选择（resolve 后 store 仍为 open，由对话框组件调用 close）
    useQuitConfirmStore.getState().resolve?.('quit-now');

    const choice = await promise;
    expect(choice).toBe('quit-now');
  });

  it('promptQuitConfirm 取消时返回 cancel', async () => {
    const promise = promptQuitConfirm();

    useQuitConfirmStore.getState().resolve?.('cancel');

    const choice = await promise;
    expect(choice).toBe('cancel');
  });

  it('promptQuitConfirm 备份退出时返回 backup-and-quit', async () => {
    const promise = promptQuitConfirm();

    useQuitConfirmStore.getState().resolve?.('backup-and-quit');

    const choice = await promise;
    expect(choice).toBe('backup-and-quit');
  });
});
