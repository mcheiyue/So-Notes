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
} from './ScheduledRemoteBackupConfigService';
import { loadConfig as loadWebDavConfig } from './WebDavBackupService';
import type { StorageData } from '../../store/types';

const EXIT_PROMPT_THRESHOLD_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// 依赖注入接口
// ---------------------------------------------------------------------------

export interface QuitHandlerDeps {
  loadScheduledConfig: typeof loadScheduledConfig;
  loadScheduledState?: () => Promise<ScheduledBackupStateLoadResult>;
  loadWebDavConfig: typeof loadWebDavConfig;
  readDiskStorageData?: () => Promise<StorageData | null>;
  getLatestUpdateTimestamp?: (data: StorageData) => number | null;
  clock?: () => number;
  invoke: typeof invoke;
  promptQuitConfirm: () => Promise<'backup-and-quit' | 'quit-now' | 'cancel'>;
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
  clock: () => Date.now(),
  invoke,
  promptQuitConfirm: async () => 'cancel',
  setBackingUp: () => {},
  closeDialog: () => {},
  runBeforeExit: async () => {},
};

// ---------------------------------------------------------------------------
// 条件判断
// ---------------------------------------------------------------------------

/**
 * 判断是否需要退出前备份提示。
 *
 * 只有同时满足以下条件才提示：
 * - exitPromptEnabled === true
 * - WebDAV 已保存配置（serverUrl 非空）
 * - passwordSaved === true
 * - 本地有未备份变化 OR 距上次成功超过阈值
 */
export async function shouldPromptExitBackup(
  deps: Pick<QuitHandlerDeps, 'loadScheduledConfig' | 'loadWebDavConfig' | 'loadScheduledState' | 'readDiskStorageData' | 'getLatestUpdateTimestamp' | 'clock'> = DEFAULT_DEPS,
): Promise<boolean> {
  try {
    const loadScheduledStateFn = deps.loadScheduledState ?? loadScheduledState;
    const readDiskStorageDataFn = deps.readDiskStorageData ?? (async () => null);
    const getLatestUpdateTimestampFn = deps.getLatestUpdateTimestamp ?? (() => null);
    const clockFn = deps.clock ?? (() => Date.now());

    const [scheduledResult, webdavResult, stateResult] = await Promise.all([
      deps.loadScheduledConfig(),
      deps.loadWebDavConfig(),
      loadScheduledStateFn(),
    ]);

    if (!scheduledResult.success || !scheduledResult.config) return false;
    if (!webdavResult.success) return false;

    const { exitPromptEnabled } = scheduledResult.config;
    const hasServerUrl = Boolean(webdavResult.serverUrl?.trim());
    const { passwordSaved } = webdavResult;

    if (!exitPromptEnabled || !hasServerUrl || !passwordSaved) return false;

    const state = stateResult.success ? stateResult.state : null;
    if (!state) return true;

    const diskData = await readDiskStorageDataFn();
    const diskTimestamp = diskData ? getLatestUpdateTimestampFn(diskData) : null;
    const hasUnsavedChanges =
      diskTimestamp !== null &&
      diskTimestamp > 0 &&
      (state.lastSuccessfulStorageUpdatedAt === null ||
        diskTimestamp > state.lastSuccessfulStorageUpdatedAt);

    if (hasUnsavedChanges) return true;

    const lastSuccessAt =
      state.lastAutomaticSuccessAt ?? state.lastManualSuccessAt;
    if (lastSuccessAt === null) return true;

    return clockFn() - lastSuccessAt > EXIT_PROMPT_THRESHOLD_MS;
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
  } catch (error) {
    console.warn('退出前备份失败:', error);
  }

  // 备份完成后（无论成功失败），关闭对话框并退出
  deps.closeDialog();
  deps.invoke('confirm_app_quit');
}
