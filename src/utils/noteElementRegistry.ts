const noteElements = new Map<string, HTMLElement>();

export function registerNoteElement(id: string, el: HTMLElement): void {
  noteElements.set(id, el);
}

export function unregisterNoteElement(id: string): void {
  noteElements.delete(id);
}

export function getNoteElement(id: string): HTMLElement | undefined {
  return noteElements.get(id);
}

export function applyGroupTransforms(
  leaderId: string,
  selectedIds: string[],
  dx: number,
  dy: number,
  getNotePos: (id: string) => { x: number; y: number } | null
): void {
  for (const id of selectedIds) {
    if (id === leaderId) continue;
    const el = noteElements.get(id);
    if (!el) continue;
    const pos = getNotePos(id);
    if (!pos) continue;
    el.style.transform = `translate(${pos.x + dx}px, ${pos.y + dy}px)`;
  }
}
