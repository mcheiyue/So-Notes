import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  tryStartBackupJob,
  getActiveBackupJob,
  subscribeBackupJob,
  _resetCoordinatorForTesting,
  type BackupJobKind,
} from './BackupJobCoordinator';

describe('BackupJobCoordinator', () => {
  beforeEach(() => {
    _resetCoordinatorForTesting();
  });

  // -------------------------------------------------------------------------
  // 基本获取与释放
  // -------------------------------------------------------------------------

  describe('tryStartBackupJob', () => {
    it('无活跃任务时成功获取', () => {
      const handle = tryStartBackupJob('manual-remote-backup');

      expect(handle).not.toBeNull();
      expect(handle!.kind).toBe('manual-remote-backup');
      expect(typeof handle!.startedAt).toBe('number');
      expect(handle!.startedAt).toBeGreaterThan(0);
      handle!.release();
    });

    it('获取后 getActiveBackupJob 返回快照', () => {
      const handle = tryStartBackupJob('scheduled-remote-backup');

      const snapshot = getActiveBackupJob();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.kind).toBe('scheduled-remote-backup');
      expect(snapshot!.startedAt).toBe(handle!.startedAt);
      handle!.release();
    });

    it('所有 BackupJobKind 值均可获取', () => {
      const kinds: BackupJobKind[] = [
        'manual-local-backup',
        'manual-remote-backup',
        'scheduled-remote-backup',
        'before-exit-remote-backup',
        'local-restore',
        'remote-restore',
      ];

      for (const kind of kinds) {
        const handle = tryStartBackupJob(kind);
        expect(handle).not.toBeNull();
        expect(handle!.kind).toBe(kind);
        handle!.release();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 重复进入（single-flight）
  // -------------------------------------------------------------------------

  describe('重复进入', () => {
    it('已有活跃任务时返回 null', () => {
      const first = tryStartBackupJob('manual-remote-backup');
      expect(first).not.toBeNull();

      const second = tryStartBackupJob('scheduled-remote-backup');
      expect(second).toBeNull();

      first!.release();
    });

    it('同类型任务重复进入也返回 null', () => {
      const first = tryStartBackupJob('manual-local-backup');
      const second = tryStartBackupJob('manual-local-backup');
      expect(second).toBeNull();
      first!.release();
    });

    it('不同任务类型之间也互斥', () => {
      const restore = tryStartBackupJob('local-restore');
      expect(restore).not.toBeNull();

      const backup = tryStartBackupJob('manual-remote-backup');
      expect(backup).toBeNull();

      restore!.release();
    });
  });

  // -------------------------------------------------------------------------
  // 释放后可再次获取
  // -------------------------------------------------------------------------

  describe('释放后可再次获取', () => {
    it('release 后可以启动新任务', () => {
      const first = tryStartBackupJob('manual-remote-backup');
      first!.release();

      const second = tryStartBackupJob('scheduled-remote-backup');
      expect(second).not.toBeNull();
      expect(second!.kind).toBe('scheduled-remote-backup');
      second!.release();
    });

    it('释放后 getActiveBackupJob 返回 null', () => {
      const handle = tryStartBackupJob('before-exit-remote-backup');
      handle!.release();

      expect(getActiveBackupJob()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 异常 / finally 释放模式
  // -------------------------------------------------------------------------

  describe('异常 / finally 释放', () => {
    it('finally 块中 release 确保异常后释放', async () => {
      const simulateBackupJob = async (): Promise<boolean> => {
        const handle = tryStartBackupJob('manual-remote-backup');
        if (handle === null) return false;
        try {
          throw new Error('模拟备份失败');
        } finally {
          handle.release();
        }
      };

      // 第一次应抛出异常但释放锁
      await expect(simulateBackupJob()).rejects.toThrow('模拟备份失败');

      // 异常后锁已释放，可以再次获取
      const handle = tryStartBackupJob('manual-remote-backup');
      expect(handle).not.toBeNull();
      handle!.release();
    });

    it('成功路径中 finally 块也正确释放', async () => {
      const simulateSuccessfulJob = async (): Promise<boolean> => {
        const handle = tryStartBackupJob('scheduled-remote-backup');
        if (handle === null) return false;
        try {
          return true;
        } finally {
          handle.release();
        }
      };

      const result = await simulateSuccessfulJob();
      expect(result).toBe(true);
      expect(getActiveBackupJob()).toBeNull();
    });

    it('未释放时任务保持活跃', () => {
      const handle = tryStartBackupJob('remote-restore');
      expect(handle).not.toBeNull();
      try {
        expect(getActiveBackupJob()).not.toBeNull();
        expect(getActiveBackupJob()!.kind).toBe('remote-restore');
      } finally {
        handle!.release();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 重复释放幂等
  // -------------------------------------------------------------------------

  describe('重复释放幂等', () => {
    it('多次 release 不会出错或影响后续任务', () => {
      const handle = tryStartBackupJob('manual-remote-backup');
      handle!.release();
      handle!.release(); // 第二次 release 应为 no-op

      expect(getActiveBackupJob()).toBeNull();

      // 后续任务正常获取
      const next = tryStartBackupJob('local-restore');
      expect(next).not.toBeNull();
      next!.release();
    });

    it('不同 handle 的 release 互不影响', () => {
      const first = tryStartBackupJob('manual-local-backup');
      first!.release();

      const second = tryStartBackupJob('manual-remote-backup');
      try {
        first!.release(); // no-op：已释放的旧 handle

        expect(getActiveBackupJob()).not.toBeNull();
        expect(getActiveBackupJob()!.kind).toBe('manual-remote-backup');
      } finally {
        second!.release();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 订阅通知
  // -------------------------------------------------------------------------

  describe('subscribeBackupJob', () => {
    it('任务启动时通知订阅者', () => {
      const listener = vi.fn();
      const unsubscribe = subscribeBackupJob(listener);

      const handle = tryStartBackupJob('manual-remote-backup');

      expect(listener).toHaveBeenCalledTimes(1);
      handle!.release();
      unsubscribe();
    });

    it('任务释放时通知订阅者', () => {
      const listener = vi.fn();
      const unsubscribe = subscribeBackupJob(listener);

      const handle = tryStartBackupJob('manual-remote-backup');
      expect(listener).toHaveBeenCalledTimes(1);

      handle!.release();
      expect(listener).toHaveBeenCalledTimes(2);
      unsubscribe();
    });

    it('完整生命周期：启动 + 释放共通知两次', () => {
      const listener = vi.fn();
      const unsubscribe = subscribeBackupJob(listener);

      const handle = tryStartBackupJob('scheduled-remote-backup');
      expect(listener).toHaveBeenCalledTimes(1);

      handle!.release();
      expect(listener).toHaveBeenCalledTimes(2);
      unsubscribe();
    });

    it('多个订阅者同时收到通知', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const unsub1 = subscribeBackupJob(listener1);
      const unsub2 = subscribeBackupJob(listener2);

      const handle = tryStartBackupJob('before-exit-remote-backup');

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);

      handle!.release();
      expect(listener1).toHaveBeenCalledTimes(2);
      expect(listener2).toHaveBeenCalledTimes(2);

      unsub1();
      unsub2();
    });

    it('取消订阅后不再收到通知', () => {
      const listener = vi.fn();
      const unsubscribe = subscribeBackupJob(listener);

      const handle1 = tryStartBackupJob('manual-remote-backup');
      expect(listener).toHaveBeenCalledTimes(1);
      handle1!.release();
      expect(listener).toHaveBeenCalledTimes(2);

      // 取消订阅
      unsubscribe();

      const handle2 = tryStartBackupJob('manual-remote-backup');
      expect(listener).toHaveBeenCalledTimes(2); // 不再增加
      handle2!.release();
      expect(listener).toHaveBeenCalledTimes(2); // 仍然不增加
    });

    it('未释放时不影响 getActiveBackupJob 通过订阅获取', () => {
      let snapshotFromListener: ReturnType<typeof getActiveBackupJob> = null;
      const unsubscribe = subscribeBackupJob(() => {
        snapshotFromListener = getActiveBackupJob();
      });

      const handle = tryStartBackupJob('manual-local-backup');
      expect(snapshotFromListener).not.toBeNull();
      expect(snapshotFromListener!.kind).toBe('manual-local-backup');

      handle!.release();
      unsubscribe();
    });
  });

  // -------------------------------------------------------------------------
  // getActiveBackupJob 快照语义
  // -------------------------------------------------------------------------

  describe('getActiveBackupJob 快照语义', () => {
    it('返回当前活跃任务的快照', () => {
      expect(getActiveBackupJob()).toBeNull();

      const handle = tryStartBackupJob('manual-remote-backup');
      const snapshot = getActiveBackupJob();

      expect(snapshot).not.toBeNull();
      expect(snapshot!.kind).toBe('manual-remote-backup');
      expect(snapshot!.startedAt).toBe(handle!.startedAt);

      handle!.release();
    });

    it('释放后返回 null', () => {
      const handle = tryStartBackupJob('remote-restore');
      handle!.release();

      expect(getActiveBackupJob()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 快速连续 acquire-release-acquire 场景
  // -------------------------------------------------------------------------

  describe('快速连续操作', () => {
    it('释放后立即获取成功', () => {
      const h1 = tryStartBackupJob('manual-remote-backup');
      h1!.release();

      const h2 = tryStartBackupJob('manual-remote-backup');
      expect(h2).not.toBeNull();
      h2!.release();
    });

    it('多个任务交替获取和释放', () => {
      const kinds: BackupJobKind[] = [
        'manual-local-backup',
        'manual-remote-backup',
        'scheduled-remote-backup',
        'before-exit-remote-backup',
        'local-restore',
        'remote-restore',
      ];

      for (const kind of kinds) {
        const handle = tryStartBackupJob(kind);
        expect(handle).not.toBeNull();
        expect(getActiveBackupJob()).not.toBeNull();
        handle!.release();
        expect(getActiveBackupJob()).toBeNull();
      }
    });
  });
});
