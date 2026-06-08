import { invoke } from '@tauri-apps/api/core';
import type { StorageData, Note, Board, SaveResult } from '../../store/types';
import { DEFAULT_BOARD, DEFAULT_CONFIG, STORAGE_SCHEMA_VERSION } from '../../store/types';
import { db } from '../../store/db';
import type { DomainState } from '../../store/domainStore';
import { setDomainPersistenceBridge } from '../../store/domainStore';
import { denormalizeNotes, sanitizeNoteAttachments } from '../../store/normalization';
import type { BootstrapResult, SyncAction, StorageDataSource, AttachOptions, AttachResult, PersistenceStatus } from './types';
import {
  readDiskStorageData,
  normalizeStorageDataMetadata,
  getLatestUpdateTimestamp,
} from './tauriPersistence';
import { resolveAttachmentAssetUrlCached } from './attachmentPersistence';

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

const hasInvalidStorageContract = (data: StorageData): boolean =>
  !Array.isArray(data.notes)
  || !Array.isArray(data.boards)
  || data.boards.length === 0
  || typeof data.currentBoardId !== 'string'
  || data.currentBoardId.length === 0
  || !data.boards.some((board) => board.id === data.currentBoardId);

const hasValidStorageContract = (data: StorageData | null | undefined): data is StorageData =>
  data != null && !hasInvalidStorageContract(data);

const hasMigratableStorageData = (data: StorageData | null | undefined): data is StorageData =>
  data != null && Array.isArray(data.notes);

const normalizeWalStorageData = (raw: unknown): StorageData | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  if (!Array.isArray((raw as { notes?: unknown }).notes)) return undefined;

  try {
    return normalizeStorageDataMetadata(raw as StorageData);
  } catch {
    return undefined;
  }
};

const migrateAndSanitize = (data: StorageData): StorageData => {
  const migrated: StorageData = {
    ...data,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    notes: Array.isArray(data.notes) ? data.notes : [],
    boards: Array.isArray(data.boards) ? data.boards : [DEFAULT_BOARD],
    currentBoardId: typeof data.currentBoardId === 'string' ? data.currentBoardId : DEFAULT_BOARD.id,
    config: { ...DEFAULT_CONFIG, ...(data.config && typeof data.config === 'object' ? data.config : {}) },
  };

  if (migrated.notes.length > 0) {
    const currentMaxZ = Math.max(...migrated.notes.map((n) => n.z || 0), 0);
    migrated.config.maxZ = Math.max(currentMaxZ, migrated.notes.length);

    migrated.notes.forEach((n: Note, i: number) => {
      if (n.x < 0 || n.y < 0) {
        n.x = 20 + i * 10;
        n.y = 20 + i * 10;
      }
      if (n.collapsed === undefined) n.collapsed = false;
      if (n.title === undefined) n.title = '';
      if (!n.boardId) n.boardId = 'default';
      if (!n.updatedAt) n.updatedAt = n.createdAt || Date.now();
        n.attachments = sanitizeNoteAttachments(n);
      });
  }

  if (migrated.boards.length === 0) {
    migrated.boards = [DEFAULT_BOARD];
    migrated.currentBoardId = DEFAULT_BOARD.id;
  }

  if (!migrated.currentBoardId || !migrated.boards.find((b: Board) => b.id === migrated.currentBoardId)) {
    migrated.currentBoardId = migrated.boards[0].id;
  }

  return migrated;
};

const tryPrepareSource = (data: StorageData | null | undefined): StorageData | null => {
  if (!hasMigratableStorageData(data)) return null;

  try {
    const migrated = migrateAndSanitize(data);
    return hasValidStorageContract(migrated) ? migrated : null;
  } catch {
    return null;
  }
};

const prehydrateImageNoteAssetUrls = async (notes: Note[]): Promise<void> => {
  const imageRelativePaths = notes
    .filter((note) => note.kind === 'image')
    .flatMap((note) => note.attachments ?? [])
    .map((attachment) => attachment.relativePath);

  if (imageRelativePaths.length === 0) return;

  await Promise.allSettled(
    Array.from(new Set(imageRelativePaths)).map((relativePath) =>
      resolveAttachmentAssetUrlCached(relativePath),
    ),
  );
};

const resolveSyncAction = (source: StorageDataSource, data: StorageData): SyncAction => {
  if (source === 'DISK') return { type: 'SYNC_DISK_TO_WAL', data };
  if (source === 'WAL') return { type: 'SYNC_WAL_TO_DISK' };
  return { type: 'NONE' };
};

export async function bootstrap(): Promise<BootstrapResult> {
  const defaultData = buildNewDefaultData();

  const [walData, diskData] = await Promise.all([
    db.loadWAL().then(normalizeWalStorageData),
    readDiskStorageData('data.json'),
  ]);

  const walTime = getLatestUpdateTimestamp(walData);
  const diskTime = getLatestUpdateTimestamp(diskData);
  const candidates = [
    { source: 'DISK' as const, data: diskData, time: diskTime },
    { source: 'WAL' as const, data: walData, time: walTime },
  ].sort((left, right) => {
    if (left.time !== right.time) return right.time - left.time;
    if (left.source === right.source) return 0;
    return left.source === 'WAL' ? -1 : 1;
  });

  let finalData: StorageData = defaultData;
  let source: StorageDataSource = 'NEW';

  for (const candidate of candidates) {
    const prepared = tryPrepareSource(candidate.data);
    if (prepared) {
      finalData = prepared;
      source = candidate.source;
      break;
    }
  }
  await prehydrateImageNoteAssetUrls(finalData.notes);

  return {
    source,
    data: finalData,
    syncAction: resolveSyncAction(source, finalData),
    walTime,
    diskTime,
    recovered: source === 'NEW',
  };
}

const serializeDomainState = (state: DomainState): StorageData => ({
  schemaVersion: STORAGE_SCHEMA_VERSION,
  storageUpdatedAt: Date.now(),
  notes: denormalizeNotes(state),
  boards: state.boards,
  currentBoardId: state.currentBoardId,
  config: state.config,
});

const defaultWriteDisk = async (data: StorageData): Promise<boolean> => {
  if (hasInvalidStorageContract(data)) {
    return false;
  }

  try {
    const jsonString = JSON.stringify(data, null, 2);
    const result = await invoke<SaveResult>('save_content', {
      filename: 'data.json',
      content: jsonString,
      generationId: data.storageUpdatedAt,
    });
    return result?.success ?? false;
  } catch {
    return false;
  }
};

export function attach(options?: AttachOptions): AttachResult {
  const walThrottleMs = options?.walThrottleMs ?? 100;
  const diskDebounceMs = options?.diskDebounceMs ?? 2000;
  const writeWAL = options?.writeWAL ?? ((data: StorageData) => db.saveWAL(data));
  const writeDisk = options?.writeDisk ?? defaultWriteDisk;

  const onStatusChange = options?.onStatusChange;

  let latestState: DomainState | null = options?.initialState ?? null;
  let status: PersistenceStatus = 'idle';
  let dirty = options?.initialState ? denormalizeNotes(options.initialState).length > 0 : false;
  let detached = false;
  let paused = false;

  let walTimer: ReturnType<typeof setTimeout> | null = null;
  let diskTimer: ReturnType<typeof setTimeout> | null = null;

  let diskInFlight = false;
  let diskPending = false;
  let diskDonePromise: Promise<boolean> = Promise.resolve(true);

  const setStatus = (s: PersistenceStatus) => {
    status = s;
    onStatusChange?.(s);
  };

  const flushWAL = async () => {
    walTimer = null;
    if (!dirty || !latestState) return;

    setStatus('writing-wal');
    const data = serializeDomainState(latestState);
    if (hasInvalidStorageContract(data)) {
      setStatus('error');
      return;
    }
    const success = await writeWAL(data);

    if (!success) {
      setStatus('error');
      return;
    }

    setStatus(dirty ? 'dirty' : 'idle');
  };

  const executeDiskWrite = (): Promise<boolean> => {
    if (diskInFlight) {
      diskPending = true;
      return diskDonePromise;
    }

    diskInFlight = true;

    const promise = (async () => {
      do {
        diskPending = false;
        if (!latestState) {
          diskInFlight = false;
          return true;
        }

        setStatus('writing-disk');
        const data = serializeDomainState(latestState);
        if (hasInvalidStorageContract(data)) {
          setStatus('error');
          diskInFlight = false;
          return false;
        }
        const success = await writeDisk(data);

        if (!success) {
          setStatus('error');
          diskInFlight = false;
          return false;
        }
      } while (diskPending);

      diskInFlight = false;

      dirty = false;
      setStatus('idle');
      return true;
    })();

    diskDonePromise = promise;
    return promise;
  };

  const scheduleWAL = () => {
    if (walTimer !== null) return;
    walTimer = setTimeout(flushWAL, walThrottleMs);
  };

  const scheduleDisk = () => {
    if (diskTimer !== null) {
      clearTimeout(diskTimer);
    }
    diskTimer = setTimeout(() => {
      diskTimer = null;
      executeDiskWrite();
    }, diskDebounceMs);
  };

  const onDomainStateChanged = (state: DomainState) => {
    if (detached || paused) return;
    latestState = state;
    dirty = true;
    setStatus('dirty');
    scheduleWAL();
    if (diskInFlight) {
      diskPending = true;
      if (diskTimer !== null) {
        clearTimeout(diskTimer);
        diskTimer = null;
      }
      return;
    }
    scheduleDisk();
  };

  const removeBridge = setDomainPersistenceBridge(onDomainStateChanged);

  const onBeforeUnload = () => {
    if (!dirty || !latestState) return;
    const data = serializeDomainState(latestState);
    if (hasInvalidStorageContract(data)) {
      setStatus('error');
      return;
    }
    writeWAL(data);
    writeDisk(data);
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden' && dirty) {
      flushPersistNow();
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  const flushPersistNow = async (): Promise<boolean> => {
    if (detached) return false;

    if (walTimer !== null) {
      clearTimeout(walTimer);
      walTimer = null;
    }
    if (diskTimer !== null) {
      clearTimeout(diskTimer);
      diskTimer = null;
    }

    if (!dirty || !latestState) return true;

    setStatus('writing-wal');
    const data = serializeDomainState(latestState);
    if (hasInvalidStorageContract(data)) {
      setStatus('error');
      return false;
    }
    const walSuccess = await writeWAL(data);
    if (!walSuccess) {
      setStatus('error');
      return false;
    }

    const diskSuccess = await executeDiskWrite();
    return diskSuccess;
  };

  const detach = () => {
    if (detached) return;
    detached = true;

    removeBridge();

    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }

    if (walTimer !== null) {
      clearTimeout(walTimer);
      walTimer = null;
    }
    if (diskTimer !== null) {
      clearTimeout(diskTimer);
      diskTimer = null;
    }
  };

  const pause = () => {
    if (detached || paused) return;
    paused = true;

    if (walTimer !== null) {
      clearTimeout(walTimer);
      walTimer = null;
    }
    if (diskTimer !== null) {
      clearTimeout(diskTimer);
      diskTimer = null;
    }
  };

  const resume = () => {
    if (detached || !paused) return;
    paused = false;
  };

  const isPaused = (): boolean => paused;

  return { detach, flushPersistNow, getStatus: () => status, pause, resume, isPaused };
}
