import type { StorageData } from '../../store/types';
import type { DomainState } from '../../store/domainStore';

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
  /** 双源均未产出可用数据并回退到内置 NEW 默认领域时为 true */
  readonly recovered: boolean;
}

/**
 * 持久化引擎运行状态。
 * - idle: 无待写数据
 * - dirty: 已标记脏数据，等待调度写入
 * - writing-wal: 正在写入 WAL
 * - writing-disk: 正在写入磁盘
 * - error: 最近一次写入失败
 */
export type PersistenceStatus = 'idle' | 'dirty' | 'writing-wal' | 'writing-disk' | 'error';

/**
 * attach() 的可选配置。
 * 所有时间参数单位为毫秒；writer 注入用于测试。
 */
export interface AttachOptions {
  readonly initialState?: DomainState;
  /** WAL 写入节流间隔（毫秒），默认 100 */
  readonly walThrottleMs?: number;
  /** 磁盘写入防抖间隔（毫秒），默认 2000 */
  readonly diskDebounceMs?: number;
  /** 自定义 WAL 写入器，默认 db.saveWAL */
  readonly writeWAL?: (data: StorageData) => Promise<boolean>;
  /** 自定义磁盘写入器，默认 Tauri invoke save_content */
  readonly writeDisk?: (data: StorageData) => Promise<boolean>;
  /** 持久化状态变更回调，用于桥接 UI 状态指示器 */
  readonly onStatusChange?: (status: PersistenceStatus) => void;
}

/**
 * 持久化暂停状态。
 * - active: 正常运行，领域变更会触发持久化
 * - paused: 暂停中，挂起的写入被取消，新的领域变更不触发持久化
 */
export type PersistPauseState = 'active' | 'paused';

/**
 * attach() 返回的控制句柄。
 */
export interface AttachResult {
  /** 取消所有注册、清空定时器并断开 bridge 连接 */
  readonly detach: () => void;
  /** 立即强制 WAL + 磁盘持久化（取消定时器、合并 in-flight），返回是否全部成功 */
  readonly flushPersistNow: () => Promise<boolean>;
  /** 查询当前持久化状态 */
  readonly getStatus: () => PersistenceStatus;
  /**
   * 暂停持久化：取消挂起的 WAL/磁盘写入定时器，
   * 后续领域变更不再调度写入，直到调用 resume()。
   */
  readonly pause: () => void;
  /**
   * 恢复持久化：允许后续领域变更重新触发写入调度。
   * 不会自动 flush；调用方应在恢复前确保已通过 flushPersistNow() 保存最新状态。
   */
  readonly resume: () => void;
  /** 查询当前暂停状态 */
  readonly isPaused: () => boolean;
}
