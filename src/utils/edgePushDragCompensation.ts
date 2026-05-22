import { getNoteElement } from './noteElementRegistry';

let activeLeaderId: string | null = null;
let accumulatedDelta = { x: 0, y: 0 };
let lastDraggablePos = { x: 0, y: 0 };

const getEffectivePosition = () => ({
  x: lastDraggablePos.x + accumulatedDelta.x,
  y: lastDraggablePos.y + accumulatedDelta.y,
});

export function setEdgePushDragLeader(leaderId: string | null): void {
  if (leaderId !== activeLeaderId) {
    accumulatedDelta = { x: 0, y: 0 };
    lastDraggablePos = { x: 0, y: 0 };
  }
  activeLeaderId = leaderId;
}

export function getEdgePushDragLeader(): string | null {
  return activeLeaderId;
}

export function accumulateEdgePushDelta(dx: number, dy: number): void {
  accumulatedDelta.x += dx;
  accumulatedDelta.y += dy;
}

export function getEdgePushAccumulatedDelta(): Readonly<{ x: number; y: number }> {
  return accumulatedDelta;
}

export function setLastDraggablePosition(x: number, y: number): void {
  lastDraggablePos = { x, y };
}

export function getLastDraggablePosition(): Readonly<{ x: number; y: number }> {
  return lastDraggablePos;
}

export function getEffectiveLeaderPosition(): Readonly<{ x: number; y: number }> {
  return getEffectivePosition();
}

export function applyLeaderDOMCompensation(): void {
  if (!activeLeaderId) return;
  const el = getNoteElement(activeLeaderId);
  if (!el) return;
  const { x: tx, y: ty } = getEffectivePosition();
  el.style.transform = `translate(${tx}px, ${ty}px)`;
}
