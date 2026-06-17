/**
 * 远端备份执行器。
 *
 * 从 BoardDock 手动备份流程中提取而来，封装了
 * coordinator 获取 → flush → createRemoteBackup 的完整链路。
 * BoardDock / 定时备份 / 退出前备份均可调用此模块。
 */

import type { BackupJobKind, BackupJobHandle } from './BackupJobCoordinator';
import type { WebDavConfig, WebDavUploadResult } from './WebDavBackupService';
import type { StorageData } from '../../store/types';

// ---------------------------------------------------------------------------
// 协调器注入接口
// ---------------------------------------------------------------------------

/**
 * 备份任务协调器接口。
 *
 * 替代直接导入 BackupJobCoordinator 模块级单例，
 * 通过依赖注入实现可测试性和多入口复用。
 */
export interface BackupJobCoordinator {
  tryStartBackupJob(kind: BackupJobKind): BackupJobHandle | null;
}

// ---------------------------------------------------------------------------
// 依赖注入接口
// ---------------------------------------------------------------------------

/**
 * 运行远端备份所需的外部依赖。
 *
 * 使用接口注入而非直接引用模块级单例，
 * 便于测试 mock 和未来多入口复用。
 */
export interface RemoteBackupRunnerDependencies {
  /** 将内存数据刷写到磁盘。返回 false 表示刷写失败。 */
  flushNow: () => Promise<boolean>;
  /** 调用 Rust 侧执行远端备份上传。 */
  createRemoteBackup: (config: WebDavConfig) => Promise<WebDavUploadResult>;
  /** 读取磁盘存储数据。 */
  readDiskStorageData: () => Promise<StorageData | null>;
  /** 获取最近更新时间戳。 */
  getLatestUpdateTimestamp: (data: StorageData) => number | null;
  /** 备份任务协调器，管理 single-flight 锁。 */
  coordinator: BackupJobCoordinator;
  /** 当前时间戳函数。 */
  now: () => number;
}

// ---------------------------------------------------------------------------
// 运行选项
// ---------------------------------------------------------------------------

export interface RunRemoteBackupOptions {
  /** 备份任务类型，用于协调器 single-flight 锁。默认 'manual-remote-backup'。 */
  jobKind?: BackupJobKind;
}

// ---------------------------------------------------------------------------
// 错误阶段常量（与 RemoteBackupStage 联合类型对齐）
// ---------------------------------------------------------------------------

import type { RemoteBackupStage } from './ScheduledRemoteBackupConfigService';

export const RemoteBackupErrorStage: Record<string, RemoteBackupStage> = {
  Flush: 'flush',
  SingleFlight: 'single-flight',
  Unknown: 'unknown',
} as const;

// ---------------------------------------------------------------------------
// 运行入口
// ---------------------------------------------------------------------------

/**
 * 执行一次远端备份。
 *
 * 流程：
 * 1. 通过注入的 coordinator.tryStartBackupJob 获取任务句柄。
 * 2. 调用 deps.flushNow() 将内存数据刷写到磁盘。
 * 3. 调用 deps.createRemoteBackup(config) 执行远端备份上传。
 * 4. 无论成功或异常，始终释放任务句柄。
 */
export async function runRemoteBackup(
  deps: RemoteBackupRunnerDependencies,
  config: WebDavConfig,
  options?: RunRemoteBackupOptions,
): Promise<WebDavUploadResult> {
  const jobKind = options?.jobKind ?? 'manual-remote-backup';
  const handle = deps.coordinator.tryStartBackupJob(jobKind);
  if (!handle) {
    return {
      success: false,
      error: 'busy',
      errorStage: RemoteBackupErrorStage.SingleFlight,
      summary: null,
      zipSizeBytes: null,
    };
  }

  try {
    // 1. FlushNow gate：确保内存数据已写入磁盘
    let flushed = false;
    try {
      flushed = await deps.flushNow();
    } catch {
      flushed = false;
    }
    if (!flushed) {
      return {
        success: false,
        error: 'Flush failed',
        errorStage: RemoteBackupErrorStage.Flush,
        summary: null,
        zipSizeBytes: null,
      };
    }

    // 2. flushNow 成功后重新读盘，捕获最新 storageUpdatedAt
    let capturedStorageUpdatedAt: number | null = null;
    try {
      const postFlushData = await deps.readDiskStorageData();
      if (postFlushData) {
        capturedStorageUpdatedAt = deps.getLatestUpdateTimestamp(postFlushData);
      }
    } catch {
      // 读盘失败不阻塞备份流程
    }

    // 3. 调用 Rust 侧执行远端备份上传
    const result = await deps.createRemoteBackup(config);
    return { ...result, capturedStorageUpdatedAt };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: message,
      errorStage: RemoteBackupErrorStage.Unknown,
      summary: null,
      zipSizeBytes: null,
    };
  } finally {
    handle.release();
  }
}
