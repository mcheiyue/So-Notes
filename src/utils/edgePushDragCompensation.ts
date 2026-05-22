import { getNoteElement } from './noteElementRegistry';

type Position = { x: number; y: number };

type DragSession = {
  leaderId: string;
  noteIds: string[];
  basePositions: Record<string, Position>;
  pointerStart: Position;
  pointerDelta: Position;
  edgePushDelta: Position;
};

let activeSession: DragSession | null = null;
let activeLeaderId: string | null = null;
let accumulatedDelta: Position = { x: 0, y: 0 };
let lastDraggablePos: Position = { x: 0, y: 0 };

const getEffectivePosition = () => ({
  x: getBasePosition(activeLeaderId).x + getTotalDelta().x,
  y: getBasePosition(activeLeaderId).y + getTotalDelta().y,
});

const getBasePosition = (id: string | null): Position => {
  if (!id || !activeSession) return lastDraggablePos;
  return activeSession.basePositions[id] ?? lastDraggablePos;
};

const getTotalDelta = (): Position => {
  if (!activeSession) return accumulatedDelta;
  return {
    x: activeSession.pointerDelta.x + activeSession.edgePushDelta.x,
    y: activeSession.pointerDelta.y + activeSession.edgePushDelta.y,
  };
};

const resetSessionState = () => {
  activeSession = null;
  activeLeaderId = null;
  accumulatedDelta = { x: 0, y: 0 };
  lastDraggablePos = { x: 0, y: 0 };
};

export function beginEdgePushDragSession(
  leaderId: string,
  noteIds: string[],
  basePositions: Record<string, Position>,
  pointerStart: Position = { x: 0, y: 0 },
): void {
  activeLeaderId = leaderId;
  accumulatedDelta = { x: 0, y: 0 };
  const leaderBase = basePositions[leaderId] ?? { x: 0, y: 0 };
  lastDraggablePos = { ...leaderBase };
  activeSession = {
    leaderId,
    noteIds: [...new Set([leaderId, ...noteIds])],
    basePositions: Object.fromEntries(
      Object.entries(basePositions).map(([id, pos]) => [id, { ...pos }]),
    ),
    pointerStart: { ...pointerStart },
    pointerDelta: { x: 0, y: 0 },
    edgePushDelta: { x: 0, y: 0 },
  };
}

export function setEdgePushDragLeader(leaderId: string | null): void {
  if (leaderId === null) {
    resetSessionState();
    return;
  }

  if (activeSession?.leaderId === leaderId) {
    activeLeaderId = leaderId;
    return;
  }

  if (leaderId !== activeLeaderId) {
    accumulatedDelta = { x: 0, y: 0 };
    lastDraggablePos = { x: 0, y: 0 };
  }
  activeLeaderId = leaderId;
}

export function getEdgePushDragLeader(): string | null {
  return activeLeaderId;
}

export function hasActiveEdgePushDragSession(): boolean {
  return activeSession !== null;
}

export function getEdgePushDragSessionNoteIds(): string[] {
  return activeSession ? [...activeSession.noteIds] : [];
}

export function getEdgePushDragSessionBasePosition(id: string): Readonly<Position> | null {
  return activeSession?.basePositions[id] ?? null;
}

export function getEdgePushDragTotalDelta(): Readonly<Position> {
  return getTotalDelta();
}

export function getEdgePushDragSessionPosition(id: string): Readonly<Position> | null {
  if (!activeSession) return null;
  const base = activeSession.basePositions[id];
  if (!base) return null;
  const totalDelta = getTotalDelta();
  return {
    x: base.x + totalDelta.x,
    y: base.y + totalDelta.y,
  };
}

export function updateEdgePushPointerDelta(deltaX: number, deltaY: number): void {
  if (!activeSession) return;
  activeSession.pointerDelta.x += deltaX;
  activeSession.pointerDelta.y += deltaY;
  const leaderPosition = getEdgePushDragSessionPosition(activeSession.leaderId);
  if (leaderPosition) {
    lastDraggablePos = { ...leaderPosition };
  }
}

export function updateEdgePushPointerFromClient(clientX: number, clientY: number): void {
  if (!activeSession) return;
  activeSession.pointerDelta = {
    x: clientX - activeSession.pointerStart.x,
    y: clientY - activeSession.pointerStart.y,
  };
  const leaderPosition = getEdgePushDragSessionPosition(activeSession.leaderId);
  if (leaderPosition) {
    lastDraggablePos = { ...leaderPosition };
  }
}

export function accumulateEdgePushDelta(dx: number, dy: number): void {
  if (activeSession) {
    activeSession.edgePushDelta.x += dx;
    activeSession.edgePushDelta.y += dy;
    accumulatedDelta = { ...activeSession.edgePushDelta };
    return;
  }

  accumulatedDelta = {
    x: accumulatedDelta.x + dx,
    y: accumulatedDelta.y + dy,
  };
}

export function getEdgePushAccumulatedDelta(): Readonly<{ x: number; y: number }> {
  return activeSession ? activeSession.edgePushDelta : accumulatedDelta;
}

export function setLastDraggablePosition(x: number, y: number): void {
  if (activeSession) {
    const base = activeSession.basePositions[activeSession.leaderId];
    if (base) {
      activeSession.pointerDelta = {
        x: x - base.x,
        y: y - base.y,
      };
    }
  }
  lastDraggablePos = { x, y };
}

export function getLastDraggablePosition(): Readonly<{ x: number; y: number }> {
  return lastDraggablePos;
}

export function getEffectiveLeaderPosition(): Readonly<{ x: number; y: number }> {
  return getEffectivePosition();
}

export function applyActiveDragSessionTransforms(): void {
  if (!activeSession) {
    applyLeaderDOMCompensation();
    return;
  }

  activeSession.noteIds.forEach((id) => {
    const el = getNoteElement(id);
    const position = getEdgePushDragSessionPosition(id);
    if (!el || !position) return;
    el.style.transform = `translate(${position.x}px, ${position.y}px)`;
  });
}

export function applyLeaderDOMCompensation(): void {
  if (!activeLeaderId) return;
  const el = getNoteElement(activeLeaderId);
  if (!el) return;
  const { x: tx, y: ty } = getEffectivePosition();
  el.style.transform = `translate(${tx}px, ${ty}px)`;
}
