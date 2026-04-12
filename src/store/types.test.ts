import { describe, expect, it } from 'vitest';

import { getNoteColor } from './types';

describe('深色便签颜色映射', () => {
  it('为高风险浅色便签返回更稳的深色底色', () => {
    expect(getNoteColor('#FFFFFF', true)).toBe('rgba(71, 85, 105, 0.32)');
    expect(getNoteColor('#fef9c3', true)).toBe('rgba(161, 98, 7, 0.34)');
    expect(getNoteColor('#fce7f3', true)).toBe('rgba(190, 24, 93, 0.32)');
    expect(getNoteColor('#ffedd5', true)).toBe('rgba(194, 65, 12, 0.34)');
  });

  it('未知颜色在深色模式下回退为中性深底而非发白高亮', () => {
    expect(getNoteColor('#abcdef', true)).toBe('rgba(71, 85, 105, 0.28)');
  });

  it('浅色模式保持原始便签颜色不变', () => {
    expect(getNoteColor('#fef9c3', false)).toBe('#fef9c3');
  });
});
