import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
}));

vi.mock('../store/db', () => ({
  db: {
    saveWAL: vi.fn(async () => undefined),
    loadWAL: vi.fn(async () => undefined),
    clearWAL: vi.fn(async () => undefined),
  },
}));

vi.mock('../utils/fileSystem', () => ({
  saveFile: vi.fn(async () => true),
  openFile: vi.fn(async () => null),
  saveZipDialog: vi.fn(async () => null),
  openZipDialog: vi.fn(async () => null),
}));

vi.mock('../services/storage/attachmentPersistence', () => ({
  listAttachmentFiles: vi.fn(async () => []),
  deleteAttachmentFile: vi.fn(async () => ({ deleted: true, relativePath: '' })),
  attachmentExists: vi.fn(async () => true),
  invalidateAttachmentPathCache: vi.fn(),
  resolveAttachmentAssetUrlCached: vi.fn(async (relativePath: string) => `asset://localhost/${relativePath}`),
}));

vi.mock('../services/storage/attachmentConsistency', () => ({
  detectMissingReferences: vi.fn(async () => []),
  detectOrphanAttachments: vi.fn(() => []),
}));

vi.mock('../services/backup/BackupService', () => ({
  createLocalBackup: vi.fn(async () => ({ success: true, noteCount: 0, boardCount: 0, attachmentCount: 0 })),
  restoreLocalBackup: vi.fn(async () => ({ success: true, noteCount: 0, boardCount: 0, attachmentCount: 0 })),
  validateLocalBackup: vi.fn(async () => ({
    ok: true,
    summary: {
      app: 'SoNotes',
      formatVersion: 1,
      appVersion: '1.5.2',
      createdAt: Date.now(),
      noteCount: 0,
      boardCount: 0,
      textNoteCount: 0,
      imageNoteCount: 0,
      trashNoteCount: 0,
      imageFileCount: 0,
      imageFileTotalBytes: 0,
    },
    errors: [],
    warnings: [],
  })),
}));

vi.mock('../services/backup/WebDavBackupService', () => ({
  loadConfig: vi.fn(async () => ({ success: false })),
  saveConfig: vi.fn(async () => ({ success: true })),
  clearConfig: vi.fn(async () => ({ success: true })),
  testConnection: vi.fn(async () => ({ success: true })),
  createRemoteBackup: vi.fn(async () => ({ success: true, remoteFileName: 'backup.zip', summary: null, zipSizeBytes: null })),
  listBackups: vi.fn(async () => []),
  deleteBackup: vi.fn(async () => ({ success: true })),
  downloadBackup: vi.fn(async () => ({ success: true, downloadToken: 'tok-1' })),
  resolveDownloadedBackup: vi.fn(async () => ({ success: true, localPath: '/tmp/downloaded.zip' })),
  cleanupDownloadedBackup: vi.fn(async () => ({ success: true })),
}));

vi.mock('../services/storage/PersistenceFacade', () => ({
  attach: vi.fn(),
  detach: vi.fn(),
  isAttached: vi.fn(() => false),
  flushNow: vi.fn(async () => true),
  pause: vi.fn(),
  resume: vi.fn(),
  isPaused: vi.fn(() => false),
  getStatus: vi.fn(() => 'idle'),
  resetForTests: vi.fn(),
}));

vi.mock('../services/storage/tauriPersistence', () => ({
  readDiskStorageData: vi.fn(async () => null),
  normalizeStorageDataMetadata: vi.fn((data) => data),
  getLatestUpdateTimestamp: vi.fn(() => 0),
}));

vi.mock('../store/confirmStore', () => ({
  confirm: vi.fn(async () => true),
}));

vi.mock('../services/backup/BackupJobCoordinator', () => {
  let activeJob: { kind: string; startedAt: number; release: () => void } | null = null;
  return {
    tryStartBackupJob: vi.fn((kind: string) => {
      if (activeJob) return null;
      const now = Date.now();
      const handle = {
        kind,
        startedAt: now,
        release: vi.fn(() => {
          if (activeJob && activeJob.kind === kind && activeJob.startedAt === now) {
            activeJob = null;
          }
        }),
      };
      activeJob = handle;
      return handle;
    }),
    _resetCoordinatorForTesting: vi.fn(() => { activeJob = null; }),
  };
});

const { DEFAULT_SCHEDULED_BACKUP_CONFIG, DEFAULT_SCHEDULED_BACKUP_STATE, mockScheduledConfigRef, mockScheduledStateRef } = vi.hoisted(() => {
  const config = {
    enabled: false,
    frequency: 'daily' as const,
    quietPeriodMinutes: 5,
    exitPromptEnabled: true,
    retentionEnabled: false,
    retentionCount: null as number | null,
  };
  const state = {
    lastStartedAt: null as number | null,
    lastFinishedAt: null as number | null,
    lastTrigger: null as 'manual' | 'scheduled-interval' | 'quiet-period' | 'before-exit' | null,
    lastAutomaticSuccessAt: null as number | null,
    lastManualSuccessAt: null as number | null,
    lastFailureAt: null as number | null,
    lastFailureReason: null as string | null,
    lastFailureStage: null as 'config' | 'credential' | 'single-flight' | 'restore-blocked' | 'flush' | 'create-zip' | 'upload' | 'list-refresh' | 'completed' | 'unknown' | null,
    lastRemoteFileName: null as string | null,
    nextRunAt: null as number | null,
    lastSuccessfulStorageUpdatedAt: null as number | null,
    lastAttemptCapturedStorageUpdatedAt: null as number | null,
    consecutiveCredentialFailures: 0,
    credentialActionRequired: false,
    cliffDropDetectedAt: null as number | null,
    baselineConfirmedRemoteCount: null as number | null,
    baselineConfirmedBoardCount: null as number | null,
    baselineConfirmedImageNoteCount: null as number | null,
    baselineConfirmedImageFileCount: null as number | null,
    baselineConfirmedImageFileTotalBytes: null as number | null,
    baselineConfirmedRemoteFileName: null as string | null,
    baselineConfirmedConfirmedAt: null as number | null,
    baselineConfirmedZipSizeBytes: null as number | null,
    cliffDropDeferred: false,
    cliffDropLatestSummaryNoteCount: null as number | null,
    cliffDropLatestSummaryBoardCount: null as number | null,
    cliffDropLatestSummaryImageNoteCount: null as number | null,
    cliffDropLatestSummaryImageFileCount: null as number | null,
    cliffDropLatestSummaryImageFileTotalBytes: null as number | null,
    cliffDropLatestRemoteFileName: null as string | null,
    cliffDropLatestZipSizeBytes: null as number | null,
    pendingCleanupTargetCount: null as number | null,
    lastRetentionCleanupDeletedCount: null as number | null,
    lastRetentionCleanupMissingCount: null as number | null,
    lastRetentionCleanupFailedFileName: null as string | null,
    lastRetentionCleanupError: null as string | null,
    lastRetentionCleanupSkipped: null as boolean | null,
    lastRetentionCleanupAt: null as number | null,
  };
  return {
    DEFAULT_SCHEDULED_BACKUP_CONFIG: config,
    DEFAULT_SCHEDULED_BACKUP_STATE: state,
    mockScheduledConfigRef: { current: { ...config } },
    mockScheduledStateRef: { current: { ...state } },
  };
});

const resetMockScheduled = () => {
  mockScheduledConfigRef.current = { ...DEFAULT_SCHEDULED_BACKUP_CONFIG };
  mockScheduledStateRef.current = { ...DEFAULT_SCHEDULED_BACKUP_STATE };
};

vi.mock('../services/backup/ScheduledRemoteBackupConfigService', () => ({
  DEFAULT_SCHEDULED_BACKUP_CONFIG,
  DEFAULT_SCHEDULED_BACKUP_STATE,
  loadConfig: vi.fn(async () => ({ success: true, config: mockScheduledConfigRef.current, error: null })),
  loadState: vi.fn(async () => ({ success: true, state: mockScheduledStateRef.current, error: null })),
  saveConfig: vi.fn(async () => ({ success: true, error: null })),
  saveState: vi.fn(async () => ({ success: true, error: null })),
  isValidFrequency: vi.fn((f: string) => ['every-6-hours', 'every-12-hours', 'daily', 'weekly'].includes(f)),
  redactStateBeforeSave: vi.fn((s) => s),
}));

import { BoardDock } from './BoardDock';
import { confirm } from '../store/confirmStore';
import { Z_INDEX } from '../constants/layout';
import { createEmptyNormalizedNotesState, normalizeNotes } from '../store/normalization';
import { useStore } from '../store/useStore';
import { _resetCoordinatorForTesting, tryStartBackupJob } from '../services/backup/BackupJobCoordinator';

/** 用本地时间格式化时间戳，与 BoardDock 摘要格式化逻辑一致，避免跨时区断言失败。 */
const formatLocalDate = (ts: number) => {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

describe('BoardDock v1.2.4 最小修复', () => {
  let container: HTMLDivElement;
  let root: Root;

  const clickElement = async (element: Element | null) => {
    expect(element).not.toBeNull();

    await act(async () => {
      element?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  };

  const findButtonByText = (text: string) => Array.from(container.querySelectorAll('button')).find(
    button => button.textContent?.includes(text),
  ) ?? null;

  const getSettingsButton = () => container.querySelector('button[aria-label="打开设置"]');
  const getImportFeedback = () => container.querySelector('[data-testid="board-import-feedback"]');
  const getSaveFeedback = () => container.querySelector('[data-testid="board-save-feedback"]');

  const renderBoardDock = async () => {
    await act(async () => {
      root.render(<BoardDock />);
    });
  };

  const openDataSettings = async () => {
    await renderBoardDock();
    await clickElement(getSettingsButton());
    await clickElement(findButtonByText('数据管理'));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetCoordinatorForTesting();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      boards: [
        { id: 'default', name: '主板', icon: '📌', createdAt: 0, viewport: { x: 0, y: 0 } },
        { id: 'board-2', name: '实验板', icon: '🧪', createdAt: 1, viewport: { x: 40, y: 60 } },
      ],
      currentBoardId: 'default',
      isDockVisible: true,
      viewMode: 'BOARD',
      config: { ...useStore.getState().config, themeMode: 'system' },
      saveStatus: 'idle',
      saveError: null,
      isSaving: false,
      lastSavedAt: null,
      switchBoard: vi.fn(),
      createBoard: vi.fn(),
      deleteBoard: vi.fn(),
      updateBoard: vi.fn(),
      reorderBoard: vi.fn(),
      setDockVisible: vi.fn(),
      setViewMode: vi.fn(),
      clearSelection: vi.fn(),
      exportAll: vi.fn(async () => undefined),
      importFromFile: vi.fn(async () => ({ status: 'cancelled' as const })),
      exportCurrentBoard: vi.fn(async () => undefined),
      setThemeMode: vi.fn(),
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('保持共享浮层层级合同顺序稳定', () => {
    expect(Z_INDEX.NOTE_DRAGGING).toBeLessThan(Z_INDEX.BOARD_BADGE);
    expect(Z_INDEX.BOARD_BADGE).toBeLessThan(Z_INDEX.PIN_FAB);
    expect(Z_INDEX.PIN_FAB).toBeLessThan(Z_INDEX.MINIMAP);
    expect(Z_INDEX.MINIMAP).toBeLessThan(Z_INDEX.DOCK_BACKDROP);
    expect(Z_INDEX.DOCK_BACKDROP).toBeLessThan(Z_INDEX.DOCK);
    expect(Z_INDEX.DOCK).toBeLessThan(Z_INDEX.TOOLTIP);
    expect(Z_INDEX.TOOLTIP).toBeLessThan(Z_INDEX.MENU);
    expect(Z_INDEX.MENU).toBeLessThan(Z_INDEX.SPOTLIGHT);
  });

  it('click-away backdrop 显式恢复 pointer-events，并继续关闭 dock', async () => {
    await renderBoardDock();

    const backdrop = container.querySelector('button[aria-label="关闭浮层"]') as HTMLButtonElement | null;

    expect(backdrop).not.toBeNull();
    expect(backdrop?.className).toContain('pointer-events-auto');

    await clickElement(backdrop);

    expect(useStore.getState().setDockVisible).toHaveBeenCalledWith(false);
  });

  it('右键看板时菜单锚点按容器内真实中心点定位', async () => {
    await renderBoardDock();

    const dockContainer = container.querySelector('.board-dock-container') as HTMLDivElement | null;
    const boardButton = container.querySelector('[data-board-id="board-2"]') as HTMLButtonElement | null;

    expect(dockContainer).not.toBeNull();
    expect(boardButton).not.toBeNull();

    Object.defineProperty(dockContainer!, 'offsetWidth', { configurable: true, value: 300 });
    dockContainer!.getBoundingClientRect = vi.fn(() => ({
      x: 40,
      y: 500,
      left: 40,
      top: 500,
      width: 300,
      height: 60,
      right: 340,
      bottom: 560,
      toJSON: () => ({}),
    } as DOMRect));

    Object.defineProperty(boardButton!, 'offsetLeft', { configurable: true, value: 120 });
    Object.defineProperty(boardButton!, 'offsetWidth', { configurable: true, value: 36 });
    Object.defineProperty(boardButton!, 'offsetTop', { configurable: true, value: 12 });
    boardButton!.getBoundingClientRect = vi.fn(() => ({
      x: 146,
      y: 514,
      left: 146,
      top: 514,
      width: 28,
      height: 36,
      right: 174,
      bottom: 550,
      toJSON: () => ({}),
    } as DOMRect));

    await act(async () => {
      boardButton?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });

    const menu = container.querySelector('.board-dock-context-menu') as HTMLDivElement | null;

    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain('实验板');
    expect(menu?.style.left).toBe('120px');
    expect(menu?.style.left).not.toBe('0px');
  });

  it('锚点计算不依赖 transform 后的屏幕坐标', async () => {
    await renderBoardDock();

    const dockContainer = container.querySelector('.board-dock-container') as HTMLDivElement | null;
    const boardButton = container.querySelector('[data-board-id="board-2"]') as HTMLButtonElement | null;

    expect(dockContainer).not.toBeNull();
    expect(boardButton).not.toBeNull();

    Object.defineProperty(dockContainer!, 'offsetWidth', { configurable: true, value: 400 });
    dockContainer!.getBoundingClientRect = vi.fn(() => ({
      x: 100,
      y: 420,
      left: 100,
      top: 420,
      width: 360,
      height: 72,
      right: 460,
      bottom: 492,
      toJSON: () => ({}),
    } as DOMRect));

    Object.defineProperty(boardButton!, 'offsetLeft', { configurable: true, value: 180 });
    Object.defineProperty(boardButton!, 'offsetWidth', { configurable: true, value: 40 });
    Object.defineProperty(boardButton!, 'offsetTop', { configurable: true, value: 8 });
    boardButton!.getBoundingClientRect = vi.fn(() => ({
      x: 262,
      y: 430,
      left: 262,
      top: 430,
      width: 36,
      height: 36,
      right: 298,
      bottom: 466,
      toJSON: () => ({}),
    } as DOMRect));

    await act(async () => {
      boardButton?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });

    const menu = container.querySelector('.board-dock-context-menu') as HTMLDivElement | null;

    expect(menu).not.toBeNull();
    expect(menu?.style.left).toBe('200px');
  });

  it('恢复成功后在数据管理区保留局部反馈', async () => {
    const importFromFile = vi.fn(async () => ({
      status: 'success' as const,
      message: '导入成功。',
      summary: {
        importedBoardsCount: 1,
        importedNotesCount: 3,
        skippedNotesCount: 0,
        migratedNotesCount: 0,
        renamedBoardsCount: 0,
        usedFallbackCurrentBoard: false,
        createdDefaultBoard: false,
        issues: [],
      },
    }));

    useStore.setState({ importFromFile });

    await openDataSettings();
    await clickElement(findButtonByText('导入 JSON'));

    const feedback = getImportFeedback();

    expect(importFromFile).toHaveBeenCalledTimes(1);
    expect(findButtonByText('导入 JSON')).not.toBeNull();
    expect(feedback?.textContent).toContain('导入成功。');
    expect(getSaveFeedback()?.textContent).toContain('等待保存');
  });

  it('保存中状态显示为保存中', async () => {
    useStore.setState({ saveStatus: 'saving', isSaving: true });

    await openDataSettings();

    expect(getSaveFeedback()?.textContent).toContain('保存中…');
  });

  it('保存失败状态显示失败文案与错误详情', async () => {
    useStore.setState({ saveStatus: 'error', isSaving: false, saveError: '磁盘权限不足' });

    await openDataSettings();

    expect(getSaveFeedback()?.textContent).toContain('保存失败');
    expect(getSaveFeedback()?.textContent).toContain('磁盘权限不足');
  });

  it('取消恢复时显示取消反馈', async () => {
    const importFromFile = vi.fn(async () => ({ status: 'cancelled' as const }));

    useStore.setState({ importFromFile });

    await openDataSettings();
    await clickElement(findButtonByText('导入 JSON'));

    expect(importFromFile).toHaveBeenCalledTimes(1);
    expect(getImportFeedback()?.textContent).toContain('已取消导入。');
  });

  it('恢复失败时显示错误反馈', async () => {
    const importFromFile = vi.fn(async () => ({
      status: 'error' as const,
      message: '导入失败：备份文件损坏。',
    }));

    useStore.setState({ importFromFile });

    await openDataSettings();
    await clickElement(findButtonByText('导入 JSON'));

    expect(importFromFile).toHaveBeenCalledTimes(1);
    expect(getImportFeedback()?.textContent).toContain('导入失败：备份文件损坏。');
  });

  it('写入失败回滚时额外提示已回滚', async () => {
    const importFromFile = vi.fn(async () => ({
      status: 'error' as const,
      message: '导入失败：写入本地存储时出错，已回滚到导入前状态。',
      rolledBack: true,
      summary: {
        importedBoardsCount: 2,
        importedNotesCount: 5,
        skippedNotesCount: 1,
        migratedNotesCount: 0,
        renamedBoardsCount: 0,
        usedFallbackCurrentBoard: false,
        createdDefaultBoard: false,
        issues: [],
      },
    }));

    useStore.setState({ importFromFile });

    await openDataSettings();
    await clickElement(findButtonByText('导入 JSON'));

    expect(importFromFile).toHaveBeenCalledTimes(1);
    expect(getImportFeedback()?.textContent).toContain('已回滚到导入前状态，当前数据未被改动。');
    expect(getImportFeedback()?.textContent).not.toContain('导入 2 个看板');
  });

  it('存在摘要时显示导入计数', async () => {
    const importFromFile = vi.fn(async () => ({
      status: 'success' as const,
      message: '导入完成，已跳过 2 条异常便签。',
      summary: {
        importedBoardsCount: 2,
        importedNotesCount: 5,
        skippedNotesCount: 2,
        migratedNotesCount: 0,
        renamedBoardsCount: 0,
        usedFallbackCurrentBoard: false,
        createdDefaultBoard: false,
        issues: [
          { code: 'INVALID_NOTE' as const, severity: 'error' as const, message: 'bad note', noteIndex: 1 },
          { code: 'ORPHAN_NOTE' as const, severity: 'error' as const, message: 'orphan note', noteIndex: 2 },
        ],
      },
    }));

    useStore.setState({ importFromFile });

    await openDataSettings();
    await clickElement(findButtonByText('导入 JSON'));

    expect(importFromFile).toHaveBeenCalledTimes(1);
    expect(getImportFeedback()?.textContent).toContain('导入 2 个看板 · 5 条便签 · 跳过 2 条异常便签');
  });

  it('存在迁移与回退摘要时显示额外说明', async () => {
    const importFromFile = vi.fn(async () => ({
      status: 'success' as const,
      message: '已导入旧版备份，并按当前规则完成兼容处理。',
      summary: {
        importedBoardsCount: 1,
        importedNotesCount: 1,
        skippedNotesCount: 0,
        migratedNotesCount: 1,
        renamedBoardsCount: 1,
        usedFallbackCurrentBoard: true,
        createdDefaultBoard: true,
        issues: [],
      },
    }));

    useStore.setState({ importFromFile });

    await openDataSettings();
    await clickElement(findButtonByText('导入 JSON'));

    expect(importFromFile).toHaveBeenCalledTimes(1);
    expect(getImportFeedback()?.textContent).toContain('已自动补建默认看板。');
    expect(getImportFeedback()?.textContent).toContain('已兼容迁移 1 条旧版便签。');
    expect(getImportFeedback()?.textContent).toContain('有 1 个同名看板已按规则重命名。');
    expect(getImportFeedback()?.textContent).toContain('导入主板无效，已回退到首个可用看板。');
  });

  it('关闭设置面板后重新打开数据管理时不会残留旧导入反馈', async () => {
    const importFromFile = vi.fn(async () => ({
      status: 'success' as const,
      message: '导入成功。',
      summary: {
        importedBoardsCount: 1,
        importedNotesCount: 1,
        skippedNotesCount: 0,
        migratedNotesCount: 0,
        renamedBoardsCount: 0,
        usedFallbackCurrentBoard: false,
        createdDefaultBoard: false,
        issues: [],
      },
    }));

    useStore.setState({ importFromFile });

    await openDataSettings();
    await clickElement(findButtonByText('导入 JSON'));
    expect(getImportFeedback()?.textContent).toContain('导入成功。');

    await clickElement(getSettingsButton());
    expect(getImportFeedback()).toBeNull();

    await clickElement(getSettingsButton());
    await clickElement(findButtonByText('数据管理'));
    expect(getImportFeedback()).toBeNull();
  });

  it('展示看板活跃便签计数并在删除确认中排除已删除便签', async () => {
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'active-note',
          kind: 'text',
          boardId: 'board-2',
          x: 0,
          y: 0,
          title: '',
          content: '活跃便签',
          color: '#FFFFFF',
          z: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'deleted-note',
          kind: 'text',
          boardId: 'board-2',
          x: 0,
          y: 0,
          title: '',
          content: '已删除便签',
          color: '#FFFFFF',
          z: 2,
          createdAt: 2,
          updatedAt: 2,
          deletedAt: 3,
        },
      ]),
    });

    await renderBoardDock();

    const boardButton = container.querySelector('[data-board-id="board-2"]') as HTMLButtonElement | null;
    expect(boardButton?.getAttribute('aria-label')).toBe('实验板，1 个便签');
    expect(boardButton?.textContent).toContain('1 个便签');

    await act(async () => {
      boardButton?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });

    await clickElement(findButtonByText('删除看板'));

    expect(container.textContent).toContain('确认删除看板及 1 个便签？');
  });

  it('viewMode=TRASH 且 isDockVisible=false 时不渲染 Dock', async () => {
    useStore.setState({ viewMode: 'TRASH', isDockVisible: false });

    await renderBoardDock();

    expect(container.querySelector('.board-dock-container')).toBeNull();
    expect(container.querySelector('[data-board-id="default"]')).toBeNull();
    expect(container.textContent).not.toContain('主板');
  });

  it('zip 备份按钮在数据管理区可见', async () => {
    await openDataSettings();
    const backupButton = container.querySelector('[data-testid="zip-backup-button"]');
    expect(backupButton).not.toBeNull();
    expect(backupButton?.textContent).toContain('创建本地 zip 备份');
  });

  it('zip 恢复按钮在数据管理区可见', async () => {
    await openDataSettings();
    const restoreButton = container.querySelector('[data-testid="zip-restore-button"]');
    expect(restoreButton).not.toBeNull();
    expect(restoreButton?.textContent).toContain('从 zip 覆盖恢复');
  });

  it('zip 备份成功后显示成功反馈', async () => {
    const { saveZipDialog } = await import('../utils/fileSystem');
    const { createLocalBackup } = await import('../services/backup/BackupService');

    vi.mocked(saveZipDialog).mockResolvedValue('/backups/test.zip');
    vi.mocked(createLocalBackup).mockResolvedValue({
      success: true, backupPath: '/backups/test.zip', noteCount: 5, boardCount: 2, attachmentCount: 3, summary: null, zipSizeBytes: null,
    });

    await openDataSettings();
    await clickElement(findButtonByText('创建本地 zip 备份'));

    expect(saveZipDialog).toHaveBeenCalledTimes(1);
    expect(createLocalBackup).toHaveBeenCalledWith('/backups/test.zip');
    const feedback = container.querySelector('[data-testid="zip-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.textContent).toContain('备份成功');
    expect(feedback?.textContent).toContain('5 条便签');
    expect(feedback?.getAttribute('role')).toBe('status');
  });

  it('zip 备份取消对话框时不执行备份', async () => {
    const { saveZipDialog } = await import('../utils/fileSystem');
    const { createLocalBackup } = await import('../services/backup/BackupService');

    vi.mocked(saveZipDialog).mockResolvedValue(null);

    await openDataSettings();
    await clickElement(findButtonByText('创建本地 zip 备份'));

    expect(saveZipDialog).toHaveBeenCalledTimes(1);
    expect(createLocalBackup).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="zip-feedback"]')).toBeNull();
  });

  it('zip 备份失败时显示错误反馈', async () => {
    const { saveZipDialog } = await import('../utils/fileSystem');
    const { createLocalBackup } = await import('../services/backup/BackupService');

    vi.mocked(saveZipDialog).mockResolvedValue('/backups/test.zip');
    vi.mocked(createLocalBackup).mockResolvedValue({
      success: false, noteCount: 0, boardCount: 0, attachmentCount: 0, error: '磁盘空间不足', summary: null, zipSizeBytes: null,
    });

    await openDataSettings();
    await clickElement(findButtonByText('创建本地 zip 备份'));

    const feedback = container.querySelector('[data-testid="zip-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.textContent).toContain('磁盘空间不足');
    expect(feedback?.getAttribute('role')).toBe('alert');
  });

  it('zip 恢复成功后替换前端状态并清空历史', async () => {
    const { openZipDialog } = await import('../utils/fileSystem');
    const { restoreLocalBackup, validateLocalBackup } = await import('../services/backup/BackupService');
    const { readDiskStorageData } = await import('../services/storage/tauriPersistence');
    const { invalidateAttachmentPathCache, resolveAttachmentAssetUrlCached } = await import('../services/storage/attachmentPersistence');
    const { flushNow, pause, resume } = await import('../services/storage/PersistenceFacade');

    vi.mocked(openZipDialog).mockResolvedValue('/backups/test.zip');
    vi.mocked(validateLocalBackup).mockResolvedValue({
      ok: true,
      summary: {
        app: 'SoNotes',
        formatVersion: 1,
        appVersion: '1.5.2',
        createdAt: Date.now(),
        noteCount: 3,
        boardCount: 1,
        textNoteCount: 2,
        imageNoteCount: 1,
        trashNoteCount: 0,
        imageFileCount: 2,
        imageFileTotalBytes: 2048,
      },
      errors: [],
      warnings: [],
    });
    vi.mocked(restoreLocalBackup).mockResolvedValue({
      success: true, noteCount: 3, boardCount: 1, attachmentCount: 2,
    });
    vi.mocked(readDiskStorageData).mockResolvedValue({
      schemaVersion: 1,
      storageUpdatedAt: Date.now(),
      notes: [
        { id: 'restored-1', kind: 'text', boardId: 'default', x: 0, y: 0, title: '', content: '恢复便签', color: '#FFF', z: 1, collapsed: false, createdAt: 1, updatedAt: 1 },
        {
          id: 'restored-image',
          kind: 'image',
          boardId: 'default',
          x: 20,
          y: 30,
          title: '',
          content: '',
          color: '#FFF',
          z: 2,
          collapsed: false,
          createdAt: 1,
          updatedAt: 1,
          attachments: [{ id: 'att-restored', hash: 'a'.repeat(64), filename: 'photo.png', relativePath: 'attachments/photo.png', mimeType: 'image/png', size: 123, createdAt: 1 }],
        },
      ],
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0, viewport: { x: 0, y: 0 } }],
      currentBoardId: 'default',
      config: { ...useStore.getState().config },
    });

    vi.mocked(confirm).mockResolvedValue(true);

    useStore.getState().addNote(0, 0);
    expect(useStore.getState().domainHistory.undoStack.length).toBeGreaterThan(0);

    await openDataSettings();
    await clickElement(findButtonByText('从 zip 覆盖恢复'));

    expect(openZipDialog).toHaveBeenCalledTimes(1);
    expect(flushNow).toHaveBeenCalled();
    expect(pause).toHaveBeenCalled();
    expect(restoreLocalBackup).toHaveBeenCalledWith('/backups/test.zip');
    expect(resume).toHaveBeenCalled();

    const feedback = container.querySelector('[data-testid="zip-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.textContent).toContain('恢复成功');
    expect(feedback?.textContent).toContain('3 条便签');
    expect(feedback?.getAttribute('role')).toBe('status');

    const state = useStore.getState();
    expect(state.notesById['restored-1']).toBeDefined();
    expect(state.notesById['restored-1'].content).toBe('恢复便签');
    expect(state.notesById['restored-image']).toBeDefined();
    expect(state.domainHistory.undoStack).toHaveLength(0);
    expect(invalidateAttachmentPathCache).toHaveBeenCalled();
    expect(resolveAttachmentAssetUrlCached).toHaveBeenCalledWith('attachments/photo.png');
  });

  it('zip 恢复取消确认时不执行恢复', async () => {
    const { openZipDialog } = await import('../utils/fileSystem');
    const { restoreLocalBackup, validateLocalBackup } = await import('../services/backup/BackupService');
    const { pause } = await import('../services/storage/PersistenceFacade');

    vi.mocked(openZipDialog).mockResolvedValue('/backups/test.zip');
    vi.mocked(validateLocalBackup).mockResolvedValue({
      ok: true,
      summary: {
        app: 'SoNotes',
        formatVersion: 1,
        appVersion: '1.5.2',
        createdAt: Date.now(),
        noteCount: 5,
        boardCount: 2,
        textNoteCount: 4,
        imageNoteCount: 1,
        trashNoteCount: 0,
        imageFileCount: 1,
        imageFileTotalBytes: 1024,
      },
      errors: [],
      warnings: [],
    });
    vi.mocked(confirm).mockResolvedValue(false);

    await openDataSettings();
    await clickElement(findButtonByText('从 zip 覆盖恢复'));

    expect(openZipDialog).toHaveBeenCalledTimes(1);
    expect(validateLocalBackup).toHaveBeenCalledWith('/backups/test.zip');
    expect(restoreLocalBackup).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });

  it('zip 恢复对话框取消时不执行恢复', async () => {
    const { openZipDialog } = await import('../utils/fileSystem');
    const { restoreLocalBackup } = await import('../services/backup/BackupService');

    vi.mocked(openZipDialog).mockResolvedValue(null);

    await openDataSettings();
    await clickElement(findButtonByText('从 zip 覆盖恢复'));

    expect(openZipDialog).toHaveBeenCalledTimes(1);
    expect(restoreLocalBackup).not.toHaveBeenCalled();
  });

  it('zip 恢复失败时显示错误反馈并恢复持久化', async () => {
    const { openZipDialog } = await import('../utils/fileSystem');
    const { restoreLocalBackup, validateLocalBackup } = await import('../services/backup/BackupService');
    const { pause, resume } = await import('../services/storage/PersistenceFacade');

    vi.mocked(openZipDialog).mockResolvedValue('/backups/bad.zip');
    vi.mocked(validateLocalBackup).mockResolvedValue({
      ok: true,
      summary: {
        app: 'SoNotes',
        formatVersion: 1,
        appVersion: '1.5.2',
        createdAt: Date.now(),
        noteCount: 1,
        boardCount: 1,
        textNoteCount: 1,
        imageNoteCount: 0,
        trashNoteCount: 0,
        imageFileCount: 0,
        imageFileTotalBytes: 0,
      },
      errors: [],
      warnings: [],
    });
    vi.mocked(restoreLocalBackup).mockResolvedValue({
      success: false, noteCount: 0, boardCount: 0, attachmentCount: 0, error: 'zip 文件损坏',
    });
    vi.mocked(confirm).mockResolvedValue(true);

    await openDataSettings();
    await clickElement(findButtonByText('从 zip 覆盖恢复'));

    expect(pause).toHaveBeenCalled();
    expect(resume).toHaveBeenCalled();

    const feedback = container.querySelector('[data-testid="zip-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.textContent).toContain('zip 文件损坏');
    expect(feedback?.getAttribute('role')).toBe('alert');
  });

  it('关闭设置面板后不残留 zip 反馈', async () => {
    const { saveZipDialog } = await import('../utils/fileSystem');
    const { createLocalBackup } = await import('../services/backup/BackupService');

    vi.mocked(saveZipDialog).mockResolvedValue('/backups/test.zip');
    vi.mocked(createLocalBackup).mockResolvedValue({
      success: true, noteCount: 1, boardCount: 1, attachmentCount: 0, summary: null, zipSizeBytes: null,
    });

    await openDataSettings();
    await clickElement(findButtonByText('创建本地 zip 备份'));
    expect(container.querySelector('[data-testid="zip-feedback"]')).not.toBeNull();

    await clickElement(getSettingsButton());
    expect(container.querySelector('[data-testid="zip-feedback"]')).toBeNull();
  });

  it('viewMode=TRASH 时 zip 备份仍可正常执行（persistence facade 可用）', async () => {
    const { saveZipDialog } = await import('../utils/fileSystem');
    const { createLocalBackup } = await import('../services/backup/BackupService');
    const { flushNow } = await import('../services/storage/PersistenceFacade');

    vi.mocked(saveZipDialog).mockResolvedValue('/backups/trash-test.zip');
    vi.mocked(createLocalBackup).mockResolvedValue({
      success: true, backupPath: '/backups/trash-test.zip', noteCount: 3, boardCount: 1, attachmentCount: 1, summary: null, zipSizeBytes: null,
    });
    vi.mocked(flushNow).mockResolvedValue(true);

    useStore.setState({ viewMode: 'TRASH', isDockVisible: true });

    await openDataSettings();
    await clickElement(findButtonByText('创建本地 zip 备份'));

    expect(flushNow).toHaveBeenCalledTimes(1);
    expect(saveZipDialog).toHaveBeenCalledTimes(1);
    expect(createLocalBackup).toHaveBeenCalledWith('/backups/trash-test.zip');
    const feedback = container.querySelector('[data-testid="zip-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.textContent).toContain('备份成功');
    expect(feedback?.textContent).toContain('3 条便签');
    expect(feedback?.getAttribute('role')).toBe('status');
  });

  it('viewMode=TRASH 时 zip 恢复仍可正常执行（persistence facade 可用）', async () => {
    const { openZipDialog } = await import('../utils/fileSystem');
    const { restoreLocalBackup, validateLocalBackup } = await import('../services/backup/BackupService');
    const { readDiskStorageData } = await import('../services/storage/tauriPersistence');
    const { flushNow, pause, resume } = await import('../services/storage/PersistenceFacade');

    vi.mocked(openZipDialog).mockResolvedValue('/backups/trash-restore.zip');
    vi.mocked(validateLocalBackup).mockResolvedValue({
      ok: true,
      summary: {
        app: 'SoNotes',
        formatVersion: 1,
        appVersion: '1.5.2',
        createdAt: Date.now(),
        noteCount: 2,
        boardCount: 1,
        textNoteCount: 2,
        imageNoteCount: 0,
        trashNoteCount: 0,
        imageFileCount: 0,
        imageFileTotalBytes: 0,
      },
      errors: [],
      warnings: [],
    });
    vi.mocked(restoreLocalBackup).mockResolvedValue({
      success: true, noteCount: 2, boardCount: 1, attachmentCount: 0,
    });
    vi.mocked(readDiskStorageData).mockResolvedValue({
      schemaVersion: 1,
      storageUpdatedAt: Date.now(),
      notes: [
        { id: 'restored-in-trash', kind: 'text', boardId: 'default', x: 0, y: 0, title: '', content: '恢复便签', color: '#FFF', z: 1, collapsed: false, createdAt: 1, updatedAt: 1 },
      ],
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0, viewport: { x: 0, y: 0 } }],
      currentBoardId: 'default',
      config: { ...useStore.getState().config },
    });
    vi.mocked(flushNow).mockResolvedValue(true);
    vi.mocked(confirm).mockResolvedValue(true);

    useStore.setState({ viewMode: 'TRASH', isDockVisible: true });

    await openDataSettings();
    await clickElement(findButtonByText('从 zip 覆盖恢复'));

    expect(flushNow).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalled();
    expect(restoreLocalBackup).toHaveBeenCalledWith('/backups/trash-restore.zip');
    expect(resume).toHaveBeenCalled();

    const feedback = container.querySelector('[data-testid="zip-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.textContent).toContain('恢复成功');
    expect(feedback?.getAttribute('role')).toBe('status');
  });

  it('zip 恢复验证失败时不调用 flush/pause/restore', async () => {
    const { openZipDialog } = await import('../utils/fileSystem');
    const { restoreLocalBackup, validateLocalBackup } = await import('../services/backup/BackupService');
    const { flushNow, pause } = await import('../services/storage/PersistenceFacade');

    vi.mocked(openZipDialog).mockResolvedValue('/backups/bad.zip');
    vi.mocked(validateLocalBackup).mockResolvedValue({
      ok: false,
      summary: null,
      errors: [{ code: 'not_sonotes_backup', severity: 'error', message: '这不是 SoNotes 备份包，本地数据未受影响。' }],
      warnings: [],
    });

    await openDataSettings();
    await clickElement(findButtonByText('从 zip 覆盖恢复'));

    expect(validateLocalBackup).toHaveBeenCalledWith('/backups/bad.zip');
    expect(restoreLocalBackup).not.toHaveBeenCalled();
    expect(flushNow).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();

    const feedback = container.querySelector('[data-testid="zip-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.textContent).toContain('备份验证失败');
    expect(feedback?.textContent).toContain('这不是 SoNotes 备份包');
    expect(feedback?.getAttribute('role')).toBe('alert');
  });

  it('zip 恢复验证失败时使用 fallback 文案（errors 无 message）', async () => {
    const { openZipDialog } = await import('../utils/fileSystem');
    const { validateLocalBackup } = await import('../services/backup/BackupService');

    vi.mocked(openZipDialog).mockResolvedValue('/backups/unknown.zip');
    vi.mocked(validateLocalBackup).mockResolvedValue({
      ok: false,
      summary: null,
      errors: [{ code: 'unreadable_backup_file', severity: 'error', message: '' }],
      warnings: [],
    });

    await openDataSettings();
    await clickElement(findButtonByText('从 zip 覆盖恢复'));

    const feedback = container.querySelector('[data-testid="zip-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.textContent).toContain('备份验证失败');
    expect(feedback?.textContent).toContain('本地数据未受影响');
    expect(feedback?.getAttribute('role')).toBe('alert');
  });

  it('zip 恢复验证失败（多条错误）时展示错误数量与所有错误信息', async () => {
    const { openZipDialog } = await import('../utils/fileSystem');
    const { restoreLocalBackup, validateLocalBackup } = await import('../services/backup/BackupService');
    const { flushNow, pause } = await import('../services/storage/PersistenceFacade');

    vi.mocked(openZipDialog).mockResolvedValue('/backups/multi-error.zip');
    vi.mocked(validateLocalBackup).mockResolvedValue({
      ok: false,
      summary: null,
      errors: [
        { code: 'not_sonotes_backup', severity: 'error', message: '缺少 manifest.json' },
        { code: 'unreadable_backup_file', severity: 'error', message: 'data.json 已损坏' },
        { code: 'schema_too_new', severity: 'error', message: '' },
      ],
      warnings: [],
    });

    await openDataSettings();
    await clickElement(findButtonByText('从 zip 覆盖恢复'));

    expect(restoreLocalBackup).not.toHaveBeenCalled();
    expect(flushNow).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();

    const feedback = container.querySelector('[data-testid="zip-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.getAttribute('role')).toBe('alert');
    expect(feedback?.textContent).toContain('备份验证失败');
    expect(feedback?.textContent).toContain('3 条错误');
    expect(feedback?.textContent).toContain('1. 缺少 manifest.json');
    expect(feedback?.textContent).toContain('2. data.json 已损坏');
    expect(feedback?.textContent).toContain('3.');
    expect(feedback?.textContent).toContain('本地数据未受影响');
  });

  it('zip 恢复验证成功但用户取消摘要确认时不调用 flush/pause/restore', async () => {
    const { openZipDialog } = await import('../utils/fileSystem');
    const { restoreLocalBackup, validateLocalBackup } = await import('../services/backup/BackupService');
    const { flushNow, pause } = await import('../services/storage/PersistenceFacade');

    vi.mocked(openZipDialog).mockResolvedValue('/backups/test.zip');
    vi.mocked(validateLocalBackup).mockResolvedValue({
      ok: true,
      summary: {
        app: 'SoNotes',
        formatVersion: 1,
        appVersion: '1.5.2',
        createdAt: Date.now(),
        noteCount: 42,
        boardCount: 3,
        textNoteCount: 36,
        imageNoteCount: 6,
        trashNoteCount: 2,
        imageFileCount: 6,
        imageFileTotalBytes: 5 * 1024 * 1024,
      },
      errors: [],
      warnings: [],
    });
    vi.mocked(confirm).mockResolvedValue(false);

    await openDataSettings();
    await clickElement(findButtonByText('从 zip 覆盖恢复'));

    expect(validateLocalBackup).toHaveBeenCalledWith('/backups/test.zip');
    expect(restoreLocalBackup).not.toHaveBeenCalled();
    expect(flushNow).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });

  it('zip 恢复验证成功且用户确认后执行完整恢复流程', async () => {
    const { openZipDialog } = await import('../utils/fileSystem');
    const { restoreLocalBackup, validateLocalBackup } = await import('../services/backup/BackupService');
    const { readDiskStorageData } = await import('../services/storage/tauriPersistence');
    const { flushNow, pause, resume } = await import('../services/storage/PersistenceFacade');

    vi.mocked(openZipDialog).mockResolvedValue('/backups/full.zip');
    vi.mocked(validateLocalBackup).mockResolvedValue({
      ok: true,
      summary: {
        app: 'SoNotes',
        formatVersion: 1,
        appVersion: '1.5.2',
        createdAt: 1749643200000,
        noteCount: 10,
        boardCount: 2,
        textNoteCount: 8,
        imageNoteCount: 2,
        trashNoteCount: 1,
        imageFileCount: 2,
        imageFileTotalBytes: 4096,
      },
      errors: [],
      warnings: [],
    });
    vi.mocked(restoreLocalBackup).mockResolvedValue({
      success: true, noteCount: 10, boardCount: 2, attachmentCount: 2,
    });
    vi.mocked(readDiskStorageData).mockResolvedValue({
      schemaVersion: 1,
      storageUpdatedAt: Date.now(),
      notes: [
        { id: 'r1', kind: 'text', boardId: 'default', x: 0, y: 0, title: '', content: '恢复便签', color: '#FFF', z: 1, collapsed: false, createdAt: 1, updatedAt: 1 },
      ],
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0, viewport: { x: 0, y: 0 } }],
      currentBoardId: 'default',
      config: { ...useStore.getState().config },
    });
    vi.mocked(flushNow).mockResolvedValue(true);
    vi.mocked(pause).mockImplementation(() => {});
    vi.mocked(confirm).mockResolvedValue(true);

    await openDataSettings();
    await clickElement(findButtonByText('从 zip 覆盖恢复'));

    expect(validateLocalBackup).toHaveBeenCalledWith('/backups/full.zip');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(vi.mocked(confirm).mock.calls[0][0].message).toContain('2 个看板');
    expect(vi.mocked(confirm).mock.calls[0][0].message).toContain('9 条便签');
    expect(vi.mocked(confirm).mock.calls[0][0].message).toContain('2 个图片文件');
    expect(vi.mocked(confirm).mock.calls[0][0].message).toContain(formatLocalDate(1749643200000));
    expect(vi.mocked(confirm).mock.calls[0][0].message).toContain('应用版本：1.5.2');
    expect(vi.mocked(confirm).mock.calls[0][0].message).toContain('格式版本：1');
    expect(flushNow).toHaveBeenCalled();
    expect(pause).toHaveBeenCalled();
    expect(restoreLocalBackup).toHaveBeenCalledWith('/backups/full.zip');
    expect(resume).toHaveBeenCalled();

    const feedback = container.querySelector('[data-testid="zip-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.textContent).toContain('恢复成功');
    expect(feedback?.getAttribute('role')).toBe('status');
  });
});

describe('BoardDock 图片文件一致性管理入口', () => {
  let container: HTMLDivElement;
  let root: Root;

  const clickElement = async (element: Element | null) => {
    expect(element).not.toBeNull();
    await act(async () => {
      element?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  };

  const findButtonByText = (text: string) => Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent?.includes(text),
  ) ?? null;

  const getSettingsButton = () => container.querySelector('button[aria-label="打开设置"]');

  const renderBoardDock = async () => {
    await act(async () => {
      root.render(<BoardDock />);
    });
  };

  const openDataSettings = async () => {
    await renderBoardDock();
    await clickElement(getSettingsButton());
    await clickElement(findButtonByText('数据管理'));
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetCoordinatorForTesting();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      boards: [
        { id: 'default', name: '主板', icon: '📌', createdAt: 0, viewport: { x: 0, y: 0 } },
      ],
      currentBoardId: 'default',
      isDockVisible: true,
      viewMode: 'BOARD',
      config: { ...useStore.getState().config, themeMode: 'system' },
      saveStatus: 'idle',
      saveError: null,
      isSaving: false,
      lastSavedAt: null,
      switchBoard: vi.fn(),
      createBoard: vi.fn(),
      deleteBoard: vi.fn(),
      updateBoard: vi.fn(),
      reorderBoard: vi.fn(),
      setDockVisible: vi.fn(),
      setViewMode: vi.fn(),
      clearSelection: vi.fn(),
      exportAll: vi.fn(async () => undefined),
      importFromFile: vi.fn(async () => ({ status: 'cancelled' as const })),
      exportCurrentBoard: vi.fn(async () => undefined),
      setThemeMode: vi.fn(),
    });

    const { listAttachmentFiles } = await import('../services/storage/attachmentPersistence');
    const { detectMissingReferences, detectOrphanAttachments } = await import('../services/storage/attachmentConsistency');
    vi.mocked(listAttachmentFiles).mockResolvedValue([]);
    vi.mocked(detectMissingReferences).mockResolvedValue([]);
    vi.mocked(detectOrphanAttachments).mockReturnValue([]);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('扫描按钮在数据管理区可见', async () => {
    await openDataSettings();
    const scanButton = container.querySelector('[data-testid="attachment-scan-button"]');
    expect(scanButton).not.toBeNull();
    expect(scanButton?.textContent).toContain('检查图片文件一致性');
  });

  it('扫描后显示缺失图片和孤儿图片计数', async () => {
    const { listAttachmentFiles } = await import('../services/storage/attachmentPersistence');
    const { detectMissingReferences, detectOrphanAttachments } = await import('../services/storage/attachmentConsistency');

    vi.mocked(listAttachmentFiles).mockResolvedValue([
      'attachments/aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aaa111aa.png',
      'attachments/orphan222orphan222orphan222orphan222orphan222orphan222orphan222orphan222o.png',
    ]);
    vi.mocked(detectMissingReferences).mockResolvedValue([
      { noteId: 'n1', ref: { id: 'r1', hash: 'h1', filename: 'f.png', mimeType: 'image/png', size: 100, relativePath: 'attachments/missing.png', createdAt: 1 } },
    ]);
    vi.mocked(detectOrphanAttachments).mockReturnValue([
      { relativePath: 'attachments/orphan222orphan222orphan222orphan222orphan222orphan222orphan222orphan222o.png', hash: undefined },
    ]);

    await openDataSettings();
    await clickElement(findButtonByText('检查图片文件一致性'));

    const result = container.querySelector('[data-testid="attachment-scan-result"]');
    expect(result).not.toBeNull();
    expect(result?.textContent).toContain('缺失图片 1');
    expect(result?.textContent).toContain('孤儿图片 1');
  });

  it('孤儿数为 0 时不显示清理按钮', async () => {
    const { listAttachmentFiles } = await import('../services/storage/attachmentPersistence');
    const { detectMissingReferences, detectOrphanAttachments } = await import('../services/storage/attachmentConsistency');

    vi.mocked(listAttachmentFiles).mockResolvedValue(['attachments/a.png']);
    vi.mocked(detectMissingReferences).mockResolvedValue([]);
    vi.mocked(detectOrphanAttachments).mockReturnValue([]);

    await openDataSettings();
    await clickElement(findButtonByText('检查图片文件一致性'));

    const cleanupButton = container.querySelector('[data-testid="orphan-cleanup-button"]');
    expect(cleanupButton).toBeNull();
  });

  it('孤儿数大于 0 时显示清理按钮', async () => {
    const { listAttachmentFiles } = await import('../services/storage/attachmentPersistence');
    const { detectMissingReferences, detectOrphanAttachments } = await import('../services/storage/attachmentConsistency');

    vi.mocked(listAttachmentFiles).mockResolvedValue(['attachments/orphan.png']);
    vi.mocked(detectMissingReferences).mockResolvedValue([]);
    vi.mocked(detectOrphanAttachments).mockReturnValue([
      { relativePath: 'attachments/orphan.png', hash: undefined },
    ]);

    await openDataSettings();
    await clickElement(findButtonByText('检查图片文件一致性'));

    const cleanupButton = container.querySelector('[data-testid="orphan-cleanup-button"]');
    expect(cleanupButton).not.toBeNull();
    expect(cleanupButton?.textContent).toContain('清理孤儿图片');
  });

  it('确认清理后删除孤儿文件并清空历史', async () => {
    const { listAttachmentFiles, deleteAttachmentFile } = await import('../services/storage/attachmentPersistence');
    const { detectMissingReferences, detectOrphanAttachments } = await import('../services/storage/attachmentConsistency');

    const orphanPath = 'attachments/orphan.png';
    vi.mocked(listAttachmentFiles).mockResolvedValue([orphanPath]);
    vi.mocked(detectMissingReferences).mockResolvedValue([]);
    vi.mocked(detectOrphanAttachments).mockReturnValue([
      { relativePath: orphanPath, hash: undefined },
    ]);
    vi.mocked(deleteAttachmentFile).mockResolvedValue({ deleted: true, relativePath: orphanPath });

    vi.setSystemTime(new Date('2026-06-06T10:00:00.000Z'));
    useStore.getState().addNote(0, 0);
    expect(useStore.getState().domainHistory.undoStack.length).toBeGreaterThan(0);

    vi.mocked(confirm).mockResolvedValue(true);

    await openDataSettings();
    await clickElement(findButtonByText('检查图片文件一致性'));

    const cleanupButton = container.querySelector('[data-testid="orphan-cleanup-button"]');
    await clickElement(cleanupButton);

    expect(deleteAttachmentFile).toHaveBeenCalledWith(orphanPath);
    expect(useStore.getState().domainHistory.undoStack).toHaveLength(0);
    expect(useStore.getState().domainHistory.redoStack).toHaveLength(0);
  });

  it('取消确认时不删除文件', async () => {
    const { listAttachmentFiles, deleteAttachmentFile } = await import('../services/storage/attachmentPersistence');
    const { detectMissingReferences, detectOrphanAttachments } = await import('../services/storage/attachmentConsistency');

    vi.mocked(listAttachmentFiles).mockResolvedValue(['attachments/orphan.png']);
    vi.mocked(detectMissingReferences).mockResolvedValue([]);
    vi.mocked(detectOrphanAttachments).mockReturnValue([
      { relativePath: 'attachments/orphan.png', hash: undefined },
    ]);

    vi.mocked(confirm).mockResolvedValue(false);

    await openDataSettings();
    await clickElement(findButtonByText('检查图片文件一致性'));

    const cleanupButton = container.querySelector('[data-testid="orphan-cleanup-button"]');
    await clickElement(cleanupButton);

    expect(deleteAttachmentFile).not.toHaveBeenCalled();
  });

  it('Trash 中便签引用的附件不被判定为孤儿', async () => {
    const { listAttachmentFiles } = await import('../services/storage/attachmentPersistence');
    const { detectMissingReferences, detectOrphanAttachments } = await import('../services/storage/attachmentConsistency');

    const trashRefPath = 'attachments/trash-note-attachment.png';
    vi.mocked(listAttachmentFiles).mockResolvedValue([trashRefPath]);
    vi.mocked(detectMissingReferences).mockResolvedValue([]);
    // detectOrphanAttachments 内部基于 notes 判断，此处模拟无孤儿
    vi.mocked(detectOrphanAttachments).mockReturnValue([]);

    // 将 Trash 便签注入 store
    useStore.setState({
      ...normalizeNotes([
        {
          id: 'trash-note',
          kind: 'text',
          boardId: 'default',
          x: 0,
          y: 0,
          title: '',
          content: '废纸篓便签',
          color: '#FFFFFF',
          z: 1,
          createdAt: 1,
          updatedAt: 1,
          deletedAt: 2,
          attachments: [{
            id: 'att-trash',
            hash: 'trashhash',
            filename: 'trash-note-attachment.png',
            mimeType: 'image/png',
            size: 200,
            relativePath: trashRefPath,
            createdAt: 1,
          }],
        },
      ]),
    });

    await openDataSettings();
    await clickElement(findButtonByText('检查图片文件一致性'));

    const result = container.querySelector('[data-testid="attachment-scan-result"]');
    expect(result).not.toBeNull();
    expect(result?.textContent).toContain('孤儿图片 0');
  });

  it('扫描出错时显示错误信息', async () => {
    const { listAttachmentFiles } = await import('../services/storage/attachmentPersistence');
    vi.mocked(listAttachmentFiles).mockRejectedValue(new Error('磁盘读取失败'));

    await openDataSettings();
    await clickElement(findButtonByText('检查图片文件一致性'));

    const errorEl = container.querySelector('[data-testid="attachment-scan-error"]');
    expect(errorEl).not.toBeNull();
    expect(errorEl?.textContent).toContain('磁盘读取失败');
  });
});

describe('BoardDock WebDAV 远端备份/恢复', () => {
  let container: HTMLDivElement;
  let root: Root;

  const clickElement = async (element: Element | null) => {
    expect(element).not.toBeNull();
    await act(async () => {
      element?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  };

  const findButtonByText = (text: string) => Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent?.includes(text),
  ) ?? null;

  const getSettingsButton = () => container.querySelector('button[aria-label="打开设置"]');

  const renderBoardDock = async () => {
    await act(async () => {
      root.render(<BoardDock />);
    });
  };

  const openDataSettings = async () => {
    await renderBoardDock();
    await clickElement(getSettingsButton());
    await clickElement(findButtonByText('数据管理'));
  };

  const openWebdavView = async () => {
    await openDataSettings();
    await clickElement(findButtonByText('远端备份/恢复'));
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetCoordinatorForTesting();
    resetMockScheduled();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      boards: [
        { id: 'default', name: '主板', icon: '📌', createdAt: 0, viewport: { x: 0, y: 0 } },
      ],
      currentBoardId: 'default',
      isDockVisible: true,
      viewMode: 'BOARD',
      config: { ...useStore.getState().config, themeMode: 'system' },
      saveStatus: 'idle',
      saveError: null,
      isSaving: false,
      lastSavedAt: null,
      switchBoard: vi.fn(),
      createBoard: vi.fn(),
      deleteBoard: vi.fn(),
      updateBoard: vi.fn(),
      reorderBoard: vi.fn(),
      setDockVisible: vi.fn(),
      setViewMode: vi.fn(),
      clearSelection: vi.fn(),
      exportAll: vi.fn(async () => undefined),
      importFromFile: vi.fn(async () => ({ status: 'cancelled' as const })),
      exportCurrentBoard: vi.fn(async () => undefined),
      setThemeMode: vi.fn(),
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('数据管理区显示远端备份/恢复入口按钮', async () => {
    await openDataSettings();
    const entry = container.querySelector('[data-testid="webdav-entry-button"]');
    expect(entry).not.toBeNull();
    expect(entry?.textContent).toContain('远端备份/恢复');
  });

  it('点击入口后进入 WEBDAV 视图并显示配置输入框', async () => {
    await openWebdavView();
    expect(container.querySelector('[data-testid="webdav-server-url"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="webdav-username"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="webdav-password"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="webdav-remote-dir"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="webdav-save-config"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="webdav-test-connection"]')).not.toBeNull();
  });

  it('加载配置失败时显示错误反馈', async () => {
    const { loadConfig } = await import('../services/backup/WebDavBackupService');
    vi.mocked(loadConfig).mockRejectedValue(new Error('配置文件损坏'));

    await openWebdavView();

    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback?.textContent).toContain('加载配置失败：配置文件损坏');
  });

  it('保存配置调用 saveConfig 服务', async () => {
    const { saveConfig } = await import('../services/backup/WebDavBackupService');
    const { loadConfig } = await import('../services/backup/WebDavBackupService');
    vi.mocked(loadConfig).mockResolvedValue({ success: false, passwordSaved: false });
    vi.mocked(saveConfig).mockResolvedValue({ success: true });

    await openWebdavView();

    const serverInput = container.querySelector('[data-testid="webdav-server-url"]') as HTMLInputElement;
    const usernameInput = container.querySelector('[data-testid="webdav-username"]') as HTMLInputElement;

    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      nativeSetter.call(serverInput, 'https://dav.example.com');
      serverInput.dispatchEvent(new Event('input', { bubbles: true }));
      nativeSetter.call(usernameInput, 'user1');
      usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await clickElement(findButtonByText('保存配置'));

    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: 'https://dav.example.com',
        username: 'user1',
      }),
    );
    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback?.textContent).toContain('配置已保存');
  });

  it('测试连接调用 testConnection 服务', async () => {
    const { testConnection, loadConfig } = await import('../services/backup/WebDavBackupService');
    vi.mocked(loadConfig).mockResolvedValue({ success: true, passwordSaved: true });
    vi.mocked(testConnection).mockResolvedValue({ success: true });

    await openWebdavView();

    const serverInput = container.querySelector('[data-testid="webdav-server-url"]') as HTMLInputElement;
    const usernameInput = container.querySelector('[data-testid="webdav-username"]') as HTMLInputElement;

    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      nativeSetter.call(serverInput, 'https://dav.example.com');
      serverInput.dispatchEvent(new Event('input', { bubbles: true }));
      nativeSetter.call(usernameInput, 'user1');
      usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await clickElement(findButtonByText('测试连接'));

    expect(testConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: 'https://dav.example.com',
        username: 'user1',
      }),
    );
    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback?.textContent).toContain('连接测试成功');
  });

  it('创建远端备份先调用 flushNow 再调用 createRemoteBackup', async () => {
    const { createRemoteBackup, loadConfig, listBackups } = await import('../services/backup/WebDavBackupService');
    const { flushNow } = await import('../services/storage/PersistenceFacade');
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(createRemoteBackup).mockResolvedValue({ success: true, remoteFileName: 'backup-2026.zip', summary: null, zipSizeBytes: null });
    vi.mocked(listBackups).mockResolvedValue([]);
    vi.mocked(flushNow).mockResolvedValue(true);

    await openWebdavView();
    await clickElement(findButtonByText('创建远端备份'));

    expect(flushNow).toHaveBeenCalled();
    expect(createRemoteBackup).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: 'https://dav.example.com', username: 'user1' }),
    );
    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback?.textContent).toContain('远端备份已创建');
  });

  it('手动远端备份成功后使用 runner 捕获的 flush 后时间戳更新最近成功快照', async () => {
    const { createRemoteBackup, loadConfig, listBackups } = await import('../services/backup/WebDavBackupService');
    const { flushNow } = await import('../services/storage/PersistenceFacade');
    const { readDiskStorageData, getLatestUpdateTimestamp } = await import('../services/storage/tauriPersistence');
    const { saveState } = await import('../services/backup/ScheduledRemoteBackupConfigService');
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(createRemoteBackup).mockResolvedValue({ success: true, remoteFileName: 'backup-2026.zip', summary: null, zipSizeBytes: null });
    vi.mocked(listBackups).mockResolvedValue([]);
    vi.mocked(flushNow).mockResolvedValue(true);
    vi.mocked(readDiskStorageData).mockResolvedValue({
      boards: {}, notes: {}, trashedNotes: {}, storageUpdatedAt: 1000,
    } as never);
    vi.mocked(getLatestUpdateTimestamp).mockReturnValue(1000);

    await openWebdavView();
    await clickElement(findButtonByText('创建远端备份'));

    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        lastStartedAt: expect.any(Number),
        lastTrigger: 'manual',
        lastManualSuccessAt: expect.any(Number),
        lastSuccessfulStorageUpdatedAt: 1000,
        lastAttemptCapturedStorageUpdatedAt: 1000,
        lastRemoteFileName: 'backup-2026.zip',
        lastFailureAt: null,
        lastFailureReason: null,
        lastFailureStage: null,
      }),
    );
  });

  it('flushNow 失败时不调用 createRemoteBackup', async () => {
    const { createRemoteBackup, loadConfig } = await import('../services/backup/WebDavBackupService');
    const { flushNow } = await import('../services/storage/PersistenceFacade');
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(flushNow).mockResolvedValue(false);

    await openWebdavView();
    await clickElement(findButtonByText('创建远端备份'));

    expect(flushNow).toHaveBeenCalled();
    expect(createRemoteBackup).not.toHaveBeenCalled();
    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback?.textContent).toContain('当前数据尚未成功写入磁盘');
  });

  it('创建远端备份收到字符串异常时显示具体错误', async () => {
    const { createRemoteBackup, loadConfig } = await import('../services/backup/WebDavBackupService');
    const { flushNow } = await import('../services/storage/PersistenceFacade');
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(flushNow).mockResolvedValue(true);
    vi.mocked(createRemoteBackup).mockRejectedValue('远端备份上传失败，本地数据未受影响');

    await openWebdavView();
    await clickElement(findButtonByText('创建远端备份'));

    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback?.textContent).toContain('远端备份上传失败，本地数据未受影响');
    expect(feedback?.textContent).not.toContain('未知错误');
  });

  it('刷新远端列表后渲染备份文件信息', async () => {
    const { loadConfig, listBackups } = await import('../services/backup/WebDavBackupService');
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(listBackups).mockResolvedValue([
      { fileName: 'backup-2026.zip', size: 102400, lastModified: '2026-06-08T10:00:00Z', readable: true },
    ]);

    await openWebdavView();
    await clickElement(findButtonByText('刷新远端列表'));

    const list = container.querySelector('[data-testid="webdav-backup-list"]');
    expect(list).not.toBeNull();
    expect(list?.textContent).toContain('backup-2026.zip');
    expect(list?.textContent).toContain('100.0 KB');
    expect(list?.textContent).toContain('2026-06-08');
    expect(list?.textContent).not.toContain('GMT');
    expect(list?.textContent).not.toContain('2026-06-08T10:00:00Z');
  });

  it('删除远端备份取消确认时不调用删除服务', async () => {
    const { loadConfig, listBackups, deleteBackup } = await import('../services/backup/WebDavBackupService');
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(listBackups).mockResolvedValue([
      { fileName: 'SoNotes_Backup_20260609151929.zip', size: 102400, lastModified: 'Tue, 09 Jun 2026 07:19:29 GMT', readable: true },
    ]);
    vi.mocked(confirm).mockResolvedValue(false);

    await openWebdavView();
    await clickElement(findButtonByText('刷新远端列表'));
    await clickElement(container.querySelector('[data-testid="webdav-delete-button"]'));

    expect(deleteBackup).not.toHaveBeenCalled();
  });

  it('删除远端备份成功后刷新列表', async () => {
    const { loadConfig, listBackups, deleteBackup } = await import('../services/backup/WebDavBackupService');
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(listBackups)
      .mockResolvedValueOnce([
        { fileName: 'SoNotes_Backup_20260609151929.zip', size: 102400, lastModified: 'Tue, 09 Jun 2026 07:19:29 GMT', readable: true },
      ])
      .mockResolvedValueOnce([]);
    vi.mocked(deleteBackup).mockResolvedValue({ success: true });
    vi.mocked(confirm).mockResolvedValue(true);

    await openWebdavView();
    await clickElement(findButtonByText('刷新远端列表'));
    await clickElement(container.querySelector('[data-testid="webdav-delete-button"]'));

    expect(deleteBackup).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: 'https://dav.example.com', username: 'user1' }),
      'SoNotes_Backup_20260609151929.zip',
    );
    expect(listBackups).toHaveBeenCalledTimes(2);
    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback?.textContent).toContain('远端备份已删除');
  });

  it('远端恢复取消确认时不调用任何服务', async () => {
    const { loadConfig, listBackups, downloadBackup } = await import('../services/backup/WebDavBackupService');
    const { restoreLocalBackup } = await import('../services/backup/BackupService');
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(listBackups).mockResolvedValue([
      { fileName: 'backup-2026.zip', size: 102400, lastModified: '2026-06-08T10:00:00Z', readable: true },
    ]);
    vi.mocked(confirm).mockResolvedValue(false);

    await openWebdavView();
    await clickElement(findButtonByText('刷新远端列表'));

    const restoreBtn = container.querySelector('[data-testid="webdav-restore-button"]');
    await clickElement(restoreBtn);

    expect(downloadBackup).not.toHaveBeenCalled();
    expect(restoreLocalBackup).not.toHaveBeenCalled();
  });

  it('远端恢复初始确认不含覆盖/不可撤销措辞', async () => {
    const { loadConfig, listBackups } = await import('../services/backup/WebDavBackupService');
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(listBackups).mockResolvedValue([
      { fileName: 'backup-2026.zip', size: 102400, lastModified: '2026-06-08T10:00:00Z', readable: true },
    ]);
    vi.mocked(confirm).mockResolvedValue(false);

    await openWebdavView();
    await clickElement(findButtonByText('刷新远端列表'));

    const restoreBtn = container.querySelector('[data-testid="webdav-restore-button"]');
    await clickElement(restoreBtn);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(vi.mocked(confirm).mock.calls[0][0].message).not.toContain('覆盖');
    expect(vi.mocked(confirm).mock.calls[0][0].message).not.toContain('不可撤销');
    expect(vi.mocked(confirm).mock.calls[0][0].message).toContain('下载并验证');
  });

  it('远端恢复成功后调用完整流程并更新反馈', async () => {
    const { loadConfig, listBackups, downloadBackup, resolveDownloadedBackup, cleanupDownloadedBackup } = await import('../services/backup/WebDavBackupService');
    const { restoreLocalBackup, validateLocalBackup } = await import('../services/backup/BackupService');
    const { readDiskStorageData } = await import('../services/storage/tauriPersistence');
    const { resolveAttachmentAssetUrlCached } = await import('../services/storage/attachmentPersistence');
    const { flushNow, pause, resume } = await import('../services/storage/PersistenceFacade');

    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(listBackups).mockResolvedValue([
      { fileName: 'backup-2026.zip', size: 102400, lastModified: '2026-06-08T10:00:00Z', readable: true },
    ]);
    vi.mocked(downloadBackup).mockResolvedValue({ success: true, downloadToken: 'tok-abc' });
    vi.mocked(resolveDownloadedBackup).mockResolvedValue({ success: true, localPath: '/tmp/dl.zip' });
    vi.mocked(validateLocalBackup).mockResolvedValue({
      ok: true,
      summary: {
        app: 'SoNotes', formatVersion: 1, appVersion: '1.5.2', createdAt: 1749643200000,
        noteCount: 5, boardCount: 2, textNoteCount: 4, imageNoteCount: 1, trashNoteCount: 0,
        imageFileCount: 1, imageFileTotalBytes: 456,
      },
      errors: [], warnings: [],
    });
    vi.mocked(restoreLocalBackup).mockResolvedValue({
      success: true, noteCount: 5, boardCount: 2, attachmentCount: 1,
    });
    vi.mocked(readDiskStorageData).mockResolvedValue({
      schemaVersion: 1,
      storageUpdatedAt: Date.now(),
      notes: [
        { id: 'r1', kind: 'text', boardId: 'default', x: 0, y: 0, title: '', content: '恢复便签', color: '#FFF', z: 1, collapsed: false, createdAt: 1, updatedAt: 1 },
        {
          id: 'r-image',
          kind: 'image',
          boardId: 'default',
          x: 12,
          y: 24,
          title: '',
          content: '',
          color: '#FFF',
          z: 2,
          collapsed: false,
          createdAt: 1,
          updatedAt: 1,
          attachments: [{ id: 'att-remote', hash: 'b'.repeat(64), filename: 'remote.png', relativePath: 'attachments/remote.png', mimeType: 'image/png', size: 456, createdAt: 1 }],
        },
      ],
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0, viewport: { x: 0, y: 0 } }],
      currentBoardId: 'default',
      config: { ...useStore.getState().config },
    });
    vi.mocked(flushNow).mockResolvedValue(true);
    vi.mocked(confirm).mockResolvedValue(true);

    await openWebdavView();
    await clickElement(findButtonByText('刷新远端列表'));

    const restoreBtn = container.querySelector('[data-testid="webdav-restore-button"]');
    await clickElement(restoreBtn);

    expect(downloadBackup).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: 'https://dav.example.com' }),
      'backup-2026.zip',
    );
    expect(resolveDownloadedBackup).toHaveBeenCalledWith('tok-abc');
    expect(validateLocalBackup).toHaveBeenCalledWith('/tmp/dl.zip');
    expect(flushNow).toHaveBeenCalled();
    expect(pause).toHaveBeenCalled();
    expect(restoreLocalBackup).toHaveBeenCalledWith('/tmp/dl.zip');
    expect(cleanupDownloadedBackup).toHaveBeenCalledWith('tok-abc');
    expect(resume).toHaveBeenCalled();

    expect(vi.mocked(confirm).mock.calls[0][0].message).not.toContain('覆盖');
    expect(vi.mocked(confirm).mock.calls[0][0].message).not.toContain('不可撤销');
    expect(vi.mocked(confirm).mock.calls[0][0].message).toContain('下载并验证');
    expect(vi.mocked(confirm).mock.calls[1][0].message).toContain(formatLocalDate(1749643200000));
    expect(vi.mocked(confirm).mock.calls[1][0].message).toContain('应用版本：1.5.2');
    expect(vi.mocked(confirm).mock.calls[1][0].message).toContain('格式版本：1');
    expect(vi.mocked(confirm).mock.calls[1][0].message).toContain('5 条便签');

    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.textContent).toContain('远端恢复成功');
    expect(feedback?.textContent).toContain('5 条便签');

    const state = useStore.getState();
    expect(state.notesById['r1']).toBeDefined();
    expect(state.notesById['r1'].content).toBe('恢复便签');
    expect(state.notesById['r-image']).toBeDefined();
    expect(resolveAttachmentAssetUrlCached).toHaveBeenCalledWith('attachments/remote.png');
  });

  it('远端恢复验证失败时 cleanup token 并显示错误', async () => {
    const { loadConfig, listBackups, downloadBackup, resolveDownloadedBackup, cleanupDownloadedBackup } = await import('../services/backup/WebDavBackupService');
    const { restoreLocalBackup, validateLocalBackup } = await import('../services/backup/BackupService');
    const { flushNow, pause } = await import('../services/storage/PersistenceFacade');

    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(listBackups).mockResolvedValue([
      { fileName: 'bad-backup.zip', size: 1024, lastModified: '2026-06-08T10:00:00Z', readable: true },
    ]);
    vi.mocked(downloadBackup).mockResolvedValue({ success: true, downloadToken: 'tok-bad' });
    vi.mocked(resolveDownloadedBackup).mockResolvedValue({ success: true, localPath: '/tmp/bad.zip' });
    vi.mocked(validateLocalBackup).mockResolvedValue({
      ok: false,
      summary: null,
      errors: [{ code: 'not_sonotes_backup', severity: 'error', message: '这不是 SoNotes 备份包，本地数据未受影响。' }],
      warnings: [],
    });
    vi.mocked(confirm).mockResolvedValue(true);

    await openWebdavView();
    await clickElement(findButtonByText('刷新远端列表'));

    const restoreBtn = container.querySelector('[data-testid="webdav-restore-button"]');
    await clickElement(restoreBtn);

    expect(validateLocalBackup).toHaveBeenCalledWith('/tmp/bad.zip');
    expect(restoreLocalBackup).not.toHaveBeenCalled();
    expect(flushNow).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(cleanupDownloadedBackup).toHaveBeenCalledWith('tok-bad');

    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.textContent).toContain('备份验证失败');
    expect(feedback?.textContent).toContain('这不是 SoNotes 备份包');
    expect(feedback?.getAttribute('role')).toBe('alert');
  });

  it('远端恢复验证失败（多条错误）时展示错误数量与所有错误信息', async () => {
    const { loadConfig, listBackups, downloadBackup, resolveDownloadedBackup, cleanupDownloadedBackup } = await import('../services/backup/WebDavBackupService');
    const { restoreLocalBackup, validateLocalBackup } = await import('../services/backup/BackupService');
    const { flushNow, pause } = await import('../services/storage/PersistenceFacade');

    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(listBackups).mockResolvedValue([
      { fileName: 'multi-error.zip', size: 2048, lastModified: '2026-06-08T10:00:00Z', readable: true },
    ]);
    vi.mocked(downloadBackup).mockResolvedValue({ success: true, downloadToken: 'tok-multi' });
    vi.mocked(resolveDownloadedBackup).mockResolvedValue({ success: true, localPath: '/tmp/multi-error.zip' });
    vi.mocked(validateLocalBackup).mockResolvedValue({
      ok: false,
      summary: null,
      errors: [
        { code: 'not_sonotes_backup', severity: 'error', message: '缺少 manifest.json' },
        { code: 'unreadable_backup_file', severity: 'error', message: 'data.json 已损坏' },
      ],
      warnings: [],
    });
    vi.mocked(confirm).mockResolvedValue(true);

    await openWebdavView();
    await clickElement(findButtonByText('刷新远端列表'));

    const restoreBtn = container.querySelector('[data-testid="webdav-restore-button"]');
    await clickElement(restoreBtn);

    expect(validateLocalBackup).toHaveBeenCalledWith('/tmp/multi-error.zip');
    expect(restoreLocalBackup).not.toHaveBeenCalled();
    expect(flushNow).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(cleanupDownloadedBackup).toHaveBeenCalledWith('tok-multi');

    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.getAttribute('role')).toBe('alert');
    expect(feedback?.textContent).toContain('备份验证失败');
    expect(feedback?.textContent).toContain('2 条错误');
    expect(feedback?.textContent).toContain('1. 缺少 manifest.json');
    expect(feedback?.textContent).toContain('2. data.json 已损坏');
  });

  it('远端恢复摘要确认取消时 cleanup token 且不调用恢复', async () => {
    const { loadConfig, listBackups, downloadBackup, resolveDownloadedBackup, cleanupDownloadedBackup } = await import('../services/backup/WebDavBackupService');
    const { restoreLocalBackup, validateLocalBackup } = await import('../services/backup/BackupService');
    const { flushNow, pause } = await import('../services/storage/PersistenceFacade');

    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(listBackups).mockResolvedValue([
      { fileName: 'good-backup.zip', size: 2048, lastModified: '2026-06-08T10:00:00Z', readable: true },
    ]);
    vi.mocked(downloadBackup).mockResolvedValue({ success: true, downloadToken: 'tok-cancel' });
    vi.mocked(resolveDownloadedBackup).mockResolvedValue({ success: true, localPath: '/tmp/good.zip' });
    vi.mocked(validateLocalBackup).mockResolvedValue({
      ok: true,
      summary: {
        app: 'SoNotes', formatVersion: 1, appVersion: '1.5.2', createdAt: 1749643200000,
        noteCount: 10, boardCount: 2, textNoteCount: 8, imageNoteCount: 2, trashNoteCount: 0,
        imageFileCount: 2, imageFileTotalBytes: 4096,
      },
      errors: [], warnings: [],
    });
    vi.mocked(confirm)
      .mockResolvedValueOnce(true)  // 初始确认
      .mockResolvedValueOnce(false); // 摘要确认取消

    await openWebdavView();
    await clickElement(findButtonByText('刷新远端列表'));

    const restoreBtn = container.querySelector('[data-testid="webdav-restore-button"]');
    await clickElement(restoreBtn);

    expect(validateLocalBackup).toHaveBeenCalledWith('/tmp/good.zip');
    expect(restoreLocalBackup).not.toHaveBeenCalled();
    expect(flushNow).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(cleanupDownloadedBackup).toHaveBeenCalledWith('tok-cancel');
    expect(vi.mocked(confirm).mock.calls[0][0].message).not.toContain('覆盖');
    expect(vi.mocked(confirm).mock.calls[0][0].message).not.toContain('不可撤销');
    expect(vi.mocked(confirm).mock.calls[1][0].message).toContain(formatLocalDate(1749643200000));
    expect(vi.mocked(confirm).mock.calls[1][0].message).toContain('应用版本：1.5.2');
    expect(vi.mocked(confirm).mock.calls[1][0].message).toContain('格式版本：1');
  });

  it('远端恢复 restoreLocalBackup 失败时 cleanup token 并恢复持久化', async () => {
    const { loadConfig, listBackups, downloadBackup, resolveDownloadedBackup, cleanupDownloadedBackup } = await import('../services/backup/WebDavBackupService');
    const { restoreLocalBackup, validateLocalBackup } = await import('../services/backup/BackupService');
    const { flushNow, pause, resume } = await import('../services/storage/PersistenceFacade');

    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(listBackups).mockResolvedValue([
      { fileName: 'corrupt.zip', size: 2048, lastModified: '2026-06-08T10:00:00Z', readable: true },
    ]);
    vi.mocked(downloadBackup).mockResolvedValue({ success: true, downloadToken: 'tok-fail' });
    vi.mocked(resolveDownloadedBackup).mockResolvedValue({ success: true, localPath: '/tmp/corrupt.zip' });
    vi.mocked(validateLocalBackup).mockResolvedValue({
      ok: true,
      summary: {
        app: 'SoNotes', formatVersion: 1, appVersion: '1.5.2', createdAt: Date.now(),
        noteCount: 3, boardCount: 1, textNoteCount: 3, imageNoteCount: 0, trashNoteCount: 0,
        imageFileCount: 0, imageFileTotalBytes: 0,
      },
      errors: [], warnings: [],
    });
    vi.mocked(restoreLocalBackup).mockResolvedValue({
      success: false, noteCount: 0, boardCount: 0, attachmentCount: 0, error: 'zip 文件损坏',
    });
    vi.mocked(flushNow).mockResolvedValue(true);
    vi.mocked(confirm).mockResolvedValue(true);

    await openWebdavView();
    await clickElement(findButtonByText('刷新远端列表'));

    const restoreBtn = container.querySelector('[data-testid="webdav-restore-button"]');
    await clickElement(restoreBtn);

    expect(validateLocalBackup).toHaveBeenCalledWith('/tmp/corrupt.zip');
    expect(restoreLocalBackup).toHaveBeenCalledWith('/tmp/corrupt.zip');
    expect(pause).toHaveBeenCalled();
    expect(resume).toHaveBeenCalled();
    expect(cleanupDownloadedBackup).toHaveBeenCalledWith('tok-fail');

    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.textContent).toContain('zip 文件损坏');
    expect(feedback?.getAttribute('role')).toBe('alert');
  });

  it('远端恢复 validateLocalBackup 抛异常时 cleanup token', async () => {
    const { loadConfig, listBackups, downloadBackup, resolveDownloadedBackup, cleanupDownloadedBackup } = await import('../services/backup/WebDavBackupService');
    const { validateLocalBackup } = await import('../services/backup/BackupService');
    const { flushNow, pause } = await import('../services/storage/PersistenceFacade');

    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(listBackups).mockResolvedValue([
      { fileName: 'io-error.zip', size: 2048, lastModified: '2026-06-08T10:00:00Z', readable: true },
    ]);
    vi.mocked(downloadBackup).mockResolvedValue({ success: true, downloadToken: 'tok-throw' });
    vi.mocked(resolveDownloadedBackup).mockResolvedValue({ success: true, localPath: '/tmp/io-error.zip' });
    vi.mocked(validateLocalBackup).mockRejectedValue(new Error('I/O 错误'));
    vi.mocked(confirm).mockResolvedValue(true);

    await openWebdavView();
    await clickElement(findButtonByText('刷新远端列表'));

    const restoreBtn = container.querySelector('[data-testid="webdav-restore-button"]');
    await clickElement(restoreBtn);

    expect(validateLocalBackup).toHaveBeenCalledWith('/tmp/io-error.zip');
    expect(flushNow).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(cleanupDownloadedBackup).toHaveBeenCalledWith('tok-throw');

    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.textContent).toContain('I/O 错误');
    expect(feedback?.getAttribute('role')).toBe('alert');
  });

  it('远端恢复 flushNow 失败时 cleanup token 且不调用恢复', async () => {
    const { loadConfig, listBackups, downloadBackup, resolveDownloadedBackup, cleanupDownloadedBackup } = await import('../services/backup/WebDavBackupService');
    const { restoreLocalBackup, validateLocalBackup } = await import('../services/backup/BackupService');
    const { flushNow, pause } = await import('../services/storage/PersistenceFacade');

    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(listBackups).mockResolvedValue([
      { fileName: 'flush-fail.zip', size: 2048, lastModified: '2026-06-08T10:00:00Z', readable: true },
    ]);
    vi.mocked(downloadBackup).mockResolvedValue({ success: true, downloadToken: 'tok-flush' });
    vi.mocked(resolveDownloadedBackup).mockResolvedValue({ success: true, localPath: '/tmp/flush-fail.zip' });
    vi.mocked(validateLocalBackup).mockResolvedValue({
      ok: true,
      summary: {
        app: 'SoNotes', formatVersion: 1, appVersion: '1.5.2', createdAt: Date.now(),
        noteCount: 1, boardCount: 1, textNoteCount: 1, imageNoteCount: 0, trashNoteCount: 0,
        imageFileCount: 0, imageFileTotalBytes: 0,
      },
      errors: [], warnings: [],
    });
    vi.mocked(flushNow).mockResolvedValue(false);
    vi.mocked(confirm).mockResolvedValue(true);

    await openWebdavView();
    await clickElement(findButtonByText('刷新远端列表'));

    const restoreBtn = container.querySelector('[data-testid="webdav-restore-button"]');
    await clickElement(restoreBtn);

    expect(validateLocalBackup).toHaveBeenCalled();
    expect(flushNow).toHaveBeenCalled();
    expect(restoreLocalBackup).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(cleanupDownloadedBackup).toHaveBeenCalledWith('tok-flush');

    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback?.textContent).toContain('当前数据尚未成功写入磁盘');
  });

  it('勾选记住密码但密码为空时不调用 saveConfig', async () => {
    const { saveConfig, loadConfig } = await import('../services/backup/WebDavBackupService');
    vi.mocked(loadConfig).mockResolvedValue({ success: false, passwordSaved: false });

    await openWebdavView();

    const serverInput = container.querySelector('[data-testid="webdav-server-url"]') as HTMLInputElement;
    const usernameInput = container.querySelector('[data-testid="webdav-username"]') as HTMLInputElement;

    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      nativeSetter.call(serverInput, 'https://dav.example.com');
      serverInput.dispatchEvent(new Event('input', { bubbles: true }));
      nativeSetter.call(usernameInput, 'user1');
      usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await clickElement(container.querySelector('[data-testid="webdav-remember-password"]'));

    await clickElement(findButtonByText('保存配置'));

    expect(saveConfig).not.toHaveBeenCalled();
    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback?.textContent).toContain('勾选"记住密码"时需要输入密码');
  });

  it('勾选记住密码且密码非空时调用 saveConfig', async () => {
    const { saveConfig, loadConfig } = await import('../services/backup/WebDavBackupService');
    vi.mocked(loadConfig).mockResolvedValue({ success: false, passwordSaved: false });
    vi.mocked(saveConfig).mockResolvedValue({ success: true });

    await openWebdavView();

    const serverInput = container.querySelector('[data-testid="webdav-server-url"]') as HTMLInputElement;
    const usernameInput = container.querySelector('[data-testid="webdav-username"]') as HTMLInputElement;
    const passwordInput = container.querySelector('[data-testid="webdav-password"]') as HTMLInputElement;

    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      nativeSetter.call(serverInput, 'https://dav.example.com');
      serverInput.dispatchEvent(new Event('input', { bubbles: true }));
      nativeSetter.call(usernameInput, 'user1');
      usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
      nativeSetter.call(passwordInput, 'mypass');
      passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await clickElement(container.querySelector('[data-testid="webdav-remember-password"]'));

    await clickElement(findButtonByText('保存配置'));

    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: 'https://dav.example.com',
        username: 'user1',
        rememberPassword: true,
      }),
    );
    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback?.textContent).toContain('密码已保存到系统凭据管理器');
  });

  it('loadConfig 返回 passwordSaved=true 时显示已保存状态', async () => {
    const { loadConfig } = await import('../services/backup/WebDavBackupService');
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });

    await openWebdavView();

    const status = container.querySelector('[data-testid="webdav-password-saved-status"]');
    expect(status).not.toBeNull();
    expect(status?.textContent).toContain('密码已保存到系统凭据管理器');

    const passwordInput = container.querySelector('[data-testid="webdav-password"]') as HTMLInputElement;
    expect(passwordInput.value).toBe('');
  });

  it('保存配置返回 warning 时展示 warning 文案', async () => {
    const { saveConfig, loadConfig } = await import('../services/backup/WebDavBackupService');
    vi.mocked(loadConfig).mockResolvedValue({ success: false, passwordSaved: false });
    vi.mocked(saveConfig).mockResolvedValue({ success: true, warning: '配置已更新，但系统凭据可能需要手动删除' });

    await openWebdavView();

    const serverInput = container.querySelector('[data-testid="webdav-server-url"]') as HTMLInputElement;
    const usernameInput = container.querySelector('[data-testid="webdav-username"]') as HTMLInputElement;

    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      nativeSetter.call(serverInput, 'https://dav.example.com');
      serverInput.dispatchEvent(new Event('input', { bubbles: true }));
      nativeSetter.call(usernameInput, 'user1');
      usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await clickElement(findButtonByText('保存配置'));

    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback?.textContent).toContain('配置已更新，但系统凭据可能需要手动删除');
  });

  it('passwordSaved=true 且密码为空时测试连接可调用服务', async () => {
    const { testConnection, loadConfig } = await import('../services/backup/WebDavBackupService');
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(testConnection).mockResolvedValue({ success: true });

    await openWebdavView();

    const passwordInput = container.querySelector('[data-testid="webdav-password"]') as HTMLInputElement;
    expect(passwordInput.value).toBe('');

    await clickElement(findButtonByText('测试连接'));

    expect(testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: 'https://dav.example.com', username: 'user1' }),
    );
    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback?.textContent).toContain('连接测试成功');
  });

  it('passwordSaved=false 且密码为空时不调用网络服务并显示提示', async () => {
    const { testConnection, loadConfig } = await import('../services/backup/WebDavBackupService');
    vi.mocked(loadConfig).mockResolvedValue({ success: false, passwordSaved: false });
    vi.mocked(testConnection).mockResolvedValue({ success: true });

    await openWebdavView();

    const serverInput = container.querySelector('[data-testid="webdav-server-url"]') as HTMLInputElement;
    const usernameInput = container.querySelector('[data-testid="webdav-username"]') as HTMLInputElement;

    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      nativeSetter.call(serverInput, 'https://dav.example.com');
      serverInput.dispatchEvent(new Event('input', { bubbles: true }));
      nativeSetter.call(usernameInput, 'user1');
      usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await clickElement(findButtonByText('测试连接'));

    expect(testConnection).not.toHaveBeenCalled();
    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback?.textContent).toContain('请先输入密码');
  });

  it('创建远端备份缺凭据时不调用 flushNow', async () => {
    const { createRemoteBackup, loadConfig } = await import('../services/backup/WebDavBackupService');
    const { flushNow } = await import('../services/storage/PersistenceFacade');
    vi.mocked(loadConfig).mockResolvedValue({ success: false, passwordSaved: false });
    vi.mocked(createRemoteBackup).mockResolvedValue({ success: true, remoteFileName: 'backup.zip', summary: null, zipSizeBytes: null });
    vi.mocked(flushNow).mockResolvedValue(true);

    await openWebdavView();

    const serverInput = container.querySelector('[data-testid="webdav-server-url"]') as HTMLInputElement;
    const usernameInput = container.querySelector('[data-testid="webdav-username"]') as HTMLInputElement;

    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      nativeSetter.call(serverInput, 'https://dav.example.com');
      serverInput.dispatchEvent(new Event('input', { bubbles: true }));
      nativeSetter.call(usernameInput, 'user1');
      usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await clickElement(findButtonByText('创建远端备份'));

    expect(flushNow).not.toHaveBeenCalled();
    expect(createRemoteBackup).not.toHaveBeenCalled();
    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback?.textContent).toContain('请先输入密码');
  });

  it('Rust 返回凭据错误时显示重新输入提示', async () => {
    const { testConnection, loadConfig } = await import('../services/backup/WebDavBackupService');
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(testConnection).mockResolvedValue({ success: false, error: '无法从系统凭据管理器读取密码' });

    await openWebdavView();

    await clickElement(findButtonByText('测试连接'));

    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.textContent).toContain('请在设置中输入密码，或确认系统凭据管理器中的密码可用');
    expect(feedback?.getAttribute('role')).toBe('alert');
  });

  it('清除配置成功含 secretCleanupWarning 时展示 warning', async () => {
    const { clearConfig, loadConfig } = await import('../services/backup/WebDavBackupService');
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(clearConfig).mockResolvedValue({
      success: true,
      secretCleanupWarning: '配置文件已删除，但密钥链 secret 未清理',
    });

    await openWebdavView();

    await clickElement(findButtonByText('清除配置'));

    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.textContent).toContain('配置文件已删除，但密钥链 secret 未清理');
  });

  it('清除配置成功后 passwordSaved 状态重置', async () => {
    const { clearConfig, loadConfig } = await import('../services/backup/WebDavBackupService');
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(clearConfig).mockResolvedValue({ success: true });

    await openWebdavView();

    const savedStatus = container.querySelector('[data-testid="webdav-password-saved-status"]');
    expect(savedStatus).not.toBeNull();
    expect(savedStatus?.textContent).toContain('密码已保存');

    await clickElement(findButtonByText('清除配置'));

    const savedStatusAfter = container.querySelector('[data-testid="webdav-password-saved-status"]');
    expect(savedStatusAfter).toBeNull();
  });
});

describe('BoardDock 恢复流程与 BackupJobCoordinator 集成', () => {
  let container: HTMLDivElement;
  let root: Root;

  const clickElement = async (element: Element | null) => {
    expect(element).not.toBeNull();
    await act(async () => {
      element?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  };

  const findButtonByText = (text: string) => Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent?.includes(text),
  ) ?? null;

  const getSettingsButton = () => container.querySelector('button[aria-label="打开设置"]');

  const renderBoardDock = async () => {
    await act(async () => {
      root.render(<BoardDock />);
    });
  };

  const openDataSettings = async () => {
    await renderBoardDock();
    await clickElement(getSettingsButton());
    await clickElement(findButtonByText('数据管理'));
  };

  const openWebdavView = async () => {
    await openDataSettings();
    await clickElement(findButtonByText('远端备份/恢复'));
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetCoordinatorForTesting();
    resetMockScheduled();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      boards: [
        { id: 'default', name: '主板', icon: '📌', createdAt: 0, viewport: { x: 0, y: 0 } },
      ],
      currentBoardId: 'default',
      isDockVisible: true,
      viewMode: 'BOARD',
      config: { ...useStore.getState().config, themeMode: 'system' },
      saveStatus: 'idle',
      saveError: null,
      isSaving: false,
      lastSavedAt: null,
      switchBoard: vi.fn(),
      createBoard: vi.fn(),
      deleteBoard: vi.fn(),
      updateBoard: vi.fn(),
      reorderBoard: vi.fn(),
      setDockVisible: vi.fn(),
      setViewMode: vi.fn(),
      clearSelection: vi.fn(),
      exportAll: vi.fn(async () => undefined),
      importFromFile: vi.fn(async () => ({ status: 'cancelled' as const })),
      exportCurrentBoard: vi.fn(async () => undefined),
      setThemeMode: vi.fn(),
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    _resetCoordinatorForTesting();
  });

  it('本地 zip 恢复期间有活跃备份任务时显示错误', async () => {
    const { openZipDialog } = await import('../utils/fileSystem');
    const { validateLocalBackup } = await import('../services/backup/BackupService');
    const { pause, resume } = await import('../services/storage/PersistenceFacade');

    vi.mocked(openZipDialog).mockResolvedValue('/backups/test.zip');
    vi.mocked(validateLocalBackup).mockResolvedValue({
      ok: true,
      summary: {
        app: 'SoNotes', formatVersion: 1, appVersion: '1.5.2', createdAt: Date.now(),
        noteCount: 1, boardCount: 1, textNoteCount: 1, imageNoteCount: 0, trashNoteCount: 0,
        imageFileCount: 0, imageFileTotalBytes: 0,
      },
      errors: [],
      warnings: [],
    });
    vi.mocked(confirm).mockResolvedValue(true);

    const backupHandle = tryStartBackupJob('manual-remote-backup');
    expect(backupHandle).not.toBeNull();

    await openDataSettings();
    await clickElement(findButtonByText('从 zip 覆盖恢复'));

    expect(pause).toHaveBeenCalled();
    expect(resume).toHaveBeenCalled();
    const feedback = container.querySelector('[data-testid="zip-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.textContent).toContain('已有备份任务运行中');

    backupHandle!.release();
  });

  it('远端恢复期间有活跃备份任务时显示错误', async () => {
    const { loadConfig, listBackups, downloadBackup } = await import('../services/backup/WebDavBackupService');

    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(listBackups).mockResolvedValue([
      { fileName: 'backup-2026.zip', size: 102400, lastModified: '2026-06-08T10:00:00Z', readable: true },
    ]);
    vi.mocked(downloadBackup).mockResolvedValue({ success: true, downloadToken: 'tok-1' });
    vi.mocked(confirm).mockResolvedValue(true);

    const backupHandle = tryStartBackupJob('manual-remote-backup');
    expect(backupHandle).not.toBeNull();

    await openWebdavView();
    await clickElement(findButtonByText('刷新远端列表'));
    const restoreBtn = container.querySelector('[data-testid="webdav-restore-button"]');
    await clickElement(restoreBtn);

    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.textContent).toContain('已有备份任务运行中');

    backupHandle!.release();
  });

  it('活跃恢复期间手动远端备份被协调器阻止', async () => {
    const { loadConfig } = await import('../services/backup/WebDavBackupService');
    const { createRemoteBackup } = await import('../services/backup/WebDavBackupService');
    const { flushNow } = await import('../services/storage/PersistenceFacade');

    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(createRemoteBackup).mockResolvedValue({ success: true, remoteFileName: 'backup.zip', summary: null, zipSizeBytes: null });
    vi.mocked(flushNow).mockResolvedValue(true);

    const restoreHandle = tryStartBackupJob('local-restore');
    expect(restoreHandle).not.toBeNull();

    await openWebdavView();
    await clickElement(findButtonByText('创建远端备份'));

    expect(flushNow).not.toHaveBeenCalled();
    expect(createRemoteBackup).not.toHaveBeenCalled();
    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.textContent).toContain('创建远端备份失败');

    restoreHandle!.release();
  });

  it('本地 zip 恢复异常时释放协调器任务并恢复持久化', async () => {
    const { openZipDialog } = await import('../utils/fileSystem');
    const { restoreLocalBackup, validateLocalBackup } = await import('../services/backup/BackupService');
    const { pause, resume } = await import('../services/storage/PersistenceFacade');

    vi.mocked(openZipDialog).mockResolvedValue('/backups/crash.zip');
    vi.mocked(validateLocalBackup).mockResolvedValue({
      ok: true,
      summary: {
        app: 'SoNotes', formatVersion: 1, appVersion: '1.5.2', createdAt: Date.now(),
        noteCount: 1, boardCount: 1, textNoteCount: 1, imageNoteCount: 0, trashNoteCount: 0,
        imageFileCount: 0, imageFileTotalBytes: 0,
      },
      errors: [],
      warnings: [],
    });
    vi.mocked(restoreLocalBackup).mockRejectedValue(new Error('恢复过程崩溃'));
    vi.mocked(confirm).mockResolvedValue(true);

    await openDataSettings();
    await clickElement(findButtonByText('从 zip 覆盖恢复'));

    expect(pause).toHaveBeenCalled();
    expect(resume).toHaveBeenCalled();

    const handle = tryStartBackupJob('local-restore');
    expect(handle).not.toBeNull();
    handle!.release();

    const feedback = container.querySelector('[data-testid="zip-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.textContent).toContain('恢复过程崩溃');
  });

  it('远端恢复异常时释放协调器任务并恢复持久化', async () => {
    const { loadConfig, listBackups, downloadBackup, resolveDownloadedBackup } = await import('../services/backup/WebDavBackupService');
    const { restoreLocalBackup, validateLocalBackup } = await import('../services/backup/BackupService');
    const { pause, resume } = await import('../services/storage/PersistenceFacade');

    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(listBackups).mockResolvedValue([
      { fileName: 'backup-2026.zip', size: 102400, lastModified: '2026-06-08T10:00:00Z', readable: true },
    ]);
    vi.mocked(downloadBackup).mockResolvedValue({ success: true, downloadToken: 'tok-abc' });
    vi.mocked(resolveDownloadedBackup).mockResolvedValue({ success: true, localPath: '/tmp/dl.zip' });
    vi.mocked(validateLocalBackup).mockResolvedValue({
      ok: true,
      summary: {
        app: 'SoNotes', formatVersion: 1, appVersion: '1.5.2', createdAt: Date.now(),
        noteCount: 1, boardCount: 1, textNoteCount: 1, imageNoteCount: 0, trashNoteCount: 0,
        imageFileCount: 0, imageFileTotalBytes: 0,
      },
      errors: [],
      warnings: [],
    });
    vi.mocked(restoreLocalBackup).mockRejectedValue(new Error('远端恢复过程崩溃'));
    vi.mocked(confirm).mockResolvedValue(true);

    await openWebdavView();
    await clickElement(findButtonByText('刷新远端列表'));
    const restoreBtn = container.querySelector('[data-testid="webdav-restore-button"]');
    await clickElement(restoreBtn);

    expect(pause).toHaveBeenCalled();
    expect(resume).toHaveBeenCalled();

    const handle = tryStartBackupJob('remote-restore');
    expect(handle).not.toBeNull();
    handle!.release();

    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.textContent).toContain('远端恢复过程崩溃');
  });

  it('本地 zip 恢复成功后释放协调器任务', async () => {
    const { openZipDialog } = await import('../utils/fileSystem');
    const { restoreLocalBackup, validateLocalBackup } = await import('../services/backup/BackupService');
    const { readDiskStorageData } = await import('../services/storage/tauriPersistence');
    const { pause, resume } = await import('../services/storage/PersistenceFacade');

    vi.mocked(openZipDialog).mockResolvedValue('/backups/good.zip');
    vi.mocked(validateLocalBackup).mockResolvedValue({
      ok: true,
      summary: {
        app: 'SoNotes', formatVersion: 1, appVersion: '1.5.2', createdAt: Date.now(),
        noteCount: 1, boardCount: 1, textNoteCount: 1, imageNoteCount: 0, trashNoteCount: 0,
        imageFileCount: 0, imageFileTotalBytes: 0,
      },
      errors: [],
      warnings: [],
    });
    vi.mocked(restoreLocalBackup).mockResolvedValue({
      success: true, noteCount: 1, boardCount: 1, attachmentCount: 0,
    });
    vi.mocked(readDiskStorageData).mockResolvedValue({
      schemaVersion: 1,
      storageUpdatedAt: Date.now(),
      notes: [
        { id: 'restored-ok', kind: 'text', boardId: 'default', x: 0, y: 0, title: '', content: '恢复便签', color: '#FFF', z: 1, collapsed: false, createdAt: 1, updatedAt: 1 },
      ],
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0, viewport: { x: 0, y: 0 } }],
      currentBoardId: 'default',
      config: { ...useStore.getState().config },
    });
    vi.mocked(confirm).mockResolvedValue(true);

    await openDataSettings();
    await clickElement(findButtonByText('从 zip 覆盖恢复'));

    expect(pause).toHaveBeenCalled();
    expect(restoreLocalBackup).toHaveBeenCalled();
    expect(resume).toHaveBeenCalled();

    const handle = tryStartBackupJob('local-restore');
    expect(handle).not.toBeNull();
    handle!.release();

    const feedback = container.querySelector('[data-testid="zip-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.textContent).toContain('恢复成功');
  });

  it('远端恢复成功后释放协调器任务', async () => {
    const { loadConfig, listBackups, downloadBackup, resolveDownloadedBackup, cleanupDownloadedBackup } = await import('../services/backup/WebDavBackupService');
    const { restoreLocalBackup, validateLocalBackup } = await import('../services/backup/BackupService');
    const { readDiskStorageData } = await import('../services/storage/tauriPersistence');
    const { pause, resume } = await import('../services/storage/PersistenceFacade');

    vi.mocked(loadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(listBackups).mockResolvedValue([
      { fileName: 'backup-2026.zip', size: 102400, lastModified: '2026-06-08T10:00:00Z', readable: true },
    ]);
    vi.mocked(downloadBackup).mockResolvedValue({ success: true, downloadToken: 'tok-ok' });
    vi.mocked(resolveDownloadedBackup).mockResolvedValue({ success: true, localPath: '/tmp/dl.zip' });
    vi.mocked(validateLocalBackup).mockResolvedValue({
      ok: true,
      summary: {
        app: 'SoNotes', formatVersion: 1, appVersion: '1.5.2', createdAt: Date.now(),
        noteCount: 1, boardCount: 1, textNoteCount: 1, imageNoteCount: 0, trashNoteCount: 0,
        imageFileCount: 0, imageFileTotalBytes: 0,
      },
      errors: [],
      warnings: [],
    });
    vi.mocked(restoreLocalBackup).mockResolvedValue({
      success: true, noteCount: 1, boardCount: 1, attachmentCount: 0,
    });
    vi.mocked(readDiskStorageData).mockResolvedValue({
      schemaVersion: 1,
      storageUpdatedAt: Date.now(),
      notes: [
        { id: 'restored-remote', kind: 'text', boardId: 'default', x: 0, y: 0, title: '', content: '远端恢复便签', color: '#FFF', z: 1, collapsed: false, createdAt: 1, updatedAt: 1 },
      ],
      boards: [{ id: 'default', name: '主板', icon: '📌', createdAt: 0, viewport: { x: 0, y: 0 } }],
      currentBoardId: 'default',
      config: { ...useStore.getState().config },
    });
    vi.mocked(confirm).mockResolvedValue(true);

    await openWebdavView();
    await clickElement(findButtonByText('刷新远端列表'));
    const restoreBtn = container.querySelector('[data-testid="webdav-restore-button"]');
    await clickElement(restoreBtn);

    expect(pause).toHaveBeenCalled();
    expect(restoreLocalBackup).toHaveBeenCalled();
    expect(resume).toHaveBeenCalled();
    expect(cleanupDownloadedBackup).toHaveBeenCalledWith('tok-ok');

    const handle = tryStartBackupJob('remote-restore');
    expect(handle).not.toBeNull();
    handle!.release();

    const feedback = container.querySelector('[data-testid="webdav-feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.textContent).toContain('远端恢复成功');
  });
});

describe('BoardDock 定时远端备份 UI', () => {
  let container: HTMLDivElement;
  let root: Root;

  const clickElement = async (element: Element | null) => {
    expect(element).not.toBeNull();
    await act(async () => {
      element?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  };

  const findButtonByText = (text: string) => Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent?.includes(text),
  ) ?? null;

  const getSettingsButton = () => container.querySelector('button[aria-label="打开设置"]');

  const renderBoardDock = async () => {
    await act(async () => {
      root.render(<BoardDock />);
    });
  };

  const openDataSettings = async () => {
    await renderBoardDock();
    await clickElement(getSettingsButton());
    await clickElement(findButtonByText('数据管理'));
  };

  const openWebdavView = async () => {
    await openDataSettings();
    await clickElement(findButtonByText('远端备份/恢复'));
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetCoordinatorForTesting();
    resetMockScheduled();
    useStore.setState(useStore.getInitialState(), true);
    useStore.setState({
      ...createEmptyNormalizedNotesState(),
      boards: [
        { id: 'default', name: '主板', icon: '📌', createdAt: 0, viewport: { x: 0, y: 0 } },
      ],
      currentBoardId: 'default',
      isDockVisible: true,
      viewMode: 'BOARD',
      config: { ...useStore.getState().config, themeMode: 'system' },
      saveStatus: 'idle',
      saveError: null,
      isSaving: false,
      lastSavedAt: null,
      switchBoard: vi.fn(),
      createBoard: vi.fn(),
      deleteBoard: vi.fn(),
      updateBoard: vi.fn(),
      reorderBoard: vi.fn(),
      setDockVisible: vi.fn(),
      setViewMode: vi.fn(),
      clearSelection: vi.fn(),
      exportAll: vi.fn(async () => undefined),
      importFromFile: vi.fn(async () => ({ status: 'cancelled' as const })),
      exportCurrentBoard: vi.fn(async () => undefined),
      setThemeMode: vi.fn(),
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('默认关闭自动远端备份', async () => {
    const { loadConfig } = await import('../services/backup/ScheduledRemoteBackupConfigService');
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, config: DEFAULT_SCHEDULED_BACKUP_CONFIG, error: null,
    });

    await openWebdavView();

    const toggle = container.querySelector('[data-testid="scheduled-backup-toggle"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
  });

  it('显式启用自动远端备份后持久化配置', async () => {
    const { loadConfig, saveConfig } = await import('../services/backup/ScheduledRemoteBackupConfigService');
    const { loadConfig: webdavLoadConfig } = await import('../services/backup/WebDavBackupService');
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, config: DEFAULT_SCHEDULED_BACKUP_CONFIG, error: null,
    });
    vi.mocked(saveConfig).mockResolvedValue({ success: true, error: null });
    vi.mocked(webdavLoadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });

    await openWebdavView();

    const toggle = container.querySelector('[data-testid="scheduled-backup-toggle"]');
    await clickElement(toggle);

    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
    expect(toggle?.getAttribute('aria-checked')).toBe('true');
  });

  it('passwordSaved=false 时自动备份开关 disabled', async () => {
    const { loadConfig } = await import('../services/backup/ScheduledRemoteBackupConfigService');
    const { loadConfig: webdavLoadConfig } = await import('../services/backup/WebDavBackupService');
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, config: DEFAULT_SCHEDULED_BACKUP_CONFIG, error: null,
    });
    vi.mocked(webdavLoadConfig).mockResolvedValue({
      success: false, passwordSaved: false,
    });

    await openWebdavView();

    const toggle = container.querySelector('[data-testid="scheduled-backup-toggle"]') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(toggle.disabled).toBe(true);

    const warning = container.querySelector('[data-testid="scheduled-backup-credential-warning"]');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain('请先保存 WebDAV 密码到系统凭据管理器');
  });

  it('passwordSaved=false 时点击开关不调用 saveConfig', async () => {
    const { loadConfig, saveConfig } = await import('../services/backup/ScheduledRemoteBackupConfigService');
    const { loadConfig: webdavLoadConfig } = await import('../services/backup/WebDavBackupService');
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, config: DEFAULT_SCHEDULED_BACKUP_CONFIG, error: null,
    });
    vi.mocked(webdavLoadConfig).mockResolvedValue({
      success: false, passwordSaved: false,
    });

    await openWebdavView();

    const toggle = container.querySelector('[data-testid="scheduled-backup-toggle"]');
    await clickElement(toggle);

    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('频率选择变更后持久化', async () => {
    const { loadConfig, saveConfig } = await import('../services/backup/ScheduledRemoteBackupConfigService');
    const { loadConfig: webdavLoadConfig } = await import('../services/backup/WebDavBackupService');
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, config: { ...DEFAULT_SCHEDULED_BACKUP_CONFIG, enabled: true }, error: null,
    });
    vi.mocked(saveConfig).mockResolvedValue({ success: true, error: null });
    vi.mocked(webdavLoadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });

    await openWebdavView();

    const frequencySelect = container.querySelector('[data-testid="scheduled-backup-frequency"]') as HTMLSelectElement;
    expect(frequencySelect).not.toBeNull();

    await act(async () => {
      frequencySelect.value = 'every-6-hours';
      frequencySelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ frequency: 'every-6-hours' }),
    );
  });

  it('频率变更后立即刷新显示的下次尝试时间', async () => {
    const { loadConfig, saveConfig, saveState } = await import('../services/backup/ScheduledRemoteBackupConfigService');
    const { loadConfig: webdavLoadConfig } = await import('../services/backup/WebDavBackupService');

    const dailyNextRun = new Date('2026-06-14T22:30:00').getTime();
    const weeklyNextRun = Date.now() + 7 * 24 * 60 * 60 * 1000;

    mockScheduledStateRef.current = {
      ...DEFAULT_SCHEDULED_BACKUP_STATE,
      nextRunAt: dailyNextRun,
    };
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, config: { ...DEFAULT_SCHEDULED_BACKUP_CONFIG, enabled: true }, error: null,
    });
    vi.mocked(saveConfig).mockResolvedValue({ success: true, error: null });
    vi.mocked(saveState).mockResolvedValue({ success: true, error: null });
    vi.mocked(webdavLoadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });

    await openWebdavView();

    const frequencySelect = container.querySelector('[data-testid="scheduled-backup-frequency"]') as HTMLSelectElement;
    expect(frequencySelect).not.toBeNull();

    await act(async () => {
      frequencySelect.value = 'weekly';
      frequencySelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const nextRunText = container.querySelector('[data-testid="scheduled-backup-status"]');
    const expectedFormatted = new Date(weeklyNextRun).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    expect(nextRunText?.textContent).toContain('下次尝试');
    expect(nextRunText?.textContent).toContain(expectedFormatted);
    expect(nextRunText?.textContent).not.toContain('06/14 22:30');
  });

  it('scheduler 为 null 时频率变更仍更新下次尝试时间', async () => {
    const { loadConfig, loadState, saveConfig, saveState } = await import('../services/backup/ScheduledRemoteBackupConfigService');
    const { loadConfig: webdavLoadConfig } = await import('../services/backup/WebDavBackupService');

    mockScheduledStateRef.current = {
      ...DEFAULT_SCHEDULED_BACKUP_STATE,
      nextRunAt: null,
    };
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, config: { ...DEFAULT_SCHEDULED_BACKUP_CONFIG, enabled: true }, error: null,
    });
    vi.mocked(saveConfig).mockResolvedValue({ success: true, error: null });
    vi.mocked(saveState).mockResolvedValue({ success: true, error: null });
    vi.mocked(webdavLoadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });

    await openWebdavView();

    const frequencySelect = container.querySelector('[data-testid="scheduled-backup-frequency"]') as HTMLSelectElement;
    expect(frequencySelect).not.toBeNull();

    const beforeChange = Date.now();
    await act(async () => {
      frequencySelect.value = 'daily';
      frequencySelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(loadState).toHaveBeenCalled();
    const savedArg = vi.mocked(saveState).mock.calls[0]?.[0] as unknown as Record<string, unknown> | undefined;
    expect(savedArg).toBeDefined();
    expect(typeof savedArg!.nextRunAt).toBe('number');
    expect((savedArg!.nextRunAt as number) - beforeChange).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
    expect((savedArg!.nextRunAt as number) - beforeChange).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);

    const expectedFormatted = new Date(savedArg!.nextRunAt as number).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    const nextRunText = container.querySelector('[data-testid="scheduled-backup-status"]');
    expect(nextRunText?.textContent).toContain('下次尝试');
    expect(nextRunText?.textContent).toContain(expectedFormatted);
  });

  it('退出前提醒开关变更后持久化', async () => {
    const { loadConfig, saveConfig } = await import('../services/backup/ScheduledRemoteBackupConfigService');
    const { loadConfig: webdavLoadConfig } = await import('../services/backup/WebDavBackupService');
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, config: { ...DEFAULT_SCHEDULED_BACKUP_CONFIG, enabled: true }, error: null,
    });
    vi.mocked(saveConfig).mockResolvedValue({ success: true, error: null });
    vi.mocked(webdavLoadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });

    await openWebdavView();

    const exitPrompt = container.querySelector('[data-testid="scheduled-backup-exit-prompt"]') as HTMLInputElement;
    expect(exitPrompt).not.toBeNull();
    expect(exitPrompt.checked).toBe(true);

    await clickElement(exitPrompt);

    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ exitPromptEnabled: false }),
    );
  });

  it('最近自动备份成功后显示状态', async () => {
    const { loadConfig } = await import('../services/backup/ScheduledRemoteBackupConfigService');
    const { loadConfig: webdavLoadConfig } = await import('../services/backup/WebDavBackupService');
    mockScheduledStateRef.current = {
      ...DEFAULT_SCHEDULED_BACKUP_STATE,
      lastAutomaticSuccessAt: new Date('2026-06-14T10:30:00').getTime(),
      lastRemoteFileName: 'SoNotes_Backup_20260614103000.zip',
      nextRunAt: new Date('2026-06-14T22:30:00').getTime(),
    };
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, config: { ...DEFAULT_SCHEDULED_BACKUP_CONFIG, enabled: true }, error: null,
    });
    vi.mocked(webdavLoadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });

    await openWebdavView();

    const status = container.querySelector('[data-testid="scheduled-backup-status"]');
    expect(status).not.toBeNull();
    expect(status?.textContent).toContain('最近自动备份');
    expect(status?.textContent).toContain('SoNotes_Backup_20260614103000.zip');
    expect(status?.textContent).toContain('下次尝试');
  });

  it('最近失败原因显示在状态区', async () => {
    const { loadConfig } = await import('../services/backup/ScheduledRemoteBackupConfigService');
    const { loadConfig: webdavLoadConfig } = await import('../services/backup/WebDavBackupService');
    mockScheduledStateRef.current = {
      ...DEFAULT_SCHEDULED_BACKUP_STATE,
      lastFailureAt: new Date('2026-06-14T08:00:00').getTime(),
      lastFailureReason: '网络连接失败',
    };
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, config: { ...DEFAULT_SCHEDULED_BACKUP_CONFIG, enabled: true }, error: null,
    });
    vi.mocked(webdavLoadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });

    await openWebdavView();

    const status = container.querySelector('[data-testid="scheduled-backup-status"]');
    expect(status).not.toBeNull();
    expect(status?.textContent).toContain('最近失败');
    expect(status?.textContent).toContain('网络连接失败');
  });

  it('自动备份区域不含"同步"文案', async () => {
    const { loadConfig } = await import('../services/backup/ScheduledRemoteBackupConfigService');
    const { loadConfig: webdavLoadConfig } = await import('../services/backup/WebDavBackupService');
    mockScheduledStateRef.current = {
      ...DEFAULT_SCHEDULED_BACKUP_STATE,
      lastAutomaticSuccessAt: Date.now(),
      lastFailureReason: '凭据错误',
      nextRunAt: Date.now() + 3600000,
    };
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, config: { ...DEFAULT_SCHEDULED_BACKUP_CONFIG, enabled: true }, error: null,
    });
    vi.mocked(webdavLoadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });

    await openWebdavView();

    const section = container.querySelector('[data-testid="scheduled-backup-section"]');
    expect(section).not.toBeNull();
    expect(section?.textContent).not.toContain('同步');
  });

  it('关闭自动备份后不显示频率和退出提示控件', async () => {
    const { loadConfig } = await import('../services/backup/ScheduledRemoteBackupConfigService');
    const { loadConfig: webdavLoadConfig } = await import('../services/backup/WebDavBackupService');
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, config: DEFAULT_SCHEDULED_BACKUP_CONFIG, error: null,
    });
    vi.mocked(webdavLoadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });

    await openWebdavView();

    expect(container.querySelector('[data-testid="scheduled-backup-frequency"]')).toBeNull();
    expect(container.querySelector('[data-testid="scheduled-backup-exit-prompt"]')).toBeNull();
    expect(container.querySelector('[data-testid="scheduled-backup-disabled-hint"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="scheduled-backup-disabled-hint"]')?.textContent).toContain('自动远端备份已关闭');
  });

  it('清除 WebDAV 配置后自动关闭定时备份', async () => {
    const { loadConfig, saveConfig } = await import('../services/backup/ScheduledRemoteBackupConfigService');
    const { loadConfig: webdavLoadConfig, clearConfig } = await import('../services/backup/WebDavBackupService');
    mockScheduledConfigRef.current = { ...DEFAULT_SCHEDULED_BACKUP_CONFIG, enabled: true };
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, config: mockScheduledConfigRef.current, error: null,
    });
    vi.mocked(saveConfig).mockResolvedValue({ success: true, error: null });
    vi.mocked(webdavLoadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(clearConfig).mockResolvedValue({ success: true });

    await openWebdavView();

    await clickElement(findButtonByText('清除配置'));

    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it('WebDAV 设置区不引入水平溢出的固定宽度', async () => {
    const { loadConfig } = await import('../services/backup/ScheduledRemoteBackupConfigService');
    const { loadConfig: webdavLoadConfig } = await import('../services/backup/WebDavBackupService');
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, config: { ...DEFAULT_SCHEDULED_BACKUP_CONFIG, enabled: true }, error: null,
    });
    vi.mocked(webdavLoadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });

    await openWebdavView();

    const scheduledSection = container.querySelector('[data-testid="scheduled-backup-section"]');
    expect(scheduledSection).not.toBeNull();
    const html = scheduledSection!.innerHTML;
    expect(html).not.toContain('width:');
    expect(html).not.toContain('min-width:');
  });

  it('密码保存后开启自动备份显示成功且不显示凭据警告', async () => {
    const { loadConfig, saveConfig } = await import('../services/backup/ScheduledRemoteBackupConfigService');
    const { loadConfig: webdavLoadConfig, saveConfig: webdavSaveConfig } = await import('../services/backup/WebDavBackupService');
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, config: DEFAULT_SCHEDULED_BACKUP_CONFIG, error: null,
    });
    vi.mocked(saveConfig).mockResolvedValue({ success: true, error: null });
    vi.mocked(webdavLoadConfig).mockResolvedValue({
      success: false, passwordSaved: false,
    });
    vi.mocked(webdavSaveConfig).mockResolvedValue({ success: true });

    await openWebdavView();

    expect(container.querySelector('[data-testid="scheduled-backup-credential-warning"]')).not.toBeNull();

    const serverInput = container.querySelector('[data-testid="webdav-server-url"]') as HTMLInputElement;
    const usernameInput = container.querySelector('[data-testid="webdav-username"]') as HTMLInputElement;
    const passwordInput = container.querySelector('[data-testid="webdav-password"]') as HTMLInputElement;

    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      nativeSetter.call(serverInput, 'https://dav.example.com');
      serverInput.dispatchEvent(new Event('input', { bubbles: true }));
      nativeSetter.call(usernameInput, 'user1');
      usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
      nativeSetter.call(passwordInput, 'mypass');
      passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await clickElement(container.querySelector('[data-testid="webdav-remember-password"]'));
    await clickElement(findButtonByText('保存配置'));

    const toggle = container.querySelector('[data-testid="scheduled-backup-toggle"]') as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);

    await clickElement(toggle);

    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
    expect(container.querySelector('[data-testid="scheduled-backup-credential-warning"]')).toBeNull();
  });

  it('从未备份过时显示退出提示', async () => {
    const { loadConfig } = await import('../services/backup/ScheduledRemoteBackupConfigService');
    const { loadConfig: webdavLoadConfig } = await import('../services/backup/WebDavBackupService');
    const { readDiskStorageData, getLatestUpdateTimestamp } = await import('../services/storage/tauriPersistence');
    mockScheduledStateRef.current = {
      ...DEFAULT_SCHEDULED_BACKUP_STATE,
      lastSuccessfulStorageUpdatedAt: null,
      lastAutomaticSuccessAt: null,
    };
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, config: { ...DEFAULT_SCHEDULED_BACKUP_CONFIG, enabled: true, exitPromptEnabled: true }, error: null,
    });
    vi.mocked(webdavLoadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(readDiskStorageData).mockResolvedValue({
      boards: {}, notes: {}, trashedNotes: {}, storageUpdatedAt: 1000,
    } as never);
    vi.mocked(getLatestUpdateTimestamp).mockReturnValue(1000);

    await openWebdavView();
    await vi.waitFor(() => {
      const hint = container.querySelector('[data-testid="exit-backup-pending-hint"]');
      expect(hint).not.toBeNull();
    });
  });

  it('最近成功时间仍在 30 分钟内但磁盘快照更新 → 显示退出提示', async () => {
    const { loadConfig } = await import('../services/backup/ScheduledRemoteBackupConfigService');
    const { loadConfig: webdavLoadConfig } = await import('../services/backup/WebDavBackupService');
    const { readDiskStorageData, getLatestUpdateTimestamp } = await import('../services/storage/tauriPersistence');
    const now = Date.now();
    const oneMinuteAgo = now - 60 * 1000;
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;
    mockScheduledStateRef.current = {
      ...DEFAULT_SCHEDULED_BACKUP_STATE,
      lastSuccessfulStorageUpdatedAt: twoHoursAgo,
      lastAutomaticSuccessAt: twoHoursAgo,
      lastManualSuccessAt: oneMinuteAgo,
    };
    vi.mocked(loadConfig).mockResolvedValue({
      success: true, config: { ...DEFAULT_SCHEDULED_BACKUP_CONFIG, enabled: true, exitPromptEnabled: true }, error: null,
    });
    vi.mocked(webdavLoadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(readDiskStorageData).mockResolvedValue({
      boards: {}, notes: {}, trashedNotes: {}, storageUpdatedAt: now,
    } as never);
    vi.mocked(getLatestUpdateTimestamp).mockReturnValue(now);

    await openWebdavView();
    await vi.waitFor(() => {
      const hint = container.querySelector('[data-testid="exit-backup-pending-hint"]');
      expect(hint).not.toBeNull();
    });
  });

  it('手动备份失败时非枚举 errorStage 归一化为 unknown 且写入 capturedStorageUpdatedAt', async () => {
    const { saveState } = await import('../services/backup/ScheduledRemoteBackupConfigService');
    const { loadConfig: webdavLoadConfig, createRemoteBackup } = await import('../services/backup/WebDavBackupService');
    const { readDiskStorageData, getLatestUpdateTimestamp } = await import('../services/storage/tauriPersistence');
    vi.mocked(webdavLoadConfig).mockResolvedValue({
      success: true, serverUrl: 'https://dav.example.com', username: 'user1', remoteDir: 'SoNotes_Backups/', passwordSaved: true,
    });
    vi.mocked(readDiskStorageData).mockResolvedValue({ boards: {}, notes: {}, trashedNotes: {}, storageUpdatedAt: 1234 } as never);
    vi.mocked(getLatestUpdateTimestamp).mockReturnValue(1234);
    vi.mocked(createRemoteBackup).mockResolvedValue({
      success: false,
      error: '认证失败',
      errorStage: 'credential',
      summary: null,
      zipSizeBytes: null,
    });
    vi.mocked(saveState).mockResolvedValue({ success: true, error: null });

    await openWebdavView();
    await clickElement(findButtonByText('创建远端备份'));

    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        lastStartedAt: expect.any(Number),
        lastAttemptCapturedStorageUpdatedAt: 1234,
        lastFailureStage: 'credential',
      }),
    );
  });
});
