import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import {
  attachmentExists,
  readAttachmentMetadata,
  writeAttachmentFromPath,
  type AttachmentFileMetadata,
  type AttachmentWriteResult,
} from './attachmentPersistence';

describe('attachmentPersistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
