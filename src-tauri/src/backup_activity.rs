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
    pub id: String,
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
    Ok(parent.join(format!(
        ".{file_name}.tmp-{:016x}",
        rand::random::<u64>()
    )))
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
    // Windows 上 rename 已存在目标会失败，先删除再重命名
    std::fs::remove_file(path)?;
    std::fs::rename(tmp_path, path)
}

#[cfg(not(windows))]
fn replace_file(tmp_path: &Path, path: &Path) -> std::io::Result<()> {
    std::fs::rename(tmp_path, path)
}

// ---------------------------------------------------------------------------
// 脱敏处理
// ---------------------------------------------------------------------------

/// 敏感关键词列表（小写匹配）。
const SENSITIVE_KEYWORDS: &[&str] = &[
    "password",
    "token",
    "authorization",
    "secret",
    "密码",
    "令牌",
];

/// 对单行文本进行精确敏感词替换（与 TS 侧 SENSITIVE_PATTERN 行为对齐）：
/// - `keyword=value` 或 `keyword: value` → `keyword=[REDACTED]`
/// - `keyword_something` → `keyword=[REDACTED]`
/// - 独立 keyword（后跟空格/逗号/结尾）→ `keyword=[REDACTED]`
fn redact_sensitive_keywords(line: &str) -> String {
    let mut result = String::with_capacity(line.len());
    let lower = line.to_lowercase();
    let bytes = line.as_bytes();
    let mut cursor = 0;

    while cursor < line.len() {
        // 尝试在当前位置之后找敏感词
        let mut found = false;
        for kw in SENSITIVE_KEYWORDS {
            let kw_lower = *kw;
            let kw_len = kw_lower.len();
            let after = cursor + kw_len;
            // 边界检查：确保 after 在字符边界上，避免截断多字节字符
            if after > line.len() || !line.is_char_boundary(after) {
                continue;
            }
            let candidate = &lower[cursor..after];
            if candidate != kw_lower {
                continue;
            }
            // 检查后面紧跟的字符
            if after < line.len() {
                let next_char = bytes[after];
                // `keyword=value` 或 `keyword: value`
                if next_char == b'=' || next_char == b':' {
                    // 找到分隔符，向后扫描到值的结尾（空格/逗号/结尾）
                    let val_start = after + 1;
                    // 跳过分隔符后的空格
                    let val_start = line[val_start..]
                        .find(|c: char| !c.is_whitespace())
                        .map(|i| val_start + i)
                        .unwrap_or(line.len());
                    let val_end = line[val_start..]
                        .find(|c: char| c.is_whitespace() || c == ',')
                        .map(|i| val_start + i)
                        .unwrap_or(line.len());
                    // 写入 keyword=[REDACTED]
                    result.push_str(&line[cursor..after]);
                    result.push_str("=[REDACTED]");
                    cursor = val_end;
                    found = true;
                    break;
                }
                // `keyword_something`
                if next_char == b'_' {
                    let val_end = line[after + 1..]
                        .find(|c: char| c.is_whitespace() || c == ',')
                        .map(|i| after + 1 + i)
                        .unwrap_or(line.len());
                    result.push_str(&line[cursor..after]);
                    result.push_str("=[REDACTED]");
                    cursor = val_end;
                    found = true;
                    break;
                }
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
/// 1. 精确替换敏感关键词（与 TS 侧对齐）
/// 2. 脱敏 Bearer/Basic token
/// 3. 移除 URL 中的 userinfo（`://user:pass@`）
/// 4. 替换本地绝对路径为 `[REDACTED]`
/// 5. 截断至 240 字符
fn sanitize_message(message: &str) -> String {
    let mut result = String::with_capacity(message.len());

    for line in message.lines() {
        // 先精确替换敏感关键词
        let keyword_redacted = redact_sensitive_keywords(line);
        // 再脱敏 Bearer/Basic token
        let token_redacted = redact_auth_tokens(&keyword_redacted);
        // 移除 URL userinfo
        let url_sanitized = remove_url_userinfo(&token_redacted);
        // 脱敏绝对路径
        let path_sanitized = redact_local_paths(&url_sanitized);
        result.push_str(&path_sanitized);
        result.push('\n');
    }

    // 移除末尾多余的换行符
    while result.ends_with('\n') {
        result.pop();
    }

    // 截断至 240 字符（按字符边界安全截断，避免 UTF-8 多字节字符 panic）
    if result.chars().count() > 240 {
        result = result.chars().take(240).collect();
    }

    result
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
            // 向后扫描到行尾或空格/引号等分隔符
            let mut end = i + 3;
            while end < bytes.len()
                && bytes[end] != b'\n'
                && bytes[end] != b'\r'
                && !bytes[end].is_ascii_whitespace()
                && bytes[end] != b'"'
                && bytes[end] != b'\''
            {
                end += 1;
            }
            // 至少 `\X` 才算路径（避免误匹配 `C:\` 单独出现）
            if end > i + 3 {
                result.push_str("[REDACTED]");
                i = end;
                continue;
            }
        }

        // Unix 绝对路径：/ 后跟非空格字符，且至少包含一个子目录 /
        if bytes[i] == b'/'
            && i + 1 < bytes.len()
            && !bytes[i + 1].is_ascii_whitespace()
            && bytes[i + 1] != b'/'
        {
            let mut end = i + 1;
            let mut has_sep = false;
            while end < bytes.len()
                && bytes[end] != b'\n'
                && bytes[end] != b'\r'
                && !bytes[end].is_ascii_whitespace()
                && bytes[end] != b'"'
                && bytes[end] != b'\''
            {
                if bytes[end] == b'/' {
                    has_sep = true;
                }
                end += 1;
            }
            // 至少 /dir/file 形式才替换，避免误匹配单个 /word
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

/// 从路径中提取 basename（兼容 Windows `\` 和 Unix `/`）。
fn extract_basename(name: &str) -> &str {
    if let Some(pos) = name.rfind(|c| c == '\\' || c == '/') {
        &name[pos + 1..]
    } else {
        name
    }
}

/// 对 entry 进行脱敏处理，返回脱敏后的副本。
fn sanitize_entry(mut entry: BackupActivityEntry) -> BackupActivityEntry {
    if let Some(ref msg) = entry.message {
        entry.message = Some(sanitize_message(msg));
    }

    if let Some(ref name) = entry.remote_file_name {
        let without_userinfo = remove_url_userinfo(name);
        let basename = extract_basename(&without_userinfo);
        let sanitized = basename.to_string();
        if sanitized != *name {
            entry.remote_file_name = Some(sanitized);
        }
    }
    if let Some(ref name) = entry.local_file_name {
        let without_userinfo = remove_url_userinfo(name);
        let basename = extract_basename(&without_userinfo);
        let sanitized = basename.to_string();
        if sanitized != *name {
            entry.local_file_name = Some(sanitized);
        }
    }

    // metrics.failedFileName 也可能包含绝对路径或 URL 凭证
    if let Some(ref mut metrics) = entry.metrics {
        if let Some(ref fname) = metrics.failed_file_name {
            let without_userinfo = remove_url_userinfo(fname);
            let basename = extract_basename(&without_userinfo);
            let sanitized = basename.to_string();
            if sanitized != *fname {
                metrics.failed_file_name = Some(sanitized);
            }
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

// ---------------------------------------------------------------------------
// 文件读写
// ---------------------------------------------------------------------------

/// 从文件加载日志。文件不存在或为空时返回空日志；解析失败返回明确错误；版本不匹配返回错误。
fn load_log_from_path(path: &Path) -> Result<BackupActivityLogFile, String> {
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
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建日志目录失败: {e}"))?;
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

    // id 兜底：为空时生成 UUID
    if entry.id.is_empty() {
        entry.id = generate_uuid();
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
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建日志目录失败: {e}"))?;
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

    let log = BackupActivityLogFile {
        version: LOG_VERSION,
        entries: Vec::new(),
    };
    let result = save_log_to_path(&path, &log);

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
            id: id.to_string(),
            operation: "backup".to_string(),
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
        assert!(result
            .unwrap_err()
            .contains("解析备份活动日志文件失败"));

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
        assert_eq!(loaded.entries[0].id, "test-001");
        assert_eq!(loaded.entries[0].operation, "backup");

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
        assert_eq!(loaded.entries[0].id, "entry-000");
        assert_eq!(loaded.entries[2].id, "entry-002");

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
        assert_eq!(log.entries[0].id, "entry-005");
        assert_eq!(log.entries[MAX_ENTRIES - 1].id, "entry-104");

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

    // -----------------------------------------------------------------------
    // 脱敏处理
    // -----------------------------------------------------------------------

    #[test]
    fn sanitize_message_replaces_sensitive_keywords() {
        // keyword=value 模式
        assert_eq!(
            sanitize_message("password=abc123"),
            "password=[REDACTED]"
        );
        assert_eq!(
            sanitize_message("token: xyz"),
            "token=[REDACTED]"
        );
        // 独立 keyword 模式
        assert_eq!(
            sanitize_message("password is abc123"),
            "password=[REDACTED] is abc123"
        );
        assert_eq!(
            sanitize_message("secret key"),
            "secret=[REDACTED] key"
        );
        // keyword_something 模式
        assert_eq!(
            sanitize_message("my_password_value"),
            "my_password=[REDACTED]"
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
        assert_eq!(result, "upload https://host1.com/a and https://host2.com/b done");
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

    // -----------------------------------------------------------------------
    // redact_local_paths
    // -----------------------------------------------------------------------

    #[test]
    fn redact_local_paths_windows_path() {
        assert_eq!(redact_local_paths("failed C:\\Users\\test\\backup.zip"), "failed [REDACTED]");
    }

    #[test]
    fn redact_local_paths_windows_path_forward_slash() {
        assert_eq!(redact_local_paths("path D:/backups/file.zip end"), "path [REDACTED] end");
    }

    #[test]
    fn redact_local_paths_unix_path() {
        assert_eq!(redact_local_paths("error /home/user/backups/test.zip"), "error [REDACTED]");
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
        assert!(variant_char == '8' || variant_char == '9' || variant_char == 'a' || variant_char == 'b');
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
    fn sanitize_entry_strips_local_path_to_basename() {
        let entry = BackupActivityEntry {
            id: "test".into(),
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
            local_file_name: Some("C:\\Users\\test\\backups\\SoNotes_Backup_20260626120000.zip".into()),
            summary: None,
            metrics: None,
        };
        let sanitized = sanitize_entry(entry);
        assert_eq!(sanitized.local_file_name.as_deref(), Some("SoNotes_Backup_20260626120000.zip"));
    }

    #[test]
    fn sanitize_entry_strips_remote_path_to_basename() {
        let entry = BackupActivityEntry {
            id: "test".into(),
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
        assert_eq!(sanitized.remote_file_name.as_deref(), Some("SoNotes_Backup_20260626120000.zip"));
    }
}
