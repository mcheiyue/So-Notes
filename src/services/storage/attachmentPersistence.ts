/**
 * 附件持久化服务
 *
 * 封装 Tauri 侧 `attachments` 模块的命令调用，
 * 提供类型安全的 Promise 接口供前端使用。
 *
 * Rust 命令名称：
 * - write_attachment_from_path
 * - write_attachment_from_bytes
 * - attachment_exists
 * - read_attachment_metadata
 * - save_image_from_system_clipboard
 * - resolve_attachment_path
 * - list_attachment_files
 * - delete_attachment_file
 */

import { invoke } from '@tauri-apps/api/core';

const attachmentPathCache = new Map<string, string>();

// ---------------------------------------------------------------------------
// 类型定义（与 Rust 侧 serde camelCase 输出对齐）
// ---------------------------------------------------------------------------

/** 写入附件后的结果元数据 */
export interface AttachmentWriteResult {
  /** 文件内容 SHA-256 哈希（64 字符十六进制） */
  hash: string;
  /** 原始文件名 */
  filename: string;
  /** 归一化后的 MIME 类型 */
  mimeType: string;
  /** 文件大小（字节） */
  size: number;
  /** 相对 SoNotes 数据目录的路径，例如 `attachments/<sha256>.<ext>` */
  relativePath: string;
  /** 创建时间（毫秒级 Unix 时间戳） */
  createdAt: number;
  /** 实际写入字节数；若文件已存在（内容去重）则为 0 */
  bytesWritten: number;
}

/** 附件文件元数据 */
export interface AttachmentFileMetadata {
  /** 文件内容哈希（从文件名解析） */
  hash: string;
  /** 展示用文件名（含扩展名） */
  filename: string;
  /** MIME 类型 */
  mimeType: string;
  /** 文件大小（字节） */
  size: number;
  /** 相对路径 */
  relativePath: string;
  /** 创建时间（毫秒级 Unix 时间戳） */
  createdAt: number;
}

/** 附件删除结果 */
export interface AttachmentDeleteResult {
  /** 是否实际执行了删除（文件不存在时为 false） */
  deleted: boolean;
  /** 被删除文件的相对路径 */
  relativePath: string;
}

// ---------------------------------------------------------------------------
// 命令封装
// ---------------------------------------------------------------------------

/**
 * 将源路径指定的文件写入附件目录。
 *
 * Rust 侧会流式计算 SHA-256 并按内容哈希命名存储。
 * 若相同内容的文件已存在，则复用已有文件（bytesWritten 为 0）。
 *
 * @param sourcePath 源文件的绝对路径
 * @param filename   原始文件名（用于提取扩展名和展示）
 * @param mimeType   可选 MIME 类型；为空时自动推断或回退到 application/octet-stream
 */
export async function writeAttachmentFromPath(
  sourcePath: string,
  filename: string,
  mimeType?: string,
): Promise<AttachmentWriteResult> {
  return invoke<AttachmentWriteResult>('write_attachment_from_path', {
    sourcePath,
    filename,
    mimeType: mimeType ?? null,
  });
}

/**
 * 将前端持有的文件字节写入附件目录。
 *
 * 用于 HTML5 拖放无法提供本地路径时的回退入口。Rust 侧仍负责内容寻址、去重和安全落盘。
 *
 * @param data     文件字节
 * @param filename 原始文件名（用于提取扩展名和展示）
 * @param mimeType 可选 MIME 类型；为空时自动推断或回退到 application/octet-stream
 */
export async function writeAttachmentFromBytes(
  data: ArrayBuffer | Uint8Array,
  filename: string,
  mimeType?: string,
): Promise<AttachmentWriteResult> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return invoke<AttachmentWriteResult>('write_attachment_from_bytes', {
    data: Array.from(bytes),
    filename,
    mimeType: mimeType ?? null,
  });
}

/**
 * 检查指定相对路径的附件文件是否存在。
 *
 * @param relativePath 相对路径，例如 `attachments/<sha256>.<ext>`
 */
export async function attachmentExists(
  relativePath: string,
): Promise<boolean> {
  return invoke<boolean>('attachment_exists', { relativePath });
}

/**
 * 读取指定相对路径的附件文件元数据。
 *
 * @param relativePath 相对路径，例如 `attachments/<sha256>.<ext>`
 */
export async function readAttachmentMetadata(
  relativePath: string,
): Promise<AttachmentFileMetadata> {
  return invoke<AttachmentFileMetadata>('read_attachment_metadata', {
    relativePath,
  });
}

/**
 * 从系统剪贴板读取图片，编码为 PNG 后写入附件目录。
 *
 * Rust 侧负责读取剪贴板 RGBA 数据、编码 PNG 和内容寻址写入。
 * 前端只发送轻量命令，不传输图片 bytes。
 *
 * 剪贴板无图片或图片超限时返回可区分错误。
 */
export async function saveImageFromSystemClipboard(): Promise<AttachmentWriteResult> {
  return invoke<AttachmentWriteResult>('save_image_from_system_clipboard');
}

/**
 * 将附件相对路径解析为绝对路径，供 `convertFileSrc` 生成预览来源。
 *
 * 返回值只作为运行时 UI 层预览输入，不写入 store 或 data.json。
 * 若路径非法或文件不存在，返回错误。
 *
 * @param relativePath 相对路径，例如 `attachments/<sha256>.<ext>`
 */
export async function resolveAttachmentPath(
  relativePath: string,
): Promise<string> {
  return invoke<string>('resolve_attachment_path', { relativePath });
}

export function getCachedAttachmentPath(relativePath: string): string | undefined {
  return attachmentPathCache.get(relativePath);
}

export async function resolveAttachmentPathCached(relativePath: string): Promise<string> {
  const cachedPath = getCachedAttachmentPath(relativePath);
  if (cachedPath !== undefined) {
    return cachedPath;
  }

  const resolvedPath = await resolveAttachmentPath(relativePath);
  attachmentPathCache.set(relativePath, resolvedPath);
  return resolvedPath;
}

export function invalidateAttachmentPathCache(relativePath?: string): void {
  if (relativePath === undefined) {
    attachmentPathCache.clear();
    return;
  }

  attachmentPathCache.delete(relativePath);
}

/**
 * 列出 `attachments/` 目录下所有普通文件的安全相对路径。
 *
 * 返回值按字典序排列，每个元素以 `attachments/` 为前缀。
 * 可用于孤儿附件扫描。
 */
export async function listAttachmentFiles(): Promise<string[]> {
  return invoke<string[]>('list_attachment_files');
}

/**
 * 删除指定相对路径的附件文件。
 *
 * 只删除已通过路径校验的附件文件，不推断 Domain state。
 * 文件不存在时返回 `{ deleted: false }`。
 *
 * @param relativePath 相对路径，例如 `attachments/<sha256>.<ext>`
 */
export async function deleteAttachmentFile(
  relativePath: string,
): Promise<AttachmentDeleteResult> {
  return invoke<AttachmentDeleteResult>('delete_attachment_file', {
    relativePath,
  });
}
