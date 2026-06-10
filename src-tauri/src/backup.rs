//! 本地 zip 备份/恢复基础类型与安全验证
//!
//! 本模块提供备份清单、操作结果的序列化类型，以及 zip 条目路径的严格验证。
//! 备份文件结构：
//! - `manifest.json`：备份清单元数据
//! - `data.json`：便签/看板数据
//! - `attachments/<hash>.<ext>`：图片文件（仅允许一级扁平目录）

use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::Manager;

// ---------------------------------------------------------------------------
// 备份格式版本
// ---------------------------------------------------------------------------

/// 当前备份格式版本号。
///
/// 后续若修改 zip 内部结构（如新增顶层文件或改变清单 schema），应递增此值。
pub const BACKUP_FORMAT_VERSION: u32 = 1;
const MAX_MANIFEST_JSON_UNCOMPRESSED_BYTES: u64 = 1024 * 1024;
const MAX_DATA_JSON_UNCOMPRESSED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ATTACHMENT_UNCOMPRESSED_BYTES: u64 = 256 * 1024 * 1024;
#[cfg(not(test))]
const MAX_ATTACHMENT_COUNT: usize = 10_000;
#[cfg(test)]
const MAX_ATTACHMENT_COUNT: usize = 8;
#[cfg(not(test))]
const MAX_TOTAL_ATTACHMENT_UNCOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;
#[cfg(test)]
const MAX_TOTAL_ATTACHMENT_UNCOMPRESSED_BYTES: u64 = 64;

// ---------------------------------------------------------------------------
// 备份清单类型
// ---------------------------------------------------------------------------

/// 备份中单个图片文件的元数据条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupAttachmentEntry {
    /// Zip 内的条目路径，如 `attachments/abc123.png`。
    pub zip_entry_path: String,
    /// 文件的 SHA-256 哈希（64 字符十六进制）。
    pub sha256: String,
    /// 文件字节数。
    pub size: u64,
}

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
    /// 备份中包含的图片文件数量。
    pub attachment_count: u32,
    /// 图片文件元数据与校验信息，用于恢复时验证完整性。
    pub attachments: Vec<BackupAttachmentEntry>,
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
    /// 图片文件数量。
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
    /// 图片文件数量。
    pub attachment_count: u32,
    /// 错误信息（失败时）。
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// 备份验证结果类型
// ---------------------------------------------------------------------------

/// 备份验证结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupValidationResult {
    /// 验证是否通过（`errors` 为空时为 `true`）。
    pub ok: bool,
    /// 备份摘要（验证通过时存在）。
    pub summary: Option<BackupSummary>,
    /// 验证错误列表。
    pub errors: Vec<BackupValidationIssue>,
    /// 验证警告列表。
    pub warnings: Vec<BackupValidationIssue>,
}

/// 备份摘要。
///
/// 描述备份包中的看板、便签和图片文件统计信息。
/// 不包含便签正文内容。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    /// 应用标识。
    pub app: String,
    /// 备份格式版本号。
    pub format_version: u32,
    /// 创建备份时的应用版本。
    pub app_version: String,
    /// 备份创建时间（毫秒级 Unix 时间戳）。
    pub created_at: u64,
    /// 便签总数。
    pub note_count: u32,
    /// 看板总数。
    pub board_count: u32,
    /// 文本便签数量。
    pub text_note_count: u32,
    /// 图片便签数量。
    pub image_note_count: u32,
    /// 废纸篓中的便签数量。
    pub trash_note_count: u32,
    /// 图片文件数量。
    pub image_file_count: u32,
    /// 图片文件总字节数。
    pub image_file_total_bytes: u64,
}

/// 备份验证问题。
///
/// 描述验证过程中发现的单个错误或警告。
/// `code` 为稳定的错误码，`severity` 为 `"error"` 或 `"warning"`。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupValidationIssue {
    /// 稳定错误码，如 `missing_manifest`、`invalid_zip`。
    pub code: String,
    /// 严重程度：`"error"` 或 `"warning"`。
    pub severity: String,
    /// 人类可读的描述信息。
    pub message: String,
    /// 问题所在的验证目标，如 `backup_file`、`zip`、`manifest`、`data`、`image_file`、`zip_entry`。
    pub target: Option<String>,
    /// 问题相关的文件路径（如 zip 内条目路径）。
    pub path: Option<String>,
    /// 问题相关的便签 ID。
    pub note_id: Option<String>,
    /// 问题相关的图片文件 ID。
    pub image_file_id: Option<String>,
}

impl BackupValidationIssue {
    /// 创建新的验证问题。
    pub fn new(
        code: impl Into<String>,
        severity: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            severity: severity.into(),
            message: message.into(),
            target: None,
            path: None,
            note_id: None,
            image_file_id: None,
        }
    }

    /// 创建 `severity` 为 `"error"` 的验证问题。
    pub fn error(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(code, "error", message)
    }

    /// 创建 `severity` 为 `"warning"` 的验证问题。
    pub fn warning(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(code, "warning", message)
    }

    /// 设置 `target` 字段。
    pub fn with_target(mut self, target: impl Into<String>) -> Self {
        self.target = Some(target.into());
        self
    }

    /// 设置 `path` 字段。
    pub fn with_path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }

    /// 设置 `note_id` 字段。
    pub fn with_note_id(mut self, note_id: impl Into<String>) -> Self {
        self.note_id = Some(note_id.into());
        self
    }

    /// 设置 `image_file_id` 字段。
    pub fn with_image_file_id(mut self, image_file_id: impl Into<String>) -> Self {
        self.image_file_id = Some(image_file_id.into());
        self
    }
}

// ---------------------------------------------------------------------------
// 恢复专用解析类型
// ---------------------------------------------------------------------------

/// 用于恢复时解析 `data.json` 的结构。
///
/// 要求 `config`、`storageUpdatedAt` 和完整的 board/note 必填字段，
/// 以便在恢复前完整校验 `StorageData` 契约。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageDataForRestore {
    schema_version: u32,
    current_board_id: String,
    storage_updated_at: f64,
    config: ConfigForRestore,
    boards: Vec<BoardForRestore>,
    notes: Vec<NoteForRestore>,
}

/// 恢复时校验 config 对象的结构。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigForRestore {
    version: f64,
    max_z: f64,
    theme_mode: String,
}

/// 恢复时校验看板对象的结构。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoardForRestore {
    id: String,
    name: String,
    icon: String,
    created_at: f64,
    #[serde(default)]
    viewport: Option<BoardViewportForRestore>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoardViewportForRestore {
    x: f64,
    y: f64,
}

/// 用于恢复时解析便签的结构。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteForRestore {
    id: String,
    #[serde(default = "default_note_kind")]
    kind: String,
    #[serde(default)]
    board_id: Option<String>,
    x: f64,
    y: f64,
    z: f64,
    title: String,
    content: String,
    color: String,
    created_at: f64,
    updated_at: f64,
    #[serde(default)]
    deleted_at: Option<f64>,
    #[serde(default)]
    collapsed: Option<bool>,
    #[serde(default)]
    attachments: Option<Vec<AttachmentRefForRestore>>,
}

fn default_note_kind() -> String {
    "text".to_string()
}

/// 恢复时校验图片引用的结构，包含 `hash` 字段。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentRefForRestore {
    id: String,
    hash: String,
    filename: String,
    mime_type: String,
    size: f64,
    relative_path: String,
    created_at: f64,
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
                return Err(format!("图片文件名不能为 . 或 ..: {entry_name:?}"));
            }
            Ok(())
        }
        // 其他所有模式均拒绝
        _ => Err(format!("zip 条目路径不在允许范围内: {entry_name:?}")),
    }
}

struct TempZipGuard {
    path: PathBuf,
    keep: bool,
}

impl TempZipGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, keep: false }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn keep(mut self) {
        self.keep = true;
    }
}

impl Drop for TempZipGuard {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn create_temp_zip_guard(resolved_path: &Path) -> Result<(TempZipGuard, std::fs::File), String> {
    let parent = resolved_path
        .parent()
        .ok_or_else(|| format!("备份目标路径缺少父目录: {}", resolved_path.display()))?;
    let file_name = resolved_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("备份目标文件名无效: {}", resolved_path.display()))?;

    for _ in 0..16 {
        let temp_path = parent.join(format!(
            ".{file_name}.{:032x}.tmp",
            rand::random::<u128>()
        ));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
        {
            Ok(file) => return Ok((TempZipGuard::new(temp_path), file)),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(format!("创建临时 zip 文件失败: {err}")),
        }
    }

    Err("创建临时 zip 文件失败: 临时文件名冲突过多".to_string())
}

struct RestoreStagingGuard {
    path: PathBuf,
}

impl RestoreStagingGuard {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl Drop for RestoreStagingGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

// ---------------------------------------------------------------------------
// 内部辅助函数
// ---------------------------------------------------------------------------

/// 如果目标路径已存在，生成带后缀 `_1`、`_2` 的确定性安全兄弟路径。
///
/// 保证不静默覆盖已有文件。当所有 `_1` 至 `_999` 均被占用时，
/// 回退到附加毫秒时间戳。
fn resolve_unique_backup_path(target: &Path) -> PathBuf {
    if !target.exists() {
        return target.to_path_buf();
    }

    let stem = target.file_stem().unwrap_or_default().to_string_lossy();
    let ext = target
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let parent = target.parent().unwrap_or(Path::new("."));

    for i in 1_u32..=999 {
        let candidate = parent.join(format!("{stem}_{i}{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }

    // 极端回退：附加时间戳
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    parent.join(format!("{stem}_{now}{ext}"))
}

// ---------------------------------------------------------------------------
// 恢复验证常量与辅助函数
// ---------------------------------------------------------------------------

const SUPPORTED_SCHEMA_VERSIONS: &[u32] = &[1, 2];
const VALID_NOTE_KINDS: &[&str] = &["text", "image"];

fn compute_sha256(data: &[u8]) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(data);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn is_valid_hash_stem(stem: &str) -> bool {
    stem.len() == 64 && stem.chars().all(|c| c.is_ascii_hexdigit())
}

fn restore_data_file(data_bak: &Path, data_path: &Path, had_old_data: bool) {
    let _ = std::fs::remove_file(data_path);
    if had_old_data {
        let _ = std::fs::rename(data_bak, data_path);
    }
}

fn restore_attachment_dir(attach_bak: &Path, attach_dir: &Path, had_old_attach: bool) {
    let _ = std::fs::remove_dir_all(attach_dir);
    if had_old_attach {
        let _ = std::fs::rename(attach_bak, attach_dir);
    }
}

fn ensure_uncompressed_size(label: &str, size: u64, limit: u64) -> Result<(), String> {
    if size > limit {
        return Err(format!("{label} 解压后大小超过上限: {size} 字节"));
    }

    Ok(())
}

fn read_zip_entry_limited<R: Read>(
    reader: &mut R,
    label: &str,
    declared_size: u64,
    limit: u64,
) -> Result<Vec<u8>, String> {
    ensure_uncompressed_size(label, declared_size, limit)?;

    let mut limited_reader = reader.take(limit.saturating_add(1));
    let mut buf = Vec::new();
    limited_reader
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取 {label} 失败: {e}"))?;

    if buf.len() as u64 > limit {
        return Err(format!("{label} 实际解压大小超过上限: {} 字节", buf.len()));
    }

    if declared_size != buf.len() as u64 {
        return Err(format!(
            "{label} 声明大小与实际读取大小不匹配: 声明 {declared_size} 字节, 实际 {} 字节",
            buf.len()
        ));
    }

    Ok(buf)
}

fn validate_storage_data_contract(
    data: &StorageDataForRestore,
    attachment_contents: &std::collections::HashMap<String, Vec<u8>>,
) -> Result<HashSet<String>, String> {
    if !SUPPORTED_SCHEMA_VERSIONS.contains(&data.schema_version) {
        return Err(format!("不支持的 schemaVersion: {}", data.schema_version));
    }

    if !data.storage_updated_at.is_finite() || data.storage_updated_at < 0.0 {
        return Err(format!(
            "storageUpdatedAt 必须为有限非负数，实际值: {}",
            data.storage_updated_at
        ));
    }

    if !data.config.version.is_finite() || data.config.version < 0.0 {
        return Err("config.version 必须为有效非负数".to_string());
    }
    if !data.config.max_z.is_finite() || data.config.max_z < 0.0 {
        return Err("config.maxZ 必须为有效非负数".to_string());
    }
    if data.config.theme_mode.is_empty() {
        return Err("config.themeMode 不能为空".to_string());
    }

    if data.boards.is_empty() {
        return Err("boards 不能为空".to_string());
    }

    let mut board_ids: HashSet<String> = HashSet::new();
    for board in &data.boards {
        if board.id.is_empty() {
            return Err("看板 id 不能为空".to_string());
        }
        if board.name.is_empty() {
            return Err(format!("看板 {} 的 name 不能为空", board.id));
        }
        if board.icon.is_empty() {
            return Err(format!("看板 {} 的 icon 不能为空", board.id));
        }
        if !board.created_at.is_finite() || board.created_at < 0.0 {
            return Err(format!("看板 {} 的 createdAt 必须为有效非负数", board.id));
        }
        if let Some(viewport) = &board.viewport {
            if !viewport.x.is_finite() {
                return Err(format!("看板 {} 的 viewport x 必须为有限数", board.id));
            }
            if !viewport.y.is_finite() {
                return Err(format!("看板 {} 的 viewport y 必须为有限数", board.id));
            }
        }
        if !board_ids.insert(board.id.clone()) {
            return Err(format!("看板 id 重复: {}", board.id));
        }
    }

    if data.current_board_id.is_empty() {
        return Err("currentBoardId 不能为空".to_string());
    }
    if !board_ids.contains(&data.current_board_id) {
        return Err(format!(
            "currentBoardId 引用了不存在的看板: {}",
            data.current_board_id
        ));
    }

    let mut data_image_refs: HashSet<String> = HashSet::new();
    let mut note_ids: HashSet<String> = HashSet::new();

    for note in &data.notes {
        if note.id.is_empty() {
            return Err("便签 id 不能为空".to_string());
        }
        if !note_ids.insert(note.id.clone()) {
            return Err(format!("便签 id 重复: {}", note.id));
        }
        if !VALID_NOTE_KINDS.contains(&note.kind.as_str()) {
            return Err(format!("便签 {} 的 kind 值无效: {}", note.id, note.kind));
        }

        if !note.x.is_finite() {
            return Err(format!("便签 {} 的 x 坐标必须为有限数", note.id));
        }
        if !note.y.is_finite() {
            return Err(format!("便签 {} 的 y 坐标必须为有限数", note.id));
        }
        if !note.z.is_finite() {
            return Err(format!("便签 {} 的 z 坐标必须为有限数", note.id));
        }
        let _ = (&note.title, &note.content);
        if note.color.is_empty() {
            return Err(format!("便签 {} 的 color 不能为空", note.id));
        }
        if !note.created_at.is_finite() || note.created_at < 0.0 {
            return Err(format!("便签 {} 的 createdAt 必须为有效非负数", note.id));
        }
        if !note.updated_at.is_finite() || note.updated_at < 0.0 {
            return Err(format!("便签 {} 的 updatedAt 必须为有效非负数", note.id));
        }
        if let Some(deleted_at) = note.deleted_at {
            if !deleted_at.is_finite() || deleted_at < 0.0 {
                return Err(format!("便签 {} 的 deletedAt 必须为有效非负数", note.id));
            }
        }
        if let Some(collapsed) = note.collapsed {
            let _ = collapsed;
        }

        let is_trashed = note.deleted_at.is_some();
        match &note.board_id {
            Some(bid) if !bid.is_empty() => {
                if !board_ids.contains(bid) {
                    return Err(format!("便签 {} 引用了不存在的看板: {}", note.id, bid));
                }
            }
            _ => {
                if !is_trashed {
                    return Err(format!("非废纸篓便签 {} 缺少有效的 boardId", note.id));
                }
            }
        }

        match note.kind.as_str() {
            "text" => {
                if let Some(ref attachments) = note.attachments {
                    if !attachments.is_empty() {
                        return Err(format!("文本便签 {} 不应包含图片引用", note.id));
                    }
                }
            }
            "image" => {
                let attachments = note
                    .attachments
                    .as_ref()
                    .ok_or_else(|| format!("图片便签 {} 缺少附件引用", note.id))?;

                if attachments.len() != 1 {
                    return Err(format!(
                        "图片便签 {} 应恰好有一个附件引用，实际有 {} 个",
                        note.id,
                        attachments.len()
                    ));
                }

                let att = &attachments[0];

                if att.id.is_empty() {
                    return Err(format!("图片便签 {} 的附件 id 不能为空", note.id));
                }
                if att.hash.is_empty() {
                    return Err(format!("图片便签 {} 的附件 hash 不能为空", note.id));
                }
                if att.filename.is_empty() {
                    return Err(format!("图片便签 {} 的附件 filename 不能为空", note.id));
                }
                if att.mime_type.is_empty() {
                    return Err(format!("图片便签 {} 的附件 mimeType 不能为空", note.id));
                }
                if !att.size.is_finite() || att.size < 0.0 {
                    return Err(format!("图片便签 {} 的附件 size 必须为有效非负数", note.id));
                }
                if !att.created_at.is_finite() || att.created_at < 0.0 {
                    return Err(format!(
                        "图片便签 {} 的附件 createdAt 必须为有效非负数",
                        note.id
                    ));
                }

                if let Some(content) = attachment_contents.get(&att.relative_path) {
                    if content.len() as f64 != att.size {
                        return Err(format!(
                            "图片便签 {} 的附件 size 与文件大小不匹配: size={}, 实际={}",
                            note.id,
                            att.size,
                            content.len()
                        ));
                    }
                }

                let rel_path = &att.relative_path;
                validate_zip_entry_path(rel_path)?;

                let file_stem = Path::new(rel_path)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .ok_or_else(|| {
                        format!(
                            "图片便签 {} 的附件路径无法提取文件名: {}",
                            note.id, rel_path
                        )
                    })?;

                if !is_valid_hash_stem(file_stem) {
                    return Err(format!(
                        "图片便签 {} 的附件文件名不是合法哈希: {}",
                        note.id, rel_path
                    ));
                }

                if att.hash != file_stem {
                    return Err(format!(
                        "图片便签 {} 的附件 hash 与文件名不匹配: hash={}, 文件名={}",
                        note.id, att.hash, file_stem
                    ));
                }

                if let Some(content) = attachment_contents.get(rel_path) {
                    let actual_hash = compute_sha256(content);
                    if att.hash != actual_hash {
                        return Err(format!(
                            "图片便签 {} 的附件 hash 与内容 SHA-256 不匹配: hash={}, 实际={}",
                            note.id, att.hash, actual_hash
                        ));
                    }
                }

                data_image_refs.insert(rel_path.clone());
            }
            _ => unreachable!(),
        }
    }

    Ok(data_image_refs)
}

fn validate_attachment_refs_for_path(
    data: &StorageDataForRestore,
    relative_path: &str,
    sha256: &str,
    size: u64,
) -> Result<(), String> {
    let mut matched = false;

    for attachment in data
        .notes
        .iter()
        .filter_map(|note| note.attachments.as_ref())
        .flat_map(|attachments| attachments.iter())
        .filter(|attachment| attachment.relative_path == relative_path)
    {
        matched = true;
        if attachment.hash != sha256 {
            return Err(format!(
                "图片文件 {relative_path} 的 hash 与 data.json 不匹配: data={}, 实际={}",
                attachment.hash, sha256
            ));
        }
        if attachment.size != size as f64 {
            return Err(format!(
                "图片文件 {relative_path} 的 size 与 data.json 不匹配: data={}, 实际={}",
                attachment.size, size
            ));
        }
    }

    if !matched {
        return Err(format!("数据中缺少图片引用: {relative_path}"));
    }

    Ok(())
}

fn validate_restored_data(
    data: &StorageDataForRestore,
    manifest: &BackupManifest,
    attachment_contents: &std::collections::HashMap<String, Vec<u8>>,
) -> Result<(), String> {
    if manifest.attachment_count != manifest.attachments.len() as u32 {
        return Err(format!(
            "备份清单图片数量不匹配: attachmentCount={}, attachments={}",
            manifest.attachment_count,
            manifest.attachments.len()
        ));
    }

    let mut manifest_paths: HashSet<String> = HashSet::new();
    for att in &manifest.attachments {
        validate_zip_entry_path(&att.zip_entry_path)?;
        if !manifest_paths.insert(att.zip_entry_path.clone()) {
            return Err(format!(
                "备份清单中存在重复图片条目: {}",
                att.zip_entry_path
            ));
        }
    }

    let data_image_refs = validate_storage_data_contract(data, attachment_contents)?;

    for ref_path in &data_image_refs {
        if !manifest_paths.contains(ref_path) {
            return Err(format!("数据中引用的图片 {ref_path} 不在备份清单中"));
        }
    }

    for att in &manifest.attachments {
        if !data_image_refs.contains(&att.zip_entry_path) {
            return Err(format!(
                "备份清单中的图片 {} 未被数据引用",
                att.zip_entry_path
            ));
        }
    }

    for att in &manifest.attachments {
        let content = attachment_contents
            .get(&att.zip_entry_path)
            .ok_or_else(|| format!("zip 中缺少图片文件: {}", att.zip_entry_path))?;

        let actual_hash = compute_sha256(content);

        if actual_hash != att.sha256 {
            return Err(format!(
                "图片文件 {} 的 SHA-256 不匹配: 期望 {}, 实际 {}",
                att.zip_entry_path, att.sha256, actual_hash
            ));
        }

        if content.len() as u64 != att.size {
            return Err(format!(
                "图片文件 {} 的大小不匹配: 期望 {} 字节, 实际 {} 字节",
                att.zip_entry_path,
                att.size,
                content.len()
            ));
        }

        let file_stem = Path::new(&att.zip_entry_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");

        if file_stem != actual_hash {
            return Err(format!(
                "图片文件 {} 的文件名哈希与内容哈希不匹配: 文件名 {}, 内容 {}",
                att.zip_entry_path, file_stem, actual_hash
            ));
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// 恢复核心逻辑
// ---------------------------------------------------------------------------

fn restore_local_backup_inner(
    sonotes_base: &Path,
    source_zip_path: &Path,
) -> Result<RestoreResult, String> {
    // -- Phase 1: 扫描 zip 条目，验证路径安全，检测重复 --
    let zip_file =
        std::fs::File::open(source_zip_path).map_err(|e| format!("打开备份文件失败: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(zip_file).map_err(|e| format!("读取 zip 文件失败: {e}"))?;

    let mut has_manifest = false;
    let mut has_data = false;
    let mut seen_entries: HashSet<String> = HashSet::new();
    let mut manifest_content: Option<String> = None;
    let mut data_content: Option<Vec<u8>> = None;
    let mut attachment_contents: std::collections::HashMap<String, Vec<u8>> =
        std::collections::HashMap::new();
    let mut attachment_count: usize = 0;
    let mut total_attachment_bytes: u64 = 0;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 zip 条目失败: {e}"))?;
        let name = entry.name().to_string();

        validate_zip_entry_path(&name)?;

        if !seen_entries.insert(name.clone()) {
            return Err(format!("zip 中存在重复条目: {name}"));
        }

        match name.as_str() {
            "manifest.json" => {
                has_manifest = true;
                let declared_size = entry.size();
                let buf = read_zip_entry_limited(
                    &mut entry,
                    "manifest.json",
                    declared_size,
                    MAX_MANIFEST_JSON_UNCOMPRESSED_BYTES,
                )?;
                let content =
                    String::from_utf8(buf).map_err(|e| format!("读取 manifest.json 失败: {e}"))?;
                manifest_content = Some(content);
            }
            "data.json" => {
                has_data = true;
                let declared_size = entry.size();
                let buf = read_zip_entry_limited(
                    &mut entry,
                    "data.json",
                    declared_size,
                    MAX_DATA_JSON_UNCOMPRESSED_BYTES,
                )?;
                data_content = Some(buf);
            }
            path if path.starts_with("attachments/") => {
                attachment_count = attachment_count
                    .checked_add(1)
                    .ok_or_else(|| "附件数量超过上限".to_string())?;
                if attachment_count > MAX_ATTACHMENT_COUNT {
                    return Err(format!("附件数量超过上限: {attachment_count}"));
                }

                let declared_size = entry.size();
                let buf = read_zip_entry_limited(
                    &mut entry,
                    &format!("附件 {path}"),
                    declared_size,
                    MAX_ATTACHMENT_UNCOMPRESSED_BYTES,
                )?;

                total_attachment_bytes = total_attachment_bytes
                    .checked_add(buf.len() as u64)
                    .ok_or_else(|| "附件总大小超过上限".to_string())?;
                if total_attachment_bytes > MAX_TOTAL_ATTACHMENT_UNCOMPRESSED_BYTES {
                    return Err(format!(
                        "附件总解压大小超过上限: {total_attachment_bytes} 字节"
                    ));
                }

                attachment_contents.insert(name, buf);
            }
            other => {
                return Err(format!("zip 中包含未知条目: {other}"));
            }
        }
    }

    if !has_manifest {
        return Err("备份文件缺少 manifest.json".to_string());
    }
    if !has_data {
        return Err("备份文件缺少 data.json".to_string());
    }

    // -- Phase 2: 解析并验证清单 --
    let manifest: BackupManifest = serde_json::from_str(&manifest_content.unwrap())
        .map_err(|e| format!("解析 manifest.json 失败: {e}"))?;

    if manifest.app != "SoNotes" {
        return Err(format!(
            "备份清单中的应用标识不匹配: 期望 SoNotes, 实际 {}",
            manifest.app
        ));
    }
    if manifest.format_version == 0 || manifest.format_version > BACKUP_FORMAT_VERSION {
        return Err(format!("不支持的备份格式版本: {}", manifest.format_version));
    }

    // -- Phase 3: 解析 data.json --
    let raw_data = data_content.unwrap();
    let data_json: StorageDataForRestore =
        serde_json::from_slice(&raw_data).map_err(|e| format!("解析 data.json 失败: {e}"))?;

    // -- Phase 4: 验证数据完整性 --
    validate_restored_data(&data_json, &manifest, &attachment_contents)?;

    let note_count = data_json.notes.len() as u32;
    let board_count = data_json.boards.len() as u32;
    let attachment_count = manifest.attachment_count;

    // -- Phase 5: 暂存提取内容到临时目录 --
    let staging_id = format!("{:016x}", rand::random::<u64>());
    let staging_dir = sonotes_base.join(format!(".restore_staging_{staging_id}"));
    std::fs::create_dir_all(&staging_dir).map_err(|e| format!("创建暂存目录失败: {e}"))?;
    let _staging_guard = RestoreStagingGuard::new(staging_dir.clone());

    std::fs::write(staging_dir.join("data.json"), &raw_data)
        .map_err(|e| format!("写入暂存 data.json 失败: {e}"))?;

    if !attachment_contents.is_empty() {
        let staging_attach = staging_dir.join("attachments");
        std::fs::create_dir_all(&staging_attach)
            .map_err(|e| format!("创建暂存附件目录失败: {e}"))?;

        for (name, content) in &attachment_contents {
            let target = staging_dir.join(name);
            std::fs::write(&target, content)
                .map_err(|e| format!("写入暂存附件失败: {name} ({e})"))?;
        }
    }

    // -- Phase 6: 原子替换 --
    let old_data_path = sonotes_base.join("data.json");
    let old_attach_dir = sonotes_base.join("attachments");

    let uid = format!("{:016x}", rand::random::<u64>());
    let data_bak = sonotes_base.join(format!(".data.json.bak.{uid}"));
    let attach_old = sonotes_base.join(format!(".attachments_old.{uid}"));

    // 备份旧 data.json
    let had_old_data = old_data_path.exists();
    if had_old_data {
        std::fs::rename(&old_data_path, &data_bak)
            .map_err(|e| format!("备份旧 data.json 失败: {e}"))?;
    }

    // 移入新 data.json
    if let Err(e) = std::fs::rename(staging_dir.join("data.json"), &old_data_path) {
        if had_old_data {
            let _ = std::fs::rename(&data_bak, &old_data_path);
        }
        let _ = std::fs::remove_dir_all(&staging_dir);
        return Err(format!("替换 data.json 失败: {e}"));
    }

    // 备份旧 attachments 目录
    let had_old_attach = old_attach_dir.exists();
    if had_old_attach {
        if let Err(e) = std::fs::rename(&old_attach_dir, &attach_old) {
            restore_data_file(&data_bak, &old_data_path, had_old_data);
            let _ = std::fs::remove_dir_all(&staging_dir);
            return Err(format!("备份旧附件目录失败: {e}"));
        }
    }

    // 移入新 attachments 目录
    let staged_attach = staging_dir.join("attachments");
    let has_new_attach = staged_attach.exists();

    if has_new_attach {
        if let Err(e) = std::fs::rename(&staged_attach, &old_attach_dir) {
            restore_attachment_dir(&attach_old, &old_attach_dir, had_old_attach);
            restore_data_file(&data_bak, &old_data_path, had_old_data);
            let _ = std::fs::remove_dir_all(&staging_dir);
            return Err(format!("替换附件目录失败: {e}"));
        }
    }

    // 成功：清理临时文件
    if had_old_data {
        let _ = std::fs::remove_file(&data_bak);
    }
    if had_old_attach {
        let _ = std::fs::remove_dir_all(&attach_old);
    }
    let _ = std::fs::remove_dir_all(&staging_dir);

    Ok(RestoreResult {
        success: true,
        note_count,
        board_count,
        attachment_count,
        error: None,
    })
}

// ---------------------------------------------------------------------------
// 备份核心逻辑
// ---------------------------------------------------------------------------

/// 备份核心逻辑，不依赖 Tauri 运行时，便于单元测试。
///
/// - `sonotes_base`：SoNotes 数据基础目录（`<Documents>/SoNotes/`）
/// - `target_path`：备份文件目标路径
fn create_local_backup_inner(
    sonotes_base: &Path,
    target_path: &Path,
) -> Result<BackupResult, String> {
    // 1. 读取 data.json
    let data_path = sonotes_base.join("data.json");
    let data_json =
        std::fs::read_to_string(&data_path).map_err(|e| format!("读取 data.json 失败: {e}"))?;
    ensure_uncompressed_size(
        "data.json",
        data_json.len() as u64,
        MAX_DATA_JSON_UNCOMPRESSED_BYTES,
    )?;

    // 2. 解析 data.json
    let storage_data: StorageDataForRestore =
        serde_json::from_str(&data_json).map_err(|e| format!("解析 data.json 失败: {e}"))?;
    let empty_attachment_contents = std::collections::HashMap::new();
    let image_refs = validate_storage_data_contract(&storage_data, &empty_attachment_contents)?;

    // 3. 统计
    let board_count = storage_data.boards.len() as u32;
    let note_count = storage_data.notes.len() as u32;

    // 4. 收集去重后的图片文件引用
    let attachment_count = image_refs.len() as u32;

    let mut validated_images = Vec::new();
    if !image_refs.is_empty() {
        let canonical_base = sonotes_base
            .canonicalize()
            .map_err(|e| format!("SoNotes 目录规范化失败: {e}"))?;
        let canonical_attach = canonical_base
            .join("attachments")
            .canonicalize()
            .map_err(|e| format!("图片文件目录规范化失败: {e}"))?;

        for ref_path in &image_refs {
            validate_zip_entry_path(ref_path)?;

            let file_path = sonotes_base.join(ref_path);
            let canonical_file = file_path
                .canonicalize()
                .map_err(|_| format!("图片文件不存在或无法访问: {ref_path}"))?;
            if !canonical_file.starts_with(&canonical_attach) {
                return Err(format!("图片文件路径超出图片文件目录边界: {ref_path}"));
            }

            validated_images.push((ref_path.clone(), file_path));
        }
    }

    let resolved_path = resolve_unique_backup_path(target_path);

    if let Some(parent) = resolved_path.parent() {
        if !parent.exists() {
            return Err(format!("备份目标目录不存在: {}", parent.display()));
        }
    }

    let (temp_guard, zip_file) = create_temp_zip_guard(&resolved_path)?;
    let mut zip = zip::ZipWriter::new(zip_file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    validate_zip_entry_path("data.json")?;
    zip.start_file("data.json", options)
        .map_err(|e| format!("写入 zip 条目 data.json 失败: {e}"))?;
    zip.write_all(data_json.as_bytes())
        .map_err(|e| format!("写入 data.json 内容失败: {e}"))?;

    let mut attachment_entries = Vec::new();
    let mut total_attachment_bytes: u64 = 0;
    for (ref_path, file_path) in &validated_images {
        // 验证路径格式（collect_unique_image_refs 已验证，这里做双重确认）
        validate_zip_entry_path(ref_path)?;

        let mut file = std::fs::File::open(file_path)
            .map_err(|e| format!("打开图片文件失败: {ref_path} ({e})"))?;

        let mut hasher = sha2::Sha256::new();
        let mut buf = vec![0u8; 64 * 1024];
        let mut total_size: u64 = 0;

        let file_size = file
            .metadata()
            .map_err(|e| format!("读取图片文件元数据失败: {ref_path} ({e})"))?
            .len();
        ensure_uncompressed_size(
            &format!("附件 {ref_path}"),
            file_size,
            MAX_ATTACHMENT_UNCOMPRESSED_BYTES,
        )?;
        total_attachment_bytes = total_attachment_bytes
            .checked_add(file_size)
            .ok_or_else(|| "附件总大小超过上限".to_string())?;
        if total_attachment_bytes > MAX_TOTAL_ATTACHMENT_UNCOMPRESSED_BYTES {
            return Err(format!(
                "附件总解压大小超过上限: {total_attachment_bytes} 字节"
            ));
        }

        zip.start_file(ref_path, options)
            .map_err(|e| format!("写入 zip 条目 {ref_path} 失败: {e}"))?;

        loop {
            let bytes_read = file
                .read(&mut buf)
                .map_err(|e| format!("读取图片文件失败: {ref_path} ({e})"))?;
            if bytes_read == 0 {
                break;
            }
            hasher.update(&buf[..bytes_read]);
            zip.write_all(&buf[..bytes_read])
                .map_err(|e| format!("写入 zip 图片内容失败: {ref_path} ({e})"))?;
            total_size += bytes_read as u64;
        }

        let hash_bytes = hasher.finalize();
        let sha256 = hash_bytes
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();

        validate_attachment_refs_for_path(&storage_data, ref_path, &sha256, total_size)?;

        attachment_entries.push(BackupAttachmentEntry {
            zip_entry_path: ref_path.clone(),
            sha256,
            size: total_size,
        });
    }

    let manifest = BackupManifest {
        app: "SoNotes".to_string(),
        format_version: BACKUP_FORMAT_VERSION,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        note_count,
        board_count,
        attachment_count,
        attachments: attachment_entries,
    };

    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("序列化 manifest.json 失败: {e}"))?;
    ensure_uncompressed_size(
        "manifest.json",
        manifest_json.len() as u64,
        MAX_MANIFEST_JSON_UNCOMPRESSED_BYTES,
    )?;

    validate_zip_entry_path("manifest.json")?;
    zip.start_file("manifest.json", options)
        .map_err(|e| format!("写入 zip 条目 manifest.json 失败: {e}"))?;
    zip.write_all(manifest_json.as_bytes())
        .map_err(|e| format!("写入 manifest.json 内容失败: {e}"))?;

    zip.finish().map_err(|e| format!("完成 zip 文件失败: {e}"))?;

    std::fs::rename(temp_guard.path(), &resolved_path).map_err(|e| format!("重命名备份文件失败: {e}"))?;
    temp_guard.keep();

    Ok(BackupResult {
        success: true,
        backup_path: Some(resolved_path.to_string_lossy().to_string()),
        note_count,
        board_count,
        attachment_count,
        error: None,
    })
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

/// 创建本地 zip 备份。
///
/// 从已刷新到磁盘的 `data.json` 读取数据，收集所有图片文件引用，
/// 创建包含 `manifest.json`、`data.json` 和 `attachments/<filename>` 的 zip 备份。
///
/// 如果 `target_path` 已存在，不会静默覆盖，而是生成带后缀的安全兄弟路径。
#[tauri::command]
pub async fn create_local_backup(
    app: tauri::AppHandle,
    target_path: String,
) -> Result<BackupResult, String> {
    let doc_dir = app
        .path()
        .document_dir()
        .map_err(|e| format!("获取文档目录失败: {e}"))?;
    let sonotes_base = doc_dir.join("SoNotes");
    let target = PathBuf::from(target_path);

    tokio::task::spawn_blocking(move || create_local_backup_inner(&sonotes_base, &target))
        .await
        .map_err(|e| format!("备份线程失败: {e}"))?
}

/// 从本地 zip 备份文件恢复数据。
///
/// 验证 zip 结构、清单元数据与数据完整性后，通过临时暂存与原子替换
/// 将 `data.json` 和 `attachments/` 完整恢复到 SoNotes 数据目录。
/// 失败时保留原有数据不变。
#[tauri::command]
pub async fn restore_local_backup(
    app: tauri::AppHandle,
    source_zip_path: String,
) -> Result<RestoreResult, String> {
    let doc_dir = app
        .path()
        .document_dir()
        .map_err(|e| format!("获取文档目录失败: {e}"))?;
    let sonotes_base = doc_dir.join("SoNotes");
    let source = PathBuf::from(source_zip_path);

    tokio::task::spawn_blocking(move || restore_local_backup_inner(&sonotes_base, &source))
        .await
        .map_err(|e| format!("恢复线程失败: {e}"))?
}

// ===========================================================================
// 单元测试
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// 为每个测试创建独立临时目录，避免相互污染。
    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sonotes-backup-{name}-{:032x}",
            rand::random::<u128>()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create test dir");
        dir
    }

    /// 生成最简 data.json 字符串。
    fn minimal_data_json(boards: &[serde_json::Value], notes: &[serde_json::Value]) -> String {
        let current_board_id = boards
            .first()
            .and_then(|board| board.get("id"))
            .and_then(|id| id.as_str())
            .unwrap_or("");
        serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": boards,
            "notes": notes,
            "currentBoardId": current_board_id,
            "config": { "version": 1, "maxZ": 1, "themeMode": "light" }
        })
        .to_string()
    }

    /// 生成一张文本便签 JSON（无图片引用）。
    fn text_note(id: &str, board_id: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "kind": "text",
            "boardId": board_id,
            "x": 0, "y": 0,
            "title": "", "content": "",
            "color": "yellow",
            "z": 1,
            "createdAt": 0, "updatedAt": 0
        })
    }

    fn image_attachment_json(id: &str, relative_path: &str, size: u64) -> serde_json::Value {
        let filename = Path::new(relative_path)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(relative_path);
        let hash = Path::new(relative_path)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        serde_json::json!({
            "id": format!("{id}-att"),
            "hash": hash,
            "filename": filename,
            "mimeType": "image/png",
            "size": size,
            "relativePath": relative_path,
            "createdAt": 0
        })
    }

    /// 生成一张图片便签 JSON，引用指定的 relative_path。
    fn image_note(id: &str, board_id: &str, relative_path: &str, size: u64) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "kind": "image",
            "boardId": board_id,
            "x": 0, "y": 0,
            "title": "", "content": "",
            "color": "yellow",
            "z": 1,
            "createdAt": 0, "updatedAt": 0,
            "attachments": [image_attachment_json(id, relative_path, size)]
        })
    }

    /// 生成一张处于废纸篓的图片便签 JSON（有 deletedAt）。
    fn trashed_image_note(id: &str, board_id: &str, relative_path: &str, size: u64) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "kind": "image",
            "boardId": board_id,
            "x": 0, "y": 0,
            "title": "", "content": "",
            "color": "yellow",
            "z": 1,
            "createdAt": 0, "updatedAt": 0,
            "deletedAt": 1700000000000_u64,
            "attachments": [image_attachment_json(id, relative_path, size)]
        })
    }

    fn image_note_for_restore(
        id: &str,
        board_id: &str,
        relative_path: &str,
        hash: &str,
        size: u64,
    ) -> serde_json::Value {
        let filename = Path::new(relative_path)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(relative_path);
        serde_json::json!({
            "id": id,
            "kind": "image",
            "boardId": board_id,
            "x": 0, "y": 0,
            "title": "", "content": "",
            "color": "yellow",
            "z": 1,
            "createdAt": 0, "updatedAt": 0,
            "attachments": [{
                "id": format!("{id}-att"),
                "hash": hash,
                "filename": filename,
                "mimeType": "image/png",
                "size": size,
                "relativePath": relative_path,
                "createdAt": 0
            }]
        })
    }

    /// 用已知内容创建一个图片文件，返回其 `attachments/<sha256>.<ext>` 相对路径。
    fn create_attachment_file(attach_dir: &Path, content: &[u8], ext: &str) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(content);
        let hash: String = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let filename = format!("{hash}.{ext}");
        std::fs::write(attach_dir.join(&filename), content).expect("write attachment");
        format!("attachments/{filename}")
    }

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
        assert!(
            validate_zip_entry_path(
                "attachments/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.jpg"
            )
            .is_ok()
        );
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
            attachments: vec![BackupAttachmentEntry {
                zip_entry_path: "attachments/abc.png".to_string(),
                sha256: "a".repeat(64),
                size: 1024,
            }],
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
        assert_eq!(deserialized.attachments.len(), 1);
        assert_eq!(deserialized.attachments[0].sha256, "a".repeat(64));
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
            attachment_count: 1,
            attachments: vec![BackupAttachmentEntry {
                zip_entry_path: "attachments/test.png".to_string(),
                sha256: "a".repeat(64),
                size: 100,
            }],
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
        assert!(
            json.contains("\"zipEntryPath\""),
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

    // -----------------------------------------------------------------------
    // resolve_unique_backup_path
    // -----------------------------------------------------------------------

    #[test]
    fn unique_path_returns_original_when_not_exists() {
        let dir = test_dir("unique-original");
        let target = dir.join("backup.zip");
        assert_eq!(resolve_unique_backup_path(&target), target);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unique_path_returns_sibling_when_exists() {
        let dir = test_dir("unique-sibling");
        let target = dir.join("backup.zip");
        std::fs::write(&target, "existing").unwrap();
        let resolved = resolve_unique_backup_path(&target);
        assert_eq!(resolved, dir.join("backup_1.zip"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unique_path_skips_existing_siblings() {
        let dir = test_dir("unique-skip");
        let target = dir.join("backup.zip");
        std::fs::write(&target, "v0").unwrap();
        std::fs::write(dir.join("backup_1.zip"), "v1").unwrap();
        let resolved = resolve_unique_backup_path(&target);
        assert_eq!(resolved, dir.join("backup_2.zip"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unique_path_handles_no_extension() {
        let dir = test_dir("unique-noext");
        let target = dir.join("backup");
        std::fs::write(&target, "existing").unwrap();
        let resolved = resolve_unique_backup_path(&target);
        assert_eq!(resolved, dir.join("backup_1"));
        let _ = std::fs::remove_dir_all(dir);
    }

    // -----------------------------------------------------------------------
    // create_local_backup_inner：无图片引用
    // -----------------------------------------------------------------------

    #[test]
    fn backup_no_attachments() {
        let root = test_dir("no-attachments");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data = minimal_data_json(
            &[serde_json::json!({"id": "b1", "name": "看板", "icon": "📋", "createdAt": 0})],
            &[text_note("n1", "b1")],
        );
        std::fs::write(sonotes_base.join("data.json"), &data).unwrap();

        let target = root.join("backup.zip");
        let result = create_local_backup_inner(&sonotes_base, &target).unwrap();

        assert!(result.success);
        assert_eq!(result.note_count, 1);
        assert_eq!(result.board_count, 1);
        assert_eq!(result.attachment_count, 0);
        assert!(result.backup_path.as_ref().unwrap().ends_with("backup.zip"));

        // 验证 zip 内容
        let zip_file = std::fs::File::open(result.backup_path.unwrap()).unwrap();
        let mut archive = zip::ZipArchive::new(zip_file).unwrap();
        assert!(archive.by_name("manifest.json").is_ok());
        assert!(archive.by_name("data.json").is_ok());

        let manifest: BackupManifest =
            serde_json::from_reader(archive.by_name("manifest.json").unwrap()).unwrap();
        assert_eq!(manifest.app, "SoNotes");
        assert!(manifest.attachments.is_empty());

        let _ = std::fs::remove_dir_all(root);
    }

    // -----------------------------------------------------------------------
    // create_local_backup_inner：图片便签引用附件
    // -----------------------------------------------------------------------

    #[test]
    fn backup_with_image_note_attachments() {
        let root = test_dir("with-attachments");
        let sonotes_base = root.join("SoNotes");
        let attach_dir = sonotes_base.join("attachments");
        std::fs::create_dir_all(&attach_dir).unwrap();

        let img_content = b"fake png image bytes here";
        let rel_path = create_attachment_file(&attach_dir, img_content, "png");

        let data = minimal_data_json(
            &[serde_json::json!({"id": "b1", "name": "看板", "icon": "📋", "createdAt": 0})],
            &[
                text_note("n1", "b1"),
                image_note("n2", "b1", &rel_path, img_content.len() as u64),
            ],
        );
        std::fs::write(sonotes_base.join("data.json"), &data).unwrap();

        let target = root.join("backup.zip");
        let result = create_local_backup_inner(&sonotes_base, &target).unwrap();

        assert!(result.success);
        assert_eq!(result.note_count, 2);
        assert_eq!(result.board_count, 1);
        assert_eq!(result.attachment_count, 1);

        // 验证 zip 内附件文件可读
        let zip_file = std::fs::File::open(result.backup_path.unwrap()).unwrap();
        let mut archive = zip::ZipArchive::new(zip_file).unwrap();
        let entry_name = rel_path.clone();
        let mut entry = archive.by_name(&entry_name).unwrap();
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut buf).unwrap();
        assert_eq!(buf, img_content);

        let _ = std::fs::remove_dir_all(root);
    }

    // -----------------------------------------------------------------------
    // create_local_backup_inner：废纸篓中的图片便签也被收集
    // -----------------------------------------------------------------------

    #[test]
    fn backup_includes_trashed_image_notes() {
        let root = test_dir("trashed-images");
        let sonotes_base = root.join("SoNotes");
        let attach_dir = sonotes_base.join("attachments");
        std::fs::create_dir_all(&attach_dir).unwrap();

        let img_content = b"trashed image content";
        let rel_path = create_attachment_file(&attach_dir, img_content, "jpg");

        let data = minimal_data_json(
            &[serde_json::json!({"id": "b1", "name": "看板", "icon": "📋", "createdAt": 0})],
            &[
                text_note("n1", "b1"),
                trashed_image_note("n2", "b1", &rel_path, img_content.len() as u64),
            ],
        );
        std::fs::write(sonotes_base.join("data.json"), &data).unwrap();

        let target = root.join("backup.zip");
        let result = create_local_backup_inner(&sonotes_base, &target).unwrap();

        assert!(result.success);
        assert_eq!(result.note_count, 2, "废纸篓便签应计入便签总数");
        assert_eq!(result.attachment_count, 1, "废纸篓图片应被收集");

        let _ = std::fs::remove_dir_all(root);
    }

    // -----------------------------------------------------------------------
    // create_local_backup_inner：重复图片引用去重
    // -----------------------------------------------------------------------

    #[test]
    fn backup_deduplicates_image_refs() {
        let root = test_dir("dedupe-refs");
        let sonotes_base = root.join("SoNotes");
        let attach_dir = sonotes_base.join("attachments");
        std::fs::create_dir_all(&attach_dir).unwrap();

        let img_content = b"same image referenced twice";
        let rel_path = create_attachment_file(&attach_dir, img_content, "png");

        let data = minimal_data_json(
            &[serde_json::json!({"id": "b1", "name": "看板", "icon": "📋", "createdAt": 0})],
            &[
                image_note("n1", "b1", &rel_path, img_content.len() as u64),
                image_note("n2", "b1", &rel_path, img_content.len() as u64),
            ],
        );
        std::fs::write(sonotes_base.join("data.json"), &data).unwrap();

        let target = root.join("backup.zip");
        let result = create_local_backup_inner(&sonotes_base, &target).unwrap();

        assert!(result.success);
        assert_eq!(result.note_count, 2);
        assert_eq!(result.attachment_count, 1, "重复引用应去重为 1 个");

        // 验证 zip 中只有一个附件条目
        let zip_file = std::fs::File::open(result.backup_path.unwrap()).unwrap();
        let mut archive = zip::ZipArchive::new(zip_file).unwrap();
        let manifest: BackupManifest =
            serde_json::from_reader(archive.by_name("manifest.json").unwrap()).unwrap();
        assert_eq!(manifest.attachments.len(), 1);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn backup_rejects_bad_duplicate_attachment_ref_size() {
        let root = test_dir("dedupe-bad-size");
        let sonotes_base = root.join("SoNotes");
        let attach_dir = sonotes_base.join("attachments");
        std::fs::create_dir_all(&attach_dir).unwrap();

        let img_content = b"same image with dirty duplicate ref";
        let rel_path = create_attachment_file(&attach_dir, img_content, "png");
        let bad_size = img_content.len() as u64 + 1;

        let data = minimal_data_json(
            &[serde_json::json!({"id": "b1", "name": "看板", "icon": "📋", "createdAt": 0})],
            &[
                image_note("n1", "b1", &rel_path, img_content.len() as u64),
                image_note("n2", "b1", &rel_path, bad_size),
            ],
        );
        std::fs::write(sonotes_base.join("data.json"), &data).unwrap();

        let target = root.join("backup.zip");
        let err = create_local_backup_inner(&sonotes_base, &target).unwrap_err();

        assert!(
            err.contains("size 与 data.json 不匹配"),
            "错误信息应提及重复引用的 size 不匹配: {err}"
        );
        assert!(!target.exists(), "失败时不应留下半成品备份文件");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn backup_rejects_attachment_over_uncompressed_limit() {
        let root = test_dir("backup-large-attachment");
        let sonotes_base = root.join("SoNotes");
        let attach_dir = sonotes_base.join("attachments");
        std::fs::create_dir_all(&attach_dir).unwrap();

        let rel_path = "attachments/0000000000000000000000000000000000000000000000000000000000000000.png";
        let attachment_path = attach_dir.join("0000000000000000000000000000000000000000000000000000000000000000.png");
        let file = std::fs::File::create(&attachment_path).unwrap();
        file.set_len(MAX_ATTACHMENT_UNCOMPRESSED_BYTES + 1).unwrap();

        let data = minimal_data_json(
            &[serde_json::json!({"id": "b1", "name": "看板", "icon": "📋", "createdAt": 0})],
            &[image_note(
                "n1",
                "b1",
                rel_path,
                MAX_ATTACHMENT_UNCOMPRESSED_BYTES + 1,
            )],
        );
        std::fs::write(sonotes_base.join("data.json"), &data).unwrap();

        let target = root.join("backup.zip");
        let err = create_local_backup_inner(&sonotes_base, &target).unwrap_err();

        assert!(
            err.contains("解压后大小超过上限"),
            "错误信息应提及附件大小上限: {err}"
        );
        assert!(!target.exists(), "失败时不应留下半成品备份文件");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn backup_rejects_total_attachment_size_over_restore_limit() {
        let root = test_dir("backup-total-attachment-size");
        let sonotes_base = root.join("SoNotes");
        let attach_dir = sonotes_base.join("attachments");
        std::fs::create_dir_all(&attach_dir).unwrap();

        let first_content = vec![b'a'; 40];
        let second_content = vec![b'b'; 40];
        let first_rel_path = create_attachment_file(&attach_dir, &first_content, "png");
        let second_rel_path = create_attachment_file(&attach_dir, &second_content, "png");

        let data = minimal_data_json(
            &[serde_json::json!({"id": "b1", "name": "看板", "icon": "📋", "createdAt": 0})],
            &[
                image_note("n1", "b1", &first_rel_path, first_content.len() as u64),
                image_note("n2", "b1", &second_rel_path, second_content.len() as u64),
            ],
        );
        std::fs::write(sonotes_base.join("data.json"), &data).unwrap();

        let target = root.join("backup.zip");
        let err = create_local_backup_inner(&sonotes_base, &target).unwrap_err();

        assert!(err.contains("附件总解压大小超过上限"), "{err}");
        assert!(!target.exists(), "失败时不应留下半成品备份文件");

        let _ = std::fs::remove_dir_all(root);
    }

    // -----------------------------------------------------------------------
    // create_local_backup_inner：引用的图片文件缺失时失败
    // -----------------------------------------------------------------------

    #[test]
    fn backup_fails_on_missing_attachment_file() {
        let root = test_dir("missing-file");
        let sonotes_base = root.join("SoNotes");
        let attach_dir = sonotes_base.join("attachments");
        std::fs::create_dir_all(&attach_dir).unwrap();
        // 不创建实际文件

        let missing_rel_path =
            "attachments/0000000000000000000000000000000000000000000000000000000000000000.png";
        let data = minimal_data_json(
            &[serde_json::json!({"id": "b1", "name": "看板", "icon": "📋", "createdAt": 0})],
            &[image_note("n1", "b1", missing_rel_path, 0)],
        );
        std::fs::write(sonotes_base.join("data.json"), &data).unwrap();

        let target = root.join("backup.zip");
        let result = create_local_backup_inner(&sonotes_base, &target);

        assert!(result.is_err(), "缺失图片文件应导致备份失败");
        let err = result.unwrap_err();
        assert!(
            err.contains("不存在") || err.contains("无法访问"),
            "错误信息应提及文件不存在: {err}"
        );
        assert!(!target.exists(), "失败时不应留下半成品备份文件");

        let _ = std::fs::remove_dir_all(root);
    }

    // -----------------------------------------------------------------------
    // create_local_backup_inner：清单包含 SHA-256
    // -----------------------------------------------------------------------

    #[test]
    fn backup_manifest_contains_sha256() {
        let root = test_dir("manifest-sha256");
        let sonotes_base = root.join("SoNotes");
        let attach_dir = sonotes_base.join("attachments");
        std::fs::create_dir_all(&attach_dir).unwrap();

        let img_content = b"content for sha256 verification";
        let rel_path = create_attachment_file(&attach_dir, img_content, "png");

        // 计算期望的 SHA-256
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(img_content);
        let expected_sha256: String = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();

        let data = minimal_data_json(
            &[serde_json::json!({"id": "b1", "name": "看板", "icon": "📋", "createdAt": 0})],
            &[image_note("n1", "b1", &rel_path, img_content.len() as u64)],
        );
        std::fs::write(sonotes_base.join("data.json"), &data).unwrap();

        let target = root.join("backup.zip");
        let result = create_local_backup_inner(&sonotes_base, &target).unwrap();

        assert!(result.success);

        let zip_file = std::fs::File::open(result.backup_path.unwrap()).unwrap();
        let mut archive = zip::ZipArchive::new(zip_file).unwrap();
        let manifest: BackupManifest =
            serde_json::from_reader(archive.by_name("manifest.json").unwrap()).unwrap();

        assert_eq!(manifest.attachments.len(), 1);
        assert_eq!(
            manifest.attachments[0].sha256, expected_sha256,
            "manifest 中的 SHA-256 应与文件内容匹配"
        );
        assert_eq!(
            manifest.attachments[0].size,
            img_content.len() as u64,
            "manifest 中的 size 应与文件大小匹配"
        );
        assert_eq!(manifest.attachments[0].zip_entry_path, rel_path);

        let _ = std::fs::remove_dir_all(root);
    }

    // -----------------------------------------------------------------------
    // create_local_backup_inner：目标路径已存在时生成唯一兄弟路径
    // -----------------------------------------------------------------------

    #[test]
    fn backup_existing_target_gets_unique_sibling() {
        let root = test_dir("existing-target");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data = minimal_data_json(
            &[serde_json::json!({"id": "b1", "name": "看板", "icon": "📋", "createdAt": 0})],
            &[],
        );
        std::fs::write(sonotes_base.join("data.json"), &data).unwrap();

        let target = root.join("backup.zip");
        std::fs::write(&target, "pre-existing content").unwrap();

        let result = create_local_backup_inner(&sonotes_base, &target).unwrap();

        assert!(result.success);
        let backup_path = result.backup_path.unwrap();
        assert!(
            backup_path.ends_with("_1.zip"),
            "应使用 _1 后缀: {backup_path}"
        );
        assert!(std::path::Path::new(&backup_path).exists());
        // 原始文件不应被覆盖
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "pre-existing content"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn backup_rejects_data_that_restore_would_reject() {
        let root = test_dir("backup-contract-invalid");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data = minimal_data_json(&[], &[]);
        std::fs::write(sonotes_base.join("data.json"), &data).unwrap();

        let target = root.join("backup.zip");
        let err = create_local_backup_inner(&sonotes_base, &target).unwrap_err();

        assert!(err.contains("boards"), "错误应来自 StorageData 契约: {err}");
        assert!(!target.exists(), "契约非法时不应生成 zip");

        let _ = std::fs::remove_dir_all(root);
    }

    // -----------------------------------------------------------------------
    // create_local_backup_inner：不安全的图片引用路径被拒绝
    // -----------------------------------------------------------------------

    #[test]
    fn backup_rejects_unsafe_attachment_path_traversal() {
        let root = test_dir("unsafe-traversal");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data = minimal_data_json(
            &[serde_json::json!({"id": "b1", "name": "看板", "icon": "📋", "createdAt": 0})],
            &[image_note("n1", "b1", "attachments/../../etc/passwd", 0)],
        );
        std::fs::write(sonotes_base.join("data.json"), &data).unwrap();

        let target = root.join("backup.zip");
        let result = create_local_backup_inner(&sonotes_base, &target);

        assert!(result.is_err(), "路径穿越应被拒绝");
        let err = result.unwrap_err();
        assert!(
            err.contains("相对路径段") || err.contains("zip 条目"),
            "错误信息应提及路径验证: {err}"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn backup_rejects_unsafe_attachment_path_absolute() {
        let root = test_dir("unsafe-absolute");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data = minimal_data_json(
            &[serde_json::json!({"id": "b1", "name": "看板", "icon": "📋", "createdAt": 0})],
            &[image_note("n1", "b1", "/etc/passwd", 0)],
        );
        std::fs::write(sonotes_base.join("data.json"), &data).unwrap();

        let target = root.join("backup.zip");
        let result = create_local_backup_inner(&sonotes_base, &target);

        assert!(result.is_err(), "绝对路径应被拒绝");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn backup_rejects_unsafe_attachment_path_windows_drive() {
        let root = test_dir("unsafe-drive");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data = minimal_data_json(
            &[serde_json::json!({"id": "b1", "name": "看板", "icon": "📋", "createdAt": 0})],
            &[image_note("n1", "b1", "C:/Windows/System32/config", 0)],
        );
        std::fs::write(sonotes_base.join("data.json"), &data).unwrap();

        let target = root.join("backup.zip");
        let result = create_local_backup_inner(&sonotes_base, &target);

        assert!(result.is_err(), "Windows 盘符路径应被拒绝");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn backup_rejects_unsafe_attachment_path_nested() {
        let root = test_dir("unsafe-nested");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data = minimal_data_json(
            &[serde_json::json!({"id": "b1", "name": "看板", "icon": "📋", "createdAt": 0})],
            &[image_note("n1", "b1", "attachments/sub/file.png", 0)],
        );
        std::fs::write(sonotes_base.join("data.json"), &data).unwrap();

        let target = root.join("backup.zip");
        let result = create_local_backup_inner(&sonotes_base, &target);

        assert!(result.is_err(), "嵌套路径应被拒绝");

        let _ = std::fs::remove_dir_all(root);
    }

    // -----------------------------------------------------------------------
    // create_local_backup_inner：data.json 不存在时失败
    // -----------------------------------------------------------------------

    #[test]
    fn backup_fails_when_data_json_missing() {
        let root = test_dir("no-data-json");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();
        // 不创建 data.json

        let target = root.join("backup.zip");
        let result = create_local_backup_inner(&sonotes_base, &target);

        assert!(result.is_err(), "data.json 缺失应导致失败");
        let err = result.unwrap_err();
        assert!(err.contains("data.json"), "错误信息应提及 data.json: {err}");

        let _ = std::fs::remove_dir_all(root);
    }

    // -----------------------------------------------------------------------
    // create_local_backup_inner：zip 内条目使用正斜杠
    // -----------------------------------------------------------------------

    #[test]
    fn backup_zip_entries_use_forward_slashes() {
        let root = test_dir("forward-slashes");
        let sonotes_base = root.join("SoNotes");
        let attach_dir = sonotes_base.join("attachments");
        std::fs::create_dir_all(&attach_dir).unwrap();

        let img_content = b"test forward slash";
        let rel_path = create_attachment_file(&attach_dir, img_content, "png");

        let data = minimal_data_json(
            &[serde_json::json!({"id": "b1", "name": "看板", "icon": "📋", "createdAt": 0})],
            &[image_note("n1", "b1", &rel_path, img_content.len() as u64)],
        );
        std::fs::write(sonotes_base.join("data.json"), &data).unwrap();

        let target = root.join("backup.zip");
        let result = create_local_backup_inner(&sonotes_base, &target).unwrap();

        let zip_file = std::fs::File::open(result.backup_path.unwrap()).unwrap();
        let mut archive = zip::ZipArchive::new(zip_file).unwrap();
        for i in 0..archive.len() {
            let entry = archive.by_index(i).unwrap();
            let name = entry.name();
            assert!(!name.contains('\\'), "zip 条目不应包含反斜杠: {name}");
        }

        let _ = std::fs::remove_dir_all(root);
    }

    // =======================================================================
    // restore_local_backup_inner 测试辅助函数
    // =======================================================================

    fn compute_test_sha256(data: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(data);
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    fn minimal_restore_manifest(attachments: Vec<BackupAttachmentEntry>) -> BackupManifest {
        BackupManifest {
            app: "SoNotes".to_string(),
            format_version: BACKUP_FORMAT_VERSION,
            app_version: "1.4.9".to_string(),
            created_at: 1700000000000,
            note_count: 0,
            board_count: 0,
            attachment_count: attachments.len() as u32,
            attachments,
        }
    }

    fn build_test_zip(
        manifest_json: &str,
        data_json: &str,
        attachments: &[(&str, &[u8])],
    ) -> PathBuf {
        let dir = test_dir("build-zip");
        let zip_path = dir.join("backup.zip");
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);

        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(manifest_json.as_bytes()).unwrap();

        zip.start_file("data.json", options).unwrap();
        zip.write_all(data_json.as_bytes()).unwrap();

        for (path, content) in attachments {
            zip.start_file(path, options).unwrap();
            zip.write_all(content).unwrap();
        }

        zip.finish().unwrap();
        zip_path
    }

    fn assert_no_restore_staging_leftover(sonotes_base: &Path) {
        let leftovers = std::fs::read_dir(sonotes_base)
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .map(|name| name.starts_with(".restore_staging_"))
                    .unwrap_or(false)
            })
            .count();
        assert_eq!(leftovers, 0, "不应残留恢复暂存目录");
    }

    #[test]
    fn read_zip_entry_limited_rejects_actual_bytes_over_limit_even_when_declared_small() {
        let mut reader = std::io::Cursor::new(vec![b'x'; 65]);

        let err = read_zip_entry_limited(&mut reader, "data.json", 1, 64).unwrap_err();

        assert!(
            err.contains("实际解压大小超过上限"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn read_zip_entry_limited_rejects_declared_and_actual_size_mismatch() {
        let mut reader = std::io::Cursor::new(vec![b'x'; 8]);

        let err = read_zip_entry_limited(&mut reader, "data.json", 4, 64).unwrap_err();

        assert!(
            err.contains("声明大小与实际读取大小不匹配"),
            "unexpected error: {err}"
        );
    }

    fn make_image_attachment_entry(path: &str, content: &[u8]) -> BackupAttachmentEntry {
        BackupAttachmentEntry {
            zip_entry_path: path.to_string(),
            sha256: compute_test_sha256(content),
            size: content.len() as u64,
        }
    }

    fn restore_data_json_with_board(board_id: &str, notes: &[serde_json::Value]) -> String {
        serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [{"id": board_id, "name": "看板", "icon": "📋", "createdAt": 0}],
            "notes": notes,
            "currentBoardId": board_id,
            "config": {"version": 1, "maxZ": 1, "themeMode": "light"}
        })
        .to_string()
    }

    // =======================================================================
    // restore_local_backup_inner：成功恢复
    // =======================================================================

    #[test]
    fn restore_success_no_attachments() {
        let root = test_dir("restore-ok-noatt");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = restore_data_json_with_board("b1", &[text_note("n1", "b1")]);
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let result = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap();
        assert!(result.success);
        assert_eq!(result.note_count, 1);
        assert_eq!(result.board_count, 1);
        assert_eq!(result.attachment_count, 0);

        let restored = std::fs::read_to_string(sonotes_base.join("data.json")).unwrap();
        assert!(restored.contains("\"n1\""));
        assert_no_restore_staging_leftover(&sonotes_base);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_staging_guard_removes_directory_on_drop() {
        let root = test_dir("restore-staging-guard");
        let staging_dir = root.join(".restore_staging_guard_test");
        std::fs::create_dir_all(&staging_dir).unwrap();
        std::fs::write(staging_dir.join("data.json"), b"{}").unwrap();

        {
            let _guard = RestoreStagingGuard::new(staging_dir.clone());
            assert!(staging_dir.exists());
        }

        assert!(!staging_dir.exists(), "暂存目录应由 RAII guard 自动清理");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_success_with_attachments() {
        let root = test_dir("restore-ok-att");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let img_content = b"restore test image bytes";
        let hash = compute_test_sha256(img_content);
        let rel_path = format!("attachments/{hash}.png");

        let data_json = restore_data_json_with_board(
            "b1",
            &[image_note_for_restore("n1", "b1", &rel_path, &hash, img_content.len() as u64)],
        );
        let att_entry = make_image_attachment_entry(&rel_path, img_content);
        let manifest = minimal_restore_manifest(vec![att_entry]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[(&rel_path, img_content)]);

        let result = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap();
        assert!(result.success);
        assert_eq!(result.attachment_count, 1);

        let restored_att = std::fs::read(sonotes_base.join(&rel_path)).unwrap();
        assert_eq!(restored_att, img_content);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_success_replaces_existing_data() {
        let root = test_dir("restore-replace");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        std::fs::write(sonotes_base.join("data.json"), "{\"old\": true}").unwrap();

        let data_json = restore_data_json_with_board("b1", &[text_note("n1", "b1")]);
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let result = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap();
        assert!(result.success);

        let restored = std::fs::read_to_string(sonotes_base.join("data.json")).unwrap();
        assert!(restored.contains("\"n1\""));
        assert!(!restored.contains("\"old\""));

        let _ = std::fs::remove_dir_all(root);
    }

    // =======================================================================
    // restore_local_backup_inner：缺失 manifest / data
    // =======================================================================

    #[test]
    fn restore_fails_missing_manifest() {
        let root = test_dir("restore-no-manifest");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let zip_path = root.join("bad.zip");
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("data.json", options).unwrap();
        zip.write_all(b"{}").unwrap();
        zip.finish().unwrap();

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(err.contains("manifest.json"), "{err}");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_missing_data_json() {
        let root = test_dir("restore-no-data");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();

        let zip_path = root.join("bad.zip");
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(manifest_json.as_bytes()).unwrap();
        zip.finish().unwrap();

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(err.contains("data.json"), "{err}");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_manifest_json_too_large() {
        let root = test_dir("restore-large-manifest");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let zip_path = root.join("large-manifest.zip");
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("manifest.json", options).unwrap();
        let oversized_manifest = vec![b' '; (MAX_MANIFEST_JSON_UNCOMPRESSED_BYTES + 1) as usize];
        zip.write_all(&oversized_manifest).unwrap();
        zip.start_file("data.json", options).unwrap();
        zip.write_all(b"{}").unwrap();
        zip.finish().unwrap();

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(err.contains("manifest.json") && err.contains("超过上限"), "{err}");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_attachment_count_too_large() {
        let root = test_dir("restore-too-many-attachments");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let zip_path = root.join("too-many.zip");
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(b"{}").unwrap();
        zip.start_file("data.json", options).unwrap();
        zip.write_all(b"{}").unwrap();

        for index in 0..=MAX_ATTACHMENT_COUNT {
            let path = format!("attachments/{index:064x}.png");
            zip.start_file(path, options).unwrap();
            zip.write_all(b"x").unwrap();
        }
        zip.finish().unwrap();

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(err.contains("附件数量超过上限"), "{err}");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_total_attachment_size_too_large() {
        let root = test_dir("restore-total-attachment-size");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let zip_path = root.join("too-large-total.zip");
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(b"{}").unwrap();
        zip.start_file("data.json", options).unwrap();
        zip.write_all(b"{}").unwrap();

        zip.start_file(
            "attachments/0000000000000000000000000000000000000000000000000000000000000000.png",
            options,
        )
        .unwrap();
        let oversized_total = vec![b'x'; (MAX_TOTAL_ATTACHMENT_UNCOMPRESSED_BYTES + 1) as usize];
        zip.write_all(&oversized_total).unwrap();
        zip.finish().unwrap();

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(err.contains("附件总解压大小超过上限"), "{err}");

        let _ = std::fs::remove_dir_all(root);
    }

    // =======================================================================
    // restore_local_backup_inner：清单验证失败
    // =======================================================================

    #[test]
    fn restore_fails_manifest_app_mismatch() {
        let root = test_dir("restore-app-mismatch");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = restore_data_json_with_board("b1", &[]);
        let mut manifest = minimal_restore_manifest(vec![]);
        manifest.app = "OtherApp".to_string();
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(err.contains("SoNotes") || err.contains("不匹配"), "{err}");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_unsupported_format_version() {
        let root = test_dir("restore-bad-fmt-ver");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = restore_data_json_with_board("b1", &[]);
        let mut manifest = minimal_restore_manifest(vec![]);
        manifest.format_version = 999;
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(err.contains("格式版本") || err.contains("format"), "{err}");

        let _ = std::fs::remove_dir_all(root);
    }

    // =======================================================================
    // restore_local_backup_inner：data.json 数据验证失败
    // =======================================================================

    #[test]
    fn restore_fails_invalid_schema_version() {
        let root = test_dir("restore-bad-schema");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = serde_json::json!({
            "schemaVersion": 999,
            "storageUpdatedAt": 0,
            "boards": [],
            "notes": [],
            "currentBoardId": "",
            "config": {"version": 1, "maxZ": 1, "themeMode": "light"}
        })
        .to_string();
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(err.contains("schemaVersion"), "{err}");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_current_board_id_not_found() {
        let root = test_dir("restore-missing-board");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [{"id": "b1", "name": "A", "icon": "📋", "createdAt": 0}],
            "notes": [],
            "currentBoardId": "nonexistent",
            "config": {"version": 1, "maxZ": 1, "themeMode": "light"}
        })
        .to_string();
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(
            err.contains("currentBoardId") || err.contains("看板"),
            "{err}"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_empty_boards() {
        let root = test_dir("restore-empty-boards");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [],
            "notes": [],
            "currentBoardId": "b1",
            "config": {"version": 1, "maxZ": 1, "themeMode": "light"}
        })
        .to_string();
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(err.contains("boards") || err.contains("看板"), "{err}");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_empty_current_board_id() {
        let root = test_dir("restore-empty-current-board");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [{"id": "b1", "name": "A", "icon": "📋", "createdAt": 0}],
            "notes": [],
            "currentBoardId": "",
            "config": {"version": 1, "maxZ": 1, "themeMode": "light"}
        })
        .to_string();
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(err.contains("currentBoardId") || err.contains("不能为空"), "{err}");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_missing_current_board_id() {
        let root = test_dir("restore-no-current-board");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [{"id": "b1", "name": "A", "icon": "📋", "createdAt": 0}],
            "notes": [],
            "config": {"version": 1, "maxZ": 1, "themeMode": "light"}
        })
        .to_string();
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(err.contains("currentBoardId") || err.contains("解析"), "{err}");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_invalid_note_kind() {
        let root = test_dir("restore-bad-kind");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [{"id": "b1", "name": "A", "icon": "📋", "createdAt": 0}],
            "notes": [{"id": "n1", "kind": "video", "boardId": "b1",
                "x": 0, "y": 0, "title": "", "content": "", "color": "yellow",
                "z": 1, "createdAt": 0, "updatedAt": 0}],
            "currentBoardId": "b1",
            "config": {"version": 1, "maxZ": 1, "themeMode": "light"}
        })
        .to_string();
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(err.contains("kind"), "{err}");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_accepts_legacy_text_note_missing_kind() {
        let root = test_dir("restore-legacy-note-no-kind");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [{"id": "b1", "name": "A", "icon": "📋", "createdAt": 0}],
            "notes": [{"id": "n1", "boardId": "b1",
                "x": 0, "y": 0, "title": "旧文本便签", "content": "legacy", "color": "yellow",
                "z": 1, "createdAt": 0, "updatedAt": 0}],
            "currentBoardId": "b1",
            "config": {"version": 1, "maxZ": 1, "themeMode": "light"}
        })
        .to_string();
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let result = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap();
        assert!(result.success);
        assert_eq!(result.note_count, 1);

        let restored = std::fs::read_to_string(sonotes_base.join("data.json")).unwrap();
        assert!(restored.contains("旧文本便签"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_text_note_with_attachments() {
        let root = test_dir("restore-text-with-att");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [{"id": "b1", "name": "A", "icon": "📋", "createdAt": 0}],
            "notes": [{
                "id": "n1", "kind": "text", "boardId": "b1",
                "x": 0, "y": 0, "title": "", "content": "", "color": "yellow",
                "z": 1, "createdAt": 0, "updatedAt": 0,
                "attachments": [{"id": "a1", "hash": "", "filename": "",
                    "mimeType": "image/png", "size": 0,
                    "relativePath": "attachments/abc.png", "createdAt": 0}]
            }],
            "currentBoardId": "b1",
            "config": {"version": 1, "maxZ": 1, "themeMode": "light"}
        })
        .to_string();
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(err.contains("文本便签") || err.contains("附件"), "{err}");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_image_note_missing_attachment() {
        let root = test_dir("restore-img-no-att");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [{"id": "b1", "name": "A", "icon": "📋", "createdAt": 0}],
            "notes": [{
                "id": "n1", "kind": "image", "boardId": "b1",
                "x": 0, "y": 0, "title": "", "content": "", "color": "yellow",
                "z": 1, "createdAt": 0, "updatedAt": 0
            }],
            "currentBoardId": "b1",
            "config": {"version": 1, "maxZ": 1, "themeMode": "light"}
        })
        .to_string();
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(err.contains("图片便签") || err.contains("缺少"), "{err}");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_image_note_two_attachments() {
        let root = test_dir("restore-img-two-att");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [{"id": "b1", "name": "A", "icon": "📋", "createdAt": 0}],
            "notes": [{
                "id": "n1", "kind": "image", "boardId": "b1",
                "x": 0, "y": 0, "title": "", "content": "", "color": "yellow",
                "z": 1, "createdAt": 0, "updatedAt": 0,
                "attachments": [
                    {"id": "a1", "hash": "", "filename": "", "mimeType": "image/png",
                        "size": 0, "relativePath": "attachments/aaa.png", "createdAt": 0},
                    {"id": "a2", "hash": "", "filename": "", "mimeType": "image/png",
                        "size": 0, "relativePath": "attachments/bbb.png", "createdAt": 0}
                ]
            }],
            "currentBoardId": "b1",
            "config": {"version": 1, "maxZ": 1, "themeMode": "light"}
        })
        .to_string();
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(err.contains("恰好有一个") || err.contains("附件"), "{err}");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_image_note_invalid_hash_stem() {
        let root = test_dir("restore-img-bad-stem");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [{"id": "b1", "name": "A", "icon": "📋", "createdAt": 0}],
            "notes": [{
                "id": "n1", "kind": "image", "boardId": "b1",
                "x": 0, "y": 0, "title": "", "content": "", "color": "yellow",
                "z": 1, "createdAt": 0, "updatedAt": 0,
                "attachments": [{
                    "id": "a1", "hash": "not-a-hash", "filename": "not-a-hash.png", "mimeType": "image/png",
                    "size": 0, "relativePath": "attachments/not-a-hash.png", "createdAt": 0
                }]
            }],
            "currentBoardId": "b1",
            "config": {"version": 1, "maxZ": 1, "themeMode": "light"}
        })
        .to_string();
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(err.contains("合法哈希") || err.contains("hash"), "{err}");

        let _ = std::fs::remove_dir_all(root);
    }

    // =======================================================================
    // restore_local_backup_inner：附件 SHA/大小不匹配
    // =======================================================================

    #[test]
    fn restore_fails_attachment_sha_mismatch() {
        let root = test_dir("restore-sha-mismatch");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let img_content = b"real image content";
        let hash = compute_test_sha256(img_content);
        let rel_path = format!("attachments/{hash}.png");

        let data_json = restore_data_json_with_board(
            "b1",
            &[image_note_for_restore("n1", "b1", &rel_path, &hash, img_content.len() as u64)],
        );

        let mut bad_entry = make_image_attachment_entry(&rel_path, img_content);
        bad_entry.sha256 = "0".repeat(64);

        let manifest = minimal_restore_manifest(vec![bad_entry]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[(&rel_path, img_content)]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(err.contains("SHA-256") || err.contains("不匹配"), "{err}");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_attachment_size_mismatch() {
        let root = test_dir("restore-size-mismatch");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let img_content = b"real image content";
        let hash = compute_test_sha256(img_content);
        let rel_path = format!("attachments/{hash}.png");

        let data_json = restore_data_json_with_board(
            "b1",
            &[image_note_for_restore("n1", "b1", &rel_path, &hash, img_content.len() as u64)],
        );

        let mut bad_entry = make_image_attachment_entry(&rel_path, img_content);
        bad_entry.size = 999999;

        let manifest = minimal_restore_manifest(vec![bad_entry]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[(&rel_path, img_content)]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(err.contains("大小") || err.contains("size"), "{err}");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_attachment_filename_hash_mismatch() {
        let root = test_dir("restore-fname-mismatch");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let img_content = b"image content for hash test";
        let _real_hash = compute_test_sha256(img_content);
        let fake_hash = "aabbccdd".repeat(8);
        let rel_path = format!("attachments/{fake_hash}.png");

        let data_json = restore_data_json_with_board(
            "b1",
            &[image_note_for_restore("n1", "b1", &rel_path, &fake_hash, img_content.len() as u64)],
        );

        let entry = make_image_attachment_entry(&rel_path, img_content);
        let manifest = minimal_restore_manifest(vec![entry]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[(&rel_path, img_content)]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(
            err.contains("文件名哈希") || err.contains("SHA-256") || err.contains("不匹配"),
            "{err}"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    // =======================================================================
    // restore_local_backup_inner：清单与数据引用不一致
    // =======================================================================

    #[test]
    fn restore_fails_extra_manifest_attachment_not_referenced() {
        let root = test_dir("restore-extra-manifest");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = restore_data_json_with_board("b1", &[]);

        let orphan_content = b"orphan image";
        let orphan_entry = make_image_attachment_entry("attachments/orphan.png", orphan_content);
        let manifest = minimal_restore_manifest(vec![orphan_entry]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(
            &manifest_json,
            &data_json,
            &[("attachments/orphan.png", orphan_content)],
        );

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(
            err.contains("未被数据引用") || err.contains("not referenced"),
            "{err}"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_data_ref_missing_in_zip() {
        let root = test_dir("restore-missing-zip-att");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let img_content = b"some image";
        let hash = compute_test_sha256(img_content);
        let rel_path = format!("attachments/{hash}.png");

        let data_json = restore_data_json_with_board(
            "b1",
            &[image_note_for_restore("n1", "b1", &rel_path, &hash, img_content.len() as u64)],
        );
        let entry = make_image_attachment_entry(&rel_path, img_content);
        let manifest = minimal_restore_manifest(vec![entry]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();

        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);
        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(
            err.contains("缺少") || err.contains("不在备份清单中"),
            "{err}"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    // =======================================================================
    // restore_local_backup_inner：zip 安全验证
    // =======================================================================

    #[test]
    fn restore_fails_zip_slash_traversal() {
        let root = test_dir("restore-zip-slip");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let zip_path = root.join("slip.zip");
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("../escape.txt", options).unwrap();
        zip.write_all(b"escaped").unwrap();
        zip.finish().unwrap();

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(
            err.contains("相对路径段") || err.contains("zip 条目"),
            "{err}"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_duplicate_manifest() {
        let root = test_dir("restore-dup-manifest");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let zip_path = root.join("dup.zip");
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(b"{}").unwrap();

        let dup_result = zip.start_file("manifest.json", options);
        assert!(dup_result.is_err(), "zip crate 应拒绝重复条目");
        let err_msg = dup_result.unwrap_err().to_string();
        assert!(
            err_msg.contains("Duplicate") || err_msg.contains("duplicate"),
            "错误应提及重复: {err_msg}"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_unknown_entry() {
        let root = test_dir("restore-unknown-entry");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = restore_data_json_with_board("b1", &[]);
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();

        let zip_path = root.join("unknown.zip");
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(manifest_json.as_bytes()).unwrap();
        zip.start_file("data.json", options).unwrap();
        zip.write_all(data_json.as_bytes()).unwrap();
        zip.start_file("malware.exe", options).unwrap();
        zip.write_all(b"bad").unwrap();
        zip.finish().unwrap();

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(
            err.contains("不在允许范围内") || err.contains("未知条目"),
            "{err}"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    // =======================================================================
    // restore_local_backup_inner：原子性 — 失败不改变现有文件
    // =======================================================================

    #[test]
    fn restore_failure_preserves_existing_data() {
        let root = test_dir("restore-fail-preserve");
        let sonotes_base = root.join("SoNotes");
        let attach_dir = sonotes_base.join("attachments");
        std::fs::create_dir_all(&attach_dir).unwrap();

        let original_data = "{\"original\": true}";
        std::fs::write(sonotes_base.join("data.json"), original_data).unwrap();
        std::fs::write(attach_dir.join("old.png"), b"old image").unwrap();

        let data_json = serde_json::json!({
            "schemaVersion": 999,
            "storageUpdatedAt": 0,
            "boards": [],
            "notes": [],
            "currentBoardId": "",
            "config": {"version": 1, "maxZ": 1, "themeMode": "light"}
        })
        .to_string();
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path);
        assert!(err.is_err());

        let preserved = std::fs::read_to_string(sonotes_base.join("data.json")).unwrap();
        assert_eq!(preserved, original_data, "data.json 应保持不变");
        assert!(attach_dir.join("old.png").exists(), "旧附件应保持不变");

        let _ = std::fs::remove_dir_all(root);
    }

    // =======================================================================
    // restore_local_backup_inner：成功后旧附件被移除
    // =======================================================================

    #[test]
    fn restore_success_removes_old_attachments() {
        let root = test_dir("restore-remove-old");
        let sonotes_base = root.join("SoNotes");
        let old_attach_dir = sonotes_base.join("attachments");
        std::fs::create_dir_all(&old_attach_dir).unwrap();
        std::fs::write(old_attach_dir.join("old_a.png"), b"old a").unwrap();
        std::fs::write(old_attach_dir.join("old_b.jpg"), b"old b").unwrap();

        let img_content = b"new image content here";
        let hash = compute_test_sha256(img_content);
        let rel_path = format!("attachments/{hash}.png");

        let data_json = restore_data_json_with_board(
            "b1",
            &[image_note_for_restore("n1", "b1", &rel_path, &hash, img_content.len() as u64)],
        );
        let entry = make_image_attachment_entry(&rel_path, img_content);
        let manifest = minimal_restore_manifest(vec![entry]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[(&rel_path, img_content)]);

        let result = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap();
        assert!(result.success);

        assert!(
            !old_attach_dir.join("old_a.png").exists(),
            "旧附件 old_a.png 应被移除"
        );
        assert!(
            !old_attach_dir.join("old_b.jpg").exists(),
            "旧附件 old_b.jpg 应被移除"
        );
        assert!(
            old_attach_dir.join(format!("{hash}.png")).exists(),
            "新附件应存在"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_success_removes_old_attachments_when_new_has_none() {
        let root = test_dir("restore-remove-old-no-new");
        let sonotes_base = root.join("SoNotes");
        let old_attach_dir = sonotes_base.join("attachments");
        std::fs::create_dir_all(&old_attach_dir).unwrap();
        std::fs::write(old_attach_dir.join("stale.png"), b"stale").unwrap();

        let data_json = restore_data_json_with_board("b1", &[text_note("n1", "b1")]);
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let result = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap();
        assert!(result.success);
        assert!(!old_attach_dir.exists(), "旧附件目录应被整体移除");

        let _ = std::fs::remove_dir_all(root);
    }

    // =======================================================================
    // 恢复校验：config 缺失/无效
    // =======================================================================

    #[test]
    fn restore_fails_missing_config() {
        let root = test_dir("restore-no-config");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [],
            "notes": [],
            "currentBoardId": ""
        })
        .to_string();
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(
            err.contains("config") || err.contains("解析") || err.contains("missing"),
            "{err}"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_config_missing_theme_mode() {
        let root = test_dir("restore-no-theme");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [],
            "notes": [],
            "currentBoardId": "",
            "config": {"version": 1, "maxZ": 1}
        })
        .to_string();
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(
            err.contains("config") || err.contains("themeMode") || err.contains("解析"),
            "{err}"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    // =======================================================================
    // 恢复校验：看板缺少必填字段
    // =======================================================================

    #[test]
    fn restore_fails_board_missing_id() {
        let root = test_dir("restore-board-no-id");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [{"name": "A", "icon": "📋", "createdAt": 0}],
            "notes": [],
            "currentBoardId": "",
            "config": {"version": 1, "maxZ": 1, "themeMode": "light"}
        })
        .to_string();
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(
            err.contains("看板") || err.contains("id") || err.contains("解析"),
            "{err}"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_board_missing_name() {
        let root = test_dir("restore-board-no-name");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [{"id": "b1", "icon": "📋", "createdAt": 0}],
            "notes": [],
            "currentBoardId": "",
            "config": {"version": 1, "maxZ": 1, "themeMode": "light"}
        })
        .to_string();
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(
            err.contains("name") || err.contains("看板") || err.contains("解析"),
            "{err}"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_board_missing_icon() {
        let root = test_dir("restore-board-no-icon");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [{"id": "b1", "name": "A", "createdAt": 0}],
            "notes": [],
            "currentBoardId": "",
            "config": {"version": 1, "maxZ": 1, "themeMode": "light"}
        })
        .to_string();
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(
            err.contains("icon") || err.contains("看板") || err.contains("解析"),
            "{err}"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_board_invalid_viewport_x() {
        let root = test_dir("restore-board-bad-viewport-x");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [{
                "id": "b1",
                "name": "A",
                "icon": "📋",
                "createdAt": 0,
                "viewport": {"x": "not_a_number", "y": 0}
            }],
            "notes": [],
            "currentBoardId": "",
            "config": {"version": 1, "maxZ": 1, "themeMode": "light"}
        })
        .to_string();
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(
            err.contains("viewport") || err.contains("x") || err.contains("解析"),
            "{err}"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    // =======================================================================
    // 恢复校验：便签 boardId 引用
    // =======================================================================

    #[test]
    fn restore_fails_note_missing_board_id() {
        let root = test_dir("restore-note-no-bid");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [{"id": "b1", "name": "A", "icon": "📋", "createdAt": 0}],
            "notes": [{
                "id": "n1", "kind": "text",
                "x": 0, "y": 0, "title": "", "content": "", "color": "yellow",
                "z": 1, "createdAt": 0, "updatedAt": 0
            }],
            "currentBoardId": "b1",
            "config": {"version": 1, "maxZ": 1, "themeMode": "light"}
        })
        .to_string();
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(err.contains("boardId") || err.contains("缺少"), "{err}");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_note_invalid_board_id() {
        let root = test_dir("restore-note-bad-bid");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [{"id": "b1", "name": "A", "icon": "📋", "createdAt": 0}],
            "notes": [{
                "id": "n1", "kind": "text", "boardId": "nonexistent",
                "x": 0, "y": 0, "title": "", "content": "", "color": "yellow",
                "z": 1, "createdAt": 0, "updatedAt": 0
            }],
            "currentBoardId": "b1",
            "config": {"version": 1, "maxZ": 1, "themeMode": "light"}
        })
        .to_string();
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(
            err.contains("不存在的看板") || err.contains("boardId"),
            "{err}"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_accepts_trashed_note_without_board_id() {
        let root = test_dir("restore-trash-no-bid");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [{"id": "b1", "name": "A", "icon": "📋", "createdAt": 0}],
            "notes": [{
                "id": "n1", "kind": "text",
                "x": 0, "y": 0, "title": "", "content": "", "color": "yellow",
                "z": 1, "createdAt": 0, "updatedAt": 0,
                "deletedAt": 1700000000000_u64
            }],
            "currentBoardId": "b1",
            "config": {"version": 1, "maxZ": 1, "themeMode": "light"}
        })
        .to_string();
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let result = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap();
        assert!(result.success);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_duplicate_note_id() {
        let root = test_dir("restore-duplicate-note-id");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [{"id": "b1", "name": "A", "icon": "📋", "createdAt": 0}],
            "notes": [
                {
                    "id": "n1", "kind": "text", "boardId": "b1",
                    "x": 0, "y": 0, "title": "", "content": "", "color": "yellow",
                    "z": 1, "createdAt": 0, "updatedAt": 0
                },
                {
                    "id": "n1", "kind": "text", "boardId": "b1",
                    "x": 10, "y": 10, "title": "", "content": "", "color": "yellow",
                    "z": 2, "createdAt": 0, "updatedAt": 0
                }
            ],
            "currentBoardId": "b1",
            "config": {"version": 1, "maxZ": 2, "themeMode": "light"}
        })
        .to_string();
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(err.contains("便签 id 重复") || err.contains("重复"), "{err}");

        let _ = std::fs::remove_dir_all(root);
    }

    // =======================================================================
    // 恢复校验：便签坐标/时间戳无效
    // =======================================================================

    #[test]
    fn restore_fails_note_invalid_x() {
        let root = test_dir("restore-note-bad-x");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data_json = serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [{"id": "b1", "name": "A", "icon": "📋", "createdAt": 0}],
            "notes": [{
                "id": "n1", "kind": "text", "boardId": "b1",
                "x": "not_a_number", "y": 0, "title": "", "content": "", "color": "yellow",
                "z": 1, "createdAt": 0, "updatedAt": 0
            }],
            "currentBoardId": "b1",
            "config": {"version": 1, "maxZ": 1, "themeMode": "light"}
        })
        .to_string();
        let manifest = minimal_restore_manifest(vec![]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(
            err.contains("解析") || err.contains("x") || err.contains("number"),
            "{err}"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    // =======================================================================
    // 恢复校验：附件 hash 与文件名/内容不匹配
    // =======================================================================

    #[test]
    fn restore_fails_attachment_hash_empty() {
        let root = test_dir("restore-hash-empty");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let img_content = b"some content";
        let hash = compute_test_sha256(img_content);
        let rel_path = format!("attachments/{hash}.png");

        let data_json = serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [{"id": "b1", "name": "A", "icon": "📋", "createdAt": 0}],
            "notes": [{
                "id": "n1", "kind": "image", "boardId": "b1",
                "x": 0, "y": 0, "title": "", "content": "", "color": "yellow",
                "z": 1, "createdAt": 0, "updatedAt": 0,
                "attachments": [{
                    "id": "a1", "hash": "", "filename": "", "mimeType": "image/png",
                    "size": 0, "relativePath": rel_path, "createdAt": 0
                }]
            }],
            "currentBoardId": "b1",
            "config": {"version": 1, "maxZ": 1, "themeMode": "light"}
        })
        .to_string();
        let entry = make_image_attachment_entry(&rel_path, img_content);
        let manifest = minimal_restore_manifest(vec![entry]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[(&rel_path, img_content)]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(err.contains("hash") || err.contains("不能为空"), "{err}");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_attachment_hash_stem_mismatch() {
        let root = test_dir("restore-hash-stem-mismatch");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let img_content = b"content for stem mismatch";
        let real_hash = compute_test_sha256(img_content);
        let rel_path = format!("attachments/{real_hash}.png");

        let data_json = serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [{"id": "b1", "name": "A", "icon": "📋", "createdAt": 0}],
            "notes": [{
                "id": "n1", "kind": "image", "boardId": "b1",
                "x": 0, "y": 0, "title": "", "content": "", "color": "yellow",
                "z": 1, "createdAt": 0, "updatedAt": 0,
                "attachments": [{
                    "id": "a1", "hash": "00000000000000000000000000000000000000000000000000000000000000aa",
                    "filename": format!("{real_hash}.png"), "mimeType": "image/png",
                    "size": img_content.len() as u64, "relativePath": rel_path, "createdAt": 0
                }]
            }],
            "currentBoardId": "b1",
            "config": {"version": 1, "maxZ": 1, "themeMode": "light"}
        })
        .to_string();
        let entry = make_image_attachment_entry(&rel_path, img_content);
        let manifest = minimal_restore_manifest(vec![entry]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[(&rel_path, img_content)]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(
            err.contains("hash") || err.contains("文件名") || err.contains("不匹配"),
            "{err}"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_fails_attachment_missing_contract_fields() {
        let root = test_dir("restore-attachment-missing-fields");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let img_content = b"content with incomplete attachment ref";
        let hash = compute_test_sha256(img_content);
        let rel_path = format!("attachments/{hash}.png");

        let data_json = serde_json::json!({
            "schemaVersion": 2,
            "storageUpdatedAt": 0,
            "boards": [{"id": "b1", "name": "A", "icon": "📋", "createdAt": 0}],
            "notes": [{
                "id": "n1", "kind": "image", "boardId": "b1",
                "x": 0, "y": 0, "title": "", "content": "", "color": "yellow",
                "z": 1, "createdAt": 0, "updatedAt": 0,
                "attachments": [{
                    "hash": hash,
                    "relativePath": rel_path
                }]
            }],
            "currentBoardId": "b1",
            "config": {"version": 1, "maxZ": 1, "themeMode": "light"}
        })
        .to_string();
        let entry = make_image_attachment_entry(&rel_path, img_content);
        let manifest = minimal_restore_manifest(vec![entry]);
        let manifest_json = serde_json::to_string(&manifest).unwrap();
        let zip_path = build_test_zip(&manifest_json, &data_json, &[(&rel_path, img_content)]);

        let err = restore_local_backup_inner(&sonotes_base, &zip_path).unwrap_err();
        assert!(err.contains("解析") || err.contains("id") || err.contains("filename"), "{err}");

        let _ = std::fs::remove_dir_all(root);
    }

    // =======================================================================
    // 备份原子性：失败时不留下半成品 zip
    // =======================================================================

    #[test]
    fn backup_failure_leaves_no_zip_or_temp() {
        let root = test_dir("backup-no-leftover");
        let sonotes_base = root.join("SoNotes");
        let attach_dir = sonotes_base.join("attachments");
        std::fs::create_dir_all(&attach_dir).unwrap();

        let blocked_rel_path =
            "attachments/0000000000000000000000000000000000000000000000000000000000000000.png";
        std::fs::create_dir_all(sonotes_base.join(blocked_rel_path)).unwrap();

        let data = minimal_data_json(
            &[serde_json::json!({"id": "b1", "name": "看板", "icon": "📋", "createdAt": 0})],
            &[image_note("n1", "b1", blocked_rel_path, 0)],
        );
        std::fs::write(sonotes_base.join("data.json"), &data).unwrap();

        let target = root.join("backup.zip");
        let stale_fixed_temp = root.join("backup.zip.tmp");
        std::fs::write(&stale_fixed_temp, b"stale temp").unwrap();
        let result = create_local_backup_inner(&sonotes_base, &target);

        assert!(result.is_err());
        assert!(!target.exists(), "失败时不应留下最终 zip");
        assert_eq!(std::fs::read(&stale_fixed_temp).unwrap(), b"stale temp");
        let leftovers = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(".backup.zip."))
            .count();
        assert_eq!(leftovers, 0, "失败时不应留下随机临时 zip");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn backup_success_has_no_temp_leftover() {
        let root = test_dir("backup-no-tmp");
        let sonotes_base = root.join("SoNotes");
        std::fs::create_dir_all(&sonotes_base).unwrap();

        let data = minimal_data_json(
            &[serde_json::json!({"id": "b1", "name": "看板", "icon": "📋", "createdAt": 0})],
            &[text_note("n1", "b1")],
        );
        std::fs::write(sonotes_base.join("data.json"), &data).unwrap();

        let target = root.join("backup.zip");
        let result = create_local_backup_inner(&sonotes_base, &target).unwrap();

        assert!(result.success);
        assert!(target.exists(), "成功时应存在最终 zip");
        let leftovers = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(".backup.zip."))
            .count();
        assert_eq!(leftovers, 0, "成功后不应留下随机临时 zip");

        let _ = std::fs::remove_dir_all(root);
    }

    // =======================================================================
    // BackupValidationIssue 构造 helper
    // =======================================================================

    #[test]
    fn issue_new_sets_code_severity_message() {
        let issue = BackupValidationIssue::new("missing_manifest", "error", "缺少清单");
        assert_eq!(issue.code, "missing_manifest");
        assert_eq!(issue.severity, "error");
        assert_eq!(issue.message, "缺少清单");
        assert!(issue.target.is_none());
        assert!(issue.path.is_none());
        assert!(issue.note_id.is_none());
        assert!(issue.image_file_id.is_none());
    }

    #[test]
    fn issue_error_convenience_sets_severity_error() {
        let issue = BackupValidationIssue::error("invalid_zip", "zip 损坏");
        assert_eq!(issue.severity, "error");
        assert_eq!(issue.code, "invalid_zip");
    }

    #[test]
    fn issue_warning_convenience_sets_severity_warning() {
        let issue = BackupValidationIssue::warning("unsupported_format_version", "旧版本");
        assert_eq!(issue.severity, "warning");
        assert_eq!(issue.code, "unsupported_format_version");
    }

    #[test]
    fn issue_builder_chains_all_metadata_fields() {
        let issue = BackupValidationIssue::error("image_file_hash_mismatch", "哈希不匹配")
            .with_target("image_file")
            .with_path("attachments/abc123.png")
            .with_note_id("n1")
            .with_image_file_id("img-1");

        assert_eq!(issue.target.as_deref(), Some("image_file"));
        assert_eq!(issue.path.as_deref(), Some("attachments/abc123.png"));
        assert_eq!(issue.note_id.as_deref(), Some("n1"));
        assert_eq!(issue.image_file_id.as_deref(), Some("img-1"));
    }

    // =======================================================================
    // BackupValidationIssue 序列化 roundtrip 与 camelCase
    // =======================================================================

    #[test]
    fn validation_issue_roundtrip() {
        let issue = BackupValidationIssue::error("missing_image_file", "图片文件缺失")
            .with_target("image_file")
            .with_path("attachments/deadbeef.png")
            .with_note_id("n42")
            .with_image_file_id("att-42");

        let json = serde_json::to_string(&issue).expect("序列化失败");
        let deserialized: BackupValidationIssue = serde_json::from_str(&json).expect("反序列化失败");

        assert_eq!(deserialized.code, "missing_image_file");
        assert_eq!(deserialized.severity, "error");
        assert_eq!(deserialized.message, "图片文件缺失");
        assert_eq!(deserialized.target.as_deref(), Some("image_file"));
        assert_eq!(deserialized.path.as_deref(), Some("attachments/deadbeef.png"));
        assert_eq!(deserialized.note_id.as_deref(), Some("n42"));
        assert_eq!(deserialized.image_file_id.as_deref(), Some("att-42"));
    }

    #[test]
    fn validation_issue_json_keys_are_camel_case() {
        let issue = BackupValidationIssue {
            code: "test".to_string(),
            severity: "error".to_string(),
            message: "msg".to_string(),
            target: Some("zip".to_string()),
            path: Some("a/b".to_string()),
            note_id: Some("n1".to_string()),
            image_file_id: Some("img1".to_string()),
        };

        let json = serde_json::to_string(&issue).expect("序列化失败");
        assert!(json.contains("\"noteId\""), "应使用 camelCase noteId: {json}");
        assert!(
            json.contains("\"imageFileId\""),
            "应使用 camelCase imageFileId: {json}"
        );
        assert!(!json.contains("\"note_id\""), "不应包含 snake_case: {json}");
        assert!(
            !json.contains("\"image_file_id\""),
            "不应包含 snake_case: {json}"
        );
    }

    #[test]
    fn validation_issue_none_fields_omitted_or_null() {
        let issue = BackupValidationIssue::error("invalid_zip", "不是合法 zip");

        let json = serde_json::to_string(&issue).expect("序列化失败");
        let deserialized: BackupValidationIssue = serde_json::from_str(&json).expect("反序列化失败");

        assert!(deserialized.target.is_none());
        assert!(deserialized.path.is_none());
        assert!(deserialized.note_id.is_none());
        assert!(deserialized.image_file_id.is_none());
    }

    // =======================================================================
    // BackupValidationResult 序列化 roundtrip 与 camelCase
    // =======================================================================

    #[test]
    fn validation_result_ok_roundtrip() {
        let result = BackupValidationResult {
            ok: true,
            summary: Some(BackupSummary {
                app: "SoNotes".to_string(),
                format_version: 1,
                app_version: "1.5.2".to_string(),
                created_at: 1700000000000,
                note_count: 10,
                board_count: 2,
                text_note_count: 8,
                image_note_count: 2,
                trash_note_count: 1,
                image_file_count: 3,
                image_file_total_bytes: 4096,
            }),
            errors: vec![],
            warnings: vec![],
        };

        let json = serde_json::to_string(&result).expect("序列化失败");
        let deserialized: BackupValidationResult =
            serde_json::from_str(&json).expect("反序列化失败");

        assert!(deserialized.ok);
        assert!(deserialized.summary.is_some());
        assert!(deserialized.errors.is_empty());
        assert!(deserialized.warnings.is_empty());
        let summary = deserialized.summary.unwrap();
        assert_eq!(summary.app, "SoNotes");
        assert_eq!(summary.text_note_count, 8);
        assert_eq!(summary.image_note_count, 2);
        assert_eq!(summary.trash_note_count, 1);
        assert_eq!(summary.image_file_count, 3);
        assert_eq!(summary.image_file_total_bytes, 4096);
    }

    #[test]
    fn validation_result_error_roundtrip() {
        let result = BackupValidationResult {
            ok: false,
            summary: None,
            errors: vec![
                BackupValidationIssue::error("missing_manifest", "缺少 manifest.json")
                    .with_target("zip"),
            ],
            warnings: vec![],
        };

        let json = serde_json::to_string(&result).expect("序列化失败");
        let deserialized: BackupValidationResult =
            serde_json::from_str(&json).expect("反序列化失败");

        assert!(!deserialized.ok);
        assert!(deserialized.summary.is_none());
        assert_eq!(deserialized.errors.len(), 1);
        assert_eq!(deserialized.errors[0].code, "missing_manifest");
        assert_eq!(deserialized.errors[0].target.as_deref(), Some("zip"));
    }

    #[test]
    fn validation_result_json_keys_are_camel_case() {
        let result = BackupValidationResult {
            ok: true,
            summary: Some(BackupSummary {
                app: "SoNotes".to_string(),
                format_version: 1,
                app_version: "1.5.2".to_string(),
                created_at: 0,
                note_count: 0,
                board_count: 0,
                text_note_count: 0,
                image_note_count: 0,
                trash_note_count: 0,
                image_file_count: 0,
                image_file_total_bytes: 0,
            }),
            errors: vec![],
            warnings: vec![],
        };

        let json = serde_json::to_string(&result).expect("序列化失败");
        assert!(json.contains("\"summary\""), "应包含 summary: {json}");
        assert!(json.contains("\"errors\""), "应包含 errors: {json}");
        assert!(json.contains("\"warnings\""), "应包含 warnings: {json}");
        assert!(
            !json.contains("\"image_file_count\""),
            "不应包含 snake_case: {json}"
        );
    }

    // =======================================================================
    // BackupSummary 序列化 roundtrip 与 camelCase
    // =======================================================================

    #[test]
    fn summary_roundtrip() {
        let summary = BackupSummary {
            app: "SoNotes".to_string(),
            format_version: 1,
            app_version: "1.5.2".to_string(),
            created_at: 1700000000000,
            note_count: 42,
            board_count: 3,
            text_note_count: 30,
            image_note_count: 10,
            trash_note_count: 2,
            image_file_count: 8,
            image_file_total_bytes: 102400,
        };

        let json = serde_json::to_string(&summary).expect("序列化失败");
        let deserialized: BackupSummary = serde_json::from_str(&json).expect("反序列化失败");

        assert_eq!(deserialized.app, "SoNotes");
        assert_eq!(deserialized.format_version, 1);
        assert_eq!(deserialized.app_version, "1.5.2");
        assert_eq!(deserialized.created_at, 1700000000000);
        assert_eq!(deserialized.note_count, 42);
        assert_eq!(deserialized.board_count, 3);
        assert_eq!(deserialized.text_note_count, 30);
        assert_eq!(deserialized.image_note_count, 10);
        assert_eq!(deserialized.trash_note_count, 2);
        assert_eq!(deserialized.image_file_count, 8);
        assert_eq!(deserialized.image_file_total_bytes, 102400);
    }

    #[test]
    fn summary_json_keys_are_camel_case() {
        let summary = BackupSummary {
            app: "SoNotes".to_string(),
            format_version: 1,
            app_version: "1.0.0".to_string(),
            created_at: 0,
            note_count: 0,
            board_count: 0,
            text_note_count: 0,
            image_note_count: 0,
            trash_note_count: 0,
            image_file_count: 0,
            image_file_total_bytes: 0,
        };

        let json = serde_json::to_string(&summary).expect("序列化失败");
        assert!(
            json.contains("\"formatVersion\""),
            "应使用 camelCase: {json}"
        );
        assert!(json.contains("\"appVersion\""), "应使用 camelCase: {json}");
        assert!(json.contains("\"createdAt\""), "应使用 camelCase: {json}");
        assert!(json.contains("\"noteCount\""), "应使用 camelCase: {json}");
        assert!(json.contains("\"boardCount\""), "应使用 camelCase: {json}");
        assert!(
            json.contains("\"textNoteCount\""),
            "应使用 camelCase: {json}"
        );
        assert!(
            json.contains("\"imageNoteCount\""),
            "应使用 camelCase: {json}"
        );
        assert!(
            json.contains("\"trashNoteCount\""),
            "应使用 camelCase: {json}"
        );
        assert!(
            json.contains("\"imageFileCount\""),
            "应使用 camelCase: {json}"
        );
        assert!(
            json.contains("\"imageFileTotalBytes\""),
            "应使用 camelCase: {json}"
        );
        assert!(
            !json.contains("\"text_note_count\""),
            "不应包含 snake_case: {json}"
        );
    }
}
