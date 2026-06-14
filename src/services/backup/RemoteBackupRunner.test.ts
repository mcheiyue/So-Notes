import { describe, it, expect, vi } from 'vitest';

import {
  runRemoteBackup,
  RemoteBackupErrorStage,
} from './RemoteBackupRunner';
import type {
  RemoteBackupRunnerDependencies,
  BackupJobCoordinator,
} from './RemoteBackupRunner';
import type { WebDavConfig } from './WebDavBackupService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): WebDavConfig {
  return {
    serverUrl: 'https://example.com/dav',
    username: 'user',
    remoteDir: 'SoNotes_Backups/',
    password: 'secret',
  };
}

function makeCoordinator(overrides?: {
  tryStartBackupJob?: BackupJobCoordinator['tryStartBackupJob'];
}): BackupJobCoordinator {
  return {
    tryStartBackupJob: overrides?.tryStartBackupJob ?? vi.fn(() => ({
      kind: 'manual-remote-backup' as const,
      startedAt: Date.now(),
      release: vi.fn(),
    })),
  };
}

function makeDeps(overrides?: Partial<RemoteBackupRunnerDependencies>): RemoteBackupRunnerDependencies {
  return {
    flushNow: vi.fn(async () => true),
    createRemoteBackup: vi.fn(async () => ({
      success: true,
      remoteFileName: 'SoNotes_Backup_20240101120000.zip',
    })),
    readDiskStorageData: vi.fn(async () => null),
    getLatestUpdateTimestamp: vi.fn(() => 0),
    coordinator: makeCoordinator(),
    now: () => Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RemoteBackupRunner', () => {
  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe('happy path', () => {
    it('flushNow 成功且 createRemoteBackup 成功时返回 success', async () => {
      const deps = makeDeps();
      const config = makeConfig();

      const result = await runRemoteBackup(deps, config);

      expect(result.success).toBe(true);
      expect(result.remoteFileName).toBe('SoNotes_Backup_20240101120000.zip');
      expect(result.error).toBeUndefined();
      expect(deps.flushNow).toHaveBeenCalledOnce();
      expect(deps.createRemoteBackup).toHaveBeenCalledWith(config);
    });

    it('使用注入的协调器获取任务句柄', async () => {
      const releaseFn = vi.fn();
      const coordinator = makeCoordinator({
        tryStartBackupJob: vi.fn(() => ({
          kind: 'manual-remote-backup' as const,
          startedAt: Date.now(),
          release: releaseFn,
        })),
      });
      const deps = makeDeps({ coordinator });

      await runRemoteBackup(deps, makeConfig());

      expect(coordinator.tryStartBackupJob).toHaveBeenCalledWith('manual-remote-backup');
      expect(releaseFn).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Job kind option
  // -------------------------------------------------------------------------

  describe('job kind option', () => {
    it('默认使用 manual-remote-backup', async () => {
      const coordinator = makeCoordinator({
        tryStartBackupJob: vi.fn(() => ({
          kind: 'manual-remote-backup' as const,
          startedAt: Date.now(),
          release: vi.fn(),
        })),
      });
      const deps = makeDeps({ coordinator });

      await runRemoteBackup(deps, makeConfig());

      expect(coordinator.tryStartBackupJob).toHaveBeenCalledWith('manual-remote-backup');
    });

    it('可通过 options.jobKind 指定任务类型', async () => {
      const coordinator = makeCoordinator({
        tryStartBackupJob: vi.fn(() => ({
          kind: 'scheduled-remote-backup' as const,
          startedAt: Date.now(),
          release: vi.fn(),
        })),
      });
      const deps = makeDeps({ coordinator });

      await runRemoteBackup(deps, makeConfig(), { jobKind: 'scheduled-remote-backup' });

      expect(coordinator.tryStartBackupJob).toHaveBeenCalledWith('scheduled-remote-backup');
    });

    it('before-exit 使用 before-exit-remote-backup', async () => {
      const coordinator = makeCoordinator({
        tryStartBackupJob: vi.fn(() => ({
          kind: 'before-exit-remote-backup' as const,
          startedAt: Date.now(),
          release: vi.fn(),
        })),
      });
      const deps = makeDeps({ coordinator });

      await runRemoteBackup(deps, makeConfig(), { jobKind: 'before-exit-remote-backup' });

      expect(coordinator.tryStartBackupJob).toHaveBeenCalledWith('before-exit-remote-backup');
    });
  });

  // -------------------------------------------------------------------------
  // FlushNow gate
  // -------------------------------------------------------------------------

  describe('flushNow gate', () => {
    it('flushNow 返回 false 时返回 { success: false, error: "Flush failed" }', async () => {
      const deps = makeDeps({
        flushNow: vi.fn(async () => false),
      });

      const result = await runRemoteBackup(deps, makeConfig());

      expect(result.success).toBe(false);
      expect(result.error).toBe('Flush failed');
      expect(result.errorStage).toBe(RemoteBackupErrorStage.Flush);
      expect(deps.createRemoteBackup).not.toHaveBeenCalled();
    });

    it('flushNow 抛出异常时返回 { success: false, error: "Flush failed" }', async () => {
      const deps = makeDeps({
        flushNow: vi.fn(async () => {
          throw new Error('disk write error');
        }),
      });

      const result = await runRemoteBackup(deps, makeConfig());

      expect(result.success).toBe(false);
      expect(result.error).toBe('Flush failed');
      expect(result.errorStage).toBe(RemoteBackupErrorStage.Flush);
      expect(deps.createRemoteBackup).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Coordinator busy
  // -------------------------------------------------------------------------

  describe('single-flight busy', () => {
    it('协调器已有活跃任务时返回 { success: false, error: "busy" }', async () => {
      const coordinator = makeCoordinator({
        tryStartBackupJob: vi.fn(() => null),
      });
      const deps = makeDeps({ coordinator });

      const result = await runRemoteBackup(deps, makeConfig());

      expect(result.success).toBe(false);
      expect(result.error).toBe('busy');
      expect(result.errorStage).toBe(RemoteBackupErrorStage.SingleFlight);
      expect(deps.flushNow).not.toHaveBeenCalled();
      expect(deps.createRemoteBackup).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Job always released
  // -------------------------------------------------------------------------

  describe('job always released', () => {
    it('成功路径：任务句柄在完成后释放', async () => {
      const releaseFn = vi.fn();
      const coordinator = makeCoordinator({
        tryStartBackupJob: vi.fn(() => ({
          kind: 'manual-remote-backup' as const,
          startedAt: Date.now(),
          release: releaseFn,
        })),
      });
      const deps = makeDeps({ coordinator });

      await runRemoteBackup(deps, makeConfig());

      expect(releaseFn).toHaveBeenCalledOnce();
    });

    it('flushNow 失败路径：任务句柄在完成后释放', async () => {
      const releaseFn = vi.fn();
      const coordinator = makeCoordinator({
        tryStartBackupJob: vi.fn(() => ({
          kind: 'manual-remote-backup' as const,
          startedAt: Date.now(),
          release: releaseFn,
        })),
      });
      const deps = makeDeps({
        coordinator,
        flushNow: vi.fn(async () => false),
      });

      await runRemoteBackup(deps, makeConfig());

      expect(releaseFn).toHaveBeenCalledOnce();
    });

    it('createRemoteBackup 抛出异常时：任务句柄在完成后释放', async () => {
      const releaseFn = vi.fn();
      const coordinator = makeCoordinator({
        tryStartBackupJob: vi.fn(() => ({
          kind: 'manual-remote-backup' as const,
          startedAt: Date.now(),
          release: releaseFn,
        })),
      });
      const deps = makeDeps({
        coordinator,
        createRemoteBackup: vi.fn(async () => {
          throw new Error('network timeout');
        }),
      });

      await runRemoteBackup(deps, makeConfig());

      expect(releaseFn).toHaveBeenCalledOnce();
    });

    it('single-flight busy 路径：不调用协调器以外的操作', async () => {
      const coordinator = makeCoordinator({
        tryStartBackupJob: vi.fn(() => null),
      });
      const deps = makeDeps({ coordinator });

      await runRemoteBackup(deps, makeConfig());

      expect(deps.flushNow).not.toHaveBeenCalled();
      expect(deps.createRemoteBackup).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Error propagation from createRemoteBackup
  // -------------------------------------------------------------------------

  describe('error propagation', () => {
    it('createRemoteBackup 抛出异常时返回 { success: false, error: message }', async () => {
      const deps = makeDeps({
        createRemoteBackup: vi.fn(async () => {
          throw new Error('WebDAV 服务器返回异常状态码: 500');
        }),
      });

      const result = await runRemoteBackup(deps, makeConfig());

      expect(result.success).toBe(false);
      expect(result.error).toBe('WebDAV 服务器返回异常状态码: 500');
      expect(result.errorStage).toBe(RemoteBackupErrorStage.Unknown);
    });

    it('createRemoteBackup 返回失败结果时直接传播', async () => {
      const deps = makeDeps({
        createRemoteBackup: vi.fn(async () => ({
          success: false,
          error: 'WebDAV 鉴权失败',
          errorStage: 'auth',
          errorCode: '401',
        })),
      });

      const result = await runRemoteBackup(deps, makeConfig());

      expect(result.success).toBe(false);
      expect(result.error).toBe('WebDAV 鉴权失败');
      expect(result.errorStage).toBe('auth');
      expect(result.errorCode).toBe('401');
    });

    it('非 Error 类型异常的消息被转为字符串', async () => {
      const deps = makeDeps({
        createRemoteBackup: vi.fn(() => Promise.reject('string error')),
      });

      const result = await runRemoteBackup(deps, makeConfig());

      expect(result.success).toBe(false);
      expect(result.error).toBe('string error');
      expect(result.errorStage).toBe(RemoteBackupErrorStage.Unknown);
    });
  });
});
