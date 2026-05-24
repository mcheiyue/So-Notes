import { LAYOUT } from '../constants/layout';
import type { ViewportState } from '../store/types';

const SPAWN_OFFSET_X = 32;
const SPAWN_OFFSET_Y = 28;
const SPAWN_OFFSET_STEPS = 6;

let viewportSpawnSequence = 0;

export interface SpawnOrigin {
  x: number;
  y: number;
}

export const getViewportSpawnOrigin = (viewport: Pick<ViewportState, 'x' | 'y' | 'w' | 'h'>): SpawnOrigin => {
  const step = viewportSpawnSequence % SPAWN_OFFSET_STEPS;
  viewportSpawnSequence += 1;

  return {
    x: Math.round(viewport.x + Math.max(24, viewport.w / 2 - LAYOUT.NOTE_WIDTH / 2) + step * SPAWN_OFFSET_X),
    y: Math.round(viewport.y + 72 + step * SPAWN_OFFSET_Y),
  };
};

export const resetViewportSpawnSequenceForTests = () => {
  viewportSpawnSequence = 0;
};
