import { invoke } from '@tauri-apps/api/core';

// ---------------------------------------------------------------------------
// 类型定义（与 Rust serde camelCase 序列化对齐）
// ---------------------------------------------------------------------------

export type ScheduledRemoteBackupFrequency =
  | 'every-6-hours'
  | 'every-12-hours'
  | 'daily'
  | 'weekly';

export interface ScheduledRemoteBackupConfig {
  readonly enabled: boolean;
  readonly frequency: ScheduledRemoteBackupFrequency;
  readonly quietPeriodMinutes: number;
  readonly exitPromptEnabled: boolean;
  readonly retentionEnabled: boolean;
  readonly retentionCount: number | null;
}

export type RemoteBackupTrigger =
  | 'manual'
  | 'scheduled-interval'
  | 'quiet-period'
  | 'before-exit';

export type RemoteBackupStage =
  | 'config'
  | 'credential'
  | 'single-flight'
  | 'restore-blocked'
  | 'flush'
  | 'create-zip'
  | 'upload'
  | 'list-refresh'
  | 'completed'
  | 'unknown';

export interface ScheduledRemoteBackupState {
  readonly lastStartedAt: number | null;
  readonly lastFinishedAt: number | null;
  readonly lastTrigger: RemoteBackupTrigger | null;
  readonly lastAutomaticSuccessAt: number | null;
  readonly lastManualSuccessAt: number | null;
  readonly lastFailureAt: number | null;
  readonly lastFailureReason: string | null;
  readonly lastFailureStage: RemoteBackupStage | null;
  readonly lastRemoteFileName: string | null;
  readonly nextRunAt: number | null;
  readonly lastSuccessfulStorageUpdatedAt: number | null;
  readonly lastAttemptCapturedStorageUpdatedAt: number | null;
  readonly consecutiveCredentialFailures: number;
  readonly credentialActionRequired: boolean;
  readonly cliffDropDetectedAt: number | null;
  readonly baselineConfirmedRemoteCount: number | null;
  readonly baselineConfirmedBoardCount: number | null;
  readonly baselineConfirmedImageNoteCount: number | null;
  readonly baselineConfirmedImageFileCount: number | null;
  readonly baselineConfirmedImageFileTotalBytes: number | null;
  readonly cliffDropDeferred: boolean;
  readonly cliffDropLatestSummaryNoteCount: number | null;
  readonly cliffDropLatestSummaryBoardCount: number | null;
  readonly cliffDropLatestSummaryImageNoteCount: number | null;
  readonly cliffDropLatestSummaryImageFileCount: number | null;
  readonly cliffDropLatestSummaryImageFileTotalBytes: number | null;
  readonly pendingCleanupTargetCount: number | null;
  readonly lastRetentionCleanupDeletedCount: number | null;
  readonly lastRetentionCleanupFailedFileName: string | null;
  readonly lastRetentionCleanupError: string | null;
  readonly lastRetentionCleanupAt: number | null;
}

// ---------------------------------------------------------------------------
// 加载/保存结果类型
// ---------------------------------------------------------------------------

export interface ScheduledBackupConfigLoadResult {
  readonly success: boolean;
  readonly config: ScheduledRemoteBackupConfig | null;
  readonly error: string | null;
}

export interface ScheduledBackupConfigSaveResult {
  readonly success: boolean;
  readonly error: string | null;
}

export interface ScheduledBackupStateLoadResult {
  readonly success: boolean;
  readonly state: ScheduledRemoteBackupState | null;
  readonly error: string | null;
}

export interface ScheduledBackupStateSaveResult {
  readonly success: boolean;
  readonly error: string | null;
}

// ---------------------------------------------------------------------------
// 合法频率值集合
// ---------------------------------------------------------------------------

const VALID_FREQUENCIES: ReadonlySet<ScheduledRemoteBackupFrequency> = new Set([
  'every-6-hours',
  'every-12-hours',
  'daily',
  'weekly',
]);

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------

export const DEFAULT_SCHEDULED_BACKUP_CONFIG: Readonly<ScheduledRemoteBackupConfig> = {
  enabled: false,
  frequency: 'daily',
  quietPeriodMinutes: 5,
  exitPromptEnabled: true,
  retentionEnabled: false,
  retentionCount: null,
} as const;

export const DEFAULT_SCHEDULED_BACKUP_STATE: Readonly<ScheduledRemoteBackupState> = {
  lastStartedAt: null,
  lastFinishedAt: null,
  lastTrigger: null,
  lastAutomaticSuccessAt: null,
  lastManualSuccessAt: null,
  lastFailureAt: null,
  lastFailureReason: null,
  lastFailureStage: null,
  lastRemoteFileName: null,
  nextRunAt: null,
  lastSuccessfulStorageUpdatedAt: null,
  lastAttemptCapturedStorageUpdatedAt: null,
  consecutiveCredentialFailures: 0,
  credentialActionRequired: false,
  cliffDropDetectedAt: null,
  baselineConfirmedRemoteCount: null,
  baselineConfirmedBoardCount: null,
  baselineConfirmedImageNoteCount: null,
  baselineConfirmedImageFileCount: null,
  baselineConfirmedImageFileTotalBytes: null,
  cliffDropDeferred: false,
  cliffDropLatestSummaryNoteCount: null,
  cliffDropLatestSummaryBoardCount: null,
  cliffDropLatestSummaryImageNoteCount: null,
  cliffDropLatestSummaryImageFileCount: null,
  cliffDropLatestSummaryImageFileTotalBytes: null,
  pendingCleanupTargetCount: null,
  lastRetentionCleanupDeletedCount: null,
  lastRetentionCleanupFailedFileName: null,
  lastRetentionCleanupError: null,
  lastRetentionCleanupAt: null,
} as const;

// ---------------------------------------------------------------------------
// 频率校验
// ---------------------------------------------------------------------------

/**
 * 判断频率值是否合法。
 */
export function isValidFrequency(
  frequency: string,
): frequency is ScheduledRemoteBackupFrequency {
  return VALID_FREQUENCIES.has(frequency as ScheduledRemoteBackupFrequency);
}

// ---------------------------------------------------------------------------
// 状态脱敏
// ---------------------------------------------------------------------------

/**
 * 敏感字段名模式（用于防御性检查）。
 */
const SENSITIVE_PATTERNS = ['password', 'token', 'authorization'] as const;

/**
 * 检查字符串是否包含敏感信息模式。
 */
function containsSensitivePattern(value: string): boolean {
  const lower = value.toLowerCase();
  return SENSITIVE_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * 在保存状态前进行脱敏校验。
 *
 * 确保状态中不包含 password / token / Authorization 等敏感信息。
 * 如果 lastFailureReason 包含敏感模式，会被替换为通用错误信息。
 */
export function redactStateBeforeSave(
  state: ScheduledRemoteBackupState,
): ScheduledRemoteBackupState {
  let redactedReason = state.lastFailureReason;

  if (redactedReason !== null && containsSensitivePattern(redactedReason)) {
    redactedReason = '远端备份失败，请检查配置';
  }

  return {
    ...state,
    lastFailureReason: redactedReason,
  };
}

// ---------------------------------------------------------------------------
// Tauri 命令封装
// ---------------------------------------------------------------------------

/**
 * 加载定时备份配置。
 *
 * 如果文件不存在，返回默认配置（enabled=false）。
 */
export async function loadConfig(): Promise<ScheduledBackupConfigLoadResult> {
  return invoke<ScheduledBackupConfigLoadResult>(
    'scheduled_backup_load_config',
  );
}

/**
 * 保存定时备份配置。
 *
 * 使用原子写入，不包含任何密码或凭据字段。
 */
export async function saveConfig(
  config: ScheduledRemoteBackupConfig,
): Promise<ScheduledBackupConfigSaveResult> {
  return invoke<ScheduledBackupConfigSaveResult>(
    'scheduled_backup_save_config',
    { config },
  );
}

/**
 * 加载最近结果状态。
 *
 * 如果文件不存在，返回默认状态。
 */
export async function loadState(): Promise<ScheduledBackupStateLoadResult> {
  return invoke<ScheduledBackupStateLoadResult>(
    'scheduled_backup_load_state',
  );
}

/**
 * 保存最近结果状态。
 *
 * 保存前自动进行脱敏校验。
 */
export async function saveState(
  state: ScheduledRemoteBackupState,
): Promise<ScheduledBackupStateSaveResult> {
  const redacted = redactStateBeforeSave(state);
  return invoke<ScheduledBackupStateSaveResult>(
    'scheduled_backup_save_state',
    { state: redacted },
  );
}
