/**
 * 定时远端备份服务。
 *
 * 管理定时远端备份的调度、触发和状态追踪。支持固定频率触发
 * 和安静时段触发，使用注入的时钟/定时器实现可测试性，
 * 并提供凭据失败追踪和无本地变更检测。
 */

import type {
  ScheduledRemoteBackupConfig,
  ScheduledRemoteBackupState,
  ScheduledRemoteBackupFrequency,
  RemoteBackupTrigger,
  RemoteBackupStage,
  ScheduledBackupConfigLoadResult,
  ScheduledBackupConfigSaveResult,
  ScheduledBackupStateLoadResult,
  ScheduledBackupStateSaveResult,
} from './ScheduledRemoteBackupConfigService';
import {
  DEFAULT_SCHEDULED_BACKUP_CONFIG,
  DEFAULT_SCHEDULED_BACKUP_STATE,
} from './ScheduledRemoteBackupConfigService';
import {
  runRemoteBackup,
  type RemoteBackupRunnerDependencies,
} from './RemoteBackupRunner';
import type { BackupJobKind } from './BackupJobCoordinator';
import type {
  WebDavConfigLoadResult,
} from './WebDavBackupService';
import type { StorageData } from '../../store/types';

// ---------------------------------------------------------------------------
// 模块级服务实例 accessor
// ---------------------------------------------------------------------------

/**
 * 模块级服务实例引用。
 *
 * ScheduledRemoteBackupController 在挂载时注册，卸载时注销。
 * BoardDock 等外部组件通过 getSchedulerService() 获取实例，
 * 用于在配置变更后调用 updateConfig() 即时生效。
 */
let _schedulerService: ReturnType<typeof createScheduledRemoteBackupService> | null = null;

export function registerSchedulerService(
  service: ReturnType<typeof createScheduledRemoteBackupService>,
): void {
  _schedulerService = service;
}

export function unregisterSchedulerService(): void {
  _schedulerService = null;
}

export function getSchedulerService():
  | ReturnType<typeof createScheduledRemoteBackupService>
  | null {
  return _schedulerService;
}

// ---------------------------------------------------------------------------
// 频率到毫秒映射
// ---------------------------------------------------------------------------

const FREQUENCY_MS: Record<ScheduledRemoteBackupFrequency, number> = {
  'every-6-hours': 6 * 60 * 60 * 1000,
  'every-12-hours': 12 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// 凭据失败阈值
// ---------------------------------------------------------------------------

const CREDENTIAL_FAILURE_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// 触发器到协调器任务类型的映射
// ---------------------------------------------------------------------------

const TRIGGER_TO_JOB_KIND: Record<RemoteBackupTrigger, BackupJobKind> = {
  manual: 'manual-remote-backup',
  'scheduled-interval': 'scheduled-remote-backup',
  'quiet-period': 'scheduled-remote-backup',
  'before-exit': 'before-exit-remote-backup',
};

// ---------------------------------------------------------------------------
// RemoteBackupStage 类型守卫
// ---------------------------------------------------------------------------

const REMOTE_BACKUP_STAGES: ReadonlySet<string> = new Set([
  'config',
  'credential',
  'single-flight',
  'restore-blocked',
  'flush',
  'create-zip',
  'upload',
  'list-refresh',
  'completed',
  'unknown',
]);

export function isRemoteBackupStage(value: string): value is RemoteBackupStage {
  return REMOTE_BACKUP_STAGES.has(value);
}

// ---------------------------------------------------------------------------
// 应用活动信号
// ---------------------------------------------------------------------------

export interface AppActivitySignals {
  isDragging: boolean;
  isPanMode: boolean;
  edgePush: boolean;
  stickyDrag: boolean;
  hasSelection: boolean;
  isTextEditing: boolean;
}

// ---------------------------------------------------------------------------
// 注入依赖（用于测试）
// ---------------------------------------------------------------------------

export interface ScheduledRemoteBackupDependencies {
  /** 获取当前时间戳（相当于 Date.now()） */
  clock: () => number;
  /** 设置延迟回调，返回定时器 ID */
  setTimeout: (fn: () => void, ms: number) => number;
  /** 清除延迟回调 */
  clearTimeout: (id: number) => void;
  /** 获取应用活动信号 */
  getAppActivity: () => AppActivitySignals;
  /** 远端备份执行器依赖 */
  runnerDeps: RemoteBackupRunnerDependencies;
  /** 加载 WebDAV 配置 */
  loadWebDavConfig: () => Promise<WebDavConfigLoadResult>;
  /** 加载定时备份配置 */
  loadScheduledConfig: () => Promise<ScheduledBackupConfigLoadResult>;
  /** 保存定时备份配置 */
  saveScheduledConfig: (
    config: ScheduledRemoteBackupConfig,
  ) => Promise<ScheduledBackupConfigSaveResult>;
  /** 加载定时备份状态 */
  loadScheduledState: () => Promise<ScheduledBackupStateLoadResult>;
  /** 保存定时备份状态 */
  saveScheduledState: (
    state: ScheduledRemoteBackupState,
  ) => Promise<ScheduledBackupStateSaveResult>;
  /** 读取磁盘存储数据（用于无本地变更检测） */
  readDiskStorageData: () => Promise<StorageData | null>;
  /** 获取最近更新时间戳 */
  getLatestUpdateTimestamp: (data: StorageData) => number | null;
}

// ---------------------------------------------------------------------------
// 服务内部状态
// ---------------------------------------------------------------------------

export interface ScheduledRemoteBackupServiceState {
  timerId: number | null;
  config: ScheduledRemoteBackupConfig;
  state: ScheduledRemoteBackupState;
  isRunning: boolean;
  quietPeriodTimer: number | null;
  /** 控制器通知有本地变更，下次调度跳过"无本地变更"检测 */
  hasPendingLocalChanges: boolean;
}

// ---------------------------------------------------------------------------
// 创建服务
// ---------------------------------------------------------------------------

export function createScheduledRemoteBackupService(
  deps: ScheduledRemoteBackupDependencies,
) {
  // 可变内部状态
  let internalState: ScheduledRemoteBackupState = {
    ...DEFAULT_SCHEDULED_BACKUP_STATE,
  };
  const serviceState: ScheduledRemoteBackupServiceState = {
    timerId: null,
    config: { ...DEFAULT_SCHEDULED_BACKUP_CONFIG },
    state: internalState,
    isRunning: false,
    quietPeriodTimer: null,
    hasPendingLocalChanges: false,
  };

  /** 更新内部状态（immutable 风格） */
  function patchState(
    patch: Partial<ScheduledRemoteBackupState>,
  ): void {
    internalState = { ...internalState, ...patch };
    serviceState.state = internalState;
  }

  // -------------------------------------------------------------------------
  // 初始化
  // -------------------------------------------------------------------------

  async function initialize(): Promise<void> {
    const configResult = await deps.loadScheduledConfig();
    if (configResult.success && configResult.config) {
      serviceState.config = { ...configResult.config };
    }

    const stateResult = await deps.loadScheduledState();
    if (stateResult.success && stateResult.state) {
      internalState = { ...stateResult.state };
      serviceState.state = internalState;
    }

    if (serviceState.config.enabled) {
      startScheduler();
    }
  }

  // -------------------------------------------------------------------------
  // 调度器
  // -------------------------------------------------------------------------

  function startScheduler(): void {
    if (serviceState.timerId !== null) return;
    if (internalState.credentialActionRequired) return;

    const now = deps.clock();
    const nextRunAt = internalState.nextRunAt;

    if (nextRunAt !== null && nextRunAt <= now) {
      scheduleImmediateRun();
    } else {
      const delay = nextRunAt !== null
        ? nextRunAt - now
        : FREQUENCY_MS[serviceState.config.frequency];

      if (nextRunAt === null) {
        patchState({ nextRunAt: now + delay });
        deps.saveScheduledState(internalState);
      }

      serviceState.timerId = deps.setTimeout(() => {
        serviceState.timerId = null;
        scheduleImmediateRun();
      }, delay);
    }
  }

  function stopScheduler(): void {
    if (serviceState.timerId !== null) {
      deps.clearTimeout(serviceState.timerId);
      serviceState.timerId = null;
    }
    if (serviceState.quietPeriodTimer !== null) {
      deps.clearTimeout(serviceState.quietPeriodTimer);
      serviceState.quietPeriodTimer = null;
    }
    serviceState.hasPendingLocalChanges = false;
  }

  // -------------------------------------------------------------------------
  // 安静时段调度
  // -------------------------------------------------------------------------

  function scheduleImmediateRun(): void {
    const quietMs = serviceState.config.quietPeriodMinutes * 60 * 1000;
    const activity = deps.getAppActivity();

    const isAppActive =
      activity.isDragging ||
      activity.isPanMode ||
      activity.edgePush ||
      activity.stickyDrag ||
      activity.hasSelection ||
      activity.isTextEditing;

    if (isAppActive) {
      // 应用活跃，延迟到安静时段后执行
      serviceState.quietPeriodTimer = deps.setTimeout(() => {
        serviceState.quietPeriodTimer = null;
        // quiet period 已耗尽，重新检查活跃状态
        // 若仍活跃也执行，因为空 quiet period 已等待过了，不应无限延迟
        runBackup('quiet-period');
      }, quietMs);
    } else {
      // 应用空闲，立即执行
      runBackup('scheduled-interval');
    }
  }

  function notifyLocalChange(): void {
    serviceState.hasPendingLocalChanges = true;
  }

  // -------------------------------------------------------------------------
  // 无本地变更检测
  // -------------------------------------------------------------------------

  async function runBackup(
    trigger: RemoteBackupTrigger,
  ): Promise<void> {
    if (serviceState.isRunning) {
      const now = deps.clock();
      patchState({
        lastTrigger: trigger,
        lastFinishedAt: now,
        lastFailureAt: now,
        lastFailureReason: '备份任务正在运行中',
        lastFailureStage: 'single-flight',
      });
      await deps.saveScheduledState(internalState);
      if (trigger === 'before-exit') {
        throw new Error('备份任务正在运行中，请稍候再试');
      }
      return;
    }
    serviceState.isRunning = true;
    const startNow = deps.clock();
    patchState({ lastStartedAt: startNow });

    let beforeExitError: Error | null = null;

    try {
      // 1. 加载 WebDAV 配置
      const webdavResult = await deps.loadWebDavConfig();
      if (!webdavResult.success || !webdavResult.serverUrl) {
        const diskTs = await getCurrentDiskTimestamp();
        const now = deps.clock();
        patchState({
          lastFinishedAt: now,
          lastTrigger: trigger,
          lastFailureAt: now,
          lastFailureReason: '缺少 WebDAV 配置',
          lastFailureStage: 'config',
          lastAttemptCapturedStorageUpdatedAt: diskTs,
          nextRunAt: now + FREQUENCY_MS[serviceState.config.frequency],
        });
        await deps.saveScheduledState(internalState);
        if (trigger === 'before-exit') {
          beforeExitError = new Error('缺少 WebDAV 配置');
        }
        return;
      }

      // 2. 检查凭据是否已保存
      if (!webdavResult.passwordSaved) {
        const diskTs = await getCurrentDiskTimestamp();
        const now = deps.clock();
        patchState({
          lastFinishedAt: now,
          lastTrigger: trigger,
          lastFailureAt: now,
          lastFailureReason: '未保存 WebDAV 凭据',
          lastFailureStage: 'credential',
          lastAttemptCapturedStorageUpdatedAt: diskTs,
          nextRunAt: now + FREQUENCY_MS[serviceState.config.frequency],
        });
        await deps.saveScheduledState(internalState);
        if (trigger === 'before-exit') {
          beforeExitError = new Error('未保存 WebDAV 凭据');
        }
        return;
      }

      // 3. 检查凭据失败阈值
      if (
        internalState.consecutiveCredentialFailures >=
        CREDENTIAL_FAILURE_THRESHOLD
      ) {
        const now = deps.clock();
        patchState({
          credentialActionRequired: true,
          nextRunAt: now + FREQUENCY_MS[serviceState.config.frequency],
        });
        await deps.saveScheduledState(internalState);
        if (trigger === 'before-exit') {
          beforeExitError = new Error('凭据失败次数过多，请重新保存密码');
        }
        return;
      }

      // 4. 无本地变更检测
      const pendingChanges = serviceState.hasPendingLocalChanges;
      if (pendingChanges) {
        serviceState.hasPendingLocalChanges = false;
        const flushed = await deps.runnerDeps.flushNow();
        if (!flushed) {
          // flush 失败时恢复 pending 标记，确保下一轮仍会尝试备份
          serviceState.hasPendingLocalChanges = true;
          const now = deps.clock();
          patchState({
            lastFinishedAt: now,
            lastTrigger: trigger,
            lastFailureAt: now,
            lastFailureReason: '当前数据尚未成功写入磁盘',
            lastFailureStage: 'flush',
            nextRunAt: now + FREQUENCY_MS[serviceState.config.frequency],
          });
          await deps.saveScheduledState(internalState);
          if (trigger === 'before-exit') {
            beforeExitError = new Error('当前数据尚未成功写入磁盘');
          }
          return;
        }
      }

      const storageData = await deps.readDiskStorageData();
      if (storageData) {
        const latestUpdate = deps.getLatestUpdateTimestamp(storageData);
        if (
          latestUpdate !== null &&
          internalState.lastSuccessfulStorageUpdatedAt !== null &&
          latestUpdate <= internalState.lastSuccessfulStorageUpdatedAt
        ) {
          const now = deps.clock();
          patchState({
            lastFinishedAt: now,
            lastTrigger: trigger,
            lastAttemptCapturedStorageUpdatedAt: latestUpdate,
            nextRunAt: now + FREQUENCY_MS[serviceState.config.frequency],
          });
          await deps.saveScheduledState(internalState);
          return;
        }
      }

      // 5. 执行远端备份
      const webdavConfig = {
        serverUrl: webdavResult.serverUrl,
        username: webdavResult.username ?? '',
        remoteDir: webdavResult.remoteDir ?? undefined,
      };

      const result = await runRemoteBackup(deps.runnerDeps, webdavConfig, {
        jobKind: TRIGGER_TO_JOB_KIND[trigger],
      });

      if (result.success) {
        // 成功
        const now = deps.clock();
        const isAutomatic =
          trigger === 'scheduled-interval' ||
          trigger === 'quiet-period' ||
          trigger === 'before-exit';
        const runnerTs = result.capturedStorageUpdatedAt;
        const fallbackTs = storageData ? deps.getLatestUpdateTimestamp(storageData) : null;
        const ts = runnerTs ?? fallbackTs;
        const patch: Partial<ScheduledRemoteBackupState> = {
          lastFinishedAt: now,
          lastTrigger: trigger,
          consecutiveCredentialFailures: 0,
          credentialActionRequired: false,
          lastRemoteFileName: result.remoteFileName ?? null,
          nextRunAt: now + FREQUENCY_MS[serviceState.config.frequency],
          ...(isAutomatic
            ? { lastAutomaticSuccessAt: now }
            : { lastManualSuccessAt: now }),
          ...(ts !== null ? { lastSuccessfulStorageUpdatedAt: ts } : {}),
          lastFailureReason: null,
          lastFailureAt: null,
          lastFailureStage: null,
        };

        patchState(patch);
      } else {
        // 失败
        const now = deps.clock();
        const ts = storageData ? deps.getLatestUpdateTimestamp(storageData) : null;
        const credentialFailure = result.errorStage === 'credential';
        const newCount = credentialFailure
          ? internalState.consecutiveCredentialFailures + 1
          : internalState.consecutiveCredentialFailures;
        const failureStage: RemoteBackupStage = (result.errorStage ?? 'unknown') as RemoteBackupStage;
        const patch: Partial<ScheduledRemoteBackupState> = {
          lastFinishedAt: now,
          lastTrigger: trigger,
          lastFailureAt: now,
          lastFailureReason: result.error ?? 'Unknown error',
          lastFailureStage: failureStage,
          nextRunAt: now + FREQUENCY_MS[serviceState.config.frequency],
          ...(ts !== null ? { lastAttemptCapturedStorageUpdatedAt: ts } : {}),
          ...(credentialFailure
            ? {
                consecutiveCredentialFailures: newCount,
                credentialActionRequired: newCount >= CREDENTIAL_FAILURE_THRESHOLD,
              }
            : {}),
        };

        patchState(patch);
      }

      // before-exit 失败时保存错误，finally 后抛出让 handleQuitRequest 捕获
      if (!result.success && trigger === 'before-exit') {
        beforeExitError = new Error(result.error ?? '退出前备份失败');
      }

      await deps.saveScheduledState(internalState);
    } catch (err: unknown) {
      const now = deps.clock();
      patchState({
        lastFinishedAt: now,
        lastTrigger: trigger,
        lastFailureAt: now,
        lastFailureReason: err instanceof Error ? err.message : String(err),
        lastFailureStage: 'unknown',
        nextRunAt: now + FREQUENCY_MS[serviceState.config.frequency],
      });
      await deps.saveScheduledState(internalState);
      if (trigger === 'before-exit') {
        beforeExitError = err instanceof Error ? err : new Error(String(err));
      }
    } finally {
      serviceState.isRunning = false;

      if (
        serviceState.config.enabled &&
        !internalState.credentialActionRequired
      ) {
        startScheduler();
      }

      throwBeforeExitErrorIfNeeded(beforeExitError);
    }
  }

  // -------------------------------------------------------------------------
  // 工具函数
  // -------------------------------------------------------------------------

  function throwBeforeExitErrorIfNeeded(err: Error | null): void {
    if (err) throw err;
  }

  async function getCurrentDiskTimestamp(): Promise<number | null> {
    const storageData = await deps.readDiskStorageData();
    if (!storageData) return null;
    return deps.getLatestUpdateTimestamp(storageData);
  }

  // -------------------------------------------------------------------------
  // 公开 API
  // -------------------------------------------------------------------------

  return {
    initialize,
    start: startScheduler,
    stop: stopScheduler,
    runNow: () => runBackup('manual'),
    runBeforeExit: () => runBackup('before-exit'),
    notifyLocalChange,

    updateConfig: async (newConfig: ScheduledRemoteBackupConfig) => {
      const oldConfig = serviceState.config;
      serviceState.config = { ...newConfig };
      await deps.saveScheduledConfig(newConfig);

      const frequencyChanged = oldConfig.frequency !== newConfig.frequency;
      const justEnabled = !oldConfig.enabled && newConfig.enabled;
      let needsStateSave = false;

      if (newConfig.enabled) {
        // 用户重新启用时清除凭据失败状态
        if (
          internalState.credentialActionRequired ||
          internalState.consecutiveCredentialFailures > 0
        ) {
          patchState({
            consecutiveCredentialFailures: 0,
            credentialActionRequired: false,
          });
          needsStateSave = true;
        }

        if (frequencyChanged || justEnabled) {
          stopScheduler();
          const now = deps.clock();
          patchState({
            nextRunAt: now + FREQUENCY_MS[newConfig.frequency],
          });
          needsStateSave = true;
        }

        if (needsStateSave) {
          await deps.saveScheduledState(internalState);
        }
        startScheduler();
      } else {
        stopScheduler();
      }
    },

    clearCredentialFailure: async () => {
      patchState({
        consecutiveCredentialFailures: 0,
        credentialActionRequired: false,
      });
      await deps.saveScheduledState(internalState);
    },

    getState: (): Readonly<ScheduledRemoteBackupServiceState> => ({
      ...serviceState,
      state: { ...internalState },
    }),
  };
}
