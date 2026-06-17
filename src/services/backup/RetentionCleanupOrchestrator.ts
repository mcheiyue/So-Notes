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

  if (config.retentionCount === null || config.retentionCount <= 0) {
    return {};
  }

  // -----------------------------------------------------------------------
  // 2. 检查健康基线
  // -----------------------------------------------------------------------
  const latestSummary = uploadResult.summary;

  if (state.baselineConfirmedRemoteCount === null) {
    // 无基线：如果有本次备份摘要，初始化基线并跳过清理
    if (latestSummary !== null) {
      return {
        baselineConfirmedRemoteCount: latestSummary.noteCount,
      };
    }
    // 无摘要且无基线，无法建立基线，跳过
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
      boardCount: 0,
      textNoteCount: 0,
      imageNoteCount: 0,
      trashNoteCount: 0,
      imageFileCount: 0,
      imageFileTotalBytes: 0,
    };

    const cliffDrop = detectBackupCliffDrop({
      latestSummary,
      baselineSummary,
    });

    if (cliffDrop !== null) {
      // 检测到断崖式骤降：保存警告，跳过清理
      return {
        cliffDropDetectedAt: clock(),
        cliffDropDeferred: true,
      };
    }
  }

  // -----------------------------------------------------------------------
  // 4. 执行清理
  // -----------------------------------------------------------------------
  try {
    const cleanupResult = await executeRetentionCleanup({
      config: webdavConfig,
      retentionCount: config.retentionCount,
      protectedFileNames: new Set(),
    });

    // 返回清理结果到 state（清理失败不改变备份成功状态，仅记录信息）
    return {
      pendingCleanupTargetCount: cleanupResult.retainedCount,
    };
  } catch {
    // 清理异常：不改变备份成功状态，仅返回空 patch
    return {};
  }
}
