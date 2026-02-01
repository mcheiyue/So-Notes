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
  x: number;
  y: number;
  content: string;
  color: NoteColor;
  z: number;
  width?: number;
  height?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AppConfig {
  version: number;
  maxZ: number;
}

export interface StorageData {
  notes: Note[];
  config: AppConfig;
}

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  maxZ: 1,
};
