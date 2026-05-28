const noteElements = new Map<string, HTMLElement>();

// 共享策略：这是 NoteCard 与 CanvasEngine 之间的 DOM 索引，按便签 id 全局共享。
// 清理策略：NoteCard 挂载时注册、卸载时注销；CanvasEngine.dispose 不清空全局索引，
// 避免在未来多 Canvas 或测试并行挂载场景下误删其他实例仍在使用的便签元素。

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
