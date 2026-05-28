import { invoke } from '@tauri-apps/api/core';
import type { StorageData, StorageDataInput } from '../../store/types';
import { STORAGE_SCHEMA_VERSION } from '../../store/types';

const isFiniteTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const getLegacyStorageUpdatedAt = (notes: StorageDataInput['notes']): number => {
  if (notes.length === 0) return 0;
  return Math.max(...notes.map((note) => note.updatedAt || 0));
};

export const normalizeStorageDataMetadata = (data: StorageDataInput): StorageData => ({
  ...data,
  schemaVersion: isFiniteTimestamp(data.schemaVersion) ? data.schemaVersion : STORAGE_SCHEMA_VERSION,
  storageUpdatedAt: isFiniteTimestamp(data.storageUpdatedAt)
    ? data.storageUpdatedAt
    : getLegacyStorageUpdatedAt(data.notes),
});

export const getLatestUpdateTimestamp = (data: StorageData | undefined | null): number => {
  if (!data) return 0;
  return isFiniteTimestamp(data.storageUpdatedAt)
    ? data.storageUpdatedAt
    : getLegacyStorageUpdatedAt(data.notes);
};

export async function readDiskStorageData(filename: string): Promise<StorageData | null> {
  try {
    const diskJson = await invoke<string>('load_content', { filename });
    if (!diskJson) return null;

    const parsed: unknown = JSON.parse(diskJson);
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).notes)) {
      return normalizeStorageDataMetadata(parsed as StorageDataInput);
    }

    return null;
  } catch {
    return null;
  }
}
