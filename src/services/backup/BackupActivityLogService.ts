import { invoke } from '@tauri-apps/api/core';
import type { BackupSummary } from './BackupService';

// ---------------------------------------------------------------------------
// 类型定义（与 Rust serde camelCase 序列化对齐）
// ---------------------------------------------------------------------------

export type BackupActivityOperation =
  | 'local-backup'
  | 'local-restore'
  | 'remote-backup'
  | 'remote-list'
  | 'remote-delete'
  | 'remote-restore'
  | 'scheduled-remote-backup'
  | 'retention-cleanup'
  | 'retention-cliff-drop'
  | 'credential-status';

export type BackupActivityStatus =
  | 'success'
  | 'failed'
  | 'skipped'
  | 'partial'
  | 'cancelled';

export type BackupActivityLevel =
  | 'info'
  | 'warning'
  | 'error';

export interface BackupActivitySummary {
  readonly noteCount?: number | null;
  readonly boardCount?: number | null;
  readonly textNoteCount?: number | null;
  readonly imageNoteCount?: number | null;
  readonly trashNoteCount?: number | null;
  readonly imageFileCount?: number | null;
  readonly imageFileTotalBytes?: number | null;
  readonly zipSizeBytes?: number | null;
}

export interface BackupActivityMetrics {
  readonly retainedCount?: number | null;
  readonly deletedCount?: number | null;
  readonly missingCount?: number | null;
  readonly attemptedCount?: number | null;
  readonly failedFileName?: string | null;
  readonly anomalyCodes?: string[] | null;
}

export interface BackupActivityEntry {
  readonly id: string;
  readonly operation: BackupActivityOperation;
  readonly status: BackupActivityStatus;
  readonly level: BackupActivityLevel;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly trigger?: string | null;
  readonly stage?: string | null;
  readonly reasonCode?: string | null;
  readonly errorCode?: string | null;
  readonly message?: string | null;
  readonly remoteFileName?: string | null;
  readonly localFileName?: string | null;
  readonly summary?: BackupActivitySummary | null;
  readonly metrics?: BackupActivityMetrics | null;
}

export interface BackupActivityAppendInput {
  readonly id?: string;
  readonly operation: BackupActivityOperation;
  readonly status: BackupActivityStatus;
  readonly level: BackupActivityLevel;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly trigger?: string | null;
  readonly stage?: string | null;
  readonly reasonCode?: string | null;
  readonly errorCode?: string | null;
  readonly message?: string | null;
  readonly remoteFileName?: string | null;
  readonly localFileName?: string | null;
  readonly summary?: BackupActivitySummary | null;
  readonly metrics?: BackupActivityMetrics | null;
}

// ---------------------------------------------------------------------------
// 脱敏与工具函数
// ---------------------------------------------------------------------------

/** 敏感词模式：keyword 后跟 :=/_ 分隔符和值，或 keyword 独立出现（后跟空格/逗号/结尾） */
const SENSITIVE_PATTERN =
  /(password|token|authorization|secret)[=:]\s*\S+|(password|token|authorization|secret)_\S+|(password|token|authorization|secret)(?=[\s,;)}\]]|$)/gi;

/** Bearer token 模式：匹配 Bearer 后面的 token 值 */
const BEARER_TOKEN_PATTERN = /(Bearer\s+)[^\s,;)}\]]{1,100}/gi;

/** URL userinfo 模式：匹配 scheme://user:pass@host */
const URL_USERINFO_PATTERN =
  /((?:https?|ftp):\/\/)([^@/]+)@/gi;

const MESSAGE_MAX_LENGTH = 240;

/**
 * 第一层脱敏：替换敏感关键词、移除 URL userinfo、截断消息。
 */
export function sanitizeActivityInput(
  input: BackupActivityAppendInput,
): BackupActivityAppendInput {
  let message = input.message;

  if (message != null) {
    // 替换 Bearer token（必须在通用敏感词之前，避免重复替换）
    message = message.replace(BEARER_TOKEN_PATTERN, '$1[REDACTED]');
    // 替换敏感关键词
    message = message.replace(SENSITIVE_PATTERN, (_match, g1, g2, g3) => {
      const keyword = (g1 ?? g2 ?? g3).toLowerCase();
      return `${keyword}=[REDACTED]`;
    });
    // 移除 URL userinfo
    message = message.replace(URL_USERINFO_PATTERN, '$1[REDACTED]@');
    // 截断
    if (message.length > MESSAGE_MAX_LENGTH) {
      message = message.slice(0, MESSAGE_MAX_LENGTH);
    }
  }

  return {
    ...input,
    message,
    localFileName: input.localFileName
      ? fileNameFromPath(input.localFileName)
      : input.localFileName,
    remoteFileName: input.remoteFileName
      ? fileNameFromPath(input.remoteFileName)
      : input.remoteFileName,
    metrics: sanitizeMetrics(input.metrics),
  };
}

/**
 * 从路径中提取 basename（最后一个路径分隔符之后的部分）。
 */
export function fileNameFromPath(path: string): string {
  const lastSeparator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return lastSeparator >= 0 ? path.slice(lastSeparator + 1) : path;
}

/**
 * 对 metrics 对象中的文件名字段进行脱敏（提取 basename）。
 */
function sanitizeMetrics(
  metrics: BackupActivityMetrics | null | undefined,
): BackupActivityMetrics | null | undefined {
  if (metrics == null) return metrics;

  return {
    ...metrics,
    failedFileName: metrics.failedFileName
      ? fileNameFromPath(metrics.failedFileName)
      : metrics.failedFileName,
  };
}

/**
 * 从 BackupSummary / BackupResult / RestoreResult 提取统计摘要。
 */
export function toBackupActivitySummary(
  source: unknown,
): BackupActivitySummary | null {
  if (source === null || source === undefined || typeof source !== 'object') {
    return null;
  }

  const obj = source as Record<string, unknown>;

  // BackupResult / RestoreResult：含 attachmentCount，优先匹配
  if ('attachmentCount' in obj) {
    const r = obj as Record<string, unknown>;
    const summary = (r.summary as BackupSummary | null) ?? null;
    if (summary) {
      return {
        noteCount: summary.noteCount ?? null,
        boardCount: summary.boardCount ?? null,
        textNoteCount: summary.textNoteCount ?? null,
        imageNoteCount: summary.imageNoteCount ?? null,
        trashNoteCount: summary.trashNoteCount ?? null,
        imageFileCount: summary.imageFileCount ?? null,
        imageFileTotalBytes: summary.imageFileTotalBytes ?? null,
      };
    }
    return {
      noteCount: typeof r.noteCount === 'number' ? r.noteCount : null,
      boardCount: typeof r.boardCount === 'number' ? r.boardCount : null,
      imageFileCount: typeof r.attachmentCount === 'number' ? r.attachmentCount : null,
    };
  }

  // BackupSummary（含 noteCount 但无 attachmentCount）
  if ('noteCount' in obj) {
    const s = obj as Record<string, unknown>;
    return {
      noteCount: typeof s.noteCount === 'number' ? s.noteCount : null,
      boardCount: typeof s.boardCount === 'number' ? s.boardCount : null,
      textNoteCount: typeof s.textNoteCount === 'number' ? s.textNoteCount : null,
      imageNoteCount: typeof s.imageNoteCount === 'number' ? s.imageNoteCount : null,
      trashNoteCount: typeof s.trashNoteCount === 'number' ? s.trashNoteCount : null,
      imageFileCount: typeof s.imageFileCount === 'number' ? s.imageFileCount : null,
      imageFileTotalBytes:
        typeof s.imageFileTotalBytes === 'number' ? s.imageFileTotalBytes : null,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Rust 命令封装
// ---------------------------------------------------------------------------

/**
 * 加载最近活动（默认 10 条）。
 */
export async function loadRecentActivities(
  limit?: number,
): Promise<BackupActivityEntry[]> {
  return invoke<BackupActivityEntry[]>('backup_activity_list', { limit });
}

/**
 * 追加活动记录（自动生成 id，第一层脱敏）。
 * 失败时吞掉错误并 console.warn，不抛出。
 */
export async function appendBackupActivity(
  input: BackupActivityAppendInput,
): Promise<void> {
  try {
    const sanitized = sanitizeActivityInput(input);
    const entry: BackupActivityEntry = {
      ...sanitized,
      id: sanitized.id ?? crypto.randomUUID(),
    };
    await invoke<void>('backup_activity_append', { entry });
  } catch (err: unknown) {
    console.warn(
      '[BackupActivityLog] appendBackupActivity failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * 清空活动日志。
 */
export async function clearBackupActivities(): Promise<void> {
  return invoke<void>('backup_activity_clear');
}
