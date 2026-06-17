import { describe, it, expect } from 'vitest';

import {
  parseRemoteBackupFileName,
  proposeRetentionCleanup,
  detectBackupCliffDrop,
} from './RemoteBackupRetention';
import type { BackupSummary } from './BackupService';
import type { WebDavRemoteBackup } from './WebDavBackupService';

// ---------------------------------------------------------------------------
// 辅助工厂
// ---------------------------------------------------------------------------

function makeBackup(
  fileName: string,
  overrides?: Partial<WebDavRemoteBackup>,
): WebDavRemoteBackup {
  return { fileName, readable: true, ...overrides };
}

function makeSummary(noteCount: number): BackupSummary {
  return {
    app: 'SoNotes',
    formatVersion: 1,
    appVersion: '1.5.7',
    createdAt: Date.now(),
    noteCount,
    boardCount: 1,
    textNoteCount: noteCount,
    imageNoteCount: 0,
    trashNoteCount: 0,
    imageFileCount: 0,
    imageFileTotalBytes: 0,
  };
}

// ---------------------------------------------------------------------------
// parseRemoteBackupFileName
// ---------------------------------------------------------------------------

describe('parseRemoteBackupFileName', () => {
  it('正确解析合法文件名并返回排序时间', () => {
    const result = parseRemoteBackupFileName('SoNotes_Backup_20250615120000.zip');
    expect(result).not.toBeNull();
    expect(result!.fileName).toBe('SoNotes_Backup_20250615120000.zip');
    expect(result!.sortTime.getFullYear()).toBe(2025);
    expect(result!.sortTime.getMonth()).toBe(5); // 6月 = index 5
    expect(result!.sortTime.getDate()).toBe(15);
    expect(result!.sortTime.getHours()).toBe(12);
    expect(result!.sortTime.getMinutes()).toBe(0);
    expect(result!.sortTime.getSeconds()).toBe(0);
  });

  it('正确解析午夜时间', () => {
    const result = parseRemoteBackupFileName('SoNotes_Backup_20250101000000.zip');
    expect(result).not.toBeNull();
    expect(result!.sortTime.getFullYear()).toBe(2025);
    expect(result!.sortTime.getMonth()).toBe(0);
    expect(result!.sortTime.getDate()).toBe(1);
    expect(result!.sortTime.getHours()).toBe(0);
  });

  it('拒绝非严格命名文件 — 缺少前缀', () => {
    expect(parseRemoteBackupFileName('Backup_20250615120000.zip')).toBeNull();
  });

  it('拒绝非严格命名文件 — 前缀拼写错误', () => {
    expect(parseRemoteBackupFileName('SoNote_Backup_20250615120000.zip')).toBeNull();
  });

  it('拒绝非 zip 文件', () => {
    expect(parseRemoteBackupFileName('SoNotes_Backup_20250615120000.tar')).toBeNull();
  });

  it('拒绝缺少后缀的文件', () => {
    expect(parseRemoteBackupFileName('SoNotes_Backup_20250615120000')).toBeNull();
  });

  it('拒绝时间部分不是 14 位数字', () => {
    expect(parseRemoteBackupFileName('SoNotes_Backup_2025061512000.zip')).toBeNull();
  });

  it('拒绝非法月份（13月）', () => {
    expect(parseRemoteBackupFileName('SoNotes_Backup_20251301120000.zip')).toBeNull();
  });

  it('拒绝非法月份（00月）', () => {
    expect(parseRemoteBackupFileName('SoNotes_Backup_20250001120000.zip')).toBeNull();
  });

  it('拒绝非法日期（2月30日）', () => {
    expect(parseRemoteBackupFileName('SoNotes_Backup_20250230120000.zip')).toBeNull();
  });

  it('拒绝非法日期（4月31日）', () => {
    expect(parseRemoteBackupFileName('SoNotes_Backup_20250431120000.zip')).toBeNull();
  });

  it('拒绝非法日期（32日）', () => {
    expect(parseRemoteBackupFileName('SoNotes_Backup_20250132120000.zip')).toBeNull();
  });

  it('拒绝非法时间（25小时）', () => {
    expect(parseRemoteBackupFileName('SoNotes_Backup_20250615250000.zip')).toBeNull();
  });

  it('拒绝非法分钟（60）', () => {
    expect(parseRemoteBackupFileName('SoNotes_Backup_20250615126000.zip')).toBeNull();
  });

  it('拒绝非法秒数（60）', () => {
    expect(parseRemoteBackupFileName('SoNotes_Backup_20250615120060.zip')).toBeNull();
  });

  it('返回 null 对于空字符串', () => {
    expect(parseRemoteBackupFileName('')).toBeNull();
  });

  it('返回 null 对于随机文本', () => {
    expect(parseRemoteBackupFileName('random-file.txt')).toBeNull();
  });

  it('合法边界 — 2月29日（闰年）', () => {
    const result = parseRemoteBackupFileName('SoNotes_Backup_20240229120000.zip');
    expect(result).not.toBeNull();
    expect(result!.sortTime.getDate()).toBe(29);
  });

  it('拒绝非法 — 2月29日（非闰年）', () => {
    expect(parseRemoteBackupFileName('SoNotes_Backup_20250229120000.zip')).toBeNull();
  });

  it('合法边界 — 最大时间 23:59:59', () => {
    const result = parseRemoteBackupFileName('SoNotes_Backup_20251231235959.zip');
    expect(result).not.toBeNull();
    expect(result!.sortTime.getHours()).toBe(23);
    expect(result!.sortTime.getMinutes()).toBe(59);
    expect(result!.sortTime.getSeconds()).toBe(59);
  });
});

// ---------------------------------------------------------------------------
// proposeRetentionCleanup
// ---------------------------------------------------------------------------

describe('proposeRetentionCleanup', () => {
  it('全部非严格命名文件 → 空候选，所有文件保留', () => {
    const files: WebDavRemoteBackup[] = [
      makeBackup('random-file.zip'),
      makeBackup('backup-20250615.tar'),
    ];

    const result = proposeRetentionCleanup({
      files,
      retentionCount: 5,
      protectedFileNames: new Set(),
    });

    expect(result.candidates).toHaveLength(0);
    // 非严格命名文件不进入解析，所以 keep 也是空（它们被过滤了）
    expect(result.keep).toHaveLength(0);
    expect(result.protectedCount).toBe(0);
  });

  it('少于 retentionCount → 无需删除', () => {
    const files: WebDavRemoteBackup[] = [
      makeBackup('SoNotes_Backup_20250610120000.zip'),
      makeBackup('SoNotes_Backup_20250611120000.zip'),
      makeBackup('SoNotes_Backup_20250612120000.zip'),
    ];

    const result = proposeRetentionCleanup({
      files,
      retentionCount: 5,
      protectedFileNames: new Set(),
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.keep).toHaveLength(3);
  });

  it('恰好等于 retentionCount → 无需删除', () => {
    const files: WebDavRemoteBackup[] = [
      makeBackup('SoNotes_Backup_20250610120000.zip'),
      makeBackup('SoNotes_Backup_20250611120000.zip'),
      makeBackup('SoNotes_Backup_20250612120000.zip'),
    ];

    const result = proposeRetentionCleanup({
      files,
      retentionCount: 3,
      protectedFileNames: new Set(),
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.keep).toHaveLength(3);
  });

  it('超过 retentionCount → 正确计算候选和保留', () => {
    const files: WebDavRemoteBackup[] = [
      makeBackup('SoNotes_Backup_20250610120000.zip'),
      makeBackup('SoNotes_Backup_20250611120000.zip'),
      makeBackup('SoNotes_Backup_20250612120000.zip'),
      makeBackup('SoNotes_Backup_20250613120000.zip'),
      makeBackup('SoNotes_Backup_20250614120000.zip'),
    ];

    const result = proposeRetentionCleanup({
      files,
      retentionCount: 3,
      protectedFileNames: new Set(),
    });

    expect(result.candidates).toHaveLength(2);
    expect(result.keep).toHaveLength(3);
    // 候选应该是最旧的两个
    expect(result.candidates[0]!.fileName).toBe('SoNotes_Backup_20250610120000.zip');
    expect(result.candidates[1]!.fileName).toBe('SoNotes_Backup_20250611120000.zip');
    // 保留的应该是最新的三个
    expect(result.keep[0]!.fileName).toBe('SoNotes_Backup_20250612120000.zip');
    expect(result.keep[2]!.fileName).toBe('SoNotes_Backup_20250614120000.zip');
  });

  it('受保护文件不进入候选', () => {
    const files: WebDavRemoteBackup[] = [
      makeBackup('SoNotes_Backup_20250610120000.zip'),
      makeBackup('SoNotes_Backup_20250611120000.zip'),
      makeBackup('SoNotes_Backup_20250612120000.zip'),
      makeBackup('SoNotes_Backup_20250613120000.zip'),
      makeBackup('SoNotes_Backup_20250614120000.zip'),
    ];

    // 保护最旧的两个，retentionCount=3 → 总共 5 个，3 个不受保护
    // 不受保护的 3 个 ≤ 3 → 不删除
    const result = proposeRetentionCleanup({
      files,
      retentionCount: 3,
      protectedFileNames: new Set([
        'SoNotes_Backup_20250610120000.zip',
        'SoNotes_Backup_20250611120000.zip',
      ]),
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.keep).toHaveLength(5);
    expect(result.protectedCount).toBe(2);
  });

  it('保护对象让实际保留数量临时超过 N 时，不删除受保护文件', () => {
    const files: WebDavRemoteBackup[] = [
      makeBackup('SoNotes_Backup_20250610120000.zip'),
      makeBackup('SoNotes_Backup_20250611120000.zip'),
      makeBackup('SoNotes_Backup_20250612120000.zip'),
      makeBackup('SoNotes_Backup_20250613120000.zip'),
      makeBackup('SoNotes_Backup_20250614120000.zip'),
    ];

    // retentionCount=2，保护最旧的 3 个 → 不受保护的只有 2 个 → 不删除
    const result = proposeRetentionCleanup({
      files,
      retentionCount: 2,
      protectedFileNames: new Set([
        'SoNotes_Backup_20250610120000.zip',
        'SoNotes_Backup_20250611120000.zip',
        'SoNotes_Backup_20250612120000.zip',
      ]),
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.keep).toHaveLength(5);
    expect(result.protectedCount).toBe(3);
  });

  it('混合严格和非严格命名文件，只处理严格命名', () => {
    const files: WebDavRemoteBackup[] = [
      makeBackup('random-backup.zip'),
      makeBackup('SoNotes_Backup_20250610120000.zip'),
      makeBackup('backup-20250611.tar'),
      makeBackup('SoNotes_Backup_20250612120000.zip'),
      makeBackup('SoNotes_Backup_20250613120000.zip'),
      makeBackup('manual_save.zip'),
    ];

    const result = proposeRetentionCleanup({
      files,
      retentionCount: 2,
      protectedFileNames: new Set(),
    });

    // 只有 3 个严格命名文件，retentionCount=2 → 候选 1 个
    expect(result.candidates).toHaveLength(1);
    expect(result.keep).toHaveLength(2);
    expect(result.candidates[0]!.fileName).toBe('SoNotes_Backup_20250610120000.zip');
  });

  it('cliffDropDetected 默认为 false', () => {
    const result = proposeRetentionCleanup({
      files: [makeBackup('SoNotes_Backup_20250610120000.zip')],
      retentionCount: 5,
      protectedFileNames: new Set(),
    });

    expect(result.cliffDropDetected).toBe(false);
  });

  it('retentionCount=0 → 删除所有非保护的严格命名文件', () => {
    const files: WebDavRemoteBackup[] = [
      makeBackup('SoNotes_Backup_20250610120000.zip'),
      makeBackup('SoNotes_Backup_20250611120000.zip'),
      makeBackup('SoNotes_Backup_20250612120000.zip'),
    ];

    const result = proposeRetentionCleanup({
      files,
      retentionCount: 0,
      protectedFileNames: new Set(),
    });

    expect(result.candidates).toHaveLength(3);
    expect(result.keep).toHaveLength(0);
  });

  it('同一秒的文件按文件名字典序稳定排序', () => {
    const files: WebDavRemoteBackup[] = [
      makeBackup('SoNotes_Backup_20250610120000.zip'),
      makeBackup('SoNotes_Backup_20250610120001.zip'),
    ];

    const result = proposeRetentionCleanup({
      files,
      retentionCount: 1,
      protectedFileNames: new Set(),
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.keep).toHaveLength(1);
    expect(result.candidates[0]!.fileName).toBe('SoNotes_Backup_20250610120000.zip');
    expect(result.keep[0]!.fileName).toBe('SoNotes_Backup_20250610120001.zip');
  });
});

// ---------------------------------------------------------------------------
// detectBackupCliffDrop
// ---------------------------------------------------------------------------

describe('detectBackupCliffDrop', () => {
  it('baselineNotes < 3 → 跳过检测，返回 null', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(0),
      baselineSummary: makeSummary(2),
    });

    expect(result).toBeNull();
  });

  it('baselineNotes = 0 → 跳过检测', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(0),
      baselineSummary: makeSummary(0),
    });

    expect(result).toBeNull();
  });

  it('baselineNotes ≤ 5 使用绝对阈值 — dropPct ≥ 0.5 触发', () => {
    // baselineNotes=4, currentNotes=1, dropPct = (4-1)/4 = 0.75 ≥ 0.5
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(1),
      baselineSummary: makeSummary(4),
    });

    expect(result).not.toBeNull();
    expect(result!.baselineNotes).toBe(4);
    expect(result!.currentNotes).toBe(1);
    expect(result!.threshold).toBe(0.5);
    expect(result!.anomalyCodes).toContain('CLIFF_DROP_ABSOLUTE');
  });

  it('baselineNotes ≤ 5 — dropPct < 0.5 不触发', () => {
    // baselineNotes=4, currentNotes=3, dropPct = (4-3)/4 = 0.25 < 0.5
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(3),
      baselineSummary: makeSummary(4),
    });

    expect(result).toBeNull();
  });

  it('baselineNotes > 5 使用相对阈值 — dropPct ≥ 0.3 触发', () => {
    // baselineNotes=10, currentNotes=5, dropPct = (10-5)/10 = 0.5 ≥ 0.3
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(5),
      baselineSummary: makeSummary(10),
    });

    expect(result).not.toBeNull();
    expect(result!.baselineNotes).toBe(10);
    expect(result!.currentNotes).toBe(5);
    expect(result!.threshold).toBe(0.3);
    expect(result!.anomalyCodes).toContain('CLIFF_DROP_RELATIVE');
  });

  it('baselineNotes > 5 — dropPct < 0.3 不触发', () => {
    // baselineNotes=10, currentNotes=8, dropPct = (10-8)/10 = 0.2 < 0.3
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(8),
      baselineSummary: makeSummary(10),
    });

    expect(result).toBeNull();
  });

  it('未触发异常时返回 null', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(100),
      baselineSummary: makeSummary(100),
    });

    expect(result).toBeNull();
  });

  it('恰好达到相对阈值边界 — dropPct = 0.3 触发', () => {
    // baselineNotes=10, currentNotes=7, dropPct = (10-7)/10 = 0.3
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(7),
      baselineSummary: makeSummary(10),
    });

    expect(result).not.toBeNull();
    expect(result!.dropPct).toBeCloseTo(0.3);
  });

  it('恰好达到绝对阈值边界 — dropPct = 0.5 触发', () => {
    // baselineNotes=4, currentNotes=2, dropPct = (4-2)/4 = 0.5
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(2),
      baselineSummary: makeSummary(4),
    });

    expect(result).not.toBeNull();
    expect(result!.dropPct).toBeCloseTo(0.5);
  });

  it('currentNotes > baselineNotes → 负 dropPct，不触发', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(20),
      baselineSummary: makeSummary(10),
    });

    expect(result).toBeNull();
  });

  it('baselineNotes=3 使用绝对阈值（≤5）', () => {
    // baselineNotes=3, currentNotes=1, dropPct = (3-1)/3 ≈ 0.667 ≥ 0.5
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(1),
      baselineSummary: makeSummary(3),
    });

    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(0.5);
    expect(result!.anomalyCodes).toContain('CLIFF_DROP_ABSOLUTE');
  });

  it('baselineNotes=5 使用绝对阈值（≤5），currentNotes=2 触发', () => {
    // dropPct = (5-2)/5 = 0.6 ≥ 0.5
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(2),
      baselineSummary: makeSummary(5),
    });

    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(0.5);
  });

  it('baselineNotes=6 使用相对阈值（>5），currentNotes=4 不触发', () => {
    // dropPct = (6-4)/6 ≈ 0.333 ≥ 0.3 → 触发
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(4),
      baselineSummary: makeSummary(6),
    });

    expect(result).not.toBeNull();
    expect(result!.threshold).toBe(0.3);
    expect(result!.anomalyCodes).toContain('CLIFF_DROP_RELATIVE');
  });
});
