/**
 * 从图片来源读取自然宽高的工具函数。
 *
 * 两种入口：
 * - File blob：用于文件拖入场景，直接从 Blob 创建 ObjectURL 加载。
 * - 附件相对路径：用于剪贴板粘贴场景，先通过 Tauri API 解析为绝对路径再加载。
 *
 * 加载失败时返回 null，调用方回退到默认尺寸。
 */

import { resolveAttachmentPath } from '../services/storage/attachmentPersistence';

/** 从 File 对象读取图片自然尺寸。 */
export function getImageDimensionsFromFile(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const result = { width: img.naturalWidth, height: img.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(result);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/** 从附件相对路径读取图片自然尺寸（需要 Tauri 运行时）。 */
export async function getImageDimensionsFromRelativePath(
  relativePath: string,
): Promise<{ width: number; height: number } | null> {
  try {
    const absolutePath = await resolveAttachmentPath(relativePath);
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    const assetUrl = convertFileSrc(absolutePath);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = assetUrl;
    });
  } catch {
    return null;
  }
}
