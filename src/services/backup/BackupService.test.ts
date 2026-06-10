import { describe, it, expect, vi, beforeEach } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { createLocalBackup, restoreLocalBackup, validateLocalBackup } from './BackupService';

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

  describe('validateLocalBackup', () => {
    it('调用 validate_local_backup 命令并传递 sourceZipPath', async () => {
      const expected = {
        ok: true,
        summary: {
          app: 'SoNotes',
          formatVersion: 1,
          appVersion: '1.5.2',
          createdAt: 1718000000000,
          noteCount: 42,
          boardCount: 3,
          textNoteCount: 36,
          imageNoteCount: 6,
          trashNoteCount: 2,
          imageFileCount: 6,
          imageFileTotalBytes: 1048576,
        },
        errors: [],
        warnings: [],
      };
      invokeMock.mockResolvedValueOnce(expected);

      const result = await validateLocalBackup('/backups/SoNotes-backup.zip');

      expect(invokeMock).toHaveBeenCalledWith('validate_local_backup', {
        sourceZipPath: '/backups/SoNotes-backup.zip',
      });
      expect(result).toEqual(expected);
    });

    it('透传验证失败结果（ok: false + errors）', async () => {
      const failed = {
        ok: false,
        summary: null,
        errors: [
          {
            code: 'missing_manifest',
            severity: 'error',
            message: '备份文件缺少 manifest.json',
            target: 'zip',
          },
        ],
        warnings: [],
      };
      invokeMock.mockResolvedValueOnce(failed);

      const result = await validateLocalBackup('/bad/backup.zip');

      expect(result.ok).toBe(false);
      expect(result.summary).toBeNull();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('missing_manifest');
      expect(result.warnings).toEqual([]);
    });

    it('透传含可选字段的验证问题', async () => {
      const resultWithOptionals = {
        ok: false,
        summary: null,
        errors: [
          {
            code: 'image_file_hash_mismatch',
            severity: 'error',
            message: '图片文件 hash 不匹配',
            target: 'image_file',
            path: 'attachments/abc123.png',
            noteId: 'note-1',
            imageFileId: 'img-1',
          },
        ],
        warnings: [],
      };
      invokeMock.mockResolvedValueOnce(resultWithOptionals);

      const result = await validateLocalBackup('/backup.zip');

      expect(result.errors[0].path).toBe('attachments/abc123.png');
      expect(result.errors[0].noteId).toBe('note-1');
      expect(result.errors[0].imageFileId).toBe('img-1');
    });

    it('invoke reject 时抛出错误', async () => {
      invokeMock.mockRejectedValueOnce(new Error('系统异常'));

      await expect(validateLocalBackup('/backup.zip')).rejects.toThrow('系统异常');
    });
  });
});
