/**
 * 从 NoteCard 抽取的纯视觉样式计算函数。
 * NoteVisuals 与 NoteCard 共用此模块，避免两套视觉逻辑分叉。
 * 所有函数均为纯函数：输入相同的参数，输出相同的样式字符串，不依赖 React 状态或 DOM。
 */

export function hexToRgbChannels(hex: string): { red: number; green: number; blue: number } {
  const normalized = hex.replace('#', '');
  const expanded = normalized.length === 3
    ? normalized
        .split('')
        .map((channel) => `${channel}${channel}`)
        .join('')
    : normalized;

  if (expanded.length !== 6) {
    return { red: 59, green: 130, blue: 246 };
  }

  const red = Number.parseInt(expanded.slice(0, 2), 16);
  const green = Number.parseInt(expanded.slice(2, 4), 16);
  const blue = Number.parseInt(expanded.slice(4, 6), 16);

  if (Number.isNaN(red) || Number.isNaN(green) || Number.isNaN(blue)) {
    return { red: 59, green: 130, blue: 246 };
  }

  return { red, green, blue };
}

export function toRgba(hex: string, alpha: number): string {
  const { red, green, blue } = hexToRgbChannels(hex);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

export function buildNoteSurfaceBackground(
  isDark: boolean,
  accentHex: string,
  isEmphasized: boolean,
): string {
  if (!isDark) {
    return 'linear-gradient(180deg, rgba(255,255,255,0.3) 0%, rgba(255,255,255,0) 50%)';
  }

  const radialLead = isEmphasized ? 0.28 : 0.22;
  const radialMid = isEmphasized ? 0.1 : 0.075;

  return [
    `radial-gradient(138% 112% at 15% 0%, ${toRgba(accentHex, radialLead)} 0%, ${toRgba(accentHex, radialMid)} 36%, ${toRgba(accentHex, 0.018)} 62%, transparent 82%)`,
    'linear-gradient(155deg, rgba(255,255,255,0.11) 0%, rgba(255,255,255,0.034) 20%, transparent 54%)',
    'linear-gradient(180deg, rgba(255,255,255,0.038) 0%, rgba(0,0,0,0.045) 76%, rgba(0,0,0,0.15) 100%)',
  ].join(', ');
}

export function getDarkBorderColor(
  accentHex: string,
  fallbackBorder: string,
  isActive: boolean,
  isDragging: boolean,
  isSelected: boolean,
  isGroupSelection: boolean,
): string {
  if (isDragging) {
    return toRgba(accentHex, 0.64);
  }

  if (isSelected) {
    return toRgba(accentHex, isGroupSelection ? 0.58 : 0.48);
  }

  if (isActive) {
    return toRgba(accentHex, 0.4);
  }

  return fallbackBorder;
}

export function buildNoteMaterialShadow(
  isDark: boolean,
  accentHex: string,
  isActive: boolean,
  isDragging: boolean,
  isSelected: boolean,
  isGroupSelection: boolean,
): string {
  if (!isDark) {
    const inset = isActive
      ? 'inset 0 1px 1px rgba(255,255,255,0.4)'
      : 'inset 0 1px 1px rgba(255,255,255,0.3)';
    const outer = isDragging
      ? '0 12px 24px rgba(0,0,0,0.08)'
      : isActive
        ? '0 4px 14px rgba(0,0,0,0.08)'
        : '0 2px 8px rgba(0,0,0,0.05)';

    let shadow = `${inset}, ${outer}`;

    if (isSelected && !isDragging) {
      const ringColor = isGroupSelection ? 'rgba(59,130,246,0.55)' : 'rgba(59,130,246,0.3)';
      const glowColor = isGroupSelection ? 'rgba(59,130,246,0.12)' : 'rgba(59,130,246,0.08)';
      shadow += `, 0 0 0 2px ${ringColor}, 0 0 0 1px ${glowColor}`;
    }

    return shadow;
  }

  const outer = isDragging
    ? '0 14px 30px -14px rgba(0,0,0,0.82)'
    : isActive || isSelected
      ? '0 10px 24px -12px rgba(0,0,0,0.78)'
      : '0 8px 20px -12px rgba(0,0,0,0.72)';

  const accentEdgeAlpha = isDragging
    ? 0.18
    : isSelected
      ? (isGroupSelection ? 0.2 : 0.14)
      : isActive
        ? 0.1
        : 0.035;

  const accentGlowAlpha = isDragging
    ? 0.28
    : isSelected
      ? (isGroupSelection ? 0.36 : 0.28)
      : isActive
        ? 0.22
        : 0;

  const layers = [
    `inset 0 1px 0 ${isActive || isSelected ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.14)'}`,
    'inset 1px 0 0 rgba(255,255,255,0.045)',
    'inset 0 -1px 0 rgba(0,0,0,0.3)',
    outer,
    `0 0 0 1px ${toRgba(accentHex, accentEdgeAlpha)}`,
  ];

  if (accentGlowAlpha > 0) {
    layers.push(`0 0 24px -10px ${toRgba(accentHex, accentGlowAlpha)}`);
  }

  return layers.join(', ');
}
