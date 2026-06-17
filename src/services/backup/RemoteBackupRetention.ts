// ---------------------------------------------------------------------------
// 保留策略引擎纯函数模块
//
// 职责：严格文件名解析、候选排序、预览结果和异常判断。
// 约束：不发网络请求，不调用 Tauri invoke，纯数据计算。
// ---------------------------------------------------------------------------

import type { WebDavRemoteBackup } from './WebDavBackupService';
import type { BackupSummary } from './BackupService';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 严格文件名正则：SoNotes_Backup_YYYYMMDDHHMMSS.zip */
const BACKUP_FILE_NAME_RE = /^SoNotes_Backup_(\d{14})\.zip$/;

/** 断崖检测：基线 < 此值时跳过 note 维度检测（但仍检查 board 维度） */
const CLIFF_DROP_MEDIUM_BASELINE_MIN = 5;

/** 断崖检测：基线 ≥ 此值时使用 30% 相对阈值（note 维度） */
const CLIFF_DROP_LARGE_BASELINE_MIN = 10;

/** 断崖检测：中等基线（5-9）时 noteCount 降至 ≤ 此值才触发 */
const CLIFF_DROP_MEDIUM_CRITICAL_COUNT = 1;

/** 断崖检测：常规样本使用相对阈值 */
const CLIFF_DROP_RELATIVE_THRESHOLD = 0.3;

/** 断崖检测：board 维度基线 ≥ 此值时使用 50% 相对阈值 */
const CLIFF_DROP_BOARD_MEDIUM_BASELINE_MIN = 3;

/** 断崖检测：board 维度基线 ≥ 此值且当前为 0 时触发 */
const CLIFF_DROP_BOARD_ZERO_TRIGGER_MIN = 2;

/** 断崖检测：图片维度（文件数/笔记数）基线 ≥ 此值时使用 30% 相对阈值 */
const CLIFF_DROP_IMAGE_MEDIUM_BASELINE_MIN = 5;

/** 断崖检测：zip 体积基线 ≥ 此值时才参与判断（1 MiB） */
const CLIFF_DROP_ZIP_MIN_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface RemoteBackupParsedName {
  readonly fileName: string;
  /** 从文件名解析出的排序时间 */
  readonly sortTime: Date;
}

export interface RetentionPreview {
  /** 将被删除的候选文件（已排除受保护文件） */
  readonly candidates: readonly RemoteBackupParsedName[];
  /** 将被保留的文件 */
  readonly keep: readonly RemoteBackupParsedName[];
  /** 实际受保护的文件数量（在远端文件列表中确实存在的 protectedFileNames 数量） */
  readonly protectedCount: number;
  /** 是否检测到断崖式骤降（由调用方另行传入摘要时判断，此处仅作为占位） */
  readonly cliffDropDetected: boolean;
}

export type RemoteRetentionAnomalyCode =
  | 'CLIFF_DROP_RELATIVE'
  | 'CLIFF_DROP_MEDIUM_SAMPLE_CRITICAL'
  | 'CLIFF_DROP_BOARD_COUNT'
  | 'CLIFF_DROP_IMAGE_NOTE_COUNT'
  | 'CLIFF_DROP_IMAGE_FILE_COUNT'
  | 'CLIFF_DROP_ZIP_SIZE_BYTES';

export interface RemoteRetentionAnomaly {
  readonly code: RemoteRetentionAnomalyCode;
  readonly message: string;
}

export interface BackupSummaryComparison {
  readonly baselineNotes: number;
  readonly currentNotes: number;
  readonly dropPct: number;
  readonly threshold: number;
  readonly anomalyCodes: readonly RemoteRetentionAnomalyCode[];
}

// ---------------------------------------------------------------------------
// parseRemoteBackupFileName
// ---------------------------------------------------------------------------

/**
 * 从严格命名的远端备份文件名中解析排序时间。
 *
 * 要求格式：`SoNotes_Backup_YYYYMMDDHHMMSS.zip`
 * - 前缀：`SoNotes_Backup_`
 * - 时间：14 位数字（YYYYMMDDHHMMSS）
 * - 后缀：`.zip`
 *
 * 验证月份 1-12、日期 1-31、小时 0-23、分钟 0-59、秒 0-59。
 * 匹配失败或日期无效时返回 null。
 */
export function parseRemoteBackupFileName(
  fileName: string,
): RemoteBackupParsedName | null {
  const match = BACKUP_FILE_NAME_RE.exec(fileName);
  if (!match) return null;

  const ts = match[1];
  const year = Number(ts.slice(0, 4));
  const month = Number(ts.slice(4, 6));
  const day = Number(ts.slice(6, 8));
  const hour = Number(ts.slice(8, 10));
  const minute = Number(ts.slice(10, 12));
  const second = Number(ts.slice(12, 14));

  // 基本范围校验
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 23) return null;
  if (minute > 59) return null;
  if (second > 59) return null;

  // 使用 Date 构造函数验证日期合法性（如 2 月 30 日）
  const sortTime = new Date(year, month - 1, day, hour, minute, second);

  // 防止 JS Date 自动溢出修正（如 2 月 30 日 → 3 月 2 日）
  if (
    sortTime.getFullYear() !== year ||
    sortTime.getMonth() !== month - 1 ||
    sortTime.getDate() !== day ||
    sortTime.getHours() !== hour ||
    sortTime.getMinutes() !== minute ||
    sortTime.getSeconds() !== second
  ) {
    return null;
  }

  return { fileName, sortTime };
}

// ---------------------------------------------------------------------------
// proposeRetentionCleanup
// ---------------------------------------------------------------------------

/**
 * 预览清理方案：纯计算，不发送任何网络请求。
 *
 * 逻辑：
 * 1. 过滤出严格命名文件并解析
 * 2. 按 sortTime 升序排列（最早 = 最旧在前）
 * 3. 取最近 N 个作为初始 keep（排序后的后 N 个）
 * 4. 把保护对象并入 keep set（保护对象不参与 N 的计数）
 * 5. 剩余的作为 candidates（将被删除）
 */
export function proposeRetentionCleanup(input: {
  readonly files: readonly WebDavRemoteBackup[];
  readonly retentionCount: number;
  readonly protectedFileNames: ReadonlySet<string>;
}): RetentionPreview {
  const { files, retentionCount, protectedFileNames } = input;

  // 1. 过滤并解析严格命名文件
  const parsedNames: RemoteBackupParsedName[] = [];
  for (const file of files) {
    const parsed = parseRemoteBackupFileName(file.fileName);
    if (parsed) {
      parsedNames.push(parsed);
    }
  }

  // 2. 按 sortTime 升序排列（最早在前 = 最旧在前）
  parsedNames.sort((a, b) => {
    const diff = a.sortTime.getTime() - b.sortTime.getTime();
    if (diff !== 0) return diff;
    // 同一秒兜底：按文件名字典序稳定排序
    return a.fileName.localeCompare(b.fileName);
  });

  // 3. 计算受保护文件数（在远端文件列表中确实存在的 protectedFileNames）
  let protectedCount = 0;
  for (const name of protectedFileNames) {
    if (files.some((f) => f.fileName === name)) {
      protectedCount++;
    }
  }

  // 4. 取最近 N 个作为初始 keep（升序排列后的后 N 个）
  const initialKeepCount = Math.min(retentionCount, parsedNames.length);
  const initialKeep = parsedNames.slice(parsedNames.length - initialKeepCount);
  const initialKeepSet = new Set(initialKeep.map((p) => p.fileName));

  // 5. 把保护对象并入 keep set
  for (const name of protectedFileNames) {
    initialKeepSet.add(name);
  }

  // 6. 剩余的作为 candidates
  const candidates: RemoteBackupParsedName[] = [];
  const keep: RemoteBackupParsedName[] = [];

  for (const p of parsedNames) {
    if (initialKeepSet.has(p.fileName)) {
      keep.push(p);
    } else {
      candidates.push(p);
    }
  }

  return {
    candidates,
    keep,
    protectedCount,
    cliffDropDetected: false,
  };
}

// ---------------------------------------------------------------------------
// detectBackupCliffDrop
// ---------------------------------------------------------------------------

/**
 * 断崖式骤降检测：比较最新备份摘要与健康基线（多维度）。
 *
 * plan 3.3 规则：
 * - note 维度：baselineNotes < 5 跳过 note 检测；5-9 降至 ≤ 1 触发；≥ 10 用 30% 阈值。
 * - board 维度：baselineBoard ≥ 3 用 50% 阈值；≥ 2 且当前为 0 也触发。
 * - image 维度：基线 ≥ 5 用 30% 阈值。
 * - zip 维度：仅当两次都有 zipSizeBytes 且基线 ≥ 1 MiB 时参与，不可单独触发。
 *
 * @returns 触发异常时返回比较结果，否则返回 null
 */
export function detectBackupCliffDrop(input: {
  readonly latestSummary: BackupSummary;
  readonly baselineSummary: BackupSummary;
  readonly latestZipSizeBytes?: number | null;
  readonly baselineZipSizeBytes?: number | null;
}): BackupSummaryComparison | null {
  const { latestSummary, baselineSummary } = input;

  const baselineNotes = baselineSummary.noteCount;
  const currentNotes = latestSummary.noteCount;

  const anomalyCodes: RemoteRetentionAnomalyCode[] = [];

  // ---- note 维度 ----
  if (baselineNotes >= CLIFF_DROP_LARGE_BASELINE_MIN) {
    const dropPct = baselineNotes > 0
      ? (baselineNotes - currentNotes) / baselineNotes
      : 0;
    if (dropPct >= CLIFF_DROP_RELATIVE_THRESHOLD) {
      anomalyCodes.push('CLIFF_DROP_RELATIVE');
    }
  } else if (baselineNotes >= CLIFF_DROP_MEDIUM_BASELINE_MIN) {
    if (currentNotes <= CLIFF_DROP_MEDIUM_CRITICAL_COUNT) {
      anomalyCodes.push('CLIFF_DROP_MEDIUM_SAMPLE_CRITICAL');
    }
  }
  // baselineNotes < 5 → 跳过 note 维度检测，但继续检查 board 维度

  // ---- board 维度 ----
  const baselineBoard = baselineSummary.boardCount;
  const currentBoard = latestSummary.boardCount;
  // plan 3.3：小样本（note<5）时 board 不独立触发，需同时 note=0
  if (baselineNotes >= CLIFF_DROP_MEDIUM_BASELINE_MIN) {
    if (baselineBoard >= CLIFF_DROP_BOARD_MEDIUM_BASELINE_MIN) {
      if (currentBoard < baselineBoard * 0.5) {
        anomalyCodes.push('CLIFF_DROP_BOARD_COUNT');
      }
    } else if (baselineBoard >= CLIFF_DROP_BOARD_ZERO_TRIGGER_MIN && currentBoard === 0) {
      anomalyCodes.push('CLIFF_DROP_BOARD_COUNT');
    }
  } else if (currentNotes === 0 && baselineBoard >= CLIFF_DROP_BOARD_ZERO_TRIGGER_MIN && currentBoard === 0) {
    // plan 3.3：note<5 时，只在 note=0 且 board 也异常接近空时触发（baselineBoard >= 2）
    anomalyCodes.push('CLIFF_DROP_BOARD_COUNT');
  }

  // ---- image file 维度 ----
  const baselineImageFile = baselineSummary.imageFileCount;
  const currentImageFile = latestSummary.imageFileCount;
  if (baselineImageFile >= CLIFF_DROP_IMAGE_MEDIUM_BASELINE_MIN) {
    const dropPct = baselineImageFile > 0
      ? (baselineImageFile - currentImageFile) / baselineImageFile
      : 0;
    if (dropPct >= CLIFF_DROP_RELATIVE_THRESHOLD) {
      anomalyCodes.push('CLIFF_DROP_IMAGE_FILE_COUNT');
    }
  }

  // ---- image note 维度 ----
  const baselineImageNote = baselineSummary.imageNoteCount;
  const currentImageNote = latestSummary.imageNoteCount;
  if (baselineImageNote >= CLIFF_DROP_IMAGE_MEDIUM_BASELINE_MIN) {
    const dropPct = baselineImageNote > 0
      ? (baselineImageNote - currentImageNote) / baselineImageNote
      : 0;
    if (dropPct >= CLIFF_DROP_RELATIVE_THRESHOLD) {
      anomalyCodes.push('CLIFF_DROP_IMAGE_NOTE_COUNT');
    }
  }

  // ---- zip 维度（不可单独触发，必须伴随其他维度异常） ----
  const hasOtherAnomaly = anomalyCodes.length > 0;
  if (hasOtherAnomaly) {
    const baselineZip = input.baselineZipSizeBytes;
    const latestZip = input.latestZipSizeBytes;
    if (
      baselineZip != null && latestZip != null &&
      baselineZip >= CLIFF_DROP_ZIP_MIN_BYTES
    ) {
      const dropPct = baselineZip > 0
        ? (baselineZip - latestZip) / baselineZip
        : 0;
      if (dropPct >= CLIFF_DROP_RELATIVE_THRESHOLD) {
        anomalyCodes.push('CLIFF_DROP_ZIP_SIZE_BYTES');
      }
    }
  }

  if (anomalyCodes.length === 0) {
    return null;
  }

  const dropPct = baselineNotes > 0
    ? (baselineNotes - currentNotes) / baselineNotes
    : 0;

  return {
    baselineNotes,
    currentNotes,
    dropPct,
    threshold: CLIFF_DROP_RELATIVE_THRESHOLD,
    anomalyCodes,
  };
}
