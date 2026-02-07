import { Note, Board, AppConfig } from '../store/types';

export interface ExportData {
  version: number;
  type: 'FULL_BACKUP' | 'SINGLE_BOARD';
  source: 'so-notes';
  timestamp: number;
  payload: {
    boards: Board[];
    notes: Note[];
    config?: AppConfig;
  };
}

/**
 * Export a single board and its notes
 */
export const generateBoardExport = (board: Board, allNotes: Note[]): string => {
  const boardNotes = allNotes.filter(n => n.boardId === board.id && !n.deletedAt);
  
  const data: ExportData = {
    version: 1,
    type: 'SINGLE_BOARD',
    source: 'so-notes',
    timestamp: Date.now(),
    payload: {
      boards: [board],
      notes: boardNotes
    }
  };
  
  return JSON.stringify(data, null, 2);
};

/**
 * Export all data (Full Backup)
 */
export const generateFullBackup = (boards: Board[], notes: Note[], config: AppConfig): string => {
  const data: ExportData = {
    version: 1,
    type: 'FULL_BACKUP',
    source: 'so-notes',
    timestamp: Date.now(),
    payload: {
      boards,
      notes,
      config
    }
  };
  
  return JSON.stringify(data, null, 2);
};

/**
 * Process import data
 * Strategy: Always "Deep Clone" & "Merge". 
 * IDs are regenerated to prevent conflicts with existing data.
 */
export const processImport = (jsonContent: string): { boards: Board[], notes: Note[] } | null => {
  try {
    const data = JSON.parse(jsonContent) as ExportData;
    
    // Basic Validation
    if (data.source !== 'so-notes' || !data.payload || !Array.isArray(data.payload.boards)) {
      console.error('Invalid So-Notes data format');
      return null;
    }

    const newBoards: Board[] = [];
    const newNotes: Note[] = [];
    const boardIdMap = new Map<string, string>();

    // 1. Process Boards (Regenerate IDs)
    data.payload.boards.forEach(oldBoard => {
      const newId = crypto.randomUUID();
      boardIdMap.set(oldBoard.id, newId);
      
      newBoards.push({
        ...oldBoard,
        id: newId,
        name: data.type === 'FULL_BACKUP' ? oldBoard.name : `${oldBoard.name} (Imported)`, // Add suffix for single import
        createdAt: Date.now() // Reset creation time to now
      });
    });

    // 2. Process Notes (Regenerate IDs and link to new Board IDs)
    data.payload.notes.forEach(oldNote => {
      // If note belongs to a board we just imported, map it.
      // If note is orphan (shouldn't happen in valid export) or belongs to excluded board, skip or map to first imported board?
      // Logic: Only import notes that belong to the imported boards.
      
      const newBoardId = boardIdMap.get(oldNote.boardId);
      
      if (newBoardId) {
        newNotes.push({
          ...oldNote,
          id: crypto.randomUUID(),
          boardId: newBoardId,
          updatedAt: Date.now(),
          createdAt: Date.now()
        });
      }
    });

    return { boards: newBoards, notes: newNotes };

  } catch (e) {
    console.error('Import failed:', e);
    return null;
  }
};
