import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { invoke } from '@tauri-apps/api/core';
import { Note, AppConfig, StorageData, DEFAULT_CONFIG, NOTE_COLORS, ContextMenuState, Board, DEFAULT_BOARD, ViewMode, ViewportState, AppCanvasState, InteractionState, ThemeMode } from './types';
import { db } from './db';
import { generateBoardExport, generateFullBackup, processImport } from '../utils/dataTransfer';
import { saveFile, openFile } from '../utils/fileSystem';

interface State {
  notes: Note[];

  boards: Board[];
  currentBoardId: string;
  viewMode: ViewMode;
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
  
  // Viewport & Canvas State (v1.1.5)
  viewport: ViewportState;
  canvas: AppCanvasState;
  interaction: InteractionState;
  
  // Dock UI State (Transient)
  isDockVisible: boolean;
  isSpotlightOpen: boolean;

  // Actions
  init: () => Promise<void>;
  
  // Viewport Actions
  setSpotlightOpen: (isOpen: boolean) => void;
  setViewportSize: (w: number, h: number) => void;
  setPanMode: (isPan: boolean) => void;
  setEdgePush: (pushState: Partial<{ top: boolean; bottom: boolean; left: boolean; right: boolean }>) => void;
  panViewport: (dx: number, dy: number) => void; // Delta pan
  setViewportPosition: (x: number, y: number) => void; // Absolute pan
  setIsDragging: (isDragging: boolean) => void; // Global drag state
  expandCanvas: (w: number, h: number) => void; // Expand world boundaries

  // Board Actions
  switchBoard: (boardId: string) => void;
  setViewMode: (mode: ViewMode) => void;
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
  deleteNote: (id: string) => void; // Soft delete
  restoreNote: (id: string) => void; // Restore from Trash
  deleteNotePermanently: (id: string) => void; // Hard delete
  emptyTrash: () => void; // Hard delete all in Trash
  restoreAllTrash: () => void; // Restore all in Trash
  deleteSelectedNotes: () => void; // Batch soft delete
  changeColor: (id: string, color: string) => void;
  changeSelectedNotesColor: (color: string) => void;
  toggleCollapse: (id: string) => void;
  setStickyDrag: (id: string | null, offsetX?: number, offsetY?: number) => void;
  
  // New Actions for v1.1.1 & v1.1.2
  duplicateNote: (id: string) => void;
  duplicateSelectedNotes: () => void;
  moveNoteToBoard: (id: string, targetBoardId: string) => void;
  copyNoteToBoard: (id: string, targetBoardId: string) => void;
  moveSelectedNotesToBoard: (targetBoardId: string) => void;
  copySelectedNotesToBoard: (targetBoardId: string) => void;
  reorderBoard: (boardId: string, direction: 'left' | 'right') => void;

  // Selection Actions
  setSelectedIds: (ids: string[]) => void;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  selectAllNotes: () => void;
  setContextMenu: (menu: ContextMenuState) => void;

  saveToDisk: () => Promise<void>;
  
  // Data Transfer Actions
  exportBoard: (boardId: string) => Promise<void>;
  exportCurrentBoard: () => Promise<void>;
  exportAll: () => Promise<void>;
  importFromFile: () => Promise<void>;
  
  // Theme Action
  setThemeMode: (mode: ThemeMode) => void;
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
    
    // v1.1.5 Init
    viewport: { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight },
    canvas: { w: window.innerWidth, h: window.innerHeight },
    interaction: { 
        isPanMode: false,
        isDragging: false,
        edgePush: { top: false, bottom: false, left: false, right: false }
    },
    
    // New State Init
    boards: [DEFAULT_BOARD],
    currentBoardId: DEFAULT_BOARD.id,
    viewMode: 'BOARD',
    isDockVisible: false,
    isSpotlightOpen: false,

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
        
        // Restore viewport for the initial board
        const activeBoard = state.boards.find(b => b.id === state.currentBoardId);
        if (activeBoard && activeBoard.viewport) {
            state.viewport.x = activeBoard.viewport.x;
            state.viewport.y = activeBoard.viewport.y;
        }

        state.isLoaded = true;

        // Apply loaded theme
        const theme = finalData.config.themeMode || 'system';
        const isSystemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const shouldBeDark = theme === 'dark' || (theme === 'system' && isSystemDark);
        
        if (shouldBeDark) {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
        localStorage.setItem('theme', theme);
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
            // 1. Save current viewport to OLD board
            const oldBoard = state.boards.find(b => b.id === state.currentBoardId);
            if (oldBoard) {
                oldBoard.viewport = { x: state.viewport.x, y: state.viewport.y };
            }

            // 2. Switch
            if (state.boards.find(b => b.id === boardId)) {
                state.currentBoardId = boardId;
                state.viewMode = 'BOARD'; // Auto-switch to board view
                state.selectedIds = []; // Clear selection to prevent ghost edits
                state.stickyDrag = { id: null, offsetX: 0, offsetY: 0 }; // Reset drag
                
                // 3. Restore viewport from NEW board
                const newBoard = state.boards.find(b => b.id === boardId);
                if (newBoard && newBoard.viewport) {
                    state.viewport.x = newBoard.viewport.x;
                    state.viewport.y = newBoard.viewport.y;
                } else {
                    state.viewport.x = 0;
                    state.viewport.y = 0;
                }
            }
        });
    },

    setViewMode: (mode) => {
        set((state) => {
            state.viewMode = mode;
            state.selectedIds = []; // Clear selection on view switch
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

    // v1.1.5 Viewport Actions
    setViewportSize: (w, h) => {
        set((state) => {
            state.viewport.w = w;
            state.viewport.h = h;
            // Ensure canvas is at least viewport size
            state.canvas.w = Math.max(state.canvas.w, state.viewport.x + w);
            state.canvas.h = Math.max(state.canvas.h, state.viewport.y + h);
        });
    },

    setPanMode: (isPan) => {
        set((state) => {
            state.interaction.isPanMode = isPan;
        });
    },

    setIsDragging: (isDragging) => {
        // Direct DOM manipulation for performance (avoids React re-renders)
        if (isDragging) {
            document.body.classList.add('is-dragging');
        } else {
            document.body.classList.remove('is-dragging');
        }
        set((state) => {
            state.interaction.isDragging = isDragging;
        });
    },

    setEdgePush: (pushState) => {
        set((state) => {
            Object.assign(state.interaction.edgePush, pushState);
        });
    },

    panViewport: (dx, dy) => {
        set((state) => {
            // Apply delta
            let newX = state.viewport.x + dx;
            let newY = state.viewport.y + dy;

            // Enforce Top-Left Hard Wall (x >= 0, y >= 0)
            if (newX < 0) newX = 0;
            if (newY < 0) newY = 0;

            state.viewport.x = newX;
            state.viewport.y = newY;

            // Auto-expand canvas if viewport moves into new territory
            const neededW = newX + state.viewport.w;
            const neededH = newY + state.viewport.h;
            
            if (neededW > state.canvas.w) state.canvas.w = neededW;
            if (neededH > state.canvas.h) state.canvas.h = neededH;
        });
    },

    setViewportPosition: (x, y) => {
        set((state) => {
            // Enforce Top-Left Hard Wall
            const finalX = Math.max(0, x);
            const finalY = Math.max(0, y);

            state.viewport.x = finalX;
            state.viewport.y = finalY;

            // Expand canvas
            state.canvas.w = Math.max(state.canvas.w, finalX + state.viewport.w);
            state.canvas.h = Math.max(state.canvas.h, finalY + state.viewport.h);
        });
    },

    expandCanvas: (w, h) => {
        set((state) => {
            state.canvas.w = Math.max(state.canvas.w, w);
            state.canvas.h = Math.max(state.canvas.h, h);
        });
    },

    setDockVisible: (visible) => set({ isDockVisible: visible }),

    setSpotlightOpen: (isOpen) => set({ isSpotlightOpen: isOpen }),

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

    arrangeNotes: (startX?: number, startY?: number) => {
        set((state) => {
            const viewport = state.viewport;
            const worldRightEdge = viewport.x + viewport.w;
            const worldBottomEdge = viewport.y + viewport.h;

            // Default to current viewport + padding if not provided
            const effectiveStartX = startX ?? (viewport.x + 50);
            const effectiveStartY = startY ?? (viewport.y + 50);

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
            let currentX = effectiveStartX;
            let currentY = effectiveStartY;
            let maxRowH = 0;
            
            // Boundary Guard for Start Position
            // Ensure we don't start off the right edge of the world view
            if (currentX + COLUMN_WIDTH > worldRightEdge) {
                currentX = Math.max(viewport.x + 20, worldRightEdge - COLUMN_WIDTH * 2);
            }
            // Ensure we don't start off the bottom
            if (currentY > worldBottomEdge - 100) {
                currentY = viewport.y + 50; 
            }
            
            // Keep track of the "carriage return" X position
            const rowStartX = currentX;

            sortedNotes.forEach((note) => {
                // Check if we need to wrap to new row
                if (currentX + COLUMN_WIDTH > worldRightEdge - 20) {
                    currentX = rowStartX;
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
        const note = state.notes.find((n) => n.id === id);
        if (note) {
          note.deletedAt = Date.now(); // Soft delete
        }
        // Remove from selection if deleted
        state.selectedIds = state.selectedIds.filter(selId => selId !== id);
      });
      get().saveToDisk();
    },
    
    restoreNote: (id) => {
        set((state) => {
            const note = state.notes.find(n => n.id === id);
            if (note) {
                note.deletedAt = null; // Restore
                
                // Safety Check: Does the target board still exist?
                const boardExists = state.boards.some(b => b.id === note.boardId);
                if (!boardExists) {
                    note.boardId = state.currentBoardId; // Fallback to current
                }
                
                // Visual Feedback: Bring to top so user sees it
                state.config.maxZ += 1;
                note.z = state.config.maxZ;
            }
        });
        get().saveToDisk();
    },

    deleteNotePermanently: (id) => {
        set((state) => {
            state.notes = state.notes.filter(n => n.id !== id);
        });
        get().saveToDisk();
    },

    emptyTrash: () => {
        set((state) => {
            state.notes = state.notes.filter(n => !n.deletedAt);
        });
        get().saveToDisk();
    },

    restoreAllTrash: () => {
        set((state) => {
            state.notes.forEach(note => {
                if (note.deletedAt) {
                    note.deletedAt = null;
                    // Safety Check
                    if (!state.boards.some(b => b.id === note.boardId)) {
                        note.boardId = state.currentBoardId;
                    }
                    // Bring to front
                    state.config.maxZ += 1;
                    note.z = state.config.maxZ;
                }
            });
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

    selectAllNotes: () => {
        set((state) => {
            const currentBoardNotes = state.notes.filter(n => n.boardId === state.currentBoardId);
            state.selectedIds = currentBoardNotes.map(n => n.id);
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
            state.notes.forEach(note => {
                if (selectedIds.includes(note.id)) {
                    note.deletedAt = Date.now(); // Soft delete
                }
            });
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

    duplicateSelectedNotes: () => {
        set((state) => {
            const { selectedIds } = state;
            if (selectedIds.length === 0) return;
            
            const newSelectedIds: string[] = [];

            selectedIds.forEach(id => {
                const note = state.notes.find(n => n.id === id);
                if (note) {
                    const newNote: Note = {
                        ...note,
                        id: crypto.randomUUID(),
                        x: note.x + 20, // Offset slightly
                        y: note.y + 20,
                        z: state.config.maxZ + 1,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                    };
                    state.notes.push(newNote);
                    state.config.maxZ += 1;
                    newSelectedIds.push(newNote.id);
                }
            });

            // Auto-select the newly created duplicates for UX
            if (newSelectedIds.length > 0) {
                state.selectedIds = newSelectedIds;
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

    moveSelectedNotesToBoard: (targetBoardId) => {
        set((state) => {
            const { selectedIds } = state;
            if (selectedIds.length === 0) return;

            let movedCount = 0;
            state.notes.forEach(note => {
                if (selectedIds.includes(note.id)) {
                    note.boardId = targetBoardId;
                    // Jitter to prevent perfect stacking
                    note.x += Math.floor(Math.random() * 30); 
                    note.y += Math.floor(Math.random() * 30);
                    movedCount++;
                }
            });

            if (movedCount > 0) {
                state.selectedIds = []; // Clear selection after move
            }
        });
        get().saveToDisk();
    },

    copySelectedNotesToBoard: (targetBoardId) => {
        set((state) => {
            const { selectedIds } = state;
            if (selectedIds.length === 0) return;

            selectedIds.forEach(id => {
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
                    // Jitter
                    newNote.x += Math.floor(Math.random() * 30);
                    newNote.y += Math.floor(Math.random() * 30);
                    
                    state.notes.push(newNote);
                    state.config.maxZ += 1;
                }
            });
        });
        get().saveToDisk();
    },

    reorderBoard: (boardId, direction) => {
        set((state) => {
            const index = state.boards.findIndex(b => b.id === boardId);
            if (index === -1) return;

            const newIndex = direction === 'left' ? index - 1 : index + 1;
            
            // Boundary Check
            if (newIndex < 0 || newIndex >= state.boards.length) return;

            // Swap
            const temp = state.boards[index];
            state.boards[index] = state.boards[newIndex];
            state.boards[newIndex] = temp;
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

    exportBoard: async (boardId) => {
        const { boards, notes } = get();
        const board = boards.find(b => b.id === boardId);
        if (!board) return;

        const json = generateBoardExport(board, notes);
        const fileName = `Board_${board.name.replace(/[^a-z0-9]/gi, '_')}.json`;
        
        await saveFile(json, fileName);
    },

    exportCurrentBoard: async () => {
        const { currentBoardId } = get();
        await get().exportBoard(currentBoardId);
    },

    exportAll: async () => {
        const { boards, notes, config } = get();
        const json = generateFullBackup(boards, notes, config);
        const fileName = `SoNotes_Backup_${new Date().toISOString().split('T')[0]}.json`;
        
        await saveFile(json, fileName);
    },

    importFromFile: async () => {
        const jsonContent = await openFile();
        if (!jsonContent) return;

        const result = processImport(jsonContent);
        if (!result) {
            // TODO: Show error toast?
            console.error("Import failed: Invalid format");
            return;
        }

        const { boards: newBoards, notes: newNotes } = result;
        if (newBoards.length === 0) return;

        set((state) => {
            state.boards.push(...newBoards);
            state.notes.push(...newNotes);
            
            // Switch to the first imported board so user sees the result
            state.currentBoardId = newBoards[0].id;
            state.viewMode = 'BOARD';
            state.selectedIds = [];
        });
        
        get().saveToDisk();
    },

    setThemeMode: (mode) => {
        set((state) => {
            state.config.themeMode = mode;
        });

        // Apply theme immediately
        const isSystemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const shouldBeDark = mode === 'dark' || (mode === 'system' && isSystemDark);

        if (shouldBeDark) {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }

        // Persist to localStorage for index.html script
        localStorage.setItem('theme', mode);
        
        get().saveToDisk();
    },
  }))
);

