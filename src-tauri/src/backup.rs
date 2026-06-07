//! 本地 zip 备份/恢复基础类型与安全验证
//!
//! 本模块提供备份清单、操作结果的序列化类型，以及 zip 条目路径的严格验证。
//! 备份文件结构：
//! - `manifest.json`：备份清单元数据
//! - `data.json`：便签/看板数据
//! - `attachments/<hash>.<ext>`：附件文件（仅允许一级扁平目录）

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 备份格式版本
// ---------------------------------------------------------------------------

/// 当前备份格式版本号。
///
/// 后续若修改 zip 内部结构（如新增顶层文件或改变清单 schema），应递增此值。
pub const BACKUP_FORMAT_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// 备份清单类型
// ---------------------------------------------------------------------------

/// 备份清单（`manifest.json` 的内容）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    /// 应用标识，固定为 `"SoNotes"`。
    pub app: String,
    /// 备份格式版本号。
    pub format_version: u32,
    /// 创建备份时的应用版本（来自 `Cargo.toml`）。
    pub app_version: String,
    /// 备份创建时间（毫秒级 Unix 时间戳）。
    pub created_at: u64,
    /// 备份中包含的便签数量。
    pub note_count: u32,
    /// 备份中包含的看板数量。
    pub board_count: u32,
    /// 备份中包含的附件文件数量。
    pub attachment_count: u32,
}

// ---------------------------------------------------------------------------
// 备份/恢复操作结果类型
// ---------------------------------------------------------------------------

/// 本地备份操作结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    /// 是否成功。
    pub success: bool,
    /// 备份文件的绝对路径（成功时）。
    pub backup_path: Option<String>,
    /// 便签数量。
    pub note_count: u32,
    /// 看板数量。
    pub board_count: u32,
    /// 附件数量。
    pub attachment_count: u32,
    /// 错误信息（失败时）。
    pub error: Option<String>,
}

/// 本地恢复操作结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    /// 是否成功。
    pub success: bool,
    /// 便签数量。
    pub note_count: u32,
    /// 看板数量。
    pub board_count: u32,
    /// 附件数量。
    pub attachment_count: u32,
    /// 错误信息（失败时）。
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Zip 条目路径验证
// ---------------------------------------------------------------------------

/// 验证 zip 条目路径是否为备份格式允许的安全路径。
///
/// 允许的路径：
/// - 恰好为 `manifest.json`
/// - 恰好为 `data.json`
/// - `attachments/<safe_filename>`，其中 `<safe_filename>` 为非空文件名，
///   不含路径分隔符且不是 `.` 或 `..`
///
/// 拒绝的路径（不完整列表）：
/// - 空字符串
/// - 绝对路径（以 `/` 开头）
/// - Windows 盘符路径（如 `C:\...` 或 `D:/...`）
/// - UNC 路径（以 `\\` 开头）
/// - 含反斜杠 `\`
/// - 含 `.` 或 `..` 路径段
/// - 目录条目（以 `/` 结尾）
/// - 嵌套 attachments 路径（如 `attachments/sub/file`）
pub fn validate_zip_entry_path(entry_name: &str) -> Result<(), String> {
    // 空路径
    if entry_name.is_empty() {
        return Err("zip 条目路径为空".to_string());
    }

    // 反斜杠（统一要求 zip 内使用正斜杠）
    if entry_name.contains('\\') {
        return Err(format!("zip 条目路径包含反斜杠: {entry_name:?}"));
    }

    // 目录条目（以 / 结尾）
    if entry_name.ends_with('/') {
        return Err(format!("zip 条目路径为目录条目: {entry_name:?}"));
    }

    // UNC 路径（// 开头，必须在绝对路径检查之前，否则会被 / 前缀先行拦截）
    if entry_name.starts_with("//") {
        return Err(format!("zip 条目路径为 UNC 路径: {entry_name:?}"));
    }

    // 绝对路径（单个 / 开头）
    if entry_name.starts_with('/') {
        return Err(format!("zip 条目路径为绝对路径: {entry_name:?}"));
    }

    // Windows 盘符路径（如 C:/... 或 c:\... 已被反斜杠检查拦截，这里处理 X:/... 形式）
    if entry_name.len() >= 3
        && entry_name.as_bytes()[0].is_ascii_alphabetic()
        && entry_name.as_bytes()[1] == b':'
        && entry_name.as_bytes()[2] == b'/'
    {
        return Err(format!("zip 条目路径为 Windows 盘符路径: {entry_name:?}"));
    }

    // 按 / 分段检查
    let parts: Vec<&str> = entry_name.split('/').collect();

    for part in &parts {
        if part.is_empty() {
            return Err(format!("zip 条目路径含空路径段: {entry_name:?}"));
        }
        if *part == "." || *part == ".." {
            return Err(format!("zip 条目路径含相对路径段 . 或 ..: {entry_name:?}"));
        }
    }

    // 逐条匹配允许的路径模式
    match parts.as_slice() {
        // manifest.json
        ["manifest.json"] => Ok(()),
        // data.json
        ["data.json"] => Ok(()),
        // attachments/<safe_filename>：仅允许一级文件名
        ["attachments", filename] => {
            // 文件名不能是 . 或 ..（已被上方检查拦截，这里再次确认）
            if *filename == "." || *filename == ".." {
                return Err(format!("附件文件名不能为 . 或 ..: {entry_name:?}"));
            }
            Ok(())
        }
        // 其他所有模式均拒绝
        _ => Err(format!("zip 条目路径不在允许范围内: {entry_name:?}")),
    }
}

// ===========================================================================
// 单元测试
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // validate_zip_entry_path：接受的路径
    // -----------------------------------------------------------------------

    #[test]
    fn accepts_manifest_json() {
        assert!(validate_zip_entry_path("manifest.json").is_ok());
    }

    #[test]
    fn accepts_data_json() {
        assert!(validate_zip_entry_path("data.json").is_ok());
    }

    #[test]
    fn accepts_attachment_with_common_extension() {
        assert!(validate_zip_entry_path("attachments/abc123def.png").is_ok());
    }

    #[test]
    fn accepts_attachment_without_extension() {
        assert!(validate_zip_entry_path("attachments/abc123def").is_ok());
    }

    #[test]
    fn accepts_attachment_with_long_hash_name() {
        assert!(validate_zip_entry_path(
            "attachments/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.jpg"
        )
        .is_ok());
    }

    #[test]
    fn accepts_attachment_with_dots_in_filename() {
        assert!(validate_zip_entry_path("attachments/file.name.jpg").is_ok());
    }

    #[test]
    fn accepts_attachment_with_hyphen_and_underscore() {
        assert!(validate_zip_entry_path("attachments/my-file_name.png").is_ok());
    }

    // -----------------------------------------------------------------------
    // validate_zip_entry_path：拒绝的路径 — 空路径
    // -----------------------------------------------------------------------

    #[test]
    fn rejects_empty_path() {
        let err = validate_zip_entry_path("").unwrap_err();
        assert!(err.contains("为空"), "错误信息应提及空路径: {err}");
    }

    // -----------------------------------------------------------------------
    // validate_zip_entry_path：拒绝的路径 — 反斜杠
    // -----------------------------------------------------------------------

    #[test]
    fn rejects_backslash() {
        let err = validate_zip_entry_path("manifest.json\\data.json").unwrap_err();
        assert!(err.contains("反斜杠"), "错误信息应提及反斜杠: {err}");
    }

    #[test]
    fn rejects_windows_backslash_path() {
        let err = validate_zip_entry_path("attachments\\secret.png").unwrap_err();
        assert!(err.contains("反斜杠"), "错误信息应提及反斜杠: {err}");
    }

    // -----------------------------------------------------------------------
    // validate_zip_entry_path：拒绝的路径 — 绝对路径
    // -----------------------------------------------------------------------

    #[test]
    fn rejects_absolute_path() {
        let err = validate_zip_entry_path("/etc/passwd").unwrap_err();
        assert!(err.contains("绝对路径"), "错误信息应提及绝对路径: {err}");
    }

    // -----------------------------------------------------------------------
    // validate_zip_entry_path：拒绝的路径 — 盘符路径
    // -----------------------------------------------------------------------

    #[test]
    fn rejects_windows_drive_path() {
        let err = validate_zip_entry_path("C:/Users/test/data.json").unwrap_err();
        assert!(
            err.contains("Windows 盘符路径"),
            "错误信息应提及盘符路径: {err}"
        );
    }

    #[test]
    fn rejects_windows_drive_lowercase() {
        let err = validate_zip_entry_path("d:/backup/data.json").unwrap_err();
        assert!(
            err.contains("Windows 盘符路径"),
            "错误信息应提及盘符路径: {err}"
        );
    }

    // -----------------------------------------------------------------------
    // validate_zip_entry_path：拒绝的路径 — UNC 路径
    // -----------------------------------------------------------------------

    #[test]
    fn rejects_unc_path() {
        let err = validate_zip_entry_path("//server/share/data.json").unwrap_err();
        assert!(err.contains("UNC 路径"), "错误信息应提及 UNC 路径: {err}");
    }

    // -----------------------------------------------------------------------
    // validate_zip_entry_path：拒绝的路径 — 目录条目
    // -----------------------------------------------------------------------

    #[test]
    fn rejects_directory_entry_attachments() {
        let err = validate_zip_entry_path("attachments/").unwrap_err();
        assert!(err.contains("目录条目"), "错误信息应提及目录条目: {err}");
    }

    #[test]
    fn rejects_directory_entry_root() {
        let err = validate_zip_entry_path("data/").unwrap_err();
        assert!(err.contains("目录条目"), "错误信息应提及目录条目: {err}");
    }

    // -----------------------------------------------------------------------
    // validate_zip_entry_path：拒绝的路径 — 点路径段
    // -----------------------------------------------------------------------

    #[test]
    fn rejects_dot_slash_data_json() {
        let err = validate_zip_entry_path("./data.json").unwrap_err();
        assert!(
            err.contains("相对路径段"),
            "错误信息应提及相对路径段: {err}"
        );
    }

    #[test]
    fn rejects_dot_dot_slash_data_json() {
        let err = validate_zip_entry_path("../data.json").unwrap_err();
        assert!(
            err.contains("相对路径段"),
            "错误信息应提及相对路径段: {err}"
        );
    }

    #[test]
    fn rejects_traversal_in_attachments() {
        let err = validate_zip_entry_path("attachments/../../secret").unwrap_err();
        assert!(
            err.contains("相对路径段"),
            "错误信息应提及相对路径段: {err}"
        );
    }

    #[test]
    fn rejects_dot_dot_in_attachment_filename() {
        let err = validate_zip_entry_path("attachments/..").unwrap_err();
        assert!(
            err.contains("相对路径段"),
            "错误信息应提及相对路径段: {err}"
        );
    }

    #[test]
    fn rejects_single_dot_as_attachment_filename() {
        let err = validate_zip_entry_path("attachments/.").unwrap_err();
        assert!(
            err.contains("相对路径段"),
            "错误信息应提及相对路径段: {err}"
        );
    }

    // -----------------------------------------------------------------------
    // validate_zip_entry_path：拒绝的路径 — 空路径段
    // -----------------------------------------------------------------------

    #[test]
    fn rejects_double_slash() {
        let err = validate_zip_entry_path("attachments//file.png").unwrap_err();
        assert!(err.contains("空路径段"), "错误信息应提及空路径段: {err}");
    }

    // -----------------------------------------------------------------------
    // validate_zip_entry_path：拒绝的路径 — 嵌套 attachments
    // -----------------------------------------------------------------------

    #[test]
    fn rejects_nested_attachments_path() {
        let err = validate_zip_entry_path("attachments/subdir/file.png").unwrap_err();
        assert!(
            err.contains("不在允许范围内"),
            "错误信息应提及路径不在允许范围: {err}"
        );
    }

    #[test]
    fn rejects_deeply_nested_attachments() {
        let err = validate_zip_entry_path("attachments/a/b/c/d/file.png").unwrap_err();
        assert!(
            err.contains("不在允许范围内"),
            "错误信息应提及路径不在允许范围: {err}"
        );
    }

    // -----------------------------------------------------------------------
    // validate_zip_entry_path：拒绝的路径 — 非法顶层文件
    // -----------------------------------------------------------------------

    #[test]
    fn rejects_unknown_top_level_file() {
        let err = validate_zip_entry_path("unknown.json").unwrap_err();
        assert!(
            err.contains("不在允许范围内"),
            "错误信息应提及路径不在允许范围: {err}"
        );
    }

    #[test]
    fn rejects_manifest_json_with_extra_segment() {
        let err = validate_zip_entry_path("subdir/manifest.json").unwrap_err();
        assert!(
            err.contains("不在允许范围内"),
            "错误信息应提及路径不在允许范围: {err}"
        );
    }

    #[test]
    fn rejects_data_json_with_prefix() {
        let err = validate_zip_entry_path("backup/data.json").unwrap_err();
        assert!(
            err.contains("不在允许范围内"),
            "错误信息应提及路径不在允许范围: {err}"
        );
    }

    // -----------------------------------------------------------------------
    // BackupManifest 序列化/反序列化往返
    // -----------------------------------------------------------------------

    #[test]
    fn manifest_roundtrip_serde_json() {
        let manifest = BackupManifest {
            app: "SoNotes".to_string(),
            format_version: BACKUP_FORMAT_VERSION,
            app_version: "1.4.9".to_string(),
            created_at: 1700000000000,
            note_count: 42,
            board_count: 3,
            attachment_count: 7,
        };

        let json = serde_json::to_string(&manifest).expect("序列化失败");
        let deserialized: BackupManifest = serde_json::from_str(&json).expect("反序列化失败");

        assert_eq!(deserialized.app, "SoNotes");
        assert_eq!(deserialized.format_version, BACKUP_FORMAT_VERSION);
        assert_eq!(deserialized.app_version, "1.4.9");
        assert_eq!(deserialized.created_at, 1700000000000);
        assert_eq!(deserialized.note_count, 42);
        assert_eq!(deserialized.board_count, 3);
        assert_eq!(deserialized.attachment_count, 7);
    }

    #[test]
    fn manifest_json_keys_are_camel_case() {
        let manifest = BackupManifest {
            app: "SoNotes".to_string(),
            format_version: 1,
            app_version: "1.4.9".to_string(),
            created_at: 0,
            note_count: 0,
            board_count: 0,
            attachment_count: 0,
        };

        let json = serde_json::to_string(&manifest).expect("序列化失败");
        assert!(
            json.contains("\"formatVersion\""),
            "应使用 camelCase: {json}"
        );
        assert!(json.contains("\"appVersion\""), "应使用 camelCase: {json}");
        assert!(json.contains("\"createdAt\""), "应使用 camelCase: {json}");
        assert!(json.contains("\"noteCount\""), "应使用 camelCase: {json}");
        assert!(json.contains("\"boardCount\""), "应使用 camelCase: {json}");
        assert!(
            json.contains("\"attachmentCount\""),
            "应使用 camelCase: {json}"
        );
    }

    // -----------------------------------------------------------------------
    // BackupResult / RestoreResult 序列化往返
    // -----------------------------------------------------------------------

    #[test]
    fn backup_result_roundtrip() {
        let result = BackupResult {
            success: true,
            backup_path: Some("/path/to/backup.zip".to_string()),
            note_count: 10,
            board_count: 2,
            attachment_count: 5,
            error: None,
        };

        let json = serde_json::to_string(&result).expect("序列化失败");
        let deserialized: BackupResult = serde_json::from_str(&json).expect("反序列化失败");

        assert!(deserialized.success);
        assert_eq!(
            deserialized.backup_path,
            Some("/path/to/backup.zip".to_string())
        );
        assert_eq!(deserialized.note_count, 10);
        assert!(deserialized.error.is_none());
    }

    #[test]
    fn restore_result_with_error() {
        let result = RestoreResult {
            success: false,
            note_count: 0,
            board_count: 0,
            attachment_count: 0,
            error: Some("清单验证失败".to_string()),
        };

        let json = serde_json::to_string(&result).expect("序列化失败");
        let deserialized: RestoreResult = serde_json::from_str(&json).expect("反序列化失败");

        assert!(!deserialized.success);
        assert_eq!(deserialized.error, Some("清单验证失败".to_string()));
    }
}
