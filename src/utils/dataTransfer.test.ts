import { describe, expect, it, vi, beforeEach } from 'vitest';

import { DEFAULT_BOARD, DEFAULT_CONFIG, type Board, type Note, type AttachmentRef } from '../store/types';
import { generateBoardExport, generateFullBackup, processImport } from './dataTransfer';

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

const makeAttachmentRef = (overrides: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: 'att-1',
  hash: 'abc123',
  filename: 'image.png',
  mimeType: 'image/png',
  size: 1024,
  relativePath: 'attachments/abc123.png',
  createdAt: 500,
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

describe('dataTransfer 附件引用导出', () => {
  it('全量备份导出包含附件引用但不含二进制/base64 字段', () => {
    const board = makeBoard();
    const noteWithClean = makeNote({
      id: 'note-clean',
      attachments: [makeAttachmentRef()],
    });
    const noteWithBinary = makeNote({ id: 'note-binary' });
    (noteWithBinary as unknown as Record<string, unknown>).attachments = [{
      ...makeAttachmentRef({ id: 'att-bin' }),
      data: 'base64-junk',
      base64: 'data:image/png;base64,iVBOR',
      content: new ArrayBuffer(10),
      blob: 'blob-ref',
    }];
    const noteWithout = makeNote({ id: 'note-none' });

    const json = generateFullBackup(
      [board],
      [noteWithClean, noteWithBinary, noteWithout],
      DEFAULT_CONFIG,
      board.id,
    );

    const parsed = JSON.parse(json);
    const notes = parsed.payload.notes as Record<string, unknown>[];

    expect(notes[0].attachments).toHaveLength(1);
    expect((notes[0].attachments as AttachmentRef[])[0].id).toBe('att-1');

    expect(notes[1].attachments).toHaveLength(1);
    const binAtt = (notes[1].attachments as Record<string, unknown>[])[0];
    expect(binAtt.id).toBe('att-bin');
    expect(binAtt).not.toHaveProperty('data');
    expect(binAtt).not.toHaveProperty('base64');
    expect(binAtt).not.toHaveProperty('content');
    expect(binAtt).not.toHaveProperty('blob');

    const allowedKeys = ['id', 'hash', 'filename', 'mimeType', 'size', 'relativePath', 'createdAt'];
    expect(Object.keys(binAtt).sort()).toEqual([...allowedKeys].sort());

    expect(notes[2].attachments).toBeUndefined();
  });

  it('单板导出保留附件引用', () => {
    const board = makeBoard();
    const note = makeNote({ attachments: [makeAttachmentRef()] });

    const json = generateBoardExport(board, [note]);
    const parsed = JSON.parse(json);

    expect(parsed.payload.notes).toHaveLength(1);
    expect(parsed.payload.notes[0].attachments).toHaveLength(1);
    expect(parsed.payload.notes[0].attachments[0].id).toBe('att-1');
  });

  it('选中便签导出保留附件引用', () => {
    const board = makeBoard();
    const note = makeNote({
      attachments: [makeAttachmentRef({ id: 'sel-att' })],
    });

    const json = generateBoardExport(board, [note]);
    const parsed = JSON.parse(json);

    expect(parsed.payload.notes[0].attachments[0].id).toBe('sel-att');
  });
});

describe('dataTransfer 附件引用导入', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('导入保留有效附件引用并丢弃无效条目', () => {
    vi.spyOn(Date, 'now').mockReturnValue(999999);
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('att-board-0000-4000-8000-0000000000')
      .mockReturnValueOnce('att-note-0000-4000-8000-000000000000');

    const board = makeBoard({ id: 'att-board', name: '附件板' });
    const noteData = {
      id: 'note-mixed',
      boardId: 'att-board',
      x: 10,
      y: 20,
      title: '混合附件',
      content: '内容',
      color: '#FFFFFF',
      z: 1,
      createdAt: 100,
      updatedAt: 100,
      attachments: [
        makeAttachmentRef({ id: 'valid-att' }),
        { id: '', hash: '', filename: '', mimeType: '', size: 0, relativePath: '', createdAt: 0 },
        null,
        { id: 'partial', hash: 'h' },
        makeAttachmentRef({ id: 'valid-att-2', hash: 'def456', filename: 'doc.pdf', mimeType: 'application/pdf', size: 2048 }),
      ],
    };

    const json = JSON.stringify({
      version: 1,
      source: 'so-notes',
      type: 'FULL_BACKUP',
      timestamp: 1,
      payload: { boards: [board], notes: [noteData], currentBoardId: 'att-board' },
    });

    const result = processImport(json);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.notes).toHaveLength(1);
      const imported = result.data.notes[0];
      expect(imported.attachments).toHaveLength(2);
      expect(imported.attachments?.[0]?.id).toBe('valid-att');
      expect(imported.attachments?.[1]?.id).toBe('valid-att-2');
    }
  });

  it('导入剥离附件中的二进制残留字段', () => {
    vi.spyOn(Date, 'now').mockReturnValue(888888);
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('bin-board-0000-4000-8000-0000000000')
      .mockReturnValueOnce('bin-note-0000-4000-8000-000000000000');

    const board = makeBoard({ id: 'bin-board', name: '二进制板' });
    const noteData = {
      id: 'note-bin',
      boardId: 'bin-board',
      x: 10, y: 20, title: 't', content: 'c', color: '#FFF', z: 1,
      createdAt: 100, updatedAt: 100,
      attachments: [{
        ...makeAttachmentRef({ id: 'att-with-binary' }),
        data: 'base64-data',
        base64: 'data:image/png;base64,xxx',
      }],
    };

    const json = JSON.stringify({
      version: 1, source: 'so-notes', type: 'FULL_BACKUP', timestamp: 1,
      payload: { boards: [board], notes: [noteData], currentBoardId: 'bin-board' },
    });

    const result = processImport(json);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      const att = result.data.notes[0].attachments;
      expect(att).toHaveLength(1);
      expect(att?.[0]?.id).toBe('att-with-binary');
      expect(att?.[0]).not.toHaveProperty('data');
      expect(att?.[0]).not.toHaveProperty('base64');
    }
  });

  it('旧版无附件备份仍可正常导入', () => {
    vi.spyOn(Date, 'now').mockReturnValue(777777);
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('old-board-0000-4000-8000-00000000000')
      .mockReturnValueOnce('old-note-0000-4000-8000-000000000000');

    const result = processImport(JSON.stringify({
      source: 'so-notes',
      type: 'FULL_BACKUP',
      payload: { notes: [{ content: '旧内容', createdAt: 50 }] },
    }));

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.notes).toHaveLength(1);
      expect(result.data.notes[0].attachments).toBeUndefined();
    }
  });

  it('畸形附件数组不破坏导入', () => {
    vi.spyOn(Date, 'now').mockReturnValue(666666);
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('mal-board-0000-4000-8000-0000000000')
      .mockReturnValueOnce('mal-note-0000-4000-8000-000000000000');

    const board = makeBoard({ id: 'mal-board', name: '畸形板' });
    const noteData = {
      id: 'note-mal',
      boardId: 'mal-board',
      x: 10, y: 20, title: 't', content: 'c', color: '#FFF', z: 1,
      createdAt: 100, updatedAt: 100,
      attachments: 'not-an-array',
    };

    const json = JSON.stringify({
      version: 1, source: 'so-notes', type: 'FULL_BACKUP', timestamp: 1,
      payload: { boards: [board], notes: [noteData], currentBoardId: 'mal-board' },
    });

    const result = processImport(json);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.notes).toHaveLength(1);
      expect(result.data.notes[0].attachments).toBeUndefined();
    }
  });

  it('附件为数字/null/布尔等非对象值时安全忽略', () => {
    vi.spyOn(Date, 'now').mockReturnValue(555555);
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('weird-board-0000-4000-8000-000000000')
      .mockReturnValueOnce('weird-note-0000-4000-8000-00000000000');

    const board = makeBoard({ id: 'weird-board', name: '怪异板' });
    const noteData = {
      id: 'note-weird',
      boardId: 'weird-board',
      x: 10, y: 20, title: 't', content: 'c', color: '#FFF', z: 1,
      createdAt: 100, updatedAt: 100,
      attachments: [42, null, true, undefined, 'string', makeAttachmentRef({ id: 'only-valid' })],
    };

    const json = JSON.stringify({
      version: 1, source: 'so-notes', type: 'FULL_BACKUP', timestamp: 1,
      payload: { boards: [board], notes: [noteData], currentBoardId: 'weird-board' },
    });

    const result = processImport(json);

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.notes[0].attachments).toHaveLength(1);
      expect(result.data.notes[0].attachments?.[0]?.id).toBe('only-valid');
    }
  });
});
