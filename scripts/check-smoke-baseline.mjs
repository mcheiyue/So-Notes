#!/usr/bin/env node
/**
 * 冒烟基线文档校验脚本
 *
 * 用法：
 *   node scripts/check-smoke-baseline.mjs <file>              # 按路径自动选 preset
 *   node scripts/check-smoke-baseline.mjs --ids ID1,ID2 <file> # 只校验指定 ID
 *   node scripts/check-smoke-baseline.mjs --allow-fail <file>  # 允许 FAIL 结果不阻断
 *   node scripts/check-smoke-baseline.mjs --preset v1.6.0 <file> # 强制 v1.6.0 ID 集
 *
 * 校验规则：
 *   - v1.5.9：docs/plans/v1.5.9-prep-and-experience-baseline.md 伪代码（约 L787-872）
 *   - v1.6.0：docs/plans/v1.6.0-capture-and-organize-implementation.md §7.2
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
 * 短语只在「自动化命令」+「证据」字段上匹配（不含场景描述正文），
 * 避免场景里写「粘贴」即可假满足命令/证据校验。
 *
 * - 默认规则（OR）：数组内任一词/短语命中即可（大小写不敏感）。
 * - AND 组：{ all: [...] }，组内每一项都必须命中。
 * - alsoAny + any：{ alsoAny: [...], any: [...] }，alsoAny 至少命中一项 + any 至少命中一项；两组之间 AND。
 * - C16：不走默认 requiredById；PASS/N/A 仅由 6b 专项规则判定。
 */
const requiredById = {
  'QC-001': ['QuickCaptureOverlay.test.tsx'],
  // 命令/证据须含测试文件锚点；场景描述中的「粘贴/拖入」不再计入
  'IMG-001': { alsoAny: ['Canvas.test.tsx', 'ImageNoteBody'], any: ['粘贴', 'paste', 'Canvas'] },
  'IMG-002': { alsoAny: ['Canvas.test.tsx', 'ImageNoteBody'], any: ['拖入', 'drag', 'Canvas'] },
  'IMG-003': { alsoAny: ['ImageNoteBody'], any: ['缺失', '占位', '图片不可用'] },
  'IMG-004': { alsoAny: ['ImageNoteBody'], any: ['预览', 'preview'] },
  'UNDO-001': {
    alsoAny: ['useStore'],
    any: ['定位不进入 Undo/Redo', '定位不进入Undo', '定位不进入历史'],
  },
  'DET-001': { alsoAny: ['DetachedNote', 'detach', '撕下'], any: ['DetachedNote', 'appController'] },
  'DET-002': { alsoAny: ['DetachedNote', 'focus', '聚焦'], any: ['DetachedNote', 'appController'] },
  'DET-003': { alsoAny: ['DetachedNote', 'locate', '定位'], any: ['DetachedNote', 'appController'] },
  'DET-004': { alsoAny: ['DetachedNote', 'pin', '置顶'], any: ['DetachedNote', 'appController'] },
  'DET-005': { alsoAny: ['DetachedNote', 'close', '关闭'], any: ['DetachedNote', 'appController'] },
  'BK-LOCAL-001': ['BackupService', 'local-backup'],
  'BK-LOCAL-002': ['BackupService', 'local-restore'],
  'BK-WEBDAV-001': ['WebDavBackupService', 'RemoteBackupRunner', 'webdav'],
  'AUTO-001': ['ScheduledRemoteBackupService'],
  'RET-001': ['RetentionCleanupOrchestrator', 'RemoteBackupRetention'],
  'CLIFF-001': { alsoAny: ['ScheduledRemoteBackupService', 'RetentionCleanupOrchestrator'], any: ['cliff', '断崖', '保留'] },
  // 恢复组合路径：须挂到 BoardDock 恢复 + 缓存/URL 解析
  'RESTORE-IMG-001': {
    alsoAny: ['BoardDock'],
    any: ['invalidateAttachmentPathCache', 'resolveAttachmentAssetUrl', 'zip 恢复成功后替换'],
  },
  // 缺失占位 UI + 恢复缓存清理分测；证据须诚实写明非单一组合 e2e
  'RESTORE-IMG-002': {
    alsoAny: ['ImageNoteBody', 'BoardDock'],
    any: ['图片不可用', '缺失', 'invalidateAttachmentPathCache'],
  },
  'TRASH-001': { alsoAny: ['TrashGrid', 'domainStore'], any: ['软删除', '永久删除', 'TrashGrid'] },
  // C16 不走默认 requiredById；见 6b 专项规则
};

/** 允许 N/A 的 ID 白名单（计划伪代码步骤 6c） */
const NA_WHITELIST = new Set(['BK-WEBDAV-001', 'C16', 'DET-001', 'DET-002', 'DET-003', 'DET-004', 'DET-005']);

// ── v1.6.0 preset（与 v1.5.9 分支并列，勿互相覆盖；§7.2）────────────────────

const REQUIRED_IDS_V160 = [
  'QC-BOARD-001',
  'QC-FAIL-001',
  'QC-HIGHLIGHT-001',
  'QC-UNDO-001',
  'QC-LOCATE-001',
];

/**
 * v1.6.0 requiredById：只在「自动化命令」+「证据」字段文本上匹配
 * BOARD/FAIL/HIGHLIGHT/UNDO/LOCATE(PASS) 使用 { all } AND，防单条 it 假绿
 */
const requiredById_V160 = {
  'QC-BOARD-001': {
    all: [
      'QuickCaptureOverlay.test.tsx',
      '空名回退当前看板',
      '长名截断且 emoji 不抛错',
      '不使用页面工作区项目',
    ],
  },
  'QC-FAIL-001': {
    all: [
      'QuickCaptureOverlay.test.tsx',
      'batch 抛错时保留输入且浮层不关',
      'batch 成功时清空并关闭',
    ],
  },
  'QC-HIGHLIGHT-001': {
    all: [
      'useStore.test.ts',
      '高亮与选区',
      'TRASH 视图下 batch 仍写入 currentBoardId',
    ],
  },
  'QC-UNDO-001': {
    all: [
      'useStore.test.ts',
      'addNotesWithContentBatch undo 整批撤销',
      'addNotesWithContentBatch redo 整批恢复',
      '空 batch 不 push history',
      'batch 与单条 add 混合栈',
    ],
  },
  'QC-LOCATE-001': {
    all: [
      'QuickCaptureOverlay.test.tsx',
      '空闲时允许定位',
      '占用时跳过定位',
    ],
  },
};

/** v1.6.0 仅 QC-LOCATE-001 允许 N/A */
const NA_WHITELIST_V160 = new Set(['QC-LOCATE-001']);

/** 必填字段列表（计划伪代码步骤 7b） */
const REQUIRED_FIELDS = ['类型:', '自动化命令:', '人工步骤:', '证据:', '跳过原因:'];

/** SYNC_BANNED 正则（计划伪代码步骤 8；与 C14 否定正则同源；C28 doc-guard 从此提取字面） */
const SYNC_BANNED = /同步|云同步|自动同步|双向|合并|sync|synchronize|自动拉取|自动下载|自动恢复/i;

/**
 * 解析 preset：路径含 v1.6.0-smoke-baseline 或 --preset v1.6.0 → v1.6.0，否则 v1.5.9
 * @param {string} filePath
 * @param {string|null} presetFlag
 * @returns {'v1.5.9'|'v1.6.0'}
 */
function resolvePreset(filePath, presetFlag) {
  if (presetFlag === 'v1.6.0' || presetFlag === '1.6.0') return 'v1.6.0';
  if (presetFlag === 'v1.5.9' || presetFlag === '1.5.9') return 'v1.5.9';
  const posix = String(filePath).replace(/\\/g, '/');
  if (posix.includes('v1.6.0-smoke-baseline')) return 'v1.6.0';
  return 'v1.5.9';
}

// ─── 工具函数 ───────────────────────────────────────────────────────────────────

/**
 * 按 /^## /m 切段（计划伪代码步骤 1）
 * 返回 { segments: Map<ID, 段文本>, duplicateIds: string[] }
 * 重复 ID 不静默覆盖：后出现的同名段记入 duplicateIds，Map 保留首次。
 */
function splitSegments(content) {
  const segments = new Map();
  const duplicateIds = [];
  const seen = new Set();
  // 按 /^## / 分割，保留段首
  const parts = content.split(/(?=^## )/m);
  for (const part of parts) {
    const match = part.match(/^## (\S+)/m);
    if (match) {
      const id = match[1];
      if (seen.has(id)) {
        if (!duplicateIds.includes(id)) {
          duplicateIds.push(id);
        }
        // 不覆盖首次段落，避免后段 PASS 抹掉前段 FAIL
        continue;
      }
      seen.add(id);
      segments.set(id, part);
    }
  }
  return { segments, duplicateIds };
}

/**
 * 段内 Result 行：要求恰好 1 个 PASS|N/A|FAIL。
 * 返回 { ok, result?, count, reason? }
 */
function parseUniqueResult(segmentText) {
  const re = /Result:\s*(PASS|N\/A|FAIL)/gi;
  const matches = [...segmentText.matchAll(re)];
  if (matches.length === 0) {
    return { ok: false, count: 0, reason: '缺少 Result: PASS|N/A|FAIL' };
  }
  if (matches.length > 1) {
    const values = matches.map((m) => m[1].toUpperCase()).join(', ');
    return {
      ok: false,
      count: matches.length,
      reason: `段内 Result 出现 ${matches.length} 次（须恰好 1 个）: ${values}`,
    };
  }
  return { ok: true, count: 1, result: matches[0][1].toUpperCase() };
}

/**
 * 从段中抽取「自动化命令」+「证据」字段正文（不含场景描述）。
 * 防止场景描述里写「粘贴」即可假满足 requiredById。
 */
function extractCommandAndEvidenceText(segmentText) {
  const lines = segmentText.split('\n');
  const chunks = [];
  for (const rawLine of lines) {
    // 防御性去掉行尾 CR（主流程已 normalize，此处双保险）
    const line = rawLine.replace(/\r$/, '');
    const m = line.match(/^[-*]?\s*(自动化命令|证据)[：:]\s*(.*)$/i);
    if (m) {
      chunks.push(m[2].trim());
    }
  }
  return chunks.join('\n');
}

/**
 * 检查段内「自动化命令/证据」是否包含 requiredById 短语
 * 支持 OR 数组、{all}、{alsoAny, any} 三种形式
 * 返回 { pass: boolean, reason: string }
 * @param {string} id
 * @param {string} segmentText
 * @param {Record<string, unknown>} ruleMap 当前 preset 的 requiredById
 */
function checkRequiredPhrases(id, segmentText, ruleMap) {
  const rule = ruleMap[id];
  if (!rule) return { pass: true, reason: '无 requiredById 规则' };

  // C16 不走默认 requiredById（计划伪代码步骤 5）
  if (id === 'C16') return { pass: true, reason: 'C16 走专项规则' };

  const scopeText = extractCommandAndEvidenceText(segmentText);
  if (!scopeText.trim()) {
    return { pass: false, reason: '自动化命令/证据字段为空，无法校验 requiredById' };
  }

  // 默认 OR 数组
  if (Array.isArray(rule)) {
    const lowerText = scopeText.toLowerCase();
    const hits = rule.filter(phrase => lowerText.includes(phrase.toLowerCase()));
    if (hits.length === 0) {
      return { pass: false, reason: `OR 数组无命中（仅查命令/证据）；需含至少一项: ${rule.join(' / ')}` };
    }
    return { pass: true, reason: `OR 命中: ${hits.join(', ')}` };
  }

  // {all} AND 组
  if (rule.all) {
    const lowerText = scopeText.toLowerCase();
    const missing = rule.all.filter(phrase => !lowerText.includes(phrase.toLowerCase()));
    if (missing.length > 0) {
      return { pass: false, reason: `AND 组缺失（仅查命令/证据）: ${missing.join(', ')}` };
    }
    return { pass: true, reason: `AND 全命中` };
  }

  // {alsoAny, any} 两组 AND（计划伪代码步骤 5）
  if (rule.alsoAny && rule.any) {
    const lowerText = scopeText.toLowerCase();
    const alsoAnyHits = rule.alsoAny.filter(phrase => lowerText.includes(phrase.toLowerCase()));
    const anyHits = rule.any.filter(phrase => lowerText.includes(phrase.toLowerCase()));

    if (alsoAnyHits.length === 0) {
      return { pass: false, reason: `alsoAny 组无命中（仅查命令/证据）；需含至少一项: ${rule.alsoAny.join(' / ')}` };
    }
    if (anyHits.length === 0) {
      return { pass: false, reason: `any 组无命中（仅查命令/证据）；需含至少一项: ${rule.any.join(' / ')}` };
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
  let presetFlag = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--allow-fail') {
      allowFail = true;
    } else if (args[i] === '--ids' && i + 1 < args.length) {
      onlyIds = args[i + 1].split(',').map(s => s.trim());
      i++;
    } else if (args[i] === '--preset' && i + 1 < args.length) {
      presetFlag = args[i + 1].trim();
      i++;
    } else if (!args[i].startsWith('-')) {
      filePath = args[i];
    }
  }

  if (!filePath) {
    console.error('用法: node scripts/check-smoke-baseline.mjs [--ids ID1,ID2] [--allow-fail] [--preset v1.5.9|v1.6.0] <file>');
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

  // Windows CI checkout 常为 CRLF；统一为 LF，避免字段行 `$` 锚定被 \r 阻断
  content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 按 /^## /m 切段（拒绝重复 ID）
  const { segments, duplicateIds } = splitSegments(content);

  // preset 切换：路径含 v1.6.0-smoke-baseline 或 --preset v1.6.0
  const preset = resolvePreset(filePath, presetFlag);
  const activeRequiredIds = preset === 'v1.6.0' ? REQUIRED_IDS_V160 : REQUIRED_IDS;
  const activeRequiredById = preset === 'v1.6.0' ? requiredById_V160 : requiredById;
  const activeNaWhitelist = preset === 'v1.6.0' ? NA_WHITELIST_V160 : NA_WHITELIST;

  // 确定要校验的 ID
  const idsToCheck = onlyIds || activeRequiredIds;

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

  // ─── 重复 ID：发布阻断（防后段 PASS 覆盖前段 FAIL） ───────────────────
  for (const id of duplicateIds) {
    // --ids 过滤时：仅当重复 ID 在检查范围内才报（仍阻断合并污染）
    if (onlyIds && !onlyIds.includes(id)) {
      continue;
    }
    errors.push(`[${id}] 重复段落 (## ${id} 出现多次)；须每个 ID 唯一`);
    exitCode = 1;
  }

  // ─── 校验每个必需 ID ─────────────────────────────────────────────────────
  for (const id of idsToCheck) {
    // 检查段是否存在
    if (!segments.has(id)) {
      errors.push(`[${id}] 缺少段落 (## ${id})`);
      exitCode = 1;
      continue;
    }

    const segmentText = segments.get(id);

    // 检查 Result 字段：恰好一个（计划伪代码步骤 4 + 防多 Result 假绿）
    const parsed = parseUniqueResult(segmentText);
    if (!parsed.ok) {
      errors.push(`[${id}] ${parsed.reason}`);
      exitCode = 1;
      continue;
    }

    const result = parsed.result;

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

      // QC-LOCATE-001 N/A 专项（v1.6.0 §7.2 步骤 6）
      if (id === 'QC-LOCATE-001') {
        if (!/原因[:：]/.test(segmentText)) {
          errors.push(`[${id}] N/A 但缺少 "原因:"`);
          exitCode = 1;
        }
        const locateNaOk =
          segmentText.includes('未交付') ||
          segmentText.includes('Optional') ||
          segmentText.includes('C29') ||
          segmentText.includes('捕获后程序定位未交付');
        if (!locateNaOk) {
          errors.push(
            `[${id}] N/A 但缺少原因关键词之一：未交付 / Optional / C29 / 捕获后程序定位未交付`,
          );
          exitCode = 1;
        }
        if (!/跳过原因[:：]\s*\S/.test(segmentText)) {
          errors.push(`[${id}] N/A 但缺少非空 "跳过原因:"`);
          exitCode = 1;
        }
      }

      // 禁止对非白名单 ID 使用 N/A（计划伪代码步骤 6c；preset 各自白名单）
      if (!activeNaWhitelist.has(id)) {
        errors.push(`[${id}] 不允许 Result: N/A（仅白名单 ID 可使用 N/A；preset=${preset}）`);
        exitCode = 1;
      }

      // N/A 段跳过默认 requiredById 短语检查（计划伪代码步骤 5b）
      continue;
    }

    // ─── PASS 段的专项规则 ──────────────────────────────────────────────

    // C16 PASS 专项（计划伪代码步骤 6b；仅 v1.5.9）
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
    const phraseCheck = checkRequiredPhrases(id, segmentText, activeRequiredById);
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
