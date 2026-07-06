import { describe, it, expect, vi, beforeEach } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import {
  loadConfig,
  saveConfig,
  loadState,
  saveState,
  isValidFrequency,
  redactStateBeforeSave,
  DEFAULT_SCHEDULED_BACKUP_CONFIG,
  DEFAULT_SCHEDULED_BACKUP_STATE,
} from './ScheduledRemoteBackupConfigService';
import type {
  ScheduledRemoteBackupConfig,
  ScheduledRemoteBackupState,
} from './ScheduledRemoteBackupConfigService';

describe('ScheduledRemoteBackupConfigService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 默认值
  // -------------------------------------------------------------------------

  describe('默认值', () => {
    it('默认配置为 disabled', () => {
      expect(DEFAULT_SCHEDULED_BACKUP_CONFIG.enabled).toBe(false);
    });

    it('默认频率为 daily', () => {
      expect(DEFAULT_SCHEDULED_BACKUP_CONFIG.frequency).toBe('daily');
    });

    it('默认静默期为 5 分钟', () => {
      expect(DEFAULT_SCHEDULED_BACKUP_CONFIG.quietPeriodMinutes).toBe(5);
    });

    it('默认退出提示启用', () => {
      expect(DEFAULT_SCHEDULED_BACKUP_CONFIG.exitPromptEnabled).toBe(true);
    });

    it('默认状态全部为空/零值', () => {
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.lastStartedAt).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.lastFinishedAt).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.lastTrigger).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.lastAutomaticSuccessAt).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.lastManualSuccessAt).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.lastFailureAt).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.lastFailureReason).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.lastFailureStage).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.lastRemoteFileName).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.nextRunAt).toBeNull();
      expect(
        DEFAULT_SCHEDULED_BACKUP_STATE.lastSuccessfulStorageUpdatedAt,
      ).toBeNull();
      expect(
        DEFAULT_SCHEDULED_BACKUP_STATE.lastAttemptCapturedStorageUpdatedAt,
      ).toBeNull();
      expect(
        DEFAULT_SCHEDULED_BACKUP_STATE.consecutiveCredentialFailures,
      ).toBe(0);
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.credentialActionRequired).toBe(
        false,
      );
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.cliffDropDetectedAt).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.baselineConfirmedRemoteCount).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.baselineConfirmedBoardCount).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.baselineConfirmedImageNoteCount).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.baselineConfirmedImageFileCount).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.baselineConfirmedImageFileTotalBytes).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.baselineConfirmedRemoteFileName).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.baselineConfirmedConfirmedAt).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.baselineConfirmedZipSizeBytes).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.cliffDropDeferred).toBe(false);
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.cliffDropLatestSummaryNoteCount).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.cliffDropLatestSummaryBoardCount).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.cliffDropLatestSummaryImageNoteCount).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.cliffDropLatestSummaryImageFileCount).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.cliffDropLatestSummaryImageFileTotalBytes).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.cliffDropLatestRemoteFileName).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.cliffDropLatestZipSizeBytes).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.cliffDropLatestAnomalyCodes).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.pendingCleanupTargetCount).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.lastRetentionCleanupDeletedCount).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.lastRetentionCleanupFailedFileName).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.lastRetentionCleanupError).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.lastRetentionCleanupSkipped).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.lastRetentionCleanupBusy).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.lastRetentionCleanupMissingCount).toBeNull();
      expect(DEFAULT_SCHEDULED_BACKUP_STATE.lastRetentionCleanupAt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 频率校验
  // -------------------------------------------------------------------------

  describe('isValidFrequency', () => {
    it('合法频率返回 true', () => {
      expect(isValidFrequency('every-6-hours')).toBe(true);
      expect(isValidFrequency('every-12-hours')).toBe(true);
      expect(isValidFrequency('daily')).toBe(true);
      expect(isValidFrequency('weekly')).toBe(true);
    });

    it('非法频率返回 false', () => {
      expect(isValidFrequency('monthly')).toBe(false);
      expect(isValidFrequency('')).toBe(false);
      expect(isValidFrequency('DAILY')).toBe(false);
      expect(isValidFrequency('every-hour')).toBe(false);
      expect(isValidFrequency('daily ')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // loadConfig
  // -------------------------------------------------------------------------

  describe('loadConfig', () => {
    it('文件不存在时返回默认配置', async () => {
      const expected = {
        success: true,
        config: DEFAULT_SCHEDULED_BACKUP_CONFIG,
        error: null,
      };
      invokeMock.mockResolvedValueOnce(expected);

      const result = await loadConfig();

      expect(invokeMock).toHaveBeenCalledWith(
        'scheduled_backup_load_config',
      );
      expect(result.success).toBe(true);
      expect(result.config).toEqual(DEFAULT_SCHEDULED_BACKUP_CONFIG);
    });

    it('传播已保存的配置', async () => {
      const savedConfig: ScheduledRemoteBackupConfig = {
        enabled: true,
        frequency: 'every-6-hours',
        quietPeriodMinutes: 10,
        exitPromptEnabled: false,
        retentionEnabled: false,
        retentionCount: null,
      };
      const expected = {
        success: true,
        config: savedConfig,
        error: null,
      };
      invokeMock.mockResolvedValueOnce(expected);

      const result = await loadConfig();

      expect(result.success).toBe(true);
      expect(result.config?.enabled).toBe(true);
      expect(result.config?.frequency).toBe('every-6-hours');
    });

    it('传播 Rust 侧返回的解析错误', async () => {
      const failed = {
        success: false,
        config: null,
        error: '解析定时备份配置文件失败',
      };
      invokeMock.mockResolvedValueOnce(failed);

      const result = await loadConfig();

      expect(result.success).toBe(false);
      expect(result.error).toBe('解析定时备份配置文件失败');
    });
  });

  // -------------------------------------------------------------------------
  // saveConfig
  // -------------------------------------------------------------------------

  describe('saveConfig', () => {
    it('调用正确的 Tauri 命令并传递配置', async () => {
      const config: ScheduledRemoteBackupConfig = {
        enabled: true,
        frequency: 'daily',
        quietPeriodMinutes: 5,
        exitPromptEnabled: true,
        retentionEnabled: false,
        retentionCount: null,
      };
      const expected = { success: true, error: null };
      invokeMock.mockResolvedValueOnce(expected);

      const result = await saveConfig(config);

      expect(invokeMock).toHaveBeenCalledWith(
        'scheduled_backup_save_config',
        { config },
      );
      expect(result.success).toBe(true);
    });

    it('传播 Rust 侧返回的失败结果', async () => {
      const config: ScheduledRemoteBackupConfig =
        DEFAULT_SCHEDULED_BACKUP_CONFIG as ScheduledRemoteBackupConfig;
      const failed = {
        success: false,
        error: '创建临时文件失败',
      };
      invokeMock.mockResolvedValueOnce(failed);

      const result = await saveConfig(config);

      expect(result.success).toBe(false);
      expect(result.error).toBe('创建临时文件失败');
    });
  });

  // -------------------------------------------------------------------------
  // loadState
  // -------------------------------------------------------------------------

  describe('loadState', () => {
    it('文件不存在时返回默认状态', async () => {
      const expected = {
        success: true,
        state: DEFAULT_SCHEDULED_BACKUP_STATE,
        error: null,
      };
      invokeMock.mockResolvedValueOnce(expected);

      const result = await loadState();

      expect(invokeMock).toHaveBeenCalledWith(
        'scheduled_backup_load_state',
      );
      expect(result.success).toBe(true);
      expect(result.state).toEqual(DEFAULT_SCHEDULED_BACKUP_STATE);
    });

    it('传播已保存的状态', async () => {
      const savedState: ScheduledRemoteBackupState = {
        ...DEFAULT_SCHEDULED_BACKUP_STATE,
        lastAutomaticSuccessAt: 1700000060000,
        lastRemoteFileName: 'SoNotes_Backup_20260101120000.zip',
      };
      const expected = {
        success: true,
        state: savedState,
        error: null,
      };
      invokeMock.mockResolvedValueOnce(expected);

      const result = await loadState();

      expect(result.success).toBe(true);
      expect(result.state?.lastAutomaticSuccessAt).toBe(1700000060000);
      expect(result.state?.lastRemoteFileName).toBe(
        'SoNotes_Backup_20260101120000.zip',
      );
    });

    it('传播 Rust 侧返回的解析错误', async () => {
      const failed = {
        success: false,
        state: null,
        error: '解析定时备份状态文件失败',
      };
      invokeMock.mockResolvedValueOnce(failed);

      const result = await loadState();

      expect(result.success).toBe(false);
      expect(result.error).toBe('解析定时备份状态文件失败');
    });
  });

  // -------------------------------------------------------------------------
  // saveState
  // -------------------------------------------------------------------------

  describe('saveState', () => {
    it('调用正确的 Tauri 命令并传递状态', async () => {
      const state: ScheduledRemoteBackupState =
        DEFAULT_SCHEDULED_BACKUP_STATE;
      const expected = { success: true, error: null };
      invokeMock.mockResolvedValueOnce(expected);

      const result = await saveState(state);

      expect(invokeMock).toHaveBeenCalledWith(
        'scheduled_backup_save_state',
        { state },
      );
      expect(result.success).toBe(true);
    });

    it('传播 Rust 侧返回的失败结果', async () => {
      const state: ScheduledRemoteBackupState =
        DEFAULT_SCHEDULED_BACKUP_STATE;
      const failed = {
        success: false,
        error: '同步临时文件失败',
      };
      invokeMock.mockResolvedValueOnce(failed);

      const result = await saveState(state);

      expect(result.success).toBe(false);
      expect(result.error).toBe('同步临时文件失败');
    });
  });

  // -------------------------------------------------------------------------
  // redactStateBeforeSave
  // -------------------------------------------------------------------------

  describe('redactStateBeforeSave', () => {
    it('无敏感信息时原样返回', () => {
      const state: ScheduledRemoteBackupState = {
        ...DEFAULT_SCHEDULED_BACKUP_STATE,
        lastFailureReason: '网络连接失败',
      };

      const redacted = redactStateBeforeSave(state);

      expect(redacted.lastFailureReason).toBe('网络连接失败');
    });

    it('脱敏包含 password 的失败原因', () => {
      const state: ScheduledRemoteBackupState = {
        ...DEFAULT_SCHEDULED_BACKUP_STATE,
        lastFailureReason: 'password verification failed',
      };

      const redacted = redactStateBeforeSave(state);

      expect(redacted.lastFailureReason).toBe('远端备份失败，请检查配置');
    });

    it('脱敏包含 token 的失败原因', () => {
      const state: ScheduledRemoteBackupState = {
        ...DEFAULT_SCHEDULED_BACKUP_STATE,
        lastFailureReason: 'token expired or invalid',
      };

      const redacted = redactStateBeforeSave(state);

      expect(redacted.lastFailureReason).toBe('远端备份失败，请检查配置');
    });

    it('脱敏包含 authorization 的失败原因', () => {
      const state: ScheduledRemoteBackupState = {
        ...DEFAULT_SCHEDULED_BACKUP_STATE,
        lastFailureReason: 'authorization header missing',
      };

      const redacted = redactStateBeforeSave(state);

      expect(redacted.lastFailureReason).toBe('远端备份失败，请检查配置');
    });

    it('脱敏包含 URL 的失败原因', () => {
      const state: ScheduledRemoteBackupState = {
        ...DEFAULT_SCHEDULED_BACKUP_STATE,
        lastFailureReason: 'WebDAV 连接失败：https://dav.example.com/remote.php/dav/files/alice',
      };

      const redacted = redactStateBeforeSave(state);

      expect(redacted.lastFailureReason).toBe('WebDAV 连接失败：[URL_REDACTED]');
    });

    it('脱敏包含本地路径的失败原因', () => {
      const state: ScheduledRemoteBackupState = {
        ...DEFAULT_SCHEDULED_BACKUP_STATE,
        lastFailureReason: '读取失败 C:\\Users\\alice\\backup.zip',
      };

      const redacted = redactStateBeforeSave(state);

      expect(redacted.lastFailureReason).toBe('读取失败 [REDACTED]');
    });

    it('脱敏保留清理错误中的 URL 和本地路径', () => {
      const state: ScheduledRemoteBackupState = {
        ...DEFAULT_SCHEDULED_BACKUP_STATE,
        lastRetentionCleanupError: '删除 https://dav.example.com/backups/old.zip 失败，缓存 C:\\Temp\\old.zip',
      };

      const redacted = redactStateBeforeSave(state);

      expect(redacted.lastRetentionCleanupError).toBe('删除 [URL_REDACTED] 失败，缓存 [REDACTED]');
    });

    it('敏感关键词优先使用通用失败原因', () => {
      const state: ScheduledRemoteBackupState = {
        ...DEFAULT_SCHEDULED_BACKUP_STATE,
        lastFailureReason: 'password leaked at https://dav.example.com/path',
      };

      const redacted = redactStateBeforeSave(state);

      expect(redacted.lastFailureReason).toBe('远端备份失败，请检查配置');
    });

    it('null 失败原因保持 null', () => {
      const state: ScheduledRemoteBackupState = {
        ...DEFAULT_SCHEDULED_BACKUP_STATE,
        lastFailureReason: null,
      };

      const redacted = redactStateBeforeSave(state);

      expect(redacted.lastFailureReason).toBeNull();
    });

    it('不修改其他字段', () => {
      const state: ScheduledRemoteBackupState = {
        ...DEFAULT_SCHEDULED_BACKUP_STATE,
        lastStartedAt: 1700000000000,
        lastAutomaticSuccessAt: 1700000060000,
        consecutiveCredentialFailures: 3,
        credentialActionRequired: true,
      };

      const redacted = redactStateBeforeSave(state);

      expect(redacted.lastStartedAt).toBe(1700000000000);
      expect(redacted.lastAutomaticSuccessAt).toBe(1700000060000);
      expect(redacted.consecutiveCredentialFailures).toBe(3);
      expect(redacted.credentialActionRequired).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 保存状态不含敏感字段
  // -------------------------------------------------------------------------

  describe('保存状态不含敏感字段', () => {
    it('默认状态序列化不包含 password/token/authorization', () => {
      const json = JSON.stringify(DEFAULT_SCHEDULED_BACKUP_STATE);
      expect(json).not.toContain('password');
      expect(json).not.toContain('token');
      expect(json).not.toContain('authorization');
    });

    it('典型状态序列化不包含敏感字段', () => {
      const state: ScheduledRemoteBackupState = {
        ...DEFAULT_SCHEDULED_BACKUP_STATE,
        lastFailureReason: '凭据错误',
        lastRemoteFileName: 'SoNotes_Backup_20260101120000.zip',
      };
      const json = JSON.stringify(state);

      expect(json).not.toContain('password');
      expect(json).not.toContain('token');
      expect(json).not.toContain('authorization');
    });

    it('默认配置序列化不包含敏感字段', () => {
      const json = JSON.stringify(DEFAULT_SCHEDULED_BACKUP_CONFIG);
      expect(json).not.toContain('password');
      expect(json).not.toContain('token');
      expect(json).not.toContain('authorization');
    });
  });
});
