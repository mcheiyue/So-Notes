import type { StorageData } from '../../store/types';

/**
 * 数据来源标记。
 * - WAL: 从 IndexedDB 读取（浏览器 WAL 缓存）
 * - DISK: 从 Tauri 磁盘 JSON 读取
 * - NEW: 双源均无数据，使用内置默认值
 */
export type StorageDataSource = 'WAL' | 'DISK' | 'NEW';

/**
 * bootstrap 完成后应由调用方执行的同步动作描述。
 * 服务层只描述意图，不直接执行运行时副作用。
 */
export type SyncAction =
  | { type: 'SYNC_DISK_TO_WAL'; data: StorageData }
  | { type: 'SYNC_WAL_TO_DISK' }
  | { type: 'NONE' };

/**
 * StorageService.bootstrap() 的返回结构。
 */
export interface BootstrapResult {
  readonly source: StorageDataSource;
  readonly data: StorageData;
  readonly syncAction: SyncAction;
  readonly walTime: number;
  readonly diskTime: number;
  /** true when both WAL and disk failed to produce usable data and bootstrap fell back to the built-in NEW default domain */
  readonly recovered: boolean;
}
