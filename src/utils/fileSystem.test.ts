import { describe, it, expect, vi, beforeEach } from 'vitest';

const { saveMock, openMock } = vi.hoisted(() => ({
  saveMock: vi.fn(),
  openMock: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: saveMock,
  open: openMock,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: vi.fn(async () => undefined),
  readTextFile: vi.fn(async () => ''),
}));

import { saveFile, openFile, saveZipDialog, openZipDialog } from './fileSystem';

describe('fileSystem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('saveFile（JSON 保持不变）', () => {
    it('使用 JSON 过滤器打开保存对话框', async () => {
      saveMock.mockResolvedValueOnce('/test.json');

      await saveFile('{}', 'data.json');

      expect(saveMock).toHaveBeenCalledWith({
        defaultPath: 'data.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
    });

    it('用户取消时返回 false', async () => {
      saveMock.mockResolvedValueOnce(null);

      const result = await saveFile('{}', 'data.json');

      expect(result).toBe(false);
    });
  });

  describe('openFile（JSON 保持不变）', () => {
    it('使用 JSON 过滤器打开文件对话框', async () => {
      openMock.mockResolvedValueOnce(null);

      await openFile();

      expect(openMock).toHaveBeenCalledWith({
        multiple: false,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
    });
  });

  describe('saveZipDialog', () => {
    it('使用 ZIP 过滤器打开保存对话框，返回选中路径', async () => {
      saveMock.mockResolvedValueOnce('/backups/backup.zip');

      const result = await saveZipDialog('SoNotes-backup.zip');

      expect(saveMock).toHaveBeenCalledWith({
        defaultPath: 'SoNotes-backup.zip',
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      });
      expect(result).toBe('/backups/backup.zip');
    });

    it('用户取消时返回 null', async () => {
      saveMock.mockResolvedValueOnce(null);

      const result = await saveZipDialog('SoNotes-backup.zip');

      expect(result).toBeNull();
    });

    it('对话框异常时返回 null', async () => {
      saveMock.mockRejectedValueOnce(new Error('dialog error'));

      const result = await saveZipDialog('SoNotes-backup.zip');

      expect(result).toBeNull();
    });
  });

  describe('openZipDialog', () => {
    it('使用 ZIP 过滤器打开文件对话框，返回选中路径', async () => {
      openMock.mockResolvedValueOnce('/backups/backup.zip');

      const result = await openZipDialog();

      expect(openMock).toHaveBeenCalledWith({
        multiple: false,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      });
      expect(result).toBe('/backups/backup.zip');
    });

    it('用户取消时返回 null', async () => {
      openMock.mockResolvedValueOnce(null);

      const result = await openZipDialog();

      expect(result).toBeNull();
    });

    it('对话框返回非字符串时返回 null', async () => {
      openMock.mockResolvedValueOnce(['/multiple.zip']);

      const result = await openZipDialog();

      expect(result).toBeNull();
    });

    it('对话框异常时返回 null', async () => {
      openMock.mockRejectedValueOnce(new Error('dialog error'));

      const result = await openZipDialog();

      expect(result).toBeNull();
    });
  });
});
