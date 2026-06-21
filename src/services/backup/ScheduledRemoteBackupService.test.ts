import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock 远端备份执行器（隔离 coordinator 依赖）
// vi.mock 会被提升到模块顶部，必须使用 vi.hoisted 初始化 mock
// ---------------------------------------------------------------------------

const { mockRunRemoteBackup } = vi.hoisted(() => ({
  mockRunRemoteBackup: vi.fn(),
}));

vi.mock('./RemoteBackupRunner', () => ({
  runRemoteBackup: (...args: unknown[]) => mockRunRemoteBackup(...args),
  RemoteBackupErrorStage: {
    Flush: 'flush',
    SingleFlight: 'single-flight',
    Unknown: 'unknown',
  },
}));

// ---------------------------------------------------------------------------
// Mock 保留策略编排器（隔离 orchestrator 依赖）
// ---------------------------------------------------------------------------

const { mockOrchestrateRetentionCleanup } = vi.hoisted(() => ({
  mockOrchestrateRetentionCleanup: vi.fn(),
}));

vi.mock('./RetentionCleanupOrchestrator', () => ({
  orchestratePostBackupRetentionCleanup: (...args: unknown[]) =>
    mockOrchestrateRetentionCleanup(...args),
}));

import { _resetCoordinatorForTesting } from './BackupJobCoordinator';
import {
  createScheduledRemoteBackupService,
  type ScheduledRemoteBackupDependencies,
  type AppActivitySignals,
} from './ScheduledRemoteBackupService';
import type {
  ScheduledRemoteBackupConfig,
  ScheduledRemoteBackupState,
  ScheduledBackupConfigLoadResult,
  ScheduledBackupStateLoadResult,
  ScheduledBackupConfigSaveResult,
  ScheduledBackupStateSaveResult,
} from './ScheduledRemoteBackupConfigService';
import {
  DEFAULT_SCHEDULED_BACKUP_CONFIG,
  DEFAULT_SCHEDULED_BACKUP_STATE,
} from './ScheduledRemoteBackupConfigService';
import type { WebDavConfigLoadResult } from './WebDavBackupService';
import type { StorageData } from '../../store/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const INACTIVE_ACTIVITY: AppActivitySignals = {
  isDragging: false,
  isPanMode: false,
  edgePush: false,
  stickyDrag: false,
  hasSelection: false,
  isTextEditing: false,
};

const ACTIVE_ACTIVITY: AppActivitySignals = {
  isDragging: true,
  isPanMode: false,
  edgePush: false,
  stickyDrag: false,
  hasSelection: false,
  isTextEditing: false,
};

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

function makeStorageData(
  overrides?: Partial<StorageData>,
): StorageData {
  return {
    schemaVersion: 2,
    storageUpdatedAt: 1000000,
    notes: [],
    boards: [],
    currentBoardId: 'board-1',
    config: {} as StorageData['config'],
    ...overrides,
  };
}

interface TestContext {
  now: number;
  clock: ReturnType<typeof vi.fn>;
  timers: {
    setTimeout: ReturnType<typeof vi.fn>;
    clearTimeout: ReturnType<typeof vi.fn>;
    callbacks: Map<number, () => void>;
    nextId: number;
  };
  getAppActivity: ReturnType<typeof vi.fn>;
  runnerDeps: {
    flushNow: ReturnType<typeof vi.fn>;
    createRemoteBackup: ReturnType<typeof vi.fn>;
    readDiskStorageData: ReturnType<typeof vi.fn>;
    getLatestUpdateTimestamp: ReturnType<typeof vi.fn>;
    coordinator: { tryStartBackupJob: ReturnType<typeof vi.fn> };
    now: () => number;
  };
  loadWebDavConfig: ReturnType<typeof vi.fn>;
  loadScheduledConfig: ReturnType<typeof vi.fn>;
  saveScheduledConfig: ReturnType<typeof vi.fn>;
  loadScheduledState: ReturnType<typeof vi.fn>;
  saveScheduledState: ReturnType<typeof vi.fn>;
  readDiskStorageData: ReturnType<typeof vi.fn>;
  getLatestUpdateTimestamp: ReturnType<typeof vi.fn>;
  deps: ScheduledRemoteBackupDependencies;
}

function createTestContext(overrides?: {
  config?: Partial<ScheduledRemoteBackupConfig>;
  state?: Partial<ScheduledRemoteBackupState>;
  initialNow?: number;
}): TestContext {
  const now = overrides?.initialNow ?? 1000000000000;
  const callbacks = new Map<number, () => void>();
  let nextId = 1;

  const clock = vi.fn(() => now);
  const setTimeoutFn = vi.fn((fn: () => void) => {
    const id = nextId++;
    callbacks.set(id, fn);
    return id;
  });
  const clearTimeoutFn = vi.fn((id: number) => {
    callbacks.delete(id);
  });
  const getAppActivity = vi.fn(() => INACTIVE_ACTIVITY);

  const runnerDeps = {
    flushNow: vi.fn(async () => true),
    createRemoteBackup: vi.fn(async () => ({
      success: true,
      remoteFileName: 'SoNotes_Backup_20260101.zip',
      summary: null,
      zipSizeBytes: null,
    })),
    readDiskStorageData: vi.fn(async () => null),
    getLatestUpdateTimestamp: vi.fn(() => 0),
    coordinator: { tryStartBackupJob: vi.fn(() => null) },
    now: () => now,
  };

  const loadWebDavConfig = vi.fn(async () => makeWebDavConfigResult());
  const loadScheduledConfig = vi.fn(async (): Promise<ScheduledBackupConfigLoadResult> => ({
    success: true,
    config: { ...DEFAULT_SCHEDULED_BACKUP_CONFIG, ...overrides?.config },
    error: null,
  }));
  const saveScheduledConfig = vi.fn(
    async (): Promise<ScheduledBackupConfigSaveResult> => ({ success: true, error: null }),
  );
  const loadScheduledState = vi.fn(async (): Promise<ScheduledBackupStateLoadResult> => ({
    success: true,
    state: { ...DEFAULT_SCHEDULED_BACKUP_STATE, ...overrides?.state },
    error: null,
  }));
  const saveScheduledState = vi.fn(
    async (): Promise<ScheduledBackupStateSaveResult> => ({ success: true, error: null }),
  );
  const readDiskStorageData = vi.fn(async () => null as StorageData | null);
  const getLatestUpdateTimestamp = vi.fn(() => 0);

  const deps: ScheduledRemoteBackupDependencies = {
    clock,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    getAppActivity,
    runnerDeps,
    loadWebDavConfig,
    loadScheduledConfig,
    saveScheduledConfig,
    loadScheduledState,
    saveScheduledState,
    readDiskStorageData,
    getLatestUpdateTimestamp,
  };

  return {
    now,
    clock,
    timers: { setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn, callbacks, nextId: 1 },
    getAppActivity,
    runnerDeps,
    loadWebDavConfig,
    loadScheduledConfig,
    saveScheduledConfig,
    loadScheduledState,
    saveScheduledState,
    readDiskStorageData,
    getLatestUpdateTimestamp,
    deps,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScheduledRemoteBackupService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetCoordinatorForTesting();
    mockRunRemoteBackup.mockReset();
    mockOrchestrateRetentionCleanup.mockReset();
    mockOrchestrateRetentionCleanup.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetCoordinatorForTesting();
  });

  // -------------------------------------------------------------------------
  // 1. 禁用状态
  // -------------------------------------------------------------------------

  describe('禁用状态', () => {
    it('enabled 为 false 时不启动定时器', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
      });
      const service = createScheduledRemoteBackupService(ctx.deps);

      await service.initialize();

      expect(ctx.timers.setTimeout).not.toHaveBeenCalled();
      const st = service.getState();
      expect(st.timerId).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 2. 启用状态
  // -------------------------------------------------------------------------

  describe('启用状态', () => {
    it('enabled 为 true 时启动定时器', async () => {
      const ctx = createTestContext({
        config: { enabled: true, frequency: 'daily' },
      });
      const service = createScheduledRemoteBackupService(ctx.deps);

      await service.initialize();

      expect(ctx.timers.setTimeout).toHaveBeenCalled();
      const st = service.getState();
      expect(st.timerId).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 3. 频率计算
  // -------------------------------------------------------------------------

  describe('频率计算', () => {
    it('nextRunAt 根据频率正确计算', async () => {
      const ctx = createTestContext({
        config: { enabled: true, frequency: 'daily' },
        state: { nextRunAt: null },
      });
      const service = createScheduledRemoteBackupService(ctx.deps);

      await service.initialize();

      // daily = 24h = 86400000ms
      const expectedDelay = 24 * 60 * 60 * 1000;
      expect(ctx.timers.setTimeout).toHaveBeenCalledWith(
        expect.any(Function),
        expectedDelay,
      );
    });

    it('不同频率产生不同的延迟', async () => {
      const freqTests: Array<[string, number]> = [
        ['every-6-hours', 6 * 60 * 60 * 1000],
        ['every-12-hours', 12 * 60 * 60 * 1000],
        ['daily', 24 * 60 * 60 * 1000],
        ['weekly', 7 * 24 * 60 * 60 * 1000],
      ];

      for (const [freq, expectedMs] of freqTests) {
        _resetCoordinatorForTesting();
        mockRunRemoteBackup.mockReset();
        vi.useFakeTimers();

        const ctx = createTestContext({
          config: { enabled: true, frequency: freq as ScheduledRemoteBackupConfig['frequency'] },
          state: { nextRunAt: null },
        });
        const service = createScheduledRemoteBackupService(ctx.deps);

        await service.initialize();

        expect(ctx.timers.setTimeout).toHaveBeenCalledWith(
          expect.any(Function),
          expectedMs,
        );

        service.stop();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 4. 无 WebDAV 配置
  // -------------------------------------------------------------------------

  describe('无 WebDAV 配置', () => {
    it('跳过备份并记录可解释状态', async () => {
      const storageData = makeStorageData({ storageUpdatedAt: 8000 });
      const ctx = createTestContext({
        config: { enabled: true, frequency: 'daily' },
        state: { nextRunAt: null },
      });
      ctx.loadWebDavConfig.mockResolvedValueOnce({
        success: false,
        serverUrl: null,
        passwordSaved: false,
      });
      ctx.readDiskStorageData.mockResolvedValueOnce(storageData);
      ctx.getLatestUpdateTimestamp.mockReturnValueOnce(8000);

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      await service.runNow();

      expect(mockRunRemoteBackup).not.toHaveBeenCalled();

      const savedState = ctx.saveScheduledState.mock.calls[ctx.saveScheduledState.mock.calls.length - 1]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.lastTrigger).toBe('manual');
      expect(savedState!.lastFinishedAt).toBe(ctx.now);
      expect(savedState!.lastFailureAt).toBe(ctx.now);
      expect(savedState!.lastFailureReason).toBe('缺少 WebDAV 配置');
      expect(savedState!.lastFailureStage).toBe('config');
      expect(savedState!.lastAttemptCapturedStorageUpdatedAt).toBe(8000);

      service.stop();
    });
  });

  // -------------------------------------------------------------------------
  // 5. 无已保存凭据
  // -------------------------------------------------------------------------

  describe('无已保存凭据', () => {
    it('passwordSaved 为 false 时跳过备份并记录 credential 阶段', async () => {
      const storageData = makeStorageData({ storageUpdatedAt: 9000 });
      const ctx = createTestContext({
        config: { enabled: false },
      });
      ctx.loadWebDavConfig.mockResolvedValueOnce({
        success: true,
        serverUrl: 'https://example.com/dav',
        username: 'user',
        passwordSaved: false,
      });
      ctx.readDiskStorageData.mockResolvedValueOnce(storageData);
      ctx.getLatestUpdateTimestamp.mockReturnValueOnce(9000);

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runNow();

      expect(mockRunRemoteBackup).not.toHaveBeenCalled();

      const savedState = ctx.saveScheduledState.mock.calls[0]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.lastTrigger).toBe('manual');
      expect(savedState!.lastFailureReason).toBe('未保存 WebDAV 凭据');
      expect(savedState!.lastFailureStage).toBe('credential');
      expect(savedState!.lastAttemptCapturedStorageUpdatedAt).toBe(9000);
    });
  });

  // -------------------------------------------------------------------------
  // 6. 凭据失败阈值
  // -------------------------------------------------------------------------

  describe('凭据失败阈值', () => {
    it('连续 3 次凭据失败后设置 credentialActionRequired', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
        state: { consecutiveCredentialFailures: 2 },
      });
      mockRunRemoteBackup.mockResolvedValueOnce({
        success: false,
        error: 'Auth failed',
        errorStage: 'credential',
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runNow();

      const savedState = ctx.saveScheduledState.mock.calls[0]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.consecutiveCredentialFailures).toBe(3);
      expect(savedState!.credentialActionRequired).toBe(true);
    });

    it('达到阈值后不再执行备份', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
        state: { consecutiveCredentialFailures: 3, credentialActionRequired: true },
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runNow();

      expect(mockRunRemoteBackup).not.toHaveBeenCalled();
    });

    it('达到阈值后暂停调度（enabled=true 时不重新调度）', async () => {
      const ctx = createTestContext({
        config: { enabled: true, frequency: 'daily' },
        state: { nextRunAt: null, consecutiveCredentialFailures: 2 },
      });
      mockRunRemoteBackup.mockResolvedValueOnce({
        success: false,
        error: 'Auth failed',
        errorStage: 'credential',
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      service.stop();
      ctx.timers.setTimeout.mockClear();

      await service.runNow();

      // finally 中因 credentialActionRequired=true 不应调用 startScheduler
      expect(ctx.timers.setTimeout).not.toHaveBeenCalled();

      const savedState = ctx.saveScheduledState.mock.calls[ctx.saveScheduledState.mock.calls.length - 1]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState!.credentialActionRequired).toBe(true);

      service.stop();
    });

    it('Rust auth 阶段（归一化为 credential）触发连续失败计数', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
        state: { consecutiveCredentialFailures: 0 },
      });
      mockRunRemoteBackup.mockResolvedValueOnce({
        success: false,
        error: '401 Unauthorized',
        errorStage: 'credential',
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runNow();

      const savedState = ctx.saveScheduledState.mock.calls[0]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.consecutiveCredentialFailures).toBe(1);
      expect(savedState!.credentialActionRequired).toBe(false);
    });

    it('连续 3 次 auth 归一化为 credential 后触发 credentialActionRequired', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
        state: { consecutiveCredentialFailures: 2 },
      });
      mockRunRemoteBackup.mockResolvedValueOnce({
        success: false,
        error: '401 Unauthorized',
        errorStage: 'credential',
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runNow();

      const savedState = ctx.saveScheduledState.mock.calls[0]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.consecutiveCredentialFailures).toBe(3);
      expect(savedState!.credentialActionRequired).toBe(true);
    });

    it('非 credential 失败不增加连续凭据失败计数', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
        state: { consecutiveCredentialFailures: 2 },
      });
      mockRunRemoteBackup.mockResolvedValueOnce({
        success: false,
        error: 'Upload failed',
        errorStage: 'upload',
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runNow();

      const savedState = ctx.saveScheduledState.mock.calls[0]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.consecutiveCredentialFailures).toBe(2);
      expect(savedState!.credentialActionRequired).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 7. 清除凭据失败
  // -------------------------------------------------------------------------

  describe('清除凭据失败', () => {
    it('重置计数器和标志', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
        state: {
          consecutiveCredentialFailures: 3,
          credentialActionRequired: true,
        },
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.clearCredentialFailure();

      const savedState = ctx.saveScheduledState.mock.calls[0]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.consecutiveCredentialFailures).toBe(0);
      expect(savedState!.credentialActionRequired).toBe(false);
    });

    it('updateConfig({enabled:true}) 时自动清除凭据失败状态', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
        state: {
          consecutiveCredentialFailures: 3,
          credentialActionRequired: true,
        },
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      await service.updateConfig({
        ...DEFAULT_SCHEDULED_BACKUP_CONFIG,
        enabled: true,
        frequency: 'daily',
      });

      const savedState = ctx.saveScheduledState.mock.calls[0]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.consecutiveCredentialFailures).toBe(0);
      expect(savedState!.credentialActionRequired).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 7.1 updateConfig 频率变更重算 nextRunAt
  // -------------------------------------------------------------------------

  describe('updateConfig 频率变更重算 nextRunAt', () => {
    it('频率从 daily 改为 weekly 时重算 nextRunAt', async () => {
      const ctx = createTestContext({
        config: { enabled: true, frequency: 'daily' },
        state: { nextRunAt: 1000000000000 + 24 * 60 * 60 * 1000 },
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      const oldNextRunAt = service.getState().state.nextRunAt;

      service.stop();
      ctx.timers.setTimeout.mockClear();

      await service.updateConfig({
        ...DEFAULT_SCHEDULED_BACKUP_CONFIG,
        enabled: true,
        frequency: 'weekly',
      });

      const newState = service.getState().state;
      const weeklyMs = 7 * 24 * 60 * 60 * 1000;
      expect(newState.nextRunAt).toBe(ctx.now + weeklyMs);
      expect(newState.nextRunAt).not.toBe(oldNextRunAt);

      const savedState = ctx.saveScheduledState.mock.calls[
        ctx.saveScheduledState.mock.calls.length - 1
      ]?.[0] as ScheduledRemoteBackupState | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.nextRunAt).toBe(ctx.now + weeklyMs);

      service.stop();
    });

    it('从 disabled 切换到 enabled 时重算 nextRunAt', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
        state: { nextRunAt: 999 },
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      await service.updateConfig({
        ...DEFAULT_SCHEDULED_BACKUP_CONFIG,
        enabled: true,
        frequency: 'every-6-hours',
      });

      const sixHoursMs = 6 * 60 * 60 * 1000;
      expect(service.getState().state.nextRunAt).toBe(ctx.now + sixHoursMs);

      service.stop();
    });

    it('已启用状态仅改频率时重算 nextRunAt', async () => {
      const ctx = createTestContext({
        config: { enabled: true, frequency: 'every-6-hours' },
        state: { nextRunAt: null },
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      service.stop();
      ctx.timers.setTimeout.mockClear();

      await service.updateConfig({
        ...DEFAULT_SCHEDULED_BACKUP_CONFIG,
        enabled: true,
        frequency: 'every-12-hours',
      });

      const twelveHoursMs = 12 * 60 * 60 * 1000;
      expect(service.getState().state.nextRunAt).toBe(ctx.now + twelveHoursMs);

      service.stop();
    });

    it('频率变更时先清旧 timer 再注册新 timer', async () => {
      const ctx = createTestContext({
        config: { enabled: true, frequency: 'daily' },
        state: { nextRunAt: 1000000000000 + 24 * 60 * 60 * 1000 },
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      const oldTimerId = ctx.timers.setTimeout.mock.results[0]?.value;
      expect(oldTimerId).toBeDefined();

      ctx.timers.setTimeout.mockClear();
      ctx.timers.clearTimeout.mockClear();

      await service.updateConfig({
        ...DEFAULT_SCHEDULED_BACKUP_CONFIG,
        enabled: true,
        frequency: 'weekly',
      });

      expect(ctx.timers.clearTimeout).toHaveBeenCalledWith(oldTimerId);
      expect(ctx.timers.setTimeout).toHaveBeenCalledTimes(1);

      service.stop();
    });

    it('未改变频率时不重算 nextRunAt', async () => {
      const ctx = createTestContext({
        config: { enabled: true, frequency: 'daily' },
        state: { nextRunAt: null },
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      const nextRunAtAfterInit = service.getState().state.nextRunAt;

      service.stop();
      ctx.timers.setTimeout.mockClear();
      ctx.saveScheduledState.mockClear();

      await service.updateConfig({
        ...DEFAULT_SCHEDULED_BACKUP_CONFIG,
        enabled: true,
        frequency: 'daily',
      });

      expect(service.getState().state.nextRunAt).toBe(nextRunAtAfterInit);

      service.stop();
    });

    it('禁用时不保存 nextRunAt', async () => {
      const ctx = createTestContext({
        config: { enabled: true, frequency: 'daily' },
        state: { nextRunAt: 1000000000000 + 24 * 60 * 60 * 1000 },
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      ctx.saveScheduledState.mockClear();

      await service.updateConfig({
        ...DEFAULT_SCHEDULED_BACKUP_CONFIG,
        enabled: false,
        frequency: 'daily',
      });

      expect(ctx.saveScheduledState).not.toHaveBeenCalled();

      service.stop();
    });
  });

  // -------------------------------------------------------------------------
  // 8. 无本地变更
  // -------------------------------------------------------------------------

  describe('无本地变更', () => {
    it('跳过备份并记录 lastTrigger 和 lastAttemptCapturedStorageUpdatedAt', async () => {
      const storageData = makeStorageData({ storageUpdatedAt: 5000 });
      const ctx = createTestContext({
        config: { enabled: false },
        state: { lastSuccessfulStorageUpdatedAt: 5000 },
      });
      ctx.readDiskStorageData.mockResolvedValueOnce(storageData);
      ctx.getLatestUpdateTimestamp.mockReturnValueOnce(5000);

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runNow();

      expect(mockRunRemoteBackup).not.toHaveBeenCalled();

      const savedState = ctx.saveScheduledState.mock.calls[0]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.lastTrigger).toBe('manual');
      expect(savedState!.lastFinishedAt).toBe(ctx.now);
      expect(savedState!.lastAttemptCapturedStorageUpdatedAt).toBe(5000);
      // 不应修改成功字段
      expect(savedState!.lastAutomaticSuccessAt).toBeNull();
      expect(savedState!.lastManualSuccessAt).toBeNull();
      // 跳过时应推进 nextRunAt，防止快速重试循环
      expect(savedState!.nextRunAt).toBe(ctx.now + 24 * 60 * 60 * 1000);
    });

    it('latestUpdate > lastSuccessfulStorageUpdatedAt 时执行备份', async () => {
      const storageData = makeStorageData({ storageUpdatedAt: 6000 });
      const ctx = createTestContext({
        config: { enabled: false },
        state: { lastSuccessfulStorageUpdatedAt: 5000 },
      });
      ctx.readDiskStorageData.mockResolvedValueOnce(storageData);
      ctx.getLatestUpdateTimestamp.mockReturnValue(6000);

      mockRunRemoteBackup.mockResolvedValueOnce({
        success: true,
        remoteFileName: 'backup.zip',
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runNow();

      expect(mockRunRemoteBackup).toHaveBeenCalled();
    });

    it('notifyLocalChange 后先 flush 再检查时间戳', async () => {
      const storageDataAfterFlush = makeStorageData({ storageUpdatedAt: 6000 });
      const ctx = createTestContext({
        config: { enabled: false },
        state: { lastSuccessfulStorageUpdatedAt: 5000 },
      });
      ctx.readDiskStorageData.mockResolvedValueOnce(storageDataAfterFlush);
      ctx.getLatestUpdateTimestamp.mockReturnValue(6000);

      mockRunRemoteBackup.mockResolvedValueOnce({
        success: true,
        remoteFileName: 'backup.zip',
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      service.notifyLocalChange();
      await service.runNow();

      expect(ctx.runnerDeps.flushNow).toHaveBeenCalled();
      expect(mockRunRemoteBackup).toHaveBeenCalled();
      const st = service.getState();
      expect(st.hasPendingLocalChanges).toBe(false);
    });

    it('flush 失败后 hasPendingLocalChanges 保留为 true，下一轮仍会尝试', async () => {
      const ctx = createTestContext({
        config: { enabled: true, frequency: 'daily', quietPeriodMinutes: 0 },
      });
      ctx.runnerDeps.flushNow.mockResolvedValue(false);

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      service.notifyLocalChange();
      expect(service.getState().hasPendingLocalChanges).toBe(true);

      await service.runNow();

      expect(service.getState().state.lastFailureStage).toBe('flush');
      expect(service.getState().hasPendingLocalChanges).toBe(true);

      ctx.runnerDeps.flushNow.mockResolvedValue(true);
      ctx.readDiskStorageData.mockResolvedValue({
        boards: {},
        notes: {},
        trashedNotes: {},
        storageUpdatedAt: 999999,
      } as never);

      await service.runNow();

      expect(mockRunRemoteBackup).toHaveBeenCalled();
      expect(service.getState().hasPendingLocalChanges).toBe(false);
    });

    it('flushNow reject 后 hasPendingLocalChanges 保留为 true', async () => {
      const ctx = createTestContext({
        config: { enabled: true, frequency: 'daily', quietPeriodMinutes: 0 },
      });
      ctx.runnerDeps.flushNow.mockRejectedValue(new Error('无活跃句柄'));

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      service.notifyLocalChange();
      expect(service.getState().hasPendingLocalChanges).toBe(true);

      await service.runNow();

      expect(service.getState().state.lastFailureStage).toBe('flush');
      expect(service.getState().hasPendingLocalChanges).toBe(true);
    });

    it('stop 后 hasPendingLocalChanges 被重置', async () => {
      const ctx = createTestContext({ config: { enabled: false } });
      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      service.notifyLocalChange();
      expect(service.getState().hasPendingLocalChanges).toBe(true);

      service.stop();
      expect(service.getState().hasPendingLocalChanges).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 9. 安静时段
  // -------------------------------------------------------------------------

  describe('安静时段', () => {
    it('应用活跃时延迟到安静时段后执行', async () => {
      const ctx = createTestContext({
        config: { enabled: true, frequency: 'daily', quietPeriodMinutes: 5 },
        state: { nextRunAt: 1000000000000 - 1000 },
      });

      ctx.getAppActivity.mockReturnValue(ACTIVE_ACTIVITY);

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      // startScheduler 检测到 nextRunAt <= now → 直接调用 scheduleImmediateRun
      // scheduleImmediateRun 检测到 active → 注册安静时段定时器
      const quietMs = 5 * 60 * 1000;
      expect(ctx.timers.setTimeout).toHaveBeenCalledWith(
        expect.any(Function),
        quietMs,
      );

      service.stop();
    });

    it('quiet timer 到期后仍活跃时仍执行备份（不无限延迟）', async () => {
      const ctx = createTestContext({
        config: { enabled: true, frequency: 'daily', quietPeriodMinutes: 5 },
        state: { nextRunAt: 1000000000000 - 1000 },
      });

      ctx.getAppActivity.mockReturnValue(ACTIVE_ACTIVITY);
      mockRunRemoteBackup.mockResolvedValue({ success: true, remoteFileName: 'b.zip' });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      // 获取 quiet timer 回调
      const quietCallback = ctx.timers.setTimeout.mock.calls.find(
        (call: unknown[]) => {
          const delay = call[1];
          return typeof delay === 'number' && delay === 5 * 60 * 1000;
        },
      )?.[0] as (() => void) | undefined;
      expect(quietCallback).toBeDefined();

      // quiet timer 到期时仍活跃
      ctx.getAppActivity.mockReturnValue(ACTIVE_ACTIVITY);

      // 触发 quiet timer 回调
      quietCallback!();
      await vi.advanceTimersByTimeAsync(0);

      // 应执行备份，不无限延迟
      expect(mockRunRemoteBackup).toHaveBeenCalled();

      service.stop();
    });

    it('quiet timer 到期时空闲时执行备份', async () => {
      const ctx = createTestContext({
        config: { enabled: true, frequency: 'daily', quietPeriodMinutes: 5 },
        state: { nextRunAt: 1000000000000 - 1000 },
      });

      ctx.getAppActivity.mockReturnValue(ACTIVE_ACTIVITY);
      mockRunRemoteBackup.mockResolvedValue({ success: true, remoteFileName: 'b.zip' });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      // 获取 quiet timer 回调
      const quietCallback = ctx.timers.setTimeout.mock.calls.find(
        (call: unknown[]) => {
          const delay = call[1];
          return typeof delay === 'number' && delay === 5 * 60 * 1000;
        },
      )?.[0] as (() => void) | undefined;
      expect(quietCallback).toBeDefined();

      // quiet timer 到期时空闲
      ctx.getAppActivity.mockReturnValue(INACTIVE_ACTIVITY);

      quietCallback!();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockRunRemoteBackup).toHaveBeenCalled();

      service.stop();
    });
  });

  // -------------------------------------------------------------------------
  // 10. 应用空闲
  // -------------------------------------------------------------------------

  describe('应用空闲', () => {
    it('应用空闲时立即执行（不注册安静时段定时器）', async () => {
      const ctx = createTestContext({
        config: { enabled: true, frequency: 'daily', quietPeriodMinutes: 5 },
        state: { nextRunAt: null },
      });
      ctx.getAppActivity.mockReturnValue(INACTIVE_ACTIVITY);
      mockRunRemoteBackup.mockResolvedValue({ success: true, remoteFileName: 'b.zip' });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      // stop 后重新 start，获取 callback
      service.stop();
      mockRunRemoteBackup.mockClear();
      service.start();

      const freqCallback = ctx.timers.setTimeout.mock.calls[0]?.[0] as (() => void) | undefined;
      expect(freqCallback).toBeDefined();

      // 触发回调并等待异步 runBackup 完成
      freqCallback!();
      await vi.advanceTimersByTimeAsync(0);

      // runBackup 调用了 runRemoteBackup
      expect(mockRunRemoteBackup).toHaveBeenCalled();

      // 不应有安静时段定时器（quietMs = 300000）
      const QUIET_MS = 5 * 60 * 1000;
      const quietCalls = ctx.timers.setTimeout.mock.calls.filter(
        (call: unknown[]) => {
          const delay = call[1];
          return typeof delay === 'number' && delay === QUIET_MS;
        },
      );
      expect(quietCalls.length).toBe(0);

      service.stop();
    });
  });

  // -------------------------------------------------------------------------
  // 11. 成功路径
  // -------------------------------------------------------------------------

  describe('成功路径', () => {
    it('记录 lastAutomaticSuccessAt、lastSuccessfulStorageUpdatedAt 和 remoteFileName', async () => {
      const storageData = makeStorageData({ storageUpdatedAt: 7000 });
      const ctx = createTestContext({
        config: { enabled: false },
        state: { lastSuccessfulStorageUpdatedAt: null },
      });
      ctx.readDiskStorageData.mockResolvedValueOnce(storageData);
      // getLatestUpdateTimestamp 在无本地变更检测和成功路径中各调用一次
      ctx.getLatestUpdateTimestamp.mockReturnValue(7000);
      mockRunRemoteBackup.mockResolvedValueOnce({
        success: true,
        remoteFileName: 'SoNotes_Backup_20260101.zip',
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runNow();

      const savedState = ctx.saveScheduledState.mock.calls[0]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.lastAutomaticSuccessAt).toBeNull(); // manual 不记录 automatic
      expect(savedState!.lastManualSuccessAt).toBe(ctx.now);
      expect(savedState!.lastSuccessfulStorageUpdatedAt).toBe(7000);
      expect(savedState!.lastRemoteFileName).toBe('SoNotes_Backup_20260101.zip');
      expect(savedState!.consecutiveCredentialFailures).toBe(0);
      expect(savedState!.credentialActionRequired).toBe(false);
    });

    it('使用 runner 返回的 capturedStorageUpdatedAt 而非 runner 前读取的时间戳', async () => {
      const preFlushData = makeStorageData({ storageUpdatedAt: 5000 });
      const ctx = createTestContext({
        config: { enabled: false },
        state: { lastSuccessfulStorageUpdatedAt: null },
      });
      ctx.readDiskStorageData.mockResolvedValueOnce(preFlushData);
      ctx.getLatestUpdateTimestamp.mockReturnValue(5000);
      mockRunRemoteBackup.mockResolvedValueOnce({
        success: true,
        remoteFileName: 'backup.zip',
        capturedStorageUpdatedAt: 8000,
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runNow();

      const savedState = ctx.saveScheduledState.mock.calls[0]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.lastSuccessfulStorageUpdatedAt).toBe(8000);
    });

    it('capturedStorageUpdatedAt 为 null 时回退到 runner 前读取的时间戳', async () => {
      const storageData = makeStorageData({ storageUpdatedAt: 6000 });
      const ctx = createTestContext({
        config: { enabled: false },
        state: { lastSuccessfulStorageUpdatedAt: null },
      });
      ctx.readDiskStorageData.mockResolvedValueOnce(storageData);
      ctx.getLatestUpdateTimestamp.mockReturnValue(6000);
      mockRunRemoteBackup.mockResolvedValueOnce({
        success: true,
        remoteFileName: 'backup.zip',
        capturedStorageUpdatedAt: null,
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runNow();

      const savedState = ctx.saveScheduledState.mock.calls[0]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.lastSuccessfulStorageUpdatedAt).toBe(6000);
    });
  });

  // -------------------------------------------------------------------------
  // 12. 失败路径
  // -------------------------------------------------------------------------

  describe('失败路径', () => {
    it('记录 lastFailureAt、lastFailureReason 和 lastFailureStage', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
      });
      mockRunRemoteBackup.mockResolvedValueOnce({
        success: false,
        error: 'Network timeout',
        errorStage: 'upload',
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runNow();

      const savedState = ctx.saveScheduledState.mock.calls[0]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.lastFailureAt).toBe(ctx.now);
      expect(savedState!.lastFailureReason).toBe('Network timeout');
      expect(savedState!.lastFailureStage).toBe('upload');
    });
  });

  // -------------------------------------------------------------------------
  // 13. 手动触发
  // -------------------------------------------------------------------------

  describe('手动触发', () => {
    it('记录 lastManualSuccessAt 而非 lastAutomaticSuccessAt', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
        state: { lastSuccessfulStorageUpdatedAt: null },
      });
      mockRunRemoteBackup.mockResolvedValueOnce({
        success: true,
        remoteFileName: 'backup.zip',
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runNow();

      const savedState = ctx.saveScheduledState.mock.calls[0]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.lastManualSuccessAt).toBe(ctx.now);
      expect(savedState!.lastAutomaticSuccessAt).toBeNull();
      expect(savedState!.lastTrigger).toBe('manual');
    });
  });

  // -------------------------------------------------------------------------
  // 14. 退出前触发
  // -------------------------------------------------------------------------

  describe('退出前触发', () => {
    it('记录 lastAutomaticSuccessAt', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
        state: { lastSuccessfulStorageUpdatedAt: null },
      });
      mockRunRemoteBackup.mockResolvedValueOnce({
        success: true,
        remoteFileName: 'backup.zip',
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runBeforeExit();

      const savedState = ctx.saveScheduledState.mock.calls[0]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.lastAutomaticSuccessAt).toBe(ctx.now);
      expect(savedState!.lastManualSuccessAt).toBeNull();
      expect(savedState!.lastTrigger).toBe('before-exit');
    });

    it('runner 返回 success:false 时 runBeforeExit reject', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
        state: { lastSuccessfulStorageUpdatedAt: null },
      });
      mockRunRemoteBackup.mockResolvedValueOnce({
        success: false,
        error: '上传失败',
        errorStage: 'upload',
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await expect(service.runBeforeExit()).rejects.toThrow('上传失败');

      const calls = ctx.saveScheduledState.mock.calls;
      const savedState = calls[calls.length - 1]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.lastFailureAt).toBe(ctx.now);
      expect(savedState!.lastFailureReason).toBe('上传失败');
      expect(savedState!.lastFailureStage).toBe('upload');
    });

    it('缺少 WebDAV 配置时 runBeforeExit reject', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
        state: { lastSuccessfulStorageUpdatedAt: null },
      });
      ctx.loadWebDavConfig.mockResolvedValue({
        success: false,
        error: 'no config',
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await expect(service.runBeforeExit()).rejects.toThrow('缺少 WebDAV 配置');
    });

    it('未保存凭据时 runBeforeExit reject', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
        state: { lastSuccessfulStorageUpdatedAt: null },
      });
      ctx.loadWebDavConfig.mockResolvedValue({
        success: true,
        serverUrl: 'https://dav.example.com',
        username: 'user',
        passwordSaved: false,
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await expect(service.runBeforeExit()).rejects.toThrow('未保存 WebDAV 凭据');
    });

    it('flush 失败时 runBeforeExit reject', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
        state: { lastSuccessfulStorageUpdatedAt: null },
      });
      ctx.runnerDeps.flushNow.mockResolvedValue(false);

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      service.notifyLocalChange();
      await expect(service.runBeforeExit()).rejects.toThrow(
        '当前数据尚未成功写入磁盘',
      );
    });

    it('凭据失败阈值时 runBeforeExit reject', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
        state: {
          lastSuccessfulStorageUpdatedAt: null,
          consecutiveCredentialFailures: 3,
        },
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await expect(service.runBeforeExit()).rejects.toThrow(
        '凭据失败次数过多，请重新保存密码',
      );
    });
  });

  // -------------------------------------------------------------------------
  // 15. 过期的 nextRunAt
  // -------------------------------------------------------------------------

  describe('过期的 nextRunAt', () => {
    it('initialize 时 nextRunAt <= now 则立即触发', async () => {
      const ctx = createTestContext({
        config: { enabled: true, frequency: 'daily' },
        state: {
          nextRunAt: 1000000000000 - 1000, // 已过期
        },
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      // 应调用 scheduleImmediateRun，而非 scheduleDelayed
      // scheduleImmediateRun 会检查 getAppActivity
      expect(ctx.getAppActivity).toHaveBeenCalled();

      service.stop();
    });
  });

  // -------------------------------------------------------------------------
  // 16. 每次运行后重新调度
  // -------------------------------------------------------------------------

  describe('每次运行后重新调度', () => {
    it('备份完成后安排下一次运行', async () => {
      const ctx = createTestContext({
        config: { enabled: true, frequency: 'daily' },
        state: { nextRunAt: null },
      });
      mockRunRemoteBackup.mockResolvedValue({ success: true, remoteFileName: 'b.zip' });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      // 停止旧定时器，使 timerId = null
      service.stop();
      ctx.timers.setTimeout.mockClear();

      // runNow 不会走 startScheduler（因为 enabled 检查在 finally 块）
      // 但 finally 块中 startScheduler 会因 timerId=null 而注册新定时器
      await service.runNow();

      // startScheduler 在 finally 中被调用，注册了新定时器
      expect(ctx.timers.setTimeout).toHaveBeenCalledTimes(1);

      service.stop();
    });
  });

  // -------------------------------------------------------------------------
  // 17. 停止调度器
  // -------------------------------------------------------------------------

  describe('停止调度器', () => {
    it('清除所有定时器', async () => {
      const ctx = createTestContext({
        config: { enabled: true, frequency: 'daily' },
        state: { nextRunAt: null },
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      expect(ctx.timers.setTimeout).toHaveBeenCalled();

      service.stop();

      expect(ctx.timers.clearTimeout).toHaveBeenCalled();
      const st = service.getState();
      expect(st.timerId).toBeNull();
      expect(st.quietPeriodTimer).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 18. 防止并发运行
  // -------------------------------------------------------------------------

  describe('防止并发运行', () => {
    it('isRunning 为 true 时不执行第二次备份', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
      });

      let resolveFirst: (() => void) | undefined;
      mockRunRemoteBackup.mockImplementation(
        () =>
          new Promise<{ success: boolean; remoteFileName: string }>((resolve) => {
            resolveFirst = () => resolve({ success: true, remoteFileName: 'b.zip' });
          }),
      );

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      const firstRun = service.runNow();
      await vi.advanceTimersByTimeAsync(0);

      await service.runNow();

      expect(mockRunRemoteBackup).toHaveBeenCalledTimes(1);

      resolveFirst!();
      await firstRun;

      service.stop();
    });

    it('runNow 进行中时 runBeforeExit reject', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
      });

      let resolveFirst: (() => void) | undefined;
      mockRunRemoteBackup.mockImplementation(
        () =>
          new Promise<{ success: boolean; remoteFileName: string }>((resolve) => {
            resolveFirst = () => resolve({ success: true, remoteFileName: 'b.zip' });
          }),
      );

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      const firstRun = service.runNow();
      await vi.advanceTimersByTimeAsync(0);

      await expect(service.runBeforeExit()).rejects.toThrow(
        '备份任务正在运行中，请稍候再试',
      );

      resolveFirst!();
      await firstRun;
      service.stop();
    });

    it('manual 触发 busy 时记录 single-flight 状态后静默返回', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
      });

      let resolveFirst: (() => void) | undefined;
      mockRunRemoteBackup.mockImplementation(
        () =>
          new Promise<{ success: boolean; remoteFileName: string }>((resolve) => {
            resolveFirst = () => resolve({ success: true, remoteFileName: 'b.zip' });
          }),
      );

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      const firstRun = service.runNow();
      await vi.advanceTimersByTimeAsync(0);

      await service.runNow();

      const calls = ctx.saveScheduledState.mock.calls;
      const savedState = calls[calls.length - 1]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.lastTrigger).toBe('manual');
      expect(savedState!.lastFinishedAt).toBe(ctx.now);
      expect(savedState!.lastFailureAt).toBe(ctx.now);
      expect(savedState!.lastFailureReason).toBe('备份任务正在运行中');
      expect(savedState!.lastFailureStage).toBe('single-flight');

      expect(mockRunRemoteBackup).toHaveBeenCalledTimes(1);

      resolveFirst!();
      await firstRun;
      service.stop();
    });

    it('定时备份运行中手动触发时记录 manual single-flight 状态', async () => {
      const ctx = createTestContext({
        config: { enabled: true, frequency: 'daily', quietPeriodMinutes: 5 },
        state: { nextRunAt: 1000000000000 - 1000 },
      });
      ctx.getAppActivity.mockReturnValue(INACTIVE_ACTIVITY);

      let resolveFirst: (() => void) | undefined;
      mockRunRemoteBackup.mockImplementation(
        () =>
          new Promise<{ success: boolean; remoteFileName: string }>((resolve) => {
            resolveFirst = () => resolve({ success: true, remoteFileName: 'b.zip' });
          }),
      );

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      await vi.advanceTimersByTimeAsync(0);

      await service.runNow();

      const calls = ctx.saveScheduledState.mock.calls;
      const savedState = calls[calls.length - 1]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.lastTrigger).toBe('manual');
      expect(savedState!.lastFinishedAt).toBe(ctx.now);
      expect(savedState!.lastFailureAt).toBe(ctx.now);
      expect(savedState!.lastFailureReason).toBe('备份任务正在运行中');
      expect(savedState!.lastFailureStage).toBe('single-flight');

      resolveFirst!();
      await vi.advanceTimersByTimeAsync(0);
      service.stop();
    });

    it('before-exit 触发 busy 时记录 single-flight 状态并仍 reject', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
      });

      let resolveFirst: (() => void) | undefined;
      mockRunRemoteBackup.mockImplementation(
        () =>
          new Promise<{ success: boolean; remoteFileName: string }>((resolve) => {
            resolveFirst = () => resolve({ success: true, remoteFileName: 'b.zip' });
          }),
      );

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      const firstRun = service.runNow();
      await vi.advanceTimersByTimeAsync(0);

      await expect(service.runBeforeExit()).rejects.toThrow(
        '备份任务正在运行中，请稍候再试',
      );

      const calls = ctx.saveScheduledState.mock.calls;
      const savedState = calls[calls.length - 1]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.lastTrigger).toBe('before-exit');
      expect(savedState!.lastFinishedAt).toBe(ctx.now);
      expect(savedState!.lastFailureAt).toBe(ctx.now);
      expect(savedState!.lastFailureReason).toBe('备份任务正在运行中');
      expect(savedState!.lastFailureStage).toBe('single-flight');

      resolveFirst!();
      await firstRun;
      service.stop();
    });
  });

  // -------------------------------------------------------------------------
  // 19. 任务类型映射
  // -------------------------------------------------------------------------

  describe('任务类型映射', () => {
    it('manual 触发使用 manual-remote-backup', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
        state: { lastSuccessfulStorageUpdatedAt: null },
      });
      mockRunRemoteBackup.mockResolvedValueOnce({
        success: true,
        remoteFileName: 'backup.zip',
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runNow();

      expect(mockRunRemoteBackup).toHaveBeenCalledWith(
        ctx.runnerDeps,
        expect.any(Object),
        { jobKind: 'manual-remote-backup' },
      );

      service.stop();
    });

    it('before-exit 触发使用 before-exit-remote-backup', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
        state: { lastSuccessfulStorageUpdatedAt: null },
      });
      mockRunRemoteBackup.mockResolvedValueOnce({
        success: true,
        remoteFileName: 'backup.zip',
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runBeforeExit();

      expect(mockRunRemoteBackup).toHaveBeenCalledWith(
        ctx.runnerDeps,
        expect.any(Object),
        { jobKind: 'before-exit-remote-backup' },
      );

      service.stop();
    });

    it('scheduled-interval 触发使用 scheduled-remote-backup', async () => {
      const ctx = createTestContext({
        config: { enabled: true, frequency: 'daily', quietPeriodMinutes: 5 },
        state: { nextRunAt: 1000000000000 - 1000 },
      });
      ctx.getAppActivity.mockReturnValue(INACTIVE_ACTIVITY);
      mockRunRemoteBackup.mockResolvedValue({
        success: true,
        remoteFileName: 'backup.zip',
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      // startScheduler → nextRunAt <= now → scheduleImmediateRun → idle → runBackup('scheduled-interval')
      // 但 runBackup 是异步的，需要 flush
      await vi.advanceTimersByTimeAsync(0);

      expect(mockRunRemoteBackup).toHaveBeenCalledWith(
        ctx.runnerDeps,
        expect.any(Object),
        { jobKind: 'scheduled-remote-backup' },
      );

      service.stop();
    });
  });

  // -------------------------------------------------------------------------
  // 20. 固定频率定时器经安静时段门控
  // -------------------------------------------------------------------------

  describe('固定频率定时器经安静时段门控', () => {
    it('定时器触发时若应用活跃，注册安静时段定时器且不立即执行备份', async () => {
      const ctx = createTestContext({
        config: { enabled: true, frequency: 'daily', quietPeriodMinutes: 5 },
        state: { nextRunAt: null },
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      // 获取固定频率定时器回调
      const freqCallback = ctx.timers.setTimeout.mock.calls[0]?.[0] as (() => void) | undefined;
      expect(freqCallback).toBeDefined();

      // 模拟应用活跃
      ctx.getAppActivity.mockReturnValue(ACTIVE_ACTIVITY);

      // 触发定时器
      freqCallback!();

      // timerId 已被回调清除
      const st = service.getState();
      expect(st.timerId).toBeNull();

      // scheduleImmediateRun 检测到 active → 注册安静时段定时器
      const quietMs = 5 * 60 * 1000;
      expect(ctx.timers.setTimeout).toHaveBeenCalledWith(
        expect.any(Function),
        quietMs,
      );

      // 备份不应被调用
      expect(mockRunRemoteBackup).not.toHaveBeenCalled();

      service.stop();
    });
  });

  // -------------------------------------------------------------------------
  // 21. 定时器回调清除 timerId 后可重新调度
  // -------------------------------------------------------------------------

  describe('定时器回调清除 timerId 后可重新调度', () => {
    it('回调触发后成功运行可安排下一次定时器', async () => {
      const ctx = createTestContext({
        config: { enabled: true, frequency: 'daily', quietPeriodMinutes: 5 },
        state: { nextRunAt: null },
      });
      ctx.getAppActivity.mockReturnValue(INACTIVE_ACTIVITY);
      mockRunRemoteBackup.mockResolvedValue({ success: true, remoteFileName: 'b.zip' });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      // 获取固定频率定时器回调
      const freqCallback = ctx.timers.setTimeout.mock.calls[0]?.[0] as (() => void) | undefined;
      expect(freqCallback).toBeDefined();

      // 清除调用记录以便观察后续调度
      ctx.timers.setTimeout.mockClear();

      // 触发回调并等待异步 runBackup 完成
      freqCallback!();
      await vi.advanceTimersByTimeAsync(0);

      // 成功后 finally 重新调度，注册新定时器
      expect(ctx.timers.setTimeout).toHaveBeenCalledTimes(1);

      service.stop();
    });
  });

  // -------------------------------------------------------------------------
  // 22. credentialActionRequired 初始状态阻止调度
  // -------------------------------------------------------------------------

  describe('credentialActionRequired 初始状态阻止调度', () => {
    it('credentialActionRequired=true 时 startScheduler 不注册定时器', async () => {
      const ctx = createTestContext({
        config: { enabled: true, frequency: 'daily' },
        state: {
          credentialActionRequired: true,
          nextRunAt: null,
        },
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      expect(ctx.timers.setTimeout).not.toHaveBeenCalled();
      const st = service.getState();
      expect(st.timerId).toBeNull();

      service.stop();
    });
  });

  // -------------------------------------------------------------------------
  // 23. lastStartedAt 在备份开始时被设置
  // -------------------------------------------------------------------------

  describe('lastStartedAt 在备份开始时被设置', () => {
    it('runBackup 开头设置 lastStartedAt 为当前时间', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
        state: { lastStartedAt: null },
      });
      mockRunRemoteBackup.mockResolvedValueOnce({
        success: true,
        remoteFileName: 'backup.zip',
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runNow();

      const savedState = ctx.saveScheduledState.mock.calls[0]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.lastStartedAt).toBe(ctx.now);
    });

    it('每次 runBackup 都更新 lastStartedAt', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
        state: { lastStartedAt: null },
      });
      mockRunRemoteBackup.mockResolvedValue({
        success: true,
        remoteFileName: 'backup.zip',
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      await service.runNow();
      const firstSavedState = ctx.saveScheduledState.mock.calls[0]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(firstSavedState!.lastStartedAt).toBe(ctx.now);

      await service.runNow();
      const secondSavedState = ctx.saveScheduledState.mock.calls[1]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(secondSavedState!.lastStartedAt).toBe(ctx.now);
    });
  });

  // -------------------------------------------------------------------------
  // 24. 成功后清空失败信息
  // -------------------------------------------------------------------------

  describe('成功后清空失败信息', () => {
    it('备份成功后清空 lastFailureReason、lastFailureAt 和 lastFailureStage', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
        state: {
          lastFailureReason: '之前的错误',
          lastFailureAt: 999999999999,
          lastFailureStage: 'upload',
        },
      });
      mockRunRemoteBackup.mockResolvedValueOnce({
        success: true,
        remoteFileName: 'backup.zip',
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runNow();

      const savedState = ctx.saveScheduledState.mock.calls[0]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.lastFailureReason).toBeNull();
      expect(savedState!.lastFailureAt).toBeNull();
      expect(savedState!.lastFailureStage).toBeNull();
    });

    it('备份成功后保留其他成功字段', async () => {
      const ctx = createTestContext({
        config: { enabled: false },
        state: {
          lastFailureReason: '之前的错误',
          lastFailureAt: 999999999999,
          lastFailureStage: 'upload',
          lastSuccessfulStorageUpdatedAt: 5000,
        },
      });
      ctx.readDiskStorageData.mockResolvedValueOnce(makeStorageData({ storageUpdatedAt: 7000 }));
      ctx.getLatestUpdateTimestamp.mockReturnValue(7000);
      mockRunRemoteBackup.mockResolvedValueOnce({
        success: true,
        remoteFileName: 'backup.zip',
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runNow();

      const savedState = ctx.saveScheduledState.mock.calls[0]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.lastFailureReason).toBeNull();
      expect(savedState!.lastFailureAt).toBeNull();
      expect(savedState!.lastFailureStage).toBeNull();
      expect(savedState!.lastManualSuccessAt).toBe(ctx.now);
      expect(savedState!.lastSuccessfulStorageUpdatedAt).toBe(7000);
      expect(savedState!.lastRemoteFileName).toBe('backup.zip');
    });
  });

  // -------------------------------------------------------------------------
  // 24. 保留策略编排集成
  // -------------------------------------------------------------------------

  describe('保留策略编排集成', () => {
    it('scheduled-interval 成功后调用 orchestrator', async () => {
      const ctx = createTestContext({
        config: { enabled: true, frequency: 'daily', retentionEnabled: true, retentionCount: 10 },
        state: { nextRunAt: null },
      });
      ctx.getAppActivity.mockReturnValue(INACTIVE_ACTIVITY);
      mockRunRemoteBackup.mockResolvedValue({
        success: true,
        remoteFileName: 'SoNotes_Backup_20260101.zip',
        summary: null,
        zipSizeBytes: null,
      });
      mockOrchestrateRetentionCleanup.mockResolvedValue({});

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();

      const freqCallback = ctx.timers.setTimeout.mock.calls[0]?.[0] as (() => void) | undefined;
      expect(freqCallback).toBeDefined();
      freqCallback!();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockOrchestrateRetentionCleanup).toHaveBeenCalledTimes(1);
      expect(mockOrchestrateRetentionCleanup).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: 'scheduled-interval' }),
      );

      service.stop();
    });

    it('orchestrator 返回 patch 合并到保存状态', async () => {
      const retentionPatch = {
        cliffDropDeferred: true,
        cliffDropDetectedAt: 1000000000000,
        baselineConfirmedRemoteCount: 5,
      };
      mockOrchestrateRetentionCleanup.mockResolvedValue(retentionPatch);

      const ctx = createTestContext({
        config: { enabled: false, retentionEnabled: true, retentionCount: 10 },
      });
      mockRunRemoteBackup.mockResolvedValue({
        success: true,
        remoteFileName: 'backup.zip',
        summary: null,
        zipSizeBytes: null,
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runNow();

      expect(mockOrchestrateRetentionCleanup).toHaveBeenCalledTimes(1);
      const calls = ctx.saveScheduledState.mock.calls;
      const savedState = calls[calls.length - 1]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.cliffDropDeferred).toBe(true);
      expect(savedState!.cliffDropDetectedAt).toBe(1000000000000);
      expect(savedState!.baselineConfirmedRemoteCount).toBe(5);
    });

    it('orchestrator 抛异常不影响备份成功状态', async () => {
      mockOrchestrateRetentionCleanup.mockRejectedValue(new Error('orchestrator failed'));

      const ctx = createTestContext({
        config: { enabled: false, retentionEnabled: true, retentionCount: 5 },
      });
      mockRunRemoteBackup.mockResolvedValue({
        success: true,
        remoteFileName: 'backup.zip',
        summary: null,
        zipSizeBytes: null,
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runNow();

      const savedState = ctx.saveScheduledState.mock.calls[0]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.lastFailureReason).toBeNull();
      expect(savedState!.lastRemoteFileName).toBe('backup.zip');
    });

    it('orchestrator 抛异常时 lastRetentionCleanupError 被写入', async () => {
      mockOrchestrateRetentionCleanup.mockRejectedValue(new Error('retention network timeout'));

      const ctx = createTestContext({
        config: { enabled: false, retentionEnabled: true, retentionCount: 5 },
      });
      mockRunRemoteBackup.mockResolvedValue({
        success: true,
        remoteFileName: 'backup.zip',
        summary: null,
        zipSizeBytes: null,
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runNow();

      const savedState = ctx.saveScheduledState.mock.calls[0]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.lastRetentionCleanupError).toBe('retention network timeout');
      expect(savedState!.lastRetentionCleanupAt).toBe(ctx.now);
    });

    it('orchestrator 抛非 Error 对象时 lastRetentionCleanupError 也被写入', async () => {
      mockOrchestrateRetentionCleanup.mockRejectedValue('string error');

      const ctx = createTestContext({
        config: { enabled: false, retentionEnabled: true, retentionCount: 5 },
      });
      mockRunRemoteBackup.mockResolvedValue({
        success: true,
        remoteFileName: 'backup.zip',
        summary: null,
        zipSizeBytes: null,
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runNow();

      const savedState = ctx.saveScheduledState.mock.calls[0]?.[0] as
        | ScheduledRemoteBackupState
        | undefined;
      expect(savedState).toBeDefined();
      expect(savedState!.lastRetentionCleanupError).toBe('string error');
      expect(savedState!.lastRetentionCleanupAt).toBe(ctx.now);
    });

    it('orchestrator 返回空 patch 不产生额外 saveScheduledState 调用', async () => {
      mockOrchestrateRetentionCleanup.mockResolvedValue({});

      const ctx = createTestContext({
        config: { enabled: false, retentionEnabled: true, retentionCount: 5 },
      });
      mockRunRemoteBackup.mockResolvedValue({
        success: true,
        remoteFileName: 'backup.zip',
        summary: null,
        zipSizeBytes: null,
      });

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runNow();

      expect(mockOrchestrateRetentionCleanup).toHaveBeenCalledTimes(1);
      expect(ctx.saveScheduledState).toHaveBeenCalledTimes(1);
    });

    it('无本地变化跳过上传时不调用 orchestrator', async () => {
      const storageData = makeStorageData({ storageUpdatedAt: 5000 });
      const ctx = createTestContext({
        config: { enabled: false, retentionEnabled: true, retentionCount: 10 },
        state: { lastSuccessfulStorageUpdatedAt: 5000 },
      });
      ctx.readDiskStorageData.mockResolvedValueOnce(storageData);
      ctx.getLatestUpdateTimestamp.mockReturnValueOnce(5000);
      mockOrchestrateRetentionCleanup.mockResolvedValue({});

      const service = createScheduledRemoteBackupService(ctx.deps);
      await service.initialize();
      await service.runNow();

      expect(mockRunRemoteBackup).not.toHaveBeenCalled();
      expect(mockOrchestrateRetentionCleanup).not.toHaveBeenCalled();

      service.stop();
    });
  });
});
