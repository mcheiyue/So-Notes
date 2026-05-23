import { describe, expect, it } from 'vitest';

import { DEFAULT_NOTE_DARK_SPECTRUM, NOTE_COLORS, getNoteColor, getNoteDarkSpectrum } from './types';

describe('深色便签颜色映射', () => {
  it('深色模式下 getNoteColor 返回 dark spectrum 的 bg', () => {
    expect(getNoteColor('#FFFFFF', true)).toBe('#131e31');
    expect(getNoteColor('#fef9c3', true)).toBe('#251c0c');
    expect(getNoteColor('#fce7f3', true)).toBe('#27111d');
    expect(getNoteColor('#ffedd5', true)).toBe('#29170e');
  });

  it('getNoteDarkSpectrum 返回完整的 bg / border / accent 光谱', () => {
    expect(getNoteDarkSpectrum('#dcfce7')).toEqual({
      bg: '#0e2417',
      border: '#173f27',
      accent: '#10b981',
    });
    expect(getNoteDarkSpectrum('#f3e8ff')).toEqual({
      bg: '#1d152f',
      border: '#332353',
      accent: '#a855f7',
    });
  });

  it('getNoteDarkSpectrum 支持大小写不敏感与未知颜色回退', () => {
    expect(getNoteDarkSpectrum('#FEF9C3')).toEqual({
      bg: '#251c0c',
      border: '#413014',
      accent: '#f59e0b',
    });
    expect(getNoteDarkSpectrum('#abcdef')).toEqual(DEFAULT_NOTE_DARK_SPECTRUM);
    expect(getNoteColor('#abcdef', true)).toBe(DEFAULT_NOTE_DARK_SPECTRUM.bg);
  });

  it('浅色模式保持原始便签颜色不变，NOTE_COLORS 仍为持久化浅色真值', () => {
    expect(getNoteColor('#fef9c3', false)).toBe('#fef9c3');
    expect(NOTE_COLORS.every((color) => color.startsWith('#'))).toBe(true);
    expect(NOTE_COLORS.some((color) => color.startsWith('rgba('))).toBe(false);
  });
});
