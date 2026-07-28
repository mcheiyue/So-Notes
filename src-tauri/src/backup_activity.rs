//! 备份活动日志持久化
//!
//! 本模块提供备份活动日志的加载、追加与清除命令。日志文件存储在
//! `app_config_dir()` 下的 `backup-activity-log.json`，采用原子写入
//! 以避免并发写入导致的数据损坏。
//!
//! - 文件路径：`backup-activity-log.json`
//! - 最大条目数：100（超出时移除最旧条目）
//! - Rust 侧脱敏：message 字段自动过滤敏感信息并截断至 240 字符

use fs4::fs_std::FileExt;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::Manager;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/// 日志文件名。
const LOG_FILENAME: &str = "backup-activity-log.json";
const LOCK_FILENAME: &str = "backup-activity-log.lock";

/// 日志文件格式版本。
const LOG_VERSION: u32 = 1;

/// 最大条目数。
const MAX_ENTRIES: usize = 100;
const MAX_FILENAME_LEN: usize = 256;
const MAX_ANOMALY_CODES: usize = 10;
const MAX_ANOMALY_CODE_LEN: usize = 120;

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

/// 备份活动日志文件（顶层包装）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupActivityLogFile {
    version: u32,
    entries: Vec<BackupActivityEntry>,
}

/// 单条备份活动记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupActivityEntry {
    #[serde(default)]
    pub id: Option<String>,
    pub operation: String,
    pub status: String,
    pub level: String,
    pub started_at: i64,
    pub finished_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<BackupActivitySummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<BackupActivityMetrics>,
}

/// 备份活动摘要信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupActivitySummary {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub board_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_note_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_note_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trash_note_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_file_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_file_total_bytes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zip_size_bytes: Option<i64>,
}

/// 备份活动度量指标。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupActivityMetrics {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retained_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missing_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempted_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anomaly_codes: Option<Vec<String>>,
}

// ---------------------------------------------------------------------------
// 文件路径
// ---------------------------------------------------------------------------

/// 获取日志文件路径。
fn log_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取应用配置目录失败: {e}"))?;
    Ok(config_dir.join(LOG_FILENAME))
}

/// 获取锁文件路径（与日志文件同目录，独立文件避免 Windows 上句柄冲突）。
fn lock_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取应用配置目录失败: {e}"))?;
    Ok(config_dir.join(LOCK_FILENAME))
}

// ---------------------------------------------------------------------------
// 原子写入（复用 scheduled_backup.rs 模式）
// ---------------------------------------------------------------------------

/// 临时文件 guard：drop 时清理临时文件。
struct TempFileGuard {
    path: PathBuf,
    armed: bool,
}

impl TempFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// 生成临时文件路径。
fn temp_file_path(path: &Path) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "日志文件路径缺少父目录".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "日志文件名无效".to_string())?;
    Ok(parent.join(format!(".{file_name}.tmp-{:016x}", rand::random::<u64>())))
}

fn backup_file_path(path: &Path) -> PathBuf {
    path.with_extension("json.bak")
}

/// 原子写入：先写临时文件，再 rename 替换目标文件。
fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "日志文件路径缺少父目录".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("创建日志目录失败: {e}"))?;

    let tmp_path = temp_file_path(path)?;
    let mut guard = TempFileGuard::new(tmp_path.clone());

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp_path)
        .map_err(|e| format!("创建临时文件失败: {e}"))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("写入临时文件失败: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("同步临时文件失败: {e}"))?;
    drop(file);

    replace_file(&tmp_path, path).map_err(|e| format!("替换日志文件失败: {e}"))?;
    guard.disarm();
    Ok(())
}

#[cfg(windows)]
fn replace_file(tmp_path: &Path, path: &Path) -> std::io::Result<()> {
    if !path.exists() {
        return std::fs::rename(tmp_path, path);
    }
    // Windows 上 rename 已存在目标会失败：先备份原文件，再 rename，失败时恢复备份
    let backup_path = backup_file_path(path);
    let _ = std::fs::remove_file(&backup_path);
    std::fs::rename(path, &backup_path)?;
    match std::fs::rename(tmp_path, path) {
        Ok(()) => {
            let _ = std::fs::remove_file(&backup_path);
            Ok(())
        }
        Err(e) => {
            let _ = std::fs::rename(&backup_path, path);
            Err(e)
        }
    }
}

#[cfg(not(windows))]
fn replace_file(tmp_path: &Path, path: &Path) -> std::io::Result<()> {
    std::fs::rename(tmp_path, path)
}

// ---------------------------------------------------------------------------
// 脱敏处理
// ---------------------------------------------------------------------------

/// 敏感词 SSOT（与前端 `src/shared/sensitive-words.json` 共用；构建期嵌入）。
const SENSITIVE_WORDS_JSON: &str =
    include_str!("../../src/shared/sensitive-words.json");

/// 敏感关键词列表（小写匹配；来自 SSOT JSON 字符串数组）。
fn sensitive_keywords() -> &'static [String] {
    static KEYWORDS: OnceLock<Vec<String>> = OnceLock::new();
    KEYWORDS.get_or_init(|| {
        serde_json::from_str::<Vec<String>>(SENSITIVE_WORDS_JSON).unwrap_or_else(|e| {
            panic!("sensitive-words.json 必须是字符串数组: {e}");
        })
    })
}

/// 合法的 operation 枚举值（与 TS 侧 BackupActivityOperation 对齐）。
const VALID_OPERATIONS: &[&str] = &[
    "local-backup",
    "local-restore",
    "remote-backup",
    "remote-list",
    "remote-delete",
    "remote-restore",
    "scheduled-remote-backup",
    "retention-cleanup",
    "retention-cliff-drop",
    "credential-status",
];

/// 合法的 status 枚举值（与 TS 侧 BackupActivityStatus 对齐）。
const VALID_STATUSES: &[&str] = &["success", "failed", "skipped", "partial", "cancelled"];

/// 合法的 level 枚举值（与 TS 侧 BackupActivityLevel 对齐）。
const VALID_LEVELS: &[&str] = &["info", "warning", "error"];

fn sensitive_value_end(line: &str, start: usize) -> usize {
    let rest = &line[start..];
    // 引号包裹的值：消费到配对引号（含引号），避免 password="a b c" 只脱敏首段
    if let Some(stripped) = rest.strip_prefix('"') {
        return stripped
            .find('"')
            .map(|i| start + 1 + i + 1)
            .unwrap_or(line.len());
    }
    if let Some(stripped) = rest.strip_prefix('\'') {
        return stripped
            .find('\'')
            .map(|i| start + 1 + i + 1)
            .unwrap_or(line.len());
    }
    rest.find(|c: char| c.is_whitespace() || c == ',' || c == ';' || c == '，' || c == '。')
        .map(|i| start + i)
        .unwrap_or(line.len())
}

fn natural_language_value_start(line: &str, after_keyword: usize) -> Option<usize> {
    let rest = &line[after_keyword..];
    if let Some(after_copula) = rest.strip_prefix('是') {
        let value_start = after_keyword + '是'.len_utf8();
        return after_copula
            .find(|c: char| !c.is_whitespace())
            .map(|i| value_start + i);
    }

    let whitespace_end = rest
        .find(|c: char| !c.is_whitespace())
        .map(|i| after_keyword + i)?;
    let words = &line[whitespace_end..];
    for copula in ["is", "was"] {
        if words
            .get(..copula.len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(copula))
            && words
                .get(copula.len()..)
                .and_then(|rest| rest.chars().next())
                .is_some_and(char::is_whitespace)
        {
            let value_region = whitespace_end + copula.len();
            return line[value_region..]
                .find(|c: char| !c.is_whitespace())
                .map(|i| value_region + i);
        }
    }

    None
}

fn ascii_bytes_match_at(bytes: &[u8], start: usize, needle: &[u8]) -> bool {
    bytes
        .get(start..start + needle.len())
        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(needle))
}

fn keyword_matches_at(line: &str, start: usize, keyword: &str) -> bool {
    if keyword.is_ascii() {
        return ascii_bytes_match_at(line.as_bytes(), start, keyword.as_bytes());
    }

    line.get(start..)
        .is_some_and(|rest| rest.starts_with(keyword))
}

fn find_http_url_start(s: &str, start: usize) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut idx = start;

    while idx < bytes.len() {
        let b = bytes[idx];
        if (b == b'h' || b == b'H')
            && (ascii_bytes_match_at(bytes, idx, b"http://")
                || ascii_bytes_match_at(bytes, idx, b"https://"))
        {
            return Some(idx);
        }
        idx += 1;
    }

    None
}

/// 对单行文本进行精确敏感词替换（与 TS 侧 SENSITIVE_PATTERN 行为对齐）：
/// - `keyword=value` 或 `keyword: value` → `keyword=[REDACTED]`
/// - `keyword_something` / `keyword-something` / `keyword.something` / `keyword(something)` → `keyword=[REDACTED]`
/// - 独立 keyword（后跟空格/逗号/结尾）→ `keyword=[REDACTED]`
fn redact_sensitive_keywords(line: &str) -> String {
    let mut result = String::with_capacity(line.len());
    let bytes = line.as_bytes();
    let mut cursor = 0;

    while cursor < line.len() {
        // 尝试在当前位置之后找敏感词
        let mut found = false;
        for kw in sensitive_keywords() {
            let kw_lower = kw.as_str();
            let kw_len = kw_lower.len();
            let after = cursor + kw_len;
            if after > line.len() {
                continue;
            }
            if !keyword_matches_at(line, cursor, kw_lower) {
                continue;
            }
            if cursor > 0
                && bytes[cursor - 1] == b'['
                && line[cursor..].starts_with("URL_REDACTED]")
            {
                continue;
            }
            // 检查后面紧跟的字符（允许 keyword 与分隔符之间有空白）
            if after < line.len() {
                let after_ws = line[after..]
                    .find(|c: char| !c.is_whitespace())
                    .map(|i| after + i)
                    .unwrap_or(line.len());
                if after_ws < line.len() {
                    let next_char = line.as_bytes()[after_ws];
                    // `keyword=value` / `keyword : value` / `keyword ：value`
                    let uses_fullwidth_colon = line[after_ws..].starts_with('：');
                    if next_char == b'=' || next_char == b':' || uses_fullwidth_colon {
                        let separator_len = if uses_fullwidth_colon {
                            '：'.len_utf8()
                        } else {
                            1
                        };
                        let val_start = after_ws + separator_len;
                        let val_start = line[val_start..]
                            .find(|c: char| !c.is_whitespace())
                            .map(|i| val_start + i)
                            .unwrap_or(line.len());
                        // 值已被前序步骤（redact_auth_tokens）脱敏时跳过，避免重复替换
                        if line[val_start..].starts_with("[REDACTED]") {
                            result.push_str(&line[cursor..after]);
                            cursor = after;
                            found = true;
                            break;
                        }
                        let val_end = sensitive_value_end(line, val_start);
                        result.push_str(&line[cursor..after]);
                        result.push_str("=[REDACTED]");
                        cursor = val_end;
                        found = true;
                        break;
                    }
                    if after_ws == after && matches!(next_char, b'_' | b'-' | b'.' | b'(') {
                        let val_start = after + 1;
                        let val_end = line[val_start..]
                            .find(|c: char| c.is_whitespace() || c == ',')
                            .map(|i| val_start + i)
                            .unwrap_or(line.len());
                        result.push_str(&line[cursor..after]);
                        result.push_str("=[REDACTED]");
                        cursor = val_end;
                        found = true;
                        break;
                    }
                }
                if let Some(val_start) = natural_language_value_start(line, after) {
                    let val_end = sensitive_value_end(line, val_start);
                    result.push_str(&line[cursor..val_start]);
                    result.push_str("[REDACTED]");
                    cursor = val_end;
                    found = true;
                    break;
                }
                let next_char = bytes[after];
                // 独立 keyword（后跟空格/逗号/标点）
                if next_char.is_ascii_whitespace()
                    || next_char == b','
                    || next_char == b';'
                    || next_char == b')'
                    || next_char == b'}'
                    || next_char == b']'
                {
                    result.push_str(&line[cursor..after]);
                    result.push_str("=[REDACTED]");
                    cursor = after;
                    found = true;
                    break;
                }
            } else {
                // keyword 在行尾
                result.push_str(&line[cursor..after]);
                result.push_str("=[REDACTED]");
                cursor = after;
                found = true;
                break;
            }
        }
        if !found {
            // 当前位置不匹配任何敏感词，写入当前字符并前进
            let ch = line[cursor..].chars().next().unwrap();
            result.push(ch);
            cursor += ch.len_utf8();
        }
    }

    result
}

/// 对 message 字段进行脱敏处理：
/// 1. 脱敏 Bearer/Basic token（先于敏感词，避免 keyword 替换破坏 token 模式）
/// 2. 精确替换敏感关键词（与 TS 侧对齐）
/// 3. 替换所有 HTTP(S) URL 为 `[URL_REDACTED]`
/// 4. 移除 URL 中的 userinfo（`://user:pass@`）
/// 5. 替换本地绝对路径为 `[REDACTED]`
/// 6. 截断至 240 字符
fn sanitize_message(message: &str) -> String {
    let mut result = String::with_capacity(message.len());

    for line in message.lines() {
        // 先替换 URL，避免后续 token 脱敏把 URL 里的参数变成 [REDACTED] 导致 redact_urls 跳过
        let url_redacted = redact_urls(line);
        let token_redacted = redact_auth_tokens(&url_redacted);
        let keyword_redacted = redact_sensitive_keywords(&token_redacted);
        let path_sanitized = redact_local_paths(&keyword_redacted);
        result.push_str(&path_sanitized);
        result.push('\n');
    }

    while result.ends_with('\n') {
        result.pop();
    }

    // 截断至 240 字符（按字符边界安全截断，避免 UTF-8 多字节字符 panic）
    if result.chars().count() > 240 {
        result = result.chars().take(240).collect();
    }

    result
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn sanitize_file_name_field(name: &str) -> String {
    let without_userinfo = remove_url_userinfo(name);
    let basename = extract_basename(&without_userinfo);
    let keyword_redacted = redact_sensitive_keywords(basename);
    truncate_chars(&keyword_redacted, MAX_FILENAME_LEN)
}

/// 移除 URL 中的 userinfo 部分（全局扫描替换）。
/// 匹配 `://` 后紧跟的 `user:pass@` 或 `user@` 模式，替换所有匹配项。
fn remove_url_userinfo(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut cursor = 0;
    while cursor < s.len() {
        if let Some(rel) = s[cursor..].find("://") {
            let protocol_end = cursor + rel + 3;
            // 尝试在 `://` 之后找 `@`
            if let Some(rel_at) = s[protocol_end..].find('@') {
                let userinfo_region = &s[protocol_end..protocol_end + rel_at];
                // userinfo 非空即可（含 `user:pass@` 或纯 `user@`）
                if !userinfo_region.is_empty() {
                    // 写入 protocol 部分，跳过 userinfo 和 `@`
                    result.push_str(&s[cursor..protocol_end]);
                    cursor = protocol_end + rel_at + 1; // 跳过 `@`
                    continue;
                }
            }
            // 没有 userinfo → 写入到 protocol_end 之后继续
            result.push_str(&s[cursor..protocol_end]);
            cursor = protocol_end;
        } else {
            // 没有更多 `://` → 写入剩余部分
            result.push_str(&s[cursor..]);
            break;
        }
    }
    result
}

/// 替换所有 HTTP(S) URL 为 `[URL_REDACTED]`（全局扫描）。
fn redact_urls(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut cursor = 0;
    while cursor < s.len() {
        let abs = find_http_url_start(s, cursor);
        if let Some(abs) = abs {
            let url_start = abs;
            let mut url_end = abs;
            let bytes = s.as_bytes();
            while url_end < bytes.len() {
                match bytes[url_end] {
                    b' ' | b'\t' | b'\n' | b'\r' | b',' | b';' | b')' | b'}' | b'"' | b'\''
                    | b'<' | b'>' => break,
                    _ => url_end += 1,
                }
            }
            result.push_str(&s[cursor..url_start]);
            if url_end > url_start {
                result.push_str("[URL_REDACTED]");
            }
            cursor = url_end;
        } else {
            result.push_str(&s[cursor..]);
            break;
        }
    }
    result
}

/// 从 `start` 位置向后扫描，在当前"词"范围内寻找 `\` 或 `/`。
/// "词"由空格、换行、引号、尖括号界定。找到分隔符返回 true。
fn has_path_separator_after(bytes: &[u8], start: usize) -> bool {
    let mut j = start;
    while j < bytes.len() {
        match bytes[j] {
            b'\\' | b'/' => return true,
            b' ' | b'\t' | b'\n' | b'\r' | b'"' | b'\'' | b'<' | b'>' => return false,
            _ => j += 1,
        }
    }
    false
}

/// 检查从 `start` 位置开始的下一个"词"是否包含 `.`（文件名常见特征）。
/// 用于判断空格后的内容是否属于文件名的一部分（如 "My File.zip"）。
fn next_word_has_dot(bytes: &[u8], start: usize) -> bool {
    let mut j = start;
    while j < bytes.len() {
        match bytes[j] {
            b' ' | b'\t' | b'\n' | b'\r' | b'"' | b'\'' | b'<' | b'>' => break,
            b'.' => return true,
            _ => j += 1,
        }
    }
    false
}

/// 脱敏本地绝对路径（全局扫描替换）。
/// 匹配 Windows 盘符路径（`C:\...` 或 `C:/...`）和 Unix 绝对路径（`/home/...`），
/// 替换为 `[REDACTED]`。
fn redact_local_paths(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        // Windows 盘符路径：字母 + : + \ 或 /
        if i + 2 < bytes.len()
            && bytes[i].is_ascii_alphabetic()
            && bytes[i + 1] == b':'
            && (bytes[i + 2] == b'\\' || bytes[i + 2] == b'/')
        {
            let mut end = i + 3;
            while end < bytes.len()
                && bytes[end] != b'\n'
                && bytes[end] != b'\r'
                && bytes[end] != b'"'
                && bytes[end] != b'\''
                && bytes[end] != b'<'
                && bytes[end] != b'>'
            {
                if bytes[end] == b' ' {
                    if has_path_separator_after(bytes, end + 1) {
                        end += 1;
                        continue;
                    }
                    if next_word_has_dot(bytes, end + 1) {
                        end += 1;
                        continue;
                    }
                    break;
                }
                end += 1;
            }
            if end > i + 3 {
                result.push_str("[REDACTED]");
                i = end;
                continue;
            }
        }

        // Unix 绝对路径：/ 后跟非空格字符，且至少包含一个子目录 /
        if bytes[i] == b'/'
            && i + 1 < bytes.len()
            && bytes[i + 1] != b' '
            && bytes[i + 1] != b'/'
            && bytes[i + 1] != b'\n'
            && bytes[i + 1] != b'\r'
        {
            let mut end = i + 1;
            let mut has_sep = false;
            while end < bytes.len()
                && bytes[end] != b'\n'
                && bytes[end] != b'\r'
                && bytes[end] != b'"'
                && bytes[end] != b'\''
                && bytes[end] != b'<'
                && bytes[end] != b'>'
            {
                if bytes[end] == b' ' {
                    if has_path_separator_after(bytes, end + 1) {
                        end += 1;
                        continue;
                    }
                    break;
                }
                if bytes[end] == b'/' {
                    has_sep = true;
                }
                end += 1;
            }
            if has_sep && end > i + 2 {
                result.push_str("[REDACTED]");
                i = end;
                continue;
            }
        }

        // 普通 UTF-8 字符
        let ch_len = s[i..].chars().next().map_or(1, |c| c.len_utf8());
        result.push_str(&s[i..i + ch_len]);
        i += ch_len;
    }

    result
}

/// ASCII 大小写无关比较（仅限 ASCII 字节）。
fn ascii_eq_ignore_case(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b.iter())
            .all(|(x, y)| x.to_ascii_lowercase() == *y)
}

/// 脱敏 Bearer/Basic 认证 token（ASCII 大小写无关，全局扫描替换）。
/// 匹配 `Bearer <token>` 或 `Basic <token>` 模式，替换所有匹配项为 `[REDACTED]`。
fn redact_auth_tokens(s: &str) -> String {
    let schemes: &[&[u8]] = &[b"bearer ", b"basic "];
    let mut result = s.to_string();
    let mut offset = 0;
    loop {
        let remaining = &result.as_bytes()[offset..];
        let mut best: Option<(usize, usize)> = None; // (pos, scheme_len)
        for scheme in schemes {
            for i in 0..remaining.len() {
                if remaining[i..].len() >= scheme.len()
                    && ascii_eq_ignore_case(&remaining[i..i + scheme.len()], scheme)
                {
                    let pos = offset + i;
                    match best {
                        Some((prev_pos, _)) if pos >= prev_pos => {}
                        _ => best = Some((pos, scheme.len())),
                    }
                    break;
                }
            }
        }
        if let Some((pos, scheme_len)) = best {
            let token_start = pos + scheme_len;
            let token_end = result[token_start..]
                .find(|c: char| c == ' ' || c == ',' || c == ';' || c == '\n')
                .map(|i| token_start + i)
                .unwrap_or(result.len());
            if token_end > token_start {
                result.replace_range(pos..token_end, "[REDACTED]");
                offset = pos + "[REDACTED]".len();
                continue;
            }
        }
        break;
    }
    result
}

/// 从路径中提取 basename（兼容 Windows `\` 和 Unix `/`），
/// 并剥离 query（`?`）和 fragment（`#`）以避免泄露 token。
fn extract_basename(name: &str) -> &str {
    let after_sep = if let Some(pos) = name.rfind(|c| c == '\\' || c == '/') {
        &name[pos + 1..]
    } else {
        name
    };
    after_sep
        .split('?')
        .next()
        .unwrap_or(after_sep)
        .split('#')
        .next()
        .unwrap_or(after_sep)
}

/// 对 entry 进行脱敏处理，返回脱敏后的副本。
fn sanitize_entry(mut entry: BackupActivityEntry) -> BackupActivityEntry {
    if entry
        .id
        .as_deref()
        .is_some_and(|id| !id.is_empty() && !is_valid_uuid_v4(id))
    {
        entry.id = Some(generate_uuid());
    }

    if !VALID_OPERATIONS.contains(&entry.operation.as_str()) {
        entry.operation = "unknown".to_string();
    }
    if !VALID_STATUSES.contains(&entry.status.as_str()) {
        entry.status = "failed".to_string();
    }
    if !VALID_LEVELS.contains(&entry.level.as_str()) {
        entry.level = "error".to_string();
    }

    if let Some(ref msg) = entry.message {
        entry.message = Some(sanitize_message(msg));
    }
    if let Some(ref trigger) = entry.trigger {
        entry.trigger = Some(sanitize_message(trigger));
    }
    if let Some(ref stage) = entry.stage {
        entry.stage = Some(sanitize_message(stage));
    }
    if let Some(ref reason_code) = entry.reason_code {
        entry.reason_code = Some(sanitize_message(reason_code));
    }
    if let Some(ref error_code) = entry.error_code {
        entry.error_code = Some(sanitize_message(error_code));
    }

    if let Some(ref name) = entry.remote_file_name {
        let sanitized = sanitize_file_name_field(name);
        if sanitized != *name {
            entry.remote_file_name = Some(sanitized);
        }
    }
    if let Some(ref name) = entry.local_file_name {
        let sanitized = sanitize_file_name_field(name);
        if sanitized != *name {
            entry.local_file_name = Some(sanitized);
        }
    }

    // metrics.failedFileName 也可能包含绝对路径或 URL 凭证
    if let Some(ref mut metrics) = entry.metrics {
        if let Some(ref fname) = metrics.failed_file_name {
            let sanitized = sanitize_file_name_field(fname);
            if sanitized != *fname {
                metrics.failed_file_name = Some(sanitized);
            }
        }
        if let Some(ref anomaly_codes) = metrics.anomaly_codes {
            metrics.anomaly_codes = Some(
                anomaly_codes
                    .iter()
                    .take(MAX_ANOMALY_CODES)
                    .map(|code| sanitize_message(code))
                    .map(|code| truncate_chars(&code, MAX_ANOMALY_CODE_LEN))
                    .collect(),
            );
        }
    }

    entry
}

// ---------------------------------------------------------------------------
// ID 生成（兜底）
// ---------------------------------------------------------------------------

/// 生成一个 UUID v4 格式的随机字符串（使用 rand，无需 uuid crate）。
fn generate_uuid() -> String {
    let random_bytes: [u8; 16] = rand::random();
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        random_bytes[0], random_bytes[1], random_bytes[2], random_bytes[3],
        random_bytes[4], random_bytes[5],
        (random_bytes[6] & 0x0f) | 0x40, // version 4
        random_bytes[7],
        (random_bytes[8] & 0x3f) | 0x80, // variant 10xx
        random_bytes[9],
        random_bytes[10], random_bytes[11], random_bytes[12],
        random_bytes[13], random_bytes[14], random_bytes[15],
    )
}

fn is_valid_uuid_v4(id: &str) -> bool {
    if id.len() != 36 {
        return false;
    }
    let bytes = id.as_bytes();
    if bytes[8] != b'-' || bytes[13] != b'-' || bytes[18] != b'-' || bytes[23] != b'-' {
        return false;
    }
    if bytes[14] != b'4' {
        return false;
    }
    if !matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B') {
        return false;
    }
    bytes
        .iter()
        .enumerate()
        .all(|(idx, byte)| matches!(idx, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit())
}

// ---------------------------------------------------------------------------
// 文件读写
// ---------------------------------------------------------------------------

fn recover_orphaned_log_backup_if_missing(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    let backup_path = backup_file_path(path);
    if !backup_path.exists() {
        return Ok(());
    }
    std::fs::rename(&backup_path, path).map_err(|e| format!("恢复备份活动日志 .bak 失败: {e}"))
}

/// 从文件加载日志。文件不存在或为空时返回空日志；解析失败返回明确错误；版本不匹配返回错误。
fn load_log_from_path(path: &Path) -> Result<BackupActivityLogFile, String> {
    recover_orphaned_log_backup_if_missing(path)?;

    if !path.exists() {
        return Ok(BackupActivityLogFile {
            version: LOG_VERSION,
            entries: Vec::new(),
        });
    }

    let content =
        std::fs::read_to_string(path).map_err(|e| format!("读取备份活动日志文件失败: {e}"))?;

    // 空文件（首次创建或清空场景）视为空日志
    if content.trim().is_empty() {
        return Ok(BackupActivityLogFile {
            version: LOG_VERSION,
            entries: Vec::new(),
        });
    }

    let file: BackupActivityLogFile =
        serde_json::from_str(&content).map_err(|e| format!("解析备份活动日志文件失败: {e}"))?;

    // 版本校验：拒绝不兼容的日志文件
    if file.version != LOG_VERSION {
        return Err(format!(
            "备份活动日志版本不兼容：期望 {}，实际 {}",
            LOG_VERSION, file.version
        ));
    }

    Ok(file)
}

/// 将日志写入文件（原子写入）。
fn save_log_to_path(path: &Path, log: &BackupActivityLogFile) -> Result<(), String> {
    let content =
        serde_json::to_string_pretty(log).map_err(|e| format!("序列化备份活动日志失败: {e}"))?;
    write_atomic(path, &content)
}

fn clear_log_to_path(path: &Path) -> Result<(), String> {
    let _ = std::fs::remove_file(backup_file_path(path));

    let cleared = BackupActivityLogFile {
        version: LOG_VERSION,
        entries: Vec::new(),
    };
    save_log_to_path(path, &cleared)
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

/// 列出备份活动日志条目。
///
/// - 文件不存在时返回空列表
/// - 解析失败返回明确错误
/// - `limit` 参数限制返回的条目数量（默认返回全部）
#[tauri::command]
pub async fn backup_activity_list(
    app: tauri::AppHandle,
    limit: Option<usize>,
) -> Result<Vec<BackupActivityEntry>, String> {
    let path = log_file_path(&app)?;
    let lock_path = lock_file_path(&app)?;

    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建日志目录失败: {e}"))?;
        }
    }

    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|e| format!("打开锁文件失败: {e}"))?;

    lock_file
        .lock_exclusive()
        .map_err(|e| format!("获取日志文件锁失败: {e}"))?;

    let log = load_log_from_path(&path)?;

    let entries = match limit {
        Some(n) => {
            // 返回最新的 n 条（从末尾截取）
            let len = log.entries.len();
            if n >= len {
                log.entries
            } else {
                log.entries[len - n..].to_vec()
            }
        }
        None => log.entries,
    };

    drop(lock_file);

    Ok(entries)
}

/// 追加一条备份活动记录。
///
/// - 自动脱敏 message 字段
/// - 自动填充空 id（生成 UUID）
/// - 超过 100 条时移除最旧的条目
/// - 使用文件锁防止并发写入导致数据丢失
#[tauri::command]
pub async fn backup_activity_append(
    app: tauri::AppHandle,
    entry: BackupActivityEntry,
) -> Result<(), String> {
    let path = log_file_path(&app)?;
    let lock_path = lock_file_path(&app)?;

    // 确保父目录存在（首次安装时配置目录可能尚未创建）
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建日志目录失败: {e}"))?;
        }
    }

    // 使用独立锁文件加锁，避免 Windows 上日志文件句柄与原子替换冲突
    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|e| format!("打开锁文件失败: {e}"))?;

    lock_file
        .lock_exclusive()
        .map_err(|e| format!("获取日志文件锁失败: {e}"))?;

    // 在锁保护下执行 load -> push -> save
    let mut log = load_log_from_path(&path)?;

    // 脱敏处理
    let mut entry = sanitize_entry(entry);

    // id 兜底：为 None 或空时生成 UUID
    match &entry.id {
        Some(id) if !id.is_empty() => {}
        _ => entry.id = Some(generate_uuid()),
    }

    log.entries.push(entry);

    // 超过 MAX_ENTRIES 时移除最旧的条目
    if log.entries.len() > MAX_ENTRIES {
        let drain_count = log.entries.len() - MAX_ENTRIES;
        log.entries.drain(..drain_count);
    }

    let result = save_log_to_path(&path, &log);

    // 释放锁（文件关闭时自动释放，但显式 drop 更清晰）
    drop(lock_file);

    result
}

/// 清除所有备份活动日志条目。
///
/// 写入一个空的日志文件（保留版本号）。使用与 append 相同的文件锁防止并发丢失。
#[tauri::command]
pub async fn backup_activity_clear(app: tauri::AppHandle) -> Result<(), String> {
    let path = log_file_path(&app)?;
    let lock_path = lock_file_path(&app)?;

    // 确保父目录存在
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建日志目录失败: {e}"))?;
        }
    }

    // 使用独立锁文件加锁（与 append 共享同一把锁）
    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|e| format!("打开锁文件失败: {e}"))?;

    lock_file
        .lock_exclusive()
        .map_err(|e| format!("获取日志文件锁失败: {e}"))?;

    let result = clear_log_to_path(&path);

    drop(lock_file);
    result
}

// ===========================================================================
// 单元测试
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 创建临时测试目录，返回路径。
    fn test_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sonotes-backup-activity-test-{:016x}",
            rand::random::<u64>()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 构造一条测试用的 BackupActivityEntry。
    fn make_test_entry(id: &str) -> BackupActivityEntry {
        BackupActivityEntry {
            id: Some(id.to_string()),
            operation: "local-backup".to_string(),
            status: "success".to_string(),
            level: "info".to_string(),
            started_at: 1700000000000,
            finished_at: 1700000060000,
            trigger: Some("manual".to_string()),
            stage: None,
            reason_code: None,
            error_code: None,
            message: Some("备份完成".to_string()),
            remote_file_name: None,
            local_file_name: None,
            summary: None,
            metrics: None,
        }
    }

    // -----------------------------------------------------------------------
    // 空日志加载
    // -----------------------------------------------------------------------

    #[test]
    fn load_log_from_path_returns_empty_when_file_not_exists() {
        let dir = test_dir();
        let path = dir.join("nonexistent.json");

        let log = load_log_from_path(&path).unwrap();

        assert_eq!(log.version, LOG_VERSION);
        assert!(log.entries.is_empty());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn load_log_from_path_recovers_orphaned_bak_when_main_file_missing() {
        let dir = test_dir();
        let path = dir.join(LOG_FILENAME);
        let backup_path = path.with_extension("json.bak");
        let entry = make_test_entry("bak-001");
        let log = BackupActivityLogFile {
            version: LOG_VERSION,
            entries: vec![entry],
        };
        fs::write(&backup_path, serde_json::to_string_pretty(&log).unwrap()).unwrap();

        let loaded = load_log_from_path(&path).unwrap();

        assert!(path.exists());
        assert!(!backup_path.exists());
        assert_eq!(loaded.entries.len(), 1);
        assert_eq!(loaded.entries[0].id, Some("bak-001".into()));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn load_log_from_path_returns_empty_when_file_is_empty_array() {
        let dir = test_dir();
        let path = dir.join(LOG_FILENAME);
        fs::write(&path, r#"{"version":1,"entries":[]}"#).unwrap();

        let log = load_log_from_path(&path).unwrap();

        assert_eq!(log.version, LOG_VERSION);
        assert!(log.entries.is_empty());

        let _ = fs::remove_dir_all(dir);
    }

    // -----------------------------------------------------------------------
    // 解析失败
    // -----------------------------------------------------------------------

    #[test]
    fn load_log_from_path_returns_error_for_invalid_json() {
        let dir = test_dir();
        let path = dir.join(LOG_FILENAME);
        fs::write(&path, "{not valid json").unwrap();

        let result = load_log_from_path(&path);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("解析备份活动日志文件失败"));

        let _ = fs::remove_dir_all(dir);
    }

    // -----------------------------------------------------------------------
    // Append 后读取
    // -----------------------------------------------------------------------

    #[test]
    fn save_and_load_roundtrip() {
        let dir = test_dir();
        let path = dir.join(LOG_FILENAME);

        let entry = make_test_entry("test-001");
        let log = BackupActivityLogFile {
            version: LOG_VERSION,
            entries: vec![entry],
        };
        save_log_to_path(&path, &log).unwrap();

        let loaded = load_log_from_path(&path).unwrap();
        assert_eq!(loaded.entries.len(), 1);
        assert_eq!(loaded.entries[0].id, Some("test-001".into()));
        assert_eq!(loaded.entries[0].operation, "local-backup");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn append_multiple_entries() {
        let dir = test_dir();
        let path = dir.join(LOG_FILENAME);

        // 初始空日志
        let mut log = BackupActivityLogFile {
            version: LOG_VERSION,
            entries: Vec::new(),
        };

        // 追加 3 条
        for i in 0..3 {
            let entry = make_test_entry(&format!("entry-{i:03}"));
            log.entries.push(entry);
        }
        save_log_to_path(&path, &log).unwrap();

        let loaded = load_log_from_path(&path).unwrap();
        assert_eq!(loaded.entries.len(), 3);
        assert_eq!(loaded.entries[0].id, Some("entry-000".into()));
        assert_eq!(loaded.entries[2].id, Some("entry-002".into()));

        let _ = fs::remove_dir_all(dir);
    }

    // -----------------------------------------------------------------------
    // 超 100 条裁剪
    // -----------------------------------------------------------------------

    #[test]
    fn trim_excess_entries_beyond_max() {
        let dir = test_dir();
        let path = dir.join(LOG_FILENAME);

        let mut entries = Vec::new();
        for i in 0..105 {
            let entry = make_test_entry(&format!("entry-{i:03}"));
            entries.push(entry);
        }
        let mut log = BackupActivityLogFile {
            version: LOG_VERSION,
            entries,
        };

        // 模拟裁剪逻辑
        if log.entries.len() > MAX_ENTRIES {
            let drain_count = log.entries.len() - MAX_ENTRIES;
            log.entries.drain(..drain_count);
        }

        assert_eq!(log.entries.len(), MAX_ENTRIES);
        // 最旧的 5 条应被移除
        assert_eq!(log.entries[0].id, Some("entry-005".into()));
        assert_eq!(log.entries[MAX_ENTRIES - 1].id, Some("entry-104".into()));

        save_log_to_path(&path, &log).unwrap();
        let loaded = load_log_from_path(&path).unwrap();
        assert_eq!(loaded.entries.len(), MAX_ENTRIES);

        let _ = fs::remove_dir_all(dir);
    }

    // -----------------------------------------------------------------------
    // Clear 后为空
    // -----------------------------------------------------------------------

    #[test]
    fn clear_log_returns_empty() {
        let dir = test_dir();
        let path = dir.join(LOG_FILENAME);

        // 先写入一些数据
        let log = BackupActivityLogFile {
            version: LOG_VERSION,
            entries: vec![make_test_entry("to-be-cleared")],
        };
        save_log_to_path(&path, &log).unwrap();

        // 清除
        let cleared = BackupActivityLogFile {
            version: LOG_VERSION,
            entries: Vec::new(),
        };
        save_log_to_path(&path, &cleared).unwrap();

        let loaded = load_log_from_path(&path).unwrap();
        assert!(loaded.entries.is_empty());
        assert_eq!(loaded.version, LOG_VERSION);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn clear_log_removes_orphaned_backup_file() {
        let dir = test_dir();
        let path = dir.join(LOG_FILENAME);
        let backup_path = path.with_extension("json.bak");

        let orphaned_log = BackupActivityLogFile {
            version: LOG_VERSION,
            entries: vec![make_test_entry("orphaned")],
        };
        fs::write(
            &backup_path,
            serde_json::to_string_pretty(&orphaned_log).unwrap(),
        )
        .unwrap();

        clear_log_to_path(&path).unwrap();

        assert!(path.exists());
        assert!(!backup_path.exists());

        let loaded = load_log_from_path(&path).unwrap();
        assert!(loaded.entries.is_empty());
        assert_eq!(loaded.version, LOG_VERSION);

        let _ = fs::remove_dir_all(dir);
    }

    // -----------------------------------------------------------------------
    // 脱敏处理
    // -----------------------------------------------------------------------

    #[test]
    fn sanitize_message_replaces_sensitive_keywords() {
        // keyword=value 模式
        assert_eq!(sanitize_message("password=abc123"), "password=[REDACTED]");
        assert_eq!(sanitize_message("token: xyz"), "token=[REDACTED]");
        assert_eq!(sanitize_message("username=alice"), "username=[REDACTED]");
        assert_eq!(
            sanitize_message("serverUrl=https://dav.example.com"),
            "serverUrl=[REDACTED]"
        );
        assert_eq!(
            sanitize_message("url=https://dav.example.com"),
            "url=[REDACTED]"
        );
        assert_eq!(
            sanitize_message("password is abc123"),
            "password is [REDACTED]"
        );
        assert_eq!(
            sanitize_message("密码是 hunter2，请检查"),
            "密码是 [REDACTED]，请检查"
        );
        assert_eq!(sanitize_message("密码：hunter2"), "密码=[REDACTED]");
        assert_eq!(sanitize_message("令牌：abc"), "令牌=[REDACTED]");
        assert_eq!(sanitize_message("token：abc"), "token=[REDACTED]");
        assert_eq!(sanitize_message("password"), "password=[REDACTED]");
        assert_eq!(sanitize_message("secret key"), "secret=[REDACTED] key");
        // keyword 与分隔符之间有空格
        assert_eq!(
            sanitize_message("password = hunter2 trailing"),
            "password=[REDACTED] trailing"
        );
        assert_eq!(
            sanitize_message("token : abc123 ok"),
            "token=[REDACTED] ok"
        );
        // 引号内含空格的敏感值整段脱敏
        assert_eq!(
            sanitize_message("password=\"correct horse battery staple\" next"),
            "password=[REDACTED] next"
        );
        // keyword_something 模式
        assert_eq!(
            sanitize_message("my_password_value"),
            "my_password=[REDACTED]"
        );
        // Authorization: Bearer token — 先被 redact_auth_tokens 处理，再由 redact_sensitive_keywords 处理
        assert_eq!(
            sanitize_message("Authorization: Bearer abc123xyz"),
            "Authorization: [REDACTED]"
        );
    }

    #[test]
    fn sanitize_message_preserves_normal_text() {
        assert_eq!(
            sanitize_message("备份完成，共 42 条便签"),
            "备份完成，共 42 条便签"
        );
    }

    #[test]
    fn sanitize_message_truncates_at_240_chars() {
        let long_msg = "a".repeat(300);
        let result = sanitize_message(&long_msg);
        assert_eq!(result.chars().count(), 240);
    }

    #[test]
    fn sanitize_message_truncates_multibyte_safely() {
        let msg = "备".repeat(300);
        let result = sanitize_message(&msg);
        assert_eq!(result.chars().count(), 240);
    }

    #[test]
    fn remove_url_userinfo_strips_credentials() {
        let url = "https://user:pass@example.com/path";
        assert_eq!(remove_url_userinfo(url), "https://example.com/path");
    }

    #[test]
    fn remove_url_userinfo_preserves_clean_url() {
        let url = "https://example.com/path";
        assert_eq!(remove_url_userinfo(url), "https://example.com/path");
    }

    #[test]
    fn remove_url_userinfo_handles_no_at_sign() {
        let url = "https://example.com/path";
        assert_eq!(remove_url_userinfo(url), "https://example.com/path");
    }

    #[test]
    fn remove_url_userinfo_handles_no_colon_in_userinfo() {
        // `://user@host` 格式也应脱敏（纯用户名无密码）
        let url = "https://user@example.com/path";
        assert_eq!(remove_url_userinfo(url), "https://example.com/path");
    }

    #[test]
    fn remove_url_userinfo_strips_multiple_credentials() {
        let msg = "upload https://u:p@host1.com/a and https://u2:p2@host2.com/b done";
        let result = remove_url_userinfo(msg);
        assert_eq!(
            result,
            "upload https://host1.com/a and https://host2.com/b done"
        );
    }

    #[test]
    fn redact_auth_tokens_single_bearer() {
        assert_eq!(redact_auth_tokens("Bearer abc123"), "[REDACTED]");
    }

    #[test]
    fn redact_auth_tokens_multiple_bearer() {
        let msg = "first Bearer aaa, second Bearer bbb";
        let result = redact_auth_tokens(msg);
        assert_eq!(result, "first [REDACTED], second [REDACTED]");
    }

    #[test]
    fn redact_auth_tokens_mixed_schemes() {
        let msg = "got Basic xxx then Bearer yyy";
        let result = redact_auth_tokens(msg);
        assert_eq!(result, "got [REDACTED] then [REDACTED]");
    }

    #[test]
    fn sanitize_message_multiline() {
        let msg = "line1 is safe\npassword: secret123\nline3 is safe";
        let result = sanitize_message(msg);
        assert!(result.contains("line1 is safe"));
        assert!(result.contains("[REDACTED]"));
        assert!(result.contains("line3 is safe"));
    }

    #[test]
    fn redact_urls_handles_unicode_casefold_expansion() {
        let msg = "İstanbul https://example.com/path";
        let result = redact_urls(msg);
        assert_eq!(result, "İstanbul [URL_REDACTED]");
    }

    #[test]
    fn redact_sensitive_keywords_handles_unicode_casefold_expansion() {
        let msg = "İ password=secret123";
        let result = redact_sensitive_keywords(msg);
        assert_eq!(result, "İ password=[REDACTED]");
    }

    #[test]
    fn sanitize_message_handles_unicode_casefold_expansion() {
        let msg = "İstanbul password=secret123 https://example.com/path";
        let result = sanitize_message(msg);
        assert_eq!(result, "İstanbul password=[REDACTED] [URL_REDACTED]");
    }

    // -----------------------------------------------------------------------
    // redact_local_paths
    // -----------------------------------------------------------------------

    #[test]
    fn redact_local_paths_windows_path() {
        assert_eq!(
            redact_local_paths("failed C:\\Users\\test\\backup.zip"),
            "failed [REDACTED]"
        );
    }

    #[test]
    fn redact_local_paths_windows_path_forward_slash() {
        assert_eq!(
            redact_local_paths("path D:/backups/file.zip end"),
            "path [REDACTED] end"
        );
    }

    #[test]
    fn redact_local_paths_unix_path() {
        assert_eq!(
            redact_local_paths("error /home/user/backups/test.zip"),
            "error [REDACTED]"
        );
    }

    #[test]
    fn redact_local_paths_no_path() {
        assert_eq!(redact_local_paths("no path here"), "no path here");
    }

    #[test]
    fn redact_local_paths_single_word_slash() {
        assert_eq!(redact_local_paths("status/success"), "status/success");
    }

    #[test]
    fn redact_local_paths_multiple_paths() {
        assert_eq!(
            redact_local_paths("C:\\a\\b.zip and /c/d/e.zip"),
            "[REDACTED] and [REDACTED]"
        );
    }

    #[test]
    fn sanitize_message_redacts_local_path() {
        assert_eq!(
            sanitize_message("恢复失败 C:\\Users\\test\\backup.zip"),
            "恢复失败 [REDACTED]"
        );
    }

    // -----------------------------------------------------------------------
    // UUID 生成
    // -----------------------------------------------------------------------

    #[test]
    fn generate_uuid_format() {
        let uuid = generate_uuid();
        assert_eq!(uuid.len(), 36);
        assert_eq!(uuid.chars().nth(14), Some('4')); // version 4
                                                     // variant bit
        let variant_char = uuid.chars().nth(19).unwrap();
        assert!(
            variant_char == '8'
                || variant_char == '9'
                || variant_char == 'a'
                || variant_char == 'b'
        );
    }

    #[test]
    fn generate_uuid_is_unique() {
        let a = generate_uuid();
        let b = generate_uuid();
        assert_ne!(a, b);
    }

    // -----------------------------------------------------------------------
    // 序列化 camelCase
    // -----------------------------------------------------------------------

    #[test]
    fn entry_serialization_uses_camel_case() {
        let mut entry = make_test_entry("ser-001");
        entry.remote_file_name = Some("test.zip".to_string());
        entry.local_file_name = Some("/tmp/test.zip".to_string());
        let json = serde_json::to_string(&entry).unwrap();

        assert!(json.contains("\"operation\""));
        assert!(json.contains("\"status\""));
        assert!(json.contains("\"level\""));
        assert!(json.contains("\"startedAt\""));
        assert!(json.contains("\"finishedAt\""));
        assert!(json.contains("\"remoteFileName\""));
        assert!(json.contains("\"localFileName\""));
    }

    #[test]
    fn summary_serialization_uses_camel_case() {
        let summary = BackupActivitySummary {
            note_count: Some(10),
            board_count: None,
            text_note_count: Some(5),
            image_note_count: Some(3),
            trash_note_count: None,
            image_file_count: Some(3),
            image_file_total_bytes: Some(1024),
            zip_size_bytes: Some(2048),
        };
        let json = serde_json::to_string(&summary).unwrap();

        assert!(json.contains("\"noteCount\""));
        assert!(json.contains("\"textNoteCount\""));
        assert!(json.contains("\"imageNoteCount\""));
        assert!(json.contains("\"imageFileCount\""));
        assert!(json.contains("\"imageFileTotalBytes\""));
        assert!(json.contains("\"zipSizeBytes\""));
        // None 字段不应出现
        assert!(!json.contains("\"boardCount\""));
        assert!(!json.contains("\"trashNoteCount\""));
    }

    #[test]
    fn metrics_serialization_uses_camel_case() {
        let metrics = BackupActivityMetrics {
            retained_count: Some(100),
            deleted_count: Some(5),
            missing_count: None,
            attempted_count: Some(105),
            failed_file_name: None,
            anomaly_codes: Some(vec!["E001".to_string()]),
        };
        let json = serde_json::to_string(&metrics).unwrap();

        assert!(json.contains("\"retainedCount\""));
        assert!(json.contains("\"deletedCount\""));
        assert!(json.contains("\"attemptedCount\""));
        assert!(json.contains("\"anomalyCodes\""));
        // None 字段不应出现
        assert!(!json.contains("\"missingCount\""));
        assert!(!json.contains("\"failedFileName\""));
    }

    // -----------------------------------------------------------------------
    // 临时文件路径
    // -----------------------------------------------------------------------

    #[test]
    fn temp_file_path_has_correct_pattern() {
        let path = Path::new("/data/backup-activity-log.json");
        let tmp = temp_file_path(path).unwrap();
        let tmp_str = tmp.to_str().unwrap();
        assert!(tmp_str.contains(".backup-activity-log.json.tmp-"));
    }

    // -----------------------------------------------------------------------
    // 原子写入
    // -----------------------------------------------------------------------

    #[test]
    fn write_atomic_creates_parent_directory() {
        let dir = test_dir();
        let path = dir.join("nested").join(LOG_FILENAME);

        write_atomic(&path, "test content").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "test content");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn write_atomic_replaces_existing_file() {
        let dir = test_dir();
        let path = dir.join(LOG_FILENAME);

        write_atomic(&path, "first").unwrap();
        write_atomic(&path, "second").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn replace_file_succeeds_when_bak_already_exists() {
        let dir = test_dir();
        let path = dir.join(LOG_FILENAME);

        fs::write(&path, "original content").unwrap();

        let bak_path = path.with_extension("json.bak");
        fs::write(&bak_path, "stale backup").unwrap();

        let tmp_path = dir.join(".replace-test.tmp");
        fs::write(&tmp_path, "new content").unwrap();

        replace_file(&tmp_path, &path).unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new content");
        assert!(!bak_path.exists());

        let _ = fs::remove_dir_all(dir);
    }

    // -----------------------------------------------------------------------
    // 文件常量
    // -----------------------------------------------------------------------

    #[test]
    fn log_filename_is_expected() {
        assert_eq!(LOG_FILENAME, "backup-activity-log.json");
    }

    #[test]
    fn log_version_is_one() {
        assert_eq!(LOG_VERSION, 1);
    }

    #[test]
    fn extract_basename_unix_path() {
        assert_eq!(extract_basename("/tmp/backups/file.zip"), "file.zip");
    }

    #[test]
    fn extract_basename_windows_path() {
        assert_eq!(extract_basename("C:\\Users\\test\\file.zip"), "file.zip");
    }

    #[test]
    fn extract_basename_already_basename() {
        assert_eq!(extract_basename("file.zip"), "file.zip");
    }

    #[test]
    fn extract_basename_strips_query_and_fragment() {
        assert_eq!(extract_basename("file.zip?token=secret123"), "file.zip");
        assert_eq!(extract_basename("/tmp/file.zip?token=abc#frag"), "file.zip");
        assert_eq!(extract_basename("file.zip#section"), "file.zip");
    }

    #[test]
    fn sanitize_entry_strips_local_path_to_basename() {
        let entry = BackupActivityEntry {
            id: Some("test".into()),
            operation: "local-backup".into(),
            status: "success".into(),
            level: "info".into(),
            started_at: 0,
            finished_at: 0,
            trigger: None,
            stage: None,
            reason_code: None,
            error_code: None,
            message: None,
            remote_file_name: None,
            local_file_name: Some(
                "C:\\Users\\test\\backups\\SoNotes_Backup_20260626120000.zip".into(),
            ),
            summary: None,
            metrics: None,
        };
        let sanitized = sanitize_entry(entry);
        assert_eq!(
            sanitized.local_file_name.as_deref(),
            Some("SoNotes_Backup_20260626120000.zip")
        );
    }

    #[test]
    fn sanitize_entry_strips_remote_path_to_basename() {
        let entry = BackupActivityEntry {
            id: Some("test".into()),
            operation: "remote-backup".into(),
            status: "success".into(),
            level: "info".into(),
            started_at: 0,
            finished_at: 0,
            trigger: None,
            stage: None,
            reason_code: None,
            error_code: None,
            message: None,
            remote_file_name: Some("/backups/SoNotes_Backup_20260626120000.zip".into()),
            local_file_name: None,
            summary: None,
            metrics: None,
        };
        let sanitized = sanitize_entry(entry);
        assert_eq!(
            sanitized.remote_file_name.as_deref(),
            Some("SoNotes_Backup_20260626120000.zip")
        );
    }

    #[test]
    fn sanitize_entry_processes_message_through_sanitize_message() {
        let entry = BackupActivityEntry {
            id: Some("test".into()),
            operation: "remote-backup".into(),
            status: "failed".into(),
            level: "error".into(),
            started_at: 0,
            finished_at: 0,
            trigger: None,
            stage: None,
            reason_code: None,
            error_code: None,
            message: Some("password=abc123 连接失败".into()),
            remote_file_name: None,
            local_file_name: None,
            summary: None,
            metrics: None,
        };
        let sanitized = sanitize_entry(entry);
        assert_eq!(
            sanitized.message.as_deref(),
            Some("password=[REDACTED] 连接失败")
        );
    }

    #[test]
    fn sanitize_entry_redacts_sensitive_keywords_in_file_names() {
        let mut entry = make_test_entry("test");
        entry.remote_file_name = Some("/dav/token=abc123.zip".into());
        entry.local_file_name = Some("C:\\Backups\\secret_backup.zip".into());
        entry.metrics = Some(BackupActivityMetrics {
            deleted_count: None,
            retained_count: None,
            missing_count: None,
            attempted_count: None,
            failed_file_name: Some("password=hunter2.zip".into()),
            anomaly_codes: None,
        });

        let sanitized = sanitize_entry(entry);

        assert_eq!(
            sanitized.remote_file_name.as_deref(),
            Some("token=[REDACTED]")
        );
        assert_eq!(
            sanitized.local_file_name.as_deref(),
            Some("secret=[REDACTED]")
        );
        assert_eq!(
            sanitized
                .metrics
                .as_ref()
                .unwrap()
                .failed_file_name
                .as_deref(),
            Some("password=[REDACTED]")
        );
    }

    #[test]
    fn sanitize_entry_redacts_sensitive_keywords_with_filename_separators() {
        let mut entry = make_test_entry("test");
        entry.remote_file_name = Some("/dav/token-abc123.zip".into());
        entry.local_file_name = Some("C:\\Backups\\password.hunter2.zip".into());
        entry.metrics = Some(BackupActivityMetrics {
            deleted_count: None,
            retained_count: None,
            missing_count: None,
            attempted_count: None,
            failed_file_name: Some("secret(abc).zip".into()),
            anomaly_codes: None,
        });

        let sanitized = sanitize_entry(entry);

        assert_eq!(
            sanitized.remote_file_name.as_deref(),
            Some("token=[REDACTED]")
        );
        assert_eq!(
            sanitized.local_file_name.as_deref(),
            Some("password=[REDACTED]")
        );
        assert_eq!(
            sanitized
                .metrics
                .as_ref()
                .unwrap()
                .failed_file_name
                .as_deref(),
            Some("secret=[REDACTED]")
        );
    }

    #[test]
    fn sanitize_entry_limits_file_name_length() {
        let mut entry = make_test_entry("test");
        entry.remote_file_name = Some(format!("{}.zip", "a".repeat(MAX_FILENAME_LEN + 100)));

        let sanitized = sanitize_entry(entry);

        assert_eq!(
            sanitized
                .remote_file_name
                .as_deref()
                .unwrap()
                .chars()
                .count(),
            MAX_FILENAME_LEN
        );
    }

    #[test]
    fn sanitize_entry_limits_anomaly_codes_count_and_item_length() {
        let mut entry = make_test_entry("test");
        entry.metrics = Some(BackupActivityMetrics {
            deleted_count: None,
            retained_count: None,
            missing_count: None,
            attempted_count: None,
            failed_file_name: None,
            anomaly_codes: Some(
                (0..MAX_ANOMALY_CODES + 5)
                    .map(|idx| format!("code-{idx}-{}", "x".repeat(MAX_ANOMALY_CODE_LEN + 50)))
                    .collect(),
            ),
        });

        let sanitized = sanitize_entry(entry);
        let anomaly_codes = sanitized
            .metrics
            .as_ref()
            .unwrap()
            .anomaly_codes
            .as_ref()
            .unwrap();

        assert_eq!(anomaly_codes.len(), MAX_ANOMALY_CODES);
        assert!(anomaly_codes
            .iter()
            .all(|code| code.chars().count() == MAX_ANOMALY_CODE_LEN));
    }

    #[test]
    fn sanitize_entry_processes_free_form_fields_through_sanitize_message() {
        let mut entry = make_test_entry("test");
        entry.trigger = Some("manual password is hunter2".into());
        entry.stage = Some("upload https://example.com/path?token=abc".into());
        entry.reason_code = Some("token is abc123".into());
        entry.error_code = Some("secret: abc123".into());
        entry.metrics = Some(BackupActivityMetrics {
            deleted_count: None,
            retained_count: None,
            missing_count: None,
            attempted_count: None,
            failed_file_name: None,
            anomaly_codes: Some(vec![
                "password is hunter2".into(),
                "https://host/path".into(),
            ]),
        });

        let sanitized = sanitize_entry(entry);

        assert_eq!(
            sanitized.trigger.as_deref(),
            Some("manual password is [REDACTED]")
        );
        assert_eq!(sanitized.stage.as_deref(), Some("upload [URL_REDACTED]"));
        assert_eq!(
            sanitized.reason_code.as_deref(),
            Some("token is [REDACTED]")
        );
        assert_eq!(sanitized.error_code.as_deref(), Some("secret=[REDACTED]"));
        assert_eq!(
            sanitized
                .metrics
                .as_ref()
                .unwrap()
                .anomaly_codes
                .as_ref()
                .unwrap(),
            &vec![
                "password is [REDACTED]".to_string(),
                "[URL_REDACTED]".to_string()
            ]
        );
    }

    #[test]
    fn sanitize_entry_regenerates_invalid_id() {
        let mut entry = make_test_entry("../../evil\n<script>");
        let sanitized = sanitize_entry(entry.clone());
        assert_ne!(sanitized.id, entry.id);
        assert!(is_valid_uuid_v4(sanitized.id.as_deref().unwrap()));

        entry.id = Some("550e8400-e29b-41d4-a716-446655440000".to_string());
        let sanitized = sanitize_entry(entry);
        assert_eq!(
            sanitized.id.as_deref(),
            Some("550e8400-e29b-41d4-a716-446655440000")
        );
    }

    #[test]
    fn sanitize_entry_extracts_basename_for_metrics_failed_file_name() {
        let entry = BackupActivityEntry {
            id: Some("test".into()),
            operation: "retention-cleanup".into(),
            status: "partial".into(),
            level: "warning".into(),
            started_at: 0,
            finished_at: 0,
            trigger: None,
            stage: None,
            reason_code: None,
            error_code: None,
            message: None,
            remote_file_name: None,
            local_file_name: None,
            summary: None,
            metrics: Some(BackupActivityMetrics {
                deleted_count: Some(1),
                retained_count: Some(5),
                missing_count: None,
                attempted_count: None,
                failed_file_name: Some(
                    "/backups/old/user:pass@server/SoNotes_Old_20260101.zip".into(),
                ),
                anomaly_codes: None,
            }),
        };
        let sanitized = sanitize_entry(entry);
        assert_eq!(
            sanitized
                .metrics
                .as_ref()
                .unwrap()
                .failed_file_name
                .as_deref(),
            Some("SoNotes_Old_20260101.zip")
        );
    }

    #[test]
    fn sanitize_entry_full_pipeline_with_all_fields() {
        let entry = BackupActivityEntry {
            id: Some("test".into()),
            operation: "remote-restore".into(),
            status: "failed".into(),
            level: "error".into(),
            started_at: 0,
            finished_at: 0,
            trigger: None,
            stage: Some("resolve".into()),
            reason_code: None,
            error_code: Some("file_not_found".into()),
            message: Some("Bearer abc123 token 无效，C:\\Users\\test\\error.log 路径".into()),
            remote_file_name: Some(
                "https://user:secret@example.com/dav/SoNotes_Backup_20260626.zip".into(),
            ),
            local_file_name: Some("D:\\Backups\\SoNotes_Backup_20260626.zip".into()),
            summary: None,
            metrics: Some(BackupActivityMetrics {
                deleted_count: None,
                retained_count: None,
                missing_count: None,
                attempted_count: Some(10),
                failed_file_name: Some("C:\\Temp\\failed.zip".into()),
                anomaly_codes: None,
            }),
        };
        let sanitized = sanitize_entry(entry);
        assert!(sanitized.message.as_deref().unwrap().contains("[REDACTED]"));
        assert!(!sanitized.message.as_deref().unwrap().contains("abc123"));
        assert_eq!(
            sanitized.remote_file_name.as_deref(),
            Some("SoNotes_Backup_20260626.zip")
        );
        assert_eq!(
            sanitized.local_file_name.as_deref(),
            Some("SoNotes_Backup_20260626.zip")
        );
        assert_eq!(
            sanitized
                .metrics
                .as_ref()
                .unwrap()
                .failed_file_name
                .as_deref(),
            Some("failed.zip")
        );
    }

    #[test]
    fn redact_local_paths_windows_path_with_spaces() {
        assert_eq!(
            redact_local_paths("error C:\\Users\\Jane Doe\\Documents\\backup.zip failed"),
            "error [REDACTED] failed"
        );
    }

    #[test]
    fn redact_local_paths_windows_filename_with_spaces() {
        assert_eq!(
            redact_local_paths("error C:\\Backups\\My File.zip failed"),
            "error [REDACTED] failed"
        );
    }

    #[test]
    fn redact_local_paths_unix_path_with_spaces() {
        assert_eq!(
            redact_local_paths("error /home/jane doe/backups/test.zip failed"),
            "error [REDACTED] failed"
        );
    }

    #[test]
    fn entry_deserializes_without_id() {
        let json = r#"{
            "operation": "backup",
            "status": "success",
            "level": "info",
            "startedAt": 1700000000000,
            "finishedAt": 1700000060000
        }"#;
        let entry: BackupActivityEntry = serde_json::from_str(json).unwrap();
        assert_eq!(entry.id, None);
    }

    #[test]
    fn entry_deserializes_with_empty_id() {
        let json = r#"{
            "id": "",
            "operation": "backup",
            "status": "success",
            "level": "info",
            "startedAt": 1700000000000,
            "finishedAt": 1700000060000
        }"#;
        let entry: BackupActivityEntry = serde_json::from_str(json).unwrap();
        assert_eq!(entry.id, Some("".to_string()));
    }

    #[test]
    fn redact_urls_replaces_http_url() {
        assert_eq!(
            redact_urls("visit http://example.com/path"),
            "visit [URL_REDACTED]"
        );
    }

    #[test]
    fn redact_urls_replaces_https_url() {
        assert_eq!(
            redact_urls("see https://host.com/a?b=c end"),
            "see [URL_REDACTED] end"
        );
    }

    #[test]
    fn redact_urls_replaces_multiple_urls() {
        let msg = "first https://a.com/x second http://b.com/y";
        assert_eq!(
            redact_urls(msg),
            "first [URL_REDACTED] second [URL_REDACTED]"
        );
    }

    #[test]
    fn redact_urls_replaces_all_urls() {
        let msg = "https://[REDACTED]@host.com/path remains";
        assert_eq!(redact_urls(msg), "[URL_REDACTED] remains");
    }

    #[test]
    fn redact_urls_handles_brackets_in_url() {
        let msg = "https://host.com/path?[key=value] remains";
        assert_eq!(redact_urls(msg), "[URL_REDACTED] remains");
    }

    #[test]
    fn redact_urls_no_url_unchanged() {
        assert_eq!(redact_urls("no urls here"), "no urls here");
    }

    #[test]
    fn sanitize_message_redacts_full_url() {
        let msg = "upload to https://user:pass@host.com/webdav/file.zip failed";
        let result = sanitize_message(msg);
        assert!(
            !result.contains("host.com"),
            "host should be redacted: {result}"
        );
        assert!(
            result.contains("[URL_REDACTED]"),
            "should contain [URL_REDACTED]: {result}"
        );
    }

    #[test]
    fn sanitize_entry_rejects_invalid_operation() {
        let mut entry = make_test_entry("test");
        entry.operation = "invalid-op".to_string();
        let sanitized = sanitize_entry(entry);
        assert_eq!(sanitized.operation, "unknown");
    }

    #[test]
    fn sanitize_entry_rejects_invalid_status() {
        let mut entry = make_test_entry("test");
        entry.status = "bogus".to_string();
        let sanitized = sanitize_entry(entry);
        assert_eq!(sanitized.status, "failed");
    }

    #[test]
    fn sanitize_entry_rejects_invalid_level() {
        let mut entry = make_test_entry("test");
        entry.level = "critical".to_string();
        let sanitized = sanitize_entry(entry);
        assert_eq!(sanitized.level, "error");
    }

    #[test]
    fn sanitize_entry_accepts_valid_values() {
        let mut entry = make_test_entry("test");
        entry.operation = "remote-backup".to_string();
        entry.status = "partial".to_string();
        entry.level = "warning".to_string();
        let sanitized = sanitize_entry(entry);
        assert_eq!(sanitized.operation, "remote-backup");
        assert_eq!(sanitized.status, "partial");
        assert_eq!(sanitized.level, "warning");
    }
}
