import { LAYOUT } from '../constants/layout';

/**
 * 根据图片原始宽高计算图片便签的 editingWidth/editingHeight。
 *
 * 算法：
 * 1. 无原始尺寸时回退到默认常量。
 * 2. 宽高比钳位到 [ASPECT_RATIO_MIN, ASPECT_RATIO_MAX] 范围。
 * 3. 按钳位后比例缩放至最大边界内（优先适配宽度，再适配高度）。
 * 4. 任一维度低于最小边界时强制钳位。
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
    IMAGE_NOTE_ASPECT_RATIO_MIN,
    IMAGE_NOTE_ASPECT_RATIO_MAX,
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

  const rawAspectRatio = originalWidth / originalHeight;
  const aspectRatio = Math.max(
    IMAGE_NOTE_ASPECT_RATIO_MIN,
    Math.min(IMAGE_NOTE_ASPECT_RATIO_MAX, rawAspectRatio),
  );

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
