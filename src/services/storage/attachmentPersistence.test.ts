import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import {
  attachmentExists,
  readAttachmentMetadata,
  writeAttachmentFromPath,
  writeAttachmentFromBytes,
  saveImageFromSystemClipboard,
  resolveAttachmentPath,
  getCachedAttachmentPath,
  resolveAttachmentPathCached,
  invalidateAttachmentPathCache,
  listAttachmentFiles,
  deleteAttachmentFile,
  type AttachmentFileMetadata,
  type AttachmentWriteResult,
  type AttachmentDeleteResult,
} from './attachmentPersistence';

describe('attachmentPersistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateAttachmentPathCache();
  });

  it('writeAttachmentFromPath 调用 Rust 写入命令并透传结果', async () => {
    const result: AttachmentWriteResult = {
      hash: 'a'.repeat(64),
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      size: 1024,
      relativePath: `attachments/${'a'.repeat(64)}.jpg`,
      createdAt: 1700000000000,
      bytesWritten: 1024,
    };
    vi.mocked(invoke).mockResolvedValueOnce(result);

    await expect(writeAttachmentFromPath('D:/tmp/photo.jpg', 'photo.jpg', 'image/jpeg'))
      .resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledWith('write_attachment_from_path', {
      sourcePath: 'D:/tmp/photo.jpg',
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
    });
  });

  it('writeAttachmentFromPath 在未传 MIME 时向 Rust 传 null', async () => {
    const result: AttachmentWriteResult = {
      hash: 'b'.repeat(64),
      filename: 'file.bin',
      mimeType: 'application/octet-stream',
      size: 8,
      relativePath: `attachments/${'b'.repeat(64)}.bin`,
      createdAt: 1700000000000,
      bytesWritten: 8,
    };
    vi.mocked(invoke).mockResolvedValueOnce(result);

    await writeAttachmentFromPath('D:/tmp/file', 'file.bin');

    expect(invoke).toHaveBeenCalledWith('write_attachment_from_path', {
      sourcePath: 'D:/tmp/file',
      filename: 'file.bin',
      mimeType: null,
    });
  });

  it('writeAttachmentFromBytes 调用 Rust 字节写入命令并透传结果', async () => {
    const result: AttachmentWriteResult = {
      hash: '9'.repeat(64),
      filename: 'drop.png',
      mimeType: 'image/png',
      size: 3,
      relativePath: `attachments/${'9'.repeat(64)}.png`,
      createdAt: 1700000000000,
      bytesWritten: 3,
    };
    vi.mocked(invoke).mockResolvedValueOnce(result);

    const data = new Uint8Array([1, 2, 3]);
    await expect(writeAttachmentFromBytes(data, 'drop.png', 'image/png')).resolves.toEqual(result);

    expect(invoke).toHaveBeenCalledWith('write_attachment_from_bytes', {
      data: [1, 2, 3],
      filename: 'drop.png',
      mimeType: 'image/png',
    });
  });

  it('attachmentExists 调用 Rust 存在性命令', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(true);

    await expect(attachmentExists(`attachments/${'c'.repeat(64)}.png`)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('attachment_exists', {
      relativePath: `attachments/${'c'.repeat(64)}.png`,
    });
  });

  it('readAttachmentMetadata 调用 Rust 元数据命令并透传结果', async () => {
    const metadata: AttachmentFileMetadata = {
      hash: 'd'.repeat(64),
      filename: `${'d'.repeat(64)}.pdf`,
      mimeType: 'application/pdf',
      size: 4096,
      relativePath: `attachments/${'d'.repeat(64)}.pdf`,
      createdAt: 1700000000000,
    };
    vi.mocked(invoke).mockResolvedValueOnce(metadata);

    await expect(readAttachmentMetadata(`attachments/${'d'.repeat(64)}.pdf`))
      .resolves.toEqual(metadata);
    expect(invoke).toHaveBeenCalledWith('read_attachment_metadata', {
      relativePath: `attachments/${'d'.repeat(64)}.pdf`,
    });
  });

  it('saveImageFromSystemClipboard 调用 Rust 剪贴板命令并透传结果', async () => {
    const result: AttachmentWriteResult = {
      hash: 'e'.repeat(64),
      filename: 'clipboard-image.png',
      mimeType: 'image/png',
      size: 2048,
      relativePath: `attachments/${'e'.repeat(64)}.png`,
      createdAt: 1700000000000,
      bytesWritten: 2048,
    };
    vi.mocked(invoke).mockResolvedValueOnce(result);

    await expect(saveImageFromSystemClipboard()).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledWith('save_image_from_system_clipboard');
  });

  it('resolveAttachmentPath 调用 Rust 路径解析命令', async () => {
    const absPath = 'C:\\Users\\test\\Documents\\SoNotes\\attachments\\abc.png';
    vi.mocked(invoke).mockResolvedValueOnce(absPath);

    await expect(resolveAttachmentPath('attachments/abc.png')).resolves.toBe(absPath);
    expect(invoke).toHaveBeenCalledWith('resolve_attachment_path', {
      relativePath: 'attachments/abc.png',
    });
  });

  it('getCachedAttachmentPath 在缓存未命中时返回 undefined', () => {
    expect(getCachedAttachmentPath('attachments/missing.png')).toBeUndefined();
  });

  it('resolveAttachmentPathCached 首次解析后复用缓存', async () => {
    const relativePath = 'attachments/cached.png';
    vi.mocked(invoke).mockResolvedValueOnce('/abs/attachments/cached.png');

    await expect(resolveAttachmentPathCached(relativePath)).resolves.toBe('/abs/attachments/cached.png');
    await expect(resolveAttachmentPathCached(relativePath)).resolves.toBe('/abs/attachments/cached.png');

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('resolve_attachment_path', { relativePath });
    expect(getCachedAttachmentPath(relativePath)).toBe('/abs/attachments/cached.png');
  });

  it('invalidateAttachmentPathCache 可清理指定缓存项', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce('/abs/a.png')
      .mockResolvedValueOnce('/abs/b.png');

    await resolveAttachmentPathCached('attachments/a.png');
    await resolveAttachmentPathCached('attachments/b.png');
    invalidateAttachmentPathCache('attachments/a.png');

    expect(getCachedAttachmentPath('attachments/a.png')).toBeUndefined();
    expect(getCachedAttachmentPath('attachments/b.png')).toBe('/abs/b.png');
  });

  it('invalidateAttachmentPathCache 不传路径时清空全部缓存', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce('/abs/a.png')
      .mockResolvedValueOnce('/abs/b.png');

    await resolveAttachmentPathCached('attachments/a.png');
    await resolveAttachmentPathCached('attachments/b.png');
    invalidateAttachmentPathCache();

    expect(getCachedAttachmentPath('attachments/a.png')).toBeUndefined();
    expect(getCachedAttachmentPath('attachments/b.png')).toBeUndefined();
  });

  it('listAttachmentFiles 调用 Rust 列表命令', async () => {
    const files = [
      `attachments/${'f'.repeat(64)}.png`,
      `attachments/${'a'.repeat(64)}.jpg`,
    ];
    vi.mocked(invoke).mockResolvedValueOnce(files);

    await expect(listAttachmentFiles()).resolves.toEqual(files);
    expect(invoke).toHaveBeenCalledWith('list_attachment_files');
  });

  it('deleteAttachmentFile 调用 Rust 删除命令并透传结果', async () => {
    const result: AttachmentDeleteResult = {
      deleted: true,
      relativePath: `attachments/${'f'.repeat(64)}.png`,
    };
    vi.mocked(invoke).mockResolvedValueOnce(result);

    await expect(deleteAttachmentFile(`attachments/${'f'.repeat(64)}.png`))
      .resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledWith('delete_attachment_file', {
      relativePath: `attachments/${'f'.repeat(64)}.png`,
    });
  });

  it('deleteAttachmentFile 文件不存在时返回 deleted: false', async () => {
    const result: AttachmentDeleteResult = {
      deleted: false,
      relativePath: `attachments/${'0'.repeat(64)}.png`,
    };
    vi.mocked(invoke).mockResolvedValueOnce(result);

    await expect(deleteAttachmentFile(`attachments/${'0'.repeat(64)}.png`))
      .resolves.toEqual(result);
  });
});
