//! 备份活动日志持久化
//!
//! 本模块提供备份活动日志的加载、追加与清除命令。日志文件存储在
//! `app_config_dir()` 下的 `backup-activity-log.json`，采用原子写入
//! 以避免并发写入导致的数据损坏。
//!
//! - 文件路径：`backup-activity-log.json`
//! - 最大条目数：100（超出时移除最旧条目）
//! - Rust 侧脱敏：message 字段自动过滤敏感信息并截断至 240 字符

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/// 日志文件名。
const LOG_FILENAME: &str = "backup-activity-log.json";

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

/// 对 message 字段进行脱敏处理：
/// 1. 替换包含敏感关键词的整行
/// 2. 移除 URL 中的 userinfo（`://user:pass@`）
/// 3. 截断至 240 字符
fn sanitize_message(message: &str) -> String {
    let mut result = String::with_capacity(message.len());

    for line in message.lines() {
        let lower = line.to_lowercase();
        let has_sensitive_keyword = SENSITIVE_KEYWORDS.iter().any(|kw| lower.contains(kw));

        if has_sensitive_keyword {
            result.push_str("[REDACTED]");
        } else {
            // 移除 URL userinfo：`://user:pass@` → `://`
            let sanitized = remove_url_userinfo(line);
            result.push_str(&sanitized);
        }
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

/// 移除 URL 中的 userinfo 部分。
/// 匹配 `://` 后紧跟的 `user:pass@` 模式。
fn remove_url_userinfo(s: &str) -> String {
    // 查找 `://` 后面是否有 `user:pass@` 模式
    if let Some(protocol_end) = s.find("://") {
        let after_protocol = protocol_end + 3;
        if let Some(at_pos) = s[after_protocol..].find('@') {
            // 确保 `://` 和 `@` 之间有 `:`（即 user:pass 格式）
            let userinfo_region = &s[after_protocol..after_protocol + at_pos];
            if userinfo_region.contains(':') {
                let mut result = String::with_capacity(s.len());
                result.push_str(&s[..after_protocol]);
                result.push_str(&s[after_protocol + at_pos + 1..]);
                return result;
            }
        }
    }
    s.to_string()
}

/// 对 entry 进行脱敏处理，返回脱敏后的副本。
fn sanitize_entry(mut entry: BackupActivityEntry) -> BackupActivityEntry {
    // 脱敏 message 字段
    if let Some(ref msg) = entry.message {
        entry.message = Some(sanitize_message(msg));
    }

    // 脱敏 remote_file_name 和 local_file_name（移除可能的 userinfo）
    if let Some(ref name) = entry.remote_file_name {
        let sanitized = remove_url_userinfo(name);
        if sanitized != *name {
            entry.remote_file_name = Some(sanitized);
        }
    }
    if let Some(ref name) = entry.local_file_name {
        let sanitized = remove_url_userinfo(name);
        if sanitized != *name {
            entry.local_file_name = Some(sanitized);
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

/// 从文件加载日志。文件不存在时返回空日志；解析失败返回明确错误。
fn load_log_from_path(path: &Path) -> Result<BackupActivityLogFile, String> {
    if !path.exists() {
        return Ok(BackupActivityLogFile {
            version: LOG_VERSION,
            entries: Vec::new(),
        });
    }

    let content =
        std::fs::read_to_string(path).map_err(|e| format!("读取备份活动日志文件失败: {e}"))?;

    let file: BackupActivityLogFile =
        serde_json::from_str(&content).map_err(|e| format!("解析备份活动日志文件失败: {e}"))?;

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
#[tauri::command]
pub async fn backup_activity_append(
    app: tauri::AppHandle,
    entry: BackupActivityEntry,
) -> Result<(), String> {
    let path = log_file_path(&app)?;
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

    save_log_to_path(&path, &log)
}

/// 清除所有备份活动日志条目。
///
/// 写入一个空的日志文件（保留版本号）。
#[tauri::command]
pub async fn backup_activity_clear(app: tauri::AppHandle) -> Result<(), String> {
    let path = log_file_path(&app)?;
    let log = BackupActivityLogFile {
        version: LOG_VERSION,
        entries: Vec::new(),
    };
    save_log_to_path(&path, &log)
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
        assert_eq!(sanitize_message("password is abc123"), "[REDACTED]");
        assert_eq!(sanitize_message("token: xyz"), "[REDACTED]");
        assert_eq!(sanitize_message("Authorization: Bearer xxx"), "[REDACTED]");
        assert_eq!(sanitize_message("secret key"), "[REDACTED]");
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
        assert_eq!(result.len(), 240);
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
        // `://user@host` 格式不应被修改（没有密码部分）
        let url = "https://user@example.com/path";
        assert_eq!(remove_url_userinfo(url), "https://user@example.com/path");
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
}
