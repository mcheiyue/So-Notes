import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

import { NoteVisuals } from './NoteVisuals';
import {
  hexToRgbChannels,
  toRgba,
  buildNoteSurfaceBackground,
  getDarkBorderColor,
  buildNoteMaterialShadow,
} from './noteVisualStyles';
import { getNoteColor, getNoteDarkSpectrum } from '../../store/types';

const hexToRgbString = (hex: string): string => {
  const { red, green, blue } = hexToRgbChannels(hex);
  return `rgb(${red}, ${green}, ${blue})`;
};

const hexToRgbaString = (hex: string, alpha: number): string => {
  const { red, green, blue } = hexToRgbChannels(hex);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
};

describe('noteVisualStyles 纯函数', () => {
  it('hexToRgbChannels 解析标准 6 位 hex', () => {
    expect(hexToRgbChannels('#fef9c3')).toEqual({ red: 254, green: 249, blue: 195 });
  });

  it('hexToRgbChannels 解析 3 位 shorthand hex', () => {
    expect(hexToRgbChannels('#fff')).toEqual({ red: 255, green: 255, blue: 255 });
  });

  it('hexToRgbChannels 对非法 hex 回退到蓝色', () => {
    expect(hexToRgbChannels('#zzz')).toEqual({ red: 59, green: 130, blue: 246 });
    expect(hexToRgbChannels('#gg')).toEqual({ red: 59, green: 130, blue: 246 });
  });

  it('toRgba 合成正确 rgba 字符串', () => {
    expect(toRgba('#fef9c3', 0.5)).toBe('rgba(254, 249, 195, 0.5)');
    expect(toRgba('#ffffff', 1)).toBe('rgba(255, 255, 255, 1)');
  });

  it('buildNoteSurfaceBackground 浅色模式返回白色线性渐变', () => {
    const bg = buildNoteSurfaceBackground(false, '#3b82f6', false);
    expect(bg).toContain('linear-gradient');
    expect(bg).toContain('rgba(255,255,255');
    expect(bg).not.toContain('radial-gradient');
  });

  it('buildNoteSurfaceBackground 深色模式返回 accent 径向渐变', () => {
    const bg = buildNoteSurfaceBackground(true, '#f59e0b', false);
    expect(bg).toContain('radial-gradient');
    expect(bg).toContain('245, 158, 11');
    expect(bg).toContain('linear-gradient');
  });

  it('buildNoteSurfaceBackground 深色模式 emphasized 增强径向 alpha', () => {
    const normal = buildNoteSurfaceBackground(true, '#3b82f6', false);
    const emphasized = buildNoteSurfaceBackground(true, '#3b82f6', true);
    expect(emphasized).not.toBe(normal);
    expect(normal).toContain('0.22');
    expect(emphasized).toContain('0.28');
  });

  it('getDarkBorderColor 默认回退到 fallbackBorder', () => {
    expect(getDarkBorderColor('#3b82f6', '#223452', false, false, false, false)).toBe('#223452');
  });

  it('getDarkBorderColor 活跃态使用 accent 0.4 alpha', () => {
    expect(getDarkBorderColor('#3b82f6', '#223452', true, false, false, false))
      .toBe(hexToRgbaString('#3b82f6', 0.4));
  });

  it('getDarkBorderColor 选中态使用 accent 0.48 alpha', () => {
    expect(getDarkBorderColor('#3b82f6', '#223452', false, false, true, false))
      .toBe(hexToRgbaString('#3b82f6', 0.48));
  });

  it('getDarkBorderColor 组选态使用 accent 0.58 alpha', () => {
    expect(getDarkBorderColor('#3b82f6', '#223452', false, false, true, true))
      .toBe(hexToRgbaString('#3b82f6', 0.58));
  });

  it('getDarkBorderColor 拖拽态使用 accent 0.64 alpha', () => {
    expect(getDarkBorderColor('#3b82f6', '#223452', false, true, false, false))
      .toBe(hexToRgbaString('#3b82f6', 0.64));
  });

  it('getDarkBorderColor 拖拽优先于选中', () => {
    expect(getDarkBorderColor('#3b82f6', '#223452', false, true, true, false))
      .toBe(hexToRgbaString('#3b82f6', 0.64));
  });

  it('buildNoteMaterialShadow 浅色模式默认包含 inset 高光和 0 2px 8px 外层', () => {
    const shadow = buildNoteMaterialShadow(false, '#3b82f6', false, false, false, false);
    expect(shadow).toContain('inset 0 1px 1px');
    expect(shadow).toContain('rgba(255,255,255');
    expect(shadow).toContain('0 2px 8px');
  });

  it('buildNoteMaterialShadow 浅色模式 hover 增强外层阴影', () => {
    const shadow = buildNoteMaterialShadow(false, '#3b82f6', true, false, false, false);
    expect(shadow).toContain('0 4px 14px');
    expect(shadow).toContain('rgba(255,255,255,0.4)');
  });

  it('buildNoteMaterialShadow 浅色模式选中态包含蓝色光环', () => {
    const shadow = buildNoteMaterialShadow(false, '#3b82f6', false, false, true, false);
    expect(shadow).toContain('0 0 0 2px');
    expect(shadow).toContain('rgba(59,130,246');
  });

  it('buildNoteMaterialShadow 深色模式包含多层 inset 高光', () => {
    const shadow = buildNoteMaterialShadow(true, '#3b82f6', false, false, false, false);
    expect(shadow).toContain('inset 0 1px 0');
    expect(shadow).toContain('inset 1px 0 0');
    expect(shadow).toContain('inset 0 -1px 0');
    expect(shadow).toContain('0 8px 20px -12px');
  });

  it('buildNoteMaterialShadow 深色模式 hover 增强 outer 和 accent 边缘', () => {
    const shadow = buildNoteMaterialShadow(true, '#f59e0b', true, false, false, false);
    expect(shadow).toContain('0 10px 24px -12px');
    expect(shadow).toContain('0 0 0 1px');
  });
});

describe('NoteVisuals 组件渲染', () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderVisuals = async (props: Partial<React.ComponentProps<typeof NoteVisuals>> = {}) => {
    await act(async () => {
      root.render(
        <NoteVisuals
          title="标题"
          content="内容"
          color="#FFFFFF"
          isCollapsed={false}
          isDark={false}
          {...props}
        />,
      );
    });
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('浅色模式 inline backgroundImage 提供白色线性渐变', async () => {
    await renderVisuals();
    const article = container.querySelector('[data-note-visuals]') as HTMLElement | null;
    const bgImage = article?.style.backgroundImage ?? '';
    expect(bgImage).toContain('linear-gradient');
    expect(bgImage).toContain('255, 255, 255');
  });

  it('浅色模式 inline boxShadow 含 inset 高光层', async () => {
    await renderVisuals();
    const article = container.querySelector('[data-note-visuals]') as HTMLElement | null;
    const shadow = article?.style.boxShadow ?? '';
    expect(shadow).toContain('inset 0 1px 1px');
    expect(shadow).toContain('rgba(255,255,255');
  });

  it('浅色模式 boxShadow 默认外层为 0 2px 8px', async () => {
    await renderVisuals();
    const article = container.querySelector('[data-note-visuals]') as HTMLElement | null;
    expect(article?.style.boxShadow).toContain('0 2px 8px');
  });

  it('深色模式 backgroundImage 使用 accent 径向柔光', async () => {
    await renderVisuals({ color: '#f3e8ff', isDark: true });
    const article = container.querySelector('[data-note-visuals]') as HTMLElement | null;
    const bgImage = article?.style.backgroundImage ?? '';
    expect(bgImage).toContain('radial-gradient');
    expect(bgImage).toContain('168, 85, 247');
    expect(bgImage).toContain('linear-gradient');
  });

  it('深色模式 borderColor 使用 spectrum border', async () => {
    await renderVisuals({ color: '#fef9c3', isDark: true });
    const article = container.querySelector('[data-note-visuals]') as HTMLElement | null;
    const spectrum = getNoteDarkSpectrum('#fef9c3');
    expect(article?.style.borderColor).toBe(hexToRgbString(spectrum.border));
  });

  it('深色模式 isActive 时 borderColor 切换到 accent 0.4', async () => {
    await renderVisuals({ color: '#fef9c3', isDark: true, isActive: true });
    const article = container.querySelector('[data-note-visuals]') as HTMLElement | null;
    const spectrum = getNoteDarkSpectrum('#fef9c3');
    expect(article?.style.borderColor).toBe(hexToRgbaString(spectrum.accent, 0.4));
  });

  it('深色模式 isActive 时 boxShadow 增强 outer 并包含 accent 辉光', async () => {
    await renderVisuals({ color: '#fef9c3', isDark: true, isActive: true });
    const article = container.querySelector('[data-note-visuals]') as HTMLElement | null;
    const spectrum = getNoteDarkSpectrum('#fef9c3');
    expect(article?.style.boxShadow).toContain(hexToRgbaString(spectrum.accent, 0.22));
  });

  it('深色模式默认 boxShadow 不包含 accent 辉光', async () => {
    await renderVisuals({ color: '#fef9c3', isDark: true });
    const article = container.querySelector('[data-note-visuals]') as HTMLElement | null;
    const spectrum = getNoteDarkSpectrum('#fef9c3');
    expect(article?.style.boxShadow).not.toContain(hexToRgbaString(spectrum.accent, 0.22));
  });

  it('深色模式 isSelected 时 borderColor 切换到 accent 0.48', async () => {
    await renderVisuals({ color: '#fef9c3', isDark: true, isSelected: true });
    const article = container.querySelector('[data-note-visuals]') as HTMLElement | null;
    const spectrum = getNoteDarkSpectrum('#fef9c3');
    expect(article?.style.borderColor).toBe(hexToRgbaString(spectrum.accent, 0.48));
  });

  it('深色模式 isGroupSelection 时 borderColor 切换到 accent 0.58', async () => {
    await renderVisuals({ color: '#fef9c3', isDark: true, isSelected: true, isGroupSelection: true });
    const article = container.querySelector('[data-note-visuals]') as HTMLElement | null;
    const spectrum = getNoteDarkSpectrum('#fef9c3');
    expect(article?.style.borderColor).toBe(hexToRgbaString(spectrum.accent, 0.58));
  });

  it('深色模式 inline boxShadow 同样包含多层 inset 高光', async () => {
    await renderVisuals({ isDark: true });
    const article = container.querySelector('[data-note-visuals]') as HTMLElement | null;
    const shadow = article?.style.boxShadow ?? '';
    expect(shadow).toContain('inset 0 1px 0');
    expect(shadow).toContain('inset 1px 0 0');
    expect(shadow).toContain('rgba(255,255,255');
    expect(shadow).toContain('0 8px 20px -12px');
  });

  it('不使用 backdrop-blur 和 backdrop-saturate', async () => {
    await renderVisuals();
    const article = container.querySelector('[data-note-visuals]') as HTMLElement | null;
    expect(article?.className).not.toContain('backdrop-blur');
    expect(article?.className).not.toContain('backdrop-saturate');
    expect(article?.style.backdropFilter).toBe('');
    expect(article?.getAttribute('style')).not.toContain('backdrop-filter');
  });

  it('折叠态只显示标题，不显示正文', async () => {
    await renderVisuals({ title: '已折叠便签', isCollapsed: true });
    const article = container.querySelector('[data-note-visuals]') as HTMLElement | null;
    expect(article?.style.height).toBe('36px');
    expect(container.textContent).toContain('已折叠便签');
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('折叠态无标题时显示占位符"无标题"', async () => {
    await renderVisuals({ title: '', isCollapsed: true });
    expect(container.textContent).toContain('无标题');
  });

  it('展开态显示标题和正文', async () => {
    await renderVisuals({ title: '测试标题', content: '测试内容' });
    expect(container.textContent).toContain('测试标题');
    expect(container.textContent).toContain('测试内容');
  });

  it('展开态无标题时隐藏标题区域', async () => {
    await renderVisuals({ title: '', content: '只有内容' });
    const titleDiv = container.querySelector('.text-text-primary.font-bold');
    expect(titleDiv?.className).toContain('hidden');
  });

  it('展开态无内容时显示占位符"记点什么…"', async () => {
    await renderVisuals({ title: '标题', content: '' });
    expect(container.textContent).toContain('记点什么…');
  });

  it('只读渲染：不包含 input 或 textarea 元素', async () => {
    await renderVisuals();
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('backgroundColor 根据 color 和 isDark 正确计算', async () => {
    await renderVisuals({ color: '#fef9c3', isDark: false });
    const article = container.querySelector('[data-note-visuals]') as HTMLElement | null;
    expect(article?.style.backgroundColor).toBe(hexToRgbString(getNoteColor('#fef9c3', false)));

    await renderVisuals({ color: '#fef9c3', isDark: true });
    const articleDark = container.querySelector('[data-note-visuals]') as HTMLElement | null;
    expect(articleDark?.style.backgroundColor).toBe(hexToRgbString(getNoteColor('#fef9c3', true)));
  });

  it('浅色模式 isDragging 增强外层阴影', async () => {
    await renderVisuals({ isDragging: true });
    const article = container.querySelector('[data-note-visuals]') as HTMLElement | null;
    expect(article?.style.boxShadow).toContain('0 12px 24px');
  });
});
