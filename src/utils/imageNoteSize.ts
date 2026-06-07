import { LAYOUT } from '../constants/layout';

/**
 * 根据图片原始宽高计算图片便签的 editingWidth/editingHeight。
 *
 * 算法：
 * 1. 无原始尺寸时回退到默认常量。
 * 2. 按原始比例缩放至最大边界内（优先适配宽度，再适配高度）。
 * 3. 任一维度低于最小边界时强制钳位（极端比例图片会轻微拉伸）。
 *
 * @returns 始终返回有效的正整数尺寸。
 */
export function computeImageNoteSize(
  originalWidth?: number,
  originalHeight?: number,
): { editingWidth: number; editingHeight: number } {
  const {
    IMAGE_NOTE_DEFAULT_WIDTH,
    IMAGE_NOTE_DEFAULT_HEIGHT,
    IMAGE_NOTE_MIN_WIDTH,
    IMAGE_NOTE_MAX_WIDTH,
    IMAGE_NOTE_MIN_HEIGHT,
    IMAGE_NOTE_MAX_HEIGHT,
  } = LAYOUT;

  if (
    originalWidth === undefined ||
    originalHeight === undefined ||
    originalWidth <= 0 ||
    originalHeight <= 0
  ) {
    return {
      editingWidth: IMAGE_NOTE_DEFAULT_WIDTH,
      editingHeight: IMAGE_NOTE_DEFAULT_HEIGHT,
    };
  }

  const aspectRatio = originalWidth / originalHeight;

  // 按比例缩放到最大边界内
  let width = originalWidth;
  let height = originalHeight;

  if (width > IMAGE_NOTE_MAX_WIDTH) {
    width = IMAGE_NOTE_MAX_WIDTH;
    height = width / aspectRatio;
  }
  if (height > IMAGE_NOTE_MAX_HEIGHT) {
    height = IMAGE_NOTE_MAX_HEIGHT;
    width = height * aspectRatio;
  }

  // 钳位到最小边界
  if (width < IMAGE_NOTE_MIN_WIDTH) {
    width = IMAGE_NOTE_MIN_WIDTH;
  }
  if (height < IMAGE_NOTE_MIN_HEIGHT) {
    height = IMAGE_NOTE_MIN_HEIGHT;
  }

  return {
    editingWidth: Math.round(width),
    editingHeight: Math.round(height),
  };
}
