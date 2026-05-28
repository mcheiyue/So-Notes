import { describe, it, expect, vi } from 'vitest';
import { createDataTransferService, type DataTransferServiceDeps, type DataTransferStateSlice } from './DataTransferService';
import type { Note, Board } from '../../store/types';

const makeNote = (overrides: Partial<Note> = {}): Note => ({
  id: 'note-1',
  boardId: 'board-1',
  x: 10,
  y: 20,
  title: '标题',
  content: '内容',
  color: '#FFFFFF',
  z: 1,
  createdAt: 100,
  updatedAt: 200,
  ...overrides,
});

const makeBoard = (overrides: Partial<Board> = {}): Board => ({
  id: 'board-1',
  name: '主板',
  icon: '📌',
  createdAt: 0,
  ...overrides,
});

const makeStateSlice = (overrides: Partial<DataTransferStateSlice> = {}): DataTransferStateSlice => ({
  boards: [makeBoard()],
  notesById: { 'note-1': makeNote() },
  allNoteIds: ['note-1'],
  boardNoteIds: { 'board-1': ['note-1'] },
  layoutNotesById: {
    'note-1': { id: 'note-1', x: 10, y: 20, boardId: 'board-1', deletedAt: null, color: '#FFFFFF' },
  },
  currentBoardId: 'board-1',
  viewMode: 'BOARD',
  selectedIds: [],
  config: { version: 2, maxZ: 1, themeMode: 'system' },
  ...overrides,
});

const makeDeps = (overrides: Partial<DataTransferServiceDeps> = {}): DataTransferServiceDeps => {
  const state = overrides.getState?.() ?? makeStateSlice();
  return {
    getState: () => state,
    set: vi.fn((fn: (s: DataTransferStateSlice) => void) => {
      const draft = JSON.parse(JSON.stringify(state)) as DataTransferStateSlice;
      fn(draft);
      Object.assign(state, draft);
    }),
    denormalizeNotes: (s) => s.allNoteIds.map((id) => s.notesById[id]).filter(Boolean),
    normalizeNotes: (notes) => {
      const notesById: Record<string, Note> = {};
      const allNoteIds: string[] = [];
      const boardNoteIds: Record<string, string[]> = {};
      for (const note of notes) {
        notesById[note.id] = note;
        allNoteIds.push(note.id);
        if (!boardNoteIds[note.boardId]) boardNoteIds[note.boardId] = [];
        boardNoteIds[note.boardId].push(note.id);
      }
      return { notesById, allNoteIds, boardNoteIds };
    },
    createLayoutNotesById: (notesById) => {
      const result: Record<string, { id: string; x: number; y: number; boardId: string; deletedAt: number | null; color: string }> = {};
      for (const note of Object.values(notesById)) {
        result[note.id] = { id: note.id, x: note.x, y: note.y, boardId: note.boardId, deletedAt: note.deletedAt ?? null, color: note.color };
      }
      return result;
    },
    appendNoteToNormalizedState: (state, note) => {
      state.notesById[note.id] = note;
      state.allNoteIds.push(note.id);
      if (!state.boardNoteIds[note.boardId]) state.boardNoteIds[note.boardId] = [];
      state.boardNoteIds[note.boardId].push(note.id);
      state.layoutNotesById[note.id] = { id: note.id, x: note.x, y: note.y, boardId: note.boardId, deletedAt: note.deletedAt ?? null, color: note.color };
    },
    normalizeStorageDataMetadata: (data) => ({
      ...data,
      schemaVersion: data.schemaVersion ?? 1,
      storageUpdatedAt: data.storageUpdatedAt ?? 0,
    }),
    saveToDisk: vi.fn(async () => true),
    saveWAL: vi.fn(async () => true),
    openFile: vi.fn(async () => null),
    saveFile: vi.fn(async () => true),
    ...overrides,
  };
};

describe('DataTransferService', () => {
  describe('exportBoard', () => {
    it('看板不存在时不执行任何操作', async () => {
      const deps = makeDeps();
      const service = createDataTransferService(deps);

      await service.exportBoard('non-existent');

      expect(deps.saveFile).not.toHaveBeenCalled();
    });

    it('看板存在时调用 saveFile 并传入正确文件名', async () => {
      const deps = makeDeps({
        getState: () => makeStateSlice({
          boards: [makeBoard({ id: 'board-1', name: 'My Board' })],
        }),
      });
      const service = createDataTransferService(deps);

      await service.exportBoard('board-1');

      expect(deps.saveFile).toHaveBeenCalledTimes(1);
      const [json, fileName] = vi.mocked(deps.saveFile).mock.calls[0];
      expect(fileName).toBe('Board_My_Board.json');
      const parsed = JSON.parse(json);
      expect(parsed.type).toBe('SINGLE_BOARD');
      expect(parsed.payload.boards).toHaveLength(1);
      expect(parsed.payload.notes).toHaveLength(1);
    });
  });

  describe('exportCurrentBoard', () => {
    it('导出当前看板', async () => {
      const deps = makeDeps();
      const service = createDataTransferService(deps);

      await service.exportCurrentBoard();

      expect(deps.saveFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('exportAll', () => {
    it('生成全量备份并使用日期文件名', async () => {
      const deps = makeDeps();
      const service = createDataTransferService(deps);

      await service.exportAll();

      expect(deps.saveFile).toHaveBeenCalledTimes(1);
      const [json, fileName] = vi.mocked(deps.saveFile).mock.calls[0];
      expect(fileName).toMatch(/^SoNotes_Backup_\d{4}-\d{2}-\d{2}\.json$/);
      const parsed = JSON.parse(json);
      expect(parsed.type).toBe('FULL_BACKUP');
      expect(parsed.payload.boards).toHaveLength(1);
      expect(parsed.payload.notes).toHaveLength(1);
      expect(parsed.payload.currentBoardId).toBe('board-1');
    });
  });

  describe('exportSelectedNotes', () => {
    it('无选中项时不执行任何操作', async () => {
      const deps = makeDeps({ getState: () => makeStateSlice({ selectedIds: [] }) });
      const service = createDataTransferService(deps);

      await service.exportSelectedNotes();

      expect(deps.saveFile).not.toHaveBeenCalled();
    });

    it('选中项全部被删除或不存在时不执行任何操作', async () => {
      const deps = makeDeps({
        getState: () => makeStateSlice({
          selectedIds: ['deleted-note'],
          notesById: {
            'deleted-note': makeNote({ id: 'deleted-note', deletedAt: 999 }),
          },
        }),
      });
      const service = createDataTransferService(deps);

      await service.exportSelectedNotes();

      expect(deps.saveFile).not.toHaveBeenCalled();
    });

    it('过滤掉已删除和不存在的便签后导出有效选中项', async () => {
      const deps = makeDeps({
        getState: () => makeStateSlice({
          selectedIds: ['note-1', 'deleted-note', 'missing-note'],
          notesById: {
            'note-1': makeNote({ id: 'note-1' }),
            'deleted-note': makeNote({ id: 'deleted-note', deletedAt: 999 }),
          },
        }),
      });
      const service = createDataTransferService(deps);

      await service.exportSelectedNotes();

      expect(deps.saveFile).toHaveBeenCalledTimes(1);
      const [json, fileName] = vi.mocked(deps.saveFile).mock.calls[0];
      expect(fileName).toBe('Selected_1_notes.json');
      const parsed = JSON.parse(json);
      expect(parsed.payload.notes).toHaveLength(1);
      expect(parsed.payload.notes[0].id).toBe('note-1');
    });
  });

  describe('importFromFile', () => {
    it('用户取消文件选择时返回 cancelled', async () => {
      const deps = makeDeps({ openFile: vi.fn(async () => null) });
      const service = createDataTransferService(deps);

      const result = await service.importFromFile();

      expect(result.status).toBe('cancelled');
    });

    it('不支持的版本短路返回错误，不修改状态', async () => {
      const state = makeStateSlice();
      const originalBoards = [...state.boards];
      const deps = makeDeps({
        getState: () => state,
        openFile: vi.fn(async () => JSON.stringify({
          version: 999,
          source: 'so-notes',
          type: 'FULL_BACKUP',
          timestamp: 1,
          payload: { boards: [], notes: [] },
        })),
      });
      const service = createDataTransferService(deps);

      const result = await service.importFromFile();

      expect(result.status).toBe('error');
      expect(result.code).toBe('UNSUPPORTED_VERSION');
      expect(state.boards).toEqual(originalBoards);
      expect(deps.saveToDisk).not.toHaveBeenCalled();
    });

    it('空看板列表返回 INVALID_STRUCTURE', async () => {
      const deps = makeDeps({
        openFile: vi.fn(async () => JSON.stringify({
          version: 1,
          source: 'so-notes',
          type: 'FULL_BACKUP',
          timestamp: 1,
          payload: { boards: [], notes: [] },
        })),
      });
      const service = createDataTransferService(deps);

      const result = await service.importFromFile();

      expect(result.status).toBe('error');
      expect(result.code).toBe('INVALID_STRUCTURE');
      expect(deps.saveToDisk).not.toHaveBeenCalled();
    });

    it('成功导入调用 apply 和 save', async () => {
      vi.spyOn(globalThis.crypto, 'randomUUID')
        .mockReturnValueOnce('new-board-id-0000-4000-8000-000000000000')
        .mockReturnValueOnce('new-note-id-0000-4000-8000-000000000000');

      const state = makeStateSlice();
      const deps = makeDeps({
        getState: () => state,
        openFile: vi.fn(async () => JSON.stringify({
          version: 1,
          source: 'so-notes',
          type: 'FULL_BACKUP',
          timestamp: 1,
          payload: {
            boards: [{ id: 'import-board', name: '主板', icon: '📥', createdAt: 10 }],
            notes: [{
              id: 'import-note',
              boardId: 'import-board',
              x: 10,
              y: 20,
              title: '导入便签',
              content: '导入内容',
              color: '#FFFFFF',
              z: 2,
              createdAt: 11,
              updatedAt: 12,
            }],
            currentBoardId: 'import-board',
          },
        })),
      });
      const service = createDataTransferService(deps);

      const result = await service.importFromFile();

      expect(result.status).toBe('success');
      expect(deps.saveToDisk).toHaveBeenCalledTimes(1);
      expect(state.boards).toHaveLength(2);
      expect(state.boards[1].name).toBe('主板（导入）');
    });

    it('保存失败触发回滚并写入 WAL', async () => {
      vi.spyOn(globalThis.crypto, 'randomUUID')
        .mockReturnValueOnce('rb-board-0000-4000-8000-000000000000')
        .mockReturnValueOnce('rb-note-0000-4000-8000-000000000000');

      const state = makeStateSlice({ selectedIds: ['keep-me'] });
      const deps = makeDeps({
        getState: () => state,
        saveToDisk: vi.fn(async () => false),
        openFile: vi.fn(async () => JSON.stringify({
          version: 1,
          source: 'so-notes',
          type: 'FULL_BACKUP',
          timestamp: 1,
          payload: {
            boards: [{ id: 'rb-board', name: '回滚板', icon: '↩️', createdAt: 10 }],
            notes: [{
              id: 'rb-note',
              boardId: 'rb-board',
              x: 10,
              y: 20,
              title: '回滚',
              content: '需要回滚',
              color: '#FFFFFF',
              z: 2,
              createdAt: 11,
              updatedAt: 12,
            }],
            currentBoardId: 'rb-board',
          },
        })),
      });
      const service = createDataTransferService(deps);

      const result = await service.importFromFile();

      expect(result.status).toBe('error');
      expect(result.code).toBe('SAVE_FAILED');
      expect(result.rolledBack).toBe(true);
      expect(state.boards).toHaveLength(1);
      expect(state.boards[0].id).toBe('board-1');
      expect(state.selectedIds).toEqual(['keep-me']);
      expect(deps.saveWAL).toHaveBeenCalledTimes(1);
    });

    it('WAL 写入失败仍报告 rolledBack', async () => {
      vi.spyOn(globalThis.crypto, 'randomUUID')
        .mockReturnValueOnce('wal-board-0000-4000-8000-000000000000')
        .mockReturnValueOnce('wal-note-0000-4000-8000-000000000000');

      const state = makeStateSlice({ selectedIds: ['keep-me'] });
      const deps = makeDeps({
        getState: () => state,
        saveToDisk: vi.fn(async () => false),
        saveWAL: vi.fn(async () => false),
        openFile: vi.fn(async () => JSON.stringify({
          version: 1,
          source: 'so-notes',
          type: 'FULL_BACKUP',
          timestamp: 1,
          payload: {
            boards: [{ id: 'wal-board', name: 'WAL板', icon: '💾', createdAt: 10 }],
            notes: [{
              id: 'wal-note',
              boardId: 'wal-board',
              x: 10,
              y: 20,
              title: 'WAL失败',
              content: '需要回滚',
              color: '#FFFFFF',
              z: 2,
              createdAt: 11,
              updatedAt: 12,
            }],
            currentBoardId: 'wal-board',
          },
        })),
      });
      const service = createDataTransferService(deps);

      const result = await service.importFromFile();

      expect(result.status).toBe('error');
      expect(result.code).toBe('SAVE_FAILED');
      expect(result.rolledBack).toBe(true);
      expect(state.boards).toHaveLength(1);
      expect(deps.saveWAL).toHaveBeenCalledTimes(1);
    });
  });
});
