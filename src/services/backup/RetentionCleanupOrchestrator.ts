/**
 * 自动备份成功后的保留策略编排模块。
 *
 * 职责：在自动备份成功后，根据保留策略配置判断是否需要执行清理，
 * 并处理健康基线初始化、断崖式骤降检测和清理执行。
 *
 * 约束：
 * - 仅在自动备份（scheduled-interval / quiet-period）成功后触发。
 * - 不直接修改 state 或调用保存方法，仅返回 state patch 由调用方合并。
 * - 清理失败不影响备份成功状态。
 */

import type {
  ScheduledRemoteBackupConfig,
  ScheduledRemoteBackupState,
  RemoteBackupTrigger,
} from './ScheduledRemoteBackupConfigService';
import type { WebDavUploadResult, WebDavConfig } from './WebDavBackupService';
import type { BackupSummary } from './BackupService';
import { detectBackupCliffDrop } from './RemoteBackupRetention';
import { executeRetentionCleanup } from './RemoteBackupRetentionService';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface PostBackupRetentionCleanupInput {
  /** 当前备份触发器类型 */
  readonly trigger: RemoteBackupTrigger;
  /** 定时备份配置（含保留策略设置） */
  readonly config: ScheduledRemoteBackupConfig;
  /** 当前定时备份状态 */
  readonly state: ScheduledRemoteBackupState;
  /** 本次备份上传结果 */
  readonly uploadResult: WebDavUploadResult;
  /** WebDAV 连接配置 */
  readonly webdavConfig: WebDavConfig;
  /** 获取当前时间戳 */
  readonly clock: () => number;
}

// ---------------------------------------------------------------------------
// 自动触发器集合
// ---------------------------------------------------------------------------

const AUTOMATIC_TRIGGERS: ReadonlySet<RemoteBackupTrigger> = new Set([
  'scheduled-interval',
  'quiet-period',
]);

// ---------------------------------------------------------------------------
// orchestratePostBackupRetentionCleanup
// ---------------------------------------------------------------------------

/**
 * 自动备份成功后的保留策略编排。
 *
 * 流程：
 * 1. 检查是否应触发自动清理（仅自动备份 + 保留策略已启用）。
 * 2. 检查健康基线：无基线时初始化并跳过清理。
 * 3. 断崖检测：检测到异常时保存警告并跳过清理。
 * 4. 执行清理：删除超出保留数的旧备份。
 *
 * @returns state patch，由调用方 merge 到 state 中。清理失败不影响备份成功状态。
 */
export async function orchestratePostBackupRetentionCleanup(
  input: PostBackupRetentionCleanupInput,
): Promise<Partial<ScheduledRemoteBackupState>> {
  const { trigger, config, state, uploadResult, webdavConfig, clock } = input;

  // -----------------------------------------------------------------------
  // 1. 检查是否应触发自动清理
  // -----------------------------------------------------------------------
  if (!AUTOMATIC_TRIGGERS.has(trigger)) {
    return {};
  }

  if (!config.retentionEnabled) {
    return {};
  }

  // retentionCount=null 对应 Rust None=无限保留，跳过自动清理
  if (config.retentionCount === null) {
    return {};
  }
  const retentionCount = config.retentionCount;
  if (retentionCount <= 0) {
    return {};
  }

  // -----------------------------------------------------------------------
  // 2. 检查健康基线
  // -----------------------------------------------------------------------
  const latestSummary = uploadResult.summary;

  if (state.baselineConfirmedRemoteCount === null) {
    if (latestSummary !== null) {
      return {
        baselineConfirmedRemoteCount: latestSummary.noteCount,
        baselineConfirmedBoardCount: latestSummary.boardCount,
        baselineConfirmedImageNoteCount: latestSummary.imageNoteCount,
        baselineConfirmedImageFileCount: latestSummary.imageFileCount,
        baselineConfirmedImageFileTotalBytes: latestSummary.imageFileTotalBytes,
        baselineConfirmedRemoteFileName: uploadResult.remoteFileName ?? null,
        baselineConfirmedConfirmedAt: clock(),
        baselineConfirmedZipSizeBytes: uploadResult.zipSizeBytes ?? null,
        lastRetentionCleanupError: 'skipped_no_baseline',
        lastRetentionCleanupAt: clock(),
      };
    }
    return {
      lastRetentionCleanupError: 'skipped_no_baseline',
      lastRetentionCleanupAt: clock(),
    };
  }

  // -----------------------------------------------------------------------
  // 2.5 检查是否已有断崖延迟标记
  // -----------------------------------------------------------------------
  if (state.cliffDropDeferred) {
    // 已有断崖延迟标记，跳过本次清理
    return {};
  }

  // -----------------------------------------------------------------------
  // 3. 断崖检测
  // -----------------------------------------------------------------------
  if (latestSummary !== null) {
    const baselineSummary: BackupSummary = {
      noteCount: state.baselineConfirmedRemoteCount,
      app: 'SoNotes',
      formatVersion: 1,
      appVersion: '0.0.0',
      createdAt: 0,
      boardCount: state.baselineConfirmedBoardCount ?? 0,
      textNoteCount: 0,
      imageNoteCount: state.baselineConfirmedImageNoteCount ?? 0,
      trashNoteCount: 0,
      imageFileCount: state.baselineConfirmedImageFileCount ?? 0,
      imageFileTotalBytes: state.baselineConfirmedImageFileTotalBytes ?? 0,
    };

    const cliffDrop = detectBackupCliffDrop({
      latestSummary,
      baselineSummary,
      latestZipSizeBytes: uploadResult.zipSizeBytes ?? null,
      baselineZipSizeBytes: state.baselineConfirmedZipSizeBytes ?? null,
    });

    if (cliffDrop !== null) {
      // 检测到断崖式骤降：保存警告和最新摘要快照，跳过清理
      return {
        cliffDropDetectedAt: clock(),
        cliffDropDeferred: true,
        cliffDropLatestSummaryNoteCount: latestSummary.noteCount,
        cliffDropLatestSummaryBoardCount: latestSummary.boardCount,
        cliffDropLatestSummaryImageNoteCount: latestSummary.imageNoteCount,
        cliffDropLatestSummaryImageFileCount: latestSummary.imageFileCount,
        cliffDropLatestSummaryImageFileTotalBytes: latestSummary.imageFileTotalBytes,
        cliffDropLatestRemoteFileName: uploadResult.remoteFileName ?? null,
        cliffDropLatestZipSizeBytes: uploadResult.zipSizeBytes ?? null,
      };
    }
  }

  // -----------------------------------------------------------------------
  // 4. 执行清理
  // -----------------------------------------------------------------------

  // 无摘要时无法验证健康状态，跳过清理和基线更新（plan 3.8）
  if (latestSummary === null) {
    return {};
  }

  // 断崖检测通过，更新基线为当前健康备份（plan 3.7：先更新基线再清理）
  const baselineUpdate: Partial<ScheduledRemoteBackupState> = {
    baselineConfirmedRemoteCount: latestSummary.noteCount,
    baselineConfirmedBoardCount: latestSummary.boardCount,
    baselineConfirmedImageNoteCount: latestSummary.imageNoteCount,
    baselineConfirmedImageFileCount: latestSummary.imageFileCount,
    baselineConfirmedImageFileTotalBytes: latestSummary.imageFileTotalBytes,
    baselineConfirmedRemoteFileName: uploadResult.remoteFileName ?? null,
    baselineConfirmedConfirmedAt: clock(),
    baselineConfirmedZipSizeBytes: uploadResult.zipSizeBytes ?? null,
  };

  try {
    const cleanupResult = await executeRetentionCleanup({
      config: webdavConfig,
      retentionCount,
      protectedFileNames: (() => {
        const names = new Set<string>();
        if (uploadResult.remoteFileName) names.add(uploadResult.remoteFileName);
        if (state.baselineConfirmedRemoteFileName) names.add(state.baselineConfirmedRemoteFileName);
        if (state.cliffDropLatestRemoteFileName) names.add(state.cliffDropLatestRemoteFileName);
        return names;
      })(),
    });

    // 返回清理结果到 state（清理失败不改变备份成功状态，仅记录信息）
    return {
      ...baselineUpdate,
      pendingCleanupTargetCount: cleanupResult.retainedCount,
      lastRetentionCleanupDeletedCount: cleanupResult.deletedCount,
      lastRetentionCleanupFailedFileName: cleanupResult.failedFileName,
      lastRetentionCleanupError: cleanupResult.error,
      lastRetentionCleanupAt: clock(),
    };
  } catch (error) {
    // 清理异常：仍返回基线更新（plan 3.7：健康基线确认不应被清理失败回滚），
    // 同时记录 retention 失败状态（plan 4.5）
    return {
      ...baselineUpdate,
      lastRetentionCleanupError: error instanceof Error ? error.message : String(error),
      lastRetentionCleanupAt: clock(),
    };
  }
}
