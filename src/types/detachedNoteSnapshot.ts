import type { NoteColor } from '../store/types';

/**
 * 撕下窗口只读快照。
 * 主窗口按 noteId 定向发送到 detached-note-{noteId} 窗口。
 * 只包含只读渲染必要字段。
 */
export interface DetachedNoteSnapshot {
  noteId: string;
  title: string;
  content: string;
  color: NoteColor;
  isCollapsed: boolean;
  deletedAt?: number | null;
}

/**
 * 便签不存在事件载荷。
 * 当便签被软删除或永久删除后，主窗口向对应撕下窗口发送此事件。
 */
export interface DetachedNoteMissingPayload {
  noteId: string;
}

/**
 * 定位请求事件载荷。
 * 撕下窗口向主窗口发送，请求定位到原便签所在画布位置。
 */
export interface DetachedNoteLocatePayload {
  noteId: string;
}

/** 撕下窗口事件名常量 */
export const DETACHED_NOTE_EVENTS = {
  SNAPSHOT: 'detached-note:snapshot',
  MISSING: 'detached-note:missing',
  LOCATE: 'detached-note:locate',
} as const;
