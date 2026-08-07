import type { ViewportState } from './types';

type Pan = Pick<ViewportState, 'x' | 'y' | 'w' | 'h'>;

// ponytail: 断开 useStore ↔ viewportStore 循环；viewportStore 启动时 bind
let reader: () => Pan = () => ({ x: 0, y: 0, w: 0, h: 0 });

export const bindRuntimePanReader = (fn: () => Pan): void => {
  reader = fn;
};

export const getCurrentViewport = (): Pan => reader();
