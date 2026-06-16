/**
 * 退出前备份提示处理逻辑。
 *
 * 从 ScheduledRemoteBackupController 提取，便于独立测试。
 */

import { invoke } from '@tauri-apps/api/core';
import {
  loadConfig as loadScheduledConfig,
  loadState as loadScheduledState,
  type ScheduledBackupStateLoadResult,
  type ScheduledRemoteBackupState,
} from './ScheduledRemoteBackupConfigService';
import { loadConfig as loadWebDavConfig } from './WebDavBackupService';
import type { StorageData } from '../../store/types';

// ---------------------------------------------------------------------------
// 依赖注入接口
// ---------------------------------------------------------------------------

export interface QuitHandlerDeps {
  loadScheduledConfig: typeof loadScheduledConfig;
  loadScheduledState?: () => Promise<ScheduledBackupStateLoadResult>;
  loadWebDavConfig: typeof loadWebDavConfig;
  readDiskStorageData?: () => Promise<StorageData | null>;
  getLatestUpdateTimestamp?: (data: StorageData) => number | null;
  /** 读盘前先 flush debounce 缓冲区，确保磁盘时间戳反映最新编辑 */
  flushNow?: () => Promise<boolean>;
  invoke: typeof invoke;
  promptQuitConfirm: () => Promise<'backup-and-quit' | 'quit-now' | 'cancel'>;
  promptBackupFailed: (error: string) => Promise<'quit-anyway' | 'cancel'>;
  setBackingUp: (value: boolean) => void;
  closeDialog: () => void;
  runBeforeExit: () => Promise<void>;
}

const DEFAULT_DEPS: QuitHandlerDeps = {
  loadScheduledConfig,
  loadScheduledState,
  loadWebDavConfig,
  readDiskStorageData: async () => null,
  getLatestUpdateTimestamp: () => null,
  invoke,
  promptQuitConfirm: async () => 'cancel',
  promptBackupFailed: async () => 'quit-anyway',
  setBackingUp: () => {},
  closeDialog: () => {},
  runBeforeExit: async () => {},
};

// ---------------------------------------------------------------------------
// 条件判断
// ---------------------------------------------------------------------------

/**
 * 返回最近一次成功远端备份的时间戳。
 *
 * 同时考虑自动备份与手动备份的完成时间，取两者中较新的一个。
 * 如果两者均为 null，则返回 null。
 */
export function getLatestBackupSuccessAt(
  state: Pick<ScheduledRemoteBackupState, 'lastAutomaticSuccessAt' | 'lastManualSuccessAt'>,
): number | null {
  const { lastAutomaticSuccessAt, lastManualSuccessAt } = state;
  if (lastAutomaticSuccessAt === null && lastManualSuccessAt === null) return null;
  if (lastAutomaticSuccessAt === null) return lastManualSuccessAt;
  if (lastManualSuccessAt === null) return lastAutomaticSuccessAt;
  return lastAutomaticSuccessAt > lastManualSuccessAt
    ? lastAutomaticSuccessAt
    : lastManualSuccessAt;
}

/**
 * 判断是否需要退出前备份提示。
 *
 * 只有同时满足以下条件才提示：
 * - exitPromptEnabled === true
 * - WebDAV 已保存配置（serverUrl 非空）
 * - passwordSaved === true
 * - 本地有未备份变化：当前磁盘 storageUpdatedAt 晚于 lastSuccessfulStorageUpdatedAt
 */
export async function shouldPromptExitBackup(
  deps: Pick<QuitHandlerDeps, 'loadScheduledConfig' | 'loadWebDavConfig' | 'loadScheduledState' | 'readDiskStorageData' | 'getLatestUpdateTimestamp' | 'flushNow'> = DEFAULT_DEPS,
): Promise<boolean> {
  try {
    const loadScheduledStateFn = deps.loadScheduledState ?? loadScheduledState;
    const readDiskStorageDataFn = deps.readDiskStorageData ?? (async () => null);
    const getLatestUpdateTimestampFn = deps.getLatestUpdateTimestamp ?? (() => null);

    const [scheduledResult, webdavResult, stateResult] = await Promise.all([
      deps.loadScheduledConfig(),
      deps.loadWebDavConfig(),
      loadScheduledStateFn(),
    ]);

    if (!scheduledResult.success || !scheduledResult.config) return false;
    if (!scheduledResult.config.enabled) return false;
    if (!webdavResult.success) return false;

    const { exitPromptEnabled } = scheduledResult.config;
    const hasServerUrl = Boolean(webdavResult.serverUrl?.trim());
    const { passwordSaved } = webdavResult;

    if (!exitPromptEnabled || !hasServerUrl || !passwordSaved) return false;

    const state = stateResult.success ? stateResult.state : null;
    if (!state) return true;

    // 读盘前先 flush debounce 缓冲区，避免漏掉刚编辑但尚未持久化的数据
    const flushOk = await (deps.flushNow?.() ?? Promise.resolve());
    if (flushOk === false) return false;

    const diskData = await readDiskStorageDataFn();
    const diskTimestamp = diskData ? getLatestUpdateTimestampFn(diskData) : null;
    const hasUnsavedChanges =
      diskTimestamp !== null &&
      diskTimestamp > 0 &&
      (state.lastSuccessfulStorageUpdatedAt === null ||
        diskTimestamp > state.lastSuccessfulStorageUpdatedAt);

    if (!hasUnsavedChanges) return false;

    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 退出请求处理
// ---------------------------------------------------------------------------

/**
 * 处理 Rust 端发来的退出请求。
 *
 * 流程：
 * 1. 检查是否需要退出前备份提示
 * 2. 不需要 → 直接退出
 * 3. 需要 → 弹出三选项对话框
 *    - "先备份再退出" → 执行备份 → 退出
 *    - "直接退出" → 退出
 *    - "取消" → 不退出
 */
export async function handleQuitRequest(
  runBeforeExit: () => Promise<void>,
  deps: QuitHandlerDeps = DEFAULT_DEPS,
): Promise<void> {
  const needsBackup = await shouldPromptExitBackup(deps);

  if (!needsBackup) {
    deps.invoke('confirm_app_quit');
    return;
  }

  const choice = await deps.promptQuitConfirm();

  if (choice === 'cancel') return;

  if (choice === 'quit-now') {
    deps.invoke('confirm_app_quit');
    return;
  }

  // 'backup-and-quit': 先执行备份，完成后退出
  deps.setBackingUp(true);

  try {
    await runBeforeExit();
    deps.closeDialog();
    deps.invoke('confirm_app_quit');
  } catch (error) {
    console.warn('退出前备份失败:', error);
    deps.setBackingUp(false);
    const errorMsg = error instanceof Error ? error.message : String(error);
    const choice = await deps.promptBackupFailed(errorMsg);
    if (choice === 'quit-anyway') {
      deps.closeDialog();
      deps.invoke('confirm_app_quit');
    }
  }
}
