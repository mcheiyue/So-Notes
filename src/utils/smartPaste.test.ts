import { describe, expect, it } from 'vitest';
import { buildSmartPasteNoteInputs, createSmartPasteNoteInputs, parseSmartPaste } from './smartPaste';

describe('Smart Paste Lite 解析', () => {
  it('空白文本不产生选项', () => {
    expect(parseSmartPaste('  \n\t ').options).toEqual([]);
  });

  it('URL 保留为普通单张链接便签', () => {
    const result = parseSmartPaste('https://example.com/page');

    expect(result.kind).toBe('url');
    expect(result.options).toHaveLength(1);
    expect(result.options[0].contents).toEqual(['https://example.com/page']);
  });

  it('多行文本默认按行拆分', () => {
    const notes = createSmartPasteNoteInputs('第一行\n第二行\n\n', 100, 200);

    expect(notes).toEqual([
      { content: '第一行', x: 100, y: 200 },
      { content: '第二行', x: 132, y: 228 },
    ]);
  });

  it('多段文本优先按段拆分并保留段内换行', () => {
    const result = parseSmartPaste('第一段 A\n第一段 B\n\n第二段');

    expect(result.kind).toBe('paragraphs');
    expect(result.options.find((option) => option.id === 'split-paragraphs')?.contents).toEqual([
      '第一段 A\n第一段 B',
      '第二段',
    ]);
  });

  it('按固定错位生成便签坐标', () => {
    expect(buildSmartPasteNoteInputs(['A', 'B', 'C'], 10, 20)).toEqual([
      { content: 'A', x: 10, y: 20 },
      { content: 'B', x: 42, y: 48 },
      { content: 'C', x: 74, y: 76 },
    ]);
  });
});
