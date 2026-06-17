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

/** 断崖检测：基线便签数 < 此值时跳过检测 */
const CLIFF_DROP_MIN_BASELINE_NOTES = 3;

/** 断崖检测：小样本（≤5）使用绝对阈值 */
const CLIFF_DROP_ABSOLUTE_THRESHOLD = 0.5;

/** 断崖检测：常规样本使用相对阈值 */
const CLIFF_DROP_RELATIVE_THRESHOLD = 0.3;

/** 小样本分界线 */
const SMALL_SAMPLE_SIZE = 5;

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
  | 'CLIFF_DROP_ABSOLUTE';

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
 * 3. 过滤掉 protectedFileNames 中的文件
 * 4. 剩余数 ≤ retentionCount → 无需删除
 * 5. 剩余数 > retentionCount → 删除最旧的 (N - retentionCount) 个
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

  // 4. 过滤掉受保护文件
  const unprotected = parsedNames.filter(
    (p) => !protectedFileNames.has(p.fileName),
  );

  // 5. 计算候选和保留
  let candidates: readonly RemoteBackupParsedName[];
  let keep: readonly RemoteBackupParsedName[];

  if (unprotected.length <= retentionCount) {
    // 无需删除
    candidates = [];
    keep = parsedNames; // 保留所有已解析文件
  } else {
    // 删除最旧的 (N - retentionCount) 个
    const deleteCount = unprotected.length - retentionCount;
    const deleteSet = new Set(
      unprotected.slice(0, deleteCount).map((p) => p.fileName),
    );
    candidates = parsedNames.filter((p) => deleteSet.has(p.fileName));
    keep = parsedNames.filter((p) => !deleteSet.has(p.fileName));
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
 * 断崖式骤降检测：比较最新备份摘要与健康基线。
 *
 * 规则：
 * - baselineNotes < CLIFF_DROP_MIN_BASELINE_NOTES → 跳过检测，返回 null
 * - baselineNotes ≤ SMALL_SAMPLE_SIZE → 使用绝对阈值 (dropPct ≥ 0.5)
 * - baselineNotes > SMALL_SAMPLE_SIZE → 使用相对阈值 (dropPct ≥ 0.3)
 *
 * @returns 触发异常时返回比较结果，否则返回 null
 */
export function detectBackupCliffDrop(input: {
  readonly latestSummary: BackupSummary;
  readonly baselineSummary: BackupSummary;
}): BackupSummaryComparison | null {
  const { latestSummary, baselineSummary } = input;

  const baselineNotes = baselineSummary.noteCount;
  const currentNotes = latestSummary.noteCount;

  // 基线不足时跳过检测
  if (baselineNotes < CLIFF_DROP_MIN_BASELINE_NOTES) {
    return null;
  }

  const dropPct = (baselineNotes - currentNotes) / baselineNotes;

  // 根据样本大小选择阈值
  const useAbsoluteThreshold = baselineNotes <= SMALL_SAMPLE_SIZE;
  const threshold = useAbsoluteThreshold
    ? CLIFF_DROP_ABSOLUTE_THRESHOLD
    : CLIFF_DROP_RELATIVE_THRESHOLD;

  if (dropPct < threshold) {
    return null;
  }

  const anomalyCodes: RemoteRetentionAnomalyCode[] = useAbsoluteThreshold
    ? ['CLIFF_DROP_ABSOLUTE']
    : ['CLIFF_DROP_RELATIVE'];

  return {
    baselineNotes,
    currentNotes,
    dropPct,
    threshold,
    anomalyCodes,
  };
}
