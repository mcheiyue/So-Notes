import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AttachResult, PersistenceStatus } from './types';
import {
  attach,
  detach,
  isAttached,
  flushNow,
  pause,
  resume,
  isPaused,
  getStatus,
  resetForTests,
  NO_ACTIVE_HANDLE_ERROR,
} from './PersistenceFacade';

const makeHandle = (overrides?: Partial<AttachResult>): AttachResult => ({
  detach: vi.fn(),
  flushPersistNow: vi.fn(async () => true),
  getStatus: vi.fn((): PersistenceStatus => 'idle'),
  pause: vi.fn(),
  resume: vi.fn(),
  isPaused: vi.fn(() => false),
  ...overrides,
});

describe('PersistenceFacade', () => {
  beforeEach(() => {
    resetForTests();
  });

  it('初始状态无活跃句柄，isAttached 返回 false', () => {
    expect(isAttached()).toBe(false);
  });

  it('attach 后 isAttached 返回 true', () => {
    attach(makeHandle());
    expect(isAttached()).toBe(true);
  });

  it('detach 后 isAttached 返回 false', () => {
    attach(makeHandle());
    detach();
    expect(isAttached()).toBe(false);
  });

  it('无活跃句柄时 flushNow 抛出明确错误', async () => {
    await expect(flushNow()).rejects.toThrow(NO_ACTIVE_HANDLE_ERROR);
  });

  it('无活跃句柄时 pause 抛出明确错误', () => {
    expect(() => pause()).toThrow(NO_ACTIVE_HANDLE_ERROR);
  });

  it('无活跃句柄时 resume 抛出明确错误', () => {
    expect(() => resume()).toThrow(NO_ACTIVE_HANDLE_ERROR);
  });

  it('无活跃句柄时 isPaused 抛出明确错误', () => {
    expect(() => isPaused()).toThrow(NO_ACTIVE_HANDLE_ERROR);
  });

  it('无活跃句柄时 getStatus 抛出明确错误', () => {
    expect(() => getStatus()).toThrow(NO_ACTIVE_HANDLE_ERROR);
  });

  it('flushNow 委托给活跃句柄的 flushPersistNow', async () => {
    const handle = makeHandle();
    attach(handle);

    const result = await flushNow();

    expect(result).toBe(true);
    expect(handle.flushPersistNow).toHaveBeenCalledTimes(1);
  });

  it('flushNow 传播句柄返回的 false', async () => {
    const handle = makeHandle({ flushPersistNow: vi.fn(async () => false) });
    attach(handle);

    const result = await flushNow();

    expect(result).toBe(false);
  });

  it('pause 委托给活跃句柄', () => {
    const handle = makeHandle();
    attach(handle);

    pause();

    expect(handle.pause).toHaveBeenCalledTimes(1);
  });

  it('resume 委托给活跃句柄', () => {
    const handle = makeHandle();
    attach(handle);

    resume();

    expect(handle.resume).toHaveBeenCalledTimes(1);
  });

  it('isPaused 委托给活跃句柄', () => {
    const handle = makeHandle({ isPaused: vi.fn(() => true) });
    attach(handle);

    expect(isPaused()).toBe(true);
    expect(handle.isPaused).toHaveBeenCalledTimes(1);
  });

  it('getStatus 委托给活跃句柄', () => {
    const handle = makeHandle({ getStatus: vi.fn((): PersistenceStatus => 'dirty') });
    attach(handle);

    expect(getStatus()).toBe('dirty');
    expect(handle.getStatus).toHaveBeenCalledTimes(1);
  });

  it('用新句柄替换旧句柄后，操作委托给新句柄', async () => {
    const oldHandle = makeHandle();
    const newHandle = makeHandle({ flushPersistNow: vi.fn(async () => false) });

    attach(oldHandle);
    attach(newHandle);

    const result = await flushNow();

    expect(result).toBe(false);
    expect(oldHandle.flushPersistNow).not.toHaveBeenCalled();
    expect(newHandle.flushPersistNow).toHaveBeenCalledTimes(1);
  });
});
