export type NoteColor = string;

export interface DarkSpectrum {
  bg: string;
  border: string;
  accent: string;
}

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

// 6 色 UI 调色板：ContextMenu、SelectionActionBar、NoteCard 共用。
// 从 NOTE_COLORS 中选取视觉区分度最高的 6 种，其余颜色仅保留持久化兼容。
export const NOTE_UI_COLORS: NoteColor[] = [
  "#FFFFFF", // 白
  "#fef9c3", // 黄
  "#dcfce7", // 绿
  "#dbeafe", // 蓝
  "#fee2e2", // 红
  "#f3e8ff", // 紫
];

// NOTE_COLORS 继续作为持久化层的浅色单一事实来源。
// 深色模式渲染时，再从这里派生出无 backdrop 的 tinted acrylic 光谱参数。
export const DEFAULT_NOTE_DARK_SPECTRUM: DarkSpectrum = {
  bg: "#131e31",
  border: "#223452",
  accent: "#3b82f6",
};

export const NOTE_COLOR_MAP_DARK_MODE: Record<NoteColor, DarkSpectrum> = {
  "#FFFFFF": { bg: "#131e31", border: "#223452", accent: "#3b82f6" },
  "#fef9c3": { bg: "#251c0c", border: "#413014", accent: "#f59e0b" },
  "#dcfce7": { bg: "#0e2417", border: "#173f27", accent: "#10b981" },
  "#ccfbf1": { bg: "#0b2423", border: "#143f3d", accent: "#14b8a6" },
  "#dbeafe": { bg: "#131e31", border: "#223452", accent: "#3b82f6" },
  "#f3e8ff": { bg: "#1d152f", border: "#332353", accent: "#a855f7" },
  "#fce7f3": { bg: "#27111d", border: "#451a32", accent: "#ec4899" },
  "#ffedd5": { bg: "#29170e", border: "#462413", accent: "#f97316" },
  "#fee2e2": { bg: "#281215", border: "#471b21", accent: "#ef4444" },
  "#f1f5f9": { bg: "#202633", border: "#353f54", accent: "#94a3b8" },
  "#ecfccb": { bg: "#1c240c", border: "#313f14", accent: "#84cc16" },
  "#cffafe": { bg: "#0b2229", border: "#133a46", accent: "#06b6d4" },
  "#ffe4e6": { bg: "#271115", border: "#451921", accent: "#f43f5e" },
};

function resolveNoteDarkSpectrum(color: NoteColor): DarkSpectrum | undefined {
  if (NOTE_COLOR_MAP_DARK_MODE[color]) {
    return NOTE_COLOR_MAP_DARK_MODE[color];
  }

  const lowerColor = color.toLowerCase();
  const foundKey = Object.keys(NOTE_COLOR_MAP_DARK_MODE).find((key) => key.toLowerCase() === lowerColor);
  return foundKey ? NOTE_COLOR_MAP_DARK_MODE[foundKey] : undefined;
}

export function getNoteDarkSpectrum(color: NoteColor): DarkSpectrum {
  return resolveNoteDarkSpectrum(color) ?? DEFAULT_NOTE_DARK_SPECTRUM;
}

// 根据当前主题获取便签颜色
export function getNoteColor(color: NoteColor, isDarkMode: boolean): string {
  if (!isDarkMode) return color;
  return getNoteDarkSpectrum(color).bg;
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

export type NoteHighlightReason = 'created' | 'located' | 'edited';

export interface NoteHighlight {
  reason: NoteHighlightReason;
  token: number;
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

export const STORAGE_SCHEMA_VERSION = 1;

export interface StorageData {
  schemaVersion: number;
  storageUpdatedAt: number;
  notes: Note[];
  boards: Board[];
  currentBoardId: string;
  config: AppConfig;
}

export type StorageDataInput = Omit<StorageData, 'schemaVersion' | 'storageUpdatedAt'> & Partial<Pick<StorageData, 'schemaVersion' | 'storageUpdatedAt'>>;

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
  name: '主板',
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
