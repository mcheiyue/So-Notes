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

  it('极宽图片（8000×100）宽度钳位到最大，高度按比例后被最小边界钳位', () => {
    const { editingWidth, editingHeight } = computeImageNoteSize(8000, 100);
    expect(editingWidth).toBe(IMAGE_NOTE_MAX_WIDTH);
    // 800 / 80 = 10，低于 IMAGE_NOTE_MIN_HEIGHT=100，被钳位
    expect(editingHeight).toBe(IMAGE_NOTE_MIN_HEIGHT);
  });

  it('极窄图片（50×2000）高度钳位到最大，宽度被最小边界钳位', () => {
    const { editingWidth, editingHeight } = computeImageNoteSize(50, 2000);
    expect(editingHeight).toBe(IMAGE_NOTE_MAX_HEIGHT);
    // 600 * (50/2000) = 15，低于 IMAGE_NOTE_MIN_WIDTH=120，被钳位
    expect(editingWidth).toBe(IMAGE_NOTE_MIN_WIDTH);
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
