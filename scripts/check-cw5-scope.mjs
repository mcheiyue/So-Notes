#!/usr/bin/env node
/**
 * C-W5 范围纪律 SSOT（v1.6.1 Commit 5a）
 *
 * 用法：
 *   node scripts/check-cw5-scope.mjs whitelist   // 白名单硬门
 *   node scripts/check-cw5-scope.mjs doc-guard   // 文档守卫
 *   node scripts/check-cw5-scope.mjs soft        // 非白名单仅 warn，exit 0
 *   node scripts/check-cw5-scope.mjs all         // whitelist + doc-guard（硬；soft 不进）
 *
 * 环境：
 *   CW5_BASE  默认 'v1.6.0'（git diff 三点对比基线；禁止固定短窗口）
 *   CW5_ALLOW=1 时 whitelist 可旁路 exit 0（仍 console.warn）；DoD 不得用 ALLOW 顶替
 *   CW5_INJECT_PATHS  逗号分隔路径，并入 changed 列表（真实负向注入）
 *   CW5_INJECT_DOC_HIT=1  在 doc-guard 扫描中注入一条禁用词命中（负向）
 *
 * 规格真源：docs/plans/v1.6.1-webdav-ssrf-hardening.md §5.7
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// ─── 白名单（§5.7 精确路径）────────────────────────────────────────────────

/** 精确允许的路径（posix）— 名 CW5_WHITELIST 供结构验收 includes */
const CW5_WHITELIST = new Set([
  'src-tauri/src/webdav.rs',
  'src/services/backup/WebDavBackupService.ts',
  'src/components/BoardDock.tsx',
  'src/components/BoardDock.test.tsx',
  'src/services/backup/ScheduledRemoteBackupService.ts',
  'src/components/ScheduledRemoteBackupController.tsx',
  'CHANGELOG.md',
  'package.json',
  'package-lock.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
  'scripts/check-normalize-no-dns.mjs',
  'scripts/check-cw5-scope.mjs',
  'scripts/check-dod18-commit2-3.mjs',
  'scripts/check-cw7-entry-order.mjs',
  'scripts/run-v161-dod.mjs',
]);

/** 允许前缀 */
const CW5_PLAN_PREFIX = 'docs/plans/v1.6.1-';

/** 文档守卫禁用词（嵌入脚本为唯一真源） */
const CW5_DOC_BANNED = [
  '多 A 记录逐个尝试连接',
  '跨 host redirect 兼容性交付',
];

/**
 * soft 子命令 warn 用词（文件名可疑）；不导致 all exit 1
 * ponytail: 空表时 soft 仅对非白名单路径 warn
 */
const CW5_SOFT = [];

/** 豁免 heading 子串（大小写不敏感） */
const DOC_EXEMPT = [
  'Non-goals',
  '偏差记录',
  '无法自动证明',
  '决策记录',
  'Decision',
  '变更记录',
  '风险与对策',
];

// ─── 工具 ────────────────────────────────────────────────────────────────────

function posixPath(p) {
  return normalize(String(p)).replace(/\\/g, '/');
}

function getBase() {
  // CW5_BASE 默认 v1.6.0
  return process.env.CW5_BASE && process.env.CW5_BASE.trim()
    ? process.env.CW5_BASE.trim()
    : 'v1.6.0';
}

function isAllowEnabled() {
  return process.env.CW5_ALLOW === '1';
}

function pathAllowed(path) {
  const p = posixPath(path);
  if (CW5_WHITELIST.has(p)) return true;
  if (p.startsWith(CW5_PLAN_PREFIX)) return true;
  return false;
}

/**
 * git diff --name-only ${CW5_BASE}...HEAD + CW5_INJECT_PATHS
 * @returns {string[]}
 */
function getChangedPaths() {
  const base = getBase();
  let paths = [];
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
    paths = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map(posixPath);
  } catch (e) {
    const msg = e.stderr || e.message || String(e);
    console.error(
      `[CW5 whitelist] git diff --name-only ${base}...HEAD 失败: ${msg}`,
    );
    process.exit(1);
  }

  // 真实负向注入：CW5_INJECT_PATHS 逗号分隔
  const inject = process.env.CW5_INJECT_PATHS;
  if (inject && inject.trim()) {
    for (const part of inject.split(',')) {
      const p = posixPath(part.trim());
      if (p) paths.push(p);
    }
  }

  return paths;
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
      `✓ CW5 whitelist：相对 ${base} 共 ${paths.length} 路径全部在白名单内`,
    );
    return 0;
  }

  console.error(`\n[CW5 whitelist] 相对 ${base} 发现非白名单路径（${bad.length}）：`);
  for (const p of bad) {
    console.error(`  ✗ ${p}`);
  }

  if (isAllowEnabled()) {
    console.warn(
      '⚠️ CW5_ALLOW=1：旁路模式，不得计入 DoD',
    );
    return 0;
  }

  console.error(
    '\n硬门失败：修复范围或临时调试可设 CW5_ALLOW=1（禁止用于 DoD）',
  );
  return 1;
}

// ─── doc-guard ───────────────────────────────────────────────────────────────

/**
 * 按 markdown heading 分段，代码围栏内跳过
 * @returns {{ heading: string, body: string, startLine: number }[]}
 */
function segmentByHeading(content) {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const segments = [];
  let inFence = false;
  let current = { heading: '(root)', bodyLines: [], startLine: 1 };

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
      });
      current = {
        heading: hm[2].trim(),
        bodyLines: [line],
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

function isHeadingExempt(heading) {
  const h = heading.toLowerCase();
  return DOC_EXEMPT.some((ex) => h.includes(ex.toLowerCase()));
}

function listPlanDocs() {
  const dir = join(REPO_ROOT, 'docs/plans');
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    console.error(`[CW5 doc-guard] 无法读取 docs/plans: ${e.message}`);
    process.exit(1);
  }
  return names
    .filter((n) => n.startsWith('v1.6.1-') && n.endsWith('.md'))
    .map((n) => `docs/plans/${n}`);
}

function runDocGuard() {
  const errors = [];
  const files = listPlanDocs();

  // 负向夹具：注入禁用词命中
  if (process.env.CW5_INJECT_DOC_HIT === '1') {
    errors.push(
      `[inject] CW5_INJECT_DOC_HIT=1 模拟命中 banned: "${CW5_DOC_BANNED[0]}"`,
    );
  }

  for (const rel of files) {
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
      if (isHeadingExempt(seg.heading)) continue;
      for (const banned of CW5_DOC_BANNED) {
        if (seg.body.includes(banned)) {
          errors.push(
            `[${rel}] 非豁免段 heading="${seg.heading.slice(0, 60)}" (≈L${seg.startLine}) 命中 banned: "${banned}"`,
          );
        }
      }
    }
  }

  if (errors.length === 0) {
    console.log(
      `✓ CW5 doc-guard：${files.length} 个文档无非豁免 banned 命中`,
    );
    return 0;
  }

  console.error('\n[CW5 doc-guard] 失败:');
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
    if (!pathAllowed(p)) {
      console.warn(`[CW5 soft] 非白名单: ${p}`);
      warns++;
    }
    for (const word of CW5_SOFT) {
      if (p.includes(word)) {
        console.warn(`[CW5 soft] 文件名可疑词 "${word}": ${p}`);
        warns++;
      }
    }
  }
  if (warns === 0) {
    console.log(`✓ CW5 soft：${paths.length} 路径无 warn`);
  } else {
    console.warn(`[CW5 soft] 共 ${warns} 条 warn（不阻断 exit）`);
  }
  return 0;
}

// ─── main ────────────────────────────────────────────────────────────────────

function printUsage() {
  console.error(`用法: node scripts/check-cw5-scope.mjs <whitelist|doc-guard|soft|all>
环境: CW5_BASE（默认 v1.6.0）; CW5_ALLOW=1 旁路 whitelist 硬失败（禁止用于 DoD）; CW5_INJECT_PATHS 负向注入`);
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
