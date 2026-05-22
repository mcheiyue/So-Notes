import { getNoteElement } from './noteElementRegistry';

let activeLeaderId: string | null = null;
let accumulatedDelta = { x: 0, y: 0 };
let lastDraggablePos = { x: 0, y: 0 };

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

export function applyLeaderDOMCompensation(): void {
  if (!activeLeaderId) return;
  const el = getNoteElement(activeLeaderId);
  if (!el) return;
  const tx = lastDraggablePos.x + accumulatedDelta.x;
  const ty = lastDraggablePos.y + accumulatedDelta.y;
  el.style.transform = `translate(${tx}px, ${ty}px)`;
}
