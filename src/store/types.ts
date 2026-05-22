export type NoteColor = string;

// Windows 11 Inspired Solid Pastels
// Opaque colors for better readability and "Solid" feel
export const NOTE_COLORS: NoteColor[] = [
  "#FFFFFF", // Pure White (Default)
  "#fef9c3", // Yellow-100
  "#dcfce7", // Green-100
  "#ccfbf1", // Teal-100
  "#dbeafe", // Blue-100
  "#f3e8ff", // Purple-100
  "#fce7f3", // Pink-100
  "#ffedd5", // Orange-100
  "#fee2e2", // Red-100
  "#f1f5f9", // Slate-100
  "#ecfccb", // Lime-100
  "#cffafe", // Cyan-100
  "#ffe4e6", // Rose-100
];

// NOTE_COLOR_MAP_DARK_MODE: 深色模式下的便签颜色映射 (亮色 -> 深色增强可读性底色)
// 使用更深的半透明染色底，避免浅色便签在深色主题下发灰、发白、正文对比不足。
export const NOTE_COLOR_MAP_DARK_MODE: Record<NoteColor, string> = {
  "#FFFFFF": "rgba(71, 85, 105, 0.32)",   // White -> Slate-tinted neutral
  "#fef9c3": "rgba(161, 98, 7, 0.34)",    // Yellow -> Dark amber
  "#dcfce7": "rgba(21, 128, 61, 0.32)",   // Green -> Deep green
  "#ccfbf1": "rgba(15, 118, 110, 0.32)",  // Teal -> Deep teal
  "#dbeafe": "rgba(29, 78, 216, 0.34)",   // Blue -> Deep blue
  "#f3e8ff": "rgba(126, 34, 206, 0.34)",  // Purple -> Deep purple
  "#fce7f3": "rgba(190, 24, 93, 0.32)",   // Pink -> Deep pink
  "#ffedd5": "rgba(194, 65, 12, 0.34)",   // Orange -> Deep orange
  "#fee2e2": "rgba(185, 28, 28, 0.32)",   // Red -> Deep red
  "#f1f5f9": "rgba(71, 85, 105, 0.34)",   // Slate -> Deep slate
  "#ecfccb": "rgba(77, 124, 15, 0.32)",   // Lime -> Deep lime
  "#cffafe": "rgba(14, 116, 144, 0.32)",  // Cyan -> Deep cyan
  "#ffe4e6": "rgba(190, 18, 60, 0.32)",   // Rose -> Deep rose
};

// 根据当前主题获取便签颜色
export function getNoteColor(color: NoteColor, isDarkMode: boolean): string {
  if (!isDarkMode) return color;

  // 1. Try exact match
  if (NOTE_COLOR_MAP_DARK_MODE[color]) {
    return NOTE_COLOR_MAP_DARK_MODE[color];
  }

  // 2. Try case-insensitive match (Normalize)
  const lowerColor = color.toLowerCase();
  const foundKey = Object.keys(NOTE_COLOR_MAP_DARK_MODE).find(k => k.toLowerCase() === lowerColor);
  if (foundKey) {
    return NOTE_COLOR_MAP_DARK_MODE[foundKey];
  }

  // 3. Fallback for unknown/legacy colors
  // 保持为偏深的中性色，避免未知浅色在深色模式下刺眼。
  return "rgba(71, 85, 105, 0.28)";
}

export interface Note {
  id: string;
  boardId: string; // New field
  x: number;
  y: number;
  title: string;
  content: string;
  color: NoteColor;
  z: number;
  width?: number;
  height?: number;
  collapsed?: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null; // Soft delete timestamp. If present, note is in Trash.
}

export interface Board {
  id: string;
  name: string;
  icon: string; // Emoji or Lucide icon name
  createdAt: number;
  viewport?: { x: number; y: number };
}

export type ThemeMode = 'light' | 'dark' | 'system';

export interface AppConfig {
  version: number;
  maxZ: number;
  maximized?: boolean;
  themeMode: ThemeMode;
}

export interface ViewportState {
  x: number; // World x of top-left viewport
  y: number; // World y of top-left viewport
  w: number; // Width of viewport (shell content area)
  h: number; // Height of viewport (shell content area)
}

export interface ShellRectState {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface AppCanvasState {
  w: number; // Total width of the world
  h: number; // Total height of the world
}

export interface InteractionState {
  isPanMode: boolean; // Space key pressed
  isDragging: boolean; // Global drag state (for disabling tooltips etc)
  edgePush: {
    top: boolean;
    bottom: boolean;
    left: boolean;
    right: boolean;
  };
}

export type StickyDragStatus = 'active' | 'suspended';

export type ViewMode = 'BOARD' | 'TRASH';

export interface ContextMenuState {
  isOpen: boolean;
  x: number;
  y: number;
  type: 'CANVAS' | 'NOTE';
  targetId?: string;
}

export interface StorageData {
  notes: Note[];
  boards: Board[];
  currentBoardId: string;
  config: AppConfig;
}

export interface NormalizedNotesState {
  notesById: Record<string, Note>;
  allNoteIds: string[];
  boardNoteIds: Record<string, string[]>;
}

export interface LayoutNote {
  id: string;
  x: number;
  y: number;
  boardId: string;
  deletedAt: number | null;
  color: NoteColor;
  width?: number;
  height?: number;
}



export const DEFAULT_BOARD: Board = {
  id: 'default',
  name: '主板 (Main)',
  icon: '📌',
  createdAt: 0
};

export const DEFAULT_CONFIG: AppConfig = {
  version: 2, // Bump version
  maxZ: 1,
  themeMode: 'system',
};

// Board Icons for Random Picker
export const BOARD_ICONS = ['💡', '🚀', '🎨', '🧸', '📅', '🛒', '🎵', '📚', '💼', '🏠'];

export interface SaveResult {
  success: boolean;
  error?: string;
  io_duration_ms: number;
  retries: number;
}
