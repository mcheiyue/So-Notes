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
}

export interface AppConfig {
  version: number;
  maxZ: number;
  maximized?: boolean;
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
};

// Board Icons for Random Picker
export const BOARD_ICONS = ['💡', '🚀', '🎨', '🧸', '📅', '🛒', '🎵', '📚', '💼', '🏠'];
