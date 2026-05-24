import { beforeEach, describe, expect, it } from 'vitest';
import { getViewportSpawnOrigin, resetViewportSpawnSequenceForTests } from './spawnPosition';

describe('spawnPosition', () => {
  beforeEach(() => {
    resetViewportSpawnSequenceForTests();
  });

  it('从当前视口中心偏上生成非鼠标入口落点', () => {
    expect(getViewportSpawnOrigin({ x: 40, y: 60, w: 1280, h: 720 })).toEqual({
      x: 550,
      y: 132,
    });
  });

  it('连续生成时轻微错位并循环', () => {
    const viewport = { x: 40, y: 60, w: 1280, h: 720 };

    expect(getViewportSpawnOrigin(viewport)).toEqual({ x: 550, y: 132 });
    expect(getViewportSpawnOrigin(viewport)).toEqual({ x: 582, y: 160 });
    expect(getViewportSpawnOrigin(viewport)).toEqual({ x: 614, y: 188 });

    getViewportSpawnOrigin(viewport);
    getViewportSpawnOrigin(viewport);
    getViewportSpawnOrigin(viewport);

    expect(getViewportSpawnOrigin(viewport)).toEqual({ x: 550, y: 132 });
  });
});
