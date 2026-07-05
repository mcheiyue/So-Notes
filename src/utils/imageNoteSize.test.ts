import { describe, expect, it } from 'vitest';
import { computeImageNoteSize } from './imageNoteSize';
import { LAYOUT } from '../constants/layout';

describe('computeImageNoteSize', () => {
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

  it('无原始尺寸时回退到默认值', () => {
    expect(computeImageNoteSize()).toEqual({
      editingWidth: IMAGE_NOTE_DEFAULT_WIDTH,
      editingHeight: IMAGE_NOTE_DEFAULT_HEIGHT,
    });
    expect(computeImageNoteSize(undefined, undefined)).toEqual({
      editingWidth: IMAGE_NOTE_DEFAULT_WIDTH,
      editingHeight: IMAGE_NOTE_DEFAULT_HEIGHT,
    });
  });

  it('原始尺寸为零或负数时回退到默认值', () => {
    expect(computeImageNoteSize(0, 100)).toEqual({
      editingWidth: IMAGE_NOTE_DEFAULT_WIDTH,
      editingHeight: IMAGE_NOTE_DEFAULT_HEIGHT,
    });
    expect(computeImageNoteSize(100, -1)).toEqual({
      editingWidth: IMAGE_NOTE_DEFAULT_WIDTH,
      editingHeight: IMAGE_NOTE_DEFAULT_HEIGHT,
    });
  });

  it('横图（1920×1080）按宽度适配，高度按比例缩放', () => {
    const { editingWidth, editingHeight } = computeImageNoteSize(1920, 1080);
    expect(editingWidth).toBe(IMAGE_NOTE_MAX_WIDTH);
    // 800 / (1920/1080) = 800 * 1080 / 1920 = 450
    expect(editingHeight).toBe(450);
    expect(editingHeight).toBeGreaterThanOrEqual(IMAGE_NOTE_MIN_HEIGHT);
    expect(editingHeight).toBeLessThanOrEqual(IMAGE_NOTE_MAX_HEIGHT);
  });

  it('竖图（1080×1920）按高度适配，宽度按比例缩放', () => {
    const { editingWidth, editingHeight } = computeImageNoteSize(1080, 1920);
    expect(editingHeight).toBe(IMAGE_NOTE_MAX_HEIGHT);
    // 600 * (1080/1920) = 600 * 0.5625 = 337.5 → 338
    expect(editingWidth).toBe(338);
    expect(editingWidth).toBeGreaterThanOrEqual(IMAGE_NOTE_MIN_WIDTH);
    expect(editingWidth).toBeLessThanOrEqual(IMAGE_NOTE_MAX_WIDTH);
  });

  it('正方形图片（1000×1000）按高度适配', () => {
    const { editingWidth, editingHeight } = computeImageNoteSize(1000, 1000);
    // 正方形：高度先触达 MAX_HEIGHT=600，宽度 = 600
    expect(editingHeight).toBe(IMAGE_NOTE_MAX_HEIGHT);
    expect(editingWidth).toBe(IMAGE_NOTE_MAX_HEIGHT);
  });

  it('小图（200×150）在边界内时保持原始比例', () => {
    const { editingWidth, editingHeight } = computeImageNoteSize(200, 150);
    expect(editingWidth).toBe(200);
    expect(editingHeight).toBe(150);
    expect(editingWidth).toBeGreaterThanOrEqual(IMAGE_NOTE_MIN_WIDTH);
    expect(editingHeight).toBeGreaterThanOrEqual(IMAGE_NOTE_MIN_HEIGHT);
  });

  it('极宽图片（8000×100）宽高比钳位到 3，宽度钳位到最大，高度按钳位比例计算', () => {
    const { editingWidth, editingHeight } = computeImageNoteSize(8000, 100);
    expect(editingWidth).toBe(IMAGE_NOTE_MAX_WIDTH);
    // 宽高比 80 被钳位到 3 → 800 / 3 ≈ 266.67 → 267
    expect(editingHeight).toBe(Math.round(IMAGE_NOTE_MAX_WIDTH / IMAGE_NOTE_ASPECT_RATIO_MAX));
    expect(editingHeight).toBeGreaterThanOrEqual(IMAGE_NOTE_MIN_HEIGHT);
  });

  it('极窄图片（50×2000）宽高比钳位到 1/3，高度钳位到最大，宽度按钳位比例计算', () => {
    const { editingWidth, editingHeight } = computeImageNoteSize(50, 2000);
    expect(editingHeight).toBe(IMAGE_NOTE_MAX_HEIGHT);
    // 宽高比 0.025 被钳位到 1/3 → 600 * (1/3) = 200
    expect(editingWidth).toBe(Math.round(IMAGE_NOTE_MAX_HEIGHT * IMAGE_NOTE_ASPECT_RATIO_MIN));
    expect(editingWidth).toBeGreaterThanOrEqual(IMAGE_NOTE_MIN_WIDTH);
  });

  it('近边界宽图（2900×1000，比例 2.9）保持原始比例缩放', () => {
    const { editingWidth, editingHeight } = computeImageNoteSize(2900, 1000);
    expect(editingWidth).toBe(IMAGE_NOTE_MAX_WIDTH);
    // 比例 2.9 在 [1/3, 3] 内 → 800 / 2.9 ≈ 275.86 → 276
    expect(editingHeight).toBe(Math.round(IMAGE_NOTE_MAX_WIDTH / 2.9));
  });

  it('超边界宽图（5000×1000，比例 5）宽高比钳位到 3', () => {
    const { editingWidth, editingHeight } = computeImageNoteSize(5000, 1000);
    expect(editingWidth).toBe(IMAGE_NOTE_MAX_WIDTH);
    // 比例 5 被钳位到 3 → 800 / 3 ≈ 266.67 → 267
    expect(editingHeight).toBe(Math.round(IMAGE_NOTE_MAX_WIDTH / IMAGE_NOTE_ASPECT_RATIO_MAX));
    // 与近边界测试对比：钳位后高度更小（267 < 276）
    expect(editingHeight).toBeLessThan(Math.round(IMAGE_NOTE_MAX_WIDTH / 2.9));
  });

  it('近边界窄图（350×1000，比例 0.35）保持原始比例缩放', () => {
    const { editingWidth, editingHeight } = computeImageNoteSize(350, 1000);
    expect(editingHeight).toBe(IMAGE_NOTE_MAX_HEIGHT);
    // 比例 0.35 在 [1/3, 3] 内 → 600 * 0.35 = 210
    expect(editingWidth).toBe(Math.round(IMAGE_NOTE_MAX_HEIGHT * 0.35));
  });

  it('超边界窄图（200×1000，比例 0.2）宽高比钳位到 1/3', () => {
    const { editingWidth, editingHeight } = computeImageNoteSize(200, 1000);
    expect(editingHeight).toBe(IMAGE_NOTE_MAX_HEIGHT);
    // 比例 0.2 被钳位到 1/3 → 600 * (1/3) = 200
    expect(editingWidth).toBe(Math.round(IMAGE_NOTE_MAX_HEIGHT * IMAGE_NOTE_ASPECT_RATIO_MIN));
    // 与近边界测试对比：钳位后宽度更小（200 < 210）
    expect(editingWidth).toBeLessThan(Math.round(IMAGE_NOTE_MAX_HEIGHT * 0.35));
  });

  it('返回值始终为正整数', () => {
    const cases = [
      [1920, 1080],
      [1080, 1920],
      [333, 777],
      [1, 1],
      [9999, 1],
    ] as const;
    for (const [w, h] of cases) {
      const { editingWidth, editingHeight } = computeImageNoteSize(w, h);
      expect(editingWidth).toBe(Math.floor(editingWidth));
      expect(editingHeight).toBe(Math.floor(editingHeight));
      expect(editingWidth).toBeGreaterThan(0);
      expect(editingHeight).toBeGreaterThan(0);
    }
  });
});
