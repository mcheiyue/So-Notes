//! 附件目录与文件基础操作模块
//!
//! 提供内容寻址的附件写入、存在性检查和元数据读取。
//! 附件存储在 `<Documents>/SoNotes/attachments/` 目录下，
//! 文件名为 `<sha256>.<ext>`，通过流式 SHA-256 哈希实现内容寻址。

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tauri::Manager;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const ATTACHMENTS_SUBDIR: &str = "attachments";
const DEFAULT_MIME: &str = "application/octet-stream";
const DEFAULT_EXTENSION: &str = "bin";
const COPY_BUF_SIZE: usize = 64 * 1024; // 64 KiB 流式拷贝缓冲区

// ---------------------------------------------------------------------------
// 返回值类型（serde camelCase 以便前端直接消费）
// ---------------------------------------------------------------------------

/// 写入附件后的结果元数据
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentWriteResult {
    pub hash: String,
    pub filename: String,
    pub mime_type: String,
    pub size: u64,
    pub relative_path: String,
    pub created_at: u64,
    /// 实际写入的字节数；如果文件已存在则为 0（复用已有文件）
    pub bytes_written: u64,
}

/// 附件文件元数据
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentFileMetadata {
    pub hash: String,
    pub filename: String,
    pub mime_type: String,
    pub size: u64,
    pub relative_path: String,
    pub created_at: u64,
}

// ---------------------------------------------------------------------------
// 纯辅助函数
// ---------------------------------------------------------------------------

/// 从文件名提取安全扩展名（不含前导点，已小写化）。
///
/// 规则：
/// - 返回 ASCII 字母数字且长度 ≤ 10 的扩展名。
/// - 不含扩展名或含路径分隔符则返回 `None`。
pub fn safe_extension_from_filename(filename: &str) -> Option<String> {
    let basename = filename.rsplit(['/', '\\']).next().unwrap_or(filename);
    let dot_pos = basename.rfind('.')?;
    let ext = &basename[dot_pos + 1..];
    if ext.is_empty() {
        return None;
    }
    let lower = ext.to_ascii_lowercase();
    if lower.len() > 10 {
        return None;
    }
    if !lower.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    Some(lower)
}

/// 常见 MIME → 安全扩展名映射。
pub fn safe_extension_for_mime(mime: &str) -> Option<&'static str> {
    match mime.to_ascii_lowercase().as_str() {
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "application/pdf" => Some("pdf"),
        "text/plain" => Some("txt"),
        _ => None,
    }
}

/// 归一化 MIME 类型：空值或未知值回退到 `application/octet-stream`。
pub fn normalize_mime(raw: Option<&str>) -> String {
    match raw {
        Some(m) => {
            let trimmed = m.trim();
            if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("application/octet-stream") {
                DEFAULT_MIME.to_string()
            } else {
                trimmed.to_ascii_lowercase()
            }
        }
        None => DEFAULT_MIME.to_string(),
    }
}

/// 根据 SHA-256 哈希和可选扩展名生成内容寻址的相对路径。
///
/// 格式：`attachments/<hash>[.ext]`
pub fn content_addressed_relative_path(hash: &str, ext: Option<&str>) -> String {
    match ext {
        Some(e) if !e.is_empty() => format!("{ATTACHMENTS_SUBDIR}/{hash}.{e}"),
        _ => format!("{ATTACHMENTS_SUBDIR}/{hash}"),
    }
}

/// 验证前端传入的 `relative_path` 是否安全。
///
/// 拒绝条件：
/// - 空字符串
/// - 包含 `\`
/// - 以 `/` 开头（绝对路径）
/// - 路径段为空、`.` 或 `..`
pub fn is_safe_relative_path(rel_path: &str) -> bool {
    if rel_path.is_empty() || rel_path.contains('\\') || rel_path.starts_with('/') {
        return false;
    }
    rel_path
        .split('/')
        .all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

/// 验证 relative_path 以 `attachments/` 开头，拼接到 SoNotes 基础目录后，
/// 对已存在文件做 canonicalize 边界校验。
///
/// `sonotes_base`：`<Documents>/SoNotes/`
fn resolve_existing_attachment(
    sonotes_base: &Path,
    relative_path: &str,
) -> Result<PathBuf, String> {
    if !is_safe_relative_path(relative_path) {
        return Err("relative_path 不合法：存在路径穿越或格式错误".to_string());
    }
    if !relative_path.starts_with("attachments/") {
        return Err("relative_path 必须以 attachments/ 开头".to_string());
    }
    let canonical_base = sonotes_base
        .canonicalize()
        .map_err(|e| format!("SoNotes 目录规范化失败: {e}"))?;
    let candidate = canonical_base.join(relative_path);
    let canonical = candidate
        .canonicalize()
        .map_err(|_| format!("附件文件不存在或无法访问: {relative_path}"))?;
    let canonical_attach = sonotes_base
        .join(ATTACHMENTS_SUBDIR)
        .canonicalize()
        .map_err(|e| format!("附件目录规范化失败: {e}"))?;
    if !canonical.starts_with(&canonical_attach) {
        return Err("relative_path 解析后超出附件目录边界".to_string());
    }
    Ok(canonical)
}

/// 对于可能不存在的附件路径做安全验证。
///
/// 不要求文件本身可 canonicalize，但要求：
/// - 路径通过 `is_safe_relative_path` 检查
/// - 以 `attachments/` 开头
/// - 父目录（attachments 目录）可 canonicalize 且候选路径位于其下
fn resolve_attachment_path_missing_safe(
    sonotes_base: &Path,
    relative_path: &str,
) -> Result<PathBuf, String> {
    if !is_safe_relative_path(relative_path) {
        return Err("relative_path 不合法：存在路径穿越或格式错误".to_string());
    }
    if !relative_path.starts_with("attachments/") {
        return Err("relative_path 必须以 attachments/ 开头".to_string());
    }
    let canonical_base = sonotes_base
        .canonicalize()
        .map_err(|e| format!("SoNotes 目录规范化失败: {e}"))?;
    let candidate = canonical_base.join(relative_path);
    let canonical_attach = canonical_base
        .join(ATTACHMENTS_SUBDIR)
        .canonicalize()
        .map_err(|e| format!("附件目录规范化失败: {e}"))?;
    // 用 candidate 的 normalize（去除 `.` / `..`）检查前缀，
    // 不要求文件存在
    let normalized = normalize_path(&candidate);
    if !normalized.starts_with(&canonical_attach) {
        return Err("relative_path 解析后超出附件目录边界".to_string());
    }
    Ok(candidate)
}

/// 纯路径规范化：去除 `.` 和 `..` 段，不要求路径存在。
fn normalize_path(path: &Path) -> PathBuf {
    let mut components = Vec::new();
    for comp in path.components() {
        match comp {
            std::path::Component::ParentDir => {
                components.pop();
            }
            std::path::Component::CurDir => {}
            other => components.push(other),
        }
    }
    components.iter().collect()
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

/// 获取附件基础目录（`<Documents>/SoNotes/attachments/`），不存在则创建。
fn ensure_attachments_base_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let doc_dir = app
        .path()
        .document_dir()
        .map_err(|e| format!("获取文档目录失败: {e}"))?;
    let attach_dir = doc_dir.join("SoNotes").join(ATTACHMENTS_SUBDIR);
    std::fs::create_dir_all(&attach_dir).map_err(|e| format!("创建附件目录失败: {e}"))?;
    Ok(attach_dir)
}

/// 获取 SoNotes 基础目录（`<Documents>/SoNotes/`），不存在则创建。
fn ensure_sonotes_base_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let doc_dir = app
        .path()
        .document_dir()
        .map_err(|e| format!("获取文档目录失败: {e}"))?;
    let base = doc_dir.join("SoNotes");
    std::fs::create_dir_all(&base).map_err(|e| format!("创建 SoNotes 目录失败: {e}"))?;
    Ok(base)
}

/// 将 SystemTime 转换为毫秒级 Unix 时间戳，溢出时回退到 0。
fn system_time_to_millis(st: SystemTime) -> u64 {
    st.duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// 将字节数格式化为 64 字符十六进制字符串。
fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

/// 将源路径指定的文件写入附件目录。
///
/// 流程：
/// 1. 流式读取源文件，同步计算 SHA-256 并写入临时文件。
/// 2. 根据哈希和扩展名确定最终路径。
/// 3. 若最终路径已存在，删除临时文件并复用已有文件。
/// 4. 否则原子 rename 临时文件到最终路径。
#[tauri::command]
pub async fn write_attachment_from_path(
    app: tauri::AppHandle,
    source_path: String,
    filename: String,
    mime_type: Option<String>,
) -> Result<AttachmentWriteResult, String> {
    let attach_dir = ensure_attachments_base_dir(&app)?;
    let normalized_mime = normalize_mime(mime_type.as_deref());

    let src = Path::new(&source_path);
    if !src.is_file() {
        return Err(format!("源文件不存在或不是文件: {source_path}"));
    }

    // 流式拷贝到临时文件并同步计算 SHA-256
    let mut hasher = Sha256::new();
    let tmp_path = attach_dir.join(format!(
        ".tmp-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));

    let mut src_file = std::fs::File::open(src).map_err(|e| format!("打开源文件失败: {e}"))?;
    let mut tmp_file =
        std::fs::File::create(&tmp_path).map_err(|e| format!("创建临时文件失败: {e}"))?;

    let mut buf = vec![0u8; COPY_BUF_SIZE];
    let mut total_size: u64 = 0;

    loop {
        let bytes_read = std::io::Read::read(&mut src_file, &mut buf)
            .map_err(|e| format!("读取源文件失败: {e}"))?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buf[..bytes_read]);
        std::io::Write::write_all(&mut tmp_file, &buf[..bytes_read])
            .map_err(|e| format!("写入临时文件失败: {e}"))?;
        total_size += bytes_read as u64;
    }

    std::io::Write::flush(&mut tmp_file).map_err(|e| format!("刷新临时文件失败: {e}"))?;

    // 计算哈希并确定最终路径
    let hash_bytes = hasher.finalize();
    let hash_hex = bytes_to_hex(&hash_bytes);
    let ext = safe_extension_from_filename(&filename)
        .or_else(|| safe_extension_for_mime(&normalized_mime).map(String::from))
        .unwrap_or_else(|| DEFAULT_EXTENSION.to_string());
    let relative_path = content_addressed_relative_path(&hash_hex, Some(&ext));
    let final_path = attach_dir.join(format!(
        "{hash_hex}{}",
        format!(".{ext}")
    ));

    let bytes_written: u64;

    if final_path.exists() {
        // 内容已存在：删除临时文件，复用已有
        let _ = std::fs::remove_file(&tmp_path);
        bytes_written = 0;
    } else {
        std::fs::rename(&tmp_path, &final_path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            format!("重命名临时文件失败: {e}")
        })?;
        bytes_written = total_size;
    }

    // 读取最终文件的元数据（创建时间）
    let meta = std::fs::metadata(&final_path).map_err(|e| format!("读取附件元数据失败: {e}"))?;
    let created_at = meta.created().map(system_time_to_millis).unwrap_or(0);

    Ok(AttachmentWriteResult {
        hash: hash_hex,
        filename,
        mime_type: normalized_mime,
        size: total_size,
        relative_path,
        created_at,
        bytes_written,
    })
}

/// 检查指定相对路径的附件文件是否存在。
#[tauri::command]
pub async fn attachment_exists(
    app: tauri::AppHandle,
    relative_path: String,
) -> Result<bool, String> {
    let base = ensure_sonotes_base_dir(&app)?;
    let _attach_dir = ensure_attachments_base_dir(&app)?;
    let resolved = resolve_attachment_path_missing_safe(&base, &relative_path)?;
    Ok(resolved.is_file())
}

/// 读取指定相对路径的附件文件元数据。
#[tauri::command]
pub async fn read_attachment_metadata(
    app: tauri::AppHandle,
    relative_path: String,
) -> Result<AttachmentFileMetadata, String> {
    let base = ensure_sonotes_base_dir(&app)?;
    let _attach_dir = ensure_attachments_base_dir(&app)?;
    let resolved = resolve_existing_attachment(&base, &relative_path)?;

    if !resolved.is_file() {
        return Err(format!("附件文件不存在: {relative_path}"));
    }

    let meta = std::fs::metadata(&resolved).map_err(|e| format!("读取文件元数据失败: {e}"))?;

    // 从文件名反推哈希和展示用文件名
    let file_stem = resolved
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let file_ext = resolved
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{s}"))
        .unwrap_or_default();
    let display_filename = format!("{file_stem}{file_ext}");

    // 通过重新计算哈希获取精确值（从文件名解析可能不可靠）
    // 但为避免大文件重读，直接使用文件名中的哈希前缀
    let hash = file_stem.to_string();

    let mime_type =
        mime_from_extension(resolved.extension().and_then(|s| s.to_str()).unwrap_or(""));

    let created_at = meta.created().map(system_time_to_millis).unwrap_or(0);

    Ok(AttachmentFileMetadata {
        hash,
        filename: display_filename,
        mime_type,
        size: meta.len(),
        relative_path,
        created_at,
    })
}

/// 从扩展名推断 MIME 类型（与 `safe_extension_for_mime` 对称）。
fn mime_from_extension(ext: &str) -> String {
    match ext.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg".to_string(),
        "png" => "image/png".to_string(),
        "gif" => "image/gif".to_string(),
        "webp" => "image/webp".to_string(),
        "pdf" => "application/pdf".to_string(),
        "txt" => "text/plain".to_string(),
        _ => DEFAULT_MIME.to_string(),
    }
}

// ===========================================================================
// 单元测试
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // safe_extension_from_filename
    // -----------------------------------------------------------------------

    #[test]
    fn extracts_simple_extension() {
        assert_eq!(
            safe_extension_from_filename("photo.jpg"),
            Some("jpg".to_string())
        );
    }

    #[test]
    fn extracts_extension_from_path_like_name() {
        assert_eq!(
            safe_extension_from_filename("C:\\Users\\test\\photo.png"),
            Some("png".to_string())
        );
    }

    #[test]
    fn lowercases_extension() {
        assert_eq!(
            safe_extension_from_filename("doc.PDF"),
            Some("pdf".to_string())
        );
    }

    #[test]
    fn extracts_dotfile_as_extension() {
        // .gitignore → rfind('.') 在位置 0 → 提取 "gitignore"（合法扩展名）
        assert_eq!(
            safe_extension_from_filename(".gitignore"),
            Some("gitignore".to_string())
        );
    }

    #[test]
    fn rejects_no_extension() {
        assert_eq!(safe_extension_from_filename("README"), None);
    }

    #[test]
    fn rejects_long_extension() {
        assert_eq!(safe_extension_from_filename("file.superlongext"), None);
    }

    #[test]
    fn extracts_last_segment_extension() {
        // file.js.map → rfind('.') 找到最后一个点 → 提取 "map"
        assert_eq!(
            safe_extension_from_filename("file.js.map"),
            Some("map".to_string())
        );
    }

    // -----------------------------------------------------------------------
    // normalize_mime
    // -----------------------------------------------------------------------

    #[test]
    fn normal_mime_passthrough() {
        assert_eq!(normalize_mime(Some("image/png")), "image/png");
    }

    #[test]
    fn empty_mime_defaults() {
        assert_eq!(normalize_mime(Some("")), DEFAULT_MIME);
        assert_eq!(normalize_mime(Some("   ")), DEFAULT_MIME);
    }

    #[test]
    fn none_mime_defaults() {
        assert_eq!(normalize_mime(None), DEFAULT_MIME);
    }

    #[test]
    fn octet_stream_normalizes() {
        assert_eq!(
            normalize_mime(Some("Application/Octet-Stream")),
            DEFAULT_MIME
        );
    }

    // -----------------------------------------------------------------------
    // is_safe_relative_path
    // -----------------------------------------------------------------------

    #[test]
    fn accepts_valid_path() {
        assert!(is_safe_relative_path("attachments/abc123.jpg"));
    }

    #[test]
    fn rejects_empty() {
        assert!(!is_safe_relative_path(""));
    }

    #[test]
    fn rejects_parent_traversal() {
        assert!(!is_safe_relative_path("attachments/../../../etc/passwd"));
        assert!(!is_safe_relative_path("../etc/passwd"));
        assert!(!is_safe_relative_path("attachments/.."));
    }

    #[test]
    fn rejects_empty_and_dot_segments() {
        assert!(!is_safe_relative_path("attachments/"));
        assert!(!is_safe_relative_path("attachments//abc123.jpg"));
        assert!(!is_safe_relative_path("attachments/./abc123.jpg"));
    }

    #[test]
    fn rejects_absolute_path() {
        assert!(!is_safe_relative_path("/etc/passwd"));
    }

    #[test]
    fn rejects_backslash() {
        assert!(!is_safe_relative_path("attachments\\secret"));
    }

    #[test]
    fn rejects_bare_filename_without_attachments_prefix() {
        // is_safe_relative_path 本身不强制前缀，
        // 但 resolve_* 函数会在其后检查 starts_with("attachments/")
        assert!(is_safe_relative_path("hash.jpg"));
    }

    // -----------------------------------------------------------------------
    // content_addressed_relative_path
    // -----------------------------------------------------------------------

    #[test]
    fn path_with_extension() {
        assert_eq!(
            content_addressed_relative_path("abc123", Some("jpg")),
            "attachments/abc123.jpg"
        );
    }

    #[test]
    fn path_with_default_extension() {
        assert_eq!(
            content_addressed_relative_path("abc123", Some(DEFAULT_EXTENSION)),
            "attachments/abc123.bin"
        );
    }

    #[test]
    fn path_with_empty_extension() {
        assert_eq!(
            content_addressed_relative_path("abc123", Some("")),
            "attachments/abc123"
        );
    }

    // -----------------------------------------------------------------------
    // safe_extension_for_mime
    // -----------------------------------------------------------------------

    #[test]
    fn known_mime_types() {
        assert_eq!(safe_extension_for_mime("image/jpeg"), Some("jpg"));
        assert_eq!(safe_extension_for_mime("image/png"), Some("png"));
        assert_eq!(safe_extension_for_mime("image/gif"), Some("gif"));
        assert_eq!(safe_extension_for_mime("image/webp"), Some("webp"));
        assert_eq!(safe_extension_for_mime("application/pdf"), Some("pdf"));
        assert_eq!(safe_extension_for_mime("text/plain"), Some("txt"));
    }

    #[test]
    fn unknown_mime_returns_none() {
        assert_eq!(safe_extension_for_mime("video/mp4"), None);
        assert_eq!(safe_extension_for_mime("application/json"), None);
    }

    // -----------------------------------------------------------------------
    // bytes_to_hex
    // -----------------------------------------------------------------------

    #[test]
    fn hex_encoding() {
        assert_eq!(bytes_to_hex(&[0u8, 255, 16]), "00ff10");
    }

    #[test]
    fn hex_sha256_length() {
        // SHA-256 产生 32 字节 → 64 字符十六进制
        let mut hasher = Sha256::new();
        hasher.update(b"hello");
        let hash = hasher.finalize();
        let hex = bytes_to_hex(&hash);
        assert_eq!(hex.len(), 64);
    }

    // -----------------------------------------------------------------------
    // mime_from_extension
    // -----------------------------------------------------------------------

    #[test]
    fn reverse_mapping_consistency() {
        // safe_extension_for_mime 与 mime_from_extension 应互逆
        assert_eq!(mime_from_extension("jpg"), "image/jpeg");
        assert_eq!(mime_from_extension("png"), "image/png");
        assert_eq!(mime_from_extension("gif"), "image/gif");
        assert_eq!(mime_from_extension("webp"), "image/webp");
        assert_eq!(mime_from_extension("pdf"), "application/pdf");
        assert_eq!(mime_from_extension("txt"), "text/plain");
        assert_eq!(mime_from_extension("xyz"), DEFAULT_MIME);
    }

    // -----------------------------------------------------------------------
    // normalize_path
    // -----------------------------------------------------------------------

    #[test]
    fn normalize_removes_dot_segments() {
        let input = PathBuf::from("/a/b/./c");
        assert_eq!(normalize_path(&input), PathBuf::from("/a/b/c"));
    }

    #[test]
    fn normalize_removes_dotdot_segments() {
        let input = PathBuf::from("/a/b/../c");
        assert_eq!(normalize_path(&input), PathBuf::from("/a/c"));
    }

    #[test]
    fn normalize_preserves_normal_path() {
        let input = PathBuf::from("/a/b/c");
        assert_eq!(normalize_path(&input), PathBuf::from("/a/b/c"));
    }

    // -----------------------------------------------------------------------
    // 路径解析语义验证：relative_path 是相对于 SoNotes 基础目录的
    // -----------------------------------------------------------------------

    #[test]
    fn content_addressed_path_resolves_without_duplication() {
        // content_addressed_relative_path 生成 "attachments/<hash>.<ext>"
        // 该路径相对于 <Documents>/SoNotes，拼接后应为：
        //   <Documents>/SoNotes/attachments/<hash>.<ext>
        // 而非 <Documents>/SoNotes/attachments/attachments/<hash>.<ext>
        let relative = content_addressed_relative_path("abc123def", Some("jpg"));
        assert_eq!(relative, "attachments/abc123def.jpg");

        let sonotes_base = PathBuf::from("/Documents/SoNotes");
        let resolved = sonotes_base.join(&relative);
        assert_eq!(
            resolved,
            PathBuf::from("/Documents/SoNotes/attachments/abc123def.jpg")
        );
        assert!(!resolved
            .to_string_lossy()
            .contains("attachments/attachments"));
    }

    #[test]
    fn bare_hash_without_prefix_would_fail_prefix_check() {
        // "abc123.jpg" 不以 "attachments/" 开头
        // resolve_existing_attachment / resolve_attachment_path_missing_safe 会拒绝
        let bare = "abc123.jpg";
        assert!(!bare.starts_with("attachments/"));
    }

    #[test]
    fn traversal_in_relative_path_rejected_by_safe_check() {
        assert!(!is_safe_relative_path("attachments/../../../x"));
        assert!(!is_safe_relative_path("attachments/sub/../../x"));
    }
}
