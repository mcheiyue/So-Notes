// ---------------------------------------------------------------------------
// 远端备份保留策略执行服务
//
// 职责：基于保留策略预览和执行远端备份文件的清理删除。
// 约束：顺序删除旧备份，不并发 delete；接入 BackupJobCoordinator single-flight 保护。
// ---------------------------------------------------------------------------

import type { WebDavConfig } from './WebDavBackupService';
import {
  listBackups,
  deleteBackup,
} from './WebDavBackupService';
import {
  proposeRetentionCleanup,
  type RetentionPreview,
} from './RemoteBackupRetention';
import {
  tryStartBackupJob,
} from './BackupJobCoordinator';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface RemoteBackupRetentionPolicy {
  readonly retentionEnabled: boolean;
  readonly retentionCount: number | null;
}

export interface RemoteRetentionCleanupResult {
  readonly success: boolean;
  readonly policy: RemoteBackupRetentionPolicy;
  readonly attemptedCount: number;
  readonly deletedCount: number;
  readonly missingCount: number;
  readonly retainedCount: number;
  readonly stoppedAtFileName: string | null;
  readonly failedFileName: string | null;
  readonly error: string | null;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 判断删除结果中的错误是否为幂等成功（文件不存在）。
 *
 * 404 / "not found" / 400 / "Not Found" 视为幂等成功，不中断流程。
 */
function isIdempotentSuccessError(error: string): boolean {
  const lower = error.toLowerCase();
  return (
    lower.includes('404') ||
    lower.includes('not found') ||
    lower.includes('400') ||
    lower.includes('not found')
  );
}

/**
 * 判断删除结果中的错误是否为致命错误（应停止后续删除）。
 *
 * 401 / 403 / 423 / 5xx / 网络错误 / 超时 / 连接错误 应停止后续删除。
 */
function isFatalError(error: string): boolean {
  const lower = error.toLowerCase();
  return (
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('423') ||
    lower.includes('5') ||
    lower.includes('network') ||
    lower.includes('timeout') ||
    lower.includes('connection')
  );
}

// ---------------------------------------------------------------------------
// previewRetentionCleanup
// ---------------------------------------------------------------------------

/**
 * 预览保留策略清理方案。
 *
 * 调用 `WebDavBackupService.listBackups` 获取远端文件列表，
 * 再调用 `proposeRetentionCleanup` 计算候选删除列表。
 *
 * @returns `RetentionPreview`（复用 RemoteBackupRetention.ts 的类型）
 */
export async function previewRetentionCleanup(input: {
  readonly config: WebDavConfig;
  readonly retentionCount: number;
  readonly protectedFileNames: ReadonlySet<string>;
}): Promise<RetentionPreview> {
  const { config, retentionCount, protectedFileNames } = input;

  const files = await listBackups(config);

  return proposeRetentionCleanup({
    files,
    retentionCount,
    protectedFileNames,
  });
}

// ---------------------------------------------------------------------------
// executeRetentionCleanup
// ---------------------------------------------------------------------------

/**
 * 执行远端备份保留策略清理。
 *
 * 1. 获取 single-flight 锁（BackupJobCoordinator）
 * 2. 预览清理方案
 * 3. 顺序删除候选文件
 * 4. 根据删除结果返回部分成功结果
 *
 * 错误处理策略：
 * - `success: true` → deletedCount++
 * - error 包含 "404"/"not found"/"400"/"Not Found" → missingCount++（幂等成功）
 * - error 包含 "401"/"403"/"423"/"5xx"/网络错误 → 停止，记录 failedFileName
 * - 其他错误 → 停止，记录 failedFileName
 */
export async function executeRetentionCleanup(input: {
  readonly config: WebDavConfig;
  readonly retentionCount: number;
  readonly protectedFileNames: ReadonlySet<string>;
}): Promise<RemoteRetentionCleanupResult> {
  const { config, retentionCount, protectedFileNames } = input;

  const policy: RemoteBackupRetentionPolicy = {
    retentionEnabled: true,
    retentionCount,
  };

  // 获取 single-flight 锁
  const handle = tryStartBackupJob('remote-retention-cleanup');
  if (!handle) {
    return {
      success: false,
      policy,
      attemptedCount: 0,
      deletedCount: 0,
      missingCount: 0,
      retainedCount: 0,
      stoppedAtFileName: null,
      failedFileName: null,
      error: 'busy',
    };
  }

  try {
    // 预览清理方案
    const preview = await previewRetentionCleanup({
      config,
      retentionCount,
      protectedFileNames,
    });

    const candidates = preview.candidates;
    const retainedCount = preview.keep.length;

    // 顺序删除候选文件
    let deletedCount = 0;
    let missingCount = 0;
    let stoppedAtFileName: string | null = null;
    let failedFileName: string | null = null;
    let fatalErrorMessage: string | null = null;

    for (const candidate of candidates) {
      const result = await deleteBackup(config, candidate.fileName);

      if (result.success) {
        deletedCount++;
      } else if (result.error) {
        const errorStr = result.error;

        if (isIdempotentSuccessError(errorStr)) {
          missingCount++;
        } else if (isFatalError(errorStr)) {
          stoppedAtFileName = candidate.fileName;
          failedFileName = candidate.fileName;
          fatalErrorMessage = errorStr;
          break;
        } else {
          // 其他错误也停止
          stoppedAtFileName = candidate.fileName;
          failedFileName = candidate.fileName;
          fatalErrorMessage = errorStr;
          break;
        }
      } else {
        // 无 error 字段但 success: false 的异常情况
        stoppedAtFileName = candidate.fileName;
        failedFileName = candidate.fileName;
        fatalErrorMessage = 'unknown error';
        break;
      }
    }

    const attemptedCount = deletedCount + missingCount +
      (failedFileName !== null ? 1 : 0);

    return {
      success: failedFileName === null,
      policy,
      attemptedCount,
      deletedCount,
      missingCount,
      retainedCount,
      stoppedAtFileName,
      failedFileName,
      error: fatalErrorMessage,
    };
  } finally {
    handle.release();
  }
}
