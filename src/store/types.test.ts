import { describe, expect, it } from 'vitest';

import type { AttachmentRef, Note } from './types';
import { DEFAULT_NOTE_DARK_SPECTRUM, NOTE_COLORS, STORAGE_SCHEMA_VERSION, getNoteColor, getNoteDarkSpectrum } from './types';

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

describe('STORAGE_SCHEMA_VERSION', () => {
  it('schemaVersion 为 2', () => {
    expect(STORAGE_SCHEMA_VERSION).toBe(2);
  });
});

describe('AttachmentRef 与 Note.attachments', () => {
  it('AttachmentRef 包含计划中的全部 7 个字段', () => {
    const ref: AttachmentRef = {
      id: 'att-001',
      hash: 'a'.repeat(64),
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      size: 1024,
      relativePath: 'attachments/' + 'a'.repeat(64) + '.jpg',
      createdAt: Date.now(),
    };
    expect(ref.id).toBe('att-001');
    expect(ref.hash).toHaveLength(64);
    expect(ref.filename).toBe('photo.jpg');
    expect(ref.mimeType).toBe('image/jpeg');
    expect(ref.size).toBe(1024);
    expect(ref.relativePath).toContain('attachments/');
    expect(typeof ref.createdAt).toBe('number');
  });

  it('Note.attachments 为可选字段，缺失时不报错', () => {
    const note: Note = {
      id: 'n-1',
      boardId: 'default',
      x: 0,
      y: 0,
      title: 't',
      content: 'c',
      color: '#FFFFFF',
      z: 1,
      createdAt: 0,
      updatedAt: 0,
    };
    expect(note.attachments).toBeUndefined();
  });

  it('Note.attachments 可以附加 AttachmentRef 数组', () => {
    const ref: AttachmentRef = {
      id: 'att-002',
      hash: 'b'.repeat(64),
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      size: 2048,
      relativePath: 'attachments/' + 'b'.repeat(64) + '.pdf',
      createdAt: 1700000000000,
    };
    const note: Note = {
      id: 'n-2',
      boardId: 'default',
      x: 10,
      y: 20,
      title: 't',
      content: 'c',
      color: '#fef9c3',
      z: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      attachments: [ref],
    };
    expect(note.attachments).toHaveLength(1);
    expect(note.attachments?.[0]?.mimeType).toBe('application/pdf');
  });
});
