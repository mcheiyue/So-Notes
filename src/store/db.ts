import { get, set, del } from 'idb-keyval';
import { StorageData } from './types';

const DB_KEY = 'sonotes_wal';

export const db = {
  // Save entire state to IndexedDB (WAL)
  saveWAL: async (data: StorageData) => {
    try {
      await set(DB_KEY, data);
    } catch (e) {
      console.error('WAL Save Error:', e);
    }
  },

  // Load WAL on startup
  loadWAL: async (): Promise<StorageData | undefined> => {
    try {
      return await get<StorageData>(DB_KEY);
    } catch (e) {
      console.error('WAL Load Error:', e);
      return undefined;
    }
  },

  // Clear WAL (after successful disk flush)
  clearWAL: async () => {
    try {
      await del(DB_KEY);
    } catch (e) {
      console.error('WAL Clear Error:', e);
    }
  }
};
