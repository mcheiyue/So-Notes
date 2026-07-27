#!/usr/bin/env node
/**
 * C-W1 源码门禁：normalize_webdav_url 函数体禁止 DNS / resolve 流水线
 * 规格真源：docs/plans/v1.6.1-webdav-ssrf-hardening.md §5.2 P0-8 / L1947–1967
 *
 * CLI：node scripts/check-normalize-no-dns.mjs [文件路径]
 * 默认：src-tauri/src/webdav.rs；exit 0 通过 / exit 1 违规
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const FORBIDDEN_SYMBOLS = [
  'to_socket_addrs',
  'resolve_and_check',
  'reject_internal_https_host',
  'SystemResolver',
  'HostResolver',
  'resolve_and_pin',
  'host_resolves_',
  'resolve_and_',
];

/** 允许的 callee 白名单（函数名片段；用于粗检自定义 helper） */
const ALLOWED_CALLEE_HINTS = [
  'Url::parse',
  'is_disallowed_webdav_ip',
  'reject_disallowed_https_ip',
  'is_http_localhost_exception',
  'format!',
  'trim',
  'to_ascii_lowercase',
  'strip_prefix',
  'strip_suffix',
  'eq_ignore_ascii_case',
  'trim_end_matches',
  'starts_with',
  'ends_with',
  'push_str',
  'pop',
  'is_empty',
  'is_some',
  'is_none',
  'unwrap_or',
  'ok_or_else',
  'map_err',
  'to_string',
  'len',
];

/**
 * 大括号匹配提取完整函数体
 * @param {string} src
 * @param {string} name
 * @returns {string|null}
 */
function extractFnBody(src, name) {
  const startRe = new RegExp(`(?:pub\\s+)?fn\\s+${name}\\s*\\(`);
  const m = startRe.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 1;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  while (i < src.length && src[i] !== '{') i++;
  if (i >= src.length || src[i] !== '{') return null;
  let brace = 0;
  const start = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') brace++;
    else if (src[i] === '}') {
      brace--;
      if (brace === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function main() {
  const fileArg = process.argv[2];
  const webdavPath = fileArg
    ? resolve(process.cwd(), fileArg)
    : join(REPO_ROOT, 'src-tauri/src/webdav.rs');

  let src;
  try {
    src = readFileSync(webdavPath, 'utf-8');
  } catch (e) {
    console.error(`FAIL check-normalize-no-dns: 无法读取 ${webdavPath}: ${e.message}`);
    process.exit(1);
  }

  const body = extractFnBody(src, 'normalize_webdav_url');
  if (!body) {
    console.error('FAIL: 无法提取 normalize_webdav_url 函数体（brace-match）');
    process.exit(1);
  }

  const fails = [];

  for (const sym of FORBIDDEN_SYMBOLS) {
    if (body.includes(sym)) {
      fails.push(`FORBIDDEN symbol in normalize_webdav_url body: ${sym}`);
    }
  }

  // 间接 DNS：*.resolve( 调用
  if (/\.resolve\s*\(/.test(body)) {
    fails.push('FORBIDDEN: .resolve( call in normalize_webdav_url body');
  }

  // 粗检：调用 reject_* / host_* / resolve_* 非白名单 helper
  const callRe = /\b([a-z_][a-z0-9_]*)\s*\(/gi;
  let cm;
  while ((cm = callRe.exec(body)) !== null) {
    const name = cm[1];
    // 跳过控制流 / 标准构造
    if (
      [
        'if',
        'match',
        'while',
        'for',
        'loop',
        'return',
        'Ok',
        'Err',
        'Some',
        'None',
        'format',
        'vec',
        'String',
        'Url',
        'Host',
        'IpAddr',
        'Ipv4',
        'Ipv6',
        'Domain',
      ].includes(name)
    ) {
      continue;
    }
    if (
      name.startsWith('reject_') &&
      name !== 'reject_disallowed_https_ip'
    ) {
      fails.push(`FORBIDDEN non-whitelist callee: ${name}()`);
    }
    if (name.startsWith('host_resolves') || name.startsWith('resolve_and')) {
      fails.push(`FORBIDDEN DNS helper callee: ${name}()`);
    }
    if (name === 'to_socket_addrs') {
      fails.push(`FORBIDDEN callee: ${name}()`);
    }
  }

  // 白名单存在性提示（不强制每个都出现）
  void ALLOWED_CALLEE_HINTS;

  if (fails.length) {
    console.error(`FAIL check-normalize-no-dns:\n- ${fails.join('\n- ')}`);
    process.exit(1);
  }

  console.log('OK check-normalize-no-dns: normalize_webdav_url 无 DNS / 禁止符号');
  process.exit(0);
}

main();
