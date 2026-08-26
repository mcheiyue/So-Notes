#!/usr/bin/env node
/**
 * DoD #18 可执行脚本门（v1.6.1 Commit 5a）
 *
 * 失败 exit 1 + 明确 fail reason。
 * 半交付（仅 Commit2 无 pin）→ exit 1；完整 2+3 同树 → exit 0。
 *
 * 规格真源：docs/plans/v1.6.1-webdav-ssrf-hardening.md §11 #18
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
// FIX-GATE：webdav 已拆为目录模块（3e007f0）。本脚本为子串/正则断言（含 pin 测名，
// 位于 tests.rs），语料取目录下全部 .rs 拼接。
const WEBDAV_DIR = join(REPO_ROOT, 'src-tauri/src/webdav');

function main() {
  let src;
  try {
    src = readdirSync(WEBDAV_DIR)
      .filter((f) => f.endsWith('.rs'))
      .sort()
      .map((f) => readFileSync(join(WEBDAV_DIR, f), 'utf-8'))
      .join('\n');
  } catch (e) {
    console.error(`FAIL DoD#18: 无法读取 webdav 目录模块: ${e.message}`);
    process.exit(1);
  }

  const fails = [];

  // 1) Commit3 必需符号/测名
  const need = [
    'fn resolve_and_check',
    'resolve_to_addrs',
    'rebinding_pins_first_resolve',
    'redirect_same_host_only',
    'redirect_rejects_different_port',
    'request_url_host_equals_pin_key',
    'trait HostResolver',
    'struct SystemResolver',
  ];
  for (const k of need) {
    if (!src.includes(k)) fails.push(`missing required: ${k}`);
  }

  // 2) 禁止半交付：有 HostResolver 生产接线却无 pin
  if (src.includes('trait HostResolver') && !src.includes('resolve_to_addrs')) {
    fails.push('half-delivery: HostResolver without resolve_to_addrs');
  }

  // 3) 旧 fail-open 路径必须清除
  if (src.includes('host_resolves_to_disallowed_webdav_ip')) {
    fails.push('forbidden leftover: host_resolves_to_disallowed_webdav_ip');
  }

  // 4) 自比较占位不得作为 main 终态
  if (
    /validate_webdav_redirect_url\s*\(\s*[^,]+,\s*host_str/.test(src) &&
    !src.includes('canonical_host')
  ) {
    fails.push(
      'half-delivery: redirect still self-compare host_str without canonical_host',
    );
  }

  // 5) 旧单参 validate 签名残留（定义处）
  if (/fn\s+validate_webdav_redirect_url\s*\(\s*url\s*:\s*&Url\s*\)/.test(src)) {
    fails.push('old signature: validate_webdav_redirect_url(&Url) still present');
  }

  // 6) pin 测名必须像真实 #[test] fn（禁注释-only 字符串假绿）
  if (
    !/#\[test\][\s\S]{0,400}?fn\s+rebinding_pins_first_resolve/.test(src) &&
    !/fn\s+rebinding_pins_first_resolve\s*\(/.test(src)
  ) {
    fails.push('rebinding_pins_first_resolve missing as compilable test fn');
  }

  // 7) resolve_to_addrs 须落在 build_webdav_http_client 邻近窗口
  if (!/fn\s+build_webdav_http_client[\s\S]{0,5000}?resolve_to_addrs/.test(src)) {
    fails.push(
      'resolve_to_addrs not wired near build_webdav_http_client (half-delivery)',
    );
  }

  if (fails.length) {
    console.error(`FAIL DoD#18:\n- ${fails.join('\n- ')}`);
    process.exit(1);
  }

  console.log('OK DoD#18: Commit2+3 同树完整，无半交付组合');
  process.exit(0);
}

main();
