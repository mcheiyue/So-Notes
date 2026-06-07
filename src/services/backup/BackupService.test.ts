import { describe, it, expect, vi, beforeEach } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { createLocalBackup, restoreLocalBackup } from './BackupService';

describe('BackupService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createLocalBackup', () => {
    it('调用 create_local_backup 命令并传递 targetPath', async () => {
      const expected = {
        success: true,
        backupPath: '/backups/SoNotes-backup.zip',
        noteCount: 5,
        boardCount: 1,
        attachmentCount: 3,
      };
      invokeMock.mockResolvedValueOnce(expected);

      const result = await createLocalBackup('/backups/SoNotes-backup.zip');

      expect(invokeMock).toHaveBeenCalledWith('create_local_backup', {
        targetPath: '/backups/SoNotes-backup.zip',
      });
      expect(result).toEqual(expected);
    });

    it('传播 Rust 侧返回的失败结果', async () => {
      const failed = {
        success: false,
        noteCount: 0,
        boardCount: 0,
        attachmentCount: 0,
        error: 'data.json 不存在',
      };
      invokeMock.mockResolvedValueOnce(failed);

      const result = await createLocalBackup('/bad/path.zip');

      expect(result.success).toBe(false);
      expect(result.error).toBe('data.json 不存在');
    });
  });

  describe('restoreLocalBackup', () => {
    it('调用 restore_local_backup 命令并传递 sourceZipPath', async () => {
      const expected = {
        success: true,
        noteCount: 10,
        boardCount: 2,
        attachmentCount: 7,
      };
      invokeMock.mockResolvedValueOnce(expected);

      const result = await restoreLocalBackup('/backups/SoNotes-backup.zip');

      expect(invokeMock).toHaveBeenCalledWith('restore_local_backup', {
        sourceZipPath: '/backups/SoNotes-backup.zip',
      });
      expect(result).toEqual(expected);
    });

    it('传播 Rust 侧返回的失败结果', async () => {
      const failed = {
        success: false,
        noteCount: 0,
        boardCount: 0,
        attachmentCount: 0,
        error: '清单验证失败',
      };
      invokeMock.mockResolvedValueOnce(failed);

      const result = await restoreLocalBackup('/bad/backup.zip');

      expect(result.success).toBe(false);
      expect(result.error).toBe('清单验证失败');
    });
  });
});
