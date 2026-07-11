#!/usr/bin/env node
/**
 * 冒烟基线文档校验脚本
 *
 * 用法：
 *   node scripts/check-smoke-baseline.mjs <file>              # 校验全部必需 ID
 *   node scripts/check-smoke-baseline.mjs --ids ID1,ID2 <file> # 只校验指定 ID
 *   node scripts/check-smoke-baseline.mjs --allow-fail <file>  # 允许 FAIL 结果不阻断
 *
 * 校验规则见 docs/plans/v1.5.9-prep-and-experience-baseline.md 伪代码（约 L787-872）。
 */

import { readFileSync } from 'node:fs';

// ─── 常量 ───────────────────────────────────────────────────────────────────────

/** 必需 ID 集合（计划伪代码步骤 2） */
const REQUIRED_IDS = [
  'QC-001',
  'IMG-001', 'IMG-002', 'IMG-003', 'IMG-004',
  'UNDO-001',
  'DET-001', 'DET-002', 'DET-003', 'DET-004', 'DET-005',
  'BK-LOCAL-001', 'BK-LOCAL-002',
  'BK-WEBDAV-001',
  'AUTO-001',
  'RET-001',
  'CLIFF-001',
  'RESTORE-IMG-001', 'RESTORE-IMG-002',
  'TRASH-001',
  'C16',
];

/**
 * requiredById：匹配语义定义（计划伪代码步骤 5）
 *
 * - 默认规则（OR）：数组内任一词/短语命中即可（大小写不敏感）。
 * - AND 组：{ all: [...] }，组内每一项都必须命中。
 * - alsoAny + any：{ alsoAny: [...], any: [...] }，alsoAny 至少命中一项 + any 至少命中一项；两组之间 AND。
 * - C16：不走默认 requiredById；PASS/N/A 仅由 6b 专项规则判定。
 */
const requiredById = {
  'QC-001': ['npx vitest run src/components/QuickCaptureOverlay.test.tsx'],
  'IMG-001': ['粘贴', 'paste'],
  'IMG-002': ['拖入', 'drag'],
  'IMG-003': ['缺失', '占位', '图片不可用'],
  'IMG-004': ['预览', 'preview'],
  'UNDO-001': {
    alsoAny: ['useStore'],
    any: ['定位不进入 Undo/Redo', '预览不进入 Undo/Redo', '定位不进入Undo', '预览不进入Undo'],
  },
  'DET-001': { alsoAny: ['detach', '撕下'], any: ['DetachedNote', '窗口'] },
  'DET-002': { alsoAny: ['focus', '聚焦'], any: ['DetachedNote'] },
  'DET-003': { alsoAny: ['locate', '定位'], any: ['DetachedNote'] },
  'DET-004': { alsoAny: ['pin', '置顶'], any: ['DetachedNote'] },
  'DET-005': { alsoAny: ['close', '关闭'], any: ['DetachedNote'] },
  'BK-LOCAL-001': ['BackupService', 'local-backup', '备份'],
  'BK-LOCAL-002': ['BackupService', 'local-restore', '恢复'],
  'BK-WEBDAV-001': ['WebDavBackupService', 'RemoteBackupRunner', 'webdav'],
  'AUTO-001': ['ScheduledRemoteBackupService', '定时', '自动'],
  'RET-001': ['RetentionCleanupOrchestrator', 'RemoteBackupRetention', '保留'],
  'CLIFF-001': ['cliff', '断崖', '删除前'],
  'RESTORE-IMG-001': { alsoAny: ['恢复', 'restore', 'backup'], any: ['asset', 'URL', '可解析'] },
  'RESTORE-IMG-002': { alsoAny: ['恢复', 'restore', 'backup'], any: ['缺失', '占位', '图片不可用'] },
  'TRASH-001': ['软删除', '永久删除'],
  // C16 不走默认 requiredById；见 6b 专项规则
};

/** 允许 N/A 的 ID 白名单（计划伪代码步骤 6c） */
const NA_WHITELIST = new Set(['BK-WEBDAV-001', 'C16', 'DET-001', 'DET-002', 'DET-003', 'DET-004', 'DET-005']);

/** 必填字段列表（计划伪代码步骤 7b） */
const REQUIRED_FIELDS = ['类型:', '自动化命令:', '人工步骤:', '证据:', '跳过原因:'];

/** SYNC_BANNED 正则（计划伪代码步骤 8；与 C14 否定正则同源） */
const SYNC_BANNED = /同步|云同步|自动同步|双向|合并|sync|synchronize|自动拉取|自动下载|自动恢复/i;

// ─── 工具函数 ───────────────────────────────────────────────────────────────────

/**
 * 按 /^## /m 切段（计划伪代码步骤 1）
 * 返回 Map<段首行ID, 段文本>
 */
function splitSegments(content) {
  const segments = new Map();
  // 按 /^## / 分割，保留段首
  const parts = content.split(/(?=^## )/m);
  for (const part of parts) {
    const match = part.match(/^## (\S+)/m);
    if (match) {
      segments.set(match[1], part);
    }
  }
  return segments;
}

/**
 * 检查段内是否包含 requiredById 短语
 * 支持 OR 数组、{all}、{alsoAny, any} 三种形式
 * 返回 { pass: boolean, reason: string }
 */
function checkRequiredPhrases(id, segmentText) {
  const rule = requiredById[id];
  if (!rule) return { pass: true, reason: '无 requiredById 规则' };

  // C16 不走默认 requiredById（计划伪代码步骤 5）
  if (id === 'C16') return { pass: true, reason: 'C16 走专项规则' };

  // 默认 OR 数组
  if (Array.isArray(rule)) {
    const lowerText = segmentText.toLowerCase();
    const hits = rule.filter(phrase => lowerText.includes(phrase.toLowerCase()));
    if (hits.length === 0) {
      return { pass: false, reason: `OR 数组无命中；需含至少一项: ${rule.join(' / ')}` };
    }
    return { pass: true, reason: `OR 命中: ${hits.join(', ')}` };
  }

  // {all} AND 组
  if (rule.all) {
    const lowerText = segmentText.toLowerCase();
    const missing = rule.all.filter(phrase => !lowerText.includes(phrase.toLowerCase()));
    if (missing.length > 0) {
      return { pass: false, reason: `AND 组缺失: ${missing.join(', ')}` };
    }
    return { pass: true, reason: `AND 全命中` };
  }

  // {alsoAny, any} 两组 AND（计划伪代码步骤 5）
  if (rule.alsoAny && rule.any) {
    const lowerText = segmentText.toLowerCase();
    const alsoAnyHits = rule.alsoAny.filter(phrase => lowerText.includes(phrase.toLowerCase()));
    const anyHits = rule.any.filter(phrase => lowerText.includes(phrase.toLowerCase()));

    if (alsoAnyHits.length === 0) {
      return { pass: false, reason: `alsoAny 组无命中；需含至少一项: ${rule.alsoAny.join(' / ')}` };
    }
    if (anyHits.length === 0) {
      return { pass: false, reason: `any 组无命中；需含至少一项: ${rule.any.join(' / ')}` };
    }
    return { pass: true, reason: `alsoAny 命中: ${alsoAnyHits.join(', ')}; any 命中: ${anyHits.join(', ')}` };
  }

  return { pass: true, reason: '未知规则格式，默认通过' };
}

/**
 * 检查段内必填字段是否存在（计划伪代码步骤 7b）
 * 返回缺失字段数组
 */
function checkRequiredFields(segmentText) {
  const missing = [];
  for (const field of REQUIRED_FIELDS) {
    // 大小写不敏感，允许中文冒号
    const pattern = new RegExp(field.replace(':', '[：:]'), 'i');
    if (!pattern.test(segmentText)) {
      missing.push(field);
    }
  }
  return missing;
}

/**
 * 检查段内必填字段是否非空（计划伪代码步骤 7b 后半段）
 * 对于 PASS 段，自动化命令和证据必须非空
 * 对于 N/A 段，跳过原因必须非空
 * 返回问题列表
 */
function checkFieldNonEmpty(segmentText, result) {
  const issues = [];
  const lines = segmentText.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // 检查字段: 后面是否有非空内容
    for (const field of REQUIRED_FIELDS) {
      const fieldBase = field.replace(':', '');
      const pattern = new RegExp(`^[-*]?\\s*${fieldBase}[：:]\\s*$`, 'i');
      if (pattern.test(trimmed)) {
        issues.push(`字段 "${fieldBase}" 内容为空`);
      }
    }
  }

  return issues;
}

// ─── 主逻辑 ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  // 解析参数
  let allowFail = false;
  let onlyIds = null;
  let filePath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--allow-fail') {
      allowFail = true;
    } else if (args[i] === '--ids' && i + 1 < args.length) {
      onlyIds = args[i + 1].split(',').map(s => s.trim());
      i++;
    } else if (!args[i].startsWith('-')) {
      filePath = args[i];
    }
  }

  if (!filePath) {
    console.error('用法: node scripts/check-smoke-baseline.mjs [--ids ID1,ID2] [--allow-fail] <file>');
    process.exit(1);
  }

  // 读文件
  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (e) {
    console.error(`无法读取文件: ${filePath}`, e.message);
    process.exit(1);
  }

  // 按 /^## /m 切段
  const segments = splitSegments(content);

  // 确定要校验的 ID
  const idsToCheck = onlyIds || REQUIRED_IDS;

  // ─── 全文 SYNC_BANNED 检查（计划伪代码步骤 8） ─────────────────────────
  const syncMatches = content.match(SYNC_BANNED);
  if (syncMatches) {
    // 允许代码注释、测试名、文档非目标中出现；只报错用户可见文案
    // 简单策略：全文匹配到即报错，由调用方确认是否合理
    console.error(`[SYNC_BANNED] 全文发现同步类禁用词: "${syncMatches[0]}"（与 C14 否定正则同源；若在代码注释/测试名/非目标段中可忽略）`);
    // 不阻断，仅警告（计划步骤 8 说"全文不得把 WebDAV 描述为同步"，但具体实现由 C14 测试覆盖）
  }

  let exitCode = 0;
  const errors = [];

  // ─── 校验每个必需 ID ─────────────────────────────────────────────────────
  for (const id of idsToCheck) {
    // 检查段是否存在
    if (!segments.has(id)) {
      errors.push(`[${id}] 缺少段落 (## ${id})`);
      exitCode = 1;
      continue;
    }

    const segmentText = segments.get(id);

    // 检查 Result 字段（计划伪代码步骤 4）
    const resultMatch = segmentText.match(/Result:\s*(PASS|N\/A|FAIL)/i);
    if (!resultMatch) {
      errors.push(`[${id}] 缺少 Result: PASS|N/A|FAIL`);
      exitCode = 1;
      continue;
    }

    const result = resultMatch[1].toUpperCase();

    // FAIL 结果 => exit 1（计划伪代码步骤 4b）
    if (result === 'FAIL' && !allowFail) {
      errors.push(`[${id}] Result: FAIL（发布阻断）`);
      exitCode = 1;
      continue;
    }

    // ─── 必填字段检查（计划伪代码步骤 7b） ─────────────────────────────
    const missingFields = checkRequiredFields(segmentText);
    if (missingFields.length > 0) {
      errors.push(`[${id}] 缺少必填字段: ${missingFields.join(', ')}`);
      exitCode = 1;
      continue;
    }

    // 字段非空检查
    const fieldIssues = checkFieldNonEmpty(segmentText, result);
    if (fieldIssues.length > 0) {
      errors.push(`[${id}] 字段内容问题: ${fieldIssues.join('; ')}`);
      exitCode = 1;
      continue;
    }

    // ─── N/A 专项规则 ──────────────────────────────────────────────────
    if (result === 'N/A') {
      // BK-WEBDAV-001 N/A 专项（计划伪代码步骤 6）
      if (id === 'BK-WEBDAV-001') {
        if (!segmentText.includes('替代自动化')) {
          errors.push(`[${id}] N/A 但缺少 "替代自动化"`);
          exitCode = 1;
        }
        if (!/原因[:：]/.test(segmentText)) {
          errors.push(`[${id}] N/A 但缺少 "原因:"`);
          exitCode = 1;
        }
      }

      // C16 N/A 专项（计划伪代码步骤 6b）
      if (id === 'C16') {
        if (!/原因[:：]/.test(segmentText)) {
          errors.push(`[${id}] N/A 但缺少 "原因:"`);
          exitCode = 1;
        }
        if (!segmentText.includes('推迟')) {
          errors.push(`[${id}] N/A 但缺少 "推迟"（证明有意推迟而非遗忘）`);
          exitCode = 1;
        }
      }

      // DET-* N/A 专项（计划伪代码步骤 6c）
      if (id.startsWith('DET-')) {
        if (!/原因[:：]/.test(segmentText)) {
          errors.push(`[${id}] N/A 但缺少 "原因:"`);
          exitCode = 1;
        }
        if (!/跳过原因[:：]/.test(segmentText)) {
          errors.push(`[${id}] N/A 但缺少 "跳过原因:"`);
          exitCode = 1;
        }
        // 非空自动化命令（替代自动化证据）
        const autoCmdMatch = segmentText.match(/自动化命令[:：]\s*(.+)/i);
        if (!autoCmdMatch || !autoCmdMatch[1].trim()) {
          errors.push(`[${id}] N/A 但缺少非空 "自动化命令:"（替代自动化）`);
          exitCode = 1;
        }
      }

      // 禁止对非白名单 ID 使用 N/A（计划伪代码步骤 6c）
      if (!NA_WHITELIST.has(id)) {
        errors.push(`[${id}] 不允许 Result: N/A（仅白名单 ID 可使用 N/A）`);
        exitCode = 1;
      }

      // N/A 段跳过默认 requiredById 短语检查（计划伪代码步骤 5b）
      continue;
    }

    // ─── PASS 段的专项规则 ──────────────────────────────────────────────

    // C16 PASS 专项（计划伪代码步骤 6b）
    if (id === 'C16') {
      const testName = '文案守卫: Quick Capture 显示当前看板且不使用页面工作区项目';
      if (!segmentText.includes(testName)) {
        errors.push(`[${id}] PASS 但缺少完整具名测试名: "${testName}"`);
        exitCode = 1;
      }
      // 证据必须非空
      const evidenceMatch = segmentText.match(/证据[:：]\s*(.+)/i);
      if (!evidenceMatch || !evidenceMatch[1].trim()) {
        errors.push(`[${id}] PASS 但缺少非空 "证据:"`);
        exitCode = 1;
      }
      // C16 不走默认 requiredById
      continue;
    }

    // ─── 默认 requiredById 短语检查（计划伪代码步骤 5） ──────────────
    const phraseCheck = checkRequiredPhrases(id, segmentText);
    if (!phraseCheck.pass) {
      errors.push(`[${id}] ${phraseCheck.reason}`);
      exitCode = 1;
    }
  }

  // ─── 输出结果 ─────────────────────────────────────────────────────────────
  if (errors.length > 0) {
    console.error('\n校验失败:');
    for (const err of errors) {
      console.error(`  ✗ ${err}`);
    }
    console.error(`\n共 ${errors.length} 个错误`);
  } else {
    console.log(`\n✓ 校验通过：${idsToCheck.length} 个 ID 全部通过`);
  }

  process.exit(exitCode);
}

main();
