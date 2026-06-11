import { afterEach, describe, expect, it, vi } from 'vitest';
import { useConfirmStore, confirm } from './confirmStore';

const resetStore = () => {
  useConfirmStore.setState({
    isOpen: false,
    options: { message: '' },
    resolve: null,
  });
};

describe('confirmStore', () => {
  afterEach(() => {
    resetStore();
  });

  it('open() 设置 isOpen=true 并保存 options 和 resolve', () => {
    const resolveFn = vi.fn();

    useConfirmStore.getState().open({ message: '测试消息' }, resolveFn);

    const state = useConfirmStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.options).toEqual({ message: '测试消息' });
    expect(state.resolve).toBe(resolveFn);
  });

  it('open() 连续调用时，前一次的 resolve 被 resolve(false)', () => {
    const firstResolve = vi.fn();
    const secondResolve = vi.fn();

    useConfirmStore.getState().open({ message: '第一次' }, firstResolve);
    useConfirmStore.getState().open({ message: '第二次' }, secondResolve);

    expect(firstResolve).toHaveBeenCalledExactlyOnceWith(false);
    expect(secondResolve).not.toHaveBeenCalled();

    const state = useConfirmStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.options).toEqual({ message: '第二次' });
    expect(state.resolve).toBe(secondResolve);
  });

  it('close() 设置 isOpen=false 并清空 options 和 resolve', () => {
    const resolveFn = vi.fn();

    useConfirmStore.getState().open({ message: '待关闭' }, resolveFn);
    useConfirmStore.getState().close();

    const state = useConfirmStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.options).toEqual({ message: '' });
    expect(state.resolve).toBeNull();
  });

  it('confirm() 返回 Promise 并通过 open 暴露 resolve', async () => {
    const promise = confirm({ message: '确认？' });

    const state = useConfirmStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.options).toEqual({ message: '确认？' });
    expect(state.resolve).toBeTypeOf('function');

    // 模拟用户点击确认
    state.resolve!(true);

    const result = await promise;
    expect(result).toBe(true);
  });

  it('confirm() 连续调用时，前一个 Promise 被 resolve(false)', async () => {
    const firstPromise = confirm({ message: '第一条' });
    const secondPromise = confirm({ message: '第二条' });

    // 第一个 promise 应该已经被 resolve(false)
    const firstResult = await firstPromise;
    expect(firstResult).toBe(false);

    // 第二个 promise 的 resolve 仍在 store 中
    const state = useConfirmStore.getState();
    expect(state.options).toEqual({ message: '第二条' });

    // 模拟用户确认第二条
    state.resolve!(true);
    const secondResult = await secondPromise;
    expect(secondResult).toBe(true);
  });

  it('open() 后 close() 再 open() 不会触发已清空的 resolve', () => {
    const firstResolve = vi.fn();
    const secondResolve = vi.fn();

    useConfirmStore.getState().open({ message: '第一条' }, firstResolve);
    useConfirmStore.getState().close();
    useConfirmStore.getState().open({ message: '第二条' }, secondResolve);

    // firstResolve 在 close 时已被清空，不会被调用
    expect(firstResolve).not.toHaveBeenCalled();
    expect(secondResolve).not.toHaveBeenCalled();

    const state = useConfirmStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.options).toEqual({ message: '第二条' });
    expect(state.resolve).toBe(secondResolve);
  });
});
