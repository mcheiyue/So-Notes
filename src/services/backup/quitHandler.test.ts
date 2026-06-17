import { describe, it, expect, vi } from 'vitest';
import {
  shouldPromptExitBackup,
  handleQuitRequest,
  getLatestBackupSuccessAt,
  type QuitHandlerDeps,
} from './quitHandler';
import type {
  ScheduledBackupConfigLoadResult,
  ScheduledBackupStateLoadResult,
  ScheduledRemoteBackupState,
} from './ScheduledRemoteBackupConfigService';
import type { WebDavConfigLoadResult } from './WebDavBackupService';
import type { StorageData } from '../../store/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScheduledConfigResult(
  overrides?: Partial<ScheduledBackupConfigLoadResult>,
): ScheduledBackupConfigLoadResult {
  return {
    success: true,
    config: {
      enabled: true,
      frequency: 'daily',
      quietPeriodMinutes: 5,
      exitPromptEnabled: true,
      retentionEnabled: false,
      retentionCount: null,
    },
    error: null,
    ...overrides,
  };
}

function makeWebDavConfigResult(
  overrides?: Partial<WebDavConfigLoadResult>,
): WebDavConfigLoadResult {
  return {
    success: true,
    serverUrl: 'https://example.com/dav',
    username: 'user',
    remoteDir: 'SoNotes_Backups/',
    passwordSaved: true,
    ...overrides,
  };
}

function makeScheduledStateResult(
  overrides?: Partial<ScheduledRemoteBackupState>,
): ScheduledBackupStateLoadResult {
  return {
    success: true,
    state: {
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
      ...overrides,
    },
    error: null,
  };
}

function makeStorageData(overrides?: Partial<StorageData>): StorageData {
  return {
    schemaVersion: 2,
    storageUpdatedAt: 1000,
    notes: [],
    boards: [],
    currentBoardId: 'default',
    config: { version: 2, maxZ: 1, themeMode: 'system' },
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<QuitHandlerDeps>): QuitHandlerDeps {
  return {
    loadScheduledConfig: vi.fn().mockResolvedValue(makeScheduledConfigResult()),
    loadScheduledState: vi.fn().mockResolvedValue(makeScheduledStateResult()),
    loadWebDavConfig: vi.fn().mockResolvedValue(makeWebDavConfigResult()),
    readDiskStorageData: vi.fn().mockResolvedValue(makeStorageData({ storageUpdatedAt: 2000 })),
    getLatestUpdateTimestamp: vi.fn().mockReturnValue(2000),
    invoke: vi.fn().mockResolvedValue(undefined),
    promptQuitConfirm: vi.fn().mockResolvedValue('cancel' as const),
    promptBackupFailed: vi.fn().mockResolvedValue('quit-anyway' as const),
    setBackingUp: vi.fn(),
    closeDialog: vi.fn(),
    runBeforeExit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// shouldPromptExitBackup
// ---------------------------------------------------------------------------

describe('shouldPromptExitBackup', () => {
  it('所有条件满足时返回 true', async () => {
    const deps = makeDeps();
    const result = await shouldPromptExitBackup(deps);
    expect(result).toBe(true);
  });

  it('自动备份关闭（enabled=false）时不阻止退出提示，仍检查 exitPromptEnabled 和凭据', async () => {
    const deps = makeDeps({
      loadScheduledConfig: vi.fn().mockResolvedValue(
        makeScheduledConfigResult({
          config: {
            enabled: false,
            frequency: 'daily',
            quietPeriodMinutes: 5,
            exitPromptEnabled: true,
            retentionEnabled: false,
            retentionCount: null,
          },
        }),
      ),
    });
    const result = await shouldPromptExitBackup(deps);
    expect(result).toBe(true);
  });

  it('flushNow 返回 false 时抛出异常，让 handleQuitRequest 进入备份失败流程', async () => {
    const deps = makeDeps({
      flushNow: vi.fn().mockResolvedValue(false),
    });
    await expect(shouldPromptExitBackup(deps)).rejects.toThrow('flush 失败');
  });

  it('exitPromptEnabled 为 false 时返回 false', async () => {
    const deps = makeDeps({
      loadScheduledConfig: vi.fn().mockResolvedValue(
        makeScheduledConfigResult({
          config: {
            enabled: true,
            frequency: 'daily',
            quietPeriodMinutes: 5,
            exitPromptEnabled: false,
            retentionEnabled: false,
            retentionCount: null,
          },
        }),
      ),
    });
    const result = await shouldPromptExitBackup(deps);
    expect(result).toBe(false);
  });

  it('WebDAV 未配置（serverUrl 为空）时返回 false', async () => {
    const deps = makeDeps({
      loadWebDavConfig: vi.fn().mockResolvedValue(
        makeWebDavConfigResult({ serverUrl: '' }),
      ),
    });
    const result = await shouldPromptExitBackup(deps);
    expect(result).toBe(false);
  });

  it('passwordSaved 为 false 时返回 false', async () => {
    const deps = makeDeps({
      loadWebDavConfig: vi.fn().mockResolvedValue(
        makeWebDavConfigResult({ passwordSaved: false }),
      ),
    });
    const result = await shouldPromptExitBackup(deps);
    expect(result).toBe(false);
  });

  it('scheduled config 加载失败时返回 false', async () => {
    const deps = makeDeps({
      loadScheduledConfig: vi.fn().mockResolvedValue(
        makeScheduledConfigResult({ success: false, config: null, error: '读取失败' }),
      ),
    });
    const result = await shouldPromptExitBackup(deps);
    expect(result).toBe(false);
  });

  it('WebDAV config 加载失败时返回 false', async () => {
    const deps = makeDeps({
      loadWebDavConfig: vi.fn().mockResolvedValue(
        makeWebDavConfigResult({ success: false, passwordSaved: false }),
      ),
    });
    const result = await shouldPromptExitBackup(deps);
    expect(result).toBe(false);
  });

  it('配置加载抛出异常时返回 false', async () => {
    const deps = makeDeps({
      loadScheduledConfig: vi.fn().mockRejectedValue(new Error('网络错误')),
    });
    const result = await shouldPromptExitBackup(deps);
    expect(result).toBe(false);
  });

  it('serverUrl 只有空白字符时返回 false', async () => {
    const deps = makeDeps({
      loadWebDavConfig: vi.fn().mockResolvedValue(
        makeWebDavConfigResult({ serverUrl: '   ' }),
      ),
    });
    const result = await shouldPromptExitBackup(deps);
    expect(result).toBe(false);
  });

  it('无本地变化且刚备份完 → 不提示', async () => {
    const diskData = makeStorageData({ storageUpdatedAt: 1000 });
    const deps = makeDeps({
      loadScheduledState: vi.fn().mockResolvedValue(
        makeScheduledStateResult({
          lastSuccessfulStorageUpdatedAt: 1000,
          lastAutomaticSuccessAt: 1000,
        }),
      ),
      readDiskStorageData: vi.fn().mockResolvedValue(diskData),
      getLatestUpdateTimestamp: vi.fn().mockReturnValue(1000),
    });
    const result = await shouldPromptExitBackup(deps);
    expect(result).toBe(false);
  });

  it('有本地未备份变化 → 提示', async () => {
    const diskData = makeStorageData({ storageUpdatedAt: 2000 });
    const deps = makeDeps({
      loadScheduledState: vi.fn().mockResolvedValue(
        makeScheduledStateResult({
          lastSuccessfulStorageUpdatedAt: 1000,
          lastAutomaticSuccessAt: 1000,
        }),
      ),
      readDiskStorageData: vi.fn().mockResolvedValue(diskData),
      getLatestUpdateTimestamp: vi.fn().mockReturnValue(2000),
    });
    const result = await shouldPromptExitBackup(deps);
    expect(result).toBe(true);
  });

  it('无未备份变化但距上次成功超过阈值 → 不提示', async () => {
    const diskData = makeStorageData({ storageUpdatedAt: 1000 });
    const deps = makeDeps({
      loadScheduledState: vi.fn().mockResolvedValue(
        makeScheduledStateResult({
          lastSuccessfulStorageUpdatedAt: 1000,
          lastAutomaticSuccessAt: 1000,
        }),
      ),
      readDiskStorageData: vi.fn().mockResolvedValue(diskData),
      getLatestUpdateTimestamp: vi.fn().mockReturnValue(1000),
    });
    const result = await shouldPromptExitBackup(deps);
    expect(result).toBe(false);
  });

  it('从未备份过但有数据 → 提示', async () => {
    const diskData = makeStorageData({ storageUpdatedAt: 5000 });
    const deps = makeDeps({
      loadScheduledState: vi.fn().mockResolvedValue(
        makeScheduledStateResult({
          lastSuccessfulStorageUpdatedAt: null,
          lastAutomaticSuccessAt: null,
          lastManualSuccessAt: null,
        }),
      ),
      readDiskStorageData: vi.fn().mockResolvedValue(diskData),
      getLatestUpdateTimestamp: vi.fn().mockReturnValue(5000),
    });
    const result = await shouldPromptExitBackup(deps);
    expect(result).toBe(true);
  });

  it('state 加载失败 → 提示（保守策略）', async () => {
    const deps = makeDeps({
      loadScheduledState: vi.fn().mockResolvedValue({
        success: false,
        state: null,
        error: '读取失败',
      }),
    });
    const result = await shouldPromptExitBackup(deps);
    expect(result).toBe(true);
  });

  it('自动成功时间较旧、手动成功时间较新但磁盘快照更新 → 提示', async () => {
    const now = Date.now();
    const oneMinuteAgo = now - 60 * 1000;
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;
    const deps = makeDeps({
      loadScheduledState: vi.fn().mockResolvedValue(
        makeScheduledStateResult({
          lastAutomaticSuccessAt: twoHoursAgo,
          lastManualSuccessAt: oneMinuteAgo,
          lastSuccessfulStorageUpdatedAt: 1000,
        }),
      ),
      readDiskStorageData: vi.fn().mockResolvedValue(makeStorageData({ storageUpdatedAt: 2000 })),
      getLatestUpdateTimestamp: vi.fn().mockReturnValue(2000),
    });
    const result = await shouldPromptExitBackup(deps);
    expect(result).toBe(true);
  });

  it('读盘前调用 flushNow 确保 debounce 数据已持久化', async () => {
    const flushNow = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({ flushNow });
    await shouldPromptExitBackup(deps);
    expect(flushNow).toHaveBeenCalledOnce();
  });

  it('flushNow 未提供时正常执行（不抛异常）', async () => {
    const deps = makeDeps({ flushNow: undefined });
    const result = await shouldPromptExitBackup(deps);
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getLatestBackupSuccessAt
// ---------------------------------------------------------------------------

describe('getLatestBackupSuccessAt', () => {
  it('两者均为 null → null', () => {
    expect(getLatestBackupSuccessAt({ lastAutomaticSuccessAt: null, lastManualSuccessAt: null })).toBeNull();
  });

  it('仅自动成功 → 返回自动', () => {
    expect(getLatestBackupSuccessAt({ lastAutomaticSuccessAt: 100, lastManualSuccessAt: null })).toBe(100);
  });

  it('仅手动成功 → 返回手动', () => {
    expect(getLatestBackupSuccessAt({ lastAutomaticSuccessAt: null, lastManualSuccessAt: 200 })).toBe(200);
  });

  it('自动较新 → 返回自动', () => {
    expect(getLatestBackupSuccessAt({ lastAutomaticSuccessAt: 300, lastManualSuccessAt: 100 })).toBe(300);
  });

  it('手动较新 → 返回手动', () => {
    expect(getLatestBackupSuccessAt({ lastAutomaticSuccessAt: 100, lastManualSuccessAt: 300 })).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// handleQuitRequest
// ---------------------------------------------------------------------------

describe('handleQuitRequest', () => {
  describe('不需要退出前备份 → 直接退出', () => {
    it('条件不满足时直接调用 confirm_app_quit', async () => {
      const deps = makeDeps({
        loadScheduledConfig: vi.fn().mockResolvedValue(
          makeScheduledConfigResult({
            config: {
              enabled: true,
              frequency: 'daily',
              quietPeriodMinutes: 5,
              exitPromptEnabled: false,
              retentionEnabled: false,
              retentionCount: null,
            },
          }),
        ),
      });
      const runBeforeExit = vi.fn();

      await handleQuitRequest(runBeforeExit, deps);

      expect(deps.invoke).toHaveBeenCalledWith('confirm_app_quit');
      expect(deps.promptQuitConfirm).not.toHaveBeenCalled();
      expect(runBeforeExit).not.toHaveBeenCalled();
    });
  });

  describe('需要退出前备份 → 弹出确认', () => {
    it('用户选择"取消" → 不退出', async () => {
      const deps = makeDeps({
        promptQuitConfirm: vi.fn().mockResolvedValue('cancel' as const),
      });
      const runBeforeExit = vi.fn();

      await handleQuitRequest(runBeforeExit, deps);

      expect(deps.invoke).not.toHaveBeenCalled();
      expect(runBeforeExit).not.toHaveBeenCalled();
    });

    it('用户选择"直接退出" → 调用 confirm_app_quit', async () => {
      const deps = makeDeps({
        promptQuitConfirm: vi.fn().mockResolvedValue('quit-now' as const),
      });
      const runBeforeExit = vi.fn();

      await handleQuitRequest(runBeforeExit, deps);

      expect(deps.invoke).toHaveBeenCalledWith('confirm_app_quit');
      expect(runBeforeExit).not.toHaveBeenCalled();
    });

    it('用户选择"先备份再退出" → 执行备份后退出', async () => {
      const deps = makeDeps({
        promptQuitConfirm: vi.fn().mockResolvedValue('backup-and-quit' as const),
      });
      const runBeforeExit = vi.fn().mockResolvedValue(undefined);

      await handleQuitRequest(runBeforeExit, deps);

      expect(deps.setBackingUp).toHaveBeenCalledWith(true);
      expect(runBeforeExit).toHaveBeenCalledOnce();
      expect(deps.closeDialog).toHaveBeenCalled();
      expect(deps.invoke).toHaveBeenCalledWith('confirm_app_quit');
    });

    it('备份失败后提示用户决定是否退出', async () => {
      const promptBackupFailed = vi.fn().mockResolvedValue('cancel' as const);
      const deps = makeDeps({
        promptQuitConfirm: vi.fn().mockResolvedValue('backup-and-quit' as const),
        promptBackupFailed,
      });
      const runBeforeExit = vi.fn().mockRejectedValue(new Error('WebDAV 连接超时'));

      await handleQuitRequest(runBeforeExit, deps);

      expect(deps.setBackingUp).toHaveBeenCalledWith(true);
      expect(runBeforeExit).toHaveBeenCalledOnce();
      expect(promptBackupFailed).toHaveBeenCalledWith('WebDAV 连接超时');
      // 用户选择取消 → 不退出
      expect(deps.closeDialog).not.toHaveBeenCalled();
      expect(deps.invoke).not.toHaveBeenCalledWith('confirm_app_quit');
    });

    it('备份失败后用户选择"仍然退出" → 关闭对话框并退出', async () => {
      const promptBackupFailed = vi.fn().mockResolvedValue('quit-anyway' as const);
      const deps = makeDeps({
        promptQuitConfirm: vi.fn().mockResolvedValue('backup-and-quit' as const),
        promptBackupFailed,
      });
      const runBeforeExit = vi.fn().mockRejectedValue(new Error('超时'));

      await handleQuitRequest(runBeforeExit, deps);

      expect(deps.setBackingUp).toHaveBeenCalledWith(true);
      expect(deps.setBackingUp).toHaveBeenCalledWith(false);
      expect(promptBackupFailed).toHaveBeenCalledWith('超时');
      expect(deps.closeDialog).toHaveBeenCalled();
      expect(deps.invoke).toHaveBeenCalledWith('confirm_app_quit');
    });

    it('shouldPromptExitBackup 抛出异常（flush 失败）→ 进入备份失败确认流程', async () => {
      const promptBackupFailed = vi.fn().mockResolvedValue('cancel' as const);
      const deps = makeDeps({
        flushNow: vi.fn().mockResolvedValue(false),
        promptBackupFailed,
      });

      await handleQuitRequest(vi.fn(), deps);

      expect(promptBackupFailed).toHaveBeenCalledWith('flush 失败，无法确认磁盘数据完整性');
      expect(deps.invoke).not.toHaveBeenCalledWith('confirm_app_quit');
    });

    it('shouldPromptExitBackup 抛出异常后用户选择"仍然退出" → 退出', async () => {
      const promptBackupFailed = vi.fn().mockResolvedValue('quit-anyway' as const);
      const deps = makeDeps({
        flushNow: vi.fn().mockResolvedValue(false),
        promptBackupFailed,
      });

      await handleQuitRequest(vi.fn(), deps);

      expect(promptBackupFailed).toHaveBeenCalled();
      expect(deps.invoke).toHaveBeenCalledWith('confirm_app_quit');
    });
  });
});
