import type { NoteColor, ThemeMode } from '../store/types';

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

/**
 * 窗口销毁清理事件载荷。
 * Rust 监听到撕下窗口 WindowEvent::Destroyed 后，向主窗口发送此事件。
 * 主窗口据此清理运行态映射，不依赖撕下窗口前端主动通知。
 */
export interface DetachedNoteClosedPayload {
  noteId: string;
}

/**
 * 窗口就绪事件载荷。
 * 撕下窗口在监听器注册完成后向主窗口发送此事件。
 * 主窗口据此立即推送当前快照，确保首帧渲染无延迟。
 */
export interface DetachedNoteReadyPayload {
  noteId: string;
}

/**
 * 主题同步事件载荷。
 * 主窗口向撕下窗口发送当前主题计算结果，保证独立 WebView 的 dark class 与便签材质同步。
 */
export interface DetachedNoteThemePayload {
  themeMode: ThemeMode;
  isDark: boolean;
}

/** 撕下窗口事件名常量 */
export const DETACHED_NOTE_EVENTS = {
  SNAPSHOT: 'detached-note:snapshot',
  MISSING: 'detached-note:missing',
  LOCATE: 'detached-note:locate',
  CLOSED: 'detached-note:closed',
  SHOW_ALL: 'detached-note:show-all',
  READY: 'detached-note:ready',
  THEME: 'detached-note:theme',
} as const;
