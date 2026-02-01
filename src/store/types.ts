export type NoteColor = string;

// Windows 11 Inspired Solid Pastels
// Opaque colors for better readability and "Solid" feel
export const NOTE_COLORS: NoteColor[] = [
  "#FFFFFF", // Pure White (Default)
  "#FFF4CE", // Soft Yellow
  "#E4F7D2", // Soft Green
  "#D6EBFD", // Soft Blue
  "#F2E6FF", // Soft Purple
  "#FFDCE0", // Soft Red
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
