#!/usr/bin/env node
/**
 * C-D68 范围纪律 SSOT（v1.6.8 Commit 5a）
 *
 * 用法：
 *   node scripts/check-c68-scope.mjs whitelist   // 白名单硬门
 *   node scripts/check-c68-scope.mjs doc-guard   // 文档守卫
 *   node scripts/check-c68-scope.mjs soft        // 软扫描；仅 warn，exit 0
 *   node scripts/check-c68-scope.mjs all         // whitelist + doc-guard（硬；soft 不进）
 *   node scripts/check-c68-scope.mjs ops-hard    // ops.rs 内容硬门（webdav L703 仅 map_err 一行）
 *
 * 环境：
 *   C68_BASE  默认 'v1.6.7'（git diff 三点对比基线）
 *   C68_ALLOW=1 时 whitelist 可旁路 exit 0（仍 console.warn）；DoD 不得用 ALLOW 顶替
 *
 * 规格真源：docs/plans/v1.6.8-coordinator-lifecycle-and-lock-semantics.md §5.4
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// ─── 白名单（精确文件 + 前缀）────────────────────────────────────────────────

/** 精确允许的路径（posix） */
const EXACT_ALLOWED = new Set([
  'src/services/backup/BackupJobCoordinator.ts',
  'src/services/backup/BackupJobCoordinator.test.ts',
  'src/services/backup/RetentionCleanupOrchestrator.ts',
  'src/services/backup/RetentionCleanupOrchestrator.test.ts',
  'src/services/backup/quitHandler.ts',
  'src/services/backup/quitHandler.test.ts',
  'src/controllers/appController.ts',
  'src/controllers/appController.test.ts',
  'docs/adr/0002-three-layer-lock-semantics.md',
  'docs/qa/v1.6.8-smoke-baseline.md',
  'scripts/check-smoke-baseline.mjs',
  'scripts/check-cw7-entry-order.mjs',
  'scripts/check-dod18-commit2-3.mjs',
  'scripts/check-c68-scope.mjs',
  'package.json',
  'package-lock.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/src/webdav/ssrf.rs',
  'src-tauri/src/webdav/error.rs',
  'src-tauri/src/webdav/transport.rs',
  'src-tauri/src/webdav/ops.rs',
  'src-tauri/src/webdav/tests.rs',
  'CHANGELOG.md',
]);

/** 允许前缀 */
const PREFIX_ALLOWED = ['docs/plans/v1.6.8-', 'docs/adr/'];

/** 软扫描文件名可疑词（仅 warn） */
const SOFT_NAME_RE =
  /tag|Tag|sync|Sync|sqlite|SQLite|libsql|template|Template|color|折叠|domainStore|appController|Canvas\.tsx|legacyDomainBridge|webdav|backup\.rs|BoardDock|合并三层锁|confirmStore/;

/** 文档守卫扫描文件 */
const DOC_GUARD_FILES = [
  'docs/plans/v1.6.8-coordinator-lifecycle-and-lock-semantics.md',
  'docs/adr/0002-three-layer-lock-semantics.md',
];

/** heading 豁免子串（大小写不敏感；豁免子树） */
const HEADING_EXEMPT = [
  'Non-goals',
  'Out of Scope',
  'C-D68',
  '范围纪律',
  '无法自动证明',
  '变更记录',
  '风险与对策',
  '明确不做',
  // 5a 不能改 plan/ADR：既有正文在这些 heading 自毒（反向 rg / Non-goal 引述 / CHANGELOG 披露）
  '约束清单',
  '上下文',
  '状态字声明',
  'Commit 5b',
];

/** 产品范围夹带（本版固定，仅文档守卫） */
const PRODUCT_SCOPE_SOURCE =
  '合并三层锁|统一单一锁源|合并 confirmStore|R3 已修复|R3 已统一|标签系统|SQLite|libSQL|WebDAV 上传策略|定时备份策略变更';

const OPS_RS = 'src-tauri/src/webdav/ops.rs';

const VALID_CMDS = ['whitelist', 'doc-guard', 'soft', 'all', 'ops-hard'];

// ─── 工具 ────────────────────────────────────────────────────────────────────

function posixPath(p) {
  return String(p).replace(/\\/g, '/');
}

function getBase() {
  return process.env.C68_BASE && process.env.C68_BASE.trim()
    ? process.env.C68_BASE.trim()
    : 'v1.6.7';
}

function isAllowEnabled() {
  return process.env.C68_ALLOW === '1';
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
      `[C68 doc-guard] 无法读取 ${smokePath}: ${e.message}`,
    );
    process.exit(1);
  }
  const m = text.match(
    /const\s+SYNC_BANNED\s*=\s*\/((?:\\.|[^/\\])+)\/([a-z]*)/,
  );
  if (!m) {
    console.error(
      '[C68 doc-guard] 无法从 check-smoke-baseline.mjs 提取 const SYNC_BANNED = /.../',
    );
    process.exit(1);
  }
  return { body: m[1], flags: m[2] || '' };
}

/**
 * hardenSyncBanned：与 v1.6.0 C28 同规则
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
  const f = flags.includes('i') ? flags : `${flags}i`;
  return new RegExp(transformed.join('|'), f);
}

function buildDocBannedRegex() {
  const { body, flags } = extractSyncBannedLiteral();
  const hardened = hardenSyncBanned(body, flags);
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
  return false;
}

/**
 * git diff --name-only ${C68_BASE}...HEAD
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
      `[C68 whitelist] git diff --name-only ${base}...HEAD 失败: ${msg}`,
    );
    process.exit(1);
  }
}

function gitDiff(args) {
  const base = getBase();
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const msg = e.stderr || e.message || String(e);
    console.error(`[C68] git ${args.join(' ')} 失败: ${msg}`);
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
      `✓ C68 whitelist：相对 ${base} 共 ${paths.length} 路径全部在白名单内`,
    );
    return 0;
  }

  console.error(`\n[C68 whitelist] 相对 ${base} 发现非白名单路径（${bad.length}）：`);
  for (const p of bad) {
    console.error(`  ✗ ${p}`);
  }

  if (isAllowEnabled()) {
    console.warn(
      '[C68 whitelist] C68_ALLOW=1：旁路 exit 0（DoD / 发布不得计此结果）',
    );
    return 0;
  }

  console.error(
    '\n硬门失败：修复范围或临时调试可设 C68_ALLOW=1（禁止用于 DoD）',
  );
  return 1;
}

// ─── doc-guard ───────────────────────────────────────────────────────────────

/**
 * 按 markdown heading 分段，代码围栏内跳过（不解析 #、不扫 banned）
 * 豁免子树：祖先 heading 命中豁免表则本段也豁免
 * 返回 { heading, body, startLine, exempt }[]
 */
function segmentByHeading(content) {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const segments = [];
  let inFence = false;
  let current = { heading: '(root)', level: 0, bodyLines: [], startLine: 1, exempt: false };
  const stack = [{ level: 0, exempt: false }];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      continue;
    }

    const hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      segments.push({
        heading: current.heading,
        body: current.bodyLines.join('\n'),
        startLine: current.startLine,
        exempt: current.exempt,
      });
      const level = hm[1].length;
      const heading = hm[2].trim();
      while (stack.length && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      const selfExempt = isHeadingExempt(heading, HEADING_EXEMPT);
      const inherited = stack.some((s) => s.exempt);
      const exempt = selfExempt || inherited;
      stack.push({ level, exempt });
      current = {
        heading,
        level,
        bodyLines: [line],
        startLine: lineNo,
        exempt,
      };
      continue;
    }

    current.bodyLines.push(line);
  }

  segments.push({
    heading: current.heading,
    body: current.bodyLines.join('\n'),
    startLine: current.startLine,
    exempt: current.exempt,
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

    const segments = segmentByHeading(text);
    for (const seg of segments) {
      if (seg.exempt) continue;
      // 围栏外仍跳过行内 `code`（tokio::sync::Mutex / rg 字面等）
      const bodyForScan = seg.body.replace(/`[^`\n]*`/g, ' ');
      const m = bodyForScan.match(banned);
      if (m) {
        errors.push(
          `[${rel}] 非豁免段 heading="${seg.heading.slice(0, 60)}" (≈L${seg.startLine}) 命中 banned: "${m[0]}"`,
        );
      }
    }
  }

  if (errors.length === 0) {
    console.log(
      `✓ C68 doc-guard：${DOC_GUARD_FILES.length} 个文档无非豁免 banned 命中`,
    );
    return 0;
  }

  console.error('\n[C68 doc-guard] 失败:');
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
      console.warn(`[C68 soft] 文件名可疑: ${p}`);
      warns++;
    }
  }
  if (warns === 0) {
    console.log(`✓ C68 soft：${paths.length} 路径无文件名可疑词`);
  } else {
    console.warn(`[C68 soft] 共 ${warns} 条 warn（不阻断 exit）`);
  }
  return 0;
}

// ─── ops-hard ────────────────────────────────────────────────────────────────

function runOpsHard() {
  const base = getBase();
  const raw = gitDiff(['diff', `${base}...HEAD`, '--', OPS_RS]);
  const diff = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const hunks = diff.split('\n@@').length - 1;
  if (hunks !== 1) {
    console.error(
      `[C68 ops-hard] ${OPS_RS} 相对 ${base} hunks=${hunks}（须恰好 1）`,
    );
    return 1;
  }
  const changed = diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'));
  if (changed.length !== 1 || !changed[0].includes('map_err')) {
    console.error(
      `[C68 ops-hard] 新增行须恰好 1 且含 map_err；实际 ${changed.length} 行: ${JSON.stringify(changed)}`,
    );
    return 1;
  }
  console.log(`✓ C68 ops-hard：${OPS_RS} 恰 1 hunk / 1 行 map_err`);
  return 0;
}

// ─── main ────────────────────────────────────────────────────────────────────

function printUsage() {
  console.error(`用法: node scripts/check-c68-scope.mjs <whitelist|doc-guard|soft|all|ops-hard>
环境: C68_BASE（默认 v1.6.7）; C68_ALLOW=1 旁路 whitelist 硬失败（禁止用于 DoD）`);
}

function main() {
  const cmd = process.argv[2];
  if (!cmd || !VALID_CMDS.includes(cmd)) {
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
  } else if (cmd === 'ops-hard') {
    code = runOpsHard();
  } else if (cmd === 'all') {
    const w = runWhitelist();
    const d = runDocGuard();
    code = w !== 0 || d !== 0 ? 1 : 0;
  }

  process.exit(code);
}

main();
