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
  updateTitle: (id: string, title: string) => void;
  updateNote: (id: string, content: string) => void;
  moveNote: (id: string, x: number, y: number) => void;
  bringToFront: (id: string) => void;
  deleteNote: (id: string) => void;
  changeColor: (id: string, color: string) => void;
  toggleCollapse: (id: string) => void;
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
      let finalData: StorageData = { notes: [], config: DEFAULT_CONFIG };
      let source: 'WAL' | 'DISK' | 'NEW' = 'NEW';

      // 1. Load both sources in parallel
      const [walData, diskJson] = await Promise.all([
        db.loadWAL(),
        invoke<string>('load_content', { filename: 'data.json' }).catch(() => null)
      ]);

      let diskData: StorageData | null = null;
      if (diskJson) {
        try {
          const parsed = JSON.parse(diskJson);
          if (parsed && Array.isArray(parsed.notes)) {
            diskData = parsed;
          }
        } catch (e) {
          console.warn('Failed to parse disk data:', e);
        }
      }

      // 2. Conflict Resolution: Timestamp Arbitration
      const getLatestUpdate = (data: StorageData | null | undefined) => {
        if (!data || data.notes.length === 0) return 0;
        return Math.max(...data.notes.map(n => n.updatedAt || 0));
      };

      const walTime = getLatestUpdate(walData);
      const diskTime = getLatestUpdate(diskData);

      console.log(`Init Arbitration -> WAL: ${walTime}, DISK: ${diskTime}`);

      // Decision Logic
      if (diskData && diskTime > walTime) {
        // Disk is newer (or WAL is empty/stale) -> Use Disk
        console.log('Using DISK (Newer content found)');
        finalData = diskData;
        source = 'DISK';
      } else if (walData && walData.notes.length > 0) {
        // WAL is newer or equal -> Use WAL
        console.log('Using WAL (Cache is active)');
        finalData = walData;
        source = 'WAL';
      } else if (diskData) {
        // Fallback to Disk if WAL is empty
        console.log('Using DISK (WAL empty)');
        finalData = diskData;
        source = 'DISK';
      }

      // 3. Hydrate State
      if (finalData.notes.length > 0) {
        const currentMaxZ = Math.max(...finalData.notes.map(n => n.z || 0), 0);
        finalData.config.maxZ = Math.max(currentMaxZ, finalData.notes.length);
        
        // Data Migration / Sanity Check
        finalData.notes.forEach((n, i) => {
           if (n.x < 0 || n.y < 0) { n.x = 20 + (i * 10); n.y = 20 + (i * 10); }
           if (n.collapsed === undefined) n.collapsed = false;
           if (n.title === undefined) n.title = "";
           if (!n.updatedAt) n.updatedAt = n.createdAt || Date.now();
        });
      }

      set((state) => {
        state.notes = finalData.notes;
        state.config = finalData.config;
        state.isLoaded = true;
      });
      
      // 4. Sync Sources
      // If we chose DISK, we must update the stale WAL immediately
      if (source === 'DISK') {
          await db.saveWAL(finalData);
      }
      // If we chose WAL (and it was indeed newer), we eventually save to disk,
      // but only if it strictly has changes. 
      // Safe default: If loading from WAL, trigger a lazy save to ensure consistency.
      if (source === 'WAL') {
          get().saveToDisk(); 
      }
    },

    addNote: (x, y) => {
      const newNote: Note = {
        id: crypto.randomUUID(),
        title: '',
        content: '',
        x,
        y,
        z: get().config.maxZ + 1,
        color: NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)],
        collapsed: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      set((state) => {
        state.notes.push(newNote);
        state.config.maxZ += 1;
      });

      get().saveToDisk();
    },

    updateTitle: (id, title) => {
      set((state) => {
        const note = state.notes.find((n) => n.id === id);
        if (note) {
          note.title = title;
          note.updatedAt = Date.now();
        }
      });
      
      // Throttle WAL save
      const now = Date.now();
      if (now - lastWALSave > WAL_THROTTLE) {
        lastWALSave = now;
        db.saveWAL({ notes: get().notes, config: get().config });
      }
      
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => get().saveToDisk(), DEBOUNCE_DELAY);
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

    toggleCollapse: (id) => {
      set((state) => {
        const note = state.notes.find((n) => n.id === id);
        if (note) {
          note.collapsed = !note.collapsed;
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

      const jsonString = JSON.stringify({ notes, config }, null, 2);
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
