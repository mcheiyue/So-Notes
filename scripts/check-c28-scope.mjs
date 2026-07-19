#!/usr/bin/env node
/**
 * C28 范围纪律 SSOT（v1.6.0 Commit 6a）
 *
 * 用法：
 *   node scripts/check-c28-scope.mjs whitelist   // 白名单硬门
 *   node scripts/check-c28-scope.mjs doc-guard   // 文档守卫
 *   node scripts/check-c28-scope.mjs soft        // 软扫描；仅 warn，exit 0
 *   node scripts/check-c28-scope.mjs all         // whitelist + doc-guard（硬；soft 不进）
 *
 * 环境：
 *   C28_BASE  默认 'v1.5.9'（git diff 三点对比基线）
 *   C28_ALLOW=1 时 whitelist 可旁路 exit 0（仍 console.warn）；DoD 不得用 ALLOW 顶替
 *
 * 规格真源：docs/plans/v1.6.0-capture-and-organize-implementation.md §5.5
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// ─── 白名单（精确文件 + 前缀 + Optional gate）────────────────────────────────

/** 精确允许的路径（posix） */
const EXACT_ALLOWED = new Set([
  'src/store/useStore.ts',
  'src/store/useStore.test.ts',
  'src/components/QuickCaptureOverlay.tsx',
  'src/components/QuickCaptureOverlay.test.tsx',
  'docs/qa/v1.6.0-smoke-baseline.md',
  'scripts/check-smoke-baseline.mjs',
  'scripts/check-c28-scope.mjs',
  'package.json',
  'package-lock.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'CHANGELOG.md',
]);

/** 允许前缀 */
const PREFIX_ALLOWED = ['docs/plans/v1.6.0-', 'docs/prototypes/v1.6.0-'];

/**
 * Optional gate 路径（至多 1 个；未做 Optional 时不得出现）
 * 与 §5.5 写死谓词一致
 */
const GATE_OK =
  /^(src\/utils\/canRunViewportAction\.ts|src\/components\/canRunViewportAction\.ts|src\/components\/.*ViewportGate.*\.tsx?|src\/components\/.*canRunViewportAction.*\.tsx?)$/;

/** 软扫描文件名可疑词（仅 warn） */
const SOFT_NAME_RE =
  /tag|Tag|sync|Sync|sqlite|SQLite|libsql|template|Template|color|折叠|domainStore|appController|Canvas\.tsx|legacyDomainBridge|webdav|backup\.rs|BoardDock/;

/** 文档守卫扫描文件 */
const DOC_GUARD_FILES = [
  'docs/plans/v1.6.0-capture-and-organize-implementation.md',
  'docs/plans/v1.6.0-capture-and-organize-experience.md',
];

/** 主题书豁免 heading 子串（大小写不敏感） */
const EXPERIENCE_EXEMPT = ['Non-goals', 'Deferred'];

/** 实施稿额外豁免 heading 子串 */
const IMPLEMENTATION_EXEMPT = [
  'Out of Scope',
  'Non-goals',
  'C28',
  '范围纪律',
  '无法自动证明',
  '变更记录',
  '风险与对策',
  '禁止主题',
];

/** 产品范围夹带（本版固定，仅文档守卫） */
const PRODUCT_SCOPE_SOURCE =
  '标签系统|同步冲突 UI|SQLite|libSQL|WebDAV 上传|定时备份策略';

// ─── 工具 ────────────────────────────────────────────────────────────────────

function posixPath(p) {
  return String(p).replace(/\\/g, '/');
}

function getBase() {
  return process.env.C28_BASE && process.env.C28_BASE.trim()
    ? process.env.C28_BASE.trim()
    : 'v1.5.9';
}

function isAllowEnabled() {
  return process.env.C28_ALLOW === '1';
}

/**
 * 从 check-smoke-baseline.mjs 提取 SYNC_BANNED 正则字面
 * @returns {{ body: string, flags: string }}
 */
function extractSyncBannedLiteral() {
  const smokePath = join(REPO_ROOT, 'scripts/check-smoke-baseline.mjs');
  let text;
  try {
    text = readFileSync(smokePath, 'utf-8');
  } catch (e) {
    console.error(
      `[C28 doc-guard] 无法读取 ${smokePath}: ${e.message}`,
    );
    process.exit(1);
  }
  const m = text.match(
    /const\s+SYNC_BANNED\s*=\s*\/((?:\\.|[^/\\])+)\/([a-z]*)/,
  );
  if (!m) {
    console.error(
      '[C28 doc-guard] 无法从 check-smoke-baseline.mjs 提取 const SYNC_BANNED = /.../',
    );
    process.exit(1);
  }
  return { body: m[1], flags: m[2] || '' };
}

/**
 * hardenSyncBanned：plan 固定防假阳变换
 * - 去掉裸「合并」交替支
 * - 同步 → (?<!不)同步
 * - 自动拉取|自动下载|自动恢复 → 各加 (?<!不)
 * - sync → 词界（不匹配 existsSync 等）
 * - 补多端合并|双向合并|冲突合并
 */
function hardenSyncBanned(body, flags) {
  const parts = body.split('|').filter((p) => p !== '合并');
  const transformed = parts.map((p) => {
    if (p === '同步') return '(?<!不)同步';
    if (p === '自动拉取' || p === '自动下载' || p === '自动恢复') {
      return `(?<!不)${p}`;
    }
    if (p === 'sync') return '(?<![A-Za-z])sync(?![A-Za-z])';
    return p;
  });
  transformed.push('多端合并', '双向合并', '冲突合并');
  // 保留原 flags，确保 i 存在
  const f = flags.includes('i') ? flags : `${flags}i`;
  return new RegExp(transformed.join('|'), f);
}

function buildDocBannedRegex() {
  const { body, flags } = extractSyncBannedLiteral();
  const hardened = hardenSyncBanned(body, flags);
  // PRODUCT_SCOPE ∪ hardened
  return new RegExp(
    `(?:${PRODUCT_SCOPE_SOURCE})|(?:${hardened.source})`,
    'i',
  );
}

function pathAllowed(path) {
  const p = posixPath(path);
  if (EXACT_ALLOWED.has(p)) return true;
  for (const prefix of PREFIX_ALLOWED) {
    if (p.startsWith(prefix)) return true;
  }
  if (GATE_OK.test(p)) return true;
  return false;
}

/**
 * git diff --name-only ${C28_BASE}...HEAD
 * @returns {string[]}
 */
function getChangedPaths() {
  const base = getBase();
  try {
    const out = execFileSync(
      'git',
      ['diff', '--name-only', `${base}...HEAD`],
      {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map(posixPath);
  } catch (e) {
    const msg = e.stderr || e.message || String(e);
    console.error(
      `[C28 whitelist] git diff --name-only ${base}...HEAD 失败: ${msg}`,
    );
    process.exit(1);
  }
}

// ─── whitelist ───────────────────────────────────────────────────────────────

function runWhitelist() {
  const paths = getChangedPaths();
  const base = getBase();
  const bad = [];
  for (const p of paths) {
    if (!pathAllowed(p)) bad.push(p);
  }

  if (bad.length === 0) {
    console.log(
      `✓ C28 whitelist：相对 ${base} 共 ${paths.length} 路径全部在白名单内`,
    );
    return 0;
  }

  console.error(`\n[C28 whitelist] 相对 ${base} 发现非白名单路径（${bad.length}）：`);
  for (const p of bad) {
    console.error(`  ✗ ${p}`);
  }

  if (isAllowEnabled()) {
    console.warn(
      '[C28 whitelist] C28_ALLOW=1：旁路 exit 0（DoD / 发布不得计此结果）',
    );
    return 0;
  }

  console.error(
    '\n硬门失败：修复范围或临时调试可设 C28_ALLOW=1（禁止用于 DoD）',
  );
  return 1;
}

// ─── doc-guard ───────────────────────────────────────────────────────────────

/**
 * 按 markdown heading 分段，代码围栏内跳过（不解析 #、不扫 banned）
 * 返回 { heading, body, startLine }[]
 */
function segmentByHeading(content) {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const segments = [];
  let inFence = false;
  let current = { heading: '(root)', bodyLines: [], startLine: 1 };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // 围栏开关：仅行首 ```（允许前置空白）
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      // 围栏标记行本身不入 body（跳过扫描）
      continue;
    }

    if (inFence) {
      // 围栏内整行跳过
      continue;
    }

    const hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      // 先收束上一段
      segments.push({
        heading: current.heading,
        body: current.bodyLines.join('\n'),
        startLine: current.startLine,
      });
      current = {
        heading: hm[2].trim(),
        bodyLines: [line], // heading 行本身也受扫描（非豁免时）
        startLine: lineNo,
      };
      continue;
    }

    current.bodyLines.push(line);
  }

  segments.push({
    heading: current.heading,
    body: current.bodyLines.join('\n'),
    startLine: current.startLine,
  });

  return segments;
}

function isHeadingExempt(heading, exemptList) {
  const h = heading.toLowerCase();
  return exemptList.some((ex) => h.includes(ex.toLowerCase()));
}

function runDocGuard() {
  const banned = buildDocBannedRegex();
  const errors = [];

  for (const rel of DOC_GUARD_FILES) {
    const abs = join(REPO_ROOT, rel);
    let text;
    try {
      text = readFileSync(abs, 'utf-8');
    } catch (e) {
      errors.push(`[${rel}] 无法读取: ${e.message}`);
      continue;
    }

    const isImpl = rel.includes('implementation');
    const exemptList = isImpl
      ? [...EXPERIENCE_EXEMPT, ...IMPLEMENTATION_EXEMPT]
      : EXPERIENCE_EXEMPT;

    const segments = segmentByHeading(text);
    for (const seg of segments) {
      if (isHeadingExempt(seg.heading, exemptList)) continue;
      const m = seg.body.match(banned);
      if (m) {
        errors.push(
          `[${rel}] 非豁免段 heading="${seg.heading.slice(0, 60)}" (≈L${seg.startLine}) 命中 banned: "${m[0]}"`,
        );
      }
    }
  }

  if (errors.length === 0) {
    console.log(
      `✓ C28 doc-guard：${DOC_GUARD_FILES.length} 个文档无非豁免 banned 命中`,
    );
    return 0;
  }

  console.error('\n[C28 doc-guard] 失败:');
  for (const err of errors) {
    console.error(`  ✗ ${err}`);
  }
  return 1;
}

// ─── soft ────────────────────────────────────────────────────────────────────

function runSoft() {
  const paths = getChangedPaths();
  let warns = 0;
  for (const p of paths) {
    if (SOFT_NAME_RE.test(p)) {
      console.warn(`[C28 soft] 文件名可疑: ${p}`);
      warns++;
    }
  }
  if (warns === 0) {
    console.log(`✓ C28 soft：${paths.length} 路径无文件名可疑词`);
  } else {
    console.warn(`[C28 soft] 共 ${warns} 条 warn（不阻断 exit）`);
  }
  return 0;
}

// ─── main ────────────────────────────────────────────────────────────────────

function printUsage() {
  console.error(`用法: node scripts/check-c28-scope.mjs <whitelist|doc-guard|soft|all>
环境: C28_BASE（默认 v1.5.9）; C28_ALLOW=1 旁路 whitelist 硬失败（禁止用于 DoD）`);
}

function main() {
  const cmd = process.argv[2];
  if (!cmd || !['whitelist', 'doc-guard', 'soft', 'all'].includes(cmd)) {
    printUsage();
    process.exit(1);
  }

  let code = 0;
  if (cmd === 'whitelist') {
    code = runWhitelist();
  } else if (cmd === 'doc-guard') {
    code = runDocGuard();
  } else if (cmd === 'soft') {
    code = runSoft();
  } else if (cmd === 'all') {
    // soft 不进 all 的 exit 码
    const w = runWhitelist();
    const d = runDocGuard();
    code = w !== 0 || d !== 0 ? 1 : 0;
  }

  process.exit(code);
}

main();
