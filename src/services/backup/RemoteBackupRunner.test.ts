import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  tryStartBackupJob,
  _resetCoordinatorForTesting,
  getActiveBackupJob,
} from './BackupJobCoordinator';

import { runRemoteBackup, RemoteBackupErrorStage } from './RemoteBackupRunner';
import type { RemoteBackupRunnerDependencies } from './RemoteBackupRunner';
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

function makeDeps(overrides?: Partial<RemoteBackupRunnerDependencies>): RemoteBackupRunnerDependencies {
  return {
    flushNow: vi.fn(async () => true),
    createRemoteBackup: vi.fn(async () => ({
      success: true,
      remoteFileName: 'SoNotes_Backup_20240101120000.zip',
    })),
    readDiskStorageData: vi.fn(async () => null),
    getLatestUpdateTimestamp: vi.fn(() => 0),
    coordinator: null,
    now: () => Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RemoteBackupRunner', () => {
  beforeEach(() => {
    _resetCoordinatorForTesting();
  });

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

  describe('coordinator busy', () => {
    it('协调器已有活跃任务时返回 { success: false, error: "busy" }', async () => {
      const deps = makeDeps();

      // 占用协调器
      const blockingHandle = tryStartBackupJob('manual-local-backup');
      expect(blockingHandle).not.toBeNull();

      const result = await runRemoteBackup(deps, makeConfig());

      expect(result.success).toBe(false);
      expect(result.error).toBe('busy');
      expect(result.errorStage).toBe(RemoteBackupErrorStage.CoordinatorBusy);
      expect(deps.flushNow).not.toHaveBeenCalled();
      expect(deps.createRemoteBackup).not.toHaveBeenCalled();

      blockingHandle!.release();
    });
  });

  // -------------------------------------------------------------------------
  // Job always released
  // -------------------------------------------------------------------------

  describe('job always released', () => {
    it('成功路径：任务句柄在完成后释放', async () => {
      const deps = makeDeps();

      await runRemoteBackup(deps, makeConfig());

      // 协调器应已释放，可以再次获取
      const handle = tryStartBackupJob('manual-remote-backup');
      expect(handle).not.toBeNull();
      handle!.release();
    });

    it('flushNow 失败路径：任务句柄在完成后释放', async () => {
      const deps = makeDeps({
        flushNow: vi.fn(async () => false),
      });

      await runRemoteBackup(deps, makeConfig());

      const handle = tryStartBackupJob('manual-remote-backup');
      expect(handle).not.toBeNull();
      handle!.release();
    });

    it('createRemoteBackup 抛出异常时：任务句柄在完成后释放', async () => {
      const deps = makeDeps({
        createRemoteBackup: vi.fn(async () => {
          throw new Error('network timeout');
        }),
      });

      await runRemoteBackup(deps, makeConfig());

      const handle = tryStartBackupJob('manual-remote-backup');
      expect(handle).not.toBeNull();
      handle!.release();
    });

    it('coordinator busy 路径：不占用句柄，协调器保持可用', async () => {
      const deps = makeDeps();
      const blockingHandle = tryStartBackupJob('manual-local-backup');
      expect(blockingHandle).not.toBeNull();

      await runRemoteBackup(deps, makeConfig());

      // coordinator 仍被 blocking handle 占用
      const anotherHandle = tryStartBackupJob('manual-remote-backup');
      expect(anotherHandle).toBeNull();

      blockingHandle!.release();
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
        createRemoteBackup: vi.fn(async () => {
          throw 'string error'; // eslint-disable-line no-throw-literal
        }),
      });

      const result = await runRemoteBackup(deps, makeConfig());

      expect(result.success).toBe(false);
      expect(result.error).toBe('string error');
      expect(result.errorStage).toBe(RemoteBackupErrorStage.Unknown);
    });
  });
});
