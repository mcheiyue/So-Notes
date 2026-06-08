import { describe, it, expect, vi, beforeEach } from 'vitest';

let capturedBridgeCallback: ((state: DomainState) => void) | null = null;

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

vi.mock('../../store/domainStore', () => ({
  setDomainPersistenceBridge: vi.fn((bridge: unknown) => {
    capturedBridgeCallback = bridge as (state: DomainState) => void;
    return vi.fn();
  }),
}));

const { resolveAttachmentAssetUrlCachedMock } = vi.hoisted(() => ({
  resolveAttachmentAssetUrlCachedMock: vi.fn(async (relativePath: string) => `asset://localhost/${relativePath}`),
}));

vi.mock('./attachmentPersistence', () => ({
  resolveAttachmentAssetUrlCached: resolveAttachmentAssetUrlCachedMock,
}));

import { invoke } from '@tauri-apps/api/core';
import { db } from '../../store/db';
import { setDomainPersistenceBridge } from '../../store/domainStore';
import { bootstrap, attach } from './StorageService';
import { STORAGE_SCHEMA_VERSION, DEFAULT_BOARD, DEFAULT_CONFIG } from '../../store/types';
import type { DomainState } from '../../store/domainStore';
import type { StorageData, AttachmentRef } from '../../store/types';

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
    resolveAttachmentAssetUrlCachedMock.mockImplementation(async (relativePath: string) => `asset://localhost/${relativePath}`);
  });

  it('disk 更新时选择 DISK 来源', async () => {
    const diskTime = 9000;
    const walTime = 1000;

    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [{
        id: 'd1',
        kind: 'text',
        boardId: 'default',
        x: 10,
        y: 20,
        title: 'Disk',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 100, updatedAt: diskTime
      }],
      storageUpdatedAt: diskTime,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce({
      schemaVersion: STORAGE_SCHEMA_VERSION,
      storageUpdatedAt: walTime,
      notes: [{
        id: 'w1',
        kind: 'text',
        boardId: 'default',
        x: 5,
        y: 5,
        title: 'WAL',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 50, updatedAt: walTime
      }],
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

  it('DISK 与 WAL 同时间戳时选择 WAL 来源', async () => {
    const time = 5000;

    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [{
        id: 'd1',
        kind: 'text',
        boardId: 'default',
        x: 0,
        y: 0,
        title: '',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 100, updatedAt: time
      }],
      storageUpdatedAt: time,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce({
      schemaVersion: STORAGE_SCHEMA_VERSION,
      storageUpdatedAt: time,
      notes: [{
        id: 'w1',
        kind: 'text',
        boardId: 'default',
        x: 0,
        y: 0,
        title: '',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 100, updatedAt: time
      }],
      boards: [DEFAULT_BOARD],
      currentBoardId: DEFAULT_BOARD.id,
      config: DEFAULT_CONFIG,
    });

    const result = await bootstrap();

    expect(result.source).toBe('WAL');
    expect(result.data.notes[0].id).toBe('w1');
    expect(result.syncAction.type).toBe('SYNC_WAL_TO_DISK');
    expect(result.walTime).toBe(time);
    expect(result.diskTime).toBe(time);
    expect(result.recovered).toBe(false);
  });

  it('磁盘是较新空快照时选择 DISK 以避免旧 WAL 复活便签', async () => {
    const walTime = 5000;
    const diskTime = 9000;

    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [],
      storageUpdatedAt: diskTime,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce({
      schemaVersion: STORAGE_SCHEMA_VERSION,
      storageUpdatedAt: walTime,
      notes: [{
        id: 'w1',
        kind: 'text',
        boardId: 'default',
        x: 5,
        y: 5,
        title: 'WAL',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 50, updatedAt: walTime
      }],
      boards: [DEFAULT_BOARD],
      currentBoardId: DEFAULT_BOARD.id,
      config: DEFAULT_CONFIG,
    });

    const result = await bootstrap();

    expect(result.source).toBe('DISK');
    expect(result.data.notes).toEqual([]);
    expect(result.syncAction.type).toBe('SYNC_DISK_TO_WAL');
    expect(result.diskTime).toBe(diskTime);
    expect(result.walTime).toBe(walTime);
  });

  it('WAL 是较新空快照时选择 WAL 以保留全部删除结果', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [{
        id: 'd1',
        kind: 'text',
        boardId: 'default',
        x: 0,
        y: 0,
        title: '',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 100, updatedAt: 200
      }],
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

    expect(result.source).toBe('WAL');
    expect(result.data.notes).toEqual([]);
    expect(result.syncAction.type).toBe('SYNC_WAL_TO_DISK');
    expect(result.diskTime).toBe(200);
    expect(result.walTime).toBe(500);
    expect(result.recovered).toBe(false);
  });

  it('WAL 缺少 boards 但 notes 可迁移时会选择 WAL 并补齐看板', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [{
        id: 'd1',
        kind: 'text',
        boardId: 'default',
        x: 0,
        y: 0,
        title: '',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 100, updatedAt: 200
      }],
      storageUpdatedAt: 200,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce({
      schemaVersion: STORAGE_SCHEMA_VERSION,
      storageUpdatedAt: 500,
      notes: [{
        id: 'w1',
        kind: 'text',
        x: 0,
        y: 0,
        title: 'WAL',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 100, updatedAt: 500,
      }],
      currentBoardId: DEFAULT_BOARD.id,
      config: DEFAULT_CONFIG,
    } as unknown as StorageData);

    const result = await bootstrap();

    expect(result.source).toBe('WAL');
    expect(result.data.notes[0].id).toBe('w1');
    expect(result.data.notes[0].boardId).toBe(DEFAULT_BOARD.id);
    expect(result.data.boards).toEqual([DEFAULT_BOARD]);
    expect(result.data.currentBoardId).toBe(DEFAULT_BOARD.id);
    expect(result.syncAction.type).toBe('SYNC_WAL_TO_DISK');
    expect(result.walTime).toBe(500);
    expect(result.diskTime).toBe(200);
  });

  it('WAL 缺少 notes 时不会在归一化阶段抛错', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [{
        id: 'd1',
        kind: 'text',
        boardId: 'default',
        x: 0,
        y: 0,
        title: '',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 100, updatedAt: 200
      }],
      storageUpdatedAt: 200,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce({
      schemaVersion: STORAGE_SCHEMA_VERSION,
      storageUpdatedAt: 500,
      boards: [DEFAULT_BOARD],
      currentBoardId: DEFAULT_BOARD.id,
      config: DEFAULT_CONFIG,
    } as unknown as StorageData);

    const result = await bootstrap();

    expect(result.source).toBe('DISK');
    expect(result.data.notes[0].id).toBe('d1');
    expect(result.walTime).toBe(0);
    expect(result.diskTime).toBe(200);
  });

  it('WAL notes 包含坏元素时不会阻断 DISK 回退', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [{
        id: 'd1',
        kind: 'text',
        boardId: 'default',
        x: 0,
        y: 0,
        title: 'DISK',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 100, updatedAt: 200
      }],
      storageUpdatedAt: 200,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce({
      schemaVersion: STORAGE_SCHEMA_VERSION,
      notes: [null],
      boards: [DEFAULT_BOARD],
      currentBoardId: DEFAULT_BOARD.id,
      config: DEFAULT_CONFIG,
    } as unknown as StorageData);

    const result = await bootstrap();

    expect(result.source).toBe('DISK');
    expect(result.data.notes[0].id).toBe('d1');
    expect(result.walTime).toBe(0);
    expect(result.diskTime).toBe(200);
  });

  it('较新 WAL 迁移失败时会回退到有效 DISK', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [{
        id: 'd1',
        kind: 'text',
        boardId: 'default',
        x: 0,
        y: 0,
        title: 'DISK',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 100, updatedAt: 200
      }],
      storageUpdatedAt: 200,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce({
      schemaVersion: STORAGE_SCHEMA_VERSION,
      storageUpdatedAt: 500,
      notes: [{
        id: 'w1',
        kind: 'text',
        boardId: 'default',
        x: 0,
        y: 0,
        title: 'WAL',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 100, updatedAt: 500,
      }],
      boards: [{ name: '坏看板', icon: '📌', createdAt: 0 }],
      currentBoardId: 'default',
      config: DEFAULT_CONFIG,
    } as unknown as StorageData);

    const result = await bootstrap();

    expect(result.source).toBe('DISK');
    expect(result.data.notes[0].id).toBe('d1');
    expect(result.syncAction.type).toBe('SYNC_DISK_TO_WAL');
    expect(result.walTime).toBe(500);
    expect(result.diskTime).toBe(200);
  });

  it('WAL 缺少 config 且 boards 非数组时会安全迁移', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [],
      storageUpdatedAt: 200,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce({
      schemaVersion: STORAGE_SCHEMA_VERSION,
      storageUpdatedAt: 500,
      notes: [{
        id: 'w1',
        kind: 'text',
        x: 0,
        y: 0,
        title: 'WAL',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 100, updatedAt: 500,
      }],
      boards: 'bad-boards',
      currentBoardId: 'missing-board',
    } as unknown as StorageData);

    const result = await bootstrap();

    expect(result.source).toBe('WAL');
    expect(result.data.notes[0].id).toBe('w1');
    expect(result.data.notes[0].boardId).toBe(DEFAULT_BOARD.id);
    expect(result.data.boards).toEqual([DEFAULT_BOARD]);
    expect(result.data.currentBoardId).toBe(DEFAULT_BOARD.id);
    expect(result.data.config).toEqual(expect.objectContaining(DEFAULT_CONFIG));
    expect(result.syncAction.type).toBe('SYNC_WAL_TO_DISK');
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
      notes: [{
        id: 'old',
        kind: 'text',
        boardId: 'default',
        x: 0,
        y: 0,
        title: 'Old',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 100, updatedAt: 888
      }],
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
        {
          id: 'ok',
          kind: 'text',
          boardId: 'b1',
          x: 100,
          y: 200,
          title: 'Good',
          content: '',
          color: '#FFFFFF',
          z: 2,
          createdAt: 200, updatedAt: 200
        },
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
      notes: [{
        id: 'n1',
        kind: 'text',
        boardId: 'ghost',
        x: 0,
        y: 0,
        title: '',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 100, updatedAt: 100
      }],
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
      notes: [{
        id: 'w1',
        kind: 'text',
        boardId: 'default',
        x: 0,
        y: 0,
        title: '',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 10, updatedAt: 42
      }],
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
        {
          id: 'a',
          kind: 'text',
          boardId: 'default',
          x: 0,
          y: 0,
          title: '',
          content: '',
          color: '#FFFFFF',
          z: 50,
          createdAt: 10, updatedAt: 10
        },
        {
          id: 'b',
          kind: 'text',
          boardId: 'default',
          x: 0,
          y: 0,
          title: '',
          content: '',
          color: '#FFFFFF',
          z: 3,
          createdAt: 10, updatedAt: 10
        },
      ],
      config: { ...DEFAULT_CONFIG, maxZ: 2 },
      storageUpdatedAt: 10,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce(undefined);

    const result = await bootstrap();

    expect(result.data.config.maxZ).toBe(Math.max(50, 2));
  });
});

const makeDomainState = (): DomainState => ({
  notesById: {
    'note-1': {
      id: 'note-1',
      kind: 'text',
      boardId: DEFAULT_BOARD.id,
      x: 10,
      y: 20,
      title: '安全写入样本',
      content: '',
      color: '#FFFFFF',
      z: 1,
      createdAt: 100,
      updatedAt: 100,
    },
  },
  allNoteIds: ['note-1'],
  boardNoteIds: { [DEFAULT_BOARD.id]: ['note-1'] },
  layoutNotesById: {
    'note-1': {
      id: 'note-1',
      boardId: DEFAULT_BOARD.id,
      x: 10,
      y: 20,
      deletedAt: null,
      color: '#FFFFFF',
    },
  },
  boards: [DEFAULT_BOARD],
  currentBoardId: DEFAULT_BOARD.id,
  config: { ...DEFAULT_CONFIG },
});

const makeEmptyDomainState = (): DomainState => ({
  notesById: {},
  allNoteIds: [],
  boardNoteIds: {},
  layoutNotesById: {},
  boards: [DEFAULT_BOARD],
  currentBoardId: DEFAULT_BOARD.id,
  config: { ...DEFAULT_CONFIG },
});

describe('StorageService.attach', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedBridgeCallback = null;
    vi.useFakeTimers();
  });

  it('不写入直到收到 domain bridge 通知', async () => {
    const writeWAL = vi.fn(async () => true);
    const writeDisk = vi.fn(async () => true);

    const handle = attach({ writeWAL, writeDisk });

    expect(writeWAL).not.toHaveBeenCalled();
    expect(writeDisk).not.toHaveBeenCalled();
    expect(handle.getStatus()).toBe('idle');

    handle.detach();
  });

  it('bridge 通知后状态变为 dirty', () => {
    const handle = attach({ writeWAL: vi.fn(async () => true), writeDisk: vi.fn(async () => true) });

    capturedBridgeCallback!(makeDomainState());

    expect(handle.getStatus()).toBe('dirty');

    handle.detach();
  });

  it('WAL 节流合并快速变更', async () => {
    const writeWAL = vi.fn(async () => true);
    const writeDisk = vi.fn(async () => true);

    const handle = attach({ writeWAL, writeDisk, walThrottleMs: 100 });

    capturedBridgeCallback!(makeDomainState());
    capturedBridgeCallback!(makeDomainState());
    capturedBridgeCallback!(makeDomainState());

    expect(writeWAL).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);

    expect(writeWAL).toHaveBeenCalledTimes(1);

    handle.detach();
  });

  it('Disk 防抖合并快速变更', async () => {
    const writeWAL = vi.fn(async () => true);
    const writeDisk = vi.fn(async () => true);

    const handle = attach({ writeWAL, writeDisk, diskDebounceMs: 200 });

    capturedBridgeCallback!(makeDomainState());
    await vi.advanceTimersByTimeAsync(50);

    capturedBridgeCallback!(makeDomainState());
    await vi.advanceTimersByTimeAsync(50);

    capturedBridgeCallback!(makeDomainState());

    expect(writeDisk).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);

    expect(writeDisk).toHaveBeenCalledTimes(1);

    handle.detach();
  });

  it('pause 取消挂起写入并抑制后续领域变更调度', async () => {
    const writeWAL = vi.fn(async () => true);
    const writeDisk = vi.fn(async () => true);

    const handle = attach({ writeWAL, writeDisk, walThrottleMs: 100, diskDebounceMs: 200 });

    capturedBridgeCallback!(makeDomainState());
    handle.pause();

    expect(handle.isPaused()).toBe(true);

    capturedBridgeCallback!(makeDomainState());
    await vi.advanceTimersByTimeAsync(500);

    expect(writeWAL).not.toHaveBeenCalled();
    expect(writeDisk).not.toHaveBeenCalled();

    handle.detach();
  });

  it('resume 后新的领域变更重新触发持久化调度', async () => {
    const writeWAL = vi.fn(async () => true);
    const writeDisk = vi.fn(async () => true);

    const handle = attach({ writeWAL, writeDisk, walThrottleMs: 100, diskDebounceMs: 200 });

    handle.pause();
    capturedBridgeCallback!(makeDomainState());
    await vi.advanceTimersByTimeAsync(500);

    expect(writeWAL).not.toHaveBeenCalled();
    expect(writeDisk).not.toHaveBeenCalled();

    handle.resume();
    expect(handle.isPaused()).toBe(false);

    capturedBridgeCallback!(makeDomainState());
    await vi.advanceTimersByTimeAsync(200);

    expect(writeWAL).toHaveBeenCalledTimes(1);
    expect(writeDisk).toHaveBeenCalledTimes(1);

    handle.detach();
  });

  it('pause 后仍允许 flushPersistNow 立即刷新已有脏数据', async () => {
    const writeWAL = vi.fn(async () => true);
    const writeDisk = vi.fn(async () => true);

    const handle = attach({ writeWAL, writeDisk, walThrottleMs: 100, diskDebounceMs: 200 });

    capturedBridgeCallback!(makeDomainState());
    handle.pause();

    const result = await handle.flushPersistNow();

    expect(result).toBe(true);
    expect(writeWAL).toHaveBeenCalledTimes(1);
    expect(writeDisk).toHaveBeenCalledTimes(1);

    handle.detach();
  });

  it('flushPersistNow 强制立即写入', async () => {
    const writeWAL = vi.fn(async () => true);
    const writeDisk = vi.fn(async () => true);

    const handle = attach({ writeWAL, writeDisk });

    capturedBridgeCallback!(makeDomainState());

    const result = await handle.flushPersistNow();

    expect(result).toBe(true);
    expect(writeWAL).toHaveBeenCalledTimes(1);
    expect(writeDisk).toHaveBeenCalledTimes(1);

    handle.detach();
  });

  it('flushPersistNow 无脏数据时直接返回 true', async () => {
    const writeWAL = vi.fn(async () => true);
    const writeDisk = vi.fn(async () => true);

    const handle = attach({ writeWAL, writeDisk });

    const result = await handle.flushPersistNow();

    expect(result).toBe(true);
    expect(writeWAL).not.toHaveBeenCalled();
    expect(writeDisk).not.toHaveBeenCalled();

    handle.detach();
  });

  it('flushPersistNow 会写入 attach 时传入的初始领域状态', async () => {
    const writeWAL = vi.fn(async () => true);
    const writeDisk = vi.fn(async () => true);
    const initialState = makeDomainState();

    const handle = attach({ writeWAL, writeDisk, initialState });

    const result = await handle.flushPersistNow();

    expect(result).toBe(true);
    expect(writeWAL).toHaveBeenCalledTimes(1);
    expect(writeDisk).toHaveBeenCalledTimes(1);
    expect(writeDisk).toHaveBeenCalledWith(expect.objectContaining({ notes: [initialState.notesById['note-1']] }));

    handle.detach();
  });

  it('flushPersistNow 不会写入空初始领域状态', async () => {
    const writeWAL = vi.fn(async () => true);
    const writeDisk = vi.fn(async () => true);

    const handle = attach({ writeWAL, writeDisk, initialState: makeEmptyDomainState() });

    const result = await handle.flushPersistNow();

    expect(result).toBe(true);
    expect(writeWAL).not.toHaveBeenCalled();
    expect(writeDisk).not.toHaveBeenCalled();

    handle.detach();
  });

  it('flushPersistNow 检测到无效领域契约时拒绝写入 WAL 和磁盘', async () => {
    const writeWAL = vi.fn(async () => true);
    const writeDisk = vi.fn(async () => true);

    const handle = attach({ writeWAL, writeDisk });

    capturedBridgeCallback!({ ...makeEmptyDomainState(), boards: [] });

    const result = await handle.flushPersistNow();

    expect(result).toBe(false);
    expect(writeWAL).not.toHaveBeenCalled();
    expect(writeDisk).not.toHaveBeenCalled();
    expect(handle.getStatus()).toBe('error');

    handle.detach();
  });

  it('定时写入检测到无效领域契约时拒绝写入 WAL 和磁盘', async () => {
    const writeWAL = vi.fn(async () => true);
    const writeDisk = vi.fn(async () => true);

    const handle = attach({ writeWAL, writeDisk, walThrottleMs: 100, diskDebounceMs: 200 });

    capturedBridgeCallback!({ ...makeEmptyDomainState(), boards: [] });
    await vi.advanceTimersByTimeAsync(300);

    expect(writeWAL).not.toHaveBeenCalled();
    expect(writeDisk).not.toHaveBeenCalled();
    expect(handle.getStatus()).toBe('error');

    handle.detach();
  });

  it('flushPersistNow WAL 失败时返回 false', async () => {
    const writeWAL = vi.fn(async () => false);
    const writeDisk = vi.fn(async () => true);

    const handle = attach({ writeWAL, writeDisk });

    capturedBridgeCallback!(makeDomainState());

    const result = await handle.flushPersistNow();

    expect(result).toBe(false);
    expect(writeWAL).toHaveBeenCalledTimes(1);
    expect(writeDisk).not.toHaveBeenCalled();
    expect(handle.getStatus()).toBe('error');

    handle.detach();
  });

  it('磁盘 in-flight 时 pending 合并为一次后续写入', async () => {
    const diskResolvers: Array<(value: boolean) => void> = [];
    const writeDisk = vi.fn(() => new Promise<boolean>((resolve) => diskResolvers.push(resolve)));
    const writeWAL = vi.fn(async () => true);

    const handle = attach({ writeWAL, writeDisk, diskDebounceMs: 5000 });

    capturedBridgeCallback!(makeDomainState());

    const flushPromise = handle.flushPersistNow();

    await vi.runAllTimersAsync();
    expect(writeDisk).toHaveBeenCalledTimes(1);

    capturedBridgeCallback!(makeDomainState());

    diskResolvers[0](true);
    await vi.runAllTimersAsync();

    expect(writeDisk).toHaveBeenCalledTimes(2);

    diskResolvers[1](true);
    await vi.runAllTimersAsync();

    const result = await flushPromise;
    expect(result).toBe(true);

    handle.detach();
  });

  it('detach 移除 bridge 监听器和定时器', async () => {
    const writeWAL = vi.fn(async () => true);
    const writeDisk = vi.fn(async () => true);
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');
    const docRemoveSpy = vi.spyOn(document, 'removeEventListener');

    const handle = attach({ writeWAL, writeDisk });

    expect(addEventListenerSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    expect(setDomainPersistenceBridge).toHaveBeenCalled();

    capturedBridgeCallback!(makeDomainState());

    handle.detach();

    expect(removeEventListenerSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    expect(docRemoveSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

    await vi.advanceTimersByTimeAsync(5000);

    expect(writeWAL).not.toHaveBeenCalled();
    expect(writeDisk).not.toHaveBeenCalled();

    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
    docRemoveSpy.mockRestore();
  });

  it('visibilitychange hidden 触发 flush', async () => {
    const writeWAL = vi.fn(async () => true);
    const writeDisk = vi.fn(async () => true);

    const handle = attach({ writeWAL, writeDisk });

    capturedBridgeCallback!(makeDomainState());

    const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    if (visibilityDescriptor) {
      Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
    }

    await vi.runAllTimersAsync();

    expect(writeWAL).toHaveBeenCalledTimes(1);
    expect(writeDisk).toHaveBeenCalledTimes(1);

    handle.detach();
  });

  it('onStatusChange 回调在状态变更时被调用', async () => {
    const writeWAL = vi.fn(async () => true);
    const writeDisk = vi.fn(async () => true);
    const onStatusChange = vi.fn();

    const handle = attach({ writeWAL, writeDisk, diskDebounceMs: 200, onStatusChange });

    capturedBridgeCallback!(makeDomainState());
    expect(onStatusChange).toHaveBeenCalledWith('dirty');

    await vi.advanceTimersByTimeAsync(100);
    expect(onStatusChange).toHaveBeenCalledWith('writing-wal');

    await vi.advanceTimersByTimeAsync(200);
    expect(onStatusChange).toHaveBeenCalledWith('writing-disk');

    await vi.runAllTimersAsync();
    expect(onStatusChange).toHaveBeenCalledWith('idle');

    handle.detach();
  });

  it('onStatusChange WAL 失败时回调 error 状态', async () => {
    const writeWAL = vi.fn(async () => false);
    const writeDisk = vi.fn(async () => true);
    const onStatusChange = vi.fn();

    const handle = attach({ writeWAL, writeDisk, onStatusChange });

    capturedBridgeCallback!(makeDomainState());

    const result = await handle.flushPersistNow();

    expect(result).toBe(false);
    expect(onStatusChange).toHaveBeenCalledWith('error');

    handle.detach();
  });
});

const VALID_REF: AttachmentRef = {
  id: 'att-001',
  hash: 'a'.repeat(64),
  filename: 'photo.jpg',
  mimeType: 'image/jpeg',
  size: 1024,
  relativePath: 'attachments/' + 'a'.repeat(64) + '.jpg',
  createdAt: 1700000000000,
};

describe('StorageService 附件迁移与归一化', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('v1 旧数据（无 attachments 字段）安全加载，文本便签不补附件字段', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify({
      schemaVersion: 1,
      storageUpdatedAt: 100,
      notes: [
        {
          id: 'old-1',
          kind: 'text',
          boardId: 'default',
          x: 0,
          y: 0,
          title: '旧',
          content: '',
          color: '#FFFFFF',
          z: 1,
          createdAt: 10, updatedAt: 10
        },
        {
          id: 'old-2',
          kind: 'text',
          boardId: 'default',
          x: 10,
          y: 10,
          title: '旧二',
          content: '',
          color: '#FFFFFF',
          z: 2,
          createdAt: 20, updatedAt: 20
        },
      ],
      boards: [DEFAULT_BOARD],
      currentBoardId: DEFAULT_BOARD.id,
      config: DEFAULT_CONFIG,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce(undefined);

    const result = await bootstrap();

    expect(result.data.notes).toHaveLength(2);
    expect(result.data.schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
    expect(result.data.notes[0].attachments).toBeUndefined();
    expect(result.data.notes[1].attachments).toBeUndefined();
  });

  it('文本便签上的 AttachmentRef 在迁移后被剔除', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [{
        id: 'with-ref',
        kind: 'text',
        boardId: 'default',
        x: 0,
        y: 0,
        title: '有附件',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 10,
        updatedAt: 10,
        attachments: [VALID_REF],
      }],
      storageUpdatedAt: 100,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce(undefined);

    const result = await bootstrap();
    const note = result.data.notes[0];

    expect(note.attachments).toBeUndefined();
  });

  it('图片便签上的 AttachmentRef 在迁移后完整保留', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [{
        id: 'image-with-ref',
        kind: 'image',
        boardId: 'default',
        x: 0,
        y: 0,
        title: '图片',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 10,
        updatedAt: 10,
        attachments: [VALID_REF],
      }],
      storageUpdatedAt: 100,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce(undefined);

    const result = await bootstrap();
    const note = result.data.notes[0];

    expect(note.attachments).toHaveLength(1);
    expect(note.attachments?.[0]).toEqual(VALID_REF);
  });

  it('启动加载图片便签后会预水合图片资源 URL 缓存', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [{
        id: 'image-with-ref',
        kind: 'image',
        boardId: 'default',
        x: 0,
        y: 0,
        title: '图片',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 10,
        updatedAt: 10,
        attachments: [VALID_REF],
      }],
      storageUpdatedAt: 100,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce(undefined);

    const result = await bootstrap();

    expect(result.data.notes[0].kind).toBe('image');
    expect(resolveAttachmentAssetUrlCachedMock).toHaveBeenCalledWith(VALID_REF.relativePath);
  });

  it('附件迁移会剥离多余字段，避免二进制残留进入 Domain state', async () => {
    const dirtyRef: Record<string, unknown> = {
      ...VALID_REF,
      base64: 'data:image/jpeg;base64,xxx',
      data: 'binary-like-payload',
    };

    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [{
        id: 'dirty-ref',
        kind: 'text',
        boardId: 'default',
        x: 0,
        y: 0,
        title: '脏附件',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 10,
        updatedAt: 10,
        attachments: [dirtyRef],
      }],
      storageUpdatedAt: 100,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce(undefined);

    const result = await bootstrap();
    expect(result.data.notes[0].attachments).toBeUndefined();
  });

  it('畸形附件条目被过滤，合法条目保留', async () => {
    const malformedEntries = [
      null,
      42,
      'string',
      { id: 123 },
      { id: 'bad', hash: 999 },
      { id: 'bad', hash: 'abc', filename: 'f', mimeType: 'm', size: 'not-num', relativePath: 'r', createdAt: 1 },
      { id: 'bad', hash: 'abc', filename: 'f', mimeType: 'm', size: 1, relativePath: '', createdAt: 1 },
      { id: 'bad', hash: 'abc', filename: 'f', mimeType: 'm', size: 1, relativePath: 'r', createdAt: Infinity },
    ];

    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [{
        id: 'mixed',
        kind: 'text',
        boardId: 'default',
        x: 0,
        y: 0,
        title: '混合',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 10,
        updatedAt: 10,
        attachments: [...malformedEntries, VALID_REF],
      }],
      storageUpdatedAt: 100,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce(undefined);

    const result = await bootstrap();
    const note = result.data.notes[0];

    expect(note.attachments).toBeUndefined();
  });

  it('attachments 为非数组值时文本便签剔除附件字段', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [{
        id: 'non-array',
        kind: 'text',
        boardId: 'default',
        x: 0,
        y: 0,
        title: '异常',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 10,
        updatedAt: 10,
        attachments: 'not-an-array',
      }],
      storageUpdatedAt: 100,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce(undefined);

    const result = await bootstrap();

    expect(result.data.notes[0].attachments).toBeUndefined();
  });

  it('bootstrap 输出 schemaVersion 为 2', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [{
        id: 'v2',
        kind: 'text',
        boardId: 'default',
        x: 0,
        y: 0,
        title: '',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 10, updatedAt: 10
      }],
      storageUpdatedAt: 10,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce(undefined);

    const result = await bootstrap();

    expect(result.data.schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
    expect(result.data.schemaVersion).toBe(2);
  });

  it('WAL 来源数据也经过附件迁移归一化', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    vi.mocked(db.loadWAL).mockResolvedValueOnce({
      schemaVersion: 1,
      storageUpdatedAt: 500,
      notes: [{
        id: 'wal-note',
        kind: 'text',
        boardId: 'default',
        x: 0,
        y: 0,
        title: 'WAL',
        content: '',
        color: '#FFFFFF',
        z: 1,
        createdAt: 10,
        updatedAt: 500,
      }],
      boards: [DEFAULT_BOARD],
      currentBoardId: DEFAULT_BOARD.id,
      config: DEFAULT_CONFIG,
    });

    const result = await bootstrap();

    expect(result.source).toBe('WAL');
    expect(result.data.notes[0].attachments).toBeUndefined();
  });
});
