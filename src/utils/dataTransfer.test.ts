import { describe, expect, it, vi, beforeEach } from 'vitest';

import { DEFAULT_BOARD, DEFAULT_CONFIG, type Board, type Note } from '../store/types';
import { generateFullBackup, processImport } from './dataTransfer';

const makeBoard = (overrides: Partial<Board> = {}): Board => ({
  ...DEFAULT_BOARD,
  id: 'board-1',
  name: '主板',
  icon: '📌',
  createdAt: 1,
  ...overrides,
});

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
  updatedAt: 100,
  ...overrides,
});

describe('dataTransfer 导入契约', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('拒绝非法 JSON', () => {
    const result = processImport('{not-json');

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe('INVALID_JSON');
    }
  });

  it('拒绝不支持的备份版本', () => {
    const result = processImport(JSON.stringify({
      version: 999,
      source: 'so-notes',
      type: 'FULL_BACKUP',
      payload: { boards: [], notes: [] },
      timestamp: 1,
    }));

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe('UNSUPPORTED_VERSION');
    }
  });

  it('全量导入时为冲突看板重命名，并保留导入包主板映射', () => {
    vi.spyOn(Date, 'now').mockReturnValue(123456);
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('55555555-5555-4555-8555-555555555555')
      .mockReturnValueOnce('66666666-6666-4666-8666-666666666666');

    const board = makeBoard();
    const note = makeNote();
    const json = generateFullBackup([board], [note], DEFAULT_CONFIG, board.id);

    const result = processImport(json, ['主板']);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.compatibility).toBe('COMPATIBLE');
      expect(result.data.boards).toHaveLength(1);
      expect(result.data.boards[0].id).toBe('55555555-5555-4555-8555-555555555555');
      expect(result.data.boards[0].name).toBe('主板（导入）');
      expect(result.data.notes[0].id).toBe('66666666-6666-4666-8666-666666666666');
      expect(result.data.notes[0].boardId).toBe('55555555-5555-4555-8555-555555555555');
      expect(result.data.suggestedCurrentBoardId).toBe('55555555-5555-4555-8555-555555555555');
      expect(result.data.type).toBe('FULL_BACKUP');
      expect(result.data.summary.importedBoardsCount).toBe(1);
      expect(result.data.summary.importedNotesCount).toBe(1);
      expect(result.data.summary.skippedNotesCount).toBe(0);
      expect(result.data.summary.renamedBoardsCount).toBe(1);
      expect(result.data.summary.issues[0].code).toBe('RENAMED_BOARD');
    }
  });

  it('单板导入不建议切换当前看板，并为重复导入名称递增后缀', () => {
    vi.spyOn(Date, 'now').mockReturnValue(223344);
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('77777777-7777-4777-8777-777777777777')
      .mockReturnValueOnce('88888888-8888-4888-8888-888888888888');

    const board = makeBoard({ name: '灵感板' });
    const note = makeNote();
    const json = JSON.stringify({
      version: 1,
      source: 'so-notes',
      type: 'SINGLE_BOARD',
      timestamp: 1,
      payload: {
        boards: [board],
        notes: [note],
        currentBoardId: board.id,
      },
    });

    const result = processImport(json, ['灵感板', '灵感板（导入）']);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.boards[0].name).toBe('灵感板（导入 2）');
      expect(result.data.suggestedCurrentBoardId).toBeNull();
    }
  });

  it('多看板导入时保留导入批次相对顺序', () => {
    vi.spyOn(Date, 'now').mockReturnValue(334455);
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('10101010-1010-4010-8010-101010101010')
      .mockReturnValueOnce('20202020-2020-4020-8020-202020202020')
      .mockReturnValueOnce('30303030-3030-4030-8030-303030303030');

    const json = JSON.stringify({
      version: 1,
      source: 'so-notes',
      type: 'FULL_BACKUP',
      timestamp: 1,
      payload: {
        boards: [
          makeBoard({ id: 'board-a', name: '工作台', icon: '💼' }),
          makeBoard({ id: 'board-b', name: '灵感板', icon: '💡', createdAt: 2 }),
          makeBoard({ id: 'board-c', name: '归档区', icon: '🗂️', createdAt: 3 }),
        ],
        notes: [],
        currentBoardId: 'board-b',
      },
    });

    const result = processImport(json, ['灵感板']);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.boards.map(board => board.id)).toEqual([
        '10101010-1010-4010-8010-101010101010',
        '20202020-2020-4020-8020-202020202020',
        '30303030-3030-4030-8030-303030303030',
      ]);
      expect(result.data.boards.map(board => board.name)).toEqual([
        '工作台',
        '灵感板（导入）',
        '归档区',
      ]);
      expect(result.data.suggestedCurrentBoardId).toBe('20202020-2020-4020-8020-202020202020');
      expect(result.data.summary.renamedBoardsCount).toBe(1);
    }
  });

  it('结构有效时允许跳过异常便签，并输出部分成功摘要', () => {
    vi.spyOn(Date, 'now').mockReturnValue(556677);
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('99999999-9999-4999-8999-999999999999')
      .mockReturnValueOnce('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    const board = makeBoard({ id: 'board-a', name: '导入板' });
    const json = JSON.stringify({
      version: 1,
      source: 'so-notes',
      type: 'FULL_BACKUP',
      timestamp: 1,
      payload: {
        boards: [board],
        notes: [
          makeNote({ id: 'valid-note', boardId: 'board-a' }),
          { id: 'broken-note', boardId: 'board-a', title: '坏数据' },
          makeNote({ id: 'orphan-note', boardId: 'missing-board' }),
        ],
        currentBoardId: 'board-a',
      },
    });

    const result = processImport(json);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.notes).toHaveLength(1);
      expect(result.data.notes[0].id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      expect(result.data.summary.importedBoardsCount).toBe(1);
      expect(result.data.summary.importedNotesCount).toBe(1);
      expect(result.data.summary.skippedNotesCount).toBe(2);
      expect(result.data.summary.migratedNotesCount).toBe(0);
      expect(result.data.summary.issues).toEqual([
        {
          code: 'INVALID_NOTE',
          severity: 'error',
          noteIndex: 1,
          message: '第 2 条便签结构无效，已跳过。',
        },
        {
          code: 'ORPHAN_NOTE',
          severity: 'error',
          noteIndex: 2,
          noteId: 'orphan-note',
          message: '第 3 条便签所属看板不存在，已跳过。',
        },
      ]);
    }
  });

  it('旧版备份可迁移兼容，并补全缺失字段与默认看板', () => {
    vi.spyOn(Date, 'now').mockReturnValue(667788);
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
      .mockReturnValueOnce('cccccccc-cccc-4ccc-8ccc-cccccccccccc');

    const result = processImport(JSON.stringify({
      source: 'so-notes',
      type: 'FULL_BACKUP',
      payload: {
        notes: [
          {
            content: '旧版内容',
            createdAt: 500,
          },
        ],
      },
    }));

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.compatibility).toBe('LEGACY');
      expect(result.data.boards).toHaveLength(1);
      expect(result.data.boards[0].id).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
      expect(result.data.notes).toHaveLength(1);
      expect(result.data.notes[0]).toMatchObject({
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        title: '',
        content: '旧版内容',
        boardId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        collapsed: false,
        updatedAt: 667788,
      });
      expect(result.data.summary.createdDefaultBoard).toBe(true);
      expect(result.data.summary.migratedNotesCount).toBe(1);
      expect(result.data.summary.skippedNotesCount).toBe(0);
      expect(result.data.summary.issues.map(issue => issue.code)).toEqual([
        'CREATED_DEFAULT_BOARD',
        'MIGRATED_NOTE',
        'FALLBACK_CURRENT_BOARD',
      ]);
    }
  });

  it('旧版迁移自动补建默认看板时，该看板保持在导入批次首位', () => {
    vi.spyOn(Date, 'now').mockReturnValue(778899);
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('dddddddd-dddd-4ddd-8ddd-dddddddddddd')
      .mockReturnValueOnce('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');

    const result = processImport(JSON.stringify({
      source: 'so-notes',
      type: 'FULL_BACKUP',
      payload: {
        notes: [{ content: '旧版内容', createdAt: 12 }],
      },
    }));

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.boards).toHaveLength(1);
      expect(result.data.boards[0].id).toBe('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
      expect(result.data.summary.createdDefaultBoard).toBe(true);
    }
  });
});
