import { invoke } from '@tauri-apps/api/core';

// ---------------------------------------------------------------------------
// 类型定义（与 Rust serde camelCase 序列化对齐）
// ---------------------------------------------------------------------------

export interface WebDavConfig {
  readonly serverUrl: string;
  readonly username: string;
  readonly remoteDir?: string;
  readonly password?: string;
}

export interface WebDavConfigSaveRequest {
  readonly serverUrl: string;
  readonly username: string;
  readonly remoteDir?: string;
  readonly rememberPassword: boolean;
  readonly password?: string;
}

export interface WebDavConfigLoadResult {
  readonly success: boolean;
  readonly serverUrl?: string | null;
  readonly username?: string | null;
  readonly remoteDir?: string | null;
  readonly passwordSaved: boolean;
  readonly error?: string;
}

export interface WebDavConfigSaveResult {
  readonly success: boolean;
  readonly error?: string;
  readonly warning?: string;
}

export interface WebDavConfigClearResult {
  readonly success: boolean;
  readonly error?: string;
}

export interface WebDavConnectionResult {
  readonly success: boolean;
  readonly error?: string;
}

export interface WebDavRemoteBackup {
  readonly fileName: string;
  readonly size?: number | null;
  readonly lastModified?: string | null;
  readonly status?: number | null;
  readonly readable: boolean;
}

export interface WebDavUploadResult {
  readonly success: boolean;
  readonly remoteFileName?: string | null;
  readonly error?: string;
}

export interface WebDavDownloadResult {
  readonly success: boolean;
  readonly downloadToken?: string | null;
  readonly error?: string;
}

export interface LocalBackupPathResult {
  readonly success: boolean;
  readonly localPath?: string | null;
  readonly error?: string;
}

export interface WebDavCleanupResult {
  readonly success: boolean;
  readonly error?: string;
}

export interface WebDavDeleteResult {
  readonly success: boolean;
  readonly error?: string | null;
}

// ---------------------------------------------------------------------------
// 配置管理
// ---------------------------------------------------------------------------

export async function loadConfig(): Promise<WebDavConfigLoadResult> {
  return invoke<WebDavConfigLoadResult>('webdav_load_config');
}

export async function saveConfig(
  config: WebDavConfigSaveRequest,
): Promise<WebDavConfigSaveResult> {
  return invoke<WebDavConfigSaveResult>('webdav_save_config', { request: config });
}

export async function clearConfig(): Promise<WebDavConfigClearResult> {
  return invoke<WebDavConfigClearResult>('webdav_clear_config');
}

// ---------------------------------------------------------------------------
// 连接测试
// ---------------------------------------------------------------------------

export async function testConnection(
  config: WebDavConfig,
): Promise<WebDavConnectionResult> {
  return invoke<WebDavConnectionResult>('webdav_test_connection', { config });
}

// ---------------------------------------------------------------------------
// 远端备份操作
// ---------------------------------------------------------------------------

export async function createRemoteBackup(
  config: WebDavConfig,
): Promise<WebDavUploadResult> {
  return invoke<WebDavUploadResult>('webdav_create_remote_backup', { config });
}

export async function listBackups(
  config: WebDavConfig,
): Promise<WebDavRemoteBackup[]> {
  return invoke<WebDavRemoteBackup[]>('webdav_list_backups', { config });
}

export async function downloadBackup(
  config: WebDavConfig,
  remoteFileName: string,
): Promise<WebDavDownloadResult> {
  return invoke<WebDavDownloadResult>('webdav_download_backup', {
    config,
    remoteFileName,
  });
}

export async function deleteBackup(
  config: WebDavConfig,
  remoteFileName: string,
): Promise<WebDavDeleteResult> {
  return invoke<WebDavDeleteResult>('webdav_delete_backup', {
    config,
    remoteFileName,
  });
}

// ---------------------------------------------------------------------------
// 下载 Token 生命周期
// ---------------------------------------------------------------------------

export async function resolveDownloadedBackup(
  downloadToken: string,
): Promise<LocalBackupPathResult> {
  return invoke<LocalBackupPathResult>('resolve_downloaded_backup', {
    downloadToken,
  });
}

export async function cleanupDownloadedBackup(
  downloadToken: string,
): Promise<WebDavCleanupResult> {
  return invoke<WebDavCleanupResult>('cleanup_downloaded_backup', {
    downloadToken,
  });
}
