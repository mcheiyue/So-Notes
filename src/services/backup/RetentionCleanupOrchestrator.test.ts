import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  detectBackupCliffDropMock,
  executeRetentionCleanupMock,
} = vi.hoisted(() => ({
  detectBackupCliffDropMock: vi.fn(),
  executeRetentionCleanupMock: vi.fn(),
}));

vi.mock('./RemoteBackupRetention', () => ({
  detectBackupCliffDrop: detectBackupCliffDropMock,
}));

vi.mock('./RemoteBackupRetentionService', () => ({
  executeRetentionCleanup: executeRetentionCleanupMock,
}));

import { orchestratePostBackupRetentionCleanup } from './RetentionCleanupOrchestrator';
import type {
  ScheduledRemoteBackupConfig,
  ScheduledRemoteBackupState,
  RemoteBackupTrigger,
} from './ScheduledRemoteBackupConfigService';
import type { WebDavUploadResult, WebDavConfig } from './WebDavBackupService';

const DUMMY_WEBDAV_CONFIG: WebDavConfig = {
  serverUrl: 'https://dav.example.com',
  username: 'user',
};

const DEFAULT_CONFIG: ScheduledRemoteBackupConfig = {
  enabled: true,
  frequency: 'daily',
  quietPeriodMinutes: 5,
  exitPromptEnabled: true,
  retentionEnabled: true,
  retentionCount: 10,
};

const DEFAULT_STATE: ScheduledRemoteBackupState = {
  lastStartedAt: null,
  lastFinishedAt: null,
  lastTrigger: null,
  lastAutomaticSuccessAt: null,
  lastManualSuccessAt: null,
  lastFailureAt: null,
  lastFailureReason: null,
  lastFailureStage: null,
  lastRemoteFileName: null,
  nextRunAt: null,
  lastSuccessfulStorageUpdatedAt: null,
  lastAttemptCapturedStorageUpdatedAt: null,
  consecutiveCredentialFailures: 0,
  credentialActionRequired: false,
  cliffDropDetectedAt: null,
  baselineConfirmedRemoteCount: null,
  baselineConfirmedBoardCount: null,
  baselineConfirmedImageNoteCount: null,
  baselineConfirmedImageFileCount: null,
  baselineConfirmedImageFileTotalBytes: null,
  baselineConfirmedRemoteFileName: 'SoNotes_Backup_20250601000000.zip',
  baselineConfirmedConfirmedAt: null,
  baselineConfirmedZipSizeBytes: null,
  cliffDropDeferred: false,
  cliffDropLatestSummaryNoteCount: null,
  cliffDropLatestSummaryBoardCount: null,
  cliffDropLatestSummaryImageNoteCount: null,
  cliffDropLatestSummaryImageFileCount: null,
  cliffDropLatestSummaryImageFileTotalBytes: null,
  cliffDropLatestRemoteFileName: null,
  cliffDropLatestZipSizeBytes: null,
  cliffDropLatestAnomalyCodes: null,
  pendingCleanupTargetCount: null,
  lastRetentionCleanupDeletedCount: null,
  lastRetentionCleanupMissingCount: null,
  lastRetentionCleanupFailedFileName: null,
  lastRetentionCleanupError: null,
  lastRetentionCleanupSkipped: null,
  lastRetentionCleanupBusy: null,
  lastRetentionCleanupAt: null,
};

function makeUploadResult(overrides?: Partial<WebDavUploadResult>): WebDavUploadResult {
  return {
    success: true,
    summary: {
      app: 'SoNotes',
      formatVersion: 1,
      appVersion: '1.5.7',
      createdAt: Date.now(),
      noteCount: 10,
      boardCount: 1,
      textNoteCount: 10,
      imageNoteCount: 0,
      trashNoteCount: 0,
      imageFileCount: 0,
      imageFileTotalBytes: 0,
    },
    zipSizeBytes: 1024,
    remoteFileName: 'SoNotes_Backup_20250615000000.zip',
    ...overrides,
  };
}

function makeInput(overrides?: {
  trigger?: RemoteBackupTrigger;
  config?: Partial<ScheduledRemoteBackupConfig>;
  state?: Partial<ScheduledRemoteBackupState>;
  uploadResult?: WebDavUploadResult;
}) {
  return {
    trigger: (overrides?.trigger ?? 'scheduled-interval') as RemoteBackupTrigger,
    config: { ...DEFAULT_CONFIG, ...overrides?.config },
    state: { ...DEFAULT_STATE, ...overrides?.state },
    uploadResult: overrides?.uploadResult ?? makeUploadResult(),
    webdavConfig: DUMMY_WEBDAV_CONFIG,
    clock: () => 1700000000000,
  };
}

describe('RetentionCleanupOrchestrator', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('trigger 过滤', () => {
    it('trigger 为 manual → 跳过，返回空 patch', async () => {
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({ trigger: 'manual' }),
      );
      expect(result).toEqual({});
      expect(executeRetentionCleanupMock).not.toHaveBeenCalled();
    });

    it('trigger 为 before-exit → 跳过清理（AUTOMATIC_TRIGGERS 不包含）', async () => {
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({ trigger: 'before-exit' }),
      );
      expect(result).toEqual({});
      expect(executeRetentionCleanupMock).not.toHaveBeenCalled();
    });

    it('trigger 为 scheduled-interval → 不跳过', async () => {
      detectBackupCliffDropMock.mockReturnValue(null);
      executeRetentionCleanupMock.mockResolvedValue({ retainedCount: 5 });
      await orchestratePostBackupRetentionCleanup(
        makeInput({
          trigger: 'scheduled-interval',
          state: { baselineConfirmedRemoteCount: 10 },
        }),
      );
      expect(executeRetentionCleanupMock).toHaveBeenCalled();
    });

    it('trigger 为 quiet-period → 不跳过', async () => {
      detectBackupCliffDropMock.mockReturnValue(null);
      executeRetentionCleanupMock.mockResolvedValue({ retainedCount: 5 });
      await orchestratePostBackupRetentionCleanup(
        makeInput({
          trigger: 'quiet-period',
          state: { baselineConfirmedRemoteCount: 10 },
        }),
      );
      expect(executeRetentionCleanupMock).toHaveBeenCalled();
    });
  });

  describe('retentionEnabled 过滤', () => {
    it('retentionEnabled=false → 跳过清理', async () => {
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({ config: { retentionEnabled: false } }),
      );
      expect(result).toEqual({});
      expect(executeRetentionCleanupMock).not.toHaveBeenCalled();
    });

    it('retentionCount=null → 视为无限保留，跳过清理', async () => {
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({ config: { retentionCount: null } }),
      );
      expect(result).toEqual({});
      expect(executeRetentionCleanupMock).not.toHaveBeenCalled();
    });

    it('retentionCount=0 → 跳过清理', async () => {
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({ config: { retentionCount: 0 } }),
      );
      expect(result).toEqual({});
      expect(executeRetentionCleanupMock).not.toHaveBeenCalled();
    });

    it('retentionCount=-1 → 跳过清理', async () => {
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({ config: { retentionCount: -1 } }),
      );
      expect(result).toEqual({});
      expect(executeRetentionCleanupMock).not.toHaveBeenCalled();
    });
  });

  describe('基线初始化', () => {
    it('无基线且有摘要但 remoteFileName 为空 → 跳过基线初始化，返回 skipped', async () => {
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({
          state: { baselineConfirmedRemoteCount: null },
          uploadResult: makeUploadResult({
            remoteFileName: undefined,
            summary: {
              app: 'SoNotes',
              formatVersion: 1,
              appVersion: '1.5.7',
              createdAt: Date.now(),
              noteCount: 15,
              boardCount: 2,
              textNoteCount: 15,
              imageNoteCount: 0,
              trashNoteCount: 0,
              imageFileCount: 0,
              imageFileTotalBytes: 0,
            },
          }),
        }),
      );
      expect(result).toEqual({
        lastRetentionCleanupSkipped: true,
        lastRetentionCleanupAt: 1700000000000,
      });
      expect(executeRetentionCleanupMock).not.toHaveBeenCalled();
      expect(detectBackupCliffDropMock).not.toHaveBeenCalled();
    });

    it('无基线且无摘要 → 跳过清理，返回 skipped 状态', async () => {
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({
          state: { baselineConfirmedRemoteCount: null },
          uploadResult: makeUploadResult({ summary: null }),
        }),
      );
      expect(result).toEqual({
        lastRetentionCleanupSkipped: true,
        lastRetentionCleanupAt: 1700000000000,
      });
      expect(executeRetentionCleanupMock).not.toHaveBeenCalled();
    });

    it('有 count 但 fileName 为 null 且 remoteFileName 为空 → 跳过基线初始化', async () => {
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({
          state: { baselineConfirmedRemoteCount: 10, baselineConfirmedRemoteFileName: null },
          uploadResult: makeUploadResult({ remoteFileName: undefined }),
        }),
      );
      expect(result).toEqual({
        lastRetentionCleanupSkipped: true,
        lastRetentionCleanupAt: 1700000000000,
      });
      expect(executeRetentionCleanupMock).not.toHaveBeenCalled();
    });

    it('无基线且 remoteFileName 为 null → 跳过基线初始化，返回 skipped', async () => {
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({
          state: { baselineConfirmedRemoteCount: null },
          uploadResult: makeUploadResult({ remoteFileName: null }),
        }),
      );
      expect(result).toEqual({
        lastRetentionCleanupSkipped: true,
        lastRetentionCleanupAt: 1700000000000,
      });
      expect(executeRetentionCleanupMock).not.toHaveBeenCalled();
    });
  });

  describe('断崖检测', () => {
    it('cliffDropDeferred=true → 跳过清理，返回空 patch', async () => {
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({ state: { baselineConfirmedRemoteCount: 10, cliffDropDeferred: true } }),
      );
      expect(result).toEqual({});
      expect(detectBackupCliffDropMock).not.toHaveBeenCalled();
      expect(executeRetentionCleanupMock).not.toHaveBeenCalled();
    });

    it('断崖检测异常 → 保存警告，跳过清理', async () => {
      detectBackupCliffDropMock.mockReturnValue({
        baselineNotes: 10,
        currentNotes: 2,
        dropPct: 0.8,
        threshold: 0.3,
        anomalyCodes: ['CLIFF_DROP_RELATIVE'],
      });
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({ state: { baselineConfirmedRemoteCount: 10 } }),
      );
      expect(result).toEqual({
        cliffDropDetectedAt: 1700000000000,
        cliffDropDeferred: true,
        cliffDropLatestSummaryNoteCount: 10,
        cliffDropLatestSummaryBoardCount: 1,
        cliffDropLatestSummaryImageNoteCount: 0,
        cliffDropLatestSummaryImageFileCount: 0,
        cliffDropLatestSummaryImageFileTotalBytes: 0,
        cliffDropLatestRemoteFileName: 'SoNotes_Backup_20250615000000.zip',
        cliffDropLatestZipSizeBytes: 1024,
        cliffDropLatestAnomalyCodes: ['CLIFF_DROP_RELATIVE'],
      });
      expect(executeRetentionCleanupMock).not.toHaveBeenCalled();
    });

    it('断崖检测未触发 → 继续执行清理', async () => {
      detectBackupCliffDropMock.mockReturnValue(null);
      executeRetentionCleanupMock.mockResolvedValue({ retainedCount: 8 });
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({ state: { baselineConfirmedRemoteCount: 10 } }),
      );
      expect(executeRetentionCleanupMock).toHaveBeenCalled();
      expect(result).toHaveProperty('pendingCleanupTargetCount');
    });

    it('uploadResult.summary 为 null → 跳过断崖检测和清理，返回 skipped 状态', async () => {
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({
          state: { baselineConfirmedRemoteCount: 10 },
          uploadResult: makeUploadResult({ summary: null }),
        }),
      );
      expect(detectBackupCliffDropMock).not.toHaveBeenCalled();
      expect(executeRetentionCleanupMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        lastRetentionCleanupSkipped: true,
        lastRetentionCleanupAt: 1700000000000,
      });
    });
  });

  describe('清理执行', () => {
    it('正常情况 → 执行清理并返回 retainedCount', async () => {
      detectBackupCliffDropMock.mockReturnValue(null);
      executeRetentionCleanupMock.mockResolvedValue({
        retainedCount: 7,
        deletedCount: 0,
        missingCount: 0,
        failedFileName: null,
        error: null,
      });
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({ state: { baselineConfirmedRemoteCount: 10 } }),
      );
      expect(executeRetentionCleanupMock).toHaveBeenCalledWith({
        config: DUMMY_WEBDAV_CONFIG,
        retentionCount: 10,
        protectedFileNames: new Set([
          'SoNotes_Backup_20250615000000.zip',
          'SoNotes_Backup_20250601000000.zip',
        ]),
      });
      expect(result).toEqual({
        baselineConfirmedRemoteCount: 10,
        baselineConfirmedBoardCount: 1,
        baselineConfirmedImageNoteCount: 0,
        baselineConfirmedImageFileCount: 0,
        baselineConfirmedImageFileTotalBytes: 0,
        baselineConfirmedRemoteFileName: 'SoNotes_Backup_20250615000000.zip',
        baselineConfirmedConfirmedAt: 1700000000000,
        baselineConfirmedZipSizeBytes: 1024,
        pendingCleanupTargetCount: 7,
        lastRetentionCleanupDeletedCount: 0,
        lastRetentionCleanupMissingCount: 0,
        lastRetentionCleanupFailedFileName: null,
        lastRetentionCleanupError: null,
        lastRetentionCleanupSkipped: false,
        lastRetentionCleanupBusy: false,
        lastRetentionCleanupAt: 1700000000000,
      });
    });

    it('保护对象包含 uploadResult + baseline + suspicious 三类文件', async () => {
      detectBackupCliffDropMock.mockReturnValue(null);
      executeRetentionCleanupMock.mockResolvedValue({ retainedCount: 5 });
      await orchestratePostBackupRetentionCleanup(
        makeInput({
          state: {
            baselineConfirmedRemoteCount: 10,
            baselineConfirmedRemoteFileName: 'SoNotes_Baseline_20250601.zip',
            cliffDropLatestRemoteFileName: 'SoNotes_Suspicious_20250610.zip',
          },
          uploadResult: makeUploadResult({ remoteFileName: 'SoNotes_Current_20250615.zip' }),
        }),
      );
      expect(executeRetentionCleanupMock).toHaveBeenCalledWith(
        expect.objectContaining({
          protectedFileNames: new Set([
            'SoNotes_Current_20250615.zip',
            'SoNotes_Baseline_20250601.zip',
            'SoNotes_Suspicious_20250610.zip',
          ]),
        }),
      );
    });

    it('有 uploadResult + baseline 时保护两者', async () => {
      detectBackupCliffDropMock.mockReturnValue(null);
      executeRetentionCleanupMock.mockResolvedValue({ retainedCount: 5 });
      await orchestratePostBackupRetentionCleanup(
        makeInput({
          state: { baselineConfirmedRemoteCount: 10 },
          uploadResult: makeUploadResult({ remoteFileName: 'SoNotes_Current_20250615.zip' }),
        }),
      );
      expect(executeRetentionCleanupMock).toHaveBeenCalledWith(
        expect.objectContaining({
          protectedFileNames: new Set([
            'SoNotes_Current_20250615.zip',
            'SoNotes_Backup_20250601000000.zip',
          ]),
        }),
      );
    });

    it('baseline 和 uploadResult 同名时去重', async () => {
      detectBackupCliffDropMock.mockReturnValue(null);
      executeRetentionCleanupMock.mockResolvedValue({ retainedCount: 5 });
      await orchestratePostBackupRetentionCleanup(
        makeInput({
          state: {
            baselineConfirmedRemoteCount: 10,
            baselineConfirmedRemoteFileName: 'SoNotes_Same_20250615.zip',
          },
          uploadResult: makeUploadResult({ remoteFileName: 'SoNotes_Same_20250615.zip' }),
        }),
      );
      expect(executeRetentionCleanupMock).toHaveBeenCalledWith(
        expect.objectContaining({
          protectedFileNames: new Set(['SoNotes_Same_20250615.zip']),
        }),
      );
    });

    it('清理失败不影响备份成功状态 — 异常被 catch，返回基线更新、错误信息和零计数', async () => {
      detectBackupCliffDropMock.mockReturnValue(null);
      executeRetentionCleanupMock.mockRejectedValue(new Error('network timeout'));
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({ state: { baselineConfirmedRemoteCount: 10 } }),
      );
      expect(result).toHaveProperty('baselineConfirmedRemoteCount', 10);
      expect(result).toHaveProperty('lastRetentionCleanupDeletedCount', 0);
      expect(result).toHaveProperty('lastRetentionCleanupMissingCount', 0);
      expect(result).toHaveProperty('lastRetentionCleanupFailedFileName', null);
      expect(result).toHaveProperty('lastRetentionCleanupError', 'network timeout');
      expect(result).toHaveProperty('lastRetentionCleanupAt');
    });

    it('清理返回 success=false 但仍返回 retainedCount', async () => {
      detectBackupCliffDropMock.mockReturnValue(null);
      executeRetentionCleanupMock.mockResolvedValue({
        success: false,
        retainedCount: 5,
        deletedCount: 0,
        missingCount: 0,
        error: '401 Unauthorized',
        failedFileName: 'SoNotes_Backup_20250610120000.zip',
      });
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({ state: { baselineConfirmedRemoteCount: 10 } }),
      );
      expect(result).toEqual({
        baselineConfirmedRemoteCount: 10,
        baselineConfirmedBoardCount: 1,
        baselineConfirmedImageNoteCount: 0,
        baselineConfirmedImageFileCount: 0,
        baselineConfirmedImageFileTotalBytes: 0,
        baselineConfirmedRemoteFileName: 'SoNotes_Backup_20250615000000.zip',
        baselineConfirmedConfirmedAt: 1700000000000,
        baselineConfirmedZipSizeBytes: 1024,
        pendingCleanupTargetCount: 5,
        lastRetentionCleanupDeletedCount: 0,
        lastRetentionCleanupMissingCount: 0,
        lastRetentionCleanupFailedFileName: 'SoNotes_Backup_20250610120000.zip',
        lastRetentionCleanupError: '401 Unauthorized',
        lastRetentionCleanupSkipped: false,
        lastRetentionCleanupBusy: false,
        lastRetentionCleanupAt: 1700000000000,
      });
    });

    it('uploadResult.remoteFileName 为 null 时不覆盖现有基线', async () => {
      detectBackupCliffDropMock.mockReturnValue(null);
      executeRetentionCleanupMock.mockResolvedValue({ retainedCount: 8 });
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({
          state: {
            baselineConfirmedRemoteCount: 10,
            baselineConfirmedRemoteFileName: 'SoNotes_Backup_20250601000000.zip',
          },
          uploadResult: makeUploadResult({ remoteFileName: null }),
        }),
      );
      expect(result).not.toHaveProperty('baselineConfirmedRemoteFileName');
      expect(result).not.toHaveProperty('baselineConfirmedConfirmedAt');
      expect(result).not.toHaveProperty('baselineConfirmedRemoteCount');
      expect(result).toHaveProperty('pendingCleanupTargetCount', 8);
      expect(result).toHaveProperty('lastRetentionCleanupSkipped', false);
    });

    it('uploadResult.remoteFileName 为 undefined 时不覆盖现有基线', async () => {
      detectBackupCliffDropMock.mockReturnValue(null);
      executeRetentionCleanupMock.mockResolvedValue({ retainedCount: 6 });
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({
          state: {
            baselineConfirmedRemoteCount: 10,
            baselineConfirmedRemoteFileName: 'SoNotes_Backup_20250601000000.zip',
          },
          uploadResult: makeUploadResult({ remoteFileName: undefined }),
        }),
      );
      expect(result).not.toHaveProperty('baselineConfirmedRemoteFileName');
      expect(result).not.toHaveProperty('baselineConfirmedConfirmedAt');
      expect(result).not.toHaveProperty('baselineConfirmedRemoteCount');
      expect(result).toHaveProperty('pendingCleanupTargetCount', 6);
    });
  });

  describe('可疑备份不自动成为新基线', () => {
    it('有基线时，断崖检测未触发 → 更新基线为当前备份', async () => {
      detectBackupCliffDropMock.mockReturnValue(null);
      executeRetentionCleanupMock.mockResolvedValue({ retainedCount: 8 });
      const state: ScheduledRemoteBackupState = {
        ...DEFAULT_STATE,
        baselineConfirmedRemoteCount: 20,
      };
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({ state }),
      );
      expect(result).toHaveProperty('baselineConfirmedRemoteCount', 10);
      expect(result).toHaveProperty('baselineConfirmedConfirmedAt', 1700000000000);
      expect(result).toHaveProperty('pendingCleanupTargetCount');
    });

    it('断崖检测触发时，不更新基线', async () => {
      detectBackupCliffDropMock.mockReturnValue({
        baselineNotes: 20,
        currentNotes: 5,
        dropPct: 0.75,
        threshold: 0.3,
        anomalyCodes: ['CLIFF_DROP_RELATIVE'],
      });
      const state: ScheduledRemoteBackupState = {
        ...DEFAULT_STATE,
        baselineConfirmedRemoteCount: 20,
      };
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({ state }),
      );
      expect(result).not.toHaveProperty('baselineConfirmedRemoteCount');
      expect(result).toHaveProperty('cliffDropDeferred', true);
      expect(result).toHaveProperty('cliffDropLatestAnomalyCodes', ['CLIFF_DROP_RELATIVE']);
    });
  });

  describe('小样本数据丢失保护', () => {
    it('baseline 4 notes / 1 board → 当前 0 notes → 跳过清理，不更新基线', async () => {
      detectBackupCliffDropMock.mockReturnValue(null);
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({
          state: {
            baselineConfirmedRemoteCount: 4,
            baselineConfirmedBoardCount: 1,
          },
          uploadResult: makeUploadResult({
            summary: {
              app: 'SoNotes',
              formatVersion: 1,
              appVersion: '1.5.7',
              createdAt: Date.now(),
              noteCount: 0,
              boardCount: 1,
              textNoteCount: 0,
              imageNoteCount: 0,
              trashNoteCount: 0,
              imageFileCount: 0,
              imageFileTotalBytes: 0,
            },
          }),
        }),
      );
      expect(result).toEqual({
        lastRetentionCleanupSkipped: true,
        lastRetentionCleanupAt: 1700000000000,
      });
      expect(executeRetentionCleanupMock).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('baselineConfirmedRemoteCount');
    });

    it('baseline 4 notes / 1 board → 当前 0 boards → 跳过清理', async () => {
      detectBackupCliffDropMock.mockReturnValue(null);
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({
          state: {
            baselineConfirmedRemoteCount: 4,
            baselineConfirmedBoardCount: 1,
          },
          uploadResult: makeUploadResult({
            summary: {
              app: 'SoNotes',
              formatVersion: 1,
              appVersion: '1.5.7',
              createdAt: Date.now(),
              noteCount: 3,
              boardCount: 0,
              textNoteCount: 3,
              imageNoteCount: 0,
              trashNoteCount: 0,
              imageFileCount: 0,
              imageFileTotalBytes: 0,
            },
          }),
        }),
      );
      expect(result).toEqual({
        lastRetentionCleanupSkipped: true,
        lastRetentionCleanupAt: 1700000000000,
      });
      expect(executeRetentionCleanupMock).not.toHaveBeenCalled();
    });

    it('baseline >= 5 notes → 不受小样本保护，正常执行清理', async () => {
      detectBackupCliffDropMock.mockReturnValue(null);
      executeRetentionCleanupMock.mockResolvedValue({ retainedCount: 5 });
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({
          state: {
            baselineConfirmedRemoteCount: 5,
            baselineConfirmedBoardCount: 1,
          },
          uploadResult: makeUploadResult({
            summary: {
              app: 'SoNotes',
              formatVersion: 1,
              appVersion: '1.5.7',
              createdAt: Date.now(),
              noteCount: 0,
              boardCount: 1,
              textNoteCount: 0,
              imageNoteCount: 0,
              trashNoteCount: 0,
              imageFileCount: 0,
              imageFileTotalBytes: 0,
            },
          }),
        }),
      );
      expect(executeRetentionCleanupMock).toHaveBeenCalled();
      expect(result).toHaveProperty('pendingCleanupTargetCount', 5);
    });

    it('baseline 3 notes / 2 boards → 当前 note 和 board 均 > 0 → 不触发小样本保护', async () => {
      detectBackupCliffDropMock.mockReturnValue(null);
      executeRetentionCleanupMock.mockResolvedValue({ retainedCount: 5 });
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({
          state: {
            baselineConfirmedRemoteCount: 3,
            baselineConfirmedBoardCount: 2,
          },
          uploadResult: makeUploadResult({
            summary: {
              app: 'SoNotes',
              formatVersion: 1,
              appVersion: '1.5.7',
              createdAt: Date.now(),
              noteCount: 2,
              boardCount: 1,
              textNoteCount: 2,
              imageNoteCount: 0,
              trashNoteCount: 0,
              imageFileCount: 0,
              imageFileTotalBytes: 0,
            },
          }),
        }),
      );
      expect(executeRetentionCleanupMock).toHaveBeenCalled();
      expect(result).toHaveProperty('pendingCleanupTargetCount', 5);
    });

    it('首次初始化（baselineConfirmedRemoteCount=null）→ 不受小样本保护，走初始化路径', async () => {
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({
          state: { baselineConfirmedRemoteCount: null },
          uploadResult: makeUploadResult({
            summary: {
              app: 'SoNotes',
              formatVersion: 1,
              appVersion: '1.5.7',
              createdAt: Date.now(),
              noteCount: 0,
              boardCount: 0,
              textNoteCount: 0,
              imageNoteCount: 0,
              trashNoteCount: 0,
              imageFileCount: 0,
              imageFileTotalBytes: 0,
            },
          }),
        }),
      );
      expect(result).toHaveProperty('baselineConfirmedRemoteCount', 0);
      expect(result).toHaveProperty('lastRetentionCleanupSkipped', true);
    });

    it('纯笔记用户（baselineBoardCount=0, boardCount=0）→ 不触发 board 保护，正常清理', async () => {
      detectBackupCliffDropMock.mockReturnValue(null);
      executeRetentionCleanupMock.mockResolvedValue({ retainedCount: 5 });
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({
          state: {
            baselineConfirmedRemoteCount: 10,
            baselineConfirmedBoardCount: 0,
          },
          uploadResult: makeUploadResult({
            summary: {
              app: 'SoNotes',
              formatVersion: 1,
              appVersion: '1.5.7',
              createdAt: Date.now(),
              noteCount: 8,
              boardCount: 0,
              textNoteCount: 8,
              imageNoteCount: 0,
              trashNoteCount: 0,
              imageFileCount: 0,
              imageFileTotalBytes: 0,
            },
          }),
        }),
      );
      expect(executeRetentionCleanupMock).toHaveBeenCalled();
      expect(result).toHaveProperty('pendingCleanupTargetCount', 5);
      expect(result.lastRetentionCleanupSkipped).toBe(false);
    });
  });

  describe('综合场景', () => {
    it('手动预览只展示数量和时间，不展示内容 — 编排器不调用预览', async () => {
      detectBackupCliffDropMock.mockReturnValue(null);
      executeRetentionCleanupMock.mockResolvedValue({ retainedCount: 3 });
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({
          trigger: 'quiet-period',
          state: { baselineConfirmedRemoteCount: 10 },
        }),
      );
      expect(executeRetentionCleanupMock).toHaveBeenCalled();
      expect(result).toHaveProperty('baselineConfirmedRemoteCount', 10);
      expect(result).toHaveProperty('pendingCleanupTargetCount', 3);
    });

    it('完整流程：scheduled-interval + 有基线 + 无断崖 → 执行清理', async () => {
      detectBackupCliffDropMock.mockReturnValue(null);
      executeRetentionCleanupMock.mockResolvedValue({
        retainedCount: 10,
        deletedCount: 0,
        missingCount: 0,
        failedFileName: null,
        error: null,
      });
      const state: ScheduledRemoteBackupState = {
        ...DEFAULT_STATE,
        baselineConfirmedRemoteCount: 12,
      };
      const input = makeInput({ state });
      const result = await orchestratePostBackupRetentionCleanup(input);
      expect(detectBackupCliffDropMock).toHaveBeenCalledWith({
        latestSummary: input.uploadResult.summary,
        baselineSummary: expect.objectContaining({ noteCount: 12 }),
        latestZipSizeBytes: 1024,
        baselineZipSizeBytes: null,
      });
      expect(executeRetentionCleanupMock).toHaveBeenCalled();
      expect(result).toEqual({
        baselineConfirmedRemoteCount: 10,
        baselineConfirmedBoardCount: 1,
        baselineConfirmedImageNoteCount: 0,
        baselineConfirmedImageFileCount: 0,
        baselineConfirmedImageFileTotalBytes: 0,
        baselineConfirmedRemoteFileName: 'SoNotes_Backup_20250615000000.zip',
        baselineConfirmedConfirmedAt: 1700000000000,
        baselineConfirmedZipSizeBytes: 1024,
        pendingCleanupTargetCount: 10,
        lastRetentionCleanupDeletedCount: 0,
        lastRetentionCleanupMissingCount: 0,
        lastRetentionCleanupFailedFileName: null,
        lastRetentionCleanupError: null,
        lastRetentionCleanupSkipped: false,
        lastRetentionCleanupBusy: false,
        lastRetentionCleanupAt: 1700000000000,
      });
    });

    it('清理任务忙碌时记录为跳过而非执行失败', async () => {
      detectBackupCliffDropMock.mockReturnValue(null);
      executeRetentionCleanupMock.mockResolvedValue({
        retainedCount: 0,
        deletedCount: 0,
        missingCount: 0,
        attemptedCount: 0,
        failedFileName: null,
        error: 'busy',
      });
      const input = makeInput({
        state: {
          ...DEFAULT_STATE,
          baselineConfirmedRemoteCount: 12,
          lastRetentionCleanupFailedFileName: 'old.zip',
          lastRetentionCleanupError: 'WebDAV 409',
        },
      });

      const result = await orchestratePostBackupRetentionCleanup(input);

      expect(result).toEqual(expect.objectContaining({
        lastRetentionCleanupDeletedCount: 0,
        lastRetentionCleanupMissingCount: 0,
        lastRetentionCleanupFailedFileName: 'old.zip',
        lastRetentionCleanupError: 'WebDAV 409',
        lastRetentionCleanupSkipped: true,
        lastRetentionCleanupBusy: true,
      }));
    });
  });
});
