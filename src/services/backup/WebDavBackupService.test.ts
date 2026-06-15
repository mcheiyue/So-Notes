import { describe, it, expect, vi, beforeEach } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import {
  loadConfig,
  saveConfig,
  clearConfig,
  testConnection,
  createRemoteBackup,
  listBackups,
  downloadBackup,
  deleteBackup,
  resolveDownloadedBackup,
  cleanupDownloadedBackup,
  normalizeErrorStage,
} from './WebDavBackupService';

describe('WebDavBackupService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 配置管理
  // -------------------------------------------------------------------------

  describe('loadConfig', () => {
    it('调用 webdav_load_config 命令', async () => {
      const expected = {
        success: true,
        serverUrl: 'https://example.com',
        username: 'user',
        remoteDir: 'SoNotes_Backups/',
        passwordSaved: false,
      };
      invokeMock.mockResolvedValueOnce(expected);

      const result = await loadConfig();

      expect(invokeMock).toHaveBeenCalledWith('webdav_load_config');
      expect(result).toEqual(expected);
    });

    it('文件不存在时返回空配置（success=true）', async () => {
      const expected = {
        success: true,
        serverUrl: null,
        username: null,
        remoteDir: null,
        passwordSaved: false,
      };
      invokeMock.mockResolvedValueOnce(expected);

      const result = await loadConfig();

      expect(result.success).toBe(true);
      expect(result.serverUrl).toBeNull();
    });

    it('传播 Rust 侧返回的失败结果', async () => {
      const failed = {
        success: false,
        passwordSaved: false,
        error: '读取 WebDAV 配置文件失败',
      };
      invokeMock.mockResolvedValueOnce(failed);

      const result = await loadConfig();

      expect(result.success).toBe(false);
      expect(result.error).toBe('读取 WebDAV 配置文件失败');
    });
  });

  describe('saveConfig', () => {
    it('调用 webdav_save_config 命令并传递 request', async () => {
      const request = {
        serverUrl: 'https://example.com',
        username: 'user',
        remoteDir: 'SoNotes_Backups/',
        rememberPassword: false,
        password: 'secret',
      };
      const expected = { success: true };
      invokeMock.mockResolvedValueOnce(expected);

      const result = await saveConfig(request);

      expect(invokeMock).toHaveBeenCalledWith('webdav_save_config', {
        request,
      });
      expect(result).toEqual(expected);
    });

    it('传播 Rust 侧返回的失败结果', async () => {
      const request = {
        serverUrl: 'https://example.com',
        username: 'user',
        rememberPassword: true,
        password: 'secret',
      };
      const failed = {
        success: false,
        error: '系统密钥链尚未实现，无法安全存储密码',
      };
      invokeMock.mockResolvedValueOnce(failed);

      const result = await saveConfig(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('密钥链');
    });

    it('保存成功含 warning 时返回 warning', async () => {
      const request = {
        serverUrl: 'https://example.com',
        username: 'user',
        rememberPassword: false,
      };
      const expected = {
        success: true,
        warning: '配置已更新，但系统凭据可能需要手动删除',
      };
      invokeMock.mockResolvedValueOnce(expected);

      const result = await saveConfig(request);

      expect(result.success).toBe(true);
      expect(result.warning).toBe('配置已更新，但系统凭据可能需要手动删除');
    });
  });

  describe('clearConfig', () => {
    it('调用 webdav_clear_config 命令', async () => {
      const expected = { success: true };
      invokeMock.mockResolvedValueOnce(expected);

      const result = await clearConfig();

      expect(invokeMock).toHaveBeenCalledWith('webdav_clear_config');
      expect(result).toEqual(expected);
    });

    it('配置文件不存在时仍返回成功', async () => {
      const expected = { success: true };
      invokeMock.mockResolvedValueOnce(expected);

      const result = await clearConfig();

      expect(result.success).toBe(true);
    });

    it('传播 Rust 侧返回的失败结果', async () => {
      const failed = {
        success: false,
        error: '删除 WebDAV 配置文件失败',
      };
      invokeMock.mockResolvedValueOnce(failed);

      const result = await clearConfig();

      expect(result.success).toBe(false);
      expect(result.error).toBe('删除 WebDAV 配置文件失败');
    });

    it('清除成功含 secretCleanupWarning 时返回 warning', async () => {
      const expected = {
        success: true,
        secretCleanupWarning: '配置文件已删除，但密钥链 secret 未清理',
      };
      invokeMock.mockResolvedValueOnce(expected);

      const result = await clearConfig();

      expect(result.success).toBe(true);
      expect(result.secretCleanupWarning).toBe('配置文件已删除，但密钥链 secret 未清理');
    });
  });

  // -------------------------------------------------------------------------
  // 连接测试
  // -------------------------------------------------------------------------

  describe('testConnection', () => {
    it('调用 webdav_test_connection 命令并传递 config', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
        remoteDir: 'SoNotes_Backups/',
        password: 'secret',
      };
      const expected = { success: true };
      invokeMock.mockResolvedValueOnce(expected);

      const result = await testConnection(config);

      expect(invokeMock).toHaveBeenCalledWith('webdav_test_connection', {
        config,
      });
      expect(result).toEqual(expected);
    });

    it('传播鉴权失败结果', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
        password: 'wrong',
      };
      const failed = {
        success: false,
        error: 'WebDAV 鉴权失败',
      };
      invokeMock.mockResolvedValueOnce(failed);

      const result = await testConnection(config);

      expect(result.success).toBe(false);
      expect(result.error).toBe('WebDAV 鉴权失败');
    });

    it('传播地址不可访问结果', async () => {
      const config = {
        serverUrl: 'https://unreachable.example.com',
        username: 'user',
      };
      const failed = {
        success: false,
        error: 'WebDAV 地址不可访问',
      };
      invokeMock.mockResolvedValueOnce(failed);

      const result = await testConnection(config);

      expect(result.success).toBe(false);
      expect(result.error).toBe('WebDAV 地址不可访问');
    });
  });

  // -------------------------------------------------------------------------
  // 远端备份操作
  // -------------------------------------------------------------------------

  describe('createRemoteBackup', () => {
    it('调用 webdav_create_remote_backup 命令并传递 config（无本地路径）', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
        remoteDir: 'SoNotes_Backups/',
        password: 'secret',
      };
      const expected = {
        success: true,
        remoteFileName: 'SoNotes_Backup_20240101120000.zip',
        errorStage: 'unknown',
      };
      invokeMock.mockResolvedValueOnce(expected);

      const result = await createRemoteBackup(config);

      expect(invokeMock).toHaveBeenCalledWith('webdav_create_remote_backup', {
        config,
      });
      expect(result).toEqual(expected);
      expect(result.remoteFileName).toBe('SoNotes_Backup_20240101120000.zip');
    });

    it('传播 Rust 侧返回的失败结果', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
      };
      const failed = {
        success: false,
        error: '远端备份上传失败，本地数据未受影响',
      };
      invokeMock.mockResolvedValueOnce(failed);

      const result = await createRemoteBackup(config);

      expect(result.success).toBe(false);
      expect(result.error).toContain('上传失败');
    });

    it('凭据相关错误消息映射为 credential 阶段 (keyring)', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
      };
      invokeMock.mockRejectedValueOnce(new Error('Failed to read from keyring'));

      const result = await createRemoteBackup(config);

      expect(result.success).toBe(false);
      expect(result.errorStage).toBe('credential');
    });

    it('凭据相关错误消息映射为 credential 阶段 (password)', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
      };
      invokeMock.mockRejectedValueOnce(new Error('Invalid password provided'));

      const result = await createRemoteBackup(config);

      expect(result.success).toBe(false);
      expect(result.errorStage).toBe('credential');
    });

    it('凭据相关错误消息映射为 credential 阶段 (凭据)', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
      };
      invokeMock.mockRejectedValueOnce(new Error('系统凭据读取失败'));

      const result = await createRemoteBackup(config);

      expect(result.success).toBe(false);
      expect(result.errorStage).toBe('credential');
    });

    it('凭据相关错误消息映射为 credential 阶段 (密码)', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
      };
      invokeMock.mockRejectedValueOnce(new Error('密码存储服务不可用'));

      const result = await createRemoteBackup(config);

      expect(result.success).toBe(false);
      expect(result.errorStage).toBe('credential');
    });

    it('凭据相关错误消息映射为 credential 阶段 (credential)', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
      };
      invokeMock.mockRejectedValueOnce(new Error('Credential store access denied'));

      const result = await createRemoteBackup(config);

      expect(result.success).toBe(false);
      expect(result.errorStage).toBe('credential');
    });

    it('非凭据错误映射为 unknown 阶段', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
      };
      invokeMock.mockRejectedValueOnce(new Error('Network timeout'));

      const result = await createRemoteBackup(config);

      expect(result.success).toBe(false);
      expect(result.errorStage).toBe('unknown');
    });

    it('Rust 返回 Ok{success:false, errorStage:"auth"} 时映射为 credential', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
      };
      invokeMock.mockResolvedValueOnce({
        success: false,
        error: 'Authentication failed',
        errorStage: 'auth',
      });

      const result = await createRemoteBackup(config);

      expect(result.success).toBe(false);
      expect(result.errorStage).toBe('credential');
    });

    it('Rust 返回 Ok{success:false, errorStage:"read_local_file"} 时映射为 create-zip', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
      };
      invokeMock.mockResolvedValueOnce({
        success: false,
        error: 'Failed to read local file',
        errorStage: 'read_local_file',
      });

      const result = await createRemoteBackup(config);

      expect(result.success).toBe(false);
      expect(result.errorStage).toBe('create-zip');
    });

    it('Rust 返回 Ok{success:false, errorStage:"ensure_dir", errorCode:"401"} 时映射为 credential', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
      };
      invokeMock.mockResolvedValueOnce({
        success: false,
        error: 'Failed to ensure remote directory',
        errorStage: 'ensure_dir',
        errorCode: '401',
      });

      const result = await createRemoteBackup(config);

      expect(result.success).toBe(false);
      expect(result.errorStage).toBe('credential');
    });

    it('Rust 返回 Ok{success:false, errorStage:"ensure_dir", errorCode:"500"} 时映射为 upload', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
      };
      invokeMock.mockResolvedValueOnce({
        success: false,
        error: 'Failed to ensure remote directory',
        errorStage: 'ensure_dir',
        errorCode: '500',
      });

      const result = await createRemoteBackup(config);

      expect(result.success).toBe(false);
      expect(result.errorStage).toBe('upload');
    });

    it('Rust 返回 Ok{success:false, errorStage:"network"} 时映射为 upload', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
      };
      invokeMock.mockResolvedValueOnce({
        success: false,
        error: 'Network error',
        errorStage: 'network',
      });

      const result = await createRemoteBackup(config);

      expect(result.success).toBe(false);
      expect(result.errorStage).toBe('upload');
    });

    it('Rust 返回 Ok{success:false, errorStage:"upload_retry_exhausted"} 时映射为 upload', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
      };
      invokeMock.mockResolvedValueOnce({
        success: false,
        error: 'Upload retries exhausted',
        errorStage: 'upload_retry_exhausted',
      });

      const result = await createRemoteBackup(config);

      expect(result.success).toBe(false);
      expect(result.errorStage).toBe('upload');
    });

    it('Rust 返回 Ok{success:false, errorStage:"lock"} 时映射为 single-flight', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
      };
      invokeMock.mockResolvedValueOnce({
        success: false,
        error: 'File lock error',
        errorStage: 'lock',
      });

      const result = await createRemoteBackup(config);

      expect(result.success).toBe(false);
      expect(result.errorStage).toBe('single-flight');
    });

    it('Rust 返回未知 errorStage 时映射为 unknown', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
      };
      invokeMock.mockResolvedValueOnce({
        success: false,
        error: 'Some error',
        errorStage: 'some_future_stage',
      });

      const result = await createRemoteBackup(config);

      expect(result.success).toBe(false);
      expect(result.errorStage).toBe('unknown');
    });

    it('Rust 返回 undefined errorStage 时映射为 unknown', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
      };
      invokeMock.mockResolvedValueOnce({
        success: false,
        error: 'Some error',
      });

      const result = await createRemoteBackup(config);

      expect(result.success).toBe(false);
      expect(result.errorStage).toBe('unknown');
    });
  });

  // -------------------------------------------------------------------------
  // normalizeErrorStage
  // -------------------------------------------------------------------------

  describe('normalizeErrorStage', () => {
    it('auth 映射为 credential', () => {
      expect(normalizeErrorStage('auth')).toBe('credential');
    });

    it('read_local_file 映射为 create-zip', () => {
      expect(normalizeErrorStage('read_local_file')).toBe('create-zip');
    });

    it('ensure_dir 401/403 映射为 credential', () => {
      expect(normalizeErrorStage('ensure_dir', '401')).toBe('credential');
      expect(normalizeErrorStage('ensure_dir', '403')).toBe('credential');
    });

    it('ensure_dir 非 401/403 映射为 upload', () => {
      expect(normalizeErrorStage('ensure_dir', '500')).toBe('upload');
      expect(normalizeErrorStage('ensure_dir')).toBe('upload');
    });

    it('network 映射为 upload', () => {
      expect(normalizeErrorStage('network')).toBe('upload');
    });

    it('upload_retry_exhausted 映射为 upload', () => {
      expect(normalizeErrorStage('upload_retry_exhausted')).toBe('upload');
    });

    it('lock 映射为 single-flight', () => {
      expect(normalizeErrorStage('lock')).toBe('single-flight');
    });

    it('未知值映射为 unknown', () => {
      expect(normalizeErrorStage('some_future_stage')).toBe('unknown');
    });

    it('undefined 映射为 unknown', () => {
      expect(normalizeErrorStage(undefined)).toBe('unknown');
    });

    it('空字符串映射为 unknown', () => {
      expect(normalizeErrorStage('')).toBe('unknown');
    });
  });

  describe('listBackups', () => {
    it('调用 webdav_list_backups 命令并返回远端备份列表', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
        remoteDir: 'SoNotes_Backups/',
        password: 'secret',
      };
      const expected = [
        {
          fileName: 'SoNotes_Backup_20240101120000.zip',
          size: 102400,
          lastModified: 'Mon, 01 Jan 2024 12:00:00 GMT',
          status: 200,
          readable: true,
        },
        {
          fileName: 'SoNotes_Backup_20240102120000.zip',
          size: 204800,
          lastModified: 'Tue, 02 Jan 2024 12:00:00 GMT',
          status: 200,
          readable: true,
        },
      ];
      invokeMock.mockResolvedValueOnce(expected);

      const result = await listBackups(config);

      expect(invokeMock).toHaveBeenCalledWith('webdav_list_backups', {
        config,
      });
      expect(result).toEqual(expected);
      expect(result).toHaveLength(2);
    });

    it('空目录返回空数组', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
      };
      invokeMock.mockResolvedValueOnce([]);

      const result = await listBackups(config);

      expect(result).toEqual([]);
    });
  });

  describe('downloadBackup', () => {
    it('调用 webdav_download_backup 命令并返回 download token', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
        remoteDir: 'SoNotes_Backups/',
        password: 'secret',
      };
      const remoteFileName = 'SoNotes_Backup_20240101120000.zip';
      const expected = {
        success: true,
        downloadToken: 'webdav-dl-0000000000000000abcdef1234567890',
      };
      invokeMock.mockResolvedValueOnce(expected);

      const result = await downloadBackup(config, remoteFileName);

      expect(invokeMock).toHaveBeenCalledWith('webdav_download_backup', {
        config,
        remoteFileName,
      });
      expect(result).toEqual(expected);
      expect(result.downloadToken).toBeDefined();
    });

    it('传播超限错误结果', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
      };
      const remoteFileName = 'SoNotes_Backup_20240101120000.zip';
      const failed = {
        success: false,
        error: '远端备份超过允许大小，本地数据未受影响',
      };
      invokeMock.mockResolvedValueOnce(failed);

      const result = await downloadBackup(config, remoteFileName);

      expect(result.success).toBe(false);
      expect(result.error).toContain('超过允许大小');
    });
  });

  describe('deleteBackup', () => {
    it('调用 webdav_delete_backup 命令并传递远端文件名', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
        remoteDir: 'SoNotes_Backups/',
        password: 'secret',
      };
      const remoteFileName = 'SoNotes_Backup_20240101120000.zip';
      const expected = { success: true };
      invokeMock.mockResolvedValueOnce(expected);

      const result = await deleteBackup(config, remoteFileName);

      expect(invokeMock).toHaveBeenCalledWith('webdav_delete_backup', {
        config,
        remoteFileName,
      });
      expect(result).toEqual(expected);
    });

    it('传播远端备份已不存在结果', async () => {
      const config = {
        serverUrl: 'https://example.com',
        username: 'user',
      };
      const expected = { success: true, error: '远端备份已不存在' };
      invokeMock.mockResolvedValueOnce(expected);

      const result = await deleteBackup(config, 'SoNotes_Backup_20240101120000.zip');

      expect(result.success).toBe(true);
      expect(result.error).toBe('远端备份已不存在');
    });
  });

  // -------------------------------------------------------------------------
  // 下载 Token 生命周期
  // -------------------------------------------------------------------------

  describe('resolveDownloadedBackup', () => {
    it('调用 resolve_downloaded_backup 命令并返回受控本地路径', async () => {
      const downloadToken = 'webdav-dl-0000000000000000abcdef1234567890';
      const expected = {
        success: true,
        localPath: 'C:/cache/webdav-backups/downloads/webdav-dl-abc123.zip',
      };
      invokeMock.mockResolvedValueOnce(expected);

      const result = await resolveDownloadedBackup(downloadToken);

      expect(invokeMock).toHaveBeenCalledWith('resolve_downloaded_backup', {
        downloadToken,
      });
      expect(result).toEqual(expected);
      expect(result.localPath).toBeDefined();
    });

    it('传播 token 无效错误', async () => {
      const downloadToken = 'invalid-token';
      const failed = {
        success: false,
        error: '下载 token 无效',
      };
      invokeMock.mockResolvedValueOnce(failed);

      const result = await resolveDownloadedBackup(downloadToken);

      expect(result.success).toBe(false);
      expect(result.error).toBe('下载 token 无效');
    });

    it('传播 token 已解析错误', async () => {
      const downloadToken = 'webdav-dl-already-resolved';
      const failed = {
        success: false,
        error: '下载 token 已被解析，不能重复使用',
      };
      invokeMock.mockResolvedValueOnce(failed);

      const result = await resolveDownloadedBackup(downloadToken);

      expect(result.success).toBe(false);
      expect(result.error).toContain('已被解析');
    });
  });

  describe('cleanupDownloadedBackup', () => {
    it('调用 cleanup_downloaded_backup 命令', async () => {
      const downloadToken = 'webdav-dl-0000000000000000abcdef1234567890';
      const expected = { success: true };
      invokeMock.mockResolvedValueOnce(expected);

      const result = await cleanupDownloadedBackup(downloadToken);

      expect(invokeMock).toHaveBeenCalledWith('cleanup_downloaded_backup', {
        downloadToken,
      });
      expect(result).toEqual(expected);
    });

    it('cleanup 幂等：已清理的 token 仍返回成功', async () => {
      const downloadToken = 'webdav-dl-already-cleaned';
      const expected = { success: true };
      invokeMock.mockResolvedValueOnce(expected);

      const result = await cleanupDownloadedBackup(downloadToken);

      expect(result.success).toBe(true);
    });

    it('传播 token 无效错误', async () => {
      const downloadToken = 'invalid-token';
      const failed = {
        success: false,
        error: '下载 token 无效',
      };
      invokeMock.mockResolvedValueOnce(failed);

      const result = await cleanupDownloadedBackup(downloadToken);

      expect(result.success).toBe(false);
      expect(result.error).toBe('下载 token 无效');
    });
  });
});
