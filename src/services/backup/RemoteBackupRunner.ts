/**
 * 远端备份执行器。
 *
 * 从 BoardDock 手动备份流程中提取而来，封装了
 * coordinator 获取 → flush → createRemoteBackup 的完整链路。
 * BoardDock / 定时备份 / 退出前备份均可调用此模块。
 */

import {
  tryStartBackupJob,
  type BackupJobKind,
} from './BackupJobCoordinator';
import type { WebDavConfig, WebDavUploadResult } from './WebDavBackupService';
import type { StorageData } from '../../store/types';

// ---------------------------------------------------------------------------
// 依赖注入接口
// ---------------------------------------------------------------------------

/**
 * 运行远端备份所需的外部依赖。
 *
 * 使用接口注入而非直接引用模块级单例，
 * 便于测试 mock 和未来多入口复用。
 *
 * 当前版本仅使用 flushNow 和 createRemoteBackup；
 * readDiskStorageData / getLatestUpdateTimestamp / coordinator / now
 * 预留给后续 Commit 中定时备份和退出前备份等场景扩展。
 */
export interface RemoteBackupRunnerDependencies {
  /** 将内存数据刷写到磁盘。返回 false 表示刷写失败。 */
  flushNow: () => Promise<boolean>;
  /** 调用 Rust 侧执行远端备份上传。 */
  createRemoteBackup: (config: WebDavConfig) => Promise<WebDavUploadResult>;
  /** 读取磁盘存储数据（预留给后续扩展）。 */
  readDiskStorageData: () => Promise<StorageData | null>;
  /** 获取最近更新时间戳（预留给后续扩展）。 */
  getLatestUpdateTimestamp: (data: StorageData) => number | null;
  /** 协调器模块引用（预留给后续扩展）。 */
  coordinator: unknown;
  /** 当前时间戳函数（预留给后续扩展）。 */
  now: () => number;
}

// ---------------------------------------------------------------------------
// 错误阶段常量
// ---------------------------------------------------------------------------

/**
 * 远端备份失败阶段标识，用于前端展示分类错误信息。
 */
export const RemoteBackupErrorStage = {
  Flush: 'flush',
  CoordinatorBusy: 'coordinator_busy',
  Unknown: 'unknown',
} as const;

// ---------------------------------------------------------------------------
// 运行入口
// ---------------------------------------------------------------------------

/**
 * 执行一次远端备份。
 *
 * 流程：
 * 1. 通过 BackupJobCoordinator.tryStartBackupJob 获取任务句柄。
 * 2. 调用 deps.flushNow() 将内存数据刷写到磁盘。
 * 3. 调用 deps.createRemoteBackup(config) 执行远端备份上传。
 * 4. 无论成功或异常，始终释放任务句柄。
 *
 * @param deps   外部依赖注入
 * @param config WebDAV 连接配置
 * @returns WebDavUploadResult，包含 success、remoteFileName、error 等字段
 */
export async function runRemoteBackup(
  deps: RemoteBackupRunnerDependencies,
  config: WebDavConfig,
): Promise<WebDavUploadResult> {
  const handle = tryStartBackupJob('manual-remote-backup' as BackupJobKind);
  if (!handle) {
    return {
      success: false,
      error: 'busy',
      errorStage: RemoteBackupErrorStage.CoordinatorBusy,
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
      };
    }

    // 2. 调用 Rust 侧执行远端备份上传
    const result = await deps.createRemoteBackup(config);
    return result;
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: message,
      errorStage: RemoteBackupErrorStage.Unknown,
    };
  } finally {
    handle.release();
  }
}
