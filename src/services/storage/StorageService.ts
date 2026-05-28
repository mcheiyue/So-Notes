import type { StorageData, Note, Board } from '../../store/types';
import { DEFAULT_BOARD, DEFAULT_CONFIG } from '../../store/types';
import { db } from '../../store/db';
import type { BootstrapResult, SyncAction, StorageDataSource } from './types';
import {
  readDiskStorageData,
  normalizeStorageDataMetadata,
  getLatestUpdateTimestamp,
} from './tauriPersistence';

export const STORAGE_SERVICE_MODULE = 'StorageService' as const;

export type StorageServiceModuleName = typeof STORAGE_SERVICE_MODULE;

export interface StorageServiceScaffold {
  readonly module: StorageServiceModuleName;
  readonly description: 'Domain persistence service scaffold';
}

export const storageServiceScaffold: StorageServiceScaffold = {
  module: STORAGE_SERVICE_MODULE,
  description: 'Domain persistence service scaffold',
};

const buildNewDefaultData = (): StorageData =>
  normalizeStorageDataMetadata({
    notes: [],
    boards: [DEFAULT_BOARD],
    currentBoardId: DEFAULT_BOARD.id,
    config: DEFAULT_CONFIG,
  });

const migrateAndSanitize = (data: StorageData): StorageData => {
  if (data.notes.length > 0) {
    const currentMaxZ = Math.max(...data.notes.map((n) => n.z || 0), 0);
    data.config.maxZ = Math.max(currentMaxZ, data.notes.length);

    data.notes.forEach((n: Note, i: number) => {
      if (n.x < 0 || n.y < 0) {
        n.x = 20 + i * 10;
        n.y = 20 + i * 10;
      }
      if (n.collapsed === undefined) n.collapsed = false;
      if (n.title === undefined) n.title = '';
      if (!n.boardId) n.boardId = 'default';
      if (!n.updatedAt) n.updatedAt = n.createdAt || Date.now();
    });
  }

  if (!data.boards || data.boards.length === 0) {
    data.boards = [DEFAULT_BOARD];
    data.currentBoardId = DEFAULT_BOARD.id;
  }

  if (!data.currentBoardId || !data.boards.find((b: Board) => b.id === data.currentBoardId)) {
    data.currentBoardId = data.boards[0].id;
  }

  return data;
};

const resolveSyncAction = (source: StorageDataSource, data: StorageData): SyncAction => {
  if (source === 'DISK') return { type: 'SYNC_DISK_TO_WAL', data };
  if (source === 'WAL') return { type: 'SYNC_WAL_TO_DISK' };
  return { type: 'NONE' };
};

export async function bootstrap(): Promise<BootstrapResult> {
  const defaultData = buildNewDefaultData();

  const [walData, diskData] = await Promise.all([
    db.loadWAL().then((raw) => (raw ? normalizeStorageDataMetadata(raw) : undefined)),
    readDiskStorageData('data.json'),
  ]);

  let finalData: StorageData = defaultData;
  let source: StorageDataSource = 'NEW';

  const walTime = getLatestUpdateTimestamp(walData);
  const diskTime = getLatestUpdateTimestamp(diskData);

  if (diskData && diskTime > walTime) {
    finalData = diskData;
    source = 'DISK';
  } else if (walData && walData.notes.length > 0) {
    finalData = walData;
    source = 'WAL';
  } else if (diskData) {
    finalData = diskData;
    source = 'DISK';
  }

  finalData = migrateAndSanitize(finalData);

  return {
    source,
    data: finalData,
    syncAction: resolveSyncAction(source, finalData),
    walTime,
    diskTime,
    recovered: source === 'NEW',
  };
}
