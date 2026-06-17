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
  baselineConfirmedRemoteFileName: null,
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
  pendingCleanupTargetCount: null,
  lastRetentionCleanupDeletedCount: null,
  lastRetentionCleanupFailedFileName: null,
  lastRetentionCleanupError: null,
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

    it('trigger 为 before-exit → 跳过，返回空 patch', async () => {
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

    it('retentionCount=null → 跳过清理', async () => {
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
    it('无基线且有摘要 → 建立基线，跳过清理', async () => {
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({
          state: { baselineConfirmedRemoteCount: null },
          uploadResult: makeUploadResult({
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
        baselineConfirmedRemoteCount: 15,
        baselineConfirmedBoardCount: 2,
        baselineConfirmedImageNoteCount: 0,
        baselineConfirmedImageFileCount: 0,
        baselineConfirmedImageFileTotalBytes: 0,
        baselineConfirmedRemoteFileName: null,
        baselineConfirmedConfirmedAt: 1700000000000,
        baselineConfirmedZipSizeBytes: 1024,
      });
      expect(executeRetentionCleanupMock).not.toHaveBeenCalled();
      expect(detectBackupCliffDropMock).not.toHaveBeenCalled();
    });

    it('无基线且无摘要 → 跳过清理', async () => {
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({
          state: { baselineConfirmedRemoteCount: null },
          uploadResult: makeUploadResult({ summary: null }),
        }),
      );
      expect(result).toEqual({});
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
        cliffDropLatestRemoteFileName: null,
        cliffDropLatestZipSizeBytes: 1024,
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

    it('uploadResult.summary 为 null → 跳过断崖检测，直接执行清理', async () => {
      executeRetentionCleanupMock.mockResolvedValue({ retainedCount: 8 });
      await orchestratePostBackupRetentionCleanup(
        makeInput({
          state: { baselineConfirmedRemoteCount: 10 },
          uploadResult: makeUploadResult({ summary: null }),
        }),
      );
      expect(detectBackupCliffDropMock).not.toHaveBeenCalled();
      expect(executeRetentionCleanupMock).toHaveBeenCalled();
    });
  });

  describe('清理执行', () => {
    it('正常情况 → 执行清理并返回 retainedCount', async () => {
      detectBackupCliffDropMock.mockReturnValue(null);
      executeRetentionCleanupMock.mockResolvedValue({
        retainedCount: 7,
        deletedCount: 0,
        failedFileName: null,
        error: null,
      });
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({ state: { baselineConfirmedRemoteCount: 10 } }),
      );
      expect(executeRetentionCleanupMock).toHaveBeenCalledWith({
        config: DUMMY_WEBDAV_CONFIG,
        retentionCount: 10,
        protectedFileNames: new Set(),
      });
      expect(result).toEqual({
        baselineConfirmedRemoteCount: 10,
        baselineConfirmedBoardCount: 1,
        baselineConfirmedImageNoteCount: 0,
        baselineConfirmedImageFileCount: 0,
        baselineConfirmedImageFileTotalBytes: 0,
        baselineConfirmedRemoteFileName: null,
        baselineConfirmedConfirmedAt: 1700000000000,
        baselineConfirmedZipSizeBytes: 1024,
        pendingCleanupTargetCount: 7,
        lastRetentionCleanupDeletedCount: 0,
        lastRetentionCleanupFailedFileName: null,
        lastRetentionCleanupError: null,
        lastRetentionCleanupAt: 1700000000000,
      });
    });

    it('清理失败不影响备份成功状态 — 异常被 catch', async () => {
      detectBackupCliffDropMock.mockReturnValue(null);
      executeRetentionCleanupMock.mockRejectedValue(new Error('network timeout'));
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({ state: { baselineConfirmedRemoteCount: 10 } }),
      );
      expect(result).toEqual({});
    });

    it('清理返回 success=false 但仍返回 retainedCount', async () => {
      detectBackupCliffDropMock.mockReturnValue(null);
      executeRetentionCleanupMock.mockResolvedValue({
        success: false,
        retainedCount: 5,
        deletedCount: 0,
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
        baselineConfirmedRemoteFileName: null,
        baselineConfirmedConfirmedAt: 1700000000000,
        baselineConfirmedZipSizeBytes: 1024,
        pendingCleanupTargetCount: 5,
        lastRetentionCleanupDeletedCount: 0,
        lastRetentionCleanupFailedFileName: 'SoNotes_Backup_20250610120000.zip',
        lastRetentionCleanupError: '401 Unauthorized',
        lastRetentionCleanupAt: 1700000000000,
      });
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
        failedFileName: null,
        error: null,
      });
      const state: ScheduledRemoteBackupState = {
        ...DEFAULT_STATE,
        baselineConfirmedRemoteCount: 12,
      };
      const result = await orchestratePostBackupRetentionCleanup(
        makeInput({ state }),
      );
      expect(detectBackupCliffDropMock).toHaveBeenCalledWith({
        latestSummary: makeUploadResult().summary,
        baselineSummary: expect.objectContaining({ noteCount: 12 }),
      });
      expect(executeRetentionCleanupMock).toHaveBeenCalled();
      expect(result).toEqual({
        baselineConfirmedRemoteCount: 10,
        baselineConfirmedBoardCount: 1,
        baselineConfirmedImageNoteCount: 0,
        baselineConfirmedImageFileCount: 0,
        baselineConfirmedImageFileTotalBytes: 0,
        baselineConfirmedRemoteFileName: null,
        baselineConfirmedConfirmedAt: 1700000000000,
        baselineConfirmedZipSizeBytes: 1024,
        pendingCleanupTargetCount: 10,
        lastRetentionCleanupDeletedCount: 0,
        lastRetentionCleanupFailedFileName: null,
        lastRetentionCleanupError: null,
        lastRetentionCleanupAt: 1700000000000,
      });
    });
  });
});
