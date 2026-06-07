import type { AttachResult, PersistenceStatus } from './types';

export const NO_ACTIVE_HANDLE_ERROR = '持久化引擎未就绪：当前无活跃的持久化句柄。';

let activeHandle: AttachResult | null = null;

export function attach(handle: AttachResult): void {
  activeHandle = handle;
}

export function detach(): void {
  activeHandle = null;
}

export function isAttached(): boolean {
  return activeHandle !== null;
}

function getHandleOrThrow(): AttachResult {
  if (!activeHandle) {
    throw new Error(NO_ACTIVE_HANDLE_ERROR);
  }
  return activeHandle;
}

export async function flushNow(): Promise<boolean> {
  return getHandleOrThrow().flushPersistNow();
}

export function pause(): void {
  getHandleOrThrow().pause();
}

export function resume(): void {
  getHandleOrThrow().resume();
}

export function isPaused(): boolean {
  return getHandleOrThrow().isPaused();
}

export function getStatus(): PersistenceStatus {
  return getHandleOrThrow().getStatus();
}

/** 仅用于测试：重置单例到初始状态。 */
export function resetForTests(): void {
  activeHandle = null;
}
