import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
}));

vi.mock('../../store/db', () => ({
  db: {
    loadWAL: vi.fn(async () => undefined),
    saveWAL: vi.fn(async () => true),
    clearWAL: vi.fn(async () => undefined),
  },
}));

import { invoke } from '@tauri-apps/api/core';
import { db } from '../../store/db';
import { bootstrap } from './StorageService';
import { STORAGE_SCHEMA_VERSION, DEFAULT_BOARD, DEFAULT_CONFIG } from '../../store/types';
import type { StorageData } from '../../store/types';

type DiskJsonFixture = Partial<Omit<StorageData, 'notes'>> & {
  notes: Array<Record<string, unknown>>;
};

const makeDiskJson = (data: DiskJsonFixture): string =>
  JSON.stringify({
    schemaVersion: STORAGE_SCHEMA_VERSION,
    storageUpdatedAt: Date.now(),
    boards: [DEFAULT_BOARD],
    currentBoardId: DEFAULT_BOARD.id,
    config: DEFAULT_CONFIG,
    ...data,
  });

describe('StorageService.bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disk 更新时选择 DISK 来源', async () => {
    const diskTime = 9000;
    const walTime = 1000;

    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [{ id: 'd1', boardId: 'default', x: 10, y: 20, title: 'Disk', content: '', color: '#FFFFFF', z: 1, createdAt: 100, updatedAt: diskTime }],
      storageUpdatedAt: diskTime,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce({
      schemaVersion: STORAGE_SCHEMA_VERSION,
      storageUpdatedAt: walTime,
      notes: [{ id: 'w1', boardId: 'default', x: 5, y: 5, title: 'WAL', content: '', color: '#FFFFFF', z: 1, createdAt: 50, updatedAt: walTime }],
      boards: [DEFAULT_BOARD],
      currentBoardId: DEFAULT_BOARD.id,
      config: DEFAULT_CONFIG,
    });

    const result = await bootstrap();

    expect(result.source).toBe('DISK');
    expect(result.data.notes[0].id).toBe('d1');
    expect(result.syncAction.type).toBe('SYNC_DISK_TO_WAL');
    expect(result.diskTime).toBe(diskTime);
    expect(result.walTime).toBe(walTime);
    expect(result.recovered).toBe(false);
  });

  it('WAL 非空且时间戳 >= disk 时选择 WAL 来源', async () => {
    const time = 5000;

    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [{ id: 'd1', boardId: 'default', x: 0, y: 0, title: '', content: '', color: '#FFFFFF', z: 1, createdAt: 100, updatedAt: time }],
      storageUpdatedAt: time,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce({
      schemaVersion: STORAGE_SCHEMA_VERSION,
      storageUpdatedAt: time + 1,
      notes: [{ id: 'w1', boardId: 'default', x: 0, y: 0, title: '', content: '', color: '#FFFFFF', z: 1, createdAt: 100, updatedAt: time + 1 }],
      boards: [DEFAULT_BOARD],
      currentBoardId: DEFAULT_BOARD.id,
      config: DEFAULT_CONFIG,
    });

    const result = await bootstrap();

    expect(result.source).toBe('WAL');
    expect(result.data.notes[0].id).toBe('w1');
    expect(result.syncAction.type).toBe('SYNC_WAL_TO_DISK');
    expect(result.walTime).toBe(time + 1);
    expect(result.diskTime).toBe(time);
    expect(result.recovered).toBe(false);
  });

  it('WAL 为空时回退到 disk', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [{ id: 'd1', boardId: 'default', x: 0, y: 0, title: '', content: '', color: '#FFFFFF', z: 1, createdAt: 100, updatedAt: 200 }],
      storageUpdatedAt: 200,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce({
      schemaVersion: STORAGE_SCHEMA_VERSION,
      storageUpdatedAt: 500,
      notes: [],
      boards: [DEFAULT_BOARD],
      currentBoardId: DEFAULT_BOARD.id,
      config: DEFAULT_CONFIG,
    });

    const result = await bootstrap();

    expect(result.source).toBe('DISK');
    expect(result.data.notes[0].id).toBe('d1');
    expect(result.diskTime).toBe(200);
    expect(result.walTime).toBe(500);
    expect(result.recovered).toBe(false);
  });

  it('双源均无数据时返回 NEW 默认领域', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    vi.mocked(db.loadWAL).mockResolvedValueOnce(undefined);

    const result = await bootstrap();

    expect(result.source).toBe('NEW');
    expect(result.data.notes).toEqual([]);
    expect(result.data.boards).toEqual([DEFAULT_BOARD]);
    expect(result.data.currentBoardId).toBe(DEFAULT_BOARD.id);
    expect(result.data.schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
    expect(result.syncAction.type).toBe('NONE');
    expect(result.walTime).toBe(0);
    expect(result.diskTime).toBe(0);
    expect(result.recovered).toBe(true);
  });

  it('旧版缺少 schemaVersion 和 storageUpdatedAt 的数据被正确规范化', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify({
      notes: [{ id: 'old', boardId: 'default', x: 0, y: 0, title: 'Old', content: '', color: '#FFFFFF', z: 1, createdAt: 100, updatedAt: 888 }],
      boards: [DEFAULT_BOARD],
      currentBoardId: DEFAULT_BOARD.id,
      config: DEFAULT_CONFIG,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce(undefined);

    const result = await bootstrap();

    expect(result.data.schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
    expect(result.data.storageUpdatedAt).toBe(888);
  });

  it('迁移：修复负坐标、补齐默认字段、确保 boards 与 currentBoardId 有效', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [
        { id: 'neg', boardId: '', x: -5, y: -10, content: '', color: '#FFFFFF', z: 1, createdAt: 100, updatedAt: 0 },
        { id: 'ok', boardId: 'b1', x: 100, y: 200, title: 'Good', content: '', color: '#FFFFFF', z: 2, createdAt: 200, updatedAt: 200 },
      ],
      boards: [{ id: 'b1', name: 'Board 1', icon: '💡', createdAt: 100 }],
      currentBoardId: 'b1',
      storageUpdatedAt: 200,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce(undefined);

    const result = await bootstrap();
    const notes = result.data.notes;

    expect(notes[0].x).toBe(20);
    expect(notes[0].y).toBe(20);
    expect(notes[0].collapsed).toBe(false);
    expect(notes[0].title).toBe('');
    expect(notes[0].boardId).toBe('default');
    expect(notes[0].updatedAt).toBe(100);

    expect(notes[1].boardId).toBe('b1');
    expect(result.data.boards.length).toBeGreaterThanOrEqual(1);
    expect(result.data.currentBoardId).toBe('b1');
  });

  it('boards 为空时回退为默认看板，currentBoardId 被修正', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [{ id: 'n1', boardId: 'ghost', x: 0, y: 0, title: '', content: '', color: '#FFFFFF', z: 1, createdAt: 100, updatedAt: 100 }],
      boards: [],
      currentBoardId: 'nonexistent',
      storageUpdatedAt: 100,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce(undefined);

    const result = await bootstrap();

    expect(result.data.boards).toEqual([DEFAULT_BOARD]);
    expect(result.data.currentBoardId).toBe(DEFAULT_BOARD.id);
  });

  it('无效磁盘 JSON 不崩溃，回退到 WAL 或 NEW', async () => {
    vi.mocked(invoke).mockResolvedValueOnce('not-valid-json{{{');
    vi.mocked(db.loadWAL).mockResolvedValueOnce({
      schemaVersion: STORAGE_SCHEMA_VERSION,
      storageUpdatedAt: 42,
      notes: [{ id: 'w1', boardId: 'default', x: 0, y: 0, title: '', content: '', color: '#FFFFFF', z: 1, createdAt: 10, updatedAt: 42 }],
      boards: [DEFAULT_BOARD],
      currentBoardId: DEFAULT_BOARD.id,
      config: DEFAULT_CONFIG,
    });

    const result = await bootstrap();

    expect(result.source).toBe('WAL');
    expect(result.data.notes[0].id).toBe('w1');
    expect(result.recovered).toBe(false);
    expect(result.diskTime).toBe(0);
  });

  it('无效磁盘 JSON 且无 WAL 时返回 NEW', async () => {
    vi.mocked(invoke).mockResolvedValueOnce('{broken');
    vi.mocked(db.loadWAL).mockResolvedValueOnce(undefined);

    const result = await bootstrap();

    expect(result.source).toBe('NEW');
    expect(result.data.notes).toEqual([]);
    expect(result.recovered).toBe(true);
    expect(result.walTime).toBe(0);
    expect(result.diskTime).toBe(0);
  });

  it('config.maxZ 被校准为 max(现有 maxZ, notes.length)', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [
        { id: 'a', boardId: 'default', x: 0, y: 0, title: '', content: '', color: '#FFFFFF', z: 50, createdAt: 10, updatedAt: 10 },
        { id: 'b', boardId: 'default', x: 0, y: 0, title: '', content: '', color: '#FFFFFF', z: 3, createdAt: 10, updatedAt: 10 },
      ],
      config: { ...DEFAULT_CONFIG, maxZ: 2 },
      storageUpdatedAt: 10,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce(undefined);

    const result = await bootstrap();

    expect(result.data.config.maxZ).toBe(Math.max(50, 2));
  });
});
