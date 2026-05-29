import type { Board, Note, AppConfig, ViewMode, StorageData, StorageDataInput } from '../../store/types';
import type { NormalizedNotesState } from '../../store/types';
import type { LayoutNote } from '../../store/types';
import { generateBoardExport, generateFullBackup, processImport, type ImportFailureCode, type ImportSummary } from '../../utils/dataTransfer';

export const DATA_TRANSFER_SERVICE_MODULE = 'DataTransferService';

export type DataTransferServiceModuleName = typeof DATA_TRANSFER_SERVICE_MODULE;

export interface ImportFromFileResult {
  status: 'cancelled' | 'success' | 'error';
  code?: ImportFailureCode | 'SAVE_FAILED';
  message?: string;
  summary?: ImportSummary;
  rolledBack?: boolean;
}

export interface DataTransferStateSlice {
  boards: Board[];
  notesById: Record<string, Note>;
  allNoteIds: string[];
  boardNoteIds: Record<string, string[]>;
  layoutNotesById: Record<string, LayoutNote>;
  currentBoardId: string;
  viewMode: ViewMode;
  selectedIds: string[];
  config: AppConfig;
}

export interface DataTransferServiceDeps {
  getState: () => DataTransferStateSlice;
  set: (fn: (state: DataTransferStateSlice) => void) => void;
  denormalizeNotes: (state: NormalizedNotesState) => Note[];
  normalizeNotes: (notes: Note[]) => NormalizedNotesState;
  createLayoutNotesById: (notesById: Record<string, Note>) => Record<string, LayoutNote>;
  appendNoteToNormalizedState: (
    state: Pick<DataTransferStateSlice, 'notesById' | 'allNoteIds' | 'boardNoteIds' | 'layoutNotesById'>,
    note: Note,
  ) => void;
  normalizeStorageDataMetadata: (data: StorageDataInput) => StorageData;
  saveToDisk: () => Promise<boolean>;
  saveWAL: (data: StorageData) => Promise<boolean>;
  openFile: () => Promise<string | null>;
  saveFile: (content: string, defaultName: string) => Promise<boolean>;
}

export interface DataTransferService {
  exportBoard: (boardId: string) => Promise<void>;
  exportCurrentBoard: () => Promise<void>;
  exportAll: () => Promise<void>;
  exportSelectedNotes: () => Promise<void>;
  importFromFile: () => Promise<ImportFromFileResult>;
}

export function createDataTransferService(deps: DataTransferServiceDeps): DataTransferService {
  const {
    getState,
    set,
    denormalizeNotes,
    normalizeNotes,
    createLayoutNotesById,
    appendNoteToNormalizedState,
    normalizeStorageDataMetadata,
    saveToDisk,
    saveWAL,
    openFile,
    saveFile,
  } = deps;

  const service: DataTransferService = {
    exportBoard: async (boardId) => {
      const state = getState();
      const board = state.boards.find((b) => b.id === boardId);
      if (!board) return;

      const json = generateBoardExport(board, denormalizeNotes(state));
      const fileName = `Board_${board.name.replace(/[^a-z0-9]/gi, '_')}.json`;

      await saveFile(json, fileName);
    },

    exportCurrentBoard: async () => {
      const { currentBoardId } = getState();
      await service.exportBoard(currentBoardId);
    },

    exportAll: async () => {
      const state = getState();
      const { boards, config, currentBoardId } = state;
      const notes = denormalizeNotes(state);
      const json = generateFullBackup(boards, notes, config, currentBoardId);
      const fileName = `SoNotes_Backup_${new Date().toISOString().split('T')[0]}.json`;

      await saveFile(json, fileName);
    },

    exportSelectedNotes: async () => {
      const state = getState();
      const { selectedIds, boards, currentBoardId } = state;
      if (selectedIds.length === 0) return;

      const selectedNotes = selectedIds
        .map((id) => state.notesById[id])
        .filter((n): n is Note => n !== undefined && !n.deletedAt);

      if (selectedNotes.length === 0) return;

      const currentBoard = boards.find((b) => b.id === currentBoardId);
      if (!currentBoard) return;

      const json = generateBoardExport(currentBoard, selectedNotes);
      const fileName = `Selected_${selectedNotes.length}_notes.json`;

      await saveFile(json, fileName);
    },

    importFromFile: async () => {
      const jsonContent = await openFile();
      if (!jsonContent) {
        return { status: 'cancelled' };
      }

      const existingBoardNames = getState().boards.map((board) => board.name);
      const result = processImport(jsonContent, existingBoardNames);
      if (result.status === 'error') {
        console.error(`Import failed: ${result.code} - ${result.message}`);
        return {
          status: 'error',
          code: result.code,
          message: result.message,
        };
      }

      const previousState = getState();
      const snapshot = {
        boards: previousState.boards,
        notes: denormalizeNotes(previousState),
        currentBoardId: previousState.currentBoardId,
        viewMode: previousState.viewMode,
        selectedIds: previousState.selectedIds,
      };

      const { boards: newBoards, notes: newNotes, suggestedCurrentBoardId, summary } = result.data;
      if (newBoards.length === 0) {
        return {
          status: 'error',
          code: 'INVALID_STRUCTURE',
          message: '导入失败：备份文件中没有可导入的看板。',
        };
      }

      set((state) => {
        // v1.2.7 约定：导入批次保留内部相对顺序，并整体追加到本地看板末尾。
        state.boards.push(...newBoards);
        newNotes.forEach((note) => appendNoteToNormalizedState(state, note));

        if (suggestedCurrentBoardId) {
          state.currentBoardId = suggestedCurrentBoardId;
          state.viewMode = 'BOARD';
        }
        state.selectedIds = [];
      });

      const saved = await saveToDisk();
      if (!saved) {
        set((state) => {
          const normalizedSnapshot = normalizeNotes(snapshot.notes);
          state.boards = snapshot.boards;
          state.notesById = normalizedSnapshot.notesById;
          state.allNoteIds = normalizedSnapshot.allNoteIds;
          state.boardNoteIds = normalizedSnapshot.boardNoteIds;
          state.layoutNotesById = createLayoutNotesById(normalizedSnapshot.notesById);
          state.currentBoardId = snapshot.currentBoardId;
          state.viewMode = snapshot.viewMode;
          state.selectedIds = snapshot.selectedIds;
        });
        await saveWAL(normalizeStorageDataMetadata({
          boards: snapshot.boards,
          notes: snapshot.notes,
          currentBoardId: snapshot.currentBoardId,
          config: getState().config,
        }));

        return {
          status: 'error',
          code: 'SAVE_FAILED',
          message: '导入失败：写入本地存储时出错，已回滚到导入前状态。',
          summary,
          rolledBack: true,
        };
      }

      const summaryMessage = summary.skippedNotesCount > 0
        ? `导入完成，已跳过 ${summary.skippedNotesCount} 条异常便签。`
        : result.compatibility === 'LEGACY'
          ? '已导入旧版备份，并按当前规则完成兼容处理。'
          : '导入成功。';

      return {
        status: 'success',
        message: summaryMessage,
        summary,
      };
    },
  };

  return service;
}
