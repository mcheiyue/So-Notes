import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock setup — vi.mock 工厂会被提升到文件顶部，所以 mock 变量必须用 vi.hoisted
// ---------------------------------------------------------------------------

const {
  listBackupsMock,
  deleteBackupMock,
  tryStartBackupJobMock,
} = vi.hoisted(() => ({
  listBackupsMock: vi.fn(),
  deleteBackupMock: vi.fn(),
  tryStartBackupJobMock: vi.fn(),
}));

vi.mock('./WebDavBackupService', () => ({
  listBackups: listBackupsMock,
  deleteBackup: deleteBackupMock,
}));

vi.mock('./BackupJobCoordinator', () => ({
  tryStartBackupJob: tryStartBackupJobMock,
}));

import {
  previewRetentionCleanup,
  executeRetentionCleanup,
} from './RemoteBackupRetentionService';
import type { WebDavConfig } from './WebDavBackupService';
import type { WebDavRemoteBackup } from './WebDavBackupService';
import type { BackupSummary } from './BackupService';

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

const DUMMY_CONFIG: WebDavConfig = {
  serverUrl: 'https://dav.example.com',
  username: 'user',
};

function makeBackup(fileName: string): WebDavRemoteBackup {
  return { fileName, readable: true };
}

function makeHandle() {
  return {
    kind: 'remote-retention-cleanup' as const,
    startedAt: Date.now(),
    release: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe('RemoteBackupRetentionService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // previewRetentionCleanup
  // -------------------------------------------------------------------------

  describe('previewRetentionCleanup', () => {
    it('调用 listBackups 后调用 proposeRetentionCleanup，返回正确预览', async () => {
      const files: WebDavRemoteBackup[] = [
        makeBackup('SoNotes_Backup_20250610120000.zip'),
        makeBackup('SoNotes_Backup_20250611120000.zip'),
        makeBackup('SoNotes_Backup_20250612120000.zip'),
        makeBackup('SoNotes_Backup_20250613120000.zip'),
        makeBackup('SoNotes_Backup_20250614120000.zip'),
      ];

      listBackupsMock.mockResolvedValue(files);

      const result = await previewRetentionCleanup({
        config: DUMMY_CONFIG,
        retentionCount: 3,
        protectedFileNames: new Set(),
      });

      expect(listBackupsMock).toHaveBeenCalledWith(DUMMY_CONFIG);
      expect(result.candidates).toHaveLength(2);
      expect(result.keep).toHaveLength(3);
      expect(result.candidates[0]!.fileName).toBe('SoNotes_Backup_20250610120000.zip');
      expect(result.candidates[1]!.fileName).toBe('SoNotes_Backup_20250611120000.zip');
    });

    it('远端为空列表时，返回空预览', async () => {
      listBackupsMock.mockResolvedValue([]);

      const result = await previewRetentionCleanup({
        config: DUMMY_CONFIG,
        retentionCount: 5,
        protectedFileNames: new Set(),
      });

      expect(result.candidates).toHaveLength(0);
      expect(result.keep).toHaveLength(0);
    });

    it('protectedFileNames 传递到 proposeRetentionCleanup', async () => {
      const files: WebDavRemoteBackup[] = [
        makeBackup('SoNotes_Backup_20250610120000.zip'),
        makeBackup('SoNotes_Backup_20250611120000.zip'),
      ];

      listBackupsMock.mockResolvedValue(files);

      const result = await previewRetentionCleanup({
        config: DUMMY_CONFIG,
        retentionCount: 1,
        protectedFileNames: new Set(['SoNotes_Backup_20250610120000.zip']),
      });

      expect(result.candidates).toHaveLength(0);
      expect(result.keep).toHaveLength(2);
      expect(result.protectedCount).toBe(1);
    });

    it('传入 baseline 且 latestSummary 触发断崖检测时 cliffDropDetected=true', async () => {
      const files: WebDavRemoteBackup[] = [
        makeBackup('SoNotes_Backup_20250610120000.zip'),
        makeBackup('SoNotes_Backup_20250611120000.zip'),
        makeBackup('SoNotes_Backup_20250612120000.zip'),
      ];

      listBackupsMock.mockResolvedValue(files);

      const baselineSummary: BackupSummary = {
        app: 'SoNotes',
        formatVersion: 1,
        appVersion: '1.0.0',
        createdAt: 0,
        noteCount: 20,
        boardCount: 3,
        textNoteCount: 20,
        imageNoteCount: 0,
        trashNoteCount: 0,
        imageFileCount: 0,
        imageFileTotalBytes: 0,
      };

      const latestSummary: BackupSummary = {
        app: 'SoNotes',
        formatVersion: 1,
        appVersion: '1.0.0',
        createdAt: 0,
        noteCount: 2,
        boardCount: 3,
        textNoteCount: 2,
        imageNoteCount: 0,
        trashNoteCount: 0,
        imageFileCount: 0,
        imageFileTotalBytes: 0,
      };

      const result = await previewRetentionCleanup({
        config: DUMMY_CONFIG,
        retentionCount: 2,
        protectedFileNames: new Set(),
        baseline: {
          baselineSummary,
          latestSummary,
        },
      });

      expect(result.cliffDropDetected).toBe(true);
    });

    it('传入 baseline 但 latestSummary 未触发断崖检测时 cliffDropDetected=false', async () => {
      const files: WebDavRemoteBackup[] = [
        makeBackup('SoNotes_Backup_20250610120000.zip'),
        makeBackup('SoNotes_Backup_20250611120000.zip'),
      ];

      listBackupsMock.mockResolvedValue(files);

      const baselineSummary: BackupSummary = {
        app: 'SoNotes',
        formatVersion: 1,
        appVersion: '1.0.0',
        createdAt: 0,
        noteCount: 10,
        boardCount: 1,
        textNoteCount: 10,
        imageNoteCount: 0,
        trashNoteCount: 0,
        imageFileCount: 0,
        imageFileTotalBytes: 0,
      };

      const latestSummary: BackupSummary = {
        app: 'SoNotes',
        formatVersion: 1,
        appVersion: '1.0.0',
        createdAt: 0,
        noteCount: 10,
        boardCount: 1,
        textNoteCount: 10,
        imageNoteCount: 0,
        trashNoteCount: 0,
        imageFileCount: 0,
        imageFileTotalBytes: 0,
      };

      const result = await previewRetentionCleanup({
        config: DUMMY_CONFIG,
        retentionCount: 2,
        protectedFileNames: new Set(),
        baseline: {
          baselineSummary,
          latestSummary,
        },
      });

      expect(result.cliffDropDetected).toBe(false);
    });

    it('无 baseline 时 cliffDropDetected 始终为 false', async () => {
      const files: WebDavRemoteBackup[] = [
        makeBackup('SoNotes_Backup_20250610120000.zip'),
      ];

      listBackupsMock.mockResolvedValue(files);

      const result = await previewRetentionCleanup({
        config: DUMMY_CONFIG,
        retentionCount: 5,
        protectedFileNames: new Set(),
      });

      expect(result.cliffDropDetected).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // executeRetentionCleanup
  // -------------------------------------------------------------------------

  describe('executeRetentionCleanup', () => {
    it('获取不到 single-flight 锁 → 返回 busy', async () => {
      tryStartBackupJobMock.mockReturnValue(null);

      const result = await executeRetentionCleanup({
        config: DUMMY_CONFIG,
        retentionCount: 3,
        protectedFileNames: new Set(),
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('busy');
      expect(result.attemptedCount).toBe(0);
      expect(result.deletedCount).toBe(0);
      expect(result.missingCount).toBe(0);
      expect(listBackupsMock).not.toHaveBeenCalled();
    });

    it('顺序删除候选文件，正确记录 deletedCount', async () => {
      const handle = makeHandle();
      tryStartBackupJobMock.mockReturnValue(handle);

      const files: WebDavRemoteBackup[] = [
        makeBackup('SoNotes_Backup_20250610120000.zip'),
        makeBackup('SoNotes_Backup_20250611120000.zip'),
        makeBackup('SoNotes_Backup_20250612120000.zip'),
      ];

      listBackupsMock.mockResolvedValue(files);
      deleteBackupMock.mockResolvedValue({ success: true });

      const result = await executeRetentionCleanup({
        config: DUMMY_CONFIG,
        retentionCount: 1,
        protectedFileNames: new Set(),
      });

      expect(result.success).toBe(true);
      expect(result.deletedCount).toBe(2);
      expect(result.missingCount).toBe(0);
      expect(result.retainedCount).toBe(1);
      expect(result.attemptedCount).toBe(2);
      expect(result.error).toBeNull();
      expect(handle.release).toHaveBeenCalled();
    });

    it('404 按 missing 处理，不中断后续删除', async () => {
      const handle = makeHandle();
      tryStartBackupJobMock.mockReturnValue(handle);

      const files: WebDavRemoteBackup[] = [
        makeBackup('SoNotes_Backup_20250610120000.zip'),
        makeBackup('SoNotes_Backup_20250611120000.zip'),
        makeBackup('SoNotes_Backup_20250612120000.zip'),
      ];

      listBackupsMock.mockResolvedValue(files);
      deleteBackupMock
        .mockResolvedValueOnce({ success: false, error: '404 Not Found' })
        .mockResolvedValueOnce({ success: true });

      const result = await executeRetentionCleanup({
        config: DUMMY_CONFIG,
        retentionCount: 1,
        protectedFileNames: new Set(),
      });

      expect(result.success).toBe(true);
      expect(result.deletedCount).toBe(1);
      expect(result.missingCount).toBe(1);
      expect(result.attemptedCount).toBe(2);
      expect(deleteBackupMock).toHaveBeenCalledTimes(2);
    });

    it('"Not Found" 字符串也按 missing 处理', async () => {
      const handle = makeHandle();
      tryStartBackupJobMock.mockReturnValue(handle);

      const files: WebDavRemoteBackup[] = [
        makeBackup('SoNotes_Backup_20250610120000.zip'),
        makeBackup('SoNotes_Backup_20250611120000.zip'),
      ];

      listBackupsMock.mockResolvedValue(files);
      deleteBackupMock
        .mockResolvedValueOnce({ success: false, error: 'Not Found' })
        .mockResolvedValueOnce({ success: true });

      const result = await executeRetentionCleanup({
        config: DUMMY_CONFIG,
        retentionCount: 0,
        protectedFileNames: new Set(),
      });

      expect(result.missingCount).toBe(1);
      expect(result.deletedCount).toBe(1);
    });

    it('401 错误停止后续删除', async () => {
      const handle = makeHandle();
      tryStartBackupJobMock.mockReturnValue(handle);

      const files: WebDavRemoteBackup[] = [
        makeBackup('SoNotes_Backup_20250610120000.zip'),
        makeBackup('SoNotes_Backup_20250611120000.zip'),
        makeBackup('SoNotes_Backup_20250612120000.zip'),
      ];

      listBackupsMock.mockResolvedValue(files);
      deleteBackupMock
        .mockResolvedValueOnce({ success: false, error: '401 Unauthorized' })
        .mockResolvedValueOnce({ success: true });

      const result = await executeRetentionCleanup({
        config: DUMMY_CONFIG,
        retentionCount: 0,
        protectedFileNames: new Set(),
      });

      expect(result.success).toBe(false);
      expect(result.deletedCount).toBe(0);
      expect(result.failedFileName).toBe('SoNotes_Backup_20250610120000.zip');
      expect(result.stoppedAtFileName).toBe('SoNotes_Backup_20250610120000.zip');
      expect(result.error).toContain('401');
      // 第二个文件不应被调用
      expect(deleteBackupMock).toHaveBeenCalledTimes(1);
    });

    it('403 错误停止后续删除', async () => {
      const handle = makeHandle();
      tryStartBackupJobMock.mockReturnValue(handle);

      const files: WebDavRemoteBackup[] = [
        makeBackup('SoNotes_Backup_20250610120000.zip'),
        makeBackup('SoNotes_Backup_20250611120000.zip'),
      ];

      listBackupsMock.mockResolvedValue(files);
      deleteBackupMock.mockResolvedValue({ success: false, error: '403 Forbidden' });

      const result = await executeRetentionCleanup({
        config: DUMMY_CONFIG,
        retentionCount: 0,
        protectedFileNames: new Set(),
      });

      expect(result.success).toBe(false);
      expect(result.failedFileName).toBe('SoNotes_Backup_20250610120000.zip');
      expect(result.error).toContain('403');
      expect(deleteBackupMock).toHaveBeenCalledTimes(1);
    });

    it('423 错误停止后续删除', async () => {
      const handle = makeHandle();
      tryStartBackupJobMock.mockReturnValue(handle);

      const files: WebDavRemoteBackup[] = [
        makeBackup('SoNotes_Backup_20250610120000.zip'),
        makeBackup('SoNotes_Backup_20250611120000.zip'),
      ];

      listBackupsMock.mockResolvedValue(files);
      deleteBackupMock.mockResolvedValue({ success: false, error: '423 Locked' });

      const result = await executeRetentionCleanup({
        config: DUMMY_CONFIG,
        retentionCount: 0,
        protectedFileNames: new Set(),
      });

      expect(result.success).toBe(false);
      expect(result.failedFileName).toBe('SoNotes_Backup_20250610120000.zip');
      expect(result.error).toContain('423');
    });

    it('5xx 错误停止后续删除', async () => {
      const handle = makeHandle();
      tryStartBackupJobMock.mockReturnValue(handle);

      const files: WebDavRemoteBackup[] = [
        makeBackup('SoNotes_Backup_20250610120000.zip'),
        makeBackup('SoNotes_Backup_20250611120000.zip'),
      ];

      listBackupsMock.mockResolvedValue(files);
      deleteBackupMock.mockResolvedValue({ success: false, error: '500 Internal Server Error' });

      const result = await executeRetentionCleanup({
        config: DUMMY_CONFIG,
        retentionCount: 0,
        protectedFileNames: new Set(),
      });

      expect(result.success).toBe(false);
      expect(result.failedFileName).toBe('SoNotes_Backup_20250610120000.zip');
      expect(result.error).toContain('500');
    });

    it('无候选文件时直接返回成功', async () => {
      const handle = makeHandle();
      tryStartBackupJobMock.mockReturnValue(handle);

      listBackupsMock.mockResolvedValue([]);

      const result = await executeRetentionCleanup({
        config: DUMMY_CONFIG,
        retentionCount: 5,
        protectedFileNames: new Set(),
      });

      expect(result.success).toBe(true);
      expect(result.deletedCount).toBe(0);
      expect(result.missingCount).toBe(0);
      expect(result.attemptedCount).toBe(0);
      expect(deleteBackupMock).not.toHaveBeenCalled();
    });

    it('always releases handle even on error', async () => {
      const handle = makeHandle();
      tryStartBackupJobMock.mockReturnValue(handle);

      listBackupsMock.mockRejectedValue(new Error('network error'));

      await expect(
        executeRetentionCleanup({
          config: DUMMY_CONFIG,
          retentionCount: 3,
          protectedFileNames: new Set(),
        }),
      ).rejects.toThrow('network error');

      expect(handle.release).toHaveBeenCalled();
    });

    it('部分成功：先删一个成功，再遇到 404，再删一个成功', async () => {
      const handle = makeHandle();
      tryStartBackupJobMock.mockReturnValue(handle);

      const files: WebDavRemoteBackup[] = [
        makeBackup('SoNotes_Backup_20250610120000.zip'),
        makeBackup('SoNotes_Backup_20250611120000.zip'),
        makeBackup('SoNotes_Backup_20250612120000.zip'),
      ];

      listBackupsMock.mockResolvedValue(files);
      deleteBackupMock
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: false, error: '404 Not Found' })
        .mockResolvedValueOnce({ success: true });

      const result = await executeRetentionCleanup({
        config: DUMMY_CONFIG,
        retentionCount: 0,
        protectedFileNames: new Set(),
      });

      expect(result.success).toBe(true);
      expect(result.deletedCount).toBe(2);
      expect(result.missingCount).toBe(1);
      expect(result.attemptedCount).toBe(3);
    });
  });
});
