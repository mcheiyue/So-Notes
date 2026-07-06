import { describe, it, expect, vi, beforeEach } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import {
  loadRecentActivities,
  appendBackupActivity,
  clearBackupActivities,
  sanitizeActivityInput,
  fileNameFromPath,
  toBackupActivitySummary,
} from './BackupActivityLogService';
import type {
  BackupActivityAppendInput,
  BackupActivityEntry,
} from './BackupActivityLogService';

describe('BackupActivityLogService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // loadRecentActivities
  // -----------------------------------------------------------------------

  describe('loadRecentActivities', () => {
    it('调用 backup_activity_list 命令并传递 limit', async () => {
      const expected: BackupActivityEntry[] = [
        {
          id: 'abc-123',
          operation: 'local-backup',
          status: 'success',
          level: 'info',
          startedAt: 1718000000000,
          finishedAt: 1718000001000,
        },
      ];
      invokeMock.mockResolvedValueOnce(expected);

      const result = await loadRecentActivities(5);

      expect(invokeMock).toHaveBeenCalledWith('backup_activity_list', {
        limit: 5,
      });
      expect(result).toEqual(expected);
    });

    it('limit 省略时传递 undefined', async () => {
      invokeMock.mockResolvedValueOnce([]);

      await loadRecentActivities();

      expect(invokeMock).toHaveBeenCalledWith('backup_activity_list', {
        limit: undefined,
      });
    });

    it('invoke 失败时向上抛出异常', async () => {
      invokeMock.mockRejectedValueOnce(new Error('IPC 通道断开'));

      await expect(loadRecentActivities(10)).rejects.toThrow('IPC 通道断开');
    });
  });

  // -----------------------------------------------------------------------
  // appendBackupActivity
  // -----------------------------------------------------------------------

  describe('appendBackupActivity', () => {
    it('调用 backup_activity_append 命令并自动生成 id', async () => {
      invokeMock.mockResolvedValueOnce(undefined);

      const input: BackupActivityAppendInput = {
        operation: 'remote-backup',
        status: 'success',
        level: 'info',
        startedAt: 1718000000000,
        finishedAt: 1718000002000,
      };

      await appendBackupActivity(input);

      expect(invokeMock).toHaveBeenCalledTimes(1);
      const [command, payload] = invokeMock.mock.calls[0];
      expect(command).toBe('backup_activity_append');
      expect(payload.entry).toMatchObject({
        operation: 'remote-backup',
        status: 'success',
        level: 'info',
        startedAt: 1718000000000,
        finishedAt: 1718000002000,
      });
      // 自动生成了 UUID 格式的 id
      expect(payload.entry.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('保留调用方提供的 id', async () => {
      invokeMock.mockResolvedValueOnce(undefined);

      const input: BackupActivityAppendInput = {
        id: 'custom-id-001',
        operation: 'local-restore',
        status: 'failed',
        level: 'error',
        startedAt: 1718000000000,
        finishedAt: 1718000003000,
      };

      await appendBackupActivity(input);

      const [, payload] = invokeMock.mock.calls[0];
      expect(payload.entry.id).toBe('custom-id-001');
    });

    it('invoke reject 时不抛出，仅 console.warn', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      invokeMock.mockRejectedValueOnce(new Error('磁盘已满'));

      const input: BackupActivityAppendInput = {
        operation: 'scheduled-remote-backup',
        status: 'success',
        level: 'info',
        startedAt: 1718000000000,
        finishedAt: 1718000004000,
      };

      // 不应抛出
      await expect(appendBackupActivity(input)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        '[BackupActivityLog] appendBackupActivity failed:',
        '磁盘已满',
      );
      warnSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // clearBackupActivities
  // -----------------------------------------------------------------------

  describe('clearBackupActivities', () => {
    it('调用 backup_activity_clear 命令', async () => {
      invokeMock.mockResolvedValueOnce(undefined);

      await clearBackupActivities();

      expect(invokeMock).toHaveBeenCalledWith('backup_activity_clear');
    });

    it('invoke 失败时抛出异常', async () => {
      invokeMock.mockRejectedValueOnce(new Error('文件被占用'));

      await expect(clearBackupActivities()).rejects.toThrow('文件被占用');
    });
  });

  // -----------------------------------------------------------------------
  // sanitizeActivityInput
  // -----------------------------------------------------------------------

  describe('sanitizeActivityInput', () => {
    const baseInput: BackupActivityAppendInput = {
      operation: 'remote-backup',
      status: 'success',
      level: 'info',
      startedAt: 1718000000000,
      finishedAt: 1718000001000,
    };

    it('替换 message 中的 password 关键词', () => {
      const result = sanitizeActivityInput({
        ...baseInput,
        message: '连接失败，password 无效',
      });
      expect(result.message).toBe('连接失败，password=[REDACTED] 无效');
    });

    it('替换 message 中的 token 关键词', () => {
      const result = sanitizeActivityInput({
        ...baseInput,
        message: 'token expired',
      });
      expect(result.message).toBe('token=[REDACTED] expired');
    });

    it('替换 message 中全角冒号分隔的敏感词', () => {
      const result = sanitizeActivityInput({
        ...baseInput,
        message: '密码：hunter2，令牌：abc，token：abc',
      });
      expect(result.message).toBe(
        '密码=[REDACTED]，令牌=[REDACTED]，token=[REDACTED]',
      );
    });

    it('替换 message 中的 authorization 关键词', () => {
      const result = sanitizeActivityInput({
        ...baseInput,
        message: 'Authorization: Bearer abc123',
      });
      expect(result.message).toBe('authorization=[REDACTED] [REDACTED]');
    });

    it('替换 message 中的 secret 关键词', () => {
      const result = sanitizeActivityInput({
        ...baseInput,
        message: 'secret_key=xyz',
      });
      expect(result.message).toBe('secret=[REDACTED]');
    });

    it('移除 URL 中的 userinfo', () => {
      const result = sanitizeActivityInput({
        ...baseInput,
        message: '请求 https://user:pass@example.com 失败',
      });
      expect(result.message).toBe(
        '请求 [URL_REDACTED] 失败',
      );
    });

    it('替换 Bearer token', () => {
      const result = sanitizeActivityInput({
        ...baseInput,
        message: 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      });
      expect(result.message).toBe('authorization=[REDACTED] [REDACTED]');
    });

    it('替换 message 中的绝对路径', () => {
      const result = sanitizeActivityInput({
        ...baseInput,
        message: '备份目标目录不存在: D:\\Github\\So-Notes\\backups',
      });
      expect(result.message).toBe('备份目标目录不存在: [REDACTED]');
    });

    it('替换 message 中的 Unix 绝对路径', () => {
      const result = sanitizeActivityInput({
        ...baseInput,
        message: '读取失败: /home/user/.local/share/sonotes/data.json',
      });
      expect(result.message).toBe('读取失败: [REDACTED]');
    });

    it('替换 message 中带空格的 Windows 路径', () => {
      const result = sanitizeActivityInput({
        ...baseInput,
        message: '备份目标目录不存在: C:\\Users\\Jane Doe\\So Notes\\backups',
      });
      expect(result.message).toBe('备份目标目录不存在: [REDACTED]');
    });

    it('替换 message 中带空格的 Unix 路径', () => {
      const result = sanitizeActivityInput({
        ...baseInput,
        message: '读取失败: /Users/Jane Doe/So Notes/data.json',
      });
      expect(result.message).toBe('读取失败: [REDACTED]');
    });

    it('截断超过 240 字符的 message', () => {
      const longMessage = 'a'.repeat(300);
      const result = sanitizeActivityInput({
        ...baseInput,
        message: longMessage,
      });
      expect(result.message).toHaveLength(240);
    });

    it('message 为 null 时保持 null', () => {
      const result = sanitizeActivityInput({
        ...baseInput,
        message: null,
      });
      expect(result.message).toBeNull();
    });

    it('message 为 undefined 时保持 undefined', () => {
      const result = sanitizeActivityInput({
        ...baseInput,
      });
      expect(result.message).toBeUndefined();
    });

    it('localFileName 只保留 basename', () => {
      const result = sanitizeActivityInput({
        ...baseInput,
        localFileName: '/home/user/backups/note-backup.zip',
      });
      expect(result.localFileName).toBe('note-backup.zip');
    });

    it('remoteFileName 只保留 basename', () => {
      const result = sanitizeActivityInput({
        ...baseInput,
        remoteFileName: 'remote/backups/note-backup.zip',
      });
      expect(result.remoteFileName).toBe('note-backup.zip');
    });

    it('文件名不含路径分隔符时保持原值', () => {
      const result = sanitizeActivityInput({
        ...baseInput,
        localFileName: 'note-backup.zip',
      });
      expect(result.localFileName).toBe('note-backup.zip');
    });

    it('metrics.failedFileName 只保留 basename', () => {
      const result = sanitizeActivityInput({
        ...baseInput,
        metrics: {
          failedFileName: '/home/user/backups/SoNotes_Backup_20260626120000.zip',
        },
      });
      expect(result.metrics?.failedFileName).toBe('SoNotes_Backup_20260626120000.zip');
    });

    it('metrics 为 null 时保持 null', () => {
      const result = sanitizeActivityInput({
        ...baseInput,
        metrics: null,
      });
      expect(result.metrics).toBeNull();
    });

    it('同时包含敏感词和长消息时正确处理', () => {
      const result = sanitizeActivityInput({
        ...baseInput,
        message: 'password: abcdef ' + 'x'.repeat(300),
      });
      // 先替换再截断
      expect(result.message).toHaveLength(240);
      expect(result.message).toContain('password=[REDACTED]');
    });

    it('脱敏 message 中的 HTTPS URL', () => {
      const result = sanitizeActivityInput({
        ...baseInput,
        message: 'WebDAV 连接失败 https://dav.example.com/remote.php/dav/files/user/',
      });
      expect(result.message).toBe('WebDAV 连接失败 [URL_REDACTED]');
    });

    it('脱敏 message 中的 HTTP URL（含端口）', () => {
      const result = sanitizeActivityInput({
        ...baseInput,
        message: '无法访问 http://192.168.1.100:5000/webdav',
      });
      expect(result.message).toBe('无法访问 [URL_REDACTED]');
    });
  });

  // -----------------------------------------------------------------------
  // fileNameFromPath
  // -----------------------------------------------------------------------

  describe('fileNameFromPath', () => {
    it('提取 Unix 风格路径的 basename', () => {
      expect(fileNameFromPath('/home/user/backups/backup.zip')).toBe(
        'backup.zip',
      );
    });

    it('提取 Windows 风格路径的 basename', () => {
      expect(
        fileNameFromPath('C:\\Users\\user\\backups\\backup.zip'),
      ).toBe('backup.zip');
    });

    it('无路径分隔符时返回原值', () => {
      expect(fileNameFromPath('backup.zip')).toBe('backup.zip');
    });

    it('空字符串返回空字符串', () => {
      expect(fileNameFromPath('')).toBe('');
    });
  });

  // -----------------------------------------------------------------------
  // toBackupActivitySummary
  // -----------------------------------------------------------------------

  describe('toBackupActivitySummary', () => {
    it('从 BackupSummary 提取完整统计', () => {
      const summary = {
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
      };

      const result = toBackupActivitySummary(summary);

      expect(result).toEqual({
        noteCount: 42,
        boardCount: 3,
        textNoteCount: 36,
        imageNoteCount: 6,
        trashNoteCount: 2,
        imageFileCount: 6,
        imageFileTotalBytes: 1048576,
      });
    });

    it('从含 summary 的 BackupResult 提取统计', () => {
      const result = {
        success: true,
        noteCount: 10,
        boardCount: 2,
        attachmentCount: 5,
        summary: {
          app: 'SoNotes',
          formatVersion: 1,
          appVersion: '1.5.2',
          createdAt: 1718000000000,
          noteCount: 10,
          boardCount: 2,
          textNoteCount: 8,
          imageNoteCount: 2,
          trashNoteCount: 0,
          imageFileCount: 5,
          imageFileTotalBytes: 512000,
        },
      };

      const summary = toBackupActivitySummary(result);

      expect(summary).toEqual({
        noteCount: 10,
        boardCount: 2,
        textNoteCount: 8,
        imageNoteCount: 2,
        trashNoteCount: 0,
        imageFileCount: 5,
        imageFileTotalBytes: 512000,
      });
    });

    it('从不含 summary 的 BackupResult 仅提取 noteCount/boardCount', () => {
      const result = {
        success: true,
        noteCount: 5,
        boardCount: 1,
        attachmentCount: 3,
        summary: null,
      };

      const summary = toBackupActivitySummary(result);

      expect(summary).toEqual({
        noteCount: 5,
        boardCount: 1,
        imageFileCount: 3,
      });
    });

    it('null 输入返回 null', () => {
      expect(toBackupActivitySummary(null)).toBeNull();
    });

    it('undefined 输入返回 null', () => {
      expect(toBackupActivitySummary(undefined)).toBeNull();
    });

    it('非对象输入返回 null', () => {
      expect(toBackupActivitySummary('string')).toBeNull();
      expect(toBackupActivitySummary(42)).toBeNull();
    });

    it('空对象返回 null', () => {
      expect(toBackupActivitySummary({})).toBeNull();
    });
  });
});
