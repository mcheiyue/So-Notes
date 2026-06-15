import React, { useState, useRef, useEffect } from "react";
import { confirm } from "../store/confirmStore";
import { useStore } from "../store/useStore";
import { cn } from "../utils/cn";
import { Plus, Trash2, Settings, Download, Upload, Share, ChevronRight, ChevronLeft, Moon, Sun, Monitor, Database, Check, Activity, Search, Archive, RotateCcw, Cloud, Wifi, RefreshCw, Save, Clock } from "lucide-react";
import { Z_INDEX } from "../constants/layout";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { appController } from "../controllers/appController";
import { listAttachmentFiles, deleteAttachmentFile, attachmentExists, invalidateAttachmentPathCache, resolveAttachmentAssetUrlCached } from "../services/storage/attachmentPersistence";
import { detectMissingReferences, detectOrphanAttachments } from "../services/storage/attachmentConsistency";
import { saveZipDialog, openZipDialog } from "../utils/fileSystem";
import { createLocalBackup, restoreLocalBackup, validateLocalBackup } from "../services/backup/BackupService";
import * as WebDavBackupService from "../services/backup/WebDavBackupService";
import { runRemoteBackup } from "../services/backup/RemoteBackupRunner";
import { tryStartBackupJob, type BackupJobHandle } from "../services/backup/BackupJobCoordinator";
import * as ScheduledRemoteBackupConfigService from "../services/backup/ScheduledRemoteBackupConfigService";
import type { ScheduledRemoteBackupConfig, ScheduledRemoteBackupState, ScheduledRemoteBackupFrequency, RemoteBackupStage } from "../services/backup/ScheduledRemoteBackupConfigService";
import { getSchedulerService, isRemoteBackupStage } from "../services/backup/ScheduledRemoteBackupService";
import { getLatestBackupSuccessAt } from "../services/backup/quitHandler";
import * as persistenceFacade from "../services/storage/PersistenceFacade";
import { readDiskStorageData, getLatestUpdateTimestamp } from "../services/storage/tauriPersistence";
import { normalizeNotes, createLayoutNotesById, sanitizeNoteAttachments } from "../store/normalization";
import { db } from "../store/db";
import type { Note } from "../store/types";

const BOARD_ICONS = ["📝", "🚀", "💡", "🎨", "📅", "✅", "🔥", "✨", "📚", "🧘"];
type StoreState = ReturnType<typeof useStore.getState>;
type ImportFeedback = Awaited<ReturnType<StoreState['importFromFile']>>;

const formatImportSummary = (summary: NonNullable<ImportFeedback['summary']>) => {
  const parts = [
    `导入 ${summary.importedBoardsCount} 个看板`,
    `${summary.importedNotesCount} 条便签`,
  ];

  if (summary.skippedNotesCount > 0) {
    parts.push(`跳过 ${summary.skippedNotesCount} 条异常便签`);
  }

  return parts.join(' · ');
};

const formatImportHighlights = (summary: NonNullable<ImportFeedback['summary']>) => {
  const highlights: string[] = [];

  if (summary.createdDefaultBoard) {
    highlights.push('已自动补建默认看板。');
  }

  if (summary.migratedNotesCount > 0) {
    highlights.push(`已兼容迁移 ${summary.migratedNotesCount} 条旧版便签。`);
  }

  if (summary.renamedBoardsCount > 0) {
    highlights.push(`有 ${summary.renamedBoardsCount} 个同名看板已按规则重命名。`);
  }

  if (summary.usedFallbackCurrentBoard) {
    highlights.push('导入主板无效，已回退到首个可用看板。');
  }

  return highlights;
};

const formatUnknownError = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return '未知错误';
};

const VALIDATION_ERROR_FALLBACK = '备份包校验未通过，本地数据未受影响。';

const formatValidationErrorMessage = (
  errors: ReadonlyArray<{ readonly message: string }>,
): string => {
  if (errors.length === 0) {
    return `备份验证失败：${VALIDATION_ERROR_FALLBACK}`;
  }

  if (errors.length === 1) {
    const errorMessage = errors[0].message || VALIDATION_ERROR_FALLBACK;
    return `备份验证失败：${errorMessage}`;
  }

  const details = errors
    .map((err, index) => `${index + 1}. ${err.message || VALIDATION_ERROR_FALLBACK}`)
    .join('\n');
  return `备份验证失败（${errors.length} 条错误）：\n${details}`;
};

const CREDENTIAL_ERROR_REPLACEMENT = '请在设置中输入密码，或确认系统凭据管理器中的密码可用。';

const formatWebdavError = (message: string): string => {
  if (message.includes('凭据') || message.includes('密码')) {
    return CREDENTIAL_ERROR_REPLACEMENT;
  }
  if (message === 'Flush failed') {
    return '当前数据尚未成功写入磁盘';
  }
  return message;
};

const formatWebDavLastModified = (value?: string | null): string => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number) => part.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const prehydrateRestoredImageNoteAssetUrls = async (notes: Note[]): Promise<void> => {
  const imageRelativePaths = notes
    .filter((note) => note.kind === 'image')
    .flatMap((note) => note.attachments ?? [])
    .map((attachment) => attachment.relativePath);

  if (imageRelativePaths.length === 0) return;

  await Promise.allSettled(
    Array.from(new Set(imageRelativePaths)).map((relativePath) =>
      resolveAttachmentAssetUrlCached(relativePath),
    ),
  );
};

export const BoardDock = () => {
  const store = useStore();
  const { 
    boards, boardNoteIds, notesById, currentBoardId, 
    createBoard, deleteBoard, updateBoard, reorderBoard,
    isDockVisible, setDockVisible, 
    viewMode,
    exportAll, importFromFile,
    config, setThemeMode,
    saveStatus, isSaving, saveError, lastSavedAt
  } = store;
  const [isInputMode, setIsInputMode] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsView, setSettingsView] = useState<'MAIN' | 'DATA' | 'THEME' | 'DIAGNOSTICS' | 'WEBDAV'>('MAIN');
  const [newBoardName, setNewBoardName] = useState("");
  const [contextMenuBoard, setContextMenuBoard] = useState<{ id: string; name: string; x: number; y: number } | null>(null);
  
  // Delete Confirmation State
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; count: number } | null>(null);
  const [editingBoardId, setEditingBoardId] = useState<string | null>(null);
  const [reorderId, setReorderId] = useState<string | null>(null);
  const [importFeedback, setImportFeedback] = useState<ImportFeedback | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [zipOperation, setZipOperation] = useState<'idle' | 'backing-up' | 'restoring'>('idle');
  const [zipFeedback, setZipFeedback] = useState<{ status: 'success' | 'error'; message: string } | null>(null);
  const [attachmentScanState, setAttachmentScanState] = useState<{
    status: 'idle' | 'scanning' | 'done' | 'error';
    missingCount: number;
    orphanCount: number;
    orphanPaths: string[];
    errorMessage: string | null;
  }>({ status: 'idle', missingCount: 0, orphanCount: 0, orphanPaths: [], errorMessage: null });

  // WebDAV state
  const [webdavDraft, setWebdavDraft] = useState({
    serverUrl: '',
    username: '',
    password: '',
    remoteDir: 'SoNotes_Backups/',
    rememberPassword: false,
  });
  const [webdavOperation, setWebdavOperation] = useState<'idle' | 'testing' | 'saving' | 'listing' | 'creating' | 'restoring' | 'deleting'>('idle');
  const [webdavFeedback, setWebdavFeedback] = useState<{ status: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [webdavBackups, setWebdavBackups] = useState<WebDavBackupService.WebDavRemoteBackup[]>([]);
  const [webdavPasswordSaved, setWebdavPasswordSaved] = useState(false);

  // Scheduled remote backup state
  const [scheduledConfig, setScheduledConfig] = useState<ScheduledRemoteBackupConfig>(
    ScheduledRemoteBackupConfigService.DEFAULT_SCHEDULED_BACKUP_CONFIG,
  );
  const [scheduledState, setScheduledState] = useState<ScheduledRemoteBackupState>(
    ScheduledRemoteBackupConfigService.DEFAULT_SCHEDULED_BACKUP_STATE,
  );
  const [scheduledLoading, setScheduledLoading] = useState(false);
  const [exitHintVisible, setExitHintVisible] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const dockContainerRef = useRef<HTMLDivElement>(null);

  // Focus input when adding mode starts
  useEffect(() => {
    if (isInputMode && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isInputMode]);

  // Focus rename input
  useEffect(() => {
    if (editingBoardId && editInputRef.current) {
        editInputRef.current.focus();
        editInputRef.current.select();
    }
  }, [editingBoardId]);

  // Reorder Keyboard Logic
  useEffect(() => {
    if (!reorderId) return;

    const handleReorderKey = (e: KeyboardEvent) => {
        e.preventDefault();
        e.stopPropagation();

        if (e.key === 'ArrowLeft') {
            reorderBoard(reorderId, 'left');
        } else if (e.key === 'ArrowRight') {
            reorderBoard(reorderId, 'right');
        } else if (e.key === 'Enter' || e.key === 'Escape') {
            setReorderId(null);
        }
    };

    window.addEventListener('keydown', handleReorderKey);
    return () => window.removeEventListener('keydown', handleReorderKey);
  }, [reorderId, reorderBoard]);

  // Reset state when dock closes
  useEffect(() => {
    if (!isDockVisible) {
      setIsInputMode(false);
      setNewBoardName("");
      setContextMenuBoard(null);
      setEditingBoardId(null);
      setDeleteConfirm(null);
      setReorderId(null);
      setShowSettings(false);
      setSettingsView('MAIN');
    }
  }, [isDockVisible]);

  // Reset settings view when closed
  useEffect(() => {
      if (!showSettings) {
          setImportFeedback(null);
          setZipFeedback(null);
          setZipOperation('idle');
          setSettingsView('MAIN');
          setAttachmentScanState({ status: 'idle', missingCount: 0, orphanCount: 0, orphanPaths: [], errorMessage: null });
          setWebdavDraft({ serverUrl: '', username: '', password: '', remoteDir: 'SoNotes_Backups/', rememberPassword: false });
          setWebdavOperation('idle');
          setWebdavFeedback(null);
          setWebdavBackups([]);
          setWebdavPasswordSaved(false);
      }
  }, [showSettings]);

  useEffect(() => {
    if (settingsView !== 'WEBDAV') return;
    let cancelled = false;
    (async () => {
      try {
        const result = await WebDavBackupService.loadConfig();
        if (cancelled) return;
        if (result.success) {
          setWebdavDraft(prev => ({
            ...prev,
            serverUrl: result.serverUrl ?? '',
            username: result.username ?? '',
            remoteDir: result.remoteDir ?? 'SoNotes_Backups/',
            password: '',
          }));
          setWebdavPasswordSaved(result.passwordSaved);
        }
      } catch (err) {
        if (!cancelled) {
          setWebdavFeedback({ status: 'error', message: `加载配置失败：${formatUnknownError(err)}` });
        }
      }

      setScheduledLoading(true);
      try {
        const [configResult, stateResult] = await Promise.all([
          ScheduledRemoteBackupConfigService.loadConfig(),
          ScheduledRemoteBackupConfigService.loadState(),
        ]);
        if (cancelled) return;
        if (configResult.success && configResult.config) {
          setScheduledConfig(configResult.config);
        }
        if (stateResult.success && stateResult.state) {
          setScheduledState(stateResult.state);
        }
        const loadError = !configResult.success
          ? configResult.error
          : !stateResult.success
            ? stateResult.error
            : null;
        if (loadError) {
          setWebdavFeedback({ status: 'error', message: `加载自动远端备份设置失败：${loadError}` });
        }
      } catch (err) {
        if (!cancelled) {
          console.warn('加载自动远端备份设置失败:', err);
          setWebdavFeedback({ status: 'error', message: `加载自动远端备份设置失败：${formatUnknownError(err)}` });
        }
      } finally {
        if (!cancelled) setScheduledLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [settingsView]);

  useEffect(() => {
    if (settingsView !== 'WEBDAV' || !scheduledConfig.enabled) return;
    const intervalId = window.setInterval(async () => {
      try {
        const stateResult = await ScheduledRemoteBackupConfigService.loadState();
        if (stateResult.success && stateResult.state) {
          setScheduledState(stateResult.state);
        }
      } catch { /* 轮询失败静默忽略 */ }
    }, 5000);
    return () => { window.clearInterval(intervalId); };
  }, [settingsView, scheduledConfig.enabled]);

  useEffect(() => {
    if (!scheduledConfig.exitPromptEnabled || !webdavPasswordSaved) {
      setExitHintVisible(false);
      return;
    }
    const EXIT_PROMPT_THRESHOLD_MS = 30 * 60 * 1000;
    let cancelled = false;
    (async () => {
      try {
        const diskData = await readDiskStorageData('data.json');
        const diskTs = diskData ? getLatestUpdateTimestamp(diskData) : null;
        const lastSuccessAt = getLatestBackupSuccessAt(scheduledState);
        const hasUnsaved =
          diskTs !== null && diskTs > 0 &&
          (scheduledState.lastSuccessfulStorageUpdatedAt === null || diskTs > scheduledState.lastSuccessfulStorageUpdatedAt);
        const beyondThreshold = lastSuccessAt === null || (Date.now() - lastSuccessAt >= EXIT_PROMPT_THRESHOLD_MS);
        if (!cancelled) setExitHintVisible(hasUnsaved && beyondThreshold);
      } catch {
        if (!cancelled) setExitHintVisible(false);
      }
    })();
    return () => { cancelled = true; };
  }, [scheduledConfig.exitPromptEnabled, webdavPasswordSaved, scheduledState.lastSuccessfulStorageUpdatedAt, scheduledState.lastAutomaticSuccessAt, scheduledState.lastManualSuccessAt]);

  const onExportClick = async () => {
    try {
      setExportStatus('正在导出…');
      await exportAll();
      setExportStatus('导出成功');
      setTimeout(() => {
        setExportStatus(null);
        setShowSettings(false);
      }, 1500);
    } catch {
      setExportStatus('导出已取消或失败');
      setTimeout(() => setExportStatus(null), 2000);
    }
  };

  const onImportClick = async () => {
    setImportFeedback(null);
    const result = await importFromFile();
    setImportFeedback(result);
  };

  const onAttachmentScanClick = async () => {
    setAttachmentScanState({ status: 'scanning', missingCount: 0, orphanCount: 0, orphanPaths: [], errorMessage: null });
    try {
      const allNotes = Object.values(store.notesById);
      const knownFiles = await listAttachmentFiles();
      const missingRefs = await detectMissingReferences(allNotes, attachmentExists);
      const orphans = detectOrphanAttachments(knownFiles, allNotes);
      setAttachmentScanState({
        status: 'done',
        missingCount: missingRefs.length,
        orphanCount: orphans.length,
        orphanPaths: orphans.map((o) => o.relativePath),
        errorMessage: null,
      });
    } catch (err) {
      setAttachmentScanState({
        status: 'error',
        missingCount: 0,
        orphanCount: 0,
        orphanPaths: [],
        errorMessage: err instanceof Error ? err.message : '扫描失败',
      });
    }
  };

  const onOrphanCleanupClick = async () => {
    if (attachmentScanState.orphanPaths.length === 0) return;
    const confirmed = await confirm({
            title: '清理孤儿图片',
            message: `即将永久删除 ${attachmentScanState.orphanCount} 个孤儿图片文件本体，并同时清空撤销/重做历史。此操作不可撤销，是否继续？`,
            kind: 'danger',
    });
    if (!confirmed) return;

    try {
      for (const relativePath of attachmentScanState.orphanPaths) {
        await deleteAttachmentFile(relativePath);
      }
      store.clearDomainHistory();
      await onAttachmentScanClick();
    } catch (err) {
      setAttachmentScanState((prev) => ({
        ...prev,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : '清理失败',
      }));
    }
  };

  const onZipBackupClick = async () => {
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const defaultName = `sonotes-backup-${timestamp}.zip`;
    const targetPath = await saveZipDialog(defaultName);
    if (!targetPath) return;

    setZipFeedback(null);
    setZipOperation('backing-up');
    try {
      const flushed = await persistenceFacade.flushNow();
      if (!flushed) {
        setZipFeedback({ status: 'error', message: '备份失败：当前数据尚未成功写入磁盘，请稍后重试。' });
        return;
      }
      const result = await createLocalBackup(targetPath);
      if (result.success) {
        setZipFeedback({
          status: 'success',
          message: `备份成功：${result.noteCount} 条便签，${result.boardCount} 个看板，${result.attachmentCount} 个图片文件。${result.backupPath ? `\n${result.backupPath}` : ''}`,
        });
      } else {
        setZipFeedback({ status: 'error', message: `备份失败：${result.error ?? '未知错误'}` });
      }
    } catch (err) {
      setZipFeedback({ status: 'error', message: `备份失败：${formatUnknownError(err)}` });
    } finally {
      setZipOperation('idle');
    }
  };

  const applyRestoredDiskData = async (): Promise<boolean> => {
    const restoredData = await readDiskStorageData('data.json');
    if (!restoredData) return false;

    restoredData.notes.forEach((note) => {
      note.boardId = note.boardId || 'default';
      note.updatedAt = note.updatedAt || note.createdAt || Date.now();
      note.title = note.title ?? '';
      note.collapsed = note.collapsed ?? false;
      note.attachments = sanitizeNoteAttachments(note);
    });

    if (!restoredData.boards || restoredData.boards.length === 0) {
      restoredData.boards = [{ id: 'default', name: '主板', icon: '📌', createdAt: 0, viewport: { x: 0, y: 0 } }];
      restoredData.currentBoardId = 'default';
    }
    if (!restoredData.currentBoardId || !restoredData.boards.some((b) => b.id === restoredData.currentBoardId)) {
      restoredData.currentBoardId = restoredData.boards[0].id;
    }

    const normalizedNotes = normalizeNotes(restoredData.notes);
    const activeBoard = restoredData.boards.find((b) => b.id === restoredData.currentBoardId);

    invalidateAttachmentPathCache();
    await prehydrateRestoredImageNoteAssetUrls(restoredData.notes);

    useStore.setState((state) => ({
      ...state,
      notesById: normalizedNotes.notesById,
      allNoteIds: normalizedNotes.allNoteIds,
      boardNoteIds: normalizedNotes.boardNoteIds,
      layoutNotesById: createLayoutNotesById(normalizedNotes.notesById),
      boards: restoredData.boards,
      currentBoardId: restoredData.currentBoardId,
      config: restoredData.config,
      viewMode: 'BOARD',
      isDockVisible: true,
      selectedIds: [],
      recentlyCreatedIds: [],
      noteHighlights: {},
      detachedNotes: [],
      domainHistory: { undoStack: [], redoStack: [], capacity: state.domainHistory.capacity },
      isLoaded: true,
      saveStatus: 'idle',
      saveError: null,
      isSaving: false,
      ...(activeBoard?.viewport ? { viewport: { ...state.viewport, x: activeBoard.viewport.x, y: activeBoard.viewport.y } } : {}),
    }));

    const theme = restoredData.config.themeMode || 'system';
    const isSystemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const shouldBeDark = theme === 'dark' || (theme === 'system' && isSystemDark);
    if (shouldBeDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('theme', theme);

    await db.clearWAL();
    return true;
  };

  const formatBytesForRestore = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const buildRestoreSummaryMessage = (summary: {
    boardCount: number;
    noteCount: number;
    textNoteCount: number;
    imageNoteCount: number;
    trashNoteCount: number;
    imageFileCount: number;
    imageFileTotalBytes: number;
    createdAt: number;
    appVersion: string;
    formatVersion: number;
  }): string => {
    const d = new Date(summary.createdAt);
    const pad = (n: number) => String(n).padStart(2, '0');
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return [
      '备份验证通过。',
      '',
      '备份信息：',
      `创建时间：${dateStr}`,
      `应用版本：${summary.appVersion}`,
      `格式版本：${summary.formatVersion}`,
      '',
      '将恢复：',
      `${summary.boardCount} 个看板`,
      `${summary.noteCount - summary.trashNoteCount} 条便签（文本 ${summary.textNoteCount}，图片 ${summary.imageNoteCount}）`,
      `${summary.trashNoteCount} 条废纸篓便签`,
      `${summary.imageFileCount} 个图片文件（${formatBytesForRestore(summary.imageFileTotalBytes)}）`,
      '',
      '当前本地数据将被替换。是否继续？',
    ].join('\n');
  };

  const onZipRestoreClick = async () => {
    const sourceZipPath = await openZipDialog();
    if (!sourceZipPath) return;

    setZipFeedback(null);
    setZipOperation('restoring');
    let pauseOccurred = false;
    let restoreJobHandle: BackupJobHandle | null = null;
    try {
      const validation = await validateLocalBackup(sourceZipPath);

      if (!validation.ok) {
        setZipFeedback({
          status: 'error',
          message: formatValidationErrorMessage(validation.errors),
        });
        return;
      }

      const summary = validation.summary;
      if (!summary) {
        setZipFeedback({ status: 'error', message: '备份验证通过但摘要信息不可用，本地数据未受影响。' });
        return;
      }

      const confirmed = await confirm({ title: '覆盖恢复确认', message: buildRestoreSummaryMessage(summary), kind: 'danger' });
      if (!confirmed) return;

      const flushed = await persistenceFacade.flushNow();
      if (!flushed) {
        setZipFeedback({ status: 'error', message: '恢复失败：当前数据尚未成功写入磁盘，请稍后重试。' });
        return;
      }
      persistenceFacade.pause();
      pauseOccurred = true;

      restoreJobHandle = tryStartBackupJob('local-restore');
      if (!restoreJobHandle) {
        setZipFeedback({ status: 'error', message: '恢复失败：已有备份任务运行中，请稍后重试。' });
        return;
      }

      const result = await restoreLocalBackup(sourceZipPath);
      if (!result.success) {
        setZipFeedback({ status: 'error', message: `恢复失败：${result.error ?? '未知错误'}` });
        return;
      }

      const applied = await applyRestoredDiskData();
      if (!applied) {
        setZipFeedback({ status: 'error', message: '恢复成功但无法读取磁盘数据，请重启应用。' });
        return;
      }

      restoreJobHandle.release();
      restoreJobHandle = null;

      setZipFeedback({
        status: 'success',
        message: `恢复成功：${result.noteCount} 条便签，${result.boardCount} 个看板，${result.attachmentCount} 个图片文件。`,
      });
    } catch (err) {
      setZipFeedback({ status: 'error', message: `恢复失败：${formatUnknownError(err)}` });
    } finally {
      if (restoreJobHandle) {
        restoreJobHandle.release();
      }
      if (pauseOccurred) {
        try {
          persistenceFacade.resume();
        } catch (resumeError) {
          console.warn('恢复持久化失败:', resumeError);
        }
      }
      setZipOperation('idle');
    }
  };

  const requireWebdavCredentials = (): boolean => {
    if (webdavDraft.password.trim() || webdavPasswordSaved) return true;
    setWebdavFeedback({ status: 'error', message: '请先输入密码或在设置中勾选"记住密码"。' });
    return false;
  };

  const buildWebdavConfig = (): WebDavBackupService.WebDavConfig | null => {
    if (!webdavDraft.serverUrl.trim() || !webdavDraft.username.trim()) {
      setWebdavFeedback({ status: 'error', message: '请填写服务器地址和用户名。' });
      return null;
    }
    return {
      serverUrl: webdavDraft.serverUrl.trim(),
      username: webdavDraft.username.trim(),
      password: webdavDraft.password || undefined,
      remoteDir: webdavDraft.remoteDir.trim() || undefined,
    };
  };

  const onWebdavSaveConfig = async () => {
    const config = buildWebdavConfig();
    if (!config) return;
    if (webdavDraft.rememberPassword && !webdavDraft.password.trim()) {
      setWebdavFeedback({ status: 'error', message: '勾选"记住密码"时需要输入密码。' });
      return;
    }
    setWebdavFeedback(null);
    setWebdavOperation('saving');
    try {
      const result = await WebDavBackupService.saveConfig({
        ...config,
        rememberPassword: webdavDraft.rememberPassword,
      });
      if (result.success) {
        if (result.warning) {
          if (!webdavDraft.rememberPassword) {
            setWebdavPasswordSaved(false);
            setScheduledConfig(ScheduledRemoteBackupConfigService.DEFAULT_SCHEDULED_BACKUP_CONFIG);
            setScheduledState(ScheduledRemoteBackupConfigService.DEFAULT_SCHEDULED_BACKUP_STATE);
            setScheduledLoading(false);
            if (scheduledConfig.enabled) {
              void persistScheduledConfig({ ...scheduledConfig, enabled: false });
            }
          }
          setWebdavFeedback({ status: 'info', message: result.warning });
        } else if (webdavDraft.rememberPassword) {
          setWebdavFeedback({ status: 'success', message: '密码已保存到系统凭据管理器。' });
          setWebdavPasswordSaved(true);
        } else {
          setWebdavPasswordSaved(false);
          if (scheduledConfig.enabled) {
            void persistScheduledConfig({ ...scheduledConfig, enabled: false });
          }
          setWebdavFeedback({ status: 'success', message: '配置已保存。' });
        }
      } else {
        setWebdavFeedback({ status: 'error', message: `保存失败：${result.error ?? '未知错误'}` });
      }
    } catch (err) {
      setWebdavFeedback({ status: 'error', message: `保存失败：${formatUnknownError(err)}` });
    } finally {
      setWebdavOperation('idle');
    }
  };

  const onWebdavClearConfig = async () => {
    setWebdavFeedback(null);
    setWebdavOperation('saving');
    try {
      const result = await WebDavBackupService.clearConfig();
      if (result.success) {
        setWebdavDraft({ serverUrl: '', username: '', password: '', remoteDir: 'SoNotes_Backups/', rememberPassword: false });
        setWebdavBackups([]);
        setWebdavPasswordSaved(false);
        if (scheduledConfig.enabled) {
          void persistScheduledConfig({ ...scheduledConfig, enabled: false });
        }
        if (result.secretCleanupWarning) {
          setWebdavFeedback({ status: 'info', message: result.secretCleanupWarning });
        } else {
          setWebdavFeedback({ status: 'info', message: '配置已清除。' });
        }
      } else {
        setWebdavFeedback({ status: 'error', message: `清除失败：${result.error ?? '未知错误'}` });
      }
    } catch (err) {
      setWebdavFeedback({ status: 'error', message: `清除失败：${formatUnknownError(err)}` });
    } finally {
      setWebdavOperation('idle');
    }
  };

  const onWebdavTestConnection = async () => {
    const config = buildWebdavConfig();
    if (!config) return;
    if (!requireWebdavCredentials()) return;
    setWebdavFeedback(null);
    setWebdavOperation('testing');
    try {
      const result = await WebDavBackupService.testConnection(config);
      if (result.success) {
        setWebdavFeedback({ status: 'success', message: '连接测试成功。' });
      } else {
        setWebdavFeedback({ status: 'error', message: `连接失败：${formatWebdavError(result.error ?? '未知错误')}` });
      }
    } catch (err) {
      setWebdavFeedback({ status: 'error', message: `连接失败：${formatWebdavError(formatUnknownError(err))}` });
    } finally {
      setWebdavOperation('idle');
    }
  };

  const onWebdavListBackups = async () => {
    const config = buildWebdavConfig();
    if (!config) return;
    if (!requireWebdavCredentials()) return;
    setWebdavFeedback(null);
    setWebdavOperation('listing');
    try {
      const backups = await WebDavBackupService.listBackups(config);
      setWebdavBackups(backups);
      if (backups.length === 0) {
        setWebdavFeedback({ status: 'info', message: '远端无备份文件。' });
      }
    } catch (err) {
      setWebdavFeedback({ status: 'error', message: `获取备份列表失败：${formatWebdavError(formatUnknownError(err))}` });
    } finally {
      setWebdavOperation('idle');
    }
  };

  const onWebdavCreateBackup = async () => {
    const config = buildWebdavConfig();
    if (!config) return;
    if (!requireWebdavCredentials()) return;
    setWebdavFeedback(null);
    setWebdavOperation('creating');
    try {
      const result = await runRemoteBackup(
        {
          flushNow: persistenceFacade.flushNow.bind(persistenceFacade),
          createRemoteBackup: WebDavBackupService.createRemoteBackup,
          readDiskStorageData: () => readDiskStorageData('data.json'),
          getLatestUpdateTimestamp,
          coordinator: { tryStartBackupJob },
          now: () => Date.now(),
        },
        config,
      );
      if (result.success) {
        setWebdavFeedback({ status: 'success', message: `远端备份已创建：${result.remoteFileName ?? '完成'}` });
        try {
          const backups = await WebDavBackupService.listBackups(config);
          setWebdavBackups(backups);
        } catch {
          // list refresh failure is non-critical
        }

        // 更新定时备份状态：手动成功也覆盖快照字段
        try {
          const stateResult = await ScheduledRemoteBackupConfigService.loadState();
          if (stateResult.success && stateResult.state) {
            const diskData = await readDiskStorageData('data.json');
            const diskTs = diskData ? getLatestUpdateTimestamp(diskData) : null;
            const updated = {
              ...stateResult.state,
              lastFinishedAt: Date.now(),
              lastTrigger: 'manual' as const,
              lastManualSuccessAt: Date.now(),
              lastRemoteFileName: result.remoteFileName ?? null,
              ...(diskTs !== null ? { lastSuccessfulStorageUpdatedAt: diskTs } : {}),
            };
            await ScheduledRemoteBackupConfigService.saveState(updated);
            setScheduledState(updated);
          }
        } catch {
          // state update failure is non-critical for manual backup
        }
      } else {
        setWebdavFeedback({ status: 'error', message: `创建远端备份失败：${formatWebdavError(result.error ?? '未知错误')}` });
        try {
          const stateResult = await ScheduledRemoteBackupConfigService.loadState();
          if (stateResult.success && stateResult.state) {
            const updated = {
              ...stateResult.state,
              lastFinishedAt: Date.now(),
              lastTrigger: 'manual' as const,
              lastFailureAt: Date.now(),
              lastFailureReason: result.error ?? '未知错误',
              lastFailureStage: isRemoteBackupStage(result.errorStage ?? '') ? (result.errorStage as RemoteBackupStage) : 'unknown',
            };
            await ScheduledRemoteBackupConfigService.saveState(updated);
            setScheduledState(updated);
          }
        } catch {
          // state update failure is non-critical
        }
      }
    } catch (err) {
      setWebdavFeedback({ status: 'error', message: `创建远端备份失败：${formatWebdavError(formatUnknownError(err))}` });
    } finally {
      setWebdavOperation('idle');
    }
  };

  const onWebdavDeleteBackup = async (fileName: string) => {
    const confirmed = await confirm({
      title: '删除远端备份',
      message: `确定要删除远端备份 "${fileName}" 吗？这不会影响当前本地看板和便签，但远端备份文件删除后不可恢复。`,
      kind: 'danger',
    });
    if (!confirmed) return;

    const config = buildWebdavConfig();
    if (!config) return;
    if (!requireWebdavCredentials()) return;

    setWebdavFeedback(null);
    setWebdavOperation('deleting');
    try {
      const result = await WebDavBackupService.deleteBackup(config, fileName);
      if (result.success) {
        setWebdavFeedback({ status: 'success', message: '远端备份已删除。' });
        try {
          const backups = await WebDavBackupService.listBackups(config);
          setWebdavBackups(backups);
        } catch {
          setWebdavBackups((items) => items.filter((item) => item.fileName !== fileName));
        }
      } else {
        setWebdavFeedback({ status: 'error', message: `删除远端备份失败：${formatWebdavError(result.error ?? '未知错误')}` });
      }
    } catch (err) {
      setWebdavFeedback({ status: 'error', message: `删除远端备份失败：${formatWebdavError(formatUnknownError(err))}` });
    } finally {
      setWebdavOperation('idle');
    }
  };

  const onWebdavRestore = async (fileName: string) => {
    const initialConfirmed = await confirm({
      title: '下载并验证备份',
      message: `即将从远端备份 "${fileName}" 下载并验证，是否继续？`,
    });
    if (!initialConfirmed) return;

    const config = buildWebdavConfig();
    if (!config) return;
    if (!requireWebdavCredentials()) return;

    setWebdavFeedback(null);
    setWebdavOperation('restoring');
    let pauseOccurred = false;
    let restoreJobHandle: BackupJobHandle | null = null;
    let downloadToken: string | null = null;
    try {
      const dlResult = await WebDavBackupService.downloadBackup(config, fileName);
      if (!dlResult.success || !dlResult.downloadToken) {
        setWebdavFeedback({ status: 'error', message: `下载失败：${formatWebdavError(dlResult.error ?? '未知错误')}` });
        return;
      }
      downloadToken = dlResult.downloadToken;

      const resolveResult = await WebDavBackupService.resolveDownloadedBackup(downloadToken);
      if (!resolveResult.success || !resolveResult.localPath) {
        setWebdavFeedback({ status: 'error', message: `解析下载文件失败：${formatWebdavError(resolveResult.error ?? '未知错误')}` });
        return;
      }

      const validation = await validateLocalBackup(resolveResult.localPath);
      if (!validation.ok) {
        setWebdavFeedback({
          status: 'error',
          message: formatValidationErrorMessage(validation.errors),
        });
        return;
      }

      const summary = validation.summary;
      if (!summary) {
        setWebdavFeedback({ status: 'error', message: '备份验证通过但摘要信息不可用，本地数据未受影响。' });
        return;
      }

      const restoreConfirmed = await confirm({ title: '覆盖恢复确认', message: buildRestoreSummaryMessage(summary), kind: 'danger' });
      if (!restoreConfirmed) return;

      const flushed = await persistenceFacade.flushNow();
      if (!flushed) {
        setWebdavFeedback({ status: 'error', message: '恢复失败：当前数据尚未成功写入磁盘，请稍后重试。' });
        return;
      }
      persistenceFacade.pause();
      pauseOccurred = true;

      restoreJobHandle = tryStartBackupJob('remote-restore');
      if (!restoreJobHandle) {
        setWebdavFeedback({ status: 'error', message: '恢复失败：已有备份任务运行中，请稍后重试。' });
        return;
      }

      const result = await restoreLocalBackup(resolveResult.localPath);
      if (!result.success) {
        setWebdavFeedback({ status: 'error', message: `恢复失败：${formatWebdavError(result.error ?? '未知错误')}` });
        return;
      }

      const applied = await applyRestoredDiskData();
      if (!applied) {
        setWebdavFeedback({ status: 'error', message: '恢复成功但无法读取磁盘数据，请重启应用。' });
        return;
      }

      restoreJobHandle.release();
      restoreJobHandle = null;

      setWebdavFeedback({
        status: 'success',
        message: `远端恢复成功：${result.noteCount} 条便签，${result.boardCount} 个看板，${result.attachmentCount} 个图片文件。`,
      });
    } catch (err) {
      setWebdavFeedback({ status: 'error', message: `恢复失败：${formatWebdavError(formatUnknownError(err))}` });
    } finally {
      if (restoreJobHandle) {
        restoreJobHandle.release();
      }
      if (downloadToken) {
        try {
          await WebDavBackupService.cleanupDownloadedBackup(downloadToken);
        } catch (cleanupErr) {
          console.warn('清理下载文件失败:', cleanupErr);
        }
      }
      if (pauseOccurred) {
        try {
          persistenceFacade.resume();
        } catch (resumeError) {
          console.warn('恢复持久化失败:', resumeError);
        }
      }
      setWebdavOperation('idle');
    }
  };

  const persistScheduledConfig = async (next: ScheduledRemoteBackupConfig) => {
    const previous = scheduledConfig;
    setScheduledConfig(next);
    try {
      const result = await ScheduledRemoteBackupConfigService.saveConfig(next);
      if (!result.success) {
        setScheduledConfig(previous);
        setWebdavFeedback({ status: 'error', message: `保存自动远端备份设置失败：${result.error ?? '未知错误'}` });
        return false;
      }
      getSchedulerService()?.updateConfig(next);
      return true;
    } catch (err) {
      setScheduledConfig(previous);
      setWebdavFeedback({ status: 'error', message: `保存自动远端备份设置失败：${formatUnknownError(err)}` });
      return false;
    }
  };

  const onScheduledEnabledToggle = async () => {
    if (scheduledConfig.enabled) {
      await persistScheduledConfig({ ...scheduledConfig, enabled: false });
      return;
    }
    if (!webdavPasswordSaved) {
      setWebdavFeedback({
        status: 'error',
        message: '请先保存 WebDAV 密码到系统凭据管理器，再启用自动远端备份。',
      });
      return;
    }
    await persistScheduledConfig({ ...scheduledConfig, enabled: true });
  };

  const onScheduledFrequencyChange = async (frequency: ScheduledRemoteBackupFrequency) => {
    await persistScheduledConfig({ ...scheduledConfig, frequency });
  };

  const onExitPromptToggle = async () => {
    await persistScheduledConfig({ ...scheduledConfig, exitPromptEnabled: !scheduledConfig.exitPromptEnabled });
  };

  const disableScheduledByCredential = !webdavPasswordSaved && scheduledConfig.enabled;
  const scheduledEnabledEffective = scheduledConfig.enabled && webdavPasswordSaved;

  const importSummaryText = importFeedback?.summary && !importFeedback.rolledBack
    ? formatImportSummary(importFeedback.summary)
    : null;
  const importHighlightTexts = importFeedback?.summary && !importFeedback.rolledBack
    ? formatImportHighlights(importFeedback.summary)
    : [];
  const importFeedbackClassName = importFeedback?.status === 'error'
    ? 'mx-3 mt-2 rounded-md border border-red-100 bg-red-50 px-3 py-2 text-xs leading-5 text-red-600 dark:border-red-900/50 dark:bg-red-900/30 dark:text-red-400'
    : 'mx-3 mt-2 rounded-md border border-border-subtle bg-secondary-bg/70 px-3 py-2 text-xs leading-5 text-text-secondary';
  const saveStatusText = isSaving || saveStatus === 'saving'
    ? '保存中…'
    : saveStatus === 'error'
      ? '保存失败'
      : saveStatus === 'saved'
        ? `已保存 ${lastSavedAt ? new Date(lastSavedAt).toLocaleTimeString('zh-CN', { hour12: false }) : ''}`.trim()
        : '等待保存';
  const saveStatusClassName = saveStatus === 'error'
    ? 'mx-3 mt-2 rounded-md border border-red-100 bg-red-50 px-3 py-2 text-xs leading-5 text-red-600 dark:border-red-900/50 dark:bg-red-900/30 dark:text-red-400'
    : 'mx-3 mt-2 rounded-md border border-border-subtle bg-secondary-bg/70 px-3 py-2 text-xs leading-5 text-text-secondary';

  const handleDeleteClick = () => {
      if (!contextMenuBoard) return;
      
      if (deleteConfirm?.id === contextMenuBoard.id) {
          // Second click: Confirm Delete
          deleteBoard(contextMenuBoard.id);
          setContextMenuBoard(null);
          setDeleteConfirm(null);
      } else {
          // First click: Check count
          const count = getBoardActiveNoteCount(contextMenuBoard.id);
          if (count > 0) {
              setDeleteConfirm({ id: contextMenuBoard.id, count });
          } else {
              // No notes, delete immediately
              deleteBoard(contextMenuBoard.id);
              setContextMenuBoard(null);
          }
      }
  };

  const getBoardActiveNoteCount = (boardId: string) => (boardNoteIds[boardId] ?? []).filter((noteId) => {
      const note = notesById[noteId];
      return note && !note.deletedAt;
  }).length;

  const handleCreate = () => {
    if (newBoardName.trim()) {
      const randomIcon = BOARD_ICONS[Math.floor(Math.random() * BOARD_ICONS.length)];
      createBoard(newBoardName.trim(), randomIcon);
      setIsInputMode(false);
      setNewBoardName("");
      setDockVisible(false); // Close dock after creation
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleCreate();
    if (e.key === 'Escape') setIsInputMode(false);
  };

  const handleRenameSave = () => {
      if (editingBoardId && editName.trim()) {
          updateBoard(editingBoardId, { name: editName.trim() });
      }
      setEditingBoardId(null);
      setEditName("");
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleRenameSave();
      if (e.key === 'Escape') {
          setEditingBoardId(null);
          setEditName("");
      }
  };

  const resolveBoardMenuAnchor = (boardElement: HTMLElement) => {
      const fallbackCenterX = boardElement.offsetLeft + boardElement.offsetWidth / 2;
      const localTop = boardElement.offsetTop;
      const dockContainer = dockContainerRef.current;

      if (!dockContainer) {
          return {
              x: fallbackCenterX,
              y: localTop,
          };
      }

      const boardRect = boardElement.getBoundingClientRect();
      const dockRect = dockContainer.getBoundingClientRect();
      const layoutWidth = dockContainer.offsetWidth;

      if (layoutWidth <= 0 || dockRect.width <= 0 || boardRect.width <= 0) {
          return {
              x: fallbackCenterX,
              y: localTop,
          };
      }

      const scaleX = dockRect.width / layoutWidth;
      const renderedCenterX = boardRect.left - dockRect.left + boardRect.width / 2;

      return {
          x: renderedCenterX / scaleX,
          y: localTop,
      };
  };

  if (!isDockVisible) return null;

  // Only show overlay when:
  // 1. In BOARD mode and dock is visible (to click-away close dock)
  // 2. OR any context menu/input is open (to click-away close menu)
  const hasDockPopoverOpen = Boolean(contextMenuBoard || isInputMode || showSettings);
  const showOverlay = (isDockVisible && viewMode === 'BOARD') || hasDockPopoverOpen;
  const dockLayerZIndex = hasDockPopoverOpen ? Z_INDEX.MENU : Z_INDEX.DOCK;

  return (
    <>
      {/* 1. Full-screen transparent overlay for "Click outside to close" */}
      {showOverlay && (
        <button
          type="button"
          aria-label="关闭浮层"
          className="pointer-events-auto absolute inset-0 bg-transparent"
          style={{ zIndex: Z_INDEX.DOCK_BACKDROP }}
          onClick={() => { 
            if (contextMenuBoard || isInputMode || showSettings) {
              setContextMenuBoard(null);
              setIsInputMode(false);
              setShowSettings(false);
            } else {
              setDockVisible(false); 
            }
          }}
          onContextMenu={(e) => { 
            e.preventDefault(); 
            setContextMenuBoard(null); 
            if (!contextMenuBoard && !isInputMode && !showSettings) setDockVisible(false); 
          }} 
        />
      )}

      {/* 2. Dock Container - Centered using Flexbox to avoid transform conflicts */}
      <div className="absolute inset-x-0 bottom-8 pointer-events-none flex justify-center" style={{ zIndex: dockLayerZIndex }}>
        <div ref={dockContainerRef} className="board-dock-container relative pointer-events-auto flex flex-col items-center transform transition-transform duration-300 origin-bottom scale-90 md:scale-100">
        
        {/* Context Menu for Deletion */}
        {contextMenuBoard && (
            <div 
                className="board-dock-context-menu absolute bottom-full mb-2 -translate-x-1/2 bg-secondary-bg rounded-lg shadow-xl border border-border-subtle overflow-hidden animate-in fade-in zoom-in-95 duration-100 origin-bottom"
                style={{ left: contextMenuBoard.x, zIndex: Z_INDEX.MENU }}
            >
                <div className="px-3 py-2 text-xs text-text-secondary border-b border-border-subtle font-medium bg-secondary-bg/50">
                    {contextMenuBoard.name}
                </div>
                
                <button
                    type="button"
                    onClick={() => {
                        setEditingBoardId(contextMenuBoard.id);
                        setEditName(contextMenuBoard.name);
                        setContextMenuBoard(null);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 transition-colors border-b border-border-subtle"
                >
                    <span>✏️</span> 重命名
                </button>

                <button
                    type="button"
                    onClick={handleDeleteClick}
                    className={cn(
                        "w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors rounded-b-lg",
                        deleteConfirm?.id === contextMenuBoard.id
                            ? "bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50"
                            : "text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                    )}
                >
                    <span>🗑️</span> 
                    {deleteConfirm?.id === contextMenuBoard.id 
                        ? `确认删除看板及 ${deleteConfirm.count} 个便签？` 
                        : '删除看板'}
                </button>
            </div>
        )}

        {/* Settings Menu */}
        {showSettings && (
            <div 
                className="absolute bottom-full mb-2 bg-secondary-bg rounded-lg shadow-xl border border-border-subtle overflow-hidden animate-in fade-in zoom-in-95 duration-100 origin-bottom min-w-[200px]"
                style={{ zIndex: Z_INDEX.MENU }}
            >
                {settingsView === 'MAIN' && (
                    <div className="py-1">
                        <div className="px-3 py-2 text-xs text-text-tertiary font-medium border-b border-border-subtle mb-1 mx-1">
                            设置
                        </div>
                        <button
                            type="button"
                            onClick={() => setSettingsView('THEME')}
                            className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary transition-colors"
                        >
                            <div className="flex items-center gap-2">
                                <span className="text-text-tertiary"><Monitor className="w-4 h-4" /></span>
                                <span>主题模式</span>
                            </div>
                            <div className="flex items-center gap-1 text-text-tertiary">
                                <span className="text-xs opacity-70">
                                    {config.themeMode === 'system' ? '跟随系统' : config.themeMode === 'dark' ? '深色' : '浅色'}
                                </span>
                                <ChevronRight className="w-4 h-4" />
                            </div>
                        </button>
                        <button
                            type="button"
                            onClick={() => setSettingsView('DATA')}
                            className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary transition-colors"
                        >
                            <div className="flex items-center gap-2">
                                <span className="text-text-tertiary"><Database className="w-4 h-4" /></span>
                                <span>数据管理</span>
                            </div>
                            <ChevronRight className="w-4 h-4 text-text-tertiary" />
                        </button>
                    </div>
                )}

                {settingsView === 'THEME' && (
                    <div className="py-1">
                        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border-subtle mb-1">
                            <button 
                                type="button"
                                onClick={() => setSettingsView('MAIN')}
                                className="p-1 hover:bg-secondary-bg/50 dark:hover:bg-white/5 rounded text-text-secondary hover:text-text-primary transition-colors"
                            >
                                <ChevronLeft className="w-4 h-4" />
                            </button>
                            <span className="text-xs text-text-tertiary font-medium">主题模式</span>
                        </div>
                        {[
                            { id: 'light', label: '浅色', icon: Sun },
                            { id: 'dark', label: '深色', icon: Moon },
                            { id: 'system', label: '跟随系统', icon: Monitor },
                        ].map((item) => (
                            <button
                                key={item.id}
                                type="button"
                                onClick={() => setThemeMode(item.id as StoreState['config']['themeMode'])}
                                className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary transition-colors"
                            >
                                <div className="flex items-center gap-2">
                                    <item.icon className="w-4 h-4 text-text-tertiary" />
                                    <span>{item.label}</span>
                                </div>
                                {config.themeMode === item.id && <Check className="w-4 h-4 text-blue-500" />}
                            </button>
                        ))}
                    </div>
                )}

                {settingsView === 'DATA' && (
                    <div className="py-1">
                        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border-subtle mb-1">
                            <button 
                                type="button"
                                onClick={() => setSettingsView('MAIN')}
                                className="p-1 hover:bg-secondary-bg/50 dark:hover:bg-white/5 rounded text-text-secondary hover:text-text-primary transition-colors"
                            >
                                <ChevronLeft className="w-4 h-4" />
                            </button>
                            <span className="text-xs text-text-tertiary font-medium">数据管理</span>
                        </div>
                        
                        <button
                            type="button"
                            onClick={onExportClick}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary transition-colors"
                        >
                            <Download className="w-4 h-4 text-text-tertiary" />
                            <span>导出 JSON</span>
                        </button>

                        {viewMode === 'BOARD' && (
                        <button
                            type="button"
                            onClick={async () => {
                            await store.exportCurrentBoard();
                            setShowSettings(false);
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary transition-colors"
                        >
                            <Share className="w-4 h-4 text-text-tertiary" />
                            <span>导出当前看板</span>
                        </button>
                        )}

                        <button
                            type="button"
                            onClick={onImportClick}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary transition-colors"
                        >
        <Upload className="w-4 h-4 text-text-tertiary" />
          <span>导入 JSON</span>
        </button>

        {exportStatus && (
          <div className="mx-3 mt-2 rounded-md border border-border-subtle bg-secondary-bg/70 px-3 py-2 text-xs leading-5 text-text-secondary">
            {exportStatus}
          </div>
        )}

        {importFeedback && (
                            <div
                                data-testid="board-import-feedback"
                                role={importFeedback.status === 'error' ? 'alert' : 'status'}
                                aria-live="polite"
                                className={importFeedbackClassName}
                            >
                                <p className={cn('font-medium', importFeedback.status === 'error' ? 'text-current' : 'text-text-primary')}>
                                    {importFeedback.status === 'cancelled'
                                        ? '已取消导入。'
                                        : importFeedback.message || '导入已完成。'}
                                </p>

                                {importFeedback.rolledBack && (
                                    <p className="mt-1 text-[11px] leading-4 opacity-90">
                                        已回滚到导入前状态，当前数据未被改动。
                                    </p>
                                )}

                                {importSummaryText && (
                                    <p className={cn('mt-1 text-[11px] leading-4', importFeedback.status === 'error' ? 'text-current/90' : 'text-text-tertiary')}>
                                        {importSummaryText}
                                    </p>
                                )}

                                {importHighlightTexts.length > 0 && (
                                    <div className={cn('mt-1 space-y-1 text-[11px] leading-4', importFeedback.status === 'error' ? 'text-current/90' : 'text-text-tertiary')}>
                                        {importHighlightTexts.map((text) => (
                                            <p key={text}>{text}</p>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        <div className="mx-3 my-1.5 border-t border-border-subtle" />

                        <button
                            type="button"
                            onClick={onZipBackupClick}
                            disabled={zipOperation !== 'idle' || webdavOperation !== 'idle'}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary transition-colors disabled:opacity-50"
                            data-testid="zip-backup-button"
                        >
                            <Archive className="w-4 h-4 text-text-tertiary" />
                            <span>{zipOperation === 'backing-up' ? '备份中…' : '创建本地 zip 备份'}</span>
                        </button>

                        <button
                            type="button"
                            onClick={onZipRestoreClick}
                            disabled={zipOperation !== 'idle' || webdavOperation !== 'idle'}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary transition-colors disabled:opacity-50"
                            data-testid="zip-restore-button"
                        >
                            <RotateCcw className="w-4 h-4 text-text-tertiary" />
                            <span>{zipOperation === 'restoring' ? '恢复中…' : '从 zip 覆盖恢复'}</span>
                        </button>

                        {zipFeedback && (
                            <div
                                data-testid="zip-feedback"
                                role={zipFeedback.status === 'error' ? 'alert' : 'status'}
                                aria-live="polite"
                                className={zipFeedback.status === 'error'
                                    ? 'mx-3 mt-2 rounded-md border border-red-100 bg-red-50 px-3 py-2 text-xs leading-5 text-red-600 dark:border-red-900/50 dark:bg-red-900/30 dark:text-red-400'
                                    : 'mx-3 mt-2 rounded-md border border-border-subtle bg-secondary-bg/70 px-3 py-2 text-xs leading-5 text-text-secondary'}
                            >
                                <p className={cn('font-medium whitespace-pre-line', zipFeedback.status === 'error' ? 'text-current' : 'text-text-primary')}>
                                    {zipFeedback.message}
                                </p>
                            </div>
                        )}

                        <div
                            data-testid="board-save-feedback"
                            role={saveStatus === 'error' ? 'alert' : 'status'}
                            aria-live="polite"
                            className={saveStatusClassName}
                        >
                            <p className={cn('font-medium', saveStatus === 'error' ? 'text-current' : 'text-text-primary')}>
                                {saveStatusText}
                            </p>
                            {saveStatus === 'error' && saveError && (
                                <p className="mt-1 text-[11px] leading-4 opacity-90">{saveError}</p>
                            )}
                        </div>

                        <button
                            type="button"
                            onClick={onAttachmentScanClick}
                            disabled={attachmentScanState.status === 'scanning'}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary transition-colors disabled:opacity-50"
                            data-testid="attachment-scan-button"
                        >
                            <Search className="w-4 h-4 text-text-tertiary" />
                            <span>{attachmentScanState.status === 'scanning' ? '扫描中…' : '检查图片文件一致性'}</span>
                        </button>

                        {attachmentScanState.status === 'done' && (
                            <div
                                data-testid="attachment-scan-result"
                                className="mx-3 mt-2 rounded-md border border-border-subtle bg-secondary-bg/70 px-3 py-2 text-xs leading-5 text-text-secondary"
                            >
                                <p className="font-medium text-text-primary">
                                    缺失图片 {attachmentScanState.missingCount}，孤儿图片 {attachmentScanState.orphanCount}
                                </p>
                            </div>
                        )}

                        {attachmentScanState.status === 'error' && (
                            <div
                                data-testid="attachment-scan-error"
                                role="alert"
                                className="mx-3 mt-2 rounded-md border border-red-100 bg-red-50 px-3 py-2 text-xs leading-5 text-red-600 dark:border-red-900/50 dark:bg-red-900/30 dark:text-red-400"
                            >
                                <p className="font-medium">{attachmentScanState.errorMessage ?? '扫描失败'}</p>
                            </div>
                        )}

                        {attachmentScanState.status === 'done' && attachmentScanState.orphanCount > 0 && (
                            <button
                                type="button"
                                onClick={onOrphanCleanupClick}
                                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                                data-testid="orphan-cleanup-button"
                            >
                                <Trash2 className="w-4 h-4" />
                                <span>清理孤儿图片 ({attachmentScanState.orphanCount})</span>
                            </button>
                        )}

                        <div className="mx-3 my-1.5 border-t border-border-subtle" />

                        <button
                            type="button"
                            onClick={() => setSettingsView('WEBDAV')}
                            className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary transition-colors"
                            data-testid="webdav-entry-button"
                        >
                            <div className="flex items-center gap-2">
                                <Cloud className="w-4 h-4 text-text-tertiary" />
                                <span>远端备份/恢复</span>
                            </div>
                            <ChevronRight className="w-4 h-4 text-text-tertiary" />
                        </button>

        <button
          type="button"
          onClick={() => setSettingsView('DIAGNOSTICS')}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary transition-colors"
                        >
                            <Activity className="w-4 h-4 text-text-tertiary" />
                            <span>性能诊断</span>
                            <ChevronRight className="w-4 h-4 ml-auto text-text-tertiary" />
                        </button>
                    </div>
                )}

                {settingsView === 'WEBDAV' && (
                    <div className="py-1 min-w-[320px]">
                        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border-subtle mb-1">
                            <button
                                type="button"
                                onClick={() => setSettingsView('DATA')}
                                className="p-1 hover:bg-secondary-bg/50 dark:hover:bg-white/5 rounded text-text-secondary hover:text-text-primary transition-colors"
                            >
                                <ChevronLeft className="w-4 h-4" />
                            </button>
                            <span className="text-xs text-text-tertiary font-medium">远端备份/恢复 (WebDAV)</span>
                        </div>

                        <div className="px-3 py-2 space-y-2">
                            <input
                                type="text"
                                placeholder="服务器地址 (https://…)"
                                value={webdavDraft.serverUrl}
                                onChange={(e) => setWebdavDraft(prev => ({ ...prev, serverUrl: e.target.value }))}
                                className="w-full bg-secondary-bg/50 border border-border-subtle rounded px-2 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-blue-400"
                                data-testid="webdav-server-url"
                            />
                            <input
                                type="text"
                                placeholder="用户名"
                                value={webdavDraft.username}
                                onChange={(e) => setWebdavDraft(prev => ({ ...prev, username: e.target.value }))}
                                className="w-full bg-secondary-bg/50 border border-border-subtle rounded px-2 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-blue-400"
                                data-testid="webdav-username"
                            />
                            <input
                                type="password"
                                placeholder="密码"
                                value={webdavDraft.password}
                                onChange={(e) => setWebdavDraft(prev => ({ ...prev, password: e.target.value }))}
                                className="w-full bg-secondary-bg/50 border border-border-subtle rounded px-2 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-blue-400"
                                data-testid="webdav-password"
                            />
                            {webdavPasswordSaved && (
                                <p className="text-[10px] text-green-600 dark:text-green-400 leading-tight" data-testid="webdav-password-saved-status">
                                    密码已保存到系统凭据管理器
                                </p>
                            )}
                            <input
                                type="text"
                                placeholder="远端目录"
                                value={webdavDraft.remoteDir}
                                onChange={(e) => setWebdavDraft(prev => ({ ...prev, remoteDir: e.target.value }))}
                                className="w-full bg-secondary-bg/50 border border-border-subtle rounded px-2 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-blue-400"
                                data-testid="webdav-remote-dir"
                            />
                            <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={webdavDraft.rememberPassword}
                                    onChange={(e) => setWebdavDraft(prev => ({ ...prev, rememberPassword: e.target.checked }))}
                                    className="rounded"
                                    data-testid="webdav-remember-password"
                                />
                                <span>记住密码</span>
                            </label>
                        </div>

                        <div className="flex items-center gap-1 px-3 py-1">
                            <button
                                type="button"
                                onClick={onWebdavSaveConfig}
                                disabled={webdavOperation !== 'idle' || zipOperation !== 'idle'}
                                className="flex items-center gap-1 px-2 py-1.5 text-xs text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 rounded transition-colors disabled:opacity-50"
                                data-testid="webdav-save-config"
                            >
                                <Save className="w-3.5 h-3.5" />
                                <span>{webdavOperation === 'saving' ? '保存中…' : '保存配置'}</span>
                            </button>
                            <button
                                type="button"
                                onClick={onWebdavClearConfig}
                                disabled={webdavOperation !== 'idle' || zipOperation !== 'idle'}
                                className="flex items-center gap-1 px-2 py-1.5 text-xs text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 rounded transition-colors disabled:opacity-50"
                                data-testid="webdav-clear-config"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                                <span>清除配置</span>
                            </button>
                            <button
                                type="button"
                                onClick={onWebdavTestConnection}
                                disabled={webdavOperation !== 'idle' || zipOperation !== 'idle'}
                                className="flex items-center gap-1 px-2 py-1.5 text-xs text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 rounded transition-colors disabled:opacity-50"
                                data-testid="webdav-test-connection"
                            >
                                <Wifi className="w-3.5 h-3.5" />
                                <span>{webdavOperation === 'testing' ? '测试中…' : '测试连接'}</span>
                            </button>
                        </div>

                        <div className="mx-3 my-1.5 border-t border-border-subtle" />

                        <div className="px-3 py-1 flex items-center gap-1">
                            <button
                                type="button"
                                onClick={onWebdavListBackups}
                                disabled={webdavOperation !== 'idle' || zipOperation !== 'idle'}
                                className="flex items-center gap-1 px-2 py-1.5 text-xs text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 rounded transition-colors disabled:opacity-50"
                                data-testid="webdav-refresh-backups"
                            >
                                <RefreshCw className={cn("w-3.5 h-3.5", webdavOperation === 'listing' && "animate-spin")} />
                                <span>{webdavOperation === 'listing' ? '刷新中…' : '刷新远端列表'}</span>
                            </button>
                            <button
                                type="button"
                                onClick={onWebdavCreateBackup}
                                disabled={webdavOperation !== 'idle' || zipOperation !== 'idle'}
                                className="flex items-center gap-1 px-2 py-1.5 text-xs text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 rounded transition-colors disabled:opacity-50"
                                data-testid="webdav-create-backup"
                            >
                                <Upload className="w-3.5 h-3.5" />
                                <span>{webdavOperation === 'creating' ? '创建中…' : '创建远端备份'}</span>
                            </button>
                        </div>

                        {webdavBackups.length > 0 && (
                            <div className="mx-3 my-2 space-y-1" data-testid="webdav-backup-list">
                                {webdavBackups.map((backup) => (
                                    <div
                                        key={backup.fileName}
                                        className="flex items-center justify-between gap-2 px-2 py-1.5 rounded border border-border-subtle bg-secondary-bg/30 text-xs"
                                    >
                                        <div className="flex-1 min-w-0">
                                            <p className="text-text-primary truncate font-medium">{backup.fileName}</p>
                                            <p className="text-text-tertiary">
                                                {backup.size != null ? `${(backup.size / 1024).toFixed(1)} KB` : ''}
                                                {backup.size != null && backup.lastModified ? ' · ' : ''}
                                                {formatWebDavLastModified(backup.lastModified)}
                                                {backup.readable ? '' : ' · 不可读'}
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-1 flex-shrink-0">
                                            <button
                                                type="button"
                                                onClick={() => onWebdavRestore(backup.fileName)}
                                                disabled={webdavOperation !== 'idle' || zipOperation !== 'idle'}
                                                className="flex items-center gap-1 px-2 py-1 text-xs text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 rounded transition-colors disabled:opacity-50"
                                                data-testid="webdav-restore-button"
                                            >
                                                <RotateCcw className="w-3.5 h-3.5" />
                                                <span>恢复</span>
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => onWebdavDeleteBackup(backup.fileName)}
                                                disabled={webdavOperation !== 'idle' || zipOperation !== 'idle'}
                                                className="flex items-center gap-1 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30 rounded transition-colors disabled:opacity-50"
                                                data-testid="webdav-delete-button"
                                            >
                                                <Trash2 className="w-3.5 h-3.5" />
                                                <span>删除</span>
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        <div className="mx-3 my-1.5 border-t border-border-subtle" />

                        <div className="px-3 py-2 space-y-2" data-testid="scheduled-backup-section">
                            <div className="flex items-center justify-between gap-2">
                                <label
                                    htmlFor="scheduled-backup-enabled"
                                    className="text-xs text-text-primary font-medium"
                                >
                                    自动远端备份
                                </label>
                                <button
                                    id="scheduled-backup-enabled"
                                    type="button"
                                    role="switch"
                                    aria-checked={scheduledEnabledEffective}
                                    onClick={onScheduledEnabledToggle}
                                    disabled={scheduledLoading || (!webdavPasswordSaved && !scheduledConfig.enabled)}
                                    className={cn(
                                        "relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50",
                                        scheduledEnabledEffective
                                            ? "bg-blue-500"
                                            : "bg-gray-300 dark:bg-gray-600",
                                    )}
                                    data-testid="scheduled-backup-toggle"
                                >
                                    <span
                                        className={cn(
                                            "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform shadow-sm",
                                            scheduledEnabledEffective ? "translate-x-[18px]" : "translate-x-0.5",
                                        )}
                                    />
                                </button>
                            </div>

                            {!webdavPasswordSaved && (
                                <p
                                    className="text-[10px] text-amber-600 dark:text-amber-400 leading-tight"
                                    data-testid="scheduled-backup-credential-warning"
                                >
                                    请先保存 WebDAV 密码到系统凭据管理器，再启用自动远端备份。
                                </p>
                            )}

                            {disableScheduledByCredential && (
                                <p
                                    className="text-[10px] text-red-600 dark:text-red-400 leading-tight"
                                    data-testid="scheduled-backup-credential-disabled"
                                >
                                    自动备份已暂停：无法读取已保存的 WebDAV 密码，请重新保存密码后再启用。
                                </p>
                            )}

                            {scheduledEnabledEffective && (
                                <>
                                    <div className="flex items-center justify-between gap-2">
                                        <label
                                            htmlFor="scheduled-backup-frequency"
                                            className="text-xs text-text-secondary"
                                        >
                                            备份频率
                                        </label>
                                        <select
                                            id="scheduled-backup-frequency"
                                            value={scheduledConfig.frequency}
                                            onChange={(e) => onScheduledFrequencyChange(e.target.value as ScheduledRemoteBackupFrequency)}
                                            disabled={scheduledLoading}
                                            className="bg-secondary-bg/50 border border-border-subtle rounded px-1.5 py-1 text-xs text-text-primary outline-none focus:border-blue-400 disabled:opacity-50"
                                            data-testid="scheduled-backup-frequency"
                                        >
                                            <option value="every-6-hours">每 6 小时</option>
                                            <option value="every-12-hours">每 12 小时</option>
                                            <option value="daily">每天</option>
                                            <option value="weekly">每周</option>
                                        </select>
                                    </div>

                                    <label className="flex items-center justify-between gap-2 text-xs text-text-secondary cursor-pointer">
                                        <span>退出前提醒备份</span>
                                        <input
                                            type="checkbox"
                                            checked={scheduledConfig.exitPromptEnabled}
                                            onChange={onExitPromptToggle}
                                            disabled={scheduledLoading}
                                            className="rounded disabled:opacity-50"
                                            data-testid="scheduled-backup-exit-prompt"
                                        />
                                    </label>
                                    {exitHintVisible && (
                                        <p className="text-[10px] text-amber-600 dark:text-amber-400 leading-tight" data-testid="exit-backup-pending-hint">
                                            退出时将提示备份
                                        </p>
                                    )}
                                </>
                            )}

                            {(scheduledState.lastAutomaticSuccessAt != null || scheduledState.lastManualSuccessAt != null || scheduledState.lastFailureAt != null || scheduledState.nextRunAt != null) && (
                                <div
                                    className="rounded border border-border-subtle bg-secondary-bg/30 px-2 py-1.5 space-y-0.5 text-[11px] leading-4"
                                    data-testid="scheduled-backup-status"
                                >
                                    {scheduledState.lastAutomaticSuccessAt != null && (
                                        <p className="text-text-secondary">
                                            <Clock className="w-3 h-3 inline-block mr-1 align-text-bottom text-text-tertiary" />
                                            最近自动备份：{new Date(scheduledState.lastAutomaticSuccessAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                                            {scheduledState.lastRemoteFileName ? ` (${scheduledState.lastRemoteFileName})` : ''}
                                        </p>
                                    )}
                                    {scheduledState.lastManualSuccessAt != null && (
                                        <p className="text-text-secondary">
                                            <Clock className="w-3 h-3 inline-block mr-1 align-text-bottom text-text-tertiary" />
                                            最近手动备份：{new Date(scheduledState.lastManualSuccessAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                                        </p>
                                    )}
                                    {scheduledState.lastFailureAt != null && scheduledState.lastFailureReason && (
                                        scheduledState.lastFinishedAt == null || scheduledState.lastFailureAt >= scheduledState.lastFinishedAt
                                    ) && (
                                        <p className="text-red-500 dark:text-red-400">
                                            最近失败：{scheduledState.lastFailureReason}
                                        </p>
                                    )}
                                    {scheduledState.lastFinishedAt != null && scheduledState.lastTrigger && (
                                        scheduledState.lastFailureAt == null || scheduledState.lastFailureAt < scheduledState.lastFinishedAt
                                    ) && (
                                        <p className="text-text-tertiary">
                                            最近完成：{scheduledState.lastTrigger === 'manual' ? '手动触发' : scheduledState.lastTrigger === 'scheduled-interval' ? '定时触发' : scheduledState.lastTrigger === 'quiet-period' ? '静默期触发' : '退出前触发'}
                                            {' · '}
                                            {new Date(scheduledState.lastFinishedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                                        </p>
                                    )}
                                    {scheduledState.nextRunAt != null && scheduledEnabledEffective && (
                                        <p className="text-text-tertiary">
                                            下次尝试：{new Date(scheduledState.nextRunAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                                        </p>
                                    )}
                                </div>
                            )}

                            {!scheduledConfig.enabled && webdavPasswordSaved && !scheduledLoading && (
                                <p className="text-[10px] text-text-tertiary leading-tight" data-testid="scheduled-backup-disabled-hint">
                                    自动远端备份已关闭
                                </p>
                            )}
                        </div>

                        {webdavFeedback && (
                            <div
                                data-testid="webdav-feedback"
                                role={webdavFeedback.status === 'error' ? 'alert' : 'status'}
                                aria-live="polite"
                                className={cn(
                                    'mx-3 mt-2 rounded-md border px-3 py-2 text-xs leading-5',
                                    webdavFeedback.status === 'error'
                                        ? 'border-red-100 bg-red-50 text-red-600 dark:border-red-900/50 dark:bg-red-900/30 dark:text-red-400'
                                        : webdavFeedback.status === 'success'
                                            ? 'border-green-100 bg-green-50 text-green-700 dark:border-green-900/50 dark:bg-green-900/30 dark:text-green-400'
                                            : 'border-border-subtle bg-secondary-bg/70 text-text-secondary'
                                )}
                            >
                                <p className="font-medium whitespace-pre-line">{webdavFeedback.message}</p>
                            </div>
                        )}
                    </div>
                )}

                {settingsView === 'DIAGNOSTICS' && (
                    <div className="py-1">
                        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border-subtle mb-1">
                            <button
                                type="button"
                                onClick={() => setSettingsView('DATA')}
                                className="p-1 hover:bg-secondary-bg/50 dark:hover:bg-white/5 rounded text-text-secondary hover:text-text-primary transition-colors"
                            >
                                <ChevronLeft className="w-4 h-4" />
                            </button>
                            <span className="text-xs text-text-tertiary font-medium">性能诊断</span>
                        </div>
                        <DiagnosticsPanel />
                    </div>
                )}
            </div>
        )}

        {/* 3. Input Popover */}
        {isInputMode && (
          <div 
            className="mb-3 p-1.5 bg-secondary-bg rounded-xl shadow-xl border border-border-subtle flex items-center gap-1 animate-in slide-in-from-bottom-2 fade-in duration-200 origin-bottom"
            style={{ zIndex: Z_INDEX.MENU }}
          >
             <input
                ref={inputRef}
                type="text"
                                  placeholder="看板名称…"
                className="bg-transparent border-none outline-none text-sm px-2 py-1.5 w-32 text-text-secondary placeholder:text-text-tertiary font-medium"
                value={newBoardName}
                onChange={(e) => setNewBoardName(e.target.value)}
                onKeyDown={handleKeyDown}
             />
             <button 
               type="button"
               onClick={handleCreate} 
               className="p-1.5 hover:bg-secondary-bg/50 dark:hover:bg-white/5 rounded-lg text-text-secondary hover:text-text-primary transition-colors"
             >
                <Plus className="w-4 h-4" />
             </button>
          </div>
        )}

        {/* 4. The Main Dock (Pill) */}
        <div 
          className={cn(
            "flex items-center gap-1 p-1.5 rounded-full",
            "bg-secondary-bg", // 使用语义化背景色
            "border border-border-subtle", // 使用语义化边框
            "shadow-[0_8px_30px_rgb(0,0,0,0.12)]", // Slightly deeper shadow
            "animate-dock-slide-up" // Hand-written CSS animation
          )}
        >
          {boards.map((board) => {
            const isActive = currentBoardId === board.id;
            const isEditing = editingBoardId === board.id;
            const isReordering = reorderId === board.id;
            const activeNoteCount = getBoardActiveNoteCount(board.id);

            if (isEditing) {
                return (
                    <div 
                        key={board.id}
                        className="w-24 px-1 flex items-center justify-center"
                    >
                        <input
                            ref={editInputRef}
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onKeyDown={handleRenameKeyDown}
                            onBlur={handleRenameSave}
                            className="w-full bg-secondary-bg border-none outline-none text-xs px-2 py-1 rounded text-center text-text-primary font-medium shadow-inner"
                        />
                    </div>
                );
            }

            return (
              <button
                type="button"
                key={board.id}
                data-board-id={board.id}
                onClick={() => {
                  if (isReordering) {
                    setReorderId(null); // Click to confirm
                    return;
                  }
                  appController.switchBoard(board.id);
                  setContextMenuBoard(null);
                }}
                onDoubleClick={() => {
                    if (isReordering) return;
                    setEditingBoardId(board.id);
                    setEditName(board.name);
                }}
                 onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (isReordering) return;
                    if (board.id !== 'default') {
                        const anchor = resolveBoardMenuAnchor(e.currentTarget);
                        setContextMenuBoard({ id: board.id, name: board.name, ...anchor });
                    }
                 }}
                 aria-label={`${board.name}，${activeNoteCount} 个便签`}
                 className={cn(
                   "relative group flex items-center justify-center w-9 h-9 rounded-full transition-all duration-200",
                  isActive 
                    ? "bg-secondary-bg text-text-primary" // Active状态的语义化背景和文字
                    : "text-text-secondary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary", // Hover状态的语义化背景和文字
                  isReordering && "ring-2 ring-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 z-10 scale-110 animate-pulse"
                )}
              >
                {/* Custom Tooltip */}
                <div className={cn(
                    "absolute -top-10 left-1/2 -translate-x-1/2 px-2 py-1 bg-tertiary-bg text-text-primary text-xs rounded transition-opacity pointer-events-none whitespace-nowrap shadow-sm",
                    isReordering ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                )} style={{ zIndex: Z_INDEX.TOOLTIP }}>
                    {isReordering ? "⬅️ 移动 ➡️" : `${board.name} · ${activeNoteCount} 个便签`}
                    {/* Tiny triangle */}
<div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-tertiary-bg" />
            </div>
            {/* Active Indicator: Dot below the icon */}
            {isActive && (
              <div className="absolute -bottom-1 w-1 h-1 rounded-full bg-text-tertiary" />
            )}
            
            {/* Board Icon */}
            <span className={cn(
              "text-lg leading-none filter drop-shadow-sm transform group-hover:scale-110 transition-transform",
              activeNoteCount === 0 && !isActive && "opacity-55"
            )}>
              {board.icon}
            </span>
          </button>
            )
          })}

          {/* Vertical Divider */}
          <div className="w-px h-5 bg-border-subtle mx-1.5" />

          {/* Add Button */}
          <button
            type="button"
            onClick={() => setIsInputMode(!isInputMode)}
            className={cn(
                "relative group flex items-center justify-center w-9 h-9 rounded-full transition-all duration-200",
                isInputMode 
                  ? "bg-secondary-bg text-text-primary rotate-45" 
                  : "text-text-tertiary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary"
            )}
          >
            {/* Tooltip for Add */}
            {!isInputMode && (
             <div className="absolute -top-10 left-1/2 -translate-x-1/2 px-2 py-1 bg-tertiary-bg text-text-primary text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap shadow-sm" style={{ zIndex: Z_INDEX.TOOLTIP }}>
               新建看板
               <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-tertiary-bg" />
             </div>
            )}
            <Plus className="w-5 h-5" />
          </button>

          {/* Vertical Divider */}
          <div className="w-px h-5 bg-border-subtle mx-1.5" />

          {/* Trash Button */}
          <button
            type="button"
            onClick={() => {
              appController.toggleViewMode();
            }}
            className={cn(
              "relative group flex items-center justify-center w-9 h-9 rounded-full transition-all duration-200",
              viewMode === 'TRASH'
                ? "bg-secondary-bg text-text-primary"
                : "text-text-tertiary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary"
            )}
          >
            {/* Tooltip for Trash */}
             <div className="absolute -top-10 left-1/2 -translate-x-1/2 px-2 py-1 bg-tertiary-bg text-text-primary text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap shadow-sm" style={{ zIndex: Z_INDEX.TOOLTIP }}>
               废纸篓
               <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-tertiary-bg" />
             </div>
            <Trash2 className="w-5 h-5" />
          </button>

          {/* Vertical Divider */}
          <div className="w-px h-5 bg-border-subtle mx-1.5" />

          {/* Settings Button */}
          <button
            type="button"
            onClick={() => setShowSettings(!showSettings)}
            aria-label="打开设置"
            className={cn(
              "relative group flex items-center justify-center w-9 h-9 rounded-full transition-all duration-200",
              showSettings
                ? "bg-secondary-bg text-text-primary"
                : "text-text-tertiary hover:bg-secondary-bg/50 dark:hover:bg-white/5 hover:text-text-primary"
            )}
          >
            {/* Tooltip for Settings */}
            <div className="absolute -top-10 left-1/2 -translate-x-1/2 px-2 py-1 bg-tertiary-bg text-text-primary text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap shadow-sm" style={{ zIndex: Z_INDEX.TOOLTIP }}>
              设置
              <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-tertiary-bg" />
            </div>
            <Settings className="w-5 h-5" />
          </button>
        </div>
        </div>
      </div>
    </>
  );
};
