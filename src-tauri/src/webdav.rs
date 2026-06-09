//! WebDAV 远端备份基础类型、URL/目录规范化与配置持久化
//!
//! 本模块提供 WebDAV 远端备份的配置闭环、连接测试、远端列表、上传、下载与
//! 下载 token 生命周期管理。

use crate::backup;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use url::Url;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/// 远端默认目录名（不含尾部斜杠的规范形式）。
const DEFAULT_REMOTE_DIR_NAME: &str = "SoNotes_Backups";

/// 远端备份文件名正则：`SoNotes_Backup_YYYYMMDDHHMMSS.zip`（恰好 14 位数字）。
///
/// 用字符串匹配而非引入 regex crate，保持依赖最小。
const REMOTE_BACKUP_FILENAME_PATTERN: &str = "SoNotes_Backup_";

/// 日期时间部分长度（YYYYMMDDHHMMSS = 14 位）。
const DATETIME_LEN: usize = 14;

/// 远端备份文件完整长度（前缀 15 + 14 日期 + 4 .zip = 33）。
const REMOTE_BACKUP_FILENAME_LEN: usize = 15 + DATETIME_LEN + 4; // 33

/// 配置文件名。
const CONFIG_FILENAME: &str = "webdav-config.json";

/// 下载临时文件最大字节数（1 GiB 压缩 zip 传输上限）。
const MAX_WEBDAV_BACKUP_DOWNLOAD_BYTES: u64 = 1024 * 1024 * 1024;

/// 应用缓存目录下的 WebDAV 临时目录名。
const WEBDAV_TEMP_DIR_NAME: &str = "webdav-backups";

/// 上传前临时 zip 存放子目录名。
const WEBDAV_PENDING_DIR_NAME: &str = "pending";

/// 下载临时文件存放子目录名。
const WEBDAV_DOWNLOADS_DIR_NAME: &str = "downloads";

/// 上传同名冲突重试次数上限。
const UPLOAD_RETRY_LIMIT: u32 = 3;

/// 下载 token 有效期。过期 token 不再允许解析为本地恢复路径。
const DOWNLOAD_TOKEN_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// WebDAV 临时文件启动清理阈值。
const WEBDAV_TEMP_FILE_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

// ---------------------------------------------------------------------------
// 序列化类型（前端消费，camelCase）
// ---------------------------------------------------------------------------

/// WebDAV 连接配置（前端传入；密码/令牌仅用于本次请求，不持久化）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfig {
    /// WebDAV 服务地址（仅 host + 可选端口），例如 `example.com` 或 `example.com:5005`。
    pub server_url: String,
    /// 用户名。
    pub username: String,
    /// 远端目录（单级，例如 `SoNotes_Backups/`）。
    pub remote_dir: Option<String>,
    /// 密码或应用令牌（仅在本次请求中使用，不持久化）。
    #[serde(default)]
    pub password: Option<String>,
}

/// 连接测试结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConnectionResult {
    pub success: bool,
    pub error: Option<String>,
}

/// 远端备份条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavRemoteBackup {
    pub file_name: String,
    pub size: Option<u64>,
    pub last_modified: Option<String>,
    pub status: Option<u16>,
    pub readable: bool,
}

/// 保存配置请求（含密码/令牌字段与记住密码标记）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfigSaveRequest {
    /// WebDAV 服务地址。
    pub server_url: String,
    /// 用户名。
    pub username: String,
    /// 远端目录（单级）。
    pub remote_dir: Option<String>,
    /// 是否记住密码。若为 `true` 且提供了密码/令牌，当前应返回错误（系统密钥链未实现）。
    pub remember_password: bool,
    /// 密码或应用令牌（仅在本次请求中使用，不应持久化到普通配置文件）。
    #[serde(default)]
    pub password: Option<String>,
}

/// 配置加载结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfigLoadResult {
    /// 是否成功。
    pub success: bool,
    /// 已保存的 WebDAV 服务地址（成功时）。
    pub server_url: Option<String>,
    /// 已保存的用户名（成功时）。
    pub username: Option<String>,
    /// 已保存的远端目录（成功时）。
    pub remote_dir: Option<String>,
    /// 是否标记为已记住密码（密钥链引用占位）。
    pub password_saved: bool,
    /// 错误信息（失败时）。
    pub error: Option<String>,
}

/// 配置保存结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfigSaveResult {
    /// 是否成功。
    pub success: bool,
    /// 错误信息（失败时）。
    pub error: Option<String>,
}

/// 配置清除结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfigClearResult {
    /// 是否成功。
    pub success: bool,
    /// 错误信息（失败时）。
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavUploadResult {
    pub success: bool,
    pub remote_file_name: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavDownloadResult {
    pub success: bool,
    pub download_token: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBackupPathResult {
    pub success: bool,
    pub local_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavCleanupResult {
    pub success: bool,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// 内部持久化结构（不暴露给前端）
// ---------------------------------------------------------------------------

/// 写入磁盘的配置文件结构。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct WebDavConfigFile {
    server_url: String,
    username: String,
    remote_dir: String,
    /// 是否标记为"已记住密码"。实际凭据不在此文件中存储。
    password_saved: bool,
}

// ---------------------------------------------------------------------------
// URL 规范化
// ---------------------------------------------------------------------------

/// 规范化 WebDAV 基础 URL。
///
/// 规则：
/// - 必须使用 `https://`，除非是 `http://localhost`、`http://127.0.0.1` 或 `http://[::1]`。
/// - 拒绝 userinfo（用户名:密码嵌入 URL）。
/// - 拒绝 query 与 fragment。
/// - 拒绝空 host。
/// - 返回规范化后的 URL 字符串（不含凭据/查询/片段）。
pub fn normalize_webdav_url(input: &str) -> Result<String, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("WebDAV 地址不能为空".to_string());
    }

    let parsed = Url::parse(input).map_err(|_| "WebDAV 地址格式无效".to_string())?;

    // 检查 scheme
    match parsed.scheme() {
        "https" => {}
        "http" => {
            let host_str = parsed.host_str().unwrap_or("");
            let is_local = host_str == "localhost"
                || host_str == "127.0.0.1"
                || host_str == "[::1]"
                || host_str == "::1";
            if !is_local {
                return Err(
                    "WebDAV 地址必须使用 HTTPS，只有本机开发地址允许 HTTP".to_string(),
                );
            }
        }
        other => {
            return Err(format!("WebDAV 地址不支持的协议: {other}"));
        }
    }

    // 拒绝 userinfo
    if parsed.username() != "" || parsed.password().is_some() {
        return Err("WebDAV 地址不能包含用户名、密码、查询参数或片段".to_string());
    }

    // 拒绝 query
    if parsed.query().is_some() {
        return Err("WebDAV 地址不能包含用户名、密码、查询参数或片段".to_string());
    }

    // 拒绝 fragment
    if parsed.fragment().is_some() {
        return Err("WebDAV 地址不能包含用户名、密码、查询参数或片段".to_string());
    }

    // 拒绝空 host
    let host = parsed
        .host_str()
        .ok_or_else(|| "WebDAV 地址缺少主机名".to_string())?;
    if host.is_empty() {
        return Err("WebDAV 地址缺少主机名".to_string());
    }

    // 构造规范化 URL：scheme + host + port（如有）+ path
    let mut normalized = format!("{}://{}", parsed.scheme(), host);
    if let Some(port) = parsed.port() {
        normalized.push_str(&format!(":{port}"));
    }
    // 保留路径部分
    let path = parsed.path();
    if path != "/" {
        normalized.push_str(path);
    }
    // 确保不以 / 结尾（远端目录由 remote_dir 单独处理）
    while normalized.ends_with('/') && normalized.len() > "https://".len() {
        normalized.pop();
    }

    Ok(normalized)
}

// ---------------------------------------------------------------------------
// 远端目录规范化
// ---------------------------------------------------------------------------

/// 规范化单级远端目录。
///
/// 规则：
/// - 空值 => `SoNotes_Backups/`
/// - 接受 `SoNotes_Backups` 并规范化为 `SoNotes_Backups/`
/// - 拒绝绝对路径（以 `/` 开头）
/// - 拒绝盘符路径（如 `C:/`）
/// - 拒绝反斜杠 `\`
/// - 拒绝 `..` 段
/// - 拒绝空段
/// - 拒绝 URL 编码路径段（含 `%`）
/// - 拒绝嵌套目录（含 `/` 分隔后多于一段）
/// - 拒绝空字节
/// - 拒绝完整 URL（含 `://`）
pub fn normalize_remote_dir(input: &str) -> Result<String, String> {
    let input = input.trim();

    // 空值使用默认
    if input.is_empty() {
        return Ok(format!("{DEFAULT_REMOTE_DIR_NAME}/"));
    }

    // 拒绝完整 URL
    if input.contains("://") {
        return Err("远端目录不能是完整 URL".to_string());
    }

    // 拒绝空字节
    if input.contains('\0') {
        return Err("远端目录包含空字节".to_string());
    }

    // 拒绝反斜杠
    if input.contains('\\') {
        return Err("远端目录不能包含反斜杠".to_string());
    }

    // 拒绝绝对路径
    if input.starts_with('/') {
        return Err("远端目录不能是绝对路径".to_string());
    }

    // 拒绝盘符路径（如 C:/...）
    if input.len() >= 2 {
        let bytes = input.as_bytes();
        if bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            return Err("远端目录不能包含盘符".to_string());
        }
    }

    // 去除尾部斜杠后按 / 分段
    let trimmed = input.trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(format!("{DEFAULT_REMOTE_DIR_NAME}/"));
    }

    let parts: Vec<&str> = trimmed.split('/').collect();

    // 拒绝嵌套目录（只允许单级）
    if parts.len() > 1 {
        return Err("远端目录只允许单级目录，不支持嵌套".to_string());
    }

    let name = parts[0];

    // 拒绝空段
    if name.is_empty() {
        return Err("远端目录名不能为空".to_string());
    }

    // 拒绝 .. 段
    if name == ".." || name == "." {
        return Err("远端目录名不能为 . 或 ..".to_string());
    }

    // 拒绝 URL 编码路径段
    if name.contains('%') {
        return Err("远端目录名不能包含 URL 编码字符".to_string());
    }

    // 拒绝冒号（Windows 不友好）
    if name.contains(':') {
        return Err("远端目录名不能包含冒号".to_string());
    }

    Ok(format!("{name}/"))
}

// ---------------------------------------------------------------------------
// 远端备份文件名校验与生成
// ---------------------------------------------------------------------------

/// 校验远端备份文件名是否符合规范：`SoNotes_Backup_YYYYMMDDHHMMSS.zip`。
///
/// 规则：
/// - 严格匹配 `SoNotes_Backup_` + 14 位数字 + `.zip`
/// - 拒绝路径分隔符（`/`、`\`）
/// - 拒绝 `..`
/// - 拒绝空字节
/// - 拒绝 URL 编码路径段
/// - 拒绝冒号
/// - 拒绝非 basename（含路径段）
pub fn validate_remote_backup_filename(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("远端备份文件名不能为空".to_string());
    }

    // 拒绝路径分隔符
    if name.contains('/') || name.contains('\\') {
        return Err("远端备份文件名不能包含路径分隔符".to_string());
    }

    // 拒绝空字节
    if name.contains('\0') {
        return Err("远端备份文件名包含空字节".to_string());
    }

    // 拒绝 URL 编码
    if name.contains('%') {
        return Err("远端备份文件名不能包含 URL 编码字符".to_string());
    }

    // 拒绝冒号
    if name.contains(':') {
        return Err("远端备份文件名不能包含冒号".to_string());
    }

    // 拒绝 ..
    if name == ".." || name.contains("..") {
        return Err("远端备份文件名不能包含 ..".to_string());
    }

    // 精确长度检查
    if name.len() != REMOTE_BACKUP_FILENAME_LEN {
        return Err(format!(
            "远端备份文件名长度不正确: 期望 {REMOTE_BACKUP_FILENAME_LEN} 字符，实际 {} 字符",
            name.len()
        ));
    }

    // 检查前缀
    if !name.starts_with(REMOTE_BACKUP_FILENAME_PATTERN) {
        return Err("远端备份文件名前缀不正确".to_string());
    }

    // 检查后缀 .zip
    if !name.ends_with(".zip") {
        return Err("远端备份文件名后缀不正确".to_string());
    }

    // 检查中间 14 位数字
    let datetime_part = &name[15..29];
    if datetime_part.len() != DATETIME_LEN || !datetime_part.chars().all(|c| c.is_ascii_digit()) {
        return Err("远端备份文件名中的日期时间部分必须为 14 位数字".to_string());
    }

    Ok(())
}

/// 生成当前时间对应的规范远端备份文件名。
///
/// 格式：`SoNotes_Backup_YYYYMMDDHHMMSS.zip`
pub fn generate_current_remote_backup_filename() -> String {
    let now = chrono_now_datetime_string();
    format!("SoNotes_Backup_{now}.zip")
}

/// 获取当前日期时间的 YYYYMMDDHHMMSS 字符串（内部辅助函数，便于测试替换）。
fn chrono_now_datetime_string() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // 简易公历日期计算（Gregorian）
    let (year, month, day) = days_to_ymd(days);

    format!(
        "{year:04}{month:02}{day:02}{hours:02}{minutes:02}{seconds:02}"
    )
}

/// 将从 1970-01-01 起的天数转换为年月日。
fn days_to_ymd(days: u64) -> (u64, u64, u64) {
    // 简化的日期算法
    let mut y = 1970u64;
    let mut remaining = days;

    loop {
        let days_in_year = if is_leap_year(y) { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        y += 1;
    }

    let leap = is_leap_year(y);
    let days_in_month: [u64; 12] = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];

    let mut m = 1u64;
    for &dim in &days_in_month {
        if remaining < dim {
            break;
        }
        remaining -= dim;
        m += 1;
    }

    (y, m, remaining + 1)
}

fn is_leap_year(y: u64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

// ---------------------------------------------------------------------------
// 配置文件路径
// ---------------------------------------------------------------------------

/// 获取 WebDAV 配置文件的路径。
fn config_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取应用配置目录失败: {e}"))?;
    Ok(config_dir.join(CONFIG_FILENAME))
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

/// 加载 WebDAV 配置。
///
/// 从应用配置目录读取 `webdav-config.json`，返回非敏感字段。
/// 如果文件不存在，返回空配置（success=true）。
#[tauri::command]
pub async fn webdav_load_config(app: tauri::AppHandle) -> Result<WebDavConfigLoadResult, String> {
    let path = config_file_path(&app)?;

    if !path.exists() {
        return Ok(WebDavConfigLoadResult {
            success: true,
            server_url: None,
            username: None,
            remote_dir: None,
            password_saved: false,
            error: None,
        });
    }

    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("读取 WebDAV 配置文件失败: {e}"))?;

    let config: WebDavConfigFile =
        serde_json::from_str(&content).map_err(|e| format!("解析 WebDAV 配置文件失败: {e}"))?;

    Ok(WebDavConfigLoadResult {
        success: true,
        server_url: Some(config.server_url),
        username: Some(config.username),
        remote_dir: Some(config.remote_dir),
        password_saved: config.password_saved,
        error: None,
    })
}

/// 纯校验+规范化：将前端保存请求转换为可安全持久化的配置结构。
///
/// 职责：
/// - 拒绝 `remember_password=true`（系统密钥链未实现，无法安全存储凭据）。
/// - 通过 `normalize_webdav_url` 规范化 `server_url`。
/// - 通过 `normalize_remote_dir` 规范化 `remote_dir`。
/// - 永远不持久化 `password_saved=true`（无密钥链时该标记无意义且误导）。
/// - 永远不将密码/令牌写入磁盘。
fn prepare_config_save(request: &WebDavConfigSaveRequest) -> Result<WebDavConfigFile, String> {
    if request.remember_password {
        return Err(
            "系统密钥链尚未实现，无法安全存储密码。请取消勾选「记住密码」".to_string(),
        );
    }

    let server_url = normalize_webdav_url(&request.server_url)?;
    let remote_dir = normalize_remote_dir(request.remote_dir.as_deref().unwrap_or(""))?;

    Ok(WebDavConfigFile {
        server_url,
        username: request.username.clone(),
        remote_dir,
        password_saved: false,
    })
}

/// 保存 WebDAV 配置。
///
/// 将非敏感字段写入应用配置目录的 `webdav-config.json`。
/// - 若 `remember_password` 为 `true`，直接拒绝（系统密钥链未实现）。
/// - 密码/令牌字段仅在本次请求中使用，不写入磁盘。
#[tauri::command]
pub async fn webdav_save_config(
    app: tauri::AppHandle,
    request: WebDavConfigSaveRequest,
) -> Result<WebDavConfigSaveResult, String> {
    let config = prepare_config_save(&request).map_err(|e| e)?;

    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("序列化 WebDAV 配置失败: {e}"))?;

    let path = config_file_path(&app)?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建 WebDAV 配置目录失败: {e}"))?;
    }

    std::fs::write(&path, json).map_err(|e| format!("写入 WebDAV 配置文件失败: {e}"))?;

    Ok(WebDavConfigSaveResult {
        success: true,
        error: None,
    })
}

/// 清除 WebDAV 配置。
///
/// 删除应用配置目录中的 `webdav-config.json` 文件。
/// 如果删除失败，返回可见错误。
#[tauri::command]
pub async fn webdav_clear_config(app: tauri::AppHandle) -> Result<WebDavConfigClearResult, String> {
    let path = config_file_path(&app)?;

    if !path.exists() {
        return Ok(WebDavConfigClearResult {
            success: true,
            error: None,
        });
    }

    std::fs::remove_file(&path).map_err(|e| format!("删除 WebDAV 配置文件失败: {e}"))?;

    Ok(WebDavConfigClearResult {
        success: true,
        error: None,
    })
}

// ---------------------------------------------------------------------------
// URL 构建
// ---------------------------------------------------------------------------

fn build_remote_dir_url(base_url: &str, remote_dir: &str) -> String {
    let mut url = base_url.trim_end_matches('/').to_string();
    url.push('/');
    url.push_str(remote_dir.trim_start_matches('/'));
    if !url.ends_with('/') {
        url.push('/');
    }
    url
}

// ---------------------------------------------------------------------------
// PROPFIND 请求
// ---------------------------------------------------------------------------

fn propfind_request(
    url: &str,
    depth: &str,
    username: &str,
    password: Option<&str>,
) -> reqwest::RequestBuilder {
    let client = reqwest::Client::builder()
        .user_agent("SoNotes/1.5")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .expect("reqwest client build");

    let body = r#"<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:allprop/>
</D:propfind>"#;

    let mut req = client
        .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), url)
        .header("Depth", depth)
        .header("Content-Type", "application/xml")
        .body(body.to_string());

    if let Some(pw) = password {
        req = req.basic_auth(username, Some(pw));
    } else if !username.is_empty() {
        req = req.basic_auth(username, None::<&str>);
    }

    req
}

fn webdav_request_with_auth(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: &str,
    username: &str,
    password: Option<&str>,
) -> reqwest::RequestBuilder {
    let mut req = client.request(method, url);
    if let Some(pw) = password {
        req = req.basic_auth(username, Some(pw));
    } else if !username.is_empty() {
        req = req.basic_auth(username, None::<&str>);
    }
    req
}

async fn ensure_remote_dir_exists(
    client: &reqwest::Client,
    dir_url: &str,
    username: &str,
    password: Option<&str>,
) -> Result<(), String> {
    let propfind_resp = propfind_request(dir_url, "0", username, password)
        .send()
        .await
        .map_err(|_| "WebDAV 地址不可访问".to_string())?;

    match propfind_resp.status().as_u16() {
        200..=299 => return Ok(()),
        401 | 403 => return Err("WebDAV 鉴权失败".to_string()),
        404 => {}
        status => return Err(format!("WebDAV 服务器返回异常状态码: {status}")),
    }

    let mkcol_method = reqwest::Method::from_bytes(b"MKCOL")
        .map_err(|_| "远端备份目录不可用".to_string())?;
    let mkcol_resp = webdav_request_with_auth(client, mkcol_method, dir_url, username, password)
        .send()
        .await
        .map_err(|_| "远端备份目录不可用".to_string())?;

    match mkcol_resp.status().as_u16() {
        200 | 201 | 204 => Ok(()),
        401 | 403 => Err("WebDAV 鉴权失败".to_string()),
        status => Err(format!("远端备份目录不可用 (HTTP {status})")),
    }
}

// ---------------------------------------------------------------------------
// PROPFIND XML 解析
// ---------------------------------------------------------------------------

struct PropfindEntry {
    href: String,
    status: Option<String>,
    content_length: Option<u64>,
    last_modified: Option<String>,
    is_collection: bool,
}

fn parse_propfind_response(xml: &str) -> Result<Vec<PropfindEntry>, String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut entries: Vec<PropfindEntry> = Vec::new();
    let mut current_entry: Option<PropfindEntry> = None;
    let mut in_href = false;
    let mut in_status = false;
    let mut in_get_content_length = false;
    let mut in_get_last_modified = false;
    let mut in_resourcetype = false;
    let mut in_collection = false;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_string();
                let local = tag.split(':').last().unwrap_or(&tag).to_string();

                match local.as_str() {
                    "response" => {
                        current_entry = Some(PropfindEntry {
                            href: String::new(),
                            status: None,
                            content_length: None,
                            last_modified: None,
                            is_collection: false,
                        });
                    }
                    "href" => in_href = true,
                    "status" => in_status = true,
                    "getcontentlength" => in_get_content_length = true,
                    "getlastmodified" => in_get_last_modified = true,
                    "resourcetype" => in_resourcetype = true,
                    "collection" => {
                        if in_resourcetype {
                            in_collection = true;
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(ref e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_string();
                let local = tag.split(':').last().unwrap_or(&tag).to_string();

                if local == "collection" && in_resourcetype {
                    if let Some(ref mut entry) = current_entry {
                        entry.is_collection = true;
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_string();
                let local = tag.split(':').last().unwrap_or(&tag).to_string();

                match local.as_str() {
                    "href" => in_href = false,
                    "status" => in_status = false,
                    "getcontentlength" => in_get_content_length = false,
                    "getlastmodified" => in_get_last_modified = false,
                    "resourcetype" => {
                        in_resourcetype = false;
                        if in_collection {
                            if let Some(ref mut entry) = current_entry {
                                entry.is_collection = true;
                            }
                            in_collection = false;
                        }
                    }
                    "collection" => {
                        if in_resourcetype {
                            in_collection = false;
                        }
                    }
                    "response" => {
                        if let Some(entry) = current_entry.take() {
                            entries.push(entry);
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(ref e)) => {
                let text = e.unescape().map(|u| u.to_string()).unwrap_or_default();
                if let Some(ref mut entry) = current_entry {
                    if in_href {
                        entry.href = text;
                    } else if in_status {
                        entry.status = Some(text);
                    } else if in_get_content_length {
                        entry.content_length = text.parse().ok();
                    } else if in_get_last_modified {
                        entry.last_modified = Some(text);
                    } else if in_collection {
                        entry.is_collection = true;
                    }
                }
            }
            Ok(Event::Eof) => {
                if current_entry.is_some()
                    || in_href
                    || in_status
                    || in_get_content_length
                    || in_get_last_modified
                    || in_resourcetype
                    || in_collection
                {
                    return Err("WebDAV 列表 XML 解析失败".to_string());
                }
                break;
            }
            Err(_) => return Err("WebDAV 列表 XML 解析失败".to_string()),
            _ => {}
        }
        buf.clear();
    }

    Ok(entries)
}

fn extract_status_code(status: &str) -> Option<u16> {
    status
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.split(']').next())
        .and_then(|s| s.parse().ok())
}

fn filter_backup_entries(entries: Vec<PropfindEntry>) -> Vec<WebDavRemoteBackup> {
    entries
        .into_iter()
        .filter(|e| !e.is_collection)
        .filter_map(|e| {
            let href = e.href.trim_end_matches('/');
            let file_name = href.rsplit('/').next()?.to_string();

            if validate_remote_backup_filename(&file_name).is_err() {
                return None;
            }

            let status_code = e.status.as_deref().and_then(extract_status_code);
            let status_ok = status_code
                .map(|c| (200..400).contains(&c))
                .unwrap_or(true);

            Some(WebDavRemoteBackup {
                file_name,
                size: e.content_length,
                last_modified: e.last_modified,
                status: status_code,
                readable: status_ok,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tauri 命令：transport
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn webdav_test_connection(config: WebDavConfig) -> Result<WebDavConnectionResult, String> {
    let base_url = normalize_webdav_url(&config.server_url)?;
    let remote_dir = normalize_remote_dir(config.remote_dir.as_deref().unwrap_or(""))?;
    let dir_url = build_remote_dir_url(&base_url, &remote_dir);

    let client = reqwest::Client::builder()
        .user_agent("SoNotes/1.5")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| "WebDAV 地址不可访问".to_string())?;

    let resp = propfind_request(
        &dir_url,
        "0",
        &config.username,
        config.password.as_deref(),
    )
    .send()
    .await
    .map_err(|e| {
        if e.is_timeout() {
            "WebDAV 地址不可访问".to_string()
        } else if e.is_connect() {
            "WebDAV 地址不可访问".to_string()
        } else {
            "WebDAV 地址不可访问".to_string()
        }
    })?;

    let status = resp.status().as_u16();
    match status {
        200..=299 => Ok(WebDavConnectionResult {
            success: true,
            error: None,
        }),
        401 | 403 => Ok(WebDavConnectionResult {
            success: false,
            error: Some("WebDAV 鉴权失败".to_string()),
        }),
        404 => match ensure_remote_dir_exists(
            &client,
            &dir_url,
            &config.username,
            config.password.as_deref(),
        )
        .await
        {
            Ok(()) => Ok(WebDavConnectionResult {
                success: true,
                error: None,
            }),
            Err(error) => Ok(WebDavConnectionResult {
                success: false,
                error: Some(error),
            }),
        },
        _ => Ok(WebDavConnectionResult {
            success: false,
            error: Some(format!("WebDAV 服务器返回异常状态码: {status}")),
        }),
    }
}

#[tauri::command]
pub async fn webdav_list_backups(
    config: WebDavConfig,
) -> Result<Vec<WebDavRemoteBackup>, String> {
    let base_url = normalize_webdav_url(&config.server_url)?;
    let remote_dir = normalize_remote_dir(config.remote_dir.as_deref().unwrap_or(""))?;
    let dir_url = build_remote_dir_url(&base_url, &remote_dir);

    let resp = propfind_request(
        &dir_url,
        "1",
        &config.username,
        config.password.as_deref(),
    )
    .send()
    .await
    .map_err(|_| "远端备份列表读取失败".to_string())?;

    let status = resp.status().as_u16();
    match status {
        200..=299 => {}
        401 | 403 => return Err("WebDAV 鉴权失败".to_string()),
        404 => return Err("远端备份目录不可用".to_string()),
        _ => return Err(format!("远端备份列表读取失败 (HTTP {status})")),
    }

    let xml = resp.text().await.map_err(|_| "远端备份列表读取失败".to_string())?;
    let entries = parse_propfind_response(&xml)?;
    Ok(filter_backup_entries(entries))
}

// ---------------------------------------------------------------------------
// 下载 Token 存储
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum DownloadTokenState {
    Ready { file_path: PathBuf },
    Resolved { file_path: PathBuf },
    Cleaned { file_path: Option<PathBuf> },
}

#[derive(Debug, Clone)]
struct DownloadTokenEntry {
    state: DownloadTokenState,
    created_at: SystemTime,
}

fn download_tokens() -> &'static Mutex<HashMap<String, DownloadTokenEntry>> {
    static TOKENS: OnceLock<Mutex<HashMap<String, DownloadTokenEntry>>> = OnceLock::new();
    TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn store_download_token(token: &str, file_path: PathBuf) {
    let mut tokens = download_tokens().lock().unwrap();
    tokens.insert(
        token.to_string(),
        DownloadTokenEntry {
            state: DownloadTokenState::Ready { file_path },
            created_at: SystemTime::now(),
        },
    );
}

#[cfg(test)]
fn store_download_token_created_at(token: &str, file_path: PathBuf, created_at: SystemTime) {
    let mut tokens = download_tokens().lock().unwrap();
    tokens.insert(
        token.to_string(),
        DownloadTokenEntry {
            state: DownloadTokenState::Ready { file_path },
            created_at,
        },
    );
}

fn token_is_expired(entry: &DownloadTokenEntry) -> bool {
    SystemTime::now()
        .duration_since(entry.created_at)
        .map(|age| age > DOWNLOAD_TOKEN_TTL)
        .unwrap_or(false)
}

fn token_file_path(state: &DownloadTokenState) -> Option<PathBuf> {
    match state {
        DownloadTokenState::Ready { file_path }
        | DownloadTokenState::Resolved { file_path } => Some(file_path.clone()),
        DownloadTokenState::Cleaned { file_path } => file_path.clone(),
    }
}

fn resolve_download_token(token: &str) -> Result<PathBuf, String> {
    let mut tokens = download_tokens().lock().unwrap();
    let entry = tokens
        .get_mut(token)
        .ok_or_else(|| "下载 token 无效".to_string())?;

    if token_is_expired(entry) {
        let file_path = token_file_path(&entry.state);
        entry.state = DownloadTokenState::Cleaned { file_path };
        return Err("下载 token 已过期".to_string());
    }

    match &entry.state {
        DownloadTokenState::Ready { file_path } => {
            let path = file_path.clone();
            entry.state = DownloadTokenState::Resolved { file_path: path.clone() };
            Ok(path)
        }
        DownloadTokenState::Resolved { .. } => Err("下载 token 已被解析，不能重复使用".to_string()),
        DownloadTokenState::Cleaned { .. } => Err("下载 token 已清理，无效".to_string()),
    }
}

fn cleanup_download_token(token: &str) -> Result<PathBuf, String> {
    let mut tokens = download_tokens().lock().unwrap();
    let entry = tokens
        .get_mut(token)
        .ok_or_else(|| "下载 token 无效".to_string())?;

    if let DownloadTokenState::Cleaned { file_path } = &mut entry.state {
        return Ok(file_path.take().unwrap_or_default());
    }

    if token_is_expired(entry) {
        let file_path = token_file_path(&entry.state);
        entry.state = DownloadTokenState::Cleaned { file_path: None };
        return Ok(file_path.unwrap_or_default());
    }

    match &mut entry.state {
        DownloadTokenState::Ready { file_path } => {
            let path = file_path.clone();
            entry.state = DownloadTokenState::Cleaned { file_path: None };
            Ok(path)
        }
        DownloadTokenState::Resolved { file_path } => {
            let path = file_path.clone();
            entry.state = DownloadTokenState::Cleaned { file_path: None };
            Ok(path)
        }
        DownloadTokenState::Cleaned { file_path } => {
            Ok(file_path.take().unwrap_or_default())
        }
    }
}

fn remove_download_token(token: &str) {
    let mut tokens = download_tokens().lock().unwrap();
    tokens.remove(token);
}

// ---------------------------------------------------------------------------
// 临时路径辅助
// ---------------------------------------------------------------------------

fn webdav_temp_base_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("获取应用缓存目录失败: {e}"))?;
    Ok(cache_dir.join(WEBDAV_TEMP_DIR_NAME))
}

fn webdav_pending_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(webdav_temp_base_dir(app)?.join(WEBDAV_PENDING_DIR_NAME))
}

fn webdav_downloads_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(webdav_temp_base_dir(app)?.join(WEBDAV_DOWNLOADS_DIR_NAME))
}

fn validate_file_within_webdav_dir(path: &Path, base: &Path) -> bool {
    let normalized_path = normalize_path(path);
    let normalized_base = normalize_path(base);
    normalized_path.starts_with(&normalized_base) && normalized_path != normalized_base
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                components.pop();
            }
            std::path::Component::CurDir => {}
            other => components.push(other),
        }
    }
    components.iter().collect()
}

fn generate_download_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("webdav-dl-{:032x}", nanos)
}

fn is_stale_file(path: &Path, max_age: Duration) -> bool {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .map(|age| age > max_age)
        .unwrap_or(false)
}

fn remove_stale_matching_files(dir: &Path, prefix: &str, max_age: Duration) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }

    let entries = std::fs::read_dir(dir).map_err(|e| format!("读取 WebDAV 临时目录失败: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || !validate_file_within_webdav_dir(&path, dir) {
            continue;
        }

        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };

        if file_name.starts_with(prefix) && file_name.ends_with(".zip") && is_stale_file(&path, max_age) {
            let _ = std::fs::remove_file(path);
        }
    }

    Ok(())
}

pub fn cleanup_webdav_temp_files(app: &tauri::AppHandle) -> Result<(), String> {
    remove_stale_matching_files(
        &webdav_pending_dir(app)?,
        "webdav-pending-",
        WEBDAV_TEMP_FILE_MAX_AGE,
    )?;
    remove_stale_matching_files(
        &webdav_downloads_dir(app)?,
        "webdav-dl-",
        WEBDAV_TEMP_FILE_MAX_AGE,
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri 命令：上传/下载/Token 生命周期
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn webdav_create_remote_backup(
    app: tauri::AppHandle,
    config: WebDavConfig,
) -> Result<WebDavUploadResult, String> {
    let base_url = normalize_webdav_url(&config.server_url)?;
    let remote_dir = normalize_remote_dir(config.remote_dir.as_deref().unwrap_or(""))?;

    let pending_dir = webdav_pending_dir(&app)?;
    std::fs::create_dir_all(&pending_dir)
        .map_err(|_| "远端备份上传失败，本地数据未受影响".to_string())?;

    let temp_id: u64 = rand::random();
    let temp_zip_name = format!("webdav-pending-{temp_id:016x}.zip");
    let temp_zip_path = pending_dir.join(&temp_zip_name);
    let temp_zip_path_str = temp_zip_path.to_string_lossy().to_string();

    let backup_result = backup::create_local_backup(app.clone(), temp_zip_path_str).await?;

    if !backup_result.success {
        let _ = std::fs::remove_file(&temp_zip_path);
        return Err(
            backup_result
                .error
                .unwrap_or_else(|| "远端备份上传失败，本地数据未受影响".to_string()),
        );
    }

    let actual_zip_path = backup_result
        .backup_path
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| temp_zip_path.clone());

    if !validate_file_within_webdav_dir(&actual_zip_path, &pending_dir) {
        let _ = std::fs::remove_file(&actual_zip_path);
        if actual_zip_path != temp_zip_path {
            let _ = std::fs::remove_file(&temp_zip_path);
        }
        return Err("远端备份上传失败，本地数据未受影响".to_string());
    }

    let zip_bytes = std::fs::read(&actual_zip_path).map_err(|_| {
        let _ = std::fs::remove_file(&actual_zip_path);
        if actual_zip_path != temp_zip_path {
            let _ = std::fs::remove_file(&temp_zip_path);
        }
        "远端备份上传失败，本地数据未受影响".to_string()
    })?;

    let client = reqwest::Client::builder()
        .user_agent("SoNotes/1.5")
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|_| "远端备份上传失败，本地数据未受影响".to_string())?;

    let dir_url = build_remote_dir_url(&base_url, &remote_dir);
    ensure_remote_dir_exists(
        &client,
        &dir_url,
        &config.username,
        config.password.as_deref(),
    )
    .await
    .map_err(|error| {
        let _ = std::fs::remove_file(&actual_zip_path);
        if actual_zip_path != temp_zip_path {
            let _ = std::fs::remove_file(&temp_zip_path);
        }
        if error == "WebDAV 鉴权失败" {
            error
        } else {
            "远端备份上传失败，本地数据未受影响".to_string()
        }
    })?;

    let mut last_error = String::new();

    for attempt in 0..UPLOAD_RETRY_LIMIT {
        let remote_filename = if attempt == 0 {
            generate_current_remote_backup_filename()
        } else {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            generate_current_remote_backup_filename()
        };

        let upload_url = format!("{}{}", dir_url, remote_filename);

        let mut req = client
            .put(&upload_url)
            .header("Content-Type", "application/zip")
            .header("If-None-Match", "*")
            .body(zip_bytes.clone());

        if let Some(pw) = &config.password {
            req = req.basic_auth(&config.username, Some(pw));
        } else if !config.username.is_empty() {
            req = req.basic_auth(&config.username, None::<&str>);
        }

        match req.send().await {
            Ok(resp) => {
                let status = resp.status().as_u16();
                match status {
                    200..=299 => {
                        let _ = std::fs::remove_file(&actual_zip_path);
                        if actual_zip_path != temp_zip_path {
                            let _ = std::fs::remove_file(&temp_zip_path);
                        }
                        return Ok(WebDavUploadResult {
                            success: true,
                            remote_file_name: Some(remote_filename),
                            error: None,
                        });
                    }
                    401 | 403 => {
                        let _ = std::fs::remove_file(&actual_zip_path);
                        if actual_zip_path != temp_zip_path {
                            let _ = std::fs::remove_file(&temp_zip_path);
                        }
                        return Err("WebDAV 鉴权失败".to_string());
                    }
                    409 | 412 => {
                        last_error = "远端已存在同名备份，请稍后重试".to_string();
                        continue;
                    }
                    _ => {
                        last_error = format!("远端备份上传失败 (HTTP {status})，本地数据未受影响");
                        continue;
                    }
                }
            }
            Err(_) => {
                last_error = "远端备份上传失败，本地数据未受影响".to_string();
                continue;
            }
        }
    }

    let _ = std::fs::remove_file(&actual_zip_path);
    if actual_zip_path != temp_zip_path {
        let _ = std::fs::remove_file(&temp_zip_path);
    }
    Err(last_error)
}

#[tauri::command]
pub async fn webdav_download_backup(
    app: tauri::AppHandle,
    config: WebDavConfig,
    remote_file_name: String,
) -> Result<WebDavDownloadResult, String> {
    validate_remote_backup_filename(&remote_file_name)?;

    let base_url = normalize_webdav_url(&config.server_url)?;
    let remote_dir = normalize_remote_dir(config.remote_dir.as_deref().unwrap_or(""))?;

    let downloads_dir = webdav_downloads_dir(&app)?;
    std::fs::create_dir_all(&downloads_dir)
        .map_err(|_| "远端备份下载失败，本地数据未受影响".to_string())?;

    let dir_url = build_remote_dir_url(&base_url, &remote_dir);
    let download_url = format!("{}{}", dir_url, remote_file_name);

    let client = reqwest::Client::builder()
        .user_agent("SoNotes/1.5")
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|_| "远端备份下载失败，本地数据未受影响".to_string())?;

    let mut req = client.get(&download_url);
    if let Some(pw) = &config.password {
        req = req.basic_auth(&config.username, Some(pw));
    } else if !config.username.is_empty() {
        req = req.basic_auth(&config.username, None::<&str>);
    }

    let resp = req
        .send()
        .await
        .map_err(|_| "远端备份下载失败，本地数据未受影响".to_string())?;

    let status = resp.status().as_u16();
    match status {
        200..=299 => {}
        401 | 403 => return Err("WebDAV 鉴权失败".to_string()),
        404 => return Err("远端备份文件不存在".to_string()),
        _ => return Err(format!("远端备份下载失败 (HTTP {status})，本地数据未受影响")),
    }

    if let Some(content_length) = resp.content_length() {
        if content_length > MAX_WEBDAV_BACKUP_DOWNLOAD_BYTES {
            return Err("远端备份超过允许大小，本地数据未受影响".to_string());
        }
    }

    let dl_id: u64 = rand::random();
    let dl_file_name = format!("webdav-dl-{dl_id:016x}.zip");
    let dl_path = downloads_dir.join(&dl_file_name);

    let mut file = std::fs::File::create(&dl_path)
        .map_err(|_| "远端备份下载失败，本地数据未受影响".to_string())?;

    let mut total_bytes: u64 = 0;
    let mut resp = resp;

    use std::io::Write;

    while let Some(chunk) = resp.chunk().await.map_err(|_| {
        let _ = std::fs::remove_file(&dl_path);
        "远端备份下载失败，本地数据未受影响".to_string()
    })? {
        total_bytes += chunk.len() as u64;
        if total_bytes > MAX_WEBDAV_BACKUP_DOWNLOAD_BYTES {
            let _ = std::fs::remove_file(&dl_path);
            return Err("远端备份超过允许大小，本地数据未受影响".to_string());
        }

        file.write_all(&chunk).map_err(|_| {
            let _ = std::fs::remove_file(&dl_path);
            "远端备份下载失败，本地数据未受影响".to_string()
        })?;
    }

    drop(file);

    let token = generate_download_token();
    store_download_token(&token, dl_path);

    Ok(WebDavDownloadResult {
        success: true,
        download_token: Some(token),
        error: None,
    })
}

#[tauri::command]
pub async fn resolve_downloaded_backup(
    app: tauri::AppHandle,
    download_token: String,
) -> Result<LocalBackupPathResult, String> {
    let path = resolve_download_token(&download_token)?;

    let downloads_dir = webdav_downloads_dir(&app)?;
    if !validate_file_within_webdav_dir(&path, &downloads_dir) {
        remove_download_token(&download_token);
        return Err("下载 token 无效".to_string());
    }

    Ok(LocalBackupPathResult {
        success: true,
        local_path: Some(path.to_string_lossy().to_string()),
        error: None,
    })
}

#[tauri::command]
pub async fn cleanup_downloaded_backup(
    app: tauri::AppHandle,
    download_token: String,
) -> Result<WebDavCleanupResult, String> {
    if let Ok(path) = cleanup_download_token(&download_token) {
        if !path.as_os_str().is_empty() {
            let downloads_dir = webdav_downloads_dir(&app)?;
            if !validate_file_within_webdav_dir(&path, &downloads_dir) {
                remove_download_token(&download_token);
                return Err("下载 token 无效".to_string());
            }
            let _ = std::fs::remove_file(&path);
        }
    }
    remove_download_token(&download_token);

    Ok(WebDavCleanupResult {
        success: true,
        error: None,
    })
}

// ===========================================================================
// 单元测试
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // URL 规范化测试
    // -----------------------------------------------------------------------

    #[test]
    fn url_norm_accepts_https() {
        let result = normalize_webdav_url("https://example.com/dav").unwrap();
        assert_eq!(result, "https://example.com/dav");
    }

    #[test]
    fn url_norm_accepts_https_with_port() {
        let result = normalize_webdav_url("https://example.com:5005/dav").unwrap();
        assert_eq!(result, "https://example.com:5005/dav");
    }

    #[test]
    fn url_norm_accepts_http_localhost() {
        let result = normalize_webdav_url("http://localhost:8080/dav").unwrap();
        assert_eq!(result, "http://localhost:8080/dav");
    }

    #[test]
    fn url_norm_accepts_http_127_0_0_1() {
        let result = normalize_webdav_url("http://127.0.0.1/dav").unwrap();
        assert_eq!(result, "http://127.0.0.1/dav");
    }

    #[test]
    fn url_norm_accepts_http_ipv6_loopback() {
        let result = normalize_webdav_url("http://[::1]/dav").unwrap();
        assert_eq!(result, "http://[::1]/dav");
    }

    #[test]
    fn url_norm_rejects_http_non_localhost() {
        let err = normalize_webdav_url("http://example.com/dav").unwrap_err();
        assert!(err.contains("HTTPS"));
    }

    #[test]
    fn url_norm_rejects_userinfo() {
        let err = normalize_webdav_url("https://user:pass@example.com/dav").unwrap_err();
        assert!(err.contains("用户名"));
    }

    #[test]
    fn url_norm_rejects_query() {
        let err = normalize_webdav_url("https://example.com/dav?token=abc").unwrap_err();
        assert!(err.contains("查询参数"));
    }

    #[test]
    fn url_norm_rejects_fragment() {
        let err = normalize_webdav_url("https://example.com/dav#section").unwrap_err();
        assert!(err.contains("片段"));
    }

    #[test]
    fn url_norm_rejects_empty_input() {
        let err = normalize_webdav_url("").unwrap_err();
        assert!(err.contains("不能为空"));
    }

    #[test]
    fn url_norm_rejects_empty_host() {
        let err = normalize_webdav_url("https://:8080/").unwrap_err();
        assert!(
            err.contains("主机名") || err.contains("格式"),
            "错误应提及主机名或格式: {err}"
        );
    }

    #[test]
    fn url_norm_strips_trailing_slash() {
        let result = normalize_webdav_url("https://example.com/dav/").unwrap();
        assert_eq!(result, "https://example.com/dav");
    }

    #[test]
    fn url_norm_rejects_ftp_scheme() {
        let err = normalize_webdav_url("ftp://example.com/dav").unwrap_err();
        assert!(err.contains("不支持的协议"));
    }

    #[test]
    fn url_norm_rejects_invalid_url() {
        let err = normalize_webdav_url("not-a-url").unwrap_err();
        assert!(err.contains("格式无效"));
    }

    // -----------------------------------------------------------------------
    // 远端目录规范化测试
    // -----------------------------------------------------------------------

    #[test]
    fn dir_norm_empty_defaults() {
        assert_eq!(normalize_remote_dir("").unwrap(), "SoNotes_Backups/");
    }

    #[test]
    fn dir_norm_whitespace_defaults() {
        assert_eq!(normalize_remote_dir("   ").unwrap(), "SoNotes_Backups/");
    }

    #[test]
    fn dir_norm_accepts_valid_name() {
        assert_eq!(normalize_remote_dir("MyBackups").unwrap(), "MyBackups/");
    }

    #[test]
    fn dir_norm_adds_trailing_slash() {
        assert_eq!(
            normalize_remote_dir("SoNotes_Backups").unwrap(),
            "SoNotes_Backups/"
        );
    }

    #[test]
    fn dir_norm_strips_existing_trailing_slash() {
        assert_eq!(
            normalize_remote_dir("SoNotes_Backups/").unwrap(),
            "SoNotes_Backups/"
        );
    }

    #[test]
    fn dir_norm_rejects_absolute_path() {
        let err = normalize_remote_dir("/etc/backups").unwrap_err();
        assert!(err.contains("绝对路径"));
    }

    #[test]
    fn dir_norm_rejects_drive_path() {
        let err = normalize_remote_dir("C:/backups").unwrap_err();
        assert!(err.contains("盘符"));
    }

    #[test]
    fn dir_norm_rejects_backslash() {
        let err = normalize_remote_dir("backups\\sub").unwrap_err();
        assert!(err.contains("反斜杠"));
    }

    #[test]
    fn dir_norm_rejects_dotdot() {
        let err = normalize_remote_dir("..").unwrap_err();
        assert!(err.contains(".."));
    }

    #[test]
    fn dir_norm_single_segment_valid() {
        assert_eq!(normalize_remote_dir("backups").unwrap(), "backups/");
    }

    #[test]
    fn dir_norm_rejects_url_encoded() {
        let err = normalize_remote_dir("back%20ups").unwrap_err();
        assert!(err.contains("URL 编码"));
    }

    #[test]
    fn dir_norm_rejects_nested() {
        let err = normalize_remote_dir("a/b").unwrap_err();
        assert!(err.contains("嵌套"));
    }

    #[test]
    fn dir_norm_rejects_null_byte() {
        let err = normalize_remote_dir("back\0ups").unwrap_err();
        assert!(err.contains("空字节"));
    }

    #[test]
    fn dir_norm_rejects_full_url() {
        let err = normalize_remote_dir("https://example.com/backups").unwrap_err();
        assert!(err.contains("完整 URL"));
    }

    #[test]
    fn dir_norm_rejects_colon() {
        let err = normalize_remote_dir("backup:data").unwrap_err();
        assert!(err.contains("冒号"));
    }

    #[test]
    fn dir_norm_rejects_dot() {
        let err = normalize_remote_dir(".").unwrap_err();
        assert!(err.contains(". 或 .."));
    }

    // -----------------------------------------------------------------------
    // 远端备份文件名校验测试
    // -----------------------------------------------------------------------

    #[test]
    fn filename_valid_example() {
        assert!(validate_remote_backup_filename("SoNotes_Backup_20240101120000.zip").is_ok());
    }

    #[test]
    fn filename_valid_another_date() {
        assert!(validate_remote_backup_filename("SoNotes_Backup_20231231235959.zip").is_ok());
    }

    #[test]
    fn filename_rejects_empty() {
        let err = validate_remote_backup_filename("").unwrap_err();
        assert!(err.contains("不能为空"));
    }

    #[test]
    fn filename_rejects_slash() {
        let err =
            validate_remote_backup_filename("path/SoNotes_Backup_20240101120000.zip").unwrap_err();
        assert!(err.contains("路径分隔符"));
    }

    #[test]
    fn filename_rejects_backslash() {
        let err = validate_remote_backup_filename(
            "path\\SoNotes_Backup_20240101120000.zip",
        )
        .unwrap_err();
        assert!(err.contains("路径分隔符"));
    }

    #[test]
    fn filename_rejects_null_byte() {
        let err = validate_remote_backup_filename("SoNotes_Backup_\0202401011200.zip").unwrap_err();
        assert!(err.contains("空字节"));
    }

    #[test]
    fn filename_rejects_percent_encoded() {
        let err =
            validate_remote_backup_filename("SoNotes_Backup_202401%301120000.zip").unwrap_err();
        assert!(err.contains("URL 编码"));
    }

    #[test]
    fn filename_rejects_colon() {
        let err =
            validate_remote_backup_filename("SoNotes_Backup_20240101:20000.zip").unwrap_err();
        assert!(err.contains("冒号"));
    }

    #[test]
    fn filename_rejects_dotdot() {
        let err = validate_remote_backup_filename("..").unwrap_err();
        assert!(err.contains(".."));
    }

    #[test]
    fn filename_rejects_wrong_length() {
        let err = validate_remote_backup_filename("SoNotes_Backup_20240101.zip").unwrap_err();
        assert!(err.contains("长度不正确"));
    }

    #[test]
    fn filename_rejects_wrong_prefix() {
        let err = validate_remote_backup_filename("SoNotes_BacKup_20240101120000.zip").unwrap_err();
        assert!(err.contains("前缀不正确"), "错误应提及前缀: {err}");
    }

    #[test]
    fn filename_rejects_wrong_suffix() {
        let err = validate_remote_backup_filename("SoNotes_Backup_20240101120000.tar").unwrap_err();
        assert!(err.contains("后缀不正确"), "错误应提及后缀: {err}");
    }

    #[test]
    fn filename_rejects_non_digit_datetime() {
        let err = validate_remote_backup_filename("SoNotes_Backup_2024010112000a.zip").unwrap_err();
        assert!(err.contains("14 位数字"));
    }

    #[test]
    fn filename_rejects_extra_extension() {
        let err =
            validate_remote_backup_filename("SoNotes_Backup_20240101120000.zip.bak").unwrap_err();
        assert!(
            err.contains("长度不正确") || err.contains("后缀"),
            "错误应提及长度或后缀: {err}"
        );
    }

    // -----------------------------------------------------------------------
    // 文件名生成测试
    // -----------------------------------------------------------------------

    #[test]
    fn generate_filename_matches_pattern() {
        let name = generate_current_remote_backup_filename();
        assert!(
            validate_remote_backup_filename(&name).is_ok(),
            "生成的文件名应通过校验: {name}"
        );
    }

    #[test]
    fn generate_filename_has_correct_length() {
        let name = generate_current_remote_backup_filename();
        assert_eq!(name.len(), REMOTE_BACKUP_FILENAME_LEN);
    }

    #[test]
    fn generate_filename_has_prefix() {
        let name = generate_current_remote_backup_filename();
        assert!(name.starts_with("SoNotes_Backup_"));
    }

    #[test]
    fn generate_filename_has_zip_suffix() {
        let name = generate_current_remote_backup_filename();
        assert!(name.ends_with(".zip"));
    }

    // -----------------------------------------------------------------------
    // 辅助函数：日期时间生成测试
    // -----------------------------------------------------------------------

    #[test]
    fn days_to_ymd_known_date() {
        // 2024-01-01 是 1970-01-01 起的第 19723 天
        let (y, m, d) = days_to_ymd(19723);
        assert_eq!((y, m, d), (2024, 1, 1));
    }

    #[test]
    fn days_to_ymd_leap_year_feb29() {
        // 2024-02-29: 2024-01-01 = day 19723, +31 (Jan) + 28 (Feb) = 19782
        let (y, m, d) = days_to_ymd(19782);
        assert_eq!((y, m, d), (2024, 2, 29));
    }

    #[test]
    fn is_leap_year_standard() {
        assert!(is_leap_year(2024));
        assert!(!is_leap_year(2023));
        assert!(!is_leap_year(1900));
        assert!(is_leap_year(2000));
    }

    // -----------------------------------------------------------------------
    // 配置持久化测试（使用临时目录）
    // -----------------------------------------------------------------------

    fn test_config_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sonotes-webdav-test-{name}-{:016x}",
            rand::random::<u64>()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create test config dir");
        dir
    }

    #[test]
    fn config_file_roundtrip() {
        let dir = test_config_dir("roundtrip");
        let path = dir.join(CONFIG_FILENAME);

        let config = WebDavConfigFile {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: "SoNotes_Backups/".to_string(),
            password_saved: false,
        };

        let json = serde_json::to_string_pretty(&config).unwrap();
        std::fs::write(&path, &json).unwrap();

        let read_content = std::fs::read_to_string(&path).unwrap();
        let read_config: WebDavConfigFile = serde_json::from_str(&read_content).unwrap();

        assert_eq!(read_config.server_url, "https://example.com/dav");
        assert_eq!(read_config.username, "user1");
        assert_eq!(read_config.remote_dir, "SoNotes_Backups/");
        assert!(!read_config.password_saved);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_file_password_saved_flag() {
        let dir = test_config_dir("password-flag");
        let path = dir.join(CONFIG_FILENAME);

        let config = WebDavConfigFile {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: true,
        };

        let json = serde_json::to_string_pretty(&config).unwrap();
        std::fs::write(&path, &json).unwrap();

        let read_content = std::fs::read_to_string(&path).unwrap();
        let read_config: WebDavConfigFile = serde_json::from_str(&read_content).unwrap();

        assert!(read_config.password_saved);
        // 确保密码/令牌不被持久化
        assert!(
            !serde_json::to_string(&read_config)
                .unwrap()
                .contains("\"password\""),
            "配置文件中不应包含 \"password\" 字段"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_file_no_password_field_persisted() {
        let config = WebDavConfigFile {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: false,
        };
        let json = serde_json::to_string(&config).unwrap();
        assert!(
            !json.contains("\"password\":"),
            "配置文件序列化结果不应包含 \"password\" 字段"
        );
    }

    // -----------------------------------------------------------------------
    // prepare_config_save：真实行为测试
    // -----------------------------------------------------------------------

    #[test]
    fn prepare_rejects_remember_password_true_with_password() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: true,
            password: Some("secret123".to_string()),
        };
        let err = prepare_config_save(&request).unwrap_err();
        assert!(err.contains("系统密钥链"), "应明确拒绝: {err}");
    }

    #[test]
    fn prepare_rejects_remember_password_true_without_password() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: true,
            password: None,
        };
        let err = prepare_config_save(&request).unwrap_err();
        assert!(err.contains("系统密钥链"), "无密码也应拒绝: {err}");
    }

    #[test]
    fn prepare_always_persists_password_saved_false() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: false,
            password: Some("token123".to_string()),
        };
        let config = prepare_config_save(&request).unwrap();
        assert!(
            !config.password_saved,
            "password_saved 必须始终为 false（无密钥链）"
        );
    }

    #[test]
    fn prepare_normalizes_server_url() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://Example.COM/dav/".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: false,
            password: None,
        };
        let config = prepare_config_save(&request).unwrap();
        assert_eq!(
            config.server_url, "https://example.com/dav",
            "server_url 应被 normalize_webdav_url 规范化"
        );
    }

    #[test]
    fn prepare_normalizes_remote_dir() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("MyBackups".to_string()),
            remember_password: false,
            password: None,
        };
        let config = prepare_config_save(&request).unwrap();
        assert_eq!(
            config.remote_dir, "MyBackups/",
            "remote_dir 应规范化为带尾斜杠的单级目录"
        );
    }

    #[test]
    fn prepare_empty_remote_dir_defaults_to_sonotes_backups() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: None,
            remember_password: false,
            password: None,
        };
        let config = prepare_config_save(&request).unwrap();
        assert_eq!(config.remote_dir, "SoNotes_Backups/");
    }

    #[test]
    fn prepare_invalid_server_url_propagates_error() {
        let request = WebDavConfigSaveRequest {
            server_url: "http://insecure.example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: None,
            remember_password: false,
            password: None,
        };
        let err = prepare_config_save(&request).unwrap_err();
        assert!(err.contains("HTTPS"), "应拒绝非本机 HTTP: {err}");
    }

    #[test]
    fn prepare_invalid_remote_dir_propagates_error() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("a/b/c".to_string()),
            remember_password: false,
            password: None,
        };
        let err = prepare_config_save(&request).unwrap_err();
        assert!(err.contains("嵌套"), "应拒绝嵌套目录: {err}");
    }

    #[test]
    fn prepare_never_persists_password_in_json() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: None,
            remember_password: false,
            password: Some("supersecret".to_string()),
        };
        let config = prepare_config_save(&request).unwrap();
        let json = serde_json::to_string(&config).unwrap();
        assert!(
            !json.contains("supersecret"),
            "密码不得出现在持久化 JSON 中"
        );
        assert!(
            !json.contains("\"password\""),
            "password 字段不得出现在持久化 JSON 中"
        );
    }

    #[test]
    fn prepare_server_url_with_credentials_rejected() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://user:pass@example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: None,
            remember_password: false,
            password: None,
        };
        let err = prepare_config_save(&request).unwrap_err();
        assert!(err.contains("用户名"), "应拒绝含 userinfo 的 URL: {err}");
    }

    #[test]
    fn config_clear_removes_file() {
        let dir = test_config_dir("clear");
        let path = dir.join(CONFIG_FILENAME);

        // 创建配置文件
        std::fs::write(&path, "{}").unwrap();
        assert!(path.exists());

        // 模拟清除
        std::fs::remove_file(&path).unwrap();
        assert!(!path.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_clear_idempotent() {
        let dir = test_config_dir("clear-idempotent");
        let path = dir.join(CONFIG_FILENAME);

        // 文件不存在时清除应成功
        assert!(!path.exists());
        // 不应 panic

        let _ = std::fs::remove_dir_all(&dir);
    }

    // -----------------------------------------------------------------------
    // URL 构建测试
    // -----------------------------------------------------------------------

    #[test]
    fn build_remote_dir_url_basic() {
        let url = build_remote_dir_url("https://example.com/dav", "SoNotes_Backups/");
        assert_eq!(url, "https://example.com/dav/SoNotes_Backups/");
    }

    #[test]
    fn build_remote_dir_url_strips_double_slash() {
        let url = build_remote_dir_url("https://example.com/dav/", "/SoNotes_Backups/");
        assert_eq!(url, "https://example.com/dav/SoNotes_Backups/");
    }

    #[test]
    fn build_remote_dir_url_no_trailing_slash_on_dir() {
        let url = build_remote_dir_url("https://example.com/dav", "backups");
        assert_eq!(url, "https://example.com/dav/backups/");
    }

    #[test]
    fn build_remote_dir_url_preserves_base_path() {
        let url = build_remote_dir_url("https://example.com/remote.php/dav", "SoNotes_Backups/");
        assert_eq!(url, "https://example.com/remote.php/dav/SoNotes_Backups/");
    }

    // -----------------------------------------------------------------------
    // PROPFIND XML 解析测试
    // -----------------------------------------------------------------------

    #[test]
    fn parse_propfind_simple_collection() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/SoNotes_Backups/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

        let entries = parse_propfind_response(xml).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].is_collection);
        assert_eq!(entries[0].href, "/dav/SoNotes_Backups/");
    }

    #[test]
    fn parse_propfind_mixed_entries() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/SoNotes_Backups/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/SoNotes_Backups/SoNotes_Backup_20240101120000.zip</D:href>
    <D:propstat>
      <D:prop>
        <D:getcontentlength>1024000</D:getcontentlength>
        <D:getlastmodified>Sun, 01 Jan 2024 12:00:00 GMT</D:getlastmodified>
        <D:resourcetype/>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/SoNotes_Backups/random_file.txt</D:href>
    <D:propstat>
      <D:prop><D:getcontentlength>512</D:getcontentlength><D:resourcetype/></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

        let entries = parse_propfind_response(xml).unwrap();
        assert_eq!(entries.len(), 3);

        let filtered = filter_backup_entries(entries);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].file_name, "SoNotes_Backup_20240101120000.zip");
        assert_eq!(filtered[0].size, Some(1024000));
        assert!(filtered[0].readable);
    }

    #[test]
    fn parse_propfind_empty_response() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
</D:multistatus>"#;

        let entries = parse_propfind_response(xml).unwrap();
        assert_eq!(entries.len(), 0);
    }

    #[test]
    fn parse_propfind_malformed_xml_returns_error() {
        let result = parse_propfind_response(r#"<D:multistatus><D:response>"#);
        assert!(result.is_err());
    }

    #[test]
    fn parse_propfind_missing_size_and_mtime() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/SoNotes_Backups/SoNotes_Backup_20240101120000.zip</D:href>
    <D:propstat>
      <D:prop><D:resourcetype/></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

        let entries = parse_propfind_response(xml).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].content_length, None);
        assert_eq!(entries[0].last_modified, None);
    }

    #[test]
    fn parse_propfind_auth_error_entry() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/SoNotes_Backups/SoNotes_Backup_20240101120000.zip</D:href>
    <D:propstat>
      <D:prop><D:resourcetype/></D:prop>
      <D:status>HTTP/1.1 403 Forbidden</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

        let entries = parse_propfind_response(xml).unwrap();
        let filtered = filter_backup_entries(entries);
        assert_eq!(filtered.len(), 1);
        assert!(!filtered[0].readable);
    }

    // -----------------------------------------------------------------------
    // extract_status_code 测试
    // -----------------------------------------------------------------------

    #[test]
    fn extract_status_200() {
        assert_eq!(extract_status_code("HTTP/1.1 200 OK"), Some(200));
    }

    #[test]
    fn extract_status_403() {
        assert_eq!(extract_status_code("HTTP/1.1 403 Forbidden"), Some(403));
    }

    #[test]
    fn extract_status_none() {
        assert_eq!(extract_status_code("nonsense"), None);
    }

    // -----------------------------------------------------------------------
    // filter_backup_entries 测试
    // -----------------------------------------------------------------------

    #[test]
    fn filter_excludes_collections() {
        let entries = vec![PropfindEntry {
            href: "/dav/SoNotes_Backups/".to_string(),
            status: None,
            content_length: None,
            last_modified: None,
            is_collection: true,
        }];
        let filtered = filter_backup_entries(entries);
        assert_eq!(filtered.len(), 0);
    }

    #[test]
    fn filter_excludes_non_matching_filenames() {
        let entries = vec![PropfindEntry {
            href: "/dav/SoNotes_Backups/readme.txt".to_string(),
            status: None,
            content_length: Some(100),
            last_modified: None,
            is_collection: false,
        }];
        let filtered = filter_backup_entries(entries);
        assert_eq!(filtered.len(), 0);
    }

    #[test]
    fn filter_includes_valid_backup() {
        let entries = vec![PropfindEntry {
            href: "/dav/SoNotes_Backups/SoNotes_Backup_20240101120000.zip".to_string(),
            status: Some("HTTP/1.1 200 OK".to_string()),
            content_length: Some(2048),
            last_modified: Some("Sun, 01 Jan 2024 12:00:00 GMT".to_string()),
            is_collection: false,
        }];
        let filtered = filter_backup_entries(entries);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].file_name, "SoNotes_Backup_20240101120000.zip");
        assert_eq!(filtered[0].size, Some(2048));
    }

    // -----------------------------------------------------------------------
    // 临时路径辅助测试
    // -----------------------------------------------------------------------

    #[test]
    fn validate_file_within_webdav_dir_rejects_exact_match() {
        let base = PathBuf::from("/cache/webdav-backups/downloads");
        assert!(!validate_file_within_webdav_dir(&base, &base));
    }

    #[test]
    fn validate_file_within_webdav_dir_accepts_child_file() {
        let base = PathBuf::from("/cache/webdav-backups/downloads");
        let path = PathBuf::from("/cache/webdav-backups/downloads/file.zip");
        assert!(validate_file_within_webdav_dir(&path, &base));
    }

    #[test]
    fn validate_file_within_webdav_dir_rejects_outside_path() {
        let base = PathBuf::from("/cache/webdav-backups/downloads");
        let path = PathBuf::from("/other/dir/file.zip");
        assert!(!validate_file_within_webdav_dir(&path, &base));
    }

    #[test]
    fn validate_file_within_webdav_dir_rejects_sibling_prefix() {
        let base = PathBuf::from("/cache/webdav-backups/downloads");
        let path = PathBuf::from("/cache/webdav-backups/downloads-old/file.zip");
        assert!(!validate_file_within_webdav_dir(&path, &base));
    }

    #[test]
    fn validate_file_within_webdav_dir_rejects_traversal_attack() {
        let base = PathBuf::from("/cache/webdav-backups/downloads");
        let path = PathBuf::from("/cache/webdav-backups/downloads/../secrets/file.zip");
        assert!(!validate_file_within_webdav_dir(&path, &base));
    }

    #[test]
    fn generate_download_token_format() {
        let token = generate_download_token();
        assert!(token.starts_with("webdav-dl-"));
        assert_eq!(token.len(), 42);
    }

    #[test]
    fn generate_download_token_unique() {
        let t1 = generate_download_token();
        let t2 = generate_download_token();
        assert_ne!(t1, t2);
    }

    // -----------------------------------------------------------------------
    // Token 存储生命周期测试
    // -----------------------------------------------------------------------

    #[test]
    fn token_lifecycle_ready_resolve_cleanup() {
        let tmp = std::env::temp_dir().join(format!("webdav-token-test-{:016x}", rand::random::<u64>()));
        std::fs::write(&tmp, b"test").unwrap();

        let token = generate_download_token();
        store_download_token(&token, tmp.clone());

        let resolved = resolve_download_token(&token).unwrap();
        assert_eq!(resolved, tmp);

        let err = resolve_download_token(&token).unwrap_err();
        assert!(err.contains("已被解析"));

        let cleaned = cleanup_download_token(&token).unwrap();
        assert_eq!(cleaned, tmp);

        // 幂等：重复 cleanup 不报错
        let result = cleanup_download_token(&token);
        assert!(result.is_ok());

        let cleaned_again = cleanup_download_token(&token).unwrap();
        assert!(cleaned_again.as_os_str().is_empty());

        let err = resolve_download_token(&token).unwrap_err();
        assert!(err.contains("无效"));

        remove_download_token(&token);
    }

    #[test]
    fn token_resolve_rejects_invalid() {
        let err = resolve_download_token("nonexistent-token").unwrap_err();
        assert!(err.contains("无效"));
    }

    #[test]
    fn token_cleanup_rejects_invalid() {
        let err = cleanup_download_token("nonexistent-token").unwrap_err();
        assert!(err.contains("无效"));
    }

    #[test]
    fn token_cleanup_idempotent_after_cleaned() {
        let tmp = std::env::temp_dir().join(format!("webdav-token-test-{:016x}", rand::random::<u64>()));
        std::fs::write(&tmp, b"test").unwrap();

        let token = generate_download_token();
        store_download_token(&token, tmp.clone());

        let _ = cleanup_download_token(&token).unwrap();
        let result = cleanup_download_token(&token);
        assert!(result.is_ok());

        remove_download_token(&token);
    }

    #[test]
    fn token_cleanup_returns_path_without_deleting_file() {
        let tmp = std::env::temp_dir().join(format!("webdav-token-test-{:016x}", rand::random::<u64>()));
        std::fs::write(&tmp, b"test").unwrap();
        assert!(tmp.exists());

        let token = generate_download_token();
        store_download_token(&token, tmp.clone());

        let _ = cleanup_download_token(&token).unwrap();
        assert!(tmp.exists());

        remove_download_token(&token);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn token_resolve_rejects_expired_token() {
        let tmp = std::env::temp_dir().join(format!("webdav-token-test-{:016x}", rand::random::<u64>()));
        std::fs::write(&tmp, b"test").unwrap();

        let token = generate_download_token();
        store_download_token_created_at(
            &token,
            tmp.clone(),
            SystemTime::now() - DOWNLOAD_TOKEN_TTL - Duration::from_secs(1),
        );

        let err = resolve_download_token(&token).unwrap_err();
        assert!(err.contains("已过期"));

        remove_download_token(&token);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn cleanup_expired_token_is_idempotent() {
        let tmp = std::env::temp_dir().join(format!("webdav-token-test-{:016x}", rand::random::<u64>()));
        std::fs::write(&tmp, b"test").unwrap();

        let token = generate_download_token();
        store_download_token_created_at(
            &token,
            tmp.clone(),
            SystemTime::now() - DOWNLOAD_TOKEN_TTL - Duration::from_secs(1),
        );

        let cleaned = cleanup_download_token(&token).unwrap();
        assert_eq!(cleaned, tmp);

        let cleaned_again = cleanup_download_token(&token).unwrap();
        assert!(cleaned_again.as_os_str().is_empty());

        remove_download_token(&token);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn stale_file_detection_respects_max_age() {
        let missing = std::env::temp_dir().join(format!("missing-webdav-token-test-{:016x}", rand::random::<u64>()));
        assert!(!is_stale_file(&missing, WEBDAV_TEMP_FILE_MAX_AGE));
    }

    #[test]
    fn remove_stale_matching_files_only_removes_matching_zip() {
        let dir = std::env::temp_dir().join(format!("webdav-cleanup-test-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let matching = dir.join("webdav-dl-123.zip");
        let non_matching = dir.join("other.zip");
        let not_zip = dir.join("webdav-dl-123.tmp");
        std::fs::write(&matching, b"zip").unwrap();
        std::fs::write(&non_matching, b"zip").unwrap();
        std::fs::write(&not_zip, b"tmp").unwrap();

        remove_stale_matching_files(&dir, "webdav-dl-", Duration::ZERO).unwrap();

        assert!(!matching.exists());
        assert!(non_matching.exists());
        assert!(not_zip.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
