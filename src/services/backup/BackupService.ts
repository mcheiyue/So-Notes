import { invoke } from '@tauri-apps/api/core';

// ---------------------------------------------------------------------------
// 验证结果类型（与 Rust serde camelCase 序列化对齐）
// ---------------------------------------------------------------------------

export interface BackupValidationIssue {
  readonly code: string;
  readonly severity: string;
  readonly message: string;
  readonly target?: string;
  readonly path?: string;
  readonly noteId?: string;
  readonly imageFileId?: string;
}

export interface BackupSummary {
  readonly app: string;
  readonly formatVersion: number;
  readonly appVersion: string;
  readonly createdAt: number;
  readonly noteCount: number;
  readonly boardCount: number;
  readonly textNoteCount: number;
  readonly imageNoteCount: number;
  readonly trashNoteCount: number;
  readonly imageFileCount: number;
  readonly imageFileTotalBytes: number;
}

/**
 * 备份验证结果。
 *
 * `summary` 使用 `| null` 而非 `?:`，因为 Rust `Option<None>` 经 serde 序列化
 * 后为 JSON `null`，而非缺失字段；`| null` 能精确反映这一行为。
 */
export interface BackupValidationResult {
  readonly ok: boolean;
  readonly summary: BackupSummary | null;
  readonly errors: BackupValidationIssue[];
  readonly warnings: BackupValidationIssue[];
}

// ---------------------------------------------------------------------------
// 备份 / 恢复结果类型
// ---------------------------------------------------------------------------

export interface BackupResult {
  readonly success: boolean;
  readonly backupPath?: string;
  readonly noteCount: number;
  readonly boardCount: number;
  readonly attachmentCount: number;
  readonly error?: string;
}

export interface RestoreResult {
  readonly success: boolean;
  readonly noteCount: number;
  readonly boardCount: number;
  readonly attachmentCount: number;
  readonly error?: string;
}

export async function createLocalBackup(targetPath: string): Promise<BackupResult> {
  return invoke<BackupResult>('create_local_backup', { targetPath });
}

export async function restoreLocalBackup(sourceZipPath: string): Promise<RestoreResult> {
  return invoke<RestoreResult>('restore_local_backup', { sourceZipPath });
}

export async function validateLocalBackup(
  sourceZipPath: string,
): Promise<BackupValidationResult> {
  return invoke<BackupValidationResult>('validate_local_backup', { sourceZipPath });
}
