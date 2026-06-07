import { invoke } from '@tauri-apps/api/core';

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
