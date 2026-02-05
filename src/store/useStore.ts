import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { invoke } from '@tauri-apps/api/core';
import { Note, AppConfig, StorageData, DEFAULT_CONFIG, NOTE_COLORS, ContextMenuState, Board, DEFAULT_BOARD } from './types';
import { db } from './db';

interface State {
  notes: Note[];
  boards: Board[];
  currentBoardId: string;
  config: AppConfig;
  isLoaded: boolean;
  isSaving: boolean;
  
  // Sticky Drag State
  stickyDrag: {
    id: string | null;
    offsetX: number;
    offsetY: number;
  };

  // Selection & UI State
  selectedIds: string[];
  contextMenu: ContextMenuState;
  
  // Dock UI State (Transient)
  isDockVisible: boolean;

  // Actions
  init: () => Promise<void>;
  
  // Board Actions
  switchBoard: (boardId: string) => void;
  createBoard: (name: string, icon: string) => void;
  deleteBoard: (boardId: string) => void;
  updateBoard: (boardId: string, updates: Partial<Board>) => void;
  setDockVisible: (visible: boolean) => void;

  addNote: (x: number, y: number) => void;
  addNoteWithContent: (x: number, y: number, content: string) => void;
  updateTitle: (id: string, title: string) => void;
  updateNote: (id: string, content: string) => void;
  moveNote: (id: string, x: number, y: number) => void;
  moveSelectedNotes: (dx: number, dy: number, excludeId?: string) => void;
  arrangeNotes: (startX?: number, startY?: number) => void;
  bringToFront: (id: string) => void;
  deleteNote: (id: string) => void;
  deleteSelectedNotes: () => void; // Batch delete
  changeColor: (id: string, color: string) => void;
  changeSelectedNotesColor: (color: string) => void;
  toggleCollapse: (id: string) => void;
  setStickyDrag: (id: string | null, offsetX?: number, offsetY?: number) => void;
  
  // New Actions for v1.1.1
  duplicateNote: (id: string) => void;
  moveNoteToBoard: (id: string, targetBoardId: string) => void;
  copyNoteToBoard: (id: string, targetBoardId: string) => void;

  // Selection Actions
  setSelectedIds: (ids: string[]) => void;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  setContextMenu: (menu: ContextMenuState) => void;

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

    selectedIds: [],
    contextMenu: { isOpen: false, x: 0, y: 0, type: 'CANVAS' },
    
    // New State Init
    boards: [DEFAULT_BOARD],
    currentBoardId: DEFAULT_BOARD.id,
    isDockVisible: false,

    init: async () => {
      let finalData: StorageData = { 
        notes: [], 
        boards: [DEFAULT_BOARD], 
        currentBoardId: DEFAULT_BOARD.id, 
        config: DEFAULT_CONFIG 
      };
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

      // console.log(`Init Arbitration -> WAL: ${walTime}, DISK: ${diskTime}`);

      // Decision Logic
      if (diskData && diskTime > walTime) {
        // Disk is newer (or WAL is empty/stale) -> Use Disk
        // console.log('Using DISK (Newer content found)');
        finalData = diskData;
        source = 'DISK';
      } else if (walData && walData.notes.length > 0) {
        // WAL is newer or equal -> Use WAL
        // console.log('Using WAL (Cache is active)');
        finalData = walData;
        source = 'WAL';
      } else if (diskData) {
        // Fallback to Disk if WAL is empty
        // console.log('Using DISK (WAL empty)');
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
           if (!n.boardId) n.boardId = 'default'; // Migration: Assign default board
           if (!n.updatedAt) n.updatedAt = n.createdAt || Date.now();
        });
      }
      
      // Ensure boards exist (Migration from v1.0.9)
      if (!finalData.boards || finalData.boards.length === 0) {
          finalData.boards = [DEFAULT_BOARD];
          finalData.currentBoardId = DEFAULT_BOARD.id;
      }
      // Ensure currentBoardId is valid
      if (!finalData.currentBoardId || !finalData.boards.find(b => b.id === finalData.currentBoardId)) {
          finalData.currentBoardId = finalData.boards[0].id;
      }

      set((state) => {
        state.notes = finalData.notes;
        state.config = finalData.config;
        state.boards = finalData.boards;
        state.currentBoardId = finalData.currentBoardId;
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

    switchBoard: (boardId) => {
        set((state) => {
            if (state.boards.find(b => b.id === boardId)) {
                state.currentBoardId = boardId;
                state.selectedIds = []; // Clear selection to prevent ghost edits
                state.stickyDrag = { id: null, offsetX: 0, offsetY: 0 }; // Reset drag
                
                // Force Scroll Reset (Fix Viewport Shift)
                window.scrollTo(0, 0);
            }
        });
    },

    createBoard: (name, icon) => {
        const newBoard: Board = {
            id: crypto.randomUUID(),
            name,
            icon,
            createdAt: Date.now()
        };
        set((state) => {
            state.boards.push(newBoard);
            state.currentBoardId = newBoard.id; // Auto-switch
            state.selectedIds = [];
        });
        get().saveToDisk();
    },

    deleteBoard: (boardId) => {
        const { boards } = get();
        if (boards.length <= 1) return; // Prevent deleting last board
        
        // Find fallback board
        const fallbackId = boards.find(b => b.id !== boardId)?.id || 'default';

        set((state) => {
            // Delete all notes in this board
            state.notes = state.notes.filter(n => n.boardId !== boardId);
            
            state.boards = state.boards.filter(b => b.id !== boardId);
            if (state.currentBoardId === boardId) {
                state.currentBoardId = fallbackId;
                state.selectedIds = [];
            }
        });
        get().saveToDisk();
    },
    
    updateBoard: (boardId, updates) => {
        set((state) => {
            const board = state.boards.find(b => b.id === boardId);
            if (board) {
                Object.assign(board, updates);
            }
        });
        get().saveToDisk();
    },

    setDockVisible: (visible) => set({ isDockVisible: visible }),

    addNote: (x, y) => {
      const newNote: Note = {
        id: crypto.randomUUID(),
        boardId: get().currentBoardId, // Assign to current board
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

    addNoteWithContent: (x, y, content) => {
      const newNote: Note = {
        id: crypto.randomUUID(),
        boardId: get().currentBoardId, // Assign to current board
        title: '', // Optional: extract first line as title? For now empty.
        content: content,
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
        db.saveWAL({ notes: get().notes, config: get().config, boards: get().boards, currentBoardId: get().currentBoardId });
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
        db.saveWAL({ notes: get().notes, config: get().config, boards: get().boards, currentBoardId: get().currentBoardId });
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

    moveSelectedNotes: (dx, dy, excludeId) => {
        set((state) => {
            state.selectedIds.forEach(id => {
                if (id === excludeId) return;
                const note = state.notes.find(n => n.id === id);
                if (note) {
                    note.x += dx;
                    note.y += dy;
                }
            });
        });
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => get().saveToDisk(), DEBOUNCE_DELAY);
    },

    arrangeNotes: (startX = 50, startY = 50) => {
        set((state) => {
            const winW = window.innerWidth;
            const COLUMN_WIDTH = 320; // Approx card width (300) + gap (20)
            const ROW_GAP = 20;
            
            // 1. Determine targets: Selection or All
            let targetNotes = state.notes;
            const isGroupArrange = state.selectedIds.length > 0;
            
            if (isGroupArrange) {
                targetNotes = state.notes.filter(n => state.selectedIds.includes(n.id));
            } else {
                // Fix: Only arrange notes in the current board!
                targetNotes = state.notes.filter(n => n.boardId === state.currentBoardId);
            }

            if (targetNotes.length === 0) return;

            // 2. Sort by spatial position (Top-Left -> Bottom-Right)
            // Weight Y more than X to form "reading order"
            // Primary Sort: Y (bands of 50px? No, precise Y)
            // Let's use simple Y * 10000 + X score? 
            // Better: Y then X.
            const sortedNotes = [...targetNotes].sort((a, b) => {
                const dy = a.y - b.y;
                if (Math.abs(dy) > 50) return dy; // If Y differs significantly, sort by Y
                return a.x - b.x; // Otherwise sort by X (same 'row')
            });

            // 3. Row-based Layout with Boundary Check
            let currentX = startX;
            let currentY = startY;
            let maxRowH = 0;
            
            // Boundary Guard for Start Position
            if (currentX + COLUMN_WIDTH > winW) currentX = Math.max(20, winW - COLUMN_WIDTH * 2);
            if (currentY > window.innerHeight - 100) currentY = 50; // Reset to top if starting too low

            sortedNotes.forEach((note) => {
                // Check if we need to wrap to new row
                if (currentX + COLUMN_WIDTH > winW - 20) {
                    currentX = startX;
                    currentY += maxRowH + ROW_GAP;
                    maxRowH = 0; // Reset row height
                }

                // Update Note Position in State
                // We need to find the actual note object in the drafted state
                const stateNote = state.notes.find(n => n.id === note.id);
                if (stateNote) {
                    stateNote.x = currentX;
                    stateNote.y = currentY;
                }

                // Advance X
                currentX += COLUMN_WIDTH;
                
                // Track max height for next row (assume default height 200 if not measured)
                // Since we don't know actual DOM height here, we assume a standard height or 
                // we could improve this by passing heights from UI.
                // For now, fixed row step or safe estimate.
                const estimatedHeight = note.collapsed ? 50 : 200; // Rough estimate
                if (estimatedHeight > maxRowH) maxRowH = estimatedHeight;
            });
        });
        get().saveToDisk();
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
        // Fix: Ghost Selection - also remove from selectedIds if present
        state.selectedIds = state.selectedIds.filter(selId => selId !== id);
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

    changeSelectedNotesColor: (color) => {
        set((state) => {
            state.selectedIds.forEach(id => {
                const note = state.notes.find(n => n.id === id);
                if (note) {
                    note.color = color;
                }
            });
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

    setSelectedIds: (ids) => {
        set((state) => {
            state.selectedIds = ids;
        });
    },

    toggleSelection: (id) => {
        set((state) => {
            if (state.selectedIds.includes(id)) {
                state.selectedIds = state.selectedIds.filter(i => i !== id);
            } else {
                state.selectedIds.push(id);
            }
        });
    },

    clearSelection: () => {
        set((state) => {
            state.selectedIds = [];
        });
    },

    setContextMenu: (menu) => {
        set((state) => {
            state.contextMenu = menu;
        });
    },

    deleteSelectedNotes: () => {
        const { selectedIds } = get();
        if (selectedIds.length === 0) return;
        
        set((state) => {
            state.notes = state.notes.filter(note => !selectedIds.includes(note.id));
            state.selectedIds = [];
        });
        get().saveToDisk();
    },

    duplicateNote: (id) => {
        set((state) => {
            const note = state.notes.find(n => n.id === id);
            if (note) {
                const newNote: Note = {
                    ...note,
                    id: crypto.randomUUID(),
                    x: note.x + 20,
                    y: note.y + 20,
                    z: state.config.maxZ + 1,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    // Title copy? Yes.
                };
                state.notes.push(newNote);
                state.config.maxZ += 1;
                // Auto-select the new note? Maybe not, to avoid confusion.
            }
        });
        get().saveToDisk();
    },

    moveNoteToBoard: (id, targetBoardId) => {
        set((state) => {
            const note = state.notes.find(n => n.id === id);
            if (note) {
                note.boardId = targetBoardId;
                // Smart Placement: Center it or Offset?
                // For now, let's just keep position but offset slightly to imply movement if they switch back
                // Or just keep it. "Stacked" issue is solved by user arranging.
                // But let's add a small random jitter to prevent perfect stacking if bulk moving.
                note.x += Math.floor(Math.random() * 20);
                note.y += Math.floor(Math.random() * 20);
                
                // CRITICAL: Remove from selection if moved away
                state.selectedIds = state.selectedIds.filter(selId => selId !== id);
            }
        });
        get().saveToDisk();
    },

    copyNoteToBoard: (id, targetBoardId) => {
        set((state) => {
            const note = state.notes.find(n => n.id === id);
            if (note) {
                const newNote: Note = {
                    ...note,
                    id: crypto.randomUUID(),
                    boardId: targetBoardId,
                    z: state.config.maxZ + 1,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                };
                // Jitter for target board
                newNote.x += Math.floor(Math.random() * 20);
                newNote.y += Math.floor(Math.random() * 20);
                
                state.notes.push(newNote);
                state.config.maxZ += 1;
            }
        });
        get().saveToDisk();
    },

    saveToDisk: async () => {
      const { notes, config, boards, currentBoardId } = get();
      set({ isSaving: true });
      await db.saveWAL({ notes, config, boards, currentBoardId });

      const jsonString = JSON.stringify({ notes, config, boards, currentBoardId }, null, 2);
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
