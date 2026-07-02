import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useDomainStore } from '../store/domainStore';
import { useViewportStore } from '../store/viewportStore';
import { useUIStore } from '../store/uiStore';
import { createScheduledRemoteBackupService, FREQUENCY_MS, CREDENTIAL_FAILURE_THRESHOLD } from '../services/backup/ScheduledRemoteBackupService';
import type { AppActivitySignals } from '../services/backup/ScheduledRemoteBackupService';
import { registerSchedulerService, unregisterSchedulerService } from '../services/backup/ScheduledRemoteBackupService';
import { loadConfig as loadScheduledConfig, saveConfig as saveScheduledConfig, loadState as loadScheduledState, saveState as saveScheduledState, DEFAULT_SCHEDULED_BACKUP_STATE } from '../services/backup/ScheduledRemoteBackupConfigService';
import { loadConfig as loadWebDavConfig, createRemoteBackup } from '../services/backup/WebDavBackupService';
import { runRemoteBackup } from '../services/backup/RemoteBackupRunner';
import { flushNow } from '../services/storage/PersistenceFacade';
import { readDiskStorageData, getLatestUpdateTimestamp } from '../services/storage/tauriPersistence';
import { tryStartBackupJob } from '../services/backup/BackupJobCoordinator';
import { handleQuitRequest } from '../services/backup/quitHandler';
import { useQuitConfirmStore } from '../store/quitConfirmStore';
import { promptQuitConfirm, promptBackupFailed } from '../store/quitConfirmStore';
import { appendBackupActivity } from '../services/backup/BackupActivityLogService';

const STORAGE_FILENAME = 'data.json';

const isTextEditing = (): boolean => {
  const el = document.activeElement;
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true;
  return el.getAttribute('contenteditable') === 'true';
};

const getAppActivity = (): AppActivitySignals => {
  const vpState = useViewportStore.getState();
  const uiState = useUIStore.getState();

  return {
    isDragging: vpState.interaction.isDragging,
    isPanMode: vpState.interaction.isPanMode,
    edgePush: vpState.interaction.edgePush.top
      || vpState.interaction.edgePush.bottom
      || vpState.interaction.edgePush.left
      || vpState.interaction.edgePush.right,
    stickyDrag: vpState.stickyDrag.id !== null,
    hasSelection: uiState.selectedIds.length > 0,
    isTextEditing: isTextEditing(),
  };
};

export const ScheduledRemoteBackupController = () => {
  const serviceRef = useRef<ReturnType<typeof createScheduledRemoteBackupService> | null>(null);

  const runnerDepsRef = useRef({
    flushNow,
    createRemoteBackup,
    readDiskStorageData: () => readDiskStorageData(STORAGE_FILENAME),
    getLatestUpdateTimestamp,
    coordinator: { tryStartBackupJob },
    now: () => Date.now(),
  });

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      const service = createScheduledRemoteBackupService({
        clock: () => Date.now(),
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (id) => window.clearTimeout(id),
        getAppActivity,
        runnerDeps: runnerDepsRef.current,
        loadWebDavConfig,
        loadScheduledConfig,
        saveScheduledConfig,
        loadScheduledState,
        saveScheduledState,
        readDiskStorageData: () => readDiskStorageData(STORAGE_FILENAME),
        getLatestUpdateTimestamp,
        appendActivity: appendBackupActivity,
      });

      if (cancelled) return;

      serviceRef.current = service;
      registerSchedulerService(service);
      await service.initialize();

      if (cancelled) {
        service.stop();
        unregisterSchedulerService();
        serviceRef.current = null;
        return;
      }
    };

    bootstrap().catch((error: unknown) => {
      console.warn('初始化定时远端备份调度失败:', error);
      serviceRef.current?.stop();
      unregisterSchedulerService();
      serviceRef.current = null;
    });

    const unsubscribe = useDomainStore.subscribe(() => {
      serviceRef.current?.notifyLocalChange();
    });

    return () => {
      cancelled = true;
      unsubscribe();
      serviceRef.current?.stop();
      unregisterSchedulerService();
      serviceRef.current = null;
    };
  }, []);

  // 退出前备份提示监听
  useEffect(() => {
    let active = true;

    const unlisten = listen('remote-backup-before-quit-requested', async () => {
      if (!active) return;
      const runBeforeExit = async () => {
        const service = serviceRef.current;
        if (!service) {
          const config = await loadWebDavConfig();
          if (!config.success || !config.passwordSaved || !config.serverUrl || !config.username) {
            throw new Error('退出前备份服务尚未就绪，请稍后重试');
          }
          const webdavConfig = { serverUrl: config.serverUrl, username: config.username, remoteDir: config.remoteDir ?? undefined };
          const result = await runRemoteBackup(runnerDepsRef.current, webdavConfig, { jobKind: 'before-exit-remote-backup' });
          const now = Date.now();
          const stateResult = await loadScheduledState();
          const prev = stateResult.success && stateResult.state ? stateResult.state : DEFAULT_SCHEDULED_BACKUP_STATE;
          const schedConfigResult = await loadScheduledConfig();
          const frequencyMs = schedConfigResult.success && schedConfigResult.config
            ? FREQUENCY_MS[schedConfigResult.config.frequency]
            : FREQUENCY_MS['daily'];
          await saveScheduledState({
            ...prev,
            lastStartedAt: now,
            lastFinishedAt: now,
            lastTrigger: 'before-exit',
            nextRunAt: now + frequencyMs,
            ...(result.success
              ? {
                  lastAutomaticSuccessAt: now,
                  lastRemoteFileName: result.remoteFileName ?? null,
                  lastFailureReason: null,
                  lastFailureAt: null,
                  lastFailureStage: null,
                  consecutiveCredentialFailures: 0,
                  credentialActionRequired: false,
                }
              : {
                  lastFailureAt: now,
                  lastFailureReason: result.error ?? '退出前备份失败',
                  lastFailureStage: result.errorStage ?? null,
                  ...(result.errorStage === 'credential'
                    ? {
                        consecutiveCredentialFailures: prev.consecutiveCredentialFailures + 1,
                        credentialActionRequired: prev.consecutiveCredentialFailures + 1 >= CREDENTIAL_FAILURE_THRESHOLD,
                      }
                    : {}),
                }),
          });
          try {
            await appendBackupActivity({
              operation: 'scheduled-remote-backup',
              status: result.success ? 'success' : 'failed',
              level: result.success ? 'info' : 'error',
              startedAt: now,
              finishedAt: now,
              trigger: 'before-exit',
              stage: result.success ? null : (result.errorStage ?? 'unknown'),
              errorCode: result.errorCode ?? null,
              remoteFileName: result.remoteFileName ?? null,
              message: result.success ? null : (result.error ?? '退出前备份失败'),
              summary: {
                ...(result.summary ?? {}),
                ...(result.zipSizeBytes != null ? { zipSizeBytes: result.zipSizeBytes } : {}),
              },
            });
          } catch { /* 活动日志写入失败不影响主流程 */ }
          if (!result.success) {
            throw new Error(result.error ?? '退出前备份失败');
          }
          return;
        }
        await service.runBeforeExit();
      };

      await handleQuitRequest(runBeforeExit, {
        loadScheduledConfig,
        loadWebDavConfig,
        flushNow: flushNow,
        readDiskStorageData: () => readDiskStorageData(STORAGE_FILENAME),
        getLatestUpdateTimestamp,
        invoke,
        promptQuitConfirm,
        promptBackupFailed,
        setBackingUp: (value) => useQuitConfirmStore.getState().setBackingUp(value),
        closeDialog: () => useQuitConfirmStore.getState().close(),
        runBeforeExit,
      });
    });

    return () => {
      active = false;
      unlisten.then((f) => f());
    };
  }, []);

  return null;
};
