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

// NOTE_COLOR_MAP_DARK_MODE: 深色模式下的便签颜色映射 (亮色 -> 深色)
// OPTION D: GLASSMORPHISM (Translucent, Modern) - The Single Source of Truth
// Uses semi-transparent colors that blend with the dark background.
// Requires 'backdrop-blur' on the component for full effect.
export const NOTE_COLOR_MAP_DARK_MODE: Record<NoteColor, string> = {
  "#FFFFFF": "rgba(255, 255, 255, 0.08)", // White -> Glassy White
  "#fef9c3": "rgba(234, 179, 8, 0.2)",   // Yellow -> Glassy Gold
  "#dcfce7": "rgba(34, 197, 94, 0.2)",   // Green -> Glassy Emerald
  "#ccfbf1": "rgba(20, 184, 166, 0.2)",  // Teal -> Glassy Teal
  "#dbeafe": "rgba(59, 130, 246, 0.25)",  // Blue -> Glassy Blue
  "#f3e8ff": "rgba(168, 85, 247, 0.25)",  // Purple -> Glassy Purple
  "#fce7f3": "rgba(236, 72, 153, 0.2)",  // Pink -> Glassy Pink
  "#ffedd5": "rgba(249, 115, 22, 0.2)",  // Orange -> Glassy Orange
  "#fee2e2": "rgba(239, 68, 68, 0.2)",   // Red -> Glassy Red
  "#f1f5f9": "rgba(148, 163, 184, 0.2)", // Slate -> Glassy Slate
  "#ecfccb": "rgba(132, 204, 22, 0.2)",  // Lime -> Glassy Lime
  "#cffafe": "rgba(6, 182, 212, 0.2)",   // Cyan -> Glassy Cyan
  "#ffe4e6": "rgba(244, 63, 94, 0.2)",   // Rose -> Glassy Rose
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

  // 3. Fallback for unknown/legacy colors (Fix for missing colors)
  // Return a generic glass effect so it doesn't stay blindingly bright
  return "rgba(255, 255, 255, 0.05)";
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
  w: number; // Width of viewport (window.innerWidth)
  h: number; // Height of viewport (window.innerHeight)
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
