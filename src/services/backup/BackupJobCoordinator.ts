/**
 * 备份任务 single-flight 协调器。
 *
 * 同一时间只允许一个备份 / 恢复任务活跃。调用方通过
 * `tryStartBackupJob` 获取任务句柄，完成后必须调用
 * `handle.release()` 释放锁，允许下一次任务进入。
 *
 * 设计原则：
 * - 模块级单例状态，与 PersistenceFacade 风格一致。
 * - 不无限排队：已有任务时直接返回 null。
 * - 异常释放路径可测试：调用方应将 release 放在 finally 块中。
 */

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * 备份 / 恢复任务类型，覆盖手动本地/远端备份、定时远端备份、
 * 退出前远端备份、本地恢复、远端恢复。
 */
export type BackupJobKind =
  | 'manual-local-backup'
  | 'manual-remote-backup'
  | 'scheduled-remote-backup'
  | 'before-exit-remote-backup'
  | 'local-restore'
  | 'remote-restore';

/**
 * 当前活跃任务的只读快照，不包含可变状态。
 */
export interface BackupJobSnapshot {
  readonly kind: BackupJobKind;
  readonly startedAt: number;
}

/**
 * 任务句柄。调用方必须在任务完成或取消时调用 `release()`。
 *
 * 典型用法：
 * ```ts
 * const handle = tryStartBackupJob('manual-remote-backup');
 * if (!handle) return; // 单飞锁定，跳过
 * try {
 *   await doBackup();
 * } finally {
 *   handle.release();
 * }
 * ```
 */
export interface BackupJobHandle {
  readonly kind: BackupJobKind;
  readonly startedAt: number;
  release(): void;
}

// ---------------------------------------------------------------------------
// 模块级状态
// ---------------------------------------------------------------------------

let activeJob: BackupJobSnapshot | null = null;
const listeners = new Set<() => void>();

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * 重置协调器状态（仅用于测试）。
 *
 * 清空活跃任务和所有订阅者，确保测试间隔离。
 * 生产代码不应调用此函数。
 */
export function _resetCoordinatorForTesting(): void {
  activeJob = null;
  listeners.clear();
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 尝试启动一个备份任务。
 *
 * - 如果没有活跃任务，立即获取锁并返回 `BackupJobHandle`。
 * - 如果已有活跃任务，返回 `null`（不排队、不阻塞）。
 *
 * 调用方必须在任务完成或取消时调用 `handle.release()`。
 * 推荐在 `try/finally` 中使用，确保异常路径也能释放锁。
 */
export function tryStartBackupJob(kind: BackupJobKind): BackupJobHandle | null {
  if (activeJob !== null) {
    return null;
  }

  const now = Date.now();
  const snapshot: BackupJobSnapshot = { kind, startedAt: now };
  activeJob = snapshot;
  notifyListeners();

  return {
    kind,
    startedAt: now,
    release(): void {
      // 守卫：只有当前活跃任务与启动时一致时才释放，
      // 防止重复释放或释放已不存在的旧任务。
      if (
        activeJob !== null &&
        activeJob.kind === kind &&
        activeJob.startedAt === now
      ) {
        activeJob = null;
        notifyListeners();
      }
    },
  };
}

/**
 * 获取当前活跃任务的快照。如果没有活跃任务，返回 `null`。
 *
 * 返回值是快照副本，读取后即使任务释放也不受影响。
 */
export function getActiveBackupJob(): BackupJobSnapshot | null {
  return activeJob;
}

/**
 * 订阅任务变化。当任务启动或释放时调用 `listener`。
 *
 * 返回取消订阅函数，调用后 listener 不再被通知。
 */
export function subscribeBackupJob(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
