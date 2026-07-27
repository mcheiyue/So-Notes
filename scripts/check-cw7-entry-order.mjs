#!/usr/bin/env node
/**
 * C-W7 可执行门：五入口 brace-match + 先 pin 再请求 + Client::builder 硬门
 * （v1.6.1 Commit 5a）
 *
 * 规格真源：docs/plans/v1.6.1-webdav-ssrf-hardening.md §4.1 C-W7
 * 失败 → process.exit(1)
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const WEBDAV = join(REPO_ROOT, 'src-tauri/src/webdav.rs');

/**
 * 大括号匹配提取完整函数体（禁止固定 1200 字符窗口）
 * @param {string} src
 * @param {string} name
 * @returns {string|null}
 */
function extractFnBody(src, name) {
  const startRe = new RegExp(`fn\\s+${name}\\s*\\(`);
  const m = startRe.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length;
  // 跳过参数列表到函数体 '{'
  let depth = 1; // 已在 '(' 内
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
  let src;
  try {
    src = readFileSync(WEBDAV, 'utf-8');
  } catch (e) {
    console.error(`FAIL C-W7: 无法读取 webdav.rs: ${e.message}`);
    process.exit(1);
  }

  const entries = [
    'webdav_test_connection',
    'webdav_list_backups',
    'webdav_delete_backup',
    'webdav_create_remote_backup',
    'webdav_download_backup',
  ];

  for (const name of entries) {
    const body = extractFnBody(src, name);
    if (!body) {
      console.error(`FAIL: 无法提取函数体 ${name}`);
      process.exit(1);
    }

    if (!body.includes('build_webdav_http_client')) {
      console.error(`FAIL: ${name} 未调用 build_webdav_http_client`);
      process.exit(1);
    }

    // trust_host 透传：形态 1 或形态 2
    const hasLetTrust =
      /let\s+trust_host\s*=\s*false\s*;/.test(body) &&
      /build_webdav_http_client\s*\([\s\S]*trust_host/.test(body);
    const hasLiteralFalse =
      /build_webdav_http_client\s*\([^;]*false\s*\)/.test(body) &&
      (body.includes('SystemResolver') || body.includes('Arc::new'));
    if (!hasLetTrust && !hasLiteralFalse) {
      console.error(
        `FAIL: ${name} 未透传 trust_host（需 let trust_host=false 或字面量 false+SystemResolver）`,
      );
      process.exit(1);
    }

    if (!body.includes('SystemResolver') && !/Arc::new/.test(body)) {
      console.error(`FAIL: ${name} 未构造 SystemResolver/Arc resolver`);
      process.exit(1);
    }

    // C-W7 顺序：client 调用文本序 < request_target（若有）
    const clientIdx = body.indexOf('build_webdav_http_client');
    const targetIdx = body.indexOf('build_webdav_request_target');
    if (targetIdx >= 0 && !(clientIdx >= 0 && clientIdx < targetIdx)) {
      console.error(
        `FAIL: ${name} 顺序违规：build_webdav_http_client 必须文本序先于 build_webdav_request_target`,
      );
      process.exit(1);
    }
  }

  // 工厂：resolve_to_addrs + Client::builder
  const factoryBody = extractFnBody(src, 'build_webdav_http_client') || '';
  if (!/fn\s+build_webdav_http_client/.test(src) || !/resolve_to_addrs/.test(src)) {
    console.error('FAIL: 缺少 build_webdav_http_client 或 resolve_to_addrs');
    process.exit(1);
  }
  if (!/Client::builder/.test(factoryBody)) {
    console.error('FAIL: 工厂内无 Client::builder 接线');
    process.exit(1);
  }
  // 工厂体内须含 resolve_to_addrs（pin 接线）
  if (!factoryBody.includes('resolve_to_addrs')) {
    console.error('FAIL: 工厂体内无 resolve_to_addrs（pin 未接线）');
    process.exit(1);
  }

  // 工厂外 Client::new/builder 仅允许 #[cfg(test)] 后
  const cfgTestAt = src.lastIndexOf('#[cfg(test)]');
  const fs0 = factoryBody ? src.indexOf(factoryBody) : -1;
  for (const hit of src.matchAll(/reqwest::Client::(?:new|builder)\s*\(/g)) {
    const pos = hit.index ?? -1;
    const inFactory =
      fs0 >= 0 && pos >= fs0 && pos < fs0 + factoryBody.length;
    const inTest = cfgTestAt >= 0 && pos > cfgTestAt;
    if (!inFactory && !inTest) {
      console.error(`FAIL: 工厂外出现 Client::new/builder @${pos}`);
      process.exit(1);
    }
  }

  console.log(
    'OK: 五入口 brace-match trust_host 透传 + C-W7 顺序 + Client::builder 硬门',
  );
  process.exit(0);
}

main();
