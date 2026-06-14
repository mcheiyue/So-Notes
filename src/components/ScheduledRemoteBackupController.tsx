import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useDomainStore } from '../store/domainStore';
import { useViewportStore } from '../store/viewportStore';
import { useUIStore } from '../store/uiStore';
import { createScheduledRemoteBackupService } from '../services/backup/ScheduledRemoteBackupService';
import type { AppActivitySignals } from '../services/backup/ScheduledRemoteBackupService';
import { registerSchedulerService, unregisterSchedulerService } from '../services/backup/ScheduledRemoteBackupService';
import { loadConfig as loadScheduledConfig, saveConfig as saveScheduledConfig, loadState as loadScheduledState, saveState as saveScheduledState } from '../services/backup/ScheduledRemoteBackupConfigService';
import { loadConfig as loadWebDavConfig, createRemoteBackup } from '../services/backup/WebDavBackupService';
import { flushNow } from '../services/storage/PersistenceFacade';
import { readDiskStorageData, getLatestUpdateTimestamp } from '../services/storage/tauriPersistence';
import { tryStartBackupJob } from '../services/backup/BackupJobCoordinator';
import { handleQuitRequest } from '../services/backup/quitHandler';
import { useQuitConfirmStore } from '../store/quitConfirmStore';
import { promptQuitConfirm } from '../store/quitConfirmStore';

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

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      const service = createScheduledRemoteBackupService({
        clock: () => Date.now(),
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (id) => window.clearTimeout(id),
        getAppActivity,
        runnerDeps: {
          flushNow,
          createRemoteBackup,
          readDiskStorageData: () => readDiskStorageData(STORAGE_FILENAME),
          getLatestUpdateTimestamp,
          coordinator: { tryStartBackupJob },
          now: () => Date.now(),
        },
        loadWebDavConfig,
        loadScheduledConfig,
        saveScheduledConfig,
        loadScheduledState,
        saveScheduledState,
        readDiskStorageData: () => readDiskStorageData(STORAGE_FILENAME),
        getLatestUpdateTimestamp,
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
    const unlisten = listen('remote-backup-before-quit-requested', async () => {
      const runBeforeExit = async () => {
        await serviceRef.current?.runBeforeExit();
      };

      await handleQuitRequest(runBeforeExit, {
        loadScheduledConfig,
        loadWebDavConfig,
        invoke,
        promptQuitConfirm,
        setBackingUp: (value) => useQuitConfirmStore.getState().setBackingUp(value),
        closeDialog: () => useQuitConfirmStore.getState().close(),
        runBeforeExit,
      });
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  return null;
};
