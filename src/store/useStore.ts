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
  
  // Actions
  init: () => Promise<void>;
  addNote: (x: number, y: number) => void;
  updateNote: (id: string, content: string) => void;
  moveNote: (id: string, x: number, y: number) => void;
  bringToFront: (id: string) => void;
  deleteNote: (id: string) => void;
  changeColor: (id: string, color: string) => void;
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

    init: async () => {
      // 1. Rehydration Logic
      // Attempt to load from JSON first (Persisted)
      // Then load from IDB (WAL)
      // Merge: IDB overwrites JSON if valid
      
      let loadedData: StorageData = { notes: [], config: DEFAULT_CONFIG };
      let fromWAL = false;

      // TODO: Load from Rust fs (data.json)
      // For MVP, we assume empty or load from IDB primarily
      
      const walData = await db.loadWAL();
      if (walData) {
        console.log('Restored from WAL');
        loadedData = walData;
        fromWAL = true;
      }

      // Normalization of Z-Index & Boundary Check
      if (loadedData.notes.length > 0) {
        loadedData.notes.sort((a, b) => a.z - b.z);
        loadedData.notes.forEach((n, i) => {
          n.z = i + 1;
          
          // Safety Boundary Check: If note is off-screen (negative coords), reset it.
          // This rescues notes lost in "The Void".
          if (n.x < 0 || n.y < 0) {
             n.x = 20 + (i * 10); // Cascade slightly
             n.y = 20 + (i * 10);
          }
        });
        loadedData.config.maxZ = loadedData.notes.length;
      }

      set((state) => {
        state.notes = loadedData.notes;
        state.config = loadedData.config;
        state.isLoaded = true;
      });
      
      // If we restored from WAL, force a disk flush immediately
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

      get().saveToDisk(); // Trigger save logic (WAL + Lazy Disk)
    },

    updateNote: (id, content) => {
      set((state) => {
        const note = state.notes.find((n) => n.id === id);
        if (note) {
          note.content = content;
          note.updatedAt = Date.now();
        }
      });
      
      // High frequency update -> WAL Throttle
      const now = Date.now();
      if (now - lastWALSave > WAL_THROTTLE) {
        lastWALSave = now;
        db.saveWAL({ notes: get().notes, config: get().config });
      }
      
      // Disk -> Debounce
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
      
      // Layout change -> Lazy Save only
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
      // No immediate save for Z-index only
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

    saveToDisk: async () => {
      const { notes, config } = get();
      set({ isSaving: true });

      // 1. Save to IDB (WAL) immediately to be safe
      await db.saveWAL({ notes, config });

      // 2. Save to Disk via Rust
      const jsonString = JSON.stringify({ notes, config });
      try {
        await invoke('save_content', { filename: 'data.json', content: jsonString });
        
        // On success, we could clear WAL, but keeping it as a hot cache is also fine.
        // Plan said: "flush_wal_to_disk... on success clear IDB".
        // But for "Level 1" WAL, it acts as a mirror.
        // We only clear if we want to ensure we rely on disk next time.
        // But let's leave it as mirror. Rehydration logic handles the merge.
        
        // Actually, if we clear WAL, we might lose data if disk write succeeded but IDB clear failed? No.
        // If disk write succeeded, we are safe.
        // Let's NOT clear WAL for now, just overwrite it constantly. 
        // Rehydration prefers WAL if present.
        
      } catch (err) {
        console.error('Disk Save Failed:', err);
        // TODO: Toast notification
      } finally {
        set({ isSaving: false });
      }
    },
  }))
);
