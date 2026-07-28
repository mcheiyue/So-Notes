#!/usr/bin/env node
/**
 * v1.6.1 DoD #1–6 全量重跑（Commit 5b）
 * 真源：docs/plans/v1.6.1-webdav-ssrf-hardening.md §6 Commit1/2/3/4 + §14 Day0 + check-cw7
 * 任一步失败 → process.exit(1)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TMP = join(ROOT, 'src-tauri', '.tmp');
const PASS_RE = /test result: ok\.\s*1 passed; 0 failed/;

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    encoding: 'utf8',
    shell: true,
    env: opts.env ?? process.env,
    ...opts,
  });
}

function ensureTmp() {
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
  const front = join(ROOT, '.tmp');
  if (!existsSync(front)) mkdirSync(front, { recursive: true });
}

/** cargo --lib webdav::tests::<name> -- --exact；断言 1 passed; 0 failed */
function cargoExact(name, tag = '') {
  const r = run('cargo', ['test', '--lib', `webdav::tests::${name}`, '--', '--exact', '--nocapture'], {
    cwd: join(ROOT, 'src-tauri'),
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const prefix = tag ? `${tag}_` : '';
  writeFileSync(join(TMP, `${prefix}${name}.out`), out);
  if (!PASS_RE.test(out)) {
    console.error(`FAIL${tag ? ` ${tag}` : ''}: ${name}`);
    console.error(out.slice(-1200));
    process.exit(1);
  }
  console.log(`OK${tag ? ` ${tag}` : ''}`, name);
}

function nodeScript(relPath) {
  // shell:false — Windows 上 process.execPath 常含空格（Program Files）
  const r = spawnSync(process.execPath, [join(ROOT, relPath)], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  if (out) process.stdout.write(out);
  if (r.status !== 0) {
    console.error(`FAIL: ${relPath} exit ${r.status}`);
    process.exit(1);
  }
}

// ── DoD #1 Commit 1：S2 IP 扩展 10 新 + 2 回归 ──
const COMMIT1 = [
  'disallowed_ip_check_cgnat',
  'disallowed_ip_check_test_nets',
  'disallowed_ip_check_reserved_240',
  'disallowed_ip_check_ipv4_multicast_broadcast',
  'disallowed_ip_check_ipv6_multicast_doc',
  'disallowed_ip_check_public_still_allowed',
  'disallowed_ip_check_unspecified_net',
  'disallowed_ip_check_benchmark',
  'disallowed_ip_check_6to4_embedded',
  'disallowed_ip_check_nat64_embedded',
  'disallowed_ip_check_rejects_internal_ranges',
  'disallowed_ip_check_accepts_public_addresses',
];

// ── DoD #2 Commit 2：fail-closed + normalize 回归 ──
const COMMIT2 = [
  'dns_fail_is_closed',
  'dns_fail_with_trust_retries',
  'dns_fail_with_trust_still_rejects_private',
  'dns_fail_with_trust_retry_succeeds',
  'normalize_domain_no_dns',
  'error_sanitization_no_ip_leak',
  'mock_resolver_exhausted_returns_err',
  'disallowed_ip_check_rejects_internal_ranges',
  'disallowed_ip_check_accepts_public_addresses',
  'url_norm_rejects_https_private_ipv4_literal',
  'url_norm_accepts_https_public_ipv4_literal',
  'redirect_guard_accepts_public_https_target',
  'redirect_guard_rejects_http_target',
  'redirect_guard_rejects_https_private_target',
  'redirect_guard_rejects_https_localhost_target',
];

// ── DoD #3+#4 Commit 3：pin + redirect ──
const COMMIT3 = [
  'rebinding_pins_first_resolve',
  'request_url_host_equals_pin_key',
  'redirect_ignores_trust',
  'redirect_same_host_only',
  'redirect_rejects_different_port',
  'redirect_rejects_trailing_dot_host',
  'pin_host_canonicalized',
  'pin_host_trailing_dot',
  'pin_host_ipv6_brackets',
  'pin_chain_canonical_key',
  'redirect_guard_accepts_public_https_target',
  'redirect_guard_rejects_http_target',
  'redirect_guard_rejects_https_private_target',
  'redirect_guard_rejects_https_localhost_target',
  'url_norm_rejects_https_private_ipv4_literal',
  'url_norm_accepts_https_public_ipv4_literal',
];

// ── DoD #5 Commit 4：trust + password/prepare ──
const COMMIT4 = [
  'trust_host_persists_roundtrip',
  'trust_cleared_when_host_changes',
  'trust_set_on_host_change_when_user_opts_in',
  'trust_persists_when_host_same',
  'trust_persists_when_host_case_differs',
  'trust_persists_when_host_trailing_dot',
  'load_password_saved_requires_credential_key',
  'load_password_saved_true_when_key_present',
  'prepare_preserves_credential_when_password_unchanged',
  'trust_host_defaults_false_on_old_config',
  'webdav_config_debug_redacts_password',
  'webdav_config_save_request_debug_redacts_password',
];

// ── DoD #6 Day0 既有回归 8 测 ──
const DAY0 = [
  'disallowed_ip_check_rejects_internal_ranges',
  'disallowed_ip_check_accepts_public_addresses',
  'url_norm_rejects_https_private_ipv4_literal',
  'url_norm_accepts_https_public_ipv4_literal',
  'redirect_guard_accepts_public_https_target',
  'redirect_guard_rejects_http_target',
  'redirect_guard_rejects_https_private_target',
  'redirect_guard_rejects_https_localhost_target',
];

function commit2StaticGates() {
  const s = readFileSync(join(ROOT, 'src-tauri/src/webdav.rs'), 'utf8');
  if (/fn\s+validate_webdav_redirect_url\s*\(\s*url\s*:\s*&Url\s*\)/.test(s)) {
    console.error('FAIL P0-9: old validate signature');
    process.exit(1);
  }
  if (s.includes('host_resolves_to_disallowed_webdav_ip')) {
    console.error('FAIL: host_resolves leftover');
    process.exit(1);
  }
  if (/fn\s+build_webdav_http_client[^{]*reqwest::Error/.test(s)) {
    console.error('FAIL P0-10: client still returns reqwest::Error');
    process.exit(1);
  }
  console.log('OK Commit2 static gates');
}

function commit4WebdavLibAndDebug() {
  const r = run('cargo', ['test', '--lib', 'webdav::', '--', '--nocapture'], {
    cwd: join(ROOT, 'src-tauri'),
  });
  const out = (r.stdout || '') + (r.stderr || '');
  writeFileSync(join(TMP, 'webdav_lib.out'), out);
  if (!/test result: ok\./.test(out) || /FAILED/.test(out)) {
    console.error('FAIL: cargo test --lib webdav::');
    console.error(out.slice(-1200));
    process.exit(1);
  }
  const src = readFileSync(join(ROOT, 'src-tauri/src/webdav.rs'), 'utf8');
  if (/#\[derive\([^\]]*Debug[^\]]*\)\]\s*(?:pub\s+)?struct\s+WebDavConfig\b/.test(src)) {
    console.error('FAIL P0-7 derive Debug WebDavConfig');
    process.exit(1);
  }
  console.log('OK webdav lib + Debug gate');
}

function commit4TrustHostPassthrough() {
  const src = readFileSync(join(ROOT, 'src/components/BoardDock.tsx'), 'utf8');
  const buildFnMatch = src.match(
    /(?:function\s+buildWebdavConfig|const\s+buildWebdavConfig\s*[:=])[\s\S]{0,2000}?return\s*\{[\s\S]{0,800}?\}/,
  );
  if (!buildFnMatch || !/trustHost\s*:/.test(buildFnMatch[0])) {
    console.error('FAIL: buildWebdavConfig 返回对象无 trustHost 字段');
    process.exit(1);
  }
  for (const p of [
    'src/services/backup/ScheduledRemoteBackupService.ts',
    'src/components/ScheduledRemoteBackupController.tsx',
  ]) {
    const t = readFileSync(join(ROOT, p), 'utf8');
    if (!/trustHost/.test(t)) {
      console.error(`FAIL: ${p} 无 trustHost`);
      process.exit(1);
    }
  }
  console.log('OK: trustHost 结构化透传');
}

function vitestIt(filter, outFile, label) {
  const r = run('npx', [
    'vitest',
    'run',
    'src/components/BoardDock.test.tsx',
    '-t',
    filter,
    '--reporter=json',
    `--outputFile=${outFile}`,
  ]);
  // vitest 写 JSON 后仍可能 exit non-0；以 JSON 为准
  let j;
  try {
    j = JSON.parse(readFileSync(join(ROOT, outFile), 'utf8'));
  } catch (e) {
    console.error(`FAIL: ${label} 无法读 JSON`, e.message);
    console.error((r.stdout || '') + (r.stderr || ''));
    process.exit(1);
  }
  const passed = j.numPassedTests ?? 0;
  const failed = j.numFailedTests ?? 0;
  if (!(passed >= 1 && failed === 0)) {
    console.error(`FAIL: ${label}`, passed, failed);
    process.exit(1);
  }
  console.log(`OK: ${label}`, passed);
}

function commit4TrustUiIts() {
  const a = 'webdavDraft 默认 trustHost=false 且 checkbox 文案正确';
  const b = 'buildWebdavConfig 透传 trustHost';
  const s = readFileSync(join(ROOT, 'src/components/BoardDock.test.tsx'), 'utf8');
  if (!s.includes(a)) {
    console.error(`FAIL: 缺 it 全名: ${a}`);
    process.exit(1);
  }
  if (!s.includes(b)) {
    console.error(`FAIL: 缺 it 全名: ${b}`);
    process.exit(1);
  }
  console.log('OK: 两条 trust UI it 全名均在 BoardDock.test.tsx');
  vitestIt(a, '.tmp/boarddock-trust-default.json', 'it1 trust default');
  vitestIt(b, '.tmp/boarddock-trust-passthrough.json', 'it2 trust passthrough');
}

function main() {
  process.chdir(ROOT);
  ensureTmp();

  console.log('=== DoD #1 Commit1 S2 IP ===');
  if (COMMIT1.length !== 12) {
    console.error('FAIL: Commit1 names.length!==12');
    process.exit(1);
  }
  for (const n of COMMIT1) cargoExact(n);

  console.log('=== DoD #2 Commit2 fail-closed ===');
  nodeScript('scripts/check-normalize-no-dns.mjs');
  commit2StaticGates();
  for (const n of COMMIT2) cargoExact(n);

  console.log('=== DoD #3+#4 Commit3 pin+redirect ===');
  for (const n of COMMIT3) cargoExact(n);
  nodeScript('scripts/check-cw7-entry-order.mjs');

  console.log('=== DoD #5 Commit4 trust+password ===');
  for (const n of COMMIT4) cargoExact(n);
  commit4WebdavLibAndDebug();
  commit4TrustHostPassthrough();
  commit4TrustUiIts();

  console.log('=== DoD #6 Day0 regression 8 ===');
  for (const n of DAY0) cargoExact(n, 'Day0');

  console.log('OK run-v161-dod: DoD #1–6 all green');
}

main();
