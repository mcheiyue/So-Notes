import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { invoke } from '@tauri-apps/api/core';
import { Note, AppConfig, StorageData, DEFAULT_CONFIG, NOTE_COLORS } from './types';
import { db } from './db';

interface State {
  notes: Note[];
  config: AppConfig;
  isLoaded: boolean;
  isSaving: boolean;
  
  // Sticky Drag State
  stickyDrag: {
    id: string | null;
    offsetX: number;
    offsetY: number;
  };

  // Actions
  init: () => Promise<void>;
  addNote: (x: number, y: number) => void;
  updateNote: (id: string, content: string) => void;
  moveNote: (id: string, x: number, y: number) => void;
  bringToFront: (id: string) => void;
  deleteNote: (id: string) => void;
  changeColor: (id: string, color: string) => void;
  setStickyDrag: (id: string | null, offsetX?: number, offsetY?: number) => void;
  saveToDisk: () => Promise<void>;
}

// Helper to debounce disk saves
let saveTimeout: ReturnType<typeof setTimeout> | null = null;

const DEBOUNCE_DELAY = 2000; // 2 seconds lazy save
const WAL_THROTTLE = 100;    // 100ms throttle for IndexedDB

let lastWALSave = 0;

export const useStore = create<State>()(
  immer((set, get) => ({
    notes: [],
    config: DEFAULT_CONFIG,
    isLoaded: false,
    isSaving: false,
    
    stickyDrag: {
        id: null,
        offsetX: 0,
        offsetY: 0,
    },

    init: async () => {
      let loadedData: StorageData = { notes: [], config: DEFAULT_CONFIG };
      let fromWAL = false;
      let fromDisk = false;
      
      // 1. Try WAL first (Fastest)
      const walData = await db.loadWAL();
      if (walData) {
        console.log('Restored from WAL');
        loadedData = walData;
        fromWAL = true;
      }

      // 2. If WAL is empty, try loading from Disk (Recovery/Migration)
      if (!fromWAL || loadedData.notes.length === 0) {
        try {
          const jsonContent = await invoke<string>('load_content', { filename: 'data.json' });
          if (jsonContent) {
            const parsed = JSON.parse(jsonContent);
            // Basic validation
            if (parsed && Array.isArray(parsed.notes)) {
               console.log('Restored from Disk (Recovery)');
               loadedData = parsed;
               fromDisk = true;
            }
          }
        } catch (e) {
          console.warn('No disk backup found or load failed:', e);
        }
      }

      if (loadedData.notes.length > 0) {
        const currentMaxZ = Math.max(...loadedData.notes.map(n => n.z || 0), 0);
        loadedData.config.maxZ = Math.max(currentMaxZ, loadedData.notes.length);
        
        loadedData.notes.forEach((n, i) => {
          if (n.x < 0 || n.y < 0) {
             n.x = 20 + (i * 10);
             n.y = 20 + (i * 10);
          }
        });
      }

      set((state) => {
        state.notes = loadedData.notes;
        state.config = loadedData.config;
        state.isLoaded = true;
      });
      
      // If we recovered from disk, save back to WAL immediately so next boot is fast
      if (fromDisk) {
         db.saveWAL(loadedData);
      }
      
      // If we loaded from WAL but want to ensure disk is in sync (optional, but good practice)
      if (fromWAL) {
        get().saveToDisk();
      }
    },

    addNote: (x, y) => {
      const newNote: Note = {
        id: crypto.randomUUID(),
        content: '',
        x,
        y,
        z: get().config.maxZ + 1,
        color: NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      set((state) => {
        state.notes.push(newNote);
        state.config.maxZ += 1;
      });

      get().saveToDisk();
    },

    updateNote: (id, content) => {
      set((state) => {
        const note = state.notes.find((n) => n.id === id);
        if (note) {
          note.content = content;
          note.updatedAt = Date.now();
        }
      });
      
      const now = Date.now();
      if (now - lastWALSave > WAL_THROTTLE) {
        lastWALSave = now;
        db.saveWAL({ notes: get().notes, config: get().config });
      }
      
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => get().saveToDisk(), DEBOUNCE_DELAY);
    },

    moveNote: (id, x, y) => {
      set((state) => {
        const note = state.notes.find((n) => n.id === id);
        if (note) {
          note.x = x;
          note.y = y;
        }
      });
      
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => get().saveToDisk(), DEBOUNCE_DELAY);
    },

    bringToFront: (id) => {
      set((state) => {
        const note = state.notes.find((n) => n.id === id);
        if (note) {
          state.config.maxZ += 1;
          note.z = state.config.maxZ;
        }
      });
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => get().saveToDisk(), DEBOUNCE_DELAY);
    },

    deleteNote: (id) => {
      set((state) => {
        state.notes = state.notes.filter((n) => n.id !== id);
      });
      get().saveToDisk();
    },
    
    changeColor: (id, color) => {
      set((state) => {
         const note = state.notes.find((n) => n.id === id);
         if (note) {
           note.color = color;
         }
      });
      get().saveToDisk();
    },
    
    setStickyDrag: (id, offsetX = 0, offsetY = 0) => {
        set((state) => {
            state.stickyDrag = { id, offsetX, offsetY };
        });
    },

    saveToDisk: async () => {
      const { notes, config } = get();
      set({ isSaving: true });
      await db.saveWAL({ notes, config });

      const jsonString = JSON.stringify({ notes, config });
      try {
        await invoke('save_content', { filename: 'data.json', content: jsonString });
      } catch (err) {
        console.error('Disk Save Failed:', err);
      } finally {
        set({ isSaving: false });
      }
    },
  }))
);
