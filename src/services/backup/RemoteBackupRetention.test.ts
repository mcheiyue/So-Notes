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

function makeSummary(
  noteCount: number,
  overrides?: Partial<BackupSummary>,
): BackupSummary {
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
    ...overrides,
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
    expect(result.oldestCandidateTime).toBeNull();
    expect(result.newestKeepTime).toBeNull();
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
    expect(result.oldestCandidateTime).toBeNull();
    expect(result.newestKeepTime).toEqual(new Date(2025, 5, 12, 12, 0, 0));
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
    expect(result.oldestCandidateTime).toBeNull();
    expect(result.newestKeepTime).toEqual(new Date(2025, 5, 12, 12, 0, 0));
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
    expect(result.oldestCandidateTime).toEqual(new Date(2025, 5, 10, 12, 0, 0));
    expect(result.newestKeepTime).toEqual(new Date(2025, 5, 14, 12, 0, 0));
  });

  it('受保护文件不进入候选', () => {
    const files: WebDavRemoteBackup[] = [
      makeBackup('SoNotes_Backup_20250610120000.zip'),
      makeBackup('SoNotes_Backup_20250611120000.zip'),
      makeBackup('SoNotes_Backup_20250612120000.zip'),
      makeBackup('SoNotes_Backup_20250613120000.zip'),
      makeBackup('SoNotes_Backup_20250614120000.zip'),
    ];

    // retentionCount=3 → 最近 3 个 (12,13,14) 保留
    // 保护最旧的 2 个 → 并入 keep，总共 5 个保留，无候选
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
    expect(result.oldestCandidateTime).toBeNull();
    expect(result.newestKeepTime).toEqual(new Date(2025, 5, 14, 12, 0, 0));
  });

  it('保护对象让实际保留数量临时超过 N 时，不删除受保护文件', () => {
    const files: WebDavRemoteBackup[] = [
      makeBackup('SoNotes_Backup_20250610120000.zip'),
      makeBackup('SoNotes_Backup_20250611120000.zip'),
      makeBackup('SoNotes_Backup_20250612120000.zip'),
      makeBackup('SoNotes_Backup_20250613120000.zip'),
      makeBackup('SoNotes_Backup_20250614120000.zip'),
    ];

    // retentionCount=2 → 最近 2 个 (13,14) 保留
    // 保护最旧的 3 个 → 并入 keep，总共 5 个保留
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
    expect(result.oldestCandidateTime).toBeNull();
    expect(result.newestKeepTime).toEqual(new Date(2025, 5, 14, 12, 0, 0));
  });

  it('保护对象落在最旧 N 个区间时仍被保留', () => {
    const files: WebDavRemoteBackup[] = [
      makeBackup('SoNotes_Backup_20250610120000.zip'),
      makeBackup('SoNotes_Backup_20250611120000.zip'),
      makeBackup('SoNotes_Backup_20250612120000.zip'),
      makeBackup('SoNotes_Backup_20250613120000.zip'),
      makeBackup('SoNotes_Backup_20250614120000.zip'),
    ];

    // retentionCount=3 → 最近 3 个 (12,13,14) 保留，候选 (10,11)
    // 保护 10 → 并入 keep，候选只剩 11
    const result = proposeRetentionCleanup({
      files,
      retentionCount: 3,
      protectedFileNames: new Set([
        'SoNotes_Backup_20250610120000.zip',
      ]),
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.keep).toHaveLength(4);
    expect(result.candidates[0]!.fileName).toBe('SoNotes_Backup_20250611120000.zip');
    expect(result.protectedCount).toBe(1);
    expect(result.oldestCandidateTime).toEqual(new Date(2025, 5, 11, 12, 0, 0));
    expect(result.newestKeepTime).toEqual(new Date(2025, 5, 14, 12, 0, 0));
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
    expect(result.oldestCandidateTime).toEqual(new Date(2025, 5, 10, 12, 0, 0));
    expect(result.newestKeepTime).toEqual(new Date(2025, 5, 13, 12, 0, 0));
  });

  it('cliffDropDetected 默认为 false', () => {
    const result = proposeRetentionCleanup({
      files: [makeBackup('SoNotes_Backup_20250610120000.zip')],
      retentionCount: 5,
      protectedFileNames: new Set(),
    });

    expect(result.cliffDropDetected).toBe(false);
    expect(result.oldestCandidateTime).toBeNull();
    expect(result.newestKeepTime).toEqual(new Date(2025, 5, 10, 12, 0, 0));
  });

  it('cliffDropDetected=true 时结果反映断崖检测状态', () => {
    const result = proposeRetentionCleanup({
      files: [makeBackup('SoNotes_Backup_20250610120000.zip')],
      retentionCount: 5,
      protectedFileNames: new Set(),
      cliffDropDetected: true,
    });

    expect(result.cliffDropDetected).toBe(true);
  });

  it('retentionCount=0 → 保护所有文件，不产生候选', () => {
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

    expect(result.candidates).toHaveLength(0);
    expect(result.keep).toHaveLength(3);
    expect(result.oldestCandidateTime).toBeNull();
    expect(result.newestKeepTime).toEqual(new Date(2025, 5, 12, 12, 0, 0));
  });

  it('retentionCount=-1 → 保护所有文件，不产生候选', () => {
    const files: WebDavRemoteBackup[] = [
      makeBackup('SoNotes_Backup_20250610120000.zip'),
      makeBackup('SoNotes_Backup_20250611120000.zip'),
    ];

    const result = proposeRetentionCleanup({
      files,
      retentionCount: -1,
      protectedFileNames: new Set(),
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.keep).toHaveLength(2);
    expect(result.oldestCandidateTime).toBeNull();
    expect(result.newestKeepTime).toEqual(new Date(2025, 5, 11, 12, 0, 0));
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
    expect(result.oldestCandidateTime).toEqual(new Date(2025, 5, 10, 12, 0, 0));
    expect(result.newestKeepTime).toEqual(new Date(2025, 5, 10, 12, 0, 1));
  });
});

// ---------------------------------------------------------------------------
// detectBackupCliffDrop
// ---------------------------------------------------------------------------

describe('detectBackupCliffDrop', () => {
  it('baselineNotes < 5 → 跳过 note 检测，board 也未触发时返回 null', () => {
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

  it('baselineNotes=4 < 5 → 跳过 note 检测，board 也未触发时返回 null', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(1),
      baselineSummary: makeSummary(4),
    });

    expect(result).toBeNull();
  });

  it('baselineNotes 5-9：currentNotes ≤ 1 触发 CLIFF_DROP_MEDIUM_SAMPLE_CRITICAL', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(1),
      baselineSummary: makeSummary(5),
    });

    expect(result).not.toBeNull();
    expect(result!.baselineNotes).toBe(5);
    expect(result!.currentNotes).toBe(1);
    expect(result!.anomalyCodes).toContain('CLIFF_DROP_MEDIUM_SAMPLE_CRITICAL');
  });

  it('baselineNotes 5-9：currentNotes=2 不触发', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(2),
      baselineSummary: makeSummary(5),
    });

    expect(result).toBeNull();
  });

  it('baselineNotes 5-9：currentNotes=0 触发', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(0),
      baselineSummary: makeSummary(8),
    });

    expect(result).not.toBeNull();
    expect(result!.anomalyCodes).toContain('CLIFF_DROP_MEDIUM_SAMPLE_CRITICAL');
  });

  it('baselineNotes ≥ 10 使用相对阈值 — currentNotes < baseline * 0.3 触发', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(2),
      baselineSummary: makeSummary(10),
    });

    expect(result).not.toBeNull();
    expect(result!.baselineNotes).toBe(10);
    expect(result!.currentNotes).toBe(2);
    expect(result!.threshold).toBe(0.3);
    expect(result!.anomalyCodes).toContain('CLIFF_DROP_RELATIVE');
  });

  it('baselineNotes ≥ 10 — dropPct < 0.3 不触发', () => {
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

  it('恰好达到相对阈值边界 — currentNotes = baseline * 0.3 时不触发', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(3),
      baselineSummary: makeSummary(10),
    });

    expect(result).toBeNull();
  });

  it('currentNotes > baselineNotes → 负 dropPct，不触发', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(20),
      baselineSummary: makeSummary(10),
    });

    expect(result).toBeNull();
  });

  it('baselineNotes=3 < 5 → 跳过 note 检测', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(1),
      baselineSummary: makeSummary(3),
    });

    expect(result).toBeNull();
  });

  it('baselineNotes=5 且 currentNotes=3 不触发（>1）', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(3),
      baselineSummary: makeSummary(5),
    });

    expect(result).toBeNull();
  });

  it('baselineNotes=6 使用中等基线（5-9），currentNotes=4 不触发 noteCount', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(4),
      baselineSummary: makeSummary(6),
    });

    expect(result).toBeNull();
  });

  // ---- board 维度测试 ----

  it('board 维度：baselineBoard ≥ 3 且 dropPct ≥ 50% 触发 CLIFF_DROP_BOARD_COUNT', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(100, { boardCount: 1 }),
      baselineSummary: makeSummary(100, { boardCount: 5 }),
    });

    expect(result).not.toBeNull();
    expect(result!.anomalyCodes).toContain('CLIFF_DROP_BOARD_COUNT');
  });

  it('board 维度：baselineBoard ≥ 3 但 dropPct < 50% 不触发', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(100, { boardCount: 3 }),
      baselineSummary: makeSummary(100, { boardCount: 5 }),
    });

    expect(result).toBeNull();
  });

  it('board 维度：baselineBoard ≥ 2 且 currentBoard === 0 触发', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(100, { boardCount: 0 }),
      baselineSummary: makeSummary(100, { boardCount: 3 }),
    });

    expect(result).not.toBeNull();
    expect(result!.anomalyCodes).toContain('CLIFF_DROP_BOARD_COUNT');
  });

  it('board 维度：baselineBoard = 2 且 currentBoard === 0 触发', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(100, { boardCount: 0 }),
      baselineSummary: makeSummary(100, { boardCount: 2 }),
    });

    expect(result).not.toBeNull();
    expect(result!.anomalyCodes).toContain('CLIFF_DROP_BOARD_COUNT');
  });

  it('board 维度：baselineBoard = 2 但 currentBoard = 1 不触发', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(100, { boardCount: 1 }),
      baselineSummary: makeSummary(100, { boardCount: 2 }),
    });

    expect(result).toBeNull();
  });

  it('board 维度：baselineBoard = 1 不触发（< 2）', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(100, { boardCount: 0 }),
      baselineSummary: makeSummary(100, { boardCount: 1 }),
    });

    expect(result).toBeNull();
  });

  it('note < 5 时仍检查 board 维度 — baselineNotes=2 且 board 也正常 → null', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(2, { boardCount: 1 }),
      baselineSummary: makeSummary(4, { boardCount: 1 }),
    });

    expect(result).toBeNull();
  });

  it('note < 5 时 board 独立触发 — baselineNotes=4 且 baselineBoard ≥ 3 时 board 仍检测', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(2, { boardCount: 0 }),
      baselineSummary: makeSummary(4, { boardCount: 3 }),
    });

    expect(result).not.toBeNull();
    expect(result!.anomalyCodes).toContain('CLIFF_DROP_BOARD_COUNT');
  });

  it('note < 5 时 board 触发 — note=0 且 board 也异常接近空', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(0, { boardCount: 0 }),
      baselineSummary: makeSummary(4, { boardCount: 3 }),
    });

    expect(result).not.toBeNull();
    expect(result!.anomalyCodes).toContain('CLIFF_DROP_BOARD_COUNT');
  });

  it('baselineNotes=4, baselineBoard=10, currentBoard=0 → 触发 CLIFF_DROP_BOARD_COUNT', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(4, { boardCount: 0 }),
      baselineSummary: makeSummary(4, { boardCount: 10 }),
    });

    expect(result).not.toBeNull();
    expect(result!.anomalyCodes).toContain('CLIFF_DROP_BOARD_COUNT');
  });

  // ---- image file 维度测试 ----

  it('image file 维度：baselineImageFile ≥ 5 且 currentImageFile < baseline * 0.3 触发', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(100, { imageFileCount: 2 }),
      baselineSummary: makeSummary(100, { imageFileCount: 10 }),
    });

    expect(result).not.toBeNull();
    expect(result!.anomalyCodes).toContain('CLIFF_DROP_IMAGE_FILE_COUNT');
  });

  it('image file 维度：baselineImageFile ≥ 5 但 dropPct < 30% 不触发', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(100, { imageFileCount: 8 }),
      baselineSummary: makeSummary(100, { imageFileCount: 10 }),
    });

    expect(result).toBeNull();
  });

  it('image file 维度：baselineImageFile = 4 不触发（< 5）', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(100, { imageFileCount: 0 }),
      baselineSummary: makeSummary(100, { imageFileCount: 4 }),
    });

    expect(result).toBeNull();
  });

  // ---- image note 维度测试 ----

  it('image note 维度：baselineImageNote ≥ 5 且 currentImageNote < baseline * 0.3 触发', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(100, { imageNoteCount: 2 }),
      baselineSummary: makeSummary(100, { imageNoteCount: 10 }),
    });

    expect(result).not.toBeNull();
    expect(result!.anomalyCodes).toContain('CLIFF_DROP_IMAGE_NOTE_COUNT');
  });

  it('image note 维度：baselineImageNote ≥ 5 但 dropPct < 30% 不触发', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(100, { imageNoteCount: 8 }),
      baselineSummary: makeSummary(100, { imageNoteCount: 10 }),
    });

    expect(result).toBeNull();
  });

  it('image note 维度：baselineImageNote = 4 不触发（< 5）', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(100, { imageNoteCount: 0 }),
      baselineSummary: makeSummary(100, { imageNoteCount: 4 }),
    });

    expect(result).toBeNull();
  });

  // ---- zip 维度测试 ----

  it('zip 维度：无 zip 参数 → 跳过 zip 检测', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(2),
      baselineSummary: makeSummary(10),
    });

    expect(result).not.toBeNull();
    expect(result!.anomalyCodes).not.toContain('CLIFF_DROP_ZIP_SIZE_BYTES');
  });

  it('zip 维度：有 zip 但无数量下降 → 不触发 zip', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(100),
      baselineSummary: makeSummary(100),
      latestZipSizeBytes: 500_000,
      baselineZipSizeBytes: 2_000_000,
    });

    expect(result).toBeNull();
  });

  it('zip 维度：数量小幅下降但 zip 未降至阈值 → 不触发 zip', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(95),
      baselineSummary: makeSummary(100),
      latestZipSizeBytes: 1_800_000,
      baselineZipSizeBytes: 2_000_000,
    });

    expect(result).toBeNull();
  });

  it('zip 维度：数量小幅下降但 zip 大幅下降 → 触发 zip', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(95),
      baselineSummary: makeSummary(100),
      latestZipSizeBytes: 500_000,
      baselineZipSizeBytes: 2_000_000,
    });

    expect(result).not.toBeNull();
    expect(result!.anomalyCodes).toContain('CLIFF_DROP_ZIP_SIZE_BYTES');
  });

  it('zip 维度：有 zip 且有其他维度异常 → 触发 zip', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(2),
      baselineSummary: makeSummary(10),
      latestZipSizeBytes: 500_000,
      baselineZipSizeBytes: 2_000_000,
    });

    expect(result).not.toBeNull();
    expect(result!.anomalyCodes).toContain('CLIFF_DROP_RELATIVE');
    expect(result!.anomalyCodes).toContain('CLIFF_DROP_ZIP_SIZE_BYTES');
  });

  it('zip 维度：基线 zip < 1 MiB → 不参与判断', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(2),
      baselineSummary: makeSummary(10),
      latestZipSizeBytes: 100_000,
      baselineZipSizeBytes: 500_000,
    });

    expect(result).not.toBeNull();
    expect(result!.anomalyCodes).toContain('CLIFF_DROP_RELATIVE');
    expect(result!.anomalyCodes).not.toContain('CLIFF_DROP_ZIP_SIZE_BYTES');
  });

  it('zip 维度：latestZipSizeBytes 为 null → 跳过 zip', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(2),
      baselineSummary: makeSummary(10),
      latestZipSizeBytes: null,
      baselineZipSizeBytes: 2_000_000,
    });

    expect(result).not.toBeNull();
    expect(result!.anomalyCodes).toContain('CLIFF_DROP_RELATIVE');
    expect(result!.anomalyCodes).not.toContain('CLIFF_DROP_ZIP_SIZE_BYTES');
  });

  it('zip 维度：baselineZipSizeBytes 为 null → 跳过 zip', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(2),
      baselineSummary: makeSummary(10),
      latestZipSizeBytes: 500_000,
      baselineZipSizeBytes: null,
    });

    expect(result).not.toBeNull();
    expect(result!.anomalyCodes).toContain('CLIFF_DROP_RELATIVE');
    expect(result!.anomalyCodes).not.toContain('CLIFF_DROP_ZIP_SIZE_BYTES');
  });

  it('zip 维度：zip 未降至阈值以下 → 不触发 zip', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(2),
      baselineSummary: makeSummary(10),
      latestZipSizeBytes: 1_500_000,
      baselineZipSizeBytes: 2_000_000,
    });

    expect(result).not.toBeNull();
    expect(result!.anomalyCodes).toContain('CLIFF_DROP_RELATIVE');
    expect(result!.anomalyCodes).not.toContain('CLIFF_DROP_ZIP_SIZE_BYTES');
  });

  it('zip 维度：zip 降至阈值以下且有其他异常 → 触发', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(2),
      baselineSummary: makeSummary(10),
      latestZipSizeBytes: 500_000,
      baselineZipSizeBytes: 2_000_000,
    });

    expect(result).not.toBeNull();
    expect(result!.anomalyCodes).toContain('CLIFF_DROP_RELATIVE');
    expect(result!.anomalyCodes).toContain('CLIFF_DROP_ZIP_SIZE_BYTES');
  });

  // ---- imageFileTotalBytes 不参与断崖检测 ----

  it('imageFileTotalBytes 不再参与断崖检测（已从 otherDimensions 移除）', () => {
    const result = detectBackupCliffDrop({
      latestSummary: makeSummary(100, { imageFileTotalBytes: 100_000 }),
      baselineSummary: makeSummary(100, { imageFileTotalBytes: 10_000_000 }),
    });

    expect(result).toBeNull();
  });
});
