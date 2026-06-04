import { describe, it, expect, vi, beforeEach } from 'vitest';

let capturedBridgeCallback: ((state: Record<string, unknown>) => void) | null = null;

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
    capturedBridgeCallback = bridge as (state: Record<string, unknown>) => void;
    return vi.fn();
  }),
}));

import { invoke } from '@tauri-apps/api/core';
import { db } from '../../store/db';
import { setDomainPersistenceBridge } from '../../store/domainStore';
import { bootstrap, attach } from './StorageService';
import { STORAGE_SCHEMA_VERSION, DEFAULT_BOARD, DEFAULT_CONFIG } from '../../store/types';
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

const makeDomainState = () => ({
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

  it('v1 旧数据（无 attachments 字段）安全加载，每个 note 补齐 attachments: []', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify({
      schemaVersion: 1,
      storageUpdatedAt: 100,
      notes: [
        { id: 'old-1', boardId: 'default', x: 0, y: 0, title: '旧', content: '', color: '#FFFFFF', z: 1, createdAt: 10, updatedAt: 10 },
        { id: 'old-2', boardId: 'default', x: 10, y: 10, title: '旧二', content: '', color: '#FFFFFF', z: 2, createdAt: 20, updatedAt: 20 },
      ],
      boards: [DEFAULT_BOARD],
      currentBoardId: DEFAULT_BOARD.id,
      config: DEFAULT_CONFIG,
    }));
    vi.mocked(db.loadWAL).mockResolvedValueOnce(undefined);

    const result = await bootstrap();

    expect(result.data.notes).toHaveLength(2);
    expect(result.data.schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
    expect(result.data.notes[0].attachments).toEqual([]);
    expect(result.data.notes[1].attachments).toEqual([]);
  });

  it('合法 AttachmentRef 在迁移后完整保留', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [{
        id: 'with-ref',
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

    expect(note.attachments).toHaveLength(1);
    expect(note.attachments?.[0]).toEqual(VALID_REF);
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

    expect(note.attachments).toHaveLength(1);
    expect(note.attachments?.[0]).toEqual(VALID_REF);
  });

  it('attachments 为非数组值时归一化为空数组', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [{
        id: 'non-array',
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

    expect(result.data.notes[0].attachments).toEqual([]);
  });

  it('bootstrap 输出 schemaVersion 为 2', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(makeDiskJson({
      notes: [{ id: 'v2', boardId: 'default', x: 0, y: 0, title: '', content: '', color: '#FFFFFF', z: 1, createdAt: 10, updatedAt: 10 }],
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
    expect(result.data.notes[0].attachments).toEqual([]);
  });
});
