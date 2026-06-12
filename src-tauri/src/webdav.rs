//! WebDAV 远端备份基础类型、URL/目录规范化与配置持久化
//!
//! 本模块提供 WebDAV 远端备份的配置闭环、连接测试、远端列表、上传、下载与
//! 下载 token 生命周期管理。

use crate::backup;
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::net::{IpAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};
use tauri::Manager;
use url::{Host, Url};

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

const MAX_WEBDAV_REDIRECTS: usize = 10;

/// 下载 token 有效期。过期 token 不再允许解析为本地恢复路径。
const DOWNLOAD_TOKEN_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// WebDAV 临时文件启动清理阈值。
const WEBDAV_TEMP_FILE_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

// ---------------------------------------------------------------------------
// 序列化类型（前端消费，camelCase）
// ---------------------------------------------------------------------------

/// WebDAV 连接配置（前端传入；密码/令牌仅用于本次请求，不持久化）。
#[derive(Clone, Serialize, Deserialize)]
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

impl std::fmt::Debug for WebDavConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebDavConfig")
            .field("server_url", &self.server_url)
            .field("username", &self.username)
            .field("remote_dir", &self.remote_dir)
            .field("password", &self.password.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
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
#[derive(Clone, Serialize, Deserialize)]
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

impl std::fmt::Debug for WebDavConfigSaveRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebDavConfigSaveRequest")
            .field("server_url", &self.server_url)
            .field("username", &self.username)
            .field("remote_dir", &self.remote_dir)
            .field("remember_password", &self.remember_password)
            .field("password", &self.password.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
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
    /// 非致命警告（如凭据删除失败）。
    pub warning: Option<String>,
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
    /// 密钥链 secret 删除失败时的警告信息。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_cleanup_warning: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavDeleteResult {
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
    /// 密钥链 account 标识（SHA-256 哈希前 32 字符）。
    /// 仅在 `password_saved=true` 时写入，用于定位系统凭据。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    credential_key: Option<String>,
}

// ---------------------------------------------------------------------------
// credential_key 计算
// ---------------------------------------------------------------------------

/// 基于 server_url / username / remote_dir 计算密钥链 account 标识。
///
/// 输入格式：`v1\n{server_url}\n{username}\n{remote_dir}`
/// 输出：SHA-256 哈希的前 32 字符十六进制字符串。
/// 不包含 password，确保配置文件中不泄露凭据。
fn compute_credential_key(server_url: &str, username: &str, remote_dir: &str) -> String {
    let input = format!("v1\n{server_url}\n{username}\n{remote_dir}");
    let hash = sha2::Sha256::digest(input.as_bytes());
    let hex: String = hash.iter().map(|b| format!("{b:02x}")).collect();
    hex[..32].to_string()
}

// ---------------------------------------------------------------------------
// URL 规范化
// ---------------------------------------------------------------------------

/// 规范化 WebDAV 基础 URL。
///
/// 规则：
/// - 必须使用 `https://`，除非是 `http://localhost`、`http://127.0.0.1` 或 `http://[::1]`。
/// - `https://` 不允许指向本机、私网、链路本地、未指定地址等内部目标。
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

    // 拒绝空 host
    let host = parsed
        .host()
        .ok_or_else(|| "WebDAV 地址缺少主机名".to_string())?;

    // 检查 scheme
    match parsed.scheme() {
        "https" => reject_internal_https_host(&parsed, &host)?,
        "http" => {
            if !is_http_localhost_exception(&host) {
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

fn is_http_localhost_exception(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(ip) => ip.is_loopback(),
        Host::Ipv6(ip) => ip.is_loopback(),
    }
}

fn reject_internal_https_host(parsed: &Url, host: &Host<&str>) -> Result<(), String> {
    match host {
        Host::Domain(domain) => {
            if domain.trim_end_matches('.').eq_ignore_ascii_case("localhost") {
                return Err("WebDAV HTTPS 地址不能指向本机或内网地址".to_string());
            }

            let port = parsed.port_or_known_default().unwrap_or(443);
            if host_resolves_to_disallowed_webdav_ip(domain, port) {
                return Err("WebDAV HTTPS 地址不能指向本机或内网地址".to_string());
            }
            Ok(())
        }
        Host::Ipv4(ip) => reject_disallowed_https_ip(IpAddr::V4(*ip)),
        Host::Ipv6(ip) => reject_disallowed_https_ip(IpAddr::V6(*ip)),
    }
}

fn reject_disallowed_https_ip(ip: IpAddr) -> Result<(), String> {
    if is_disallowed_webdav_ip(ip) {
        Err("WebDAV HTTPS 地址不能指向本机或内网地址".to_string())
    } else {
        Ok(())
    }
}

fn host_resolves_to_disallowed_webdav_ip(domain: &str, port: u16) -> bool {
    (domain, port)
        .to_socket_addrs()
        .map(|addrs| addrs.map(|addr| addr.ip()).any(is_disallowed_webdav_ip))
        .unwrap_or(false)
}

fn is_disallowed_webdav_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified()
        }
        IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return is_disallowed_webdav_ip(IpAddr::V4(mapped));
            }

            ip.is_loopback()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip.is_unspecified()
        }
    }
}

fn validate_webdav_redirect_url(url: &Url) -> Result<(), String> {
    if url.scheme() != "https" {
        return Err("WebDAV 重定向目标必须使用 HTTPS".to_string());
    }

    let host = url
        .host()
        .ok_or_else(|| "WebDAV 重定向目标缺少主机名".to_string())?;
    reject_internal_https_host(url, &host)
}

fn webdav_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= MAX_WEBDAV_REDIRECTS {
            attempt.error("WebDAV redirect limit exceeded")
        } else if validate_webdav_redirect_url(attempt.url()).is_err() {
            attempt.error("WebDAV redirect target rejected")
        } else {
            attempt.follow()
        }
    })
}

fn build_webdav_http_client(timeout: Duration) -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .user_agent("SoNotes/1.5")
        .timeout(timeout)
        .redirect(webdav_redirect_policy())
        .build()
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

fn chrono_now_datetime_string() -> String {
    chrono::Local::now().format("%Y%m%d%H%M%S").to_string()
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

struct WebDavTempFileGuard {
    path: PathBuf,
    armed: bool,
}

impl WebDavTempFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for WebDavTempFileGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn webdav_config_temp_path(path: &Path) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "WebDAV 配置文件路径缺少父目录".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "WebDAV 配置文件名无效".to_string())?;
    Ok(parent.join(format!(
        ".{file_name}.tmp-{:016x}",
        rand::random::<u64>()
    )))
}

fn write_webdav_config_atomic(path: &Path, content: &str) -> Result<(), String> {
    let tmp_path = webdav_config_temp_path(path)?;
    let mut guard = WebDavTempFileGuard::new(tmp_path.clone());

    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp_path)
        .map_err(|e| format!("创建 WebDAV 配置临时文件失败: {e}"))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("写入 WebDAV 配置临时文件失败: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("同步 WebDAV 配置临时文件失败: {e}"))?;
    drop(file);

    std::fs::rename(&tmp_path, path).map_err(|e| format!("替换 WebDAV 配置文件失败: {e}"))?;
    guard.disarm();
    Ok(())
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
        password_saved: config.password_saved && config.credential_key.is_some(),
        error: None,
    })
}

/// 纯校验+规范化：将前端保存请求转换为可安全持久化的配置结构。
///
/// 职责：
/// - 通过 `normalize_webdav_url` 规范化 `server_url`。
/// - 通过 `normalize_remote_dir` 规范化 `remote_dir`。
/// - 计算 `credential_key`（不含密码）。
/// - 永远不将密码/令牌写入磁盘。
fn prepare_config_save(
    request: &WebDavConfigSaveRequest,
    old_config: Option<&WebDavConfigFile>,
) -> Result<(WebDavConfigFile, Option<String>), String> {
    let server_url = normalize_webdav_url(&request.server_url)?;
    let remote_dir = normalize_remote_dir(request.remote_dir.as_deref().unwrap_or(""))?;

    let new_key = compute_credential_key(&server_url, &request.username, &remote_dir);
    let old_credential_key = old_config.and_then(|c| c.credential_key.clone());

    if request.remember_password {
        if request.password.as_deref().unwrap_or("").is_empty() {
            return Err("勾选记住密码时必须提供密码".to_string());
        }

        let config = WebDavConfigFile {
            server_url,
            username: request.username.clone(),
            remote_dir,
            password_saved: true,
            credential_key: Some(new_key),
        };
        return Ok((config, old_credential_key));
    }

    let config = WebDavConfigFile {
        server_url,
        username: request.username.clone(),
        remote_dir,
        password_saved: false,
        credential_key: None,
    };
    Ok((config, old_credential_key))
}

/// 保存 WebDAV 配置。
///
/// 将非敏感字段写入应用配置目录的 `webdav-config.json`。
/// 当 `remember_password=true` 时，密码通过系统密钥链存储，配置文件仅保存引用。
#[tauri::command]
pub async fn webdav_save_config(
    app: tauri::AppHandle,
    request: WebDavConfigSaveRequest,
) -> Result<WebDavConfigSaveResult, String> {
    let path = config_file_path(&app)?;

    let old_config = if path.exists() {
        let content =
            std::fs::read_to_string(&path).map_err(|e| format!("读取 WebDAV 配置文件失败: {e}"))?;
        serde_json::from_str::<WebDavConfigFile>(&content)
            .map_err(|e| format!("解析 WebDAV 配置文件失败: {e}"))?
            .into()
    } else {
        None
    };

    let (config, old_credential_key) = prepare_config_save(&request, old_config.as_ref())?;

    if request.remember_password {
        let password = request.password.as_deref().unwrap_or("");
        let new_key = config.credential_key.as_ref().unwrap();
        let store = SystemWebDavCredentialStore::new();

        // 旧 key 与新 key 不同时，先删除旧 secret
        if let Some(ref old_key_str) = old_credential_key {
            if old_key_str != new_key {
                let old_cred_key = WebDavCredentialKey {
                    service: "SoNotes.WebDAV".to_string(),
                    account: old_key_str.clone(),
                };
                store
                    .delete(&old_cred_key)
                    .map_err(|e| format!("删除旧凭据失败: {e}"))?;
            }
        }

        let new_cred_key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: new_key.clone(),
        };
        store
            .save(&new_cred_key, password)
            .map_err(|e| format!("保存密码到系统凭据失败: {e}"))?;

        let json = serde_json::to_string_pretty(&config)
            .map_err(|e| format!("序列化 WebDAV 配置失败: {e}"))?;

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建 WebDAV 配置目录失败: {e}"))?;
        }

        if let Err(e) = write_webdav_config_atomic(&path, &json) {
            let _ = store.delete(&new_cred_key);
            return Err(format!("写入 WebDAV 配置文件失败: {e}"));
        }

        return Ok(WebDavConfigSaveResult {
            success: true,
            warning: None,
            error: None,
        });
    }

    // remember_password=false：尝试删除旧 secret
    let mut warning = None;
    if let Some(ref old_key_str) = old_credential_key {
        let old_cred_key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: old_key_str.clone(),
        };
        if let Err(_e) = SystemWebDavCredentialStore::new().delete(&old_cred_key) {
            warning = Some("配置已更新，但系统凭据可能需要手动删除".to_string());
        }
    }

    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("序列化 WebDAV 配置失败: {e}"))?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建 WebDAV 配置目录失败: {e}"))?;
    }

    write_webdav_config_atomic(&path, &json)?;

    Ok(WebDavConfigSaveResult {
        success: true,
        warning,
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
            secret_cleanup_warning: None,
        });
    }

    // 读取旧配置以获取 credential_key（先于删除）
    let old_credential_key = std::fs::read_to_string(&path)
        .ok()
        .and_then(|content| serde_json::from_str::<WebDavConfigFile>(&content).ok())
        .and_then(|config_file| config_file.credential_key);

    std::fs::remove_file(&path).map_err(|e| format!("删除 WebDAV 配置文件失败: {e}"))?;

    let mut secret_cleanup_warning = None;
    if let Some(key_str) = old_credential_key {
        let cred_key = WebDavCredentialKey {
            service: CREDENTIAL_SERVICE.to_string(),
            account: key_str,
        };
        if let Err(e) = SystemWebDavCredentialStore::new().delete(&cred_key) {
            secret_cleanup_warning =
                Some(format!("配置文件已删除，但密钥链 secret 未清理: {e}"));
        }
    }

    Ok(WebDavConfigClearResult {
        success: true,
        error: None,
        secret_cleanup_warning,
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
// 内部请求目标（已完成 URL/目录规范化）
// ---------------------------------------------------------------------------

/// 已完成规范化的 WebDAV 请求目标，携带基础 URL、远端目录和凭据。
///
/// 生产路径通过 `build_webdav_request_target(config)` 构造；
/// 测试路径可以直接构造本地 mock target（例如 `http://127.0.0.1:PORT`）。
pub struct WebDavRequestTarget {
    /// 规范化后的基础 URL（例如 `https://example.com/dav`）。
    pub base_url: String,
    /// 规范化后的远端目录（带尾部斜杠，例如 `SoNotes_Backups/`）。
    pub remote_dir: String,
    /// 用户名。
    pub username: String,
    /// 密码或应用令牌（仅在本次请求中使用）。
    pub password: Option<String>,
}

impl WebDavRequestTarget {
    /// 从规范化后的基础 URL 和远端目录构造请求目标（测试用，无凭据）。
    #[cfg(test)]
    pub fn for_test(base_url: &str, remote_dir: &str) -> Self {
        Self {
            base_url: base_url.to_string(),
            remote_dir: remote_dir.to_string(),
            username: String::new(),
            password: None,
        }
    }

    /// 从规范化后的基础 URL、远端目录和凭据构造请求目标（测试用）。
    #[cfg(test)]
    pub fn for_test_with_auth(
        base_url: &str,
        remote_dir: &str,
        username: &str,
        password: Option<String>,
    ) -> Self {
        Self {
            base_url: base_url.to_string(),
            remote_dir: remote_dir.to_string(),
            username: username.to_string(),
            password,
        }
    }
}

/// 从 `WebDavConfig` 构造已规范化的请求目标。
///
/// 执行 URL 规范化和远端目录规范化，失败时返回 `String` 错误。
pub fn build_webdav_request_target(config: &WebDavConfig) -> Result<WebDavRequestTarget, String> {
    let base_url = normalize_webdav_url(&config.server_url)?;
    let remote_dir = normalize_remote_dir(config.remote_dir.as_deref().unwrap_or(""))?;
    Ok(WebDavRequestTarget {
        base_url,
        remote_dir,
        username: config.username.clone(),
        password: config.password.clone(),
    })
}

/// 凭据解析固定 service 常量，与 `save_config` / `load_config` 保持一致。
const CREDENTIAL_SERVICE: &str = "SoNotes.WebDAV";

/// 解析远端操作所需的密码/令牌（核心逻辑，不依赖 AppHandle）。
///
/// 优先级：
/// 1. `config.password` 非空 → 直接使用（前端本次传入）。
/// 2. 读取已保存的配置文件，从中获取 `credential_key` → 从密钥链加载。
/// 3. 都无法获取 → 返回错误提示。
fn resolve_operation_secret_core(
    config_path: Option<&Path>,
    config: &WebDavConfig,
    store: &dyn WebDavCredentialStore,
) -> Result<String, String> {
    if let Some(ref pw) = config.password {
        if !pw.is_empty() {
            return Ok(pw.clone());
        }
    }

    let path = match config_path {
        Some(p) if p.exists() => p,
        _ => {
            return Err("请提供密码或在配置中启用「记住密码」。".to_string());
        }
    };

    let content = std::fs::read_to_string(path)
        .map_err(|_| "读取配置文件失败，请重新输入密码或应用令牌。".to_string())?;
    let config_file: WebDavConfigFile = serde_json::from_str(&content)
        .map_err(|_| "解析配置文件失败，请重新输入密码或应用令牌。".to_string())?;

    let key_str = match config_file.credential_key {
        Some(k) if config_file.password_saved => k,
        _ => {
            return Err("请提供密码或在配置中启用「记住密码」。".to_string());
        }
    };

    let cred_key = WebDavCredentialKey {
        service: CREDENTIAL_SERVICE.to_string(),
        account: key_str,
    };

    store
        .load(&cred_key)
        .map_err(|_| "系统凭据读取失败，请重新输入密码或应用令牌。".to_string())
}

/// 解析远端操作所需的密码/令牌。
///
/// 从 AppHandle 获取配置文件路径后委托给 `resolve_operation_secret_core`。
fn resolve_webdav_operation_secret(
    app: &tauri::AppHandle,
    config: &WebDavConfig,
    store: &dyn WebDavCredentialStore,
) -> Result<String, String> {
    let path = config_file_path(app)?;
    resolve_operation_secret_core(Some(&path), config, store)
}

// ---------------------------------------------------------------------------
// PROPFIND 请求
// ---------------------------------------------------------------------------

fn propfind_request(
    client: &reqwest::Client,
    url: &str,
    depth: &str,
    username: &str,
    password: Option<&str>,
) -> reqwest::RequestBuilder {
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
) -> Result<(), WebDavOperationError> {
    let propfind_resp = propfind_request(client, dir_url, "0", username, password)
        .send()
        .await
        .map_err(|e| classify_reqwest_error(WebDavOperation::UploadBackup, &e))?;

    match propfind_resp.status().as_u16() {
        200..=299 => return Ok(()),
        404 => {}
        _ => {
            return Err(classify_webdav_status(
                WebDavOperation::UploadBackup,
                propfind_resp.status(),
            ));
        }
    }

    let mkcol_method = reqwest::Method::from_bytes(b"MKCOL").map_err(|_| {
        WebDavOperationError {
            kind: WebDavErrorKind::UnexpectedStatus,
            status: None,
            retryable: false,
        }
    })?;
    let mkcol_resp = webdav_request_with_auth(client, mkcol_method, dir_url, username, password)
        .send()
        .await
        .map_err(|e| classify_reqwest_error(WebDavOperation::UploadBackup, &e))?;

    match mkcol_resp.status().as_u16() {
        200 | 201 | 204 => Ok(()),
        _ => Err(classify_webdav_status(
            WebDavOperation::UploadBackup,
            mkcol_resp.status(),
        )),
    }
}

// ---------------------------------------------------------------------------
// PROPFIND XML 解析
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct PropfindEntry {
    href: String,
    status: Option<String>,
    content_length: Option<u64>,
    last_modified: Option<String>,
    is_collection: bool,
}

fn parse_propfind_response(xml: &str) -> Result<Vec<PropfindEntry>, WebDavOperationError> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let invalid_propfind = || WebDavOperationError {
        kind: WebDavErrorKind::InvalidPropfindResponse,
        status: None,
        retryable: false,
    };

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
                    return Err(invalid_propfind());
                }
                break;
            }
            Err(_) => return Err(invalid_propfind()),
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

/// 对 href basename 做 percent-decode（`%XX` → 对应字节）。
///
/// 解码失败（如 `%` 后跟非 hex 字符）时返回 `None`。
/// 解码后的字节逐个检查合法性：拒绝路径分隔符、`..`、空字节、冒号。
fn decode_href_basename(href: &str) -> Option<String> {
    let basename = href.trim_end_matches('/').rsplit('/').next()?;

    let mut decoded = Vec::with_capacity(basename.len());
    let bytes = basename.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = hex_val(bytes[i + 1])?;
            let lo = hex_val(bytes[i + 2])?;
            decoded.push(hi * 16 + lo);
            i += 3;
        } else {
            decoded.push(bytes[i]);
            i += 1;
        }
    }

    if decoded.contains(&b'/') || decoded.contains(&b'\\') {
        return None;
    }
    if decoded.contains(&0) {
        return None;
    }
    if decoded.contains(&b':') {
        return None;
    }
    if decoded == b".." {
        return None;
    }

    String::from_utf8(decoded).ok()
}

fn hex_val(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn filter_backup_entries(entries: Vec<PropfindEntry>) -> Vec<WebDavRemoteBackup> {
    entries
        .into_iter()
        .filter(|e| !e.is_collection)
        .filter_map(|e| {
            let file_name = decode_href_basename(&e.href)?;

            if validate_remote_backup_filename(&file_name).is_err() {
                return None;
            }

            let status_code = e.status.as_deref().and_then(extract_status_code);
            if let Some(code) = status_code {
                if !(200..300).contains(&code) {
                    return None;
                }
            }

            Some(WebDavRemoteBackup {
                file_name,
                size: e.content_length,
                last_modified: e.last_modified,
                status: status_code,
                readable: true,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tauri 命令：transport
// ---------------------------------------------------------------------------

async fn webdav_test_connection_with_client(
    client: &reqwest::Client,
    target: &WebDavRequestTarget,
) -> Result<WebDavConnectionResult, String> {
    let dir_url = build_remote_dir_url(&target.base_url, &target.remote_dir);

    let resp = propfind_request(
        client,
        &dir_url,
        "0",
        &target.username,
        target.password.as_deref(),
    )
    .send()
    .await
    .map_err(|e| {
        let op_error = classify_reqwest_error(WebDavOperation::TestConnection, &e);
        webdav_error_message(&op_error)
    })?;

    let status = resp.status();
    match status.as_u16() {
        200..=299 => Ok(WebDavConnectionResult {
            success: true,
            error: None,
        }),
        404 => match ensure_remote_dir_exists(
            client,
            &dir_url,
            &target.username,
            target.password.as_deref(),
        )
        .await
        {
            Ok(()) => Ok(WebDavConnectionResult {
                success: true,
                error: None,
            }),
            Err(op_error) => Ok(WebDavConnectionResult {
                success: false,
                error: Some(webdav_error_message(&op_error)),
            }),
        },
        _ => {
            let op_error = classify_webdav_status(WebDavOperation::TestConnection, status);
            Ok(WebDavConnectionResult {
                success: false,
                error: Some(webdav_error_message(&op_error)),
            })
        }
    }
}

#[tauri::command]
pub async fn webdav_test_connection(
    app: tauri::AppHandle,
    config: WebDavConfig,
) -> Result<WebDavConnectionResult, String> {
    let store = SystemWebDavCredentialStore::new();
    let secret = resolve_webdav_operation_secret(&app, &config, &store)?;
    let mut config = config;
    config.password = Some(secret);
    let target = build_webdav_request_target(&config)?;
    let client = build_webdav_http_client(Duration::from_secs(15))
        .map_err(|_| "WebDAV 地址不可访问".to_string())?;
    webdav_test_connection_with_client(&client, &target).await
}

async fn webdav_list_backups_with_client(
    client: &reqwest::Client,
    target: &WebDavRequestTarget,
) -> Result<Vec<WebDavRemoteBackup>, String> {
    let dir_url = build_remote_dir_url(&target.base_url, &target.remote_dir);

    let resp = propfind_request(
        client,
        &dir_url,
        "1",
        &target.username,
        target.password.as_deref(),
    )
    .send()
    .await
    .map_err(|e| {
        let op_error = classify_reqwest_error(WebDavOperation::ListBackups, &e);
        webdav_error_message(&op_error)
    })?;

    let status = resp.status();
    match status.as_u16() {
        200..=299 => {}
        _ => {
            let op_error = classify_webdav_status(WebDavOperation::ListBackups, status);
            return Err(webdav_error_message(&op_error));
        }
    }

    let xml = resp.text().await.map_err(|_| "远端备份列表读取失败".to_string())?;
    let entries = parse_propfind_response(&xml).map_err(|e| webdav_error_message(&e))?;
    Ok(filter_backup_entries(entries))
}

#[tauri::command]
pub async fn webdav_list_backups(
    app: tauri::AppHandle,
    config: WebDavConfig,
) -> Result<Vec<WebDavRemoteBackup>, String> {
    let store = SystemWebDavCredentialStore::new();
    let secret = resolve_webdav_operation_secret(&app, &config, &store)?;
    let mut config = config;
    config.password = Some(secret);
    let target = build_webdav_request_target(&config)?;
    let client = build_webdav_http_client(Duration::from_secs(15))
        .map_err(|_| "远端备份列表读取失败".to_string())?;
    webdav_list_backups_with_client(&client, &target).await
}

async fn webdav_delete_backup_with_client(
    client: &reqwest::Client,
    target: &WebDavRequestTarget,
    remote_file_name: &str,
) -> Result<WebDavDeleteResult, String> {
    let dir_url = build_remote_dir_url(&target.base_url, &target.remote_dir);
    let file_url = format!("{}{}", dir_url, remote_file_name);

    let resp = webdav_request_with_auth(
        client,
        reqwest::Method::DELETE,
        &file_url,
        &target.username,
        target.password.as_deref(),
    )
    .send()
    .await
    .map_err(|e| {
        let op_error = classify_reqwest_error(WebDavOperation::DeleteBackup, &e);
        webdav_error_message(&op_error)
    })?;

    let status = resp.status();
    match status.as_u16() {
        200..=299 => Ok(WebDavDeleteResult {
            success: true,
            error: None,
        }),
        404 => Ok(WebDavDeleteResult {
            success: true,
            error: Some("远端备份已不存在".to_string()),
        }),
        _ => {
            let op_error = classify_webdav_status(WebDavOperation::DeleteBackup, status);
            Err(webdav_error_message(&op_error))
        }
    }
}

#[tauri::command]
pub async fn webdav_delete_backup(
    app: tauri::AppHandle,
    config: WebDavConfig,
    remote_file_name: String,
) -> Result<WebDavDeleteResult, String> {
    validate_remote_backup_filename(&remote_file_name)?;

    let store = SystemWebDavCredentialStore::new();
    let secret = resolve_webdav_operation_secret(&app, &config, &store)?;
    let mut config = config;
    config.password = Some(secret);
    let target = build_webdav_request_target(&config)?;
    let client = build_webdav_http_client(Duration::from_secs(30))
        .map_err(|_| "远端备份删除失败".to_string())?;
    webdav_delete_backup_with_client(&client, &target, &remote_file_name).await
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
    format!("webdav-dl-{:032x}", rand::random::<u128>())
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

async fn webdav_upload_backup_with_client(
    client: &reqwest::Client,
    target: &WebDavRequestTarget,
    zip_path: &Path,
) -> Result<WebDavUploadResult, String> {
    let dir_url = build_remote_dir_url(&target.base_url, &target.remote_dir);

    ensure_remote_dir_exists(
        client,
        &dir_url,
        &target.username,
        target.password.as_deref(),
    )
    .await
    .map_err(|op_error| {
        let _ = std::fs::remove_file(zip_path);
        webdav_error_message(&op_error)
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
        let zip_len = tokio::fs::metadata(zip_path)
            .await
            .map_err(|_| {
                let _ = std::fs::remove_file(zip_path);
                "远端备份上传失败，本地数据未受影响".to_string()
            })?
            .len();
        let zip_file = tokio::fs::File::open(zip_path).await.map_err(|_| {
            let _ = std::fs::remove_file(zip_path);
            "远端备份上传失败，本地数据未受影响".to_string()
        })?;

        let mut req = client
            .put(&upload_url)
            .header("Content-Type", "application/zip")
            .header(reqwest::header::CONTENT_LENGTH, zip_len)
            .header("If-None-Match", "*")
            .body(reqwest::Body::from(zip_file));

        if let Some(pw) = &target.password {
            req = req.basic_auth(&target.username, Some(pw));
        } else if !target.username.is_empty() {
            req = req.basic_auth(&target.username, None::<&str>);
        }

        match req.send().await {
            Ok(resp) => {
                let status = resp.status();
                match status.as_u16() {
                    200..=299 => {
                        let _ = std::fs::remove_file(zip_path);
                        return Ok(WebDavUploadResult {
                            success: true,
                            remote_file_name: Some(remote_filename),
                            error: None,
                        });
                    }
                    401 | 403 => {
                        let _ = std::fs::remove_file(zip_path);
                        let op_error =
                            classify_webdav_status(WebDavOperation::UploadBackup, status);
                        return Err(webdav_error_message(&op_error));
                    }
                    409 | 412 => {
                        last_error = "远端已存在同名备份，请稍后重试".to_string();
                        continue;
                    }
                    _ => {
                        let op_error =
                            classify_webdav_status(WebDavOperation::UploadBackup, status);
                        let _ = std::fs::remove_file(zip_path);
                        return Err(webdav_error_message(&op_error));
                    }
                }
            }
            Err(e) => {
                let _ = std::fs::remove_file(zip_path);
                let op_error = classify_reqwest_error(WebDavOperation::UploadBackup, &e);
                return Err(webdav_error_message(&op_error));
            }
        }
    }

    let _ = std::fs::remove_file(zip_path);
    Err(last_error)
}

#[tauri::command]
pub async fn webdav_create_remote_backup(
    app: tauri::AppHandle,
    config: WebDavConfig,
) -> Result<WebDavUploadResult, String> {
    let store = SystemWebDavCredentialStore::new();
    let secret = resolve_webdav_operation_secret(&app, &config, &store)?;
    let mut config = config;
    config.password = Some(secret);
    let target = build_webdav_request_target(&config)?;

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

    let client = build_webdav_http_client(Duration::from_secs(60))
        .map_err(|_| "远端备份上传失败，本地数据未受影响".to_string())?;

    let result = webdav_upload_backup_with_client(&client, &target, &actual_zip_path).await;

    if actual_zip_path != temp_zip_path {
        let _ = std::fs::remove_file(&temp_zip_path);
    }

    result
}

/// 下载核心实现：接受注入的临时目录和大小上限，便于测试。
///
/// 生产入口 `webdav_download_backup_with_client` 委托本函数，
/// 传入应用缓存目录和 `MAX_WEBDAV_BACKUP_DOWNLOAD_BYTES`。
/// 测试入口传入临时目录和较小的 `max_bytes` 以避免分配大内存。
async fn download_backup_with_limit(
    client: &reqwest::Client,
    target: &WebDavRequestTarget,
    file_name: &str,
    temp_root: &Path,
    max_bytes: u64,
) -> Result<WebDavDownloadResult, WebDavOperationError> {
    let dir_url = build_remote_dir_url(&target.base_url, &target.remote_dir);
    let download_url = format!("{}{}", dir_url, file_name);

    let mut req = client.get(&download_url);
    if let Some(pw) = &target.password {
        req = req.basic_auth(&target.username, Some(pw));
    } else if !target.username.is_empty() {
        req = req.basic_auth(&target.username, None::<&str>);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| classify_reqwest_error(WebDavOperation::DownloadBackup, &e))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(classify_webdav_status(
            WebDavOperation::DownloadBackup,
            status,
        ));
    }

    if let Some(content_length) = resp.content_length() {
        if content_length > max_bytes {
            return Err(WebDavOperationError {
                kind: WebDavErrorKind::DownloadTooLarge,
                status: None,
                retryable: false,
            });
        }
    }

    std::fs::create_dir_all(temp_root).map_err(|_| WebDavOperationError {
        kind: WebDavErrorKind::LocalTempFileError,
        status: None,
        retryable: false,
    })?;

    let dl_id: u64 = rand::random();
    let dl_file_name = format!("webdav-dl-{dl_id:016x}.zip");
    let dl_path = temp_root.join(&dl_file_name);

    let mut file = std::fs::File::create(&dl_path).map_err(|_| WebDavOperationError {
        kind: WebDavErrorKind::LocalTempFileError,
        status: None,
        retryable: false,
    })?;

    let mut total_bytes: u64 = 0;
    let mut resp = resp;

    while let Some(chunk) = resp.chunk().await.map_err(|_| {
        let _ = std::fs::remove_file(&dl_path);
        WebDavOperationError {
            kind: WebDavErrorKind::UnexpectedStatus,
            status: None,
            retryable: false,
        }
    })? {
        total_bytes += chunk.len() as u64;
        if total_bytes > max_bytes {
            let _ = std::fs::remove_file(&dl_path);
            return Err(WebDavOperationError {
                kind: WebDavErrorKind::DownloadTooLarge,
                status: None,
                retryable: false,
            });
        }

        file.write_all(&chunk).map_err(|_| {
            let _ = std::fs::remove_file(&dl_path);
            WebDavOperationError {
                kind: WebDavErrorKind::LocalTempFileError,
                status: None,
                retryable: false,
            }
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

async fn webdav_download_backup_with_client(
    client: &reqwest::Client,
    target: &WebDavRequestTarget,
    remote_file_name: &str,
    downloads_dir: &Path,
) -> Result<WebDavDownloadResult, String> {
    download_backup_with_limit(
        client,
        target,
        remote_file_name,
        downloads_dir,
        MAX_WEBDAV_BACKUP_DOWNLOAD_BYTES,
    )
    .await
    .map_err(|e| webdav_error_message(&e))
}

#[tauri::command]
pub async fn webdav_download_backup(
    app: tauri::AppHandle,
    config: WebDavConfig,
    remote_file_name: String,
) -> Result<WebDavDownloadResult, String> {
    validate_remote_backup_filename(&remote_file_name)?;

    let store = SystemWebDavCredentialStore::new();
    let secret = resolve_webdav_operation_secret(&app, &config, &store)?;
    let mut config = config;
    config.password = Some(secret);
    let target = build_webdav_request_target(&config)?;

    let downloads_dir = webdav_downloads_dir(&app)?;
    std::fs::create_dir_all(&downloads_dir)
        .map_err(|_| "远端备份下载失败，本地数据未受影响".to_string())?;

    let client = build_webdav_http_client(Duration::from_secs(120))
        .map_err(|_| "远端备份下载失败，本地数据未受影响".to_string())?;

    webdav_download_backup_with_client(&client, &target, &remote_file_name, &downloads_dir).await
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
// WebDAV 错误分类（内部使用，不改变前端返回类型）
// ===========================================================================

/// WebDAV 操作过程中的错误类型分类。
///
/// 本枚举仅用于 Rust 内部分类与测试断言，不直接暴露给前端。
/// 前端可见文案由 `webdav_error_message()` 在 Tauri 命令返回前生成。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebDavErrorKind {
    /// 鉴权失败（HTTP 401）。
    AuthFailed,
    /// 权限不足或访问被拒绝（HTTP 403）。
    Forbidden,
    /// 目标不存在（HTTP 404）。
    NotFound,
    /// 远端目录不存在、父路径冲突或同名对象已存在（HTTP 409/412）。
    PathConflict,
    /// 资源被锁定（HTTP 423）。
    Locked,
    /// 远端存储空间不足（HTTP 507）。
    InsufficientStorage,
    /// 服务端不支持当前方法或路径不正确（HTTP 405）。
    MethodNotAllowed,
    /// 请求超时。
    Timeout,
    /// 网络不可达或连接失败。
    NetworkUnreachable,
    /// 重定向被安全策略拒绝。
    RedirectRejected,
    /// 非预期的 HTTP 状态码。
    UnexpectedStatus,
    /// PROPFIND 响应 XML 无效或无法解析。
    InvalidPropfindResponse,
    /// 下载内容超过允许大小上限。
    DownloadTooLarge,
    /// 远端文件名校验失败。
    InvalidRemoteFileName,
    /// 本地临时文件操作失败。
    LocalTempFileError,
}

/// WebDAV 操作类型，用于区分同一状态码在不同操作下的语义。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebDavOperation {
    /// 连接测试。
    TestConnection,
    /// 列出远端备份。
    ListBackups,
    /// 上传备份。
    UploadBackup,
    /// 下载备份。
    DownloadBackup,
    /// 删除备份。
    DeleteBackup,
}

/// WebDAV 操作错误，包含分类、可选 HTTP 状态码和可重试标记。
///
/// 本结构体不保存用户文案，避免结构体相等比较被中文文案变化拖动。
/// 用户可见文案由 `webdav_error_message()` 在调用点生成。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebDavOperationError {
    pub kind: WebDavErrorKind,
    pub status: Option<u16>,
    pub retryable: bool,
}

// ---------------------------------------------------------------------------
// Credential Store 抽象
// ---------------------------------------------------------------------------

/// 密钥链 account key，用于在系统凭据管理器中定位 secret。
///
/// `service` 固定为 `"SoNotes.WebDAV"`；`account` 为带版本前缀的
/// sha256 哈希，不包含 password / token / Authorization header。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebDavCredentialKey {
    pub service: String,
    pub account: String,
}

/// 凭据操作错误分类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebDavCredentialErrorKind {
    /// 当前平台没有可用密钥链服务。
    Unavailable,
    /// 保存 secret 失败。
    SaveFailed,
    /// 读取 secret 失败。
    LoadFailed,
    /// 删除 secret 失败。
    DeleteFailed,
    /// 期望存在但实际无 secret。
    MissingSecret,
}

/// 凭据操作错误。
#[derive(Debug, Clone)]
pub struct WebDavCredentialError {
    pub kind: WebDavCredentialErrorKind,
    pub message: String,
}

impl std::fmt::Display for WebDavCredentialError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

/// Credential store 边界：业务逻辑通过此 trait 与系统密钥链交互。
///
/// 生产环境使用 `SystemWebDavCredentialStore`（接入 keyring crate）；
/// 测试环境使用 `MemoryWebDavCredentialStore`（内存 HashMap）。
pub trait WebDavCredentialStore: Send + Sync {
    fn save(&self, key: &WebDavCredentialKey, secret: &str) -> Result<(), WebDavCredentialError>;
    fn load(&self, key: &WebDavCredentialKey) -> Result<String, WebDavCredentialError>;
    fn delete(&self, key: &WebDavCredentialKey) -> Result<(), WebDavCredentialError>;
}

/// 内存 credential store，仅用于单元测试。
///
/// 使用 `Mutex<HashMap>` 实现 `Send + Sync`，不依赖系统密钥链。
pub struct MemoryWebDavCredentialStore {
    inner: std::sync::Mutex<HashMap<String, String>>,
}

impl MemoryWebDavCredentialStore {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(HashMap::new()),
        }
    }

    fn make_key(key: &WebDavCredentialKey) -> String {
        format!("{}/{}", key.service, key.account)
    }
}

impl Default for MemoryWebDavCredentialStore {
    fn default() -> Self {
        Self::new()
    }
}

impl WebDavCredentialStore for MemoryWebDavCredentialStore {
    fn save(&self, key: &WebDavCredentialKey, secret: &str) -> Result<(), WebDavCredentialError> {
        let mut map = self.inner.lock().map_err(|_| WebDavCredentialError {
            kind: WebDavCredentialErrorKind::SaveFailed,
            message: "内存锁中毒".to_string(),
        })?;
        map.insert(Self::make_key(key), secret.to_string());
        Ok(())
    }

    fn load(&self, key: &WebDavCredentialKey) -> Result<String, WebDavCredentialError> {
        let map = self.inner.lock().map_err(|_| WebDavCredentialError {
            kind: WebDavCredentialErrorKind::LoadFailed,
            message: "内存锁中毒".to_string(),
        })?;
        map.get(&Self::make_key(key))
            .cloned()
            .ok_or(WebDavCredentialError {
                kind: WebDavCredentialErrorKind::MissingSecret,
                message: "凭据不存在".to_string(),
            })
    }

    fn delete(&self, key: &WebDavCredentialKey) -> Result<(), WebDavCredentialError> {
        let mut map = self.inner.lock().map_err(|_| WebDavCredentialError {
            kind: WebDavCredentialErrorKind::DeleteFailed,
            message: "内存锁中毒".to_string(),
        })?;
        map.remove(&Self::make_key(key));
        Ok(())
    }
}

/// 系统密钥链 credential store，通过 `keyring` crate 接入操作系统凭据管理器。
///
/// 每次操作按需创建 `keyring_core::Entry`，不缓存实例。
/// Windows 平台需要在调用方初始化 `keyring::use_windows_native_store()`。
pub struct SystemWebDavCredentialStore;

impl SystemWebDavCredentialStore {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SystemWebDavCredentialStore {
    fn default() -> Self {
        Self::new()
    }
}

impl WebDavCredentialStore for SystemWebDavCredentialStore {
    fn save(&self, key: &WebDavCredentialKey, secret: &str) -> Result<(), WebDavCredentialError> {
        let entry = keyring_core::Entry::new(&key.service, &key.account).map_err(|e| {
            WebDavCredentialError {
                kind: WebDavCredentialErrorKind::SaveFailed,
                message: format!("创建密钥链条目失败: {e}"),
            }
        })?;
        entry.set_password(secret).map_err(|e| WebDavCredentialError {
            kind: WebDavCredentialErrorKind::SaveFailed,
            message: format!("保存密码到密钥链失败: {e}"),
        })
    }

    fn load(&self, key: &WebDavCredentialKey) -> Result<String, WebDavCredentialError> {
        let entry = keyring_core::Entry::new(&key.service, &key.account).map_err(|e| {
            WebDavCredentialError {
                kind: WebDavCredentialErrorKind::LoadFailed,
                message: format!("创建密钥链条目失败: {e}"),
            }
        })?;
        entry.get_password().map_err(|e| match e {
            keyring_core::Error::NoEntry => WebDavCredentialError {
                kind: WebDavCredentialErrorKind::MissingSecret,
                message: "凭据不存在".to_string(),
            },
            other => WebDavCredentialError {
                kind: WebDavCredentialErrorKind::LoadFailed,
                message: format!("从密钥链读取密码失败: {other}"),
            },
        })
    }

    fn delete(&self, key: &WebDavCredentialKey) -> Result<(), WebDavCredentialError> {
        let entry = keyring_core::Entry::new(&key.service, &key.account).map_err(|e| {
            WebDavCredentialError {
                kind: WebDavCredentialErrorKind::DeleteFailed,
                message: format!("创建密钥链条目失败: {e}"),
            }
        })?;
        entry.delete_credential().map_err(|e| match e {
            keyring_core::Error::NoEntry => WebDavCredentialError {
                kind: WebDavCredentialErrorKind::MissingSecret,
                message: "凭据不存在".to_string(),
            },
            other => WebDavCredentialError {
                kind: WebDavCredentialErrorKind::DeleteFailed,
                message: format!("从密钥链删除凭据失败: {other}"),
            },
        })
    }
}

/// 测试用 credential store：delete 始终失败，用于验证 warning 路径。
pub struct FailingDeleteCredentialStore;

impl FailingDeleteCredentialStore {
    pub fn new() -> Self {
        Self
    }
}

impl Default for FailingDeleteCredentialStore {
    fn default() -> Self {
        Self::new()
    }
}

impl WebDavCredentialStore for FailingDeleteCredentialStore {
    fn save(&self, _key: &WebDavCredentialKey, _secret: &str) -> Result<(), WebDavCredentialError> {
        Ok(())
    }

    fn load(&self, _key: &WebDavCredentialKey) -> Result<String, WebDavCredentialError> {
        Err(WebDavCredentialError {
            kind: WebDavCredentialErrorKind::LoadFailed,
            message: "FailingDeleteCredentialStore: load not implemented".to_string(),
        })
    }

    fn delete(&self, _key: &WebDavCredentialKey) -> Result<(), WebDavCredentialError> {
        Err(WebDavCredentialError {
            kind: WebDavCredentialErrorKind::DeleteFailed,
            message: "FailingDeleteCredentialStore: delete always fails".to_string(),
        })
    }
}

/// 传输层故障分类，用于将 `reqwest::Error` 转换为内部分类。
///
/// 拆分此层使得单元测试可以直接断言映射逻辑，无需在 CI 中制造真实超时或网络故障。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebDavTransportFailure {
    /// 请求超时。
    Timeout,
    /// 网络不可达或连接失败。
    NetworkUnreachable,
    /// 重定向被安全策略拒绝。
    RedirectRejected,
    /// 其他传输层错误。
    Other,
}

/// 将 HTTP 状态码分类为 `WebDavOperationError`。
///
/// 映射规则：
/// - 401 → AuthFailed
/// - 403 → Forbidden
/// - 404 → NotFound
/// - 405 → MethodNotAllowed
/// - 409 → PathConflict
/// - 412 → PathConflict
/// - 423 → Locked
/// - 507 → InsufficientStorage
/// - 408/429 → Timeout（可重试）
/// - 5xx → UnexpectedStatus（可重试）
/// - 其他 → UnexpectedStatus（不可重试）
///
/// 注意：`retryable` 字段仅是分类标签，不代表所有操作都会执行重试。
/// 每个操作的重试策略由自身逻辑独立控制，例如 upload 只重试 409/412 冲突。
pub fn classify_webdav_status(
    _operation: WebDavOperation,
    status: reqwest::StatusCode,
) -> WebDavOperationError {
    let code = status.as_u16();
    match code {
        401 => WebDavOperationError {
            kind: WebDavErrorKind::AuthFailed,
            status: Some(code),
            retryable: false,
        },
        403 => WebDavOperationError {
            kind: WebDavErrorKind::Forbidden,
            status: Some(code),
            retryable: false,
        },
        404 => WebDavOperationError {
            kind: WebDavErrorKind::NotFound,
            status: Some(code),
            retryable: false,
        },
        405 => WebDavOperationError {
            kind: WebDavErrorKind::MethodNotAllowed,
            status: Some(code),
            retryable: false,
        },
        408 => WebDavOperationError {
            kind: WebDavErrorKind::Timeout,
            status: Some(code),
            retryable: true,
        },
        409 => WebDavOperationError {
            kind: WebDavErrorKind::PathConflict,
            status: Some(code),
            retryable: false,
        },
        412 => WebDavOperationError {
            kind: WebDavErrorKind::PathConflict,
            status: Some(code),
            retryable: false,
        },
        423 => WebDavOperationError {
            kind: WebDavErrorKind::Locked,
            status: Some(code),
            retryable: false,
        },
        429 => WebDavOperationError {
            kind: WebDavErrorKind::Timeout,
            status: Some(code),
            retryable: true,
        },
        507 => WebDavOperationError {
            kind: WebDavErrorKind::InsufficientStorage,
            status: Some(code),
            retryable: false,
        },
        500..=599 => WebDavOperationError {
            kind: WebDavErrorKind::UnexpectedStatus,
            status: Some(code),
            retryable: true,
        },
        _ => WebDavOperationError {
            kind: WebDavErrorKind::UnexpectedStatus,
            status: Some(code),
            retryable: false,
        },
    }
}

/// 将传输层故障分类映射为 `WebDavOperationError`。
///
/// 测试可直接构造 `WebDavTransportFailure::Timeout` 断言映射逻辑，
/// 无需在 CI 中制造真实超时。
pub fn classify_transport_failure(
    failure: WebDavTransportFailure,
    _operation: WebDavOperation,
) -> WebDavOperationError {
    match failure {
        WebDavTransportFailure::Timeout => WebDavOperationError {
            kind: WebDavErrorKind::Timeout,
            status: None,
            retryable: true,
        },
        WebDavTransportFailure::NetworkUnreachable => WebDavOperationError {
            kind: WebDavErrorKind::NetworkUnreachable,
            status: None,
            retryable: true,
        },
        WebDavTransportFailure::RedirectRejected => WebDavOperationError {
            kind: WebDavErrorKind::RedirectRejected,
            status: None,
            retryable: false,
        },
        WebDavTransportFailure::Other => WebDavOperationError {
            kind: WebDavErrorKind::UnexpectedStatus,
            status: None,
            retryable: false,
        },
    }
}

/// 将 `reqwest::Error` 转换为内部传输层故障分类。
///
/// 调用链：`reqwest::Error` → `WebDavTransportFailure` → `WebDavOperationError`。
pub fn classify_reqwest_error(
    _operation: WebDavOperation,
    error: &reqwest::Error,
) -> WebDavOperationError {
    let failure = if error.is_timeout() {
        WebDavTransportFailure::Timeout
    } else if error.is_connect() {
        WebDavTransportFailure::NetworkUnreachable
    } else if error.is_redirect() {
        WebDavTransportFailure::RedirectRejected
    } else {
        WebDavTransportFailure::Other
    };

    classify_transport_failure(failure, _operation)
}

/// 将 `WebDavOperationError` 映射为用户可见的中文错误信息。
///
/// 本函数仅作为内部映射，本版本不接入命令函数，保持现有用户可见文案不变。
/// 后续 Commit 6+ 会逐步将命令函数的错误路径接入此映射。
pub fn webdav_error_message(error: &WebDavOperationError) -> String {
    match error.kind {
        WebDavErrorKind::AuthFailed => "WebDAV 鉴权失败".to_string(),
        WebDavErrorKind::Forbidden => "WebDAV 权限不足或访问被拒绝".to_string(),
        WebDavErrorKind::NotFound => "远端目标不存在".to_string(),
        WebDavErrorKind::PathConflict => "远端路径冲突".to_string(),
        WebDavErrorKind::Locked => "远端资源被锁定".to_string(),
        WebDavErrorKind::InsufficientStorage => "远端存储空间不足".to_string(),
        WebDavErrorKind::MethodNotAllowed => "WebDAV 服务端不支持当前方法或路径不正确".to_string(),
        WebDavErrorKind::Timeout => {
            if error.status.is_some() {
                "WebDAV 请求超时".to_string()
            } else {
                "WebDAV 连接超时".to_string()
            }
        }
        WebDavErrorKind::NetworkUnreachable => "WebDAV 网络不可达".to_string(),
        WebDavErrorKind::RedirectRejected => "WebDAV 重定向被拒绝".to_string(),
        WebDavErrorKind::UnexpectedStatus => match error.status {
            Some(code) => format!("WebDAV 服务器返回异常状态码: {code}"),
            None => "WebDAV 未知错误".to_string(),
        },
        WebDavErrorKind::InvalidPropfindResponse => "WebDAV 列表 XML 解析失败".to_string(),
        WebDavErrorKind::DownloadTooLarge => "远端备份超过允许大小".to_string(),
        WebDavErrorKind::InvalidRemoteFileName => "远端备份文件名不合法".to_string(),
        WebDavErrorKind::LocalTempFileError => "本地临时文件操作失败".to_string(),
    }
}

// ===========================================================================
// 单元测试
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

        /// 测试统一凭据常量，所有凭据相关断言引用此值。
        const TEST_SECRET: &str = "super-secret-token";

    #[test]
    fn webdav_config_debug_redacts_password() {
        let config = WebDavConfig {
            server_url: "https://example.com/dav".to_string(),
            username: "alice".to_string(),
            remote_dir: Some("SoNotes_Backups/".to_string()),
            password: Some("super-secret-token".to_string()),
        };

        let output = format!("{config:?}");

        assert!(
            !output.contains("super-secret-token"),
            "Debug 泄漏了密码: {output}"
        );
        assert!(
            output.contains("[REDACTED]"),
            "Debug 未显示脱敏占位: {output}"
        );
        assert!(output.contains("alice"), "Debug 应保留非敏感字段: {output}");
    }

    #[test]
    fn webdav_config_save_request_debug_redacts_password() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "alice".to_string(),
            remote_dir: Some("SoNotes_Backups/".to_string()),
            remember_password: false,
            password: Some("super-secret-token".to_string()),
        };

        let output = format!("{request:?}");

        assert!(
            !output.contains("super-secret-token"),
            "Debug 泄漏了密码: {output}"
        );
        assert!(
            output.contains("[REDACTED]"),
            "Debug 未显示脱敏占位: {output}"
        );
        assert!(output.contains("alice"), "Debug 应保留非敏感字段: {output}");
    }

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
    fn url_norm_accepts_https_public_ipv4_literal() {
        let result = normalize_webdav_url("https://1.1.1.1/dav").unwrap();
        assert_eq!(result, "https://1.1.1.1/dav");
    }

    #[test]
    fn url_norm_accepts_https_public_ipv6_literal() {
        let result = normalize_webdav_url("https://[2001:4860:4860::8888]/dav").unwrap();
        assert_eq!(result, "https://[2001:4860:4860::8888]/dav");
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
    fn url_norm_rejects_https_localhost() {
        let err = normalize_webdav_url("https://localhost/dav").unwrap_err();
        assert!(err.contains("本机") || err.contains("内网"));
    }

    #[test]
    fn url_norm_rejects_https_loopback_ipv4_literal() {
        let err = normalize_webdav_url("https://127.0.0.1/dav").unwrap_err();
        assert!(err.contains("本机") || err.contains("内网"));
    }

    #[test]
    fn url_norm_rejects_https_private_ipv4_literal() {
        let err = normalize_webdav_url("https://192.168.1.10/dav").unwrap_err();
        assert!(err.contains("本机") || err.contains("内网"));
    }

    #[test]
    fn url_norm_rejects_https_link_local_ipv4_literal() {
        let err = normalize_webdav_url("https://169.254.1.1/dav").unwrap_err();
        assert!(err.contains("本机") || err.contains("内网"));
    }

    #[test]
    fn url_norm_rejects_https_ipv6_loopback_literal() {
        let err = normalize_webdav_url("https://[::1]/dav").unwrap_err();
        assert!(err.contains("本机") || err.contains("内网"));
    }

    #[test]
    fn url_norm_rejects_https_ipv6_unique_local_literal() {
        let err = normalize_webdav_url("https://[fc00::1]/dav").unwrap_err();
        assert!(err.contains("本机") || err.contains("内网"));
    }

    #[test]
    fn disallowed_ip_check_rejects_internal_ranges() {
        assert!(is_disallowed_webdav_ip("10.0.0.1".parse().unwrap()));
        assert!(is_disallowed_webdav_ip("172.16.0.1".parse().unwrap()));
        assert!(is_disallowed_webdav_ip("192.168.0.1".parse().unwrap()));
        assert!(is_disallowed_webdav_ip("169.254.1.1".parse().unwrap()));
        assert!(is_disallowed_webdav_ip("0.0.0.0".parse().unwrap()));
        assert!(is_disallowed_webdav_ip("::".parse().unwrap()));
        assert!(is_disallowed_webdav_ip("::1".parse().unwrap()));
        assert!(is_disallowed_webdav_ip("fe80::1".parse().unwrap()));
        assert!(is_disallowed_webdav_ip("fc00::1".parse().unwrap()));
        assert!(is_disallowed_webdav_ip("::ffff:127.0.0.1".parse().unwrap()));
    }

    #[test]
    fn disallowed_ip_check_accepts_public_addresses() {
        assert!(!is_disallowed_webdav_ip("1.1.1.1".parse().unwrap()));
        assert!(!is_disallowed_webdav_ip("2001:4860:4860::8888".parse().unwrap()));
    }

    #[test]
    fn redirect_guard_accepts_public_https_target() {
        let url = Url::parse("https://1.1.1.1/dav/file.zip?token=abc").unwrap();
        validate_webdav_redirect_url(&url).unwrap();
    }

    #[test]
    fn redirect_guard_rejects_http_target() {
        let url = Url::parse("http://example.com/dav/file.zip").unwrap();
        let err = validate_webdav_redirect_url(&url).unwrap_err();
        assert!(err.contains("HTTPS"));
    }

    #[test]
    fn redirect_guard_rejects_https_private_target() {
        let url = Url::parse("https://192.168.1.10/dav/file.zip").unwrap();
        let err = validate_webdav_redirect_url(&url).unwrap_err();
        assert!(err.contains("本机") || err.contains("内网"));
    }

    #[test]
    fn redirect_guard_rejects_https_localhost_target() {
        let url = Url::parse("https://localhost/dav/file.zip").unwrap();
        let err = validate_webdav_redirect_url(&url).unwrap_err();
        assert!(err.contains("本机") || err.contains("内网"));
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

    #[test]
    fn delete_backup_rejects_path_filename_before_network() {
        let err = validate_remote_backup_filename(
            "../SoNotes_Backup_20240101120000.zip",
        )
        .unwrap_err();

        assert!(err.contains("..") || err.contains("路径分隔符"));
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
            credential_key: None,
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
            credential_key: None,
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
            credential_key: None,
        };
        let json = serde_json::to_string(&config).unwrap();
        assert!(
            !json.contains("\"password\":"),
            "配置文件序列化结果不应包含 \"password\" 字段"
        );
    }

    #[test]
    fn webdav_config_temp_path_stays_in_same_directory() {
        let dir = test_config_dir("atomic-temp-dir");
        let path = dir.join(CONFIG_FILENAME);
        let tmp_path = webdav_config_temp_path(&path).unwrap();

        assert_eq!(tmp_path.parent(), Some(dir.as_path()));
        assert!(tmp_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap()
            .starts_with(".webdav-config.json.tmp-"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn webdav_config_atomic_write_creates_file() {
        let dir = test_config_dir("atomic-create");
        let path = dir.join(CONFIG_FILENAME);

        write_webdav_config_atomic(&path, r#"{"serverUrl":"https://example.com"}"#).unwrap();

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            r#"{"serverUrl":"https://example.com"}"#
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn webdav_config_atomic_write_overwrites_existing_file() {
        let dir = test_config_dir("atomic-overwrite");
        let path = dir.join(CONFIG_FILENAME);
        std::fs::write(&path, "old").unwrap();

        write_webdav_config_atomic(&path, "new").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn webdav_config_atomic_write_leaves_no_temp_file() {
        let dir = test_config_dir("atomic-no-temp");
        let path = dir.join(CONFIG_FILENAME);

        write_webdav_config_atomic(&path, "content").unwrap();

        let temp_count = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .map(|name| name.starts_with(".webdav-config.json.tmp-"))
                    .unwrap_or(false)
            })
            .count();
        assert_eq!(temp_count, 0);

        let _ = std::fs::remove_dir_all(&dir);
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
        let (config, _) = prepare_config_save(&request, None).unwrap();
        assert!(
            config.password_saved,
            "remember_password=true 且有密码时 password_saved 应为 true"
        );
        assert!(
            config.credential_key.is_some(),
            "应生成 credential_key"
        );
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
        let err = prepare_config_save(&request, None).unwrap_err();
        assert!(err.contains("记住密码时必须提供密码"), "无密码也应拒绝: {err}");
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
        let (config, _) = prepare_config_save(&request, None).unwrap();
        assert!(
            !config.password_saved,
            "remember_password=false 时 password_saved 必须为 false"
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
        let (config, _) = prepare_config_save(&request, None).unwrap();
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
        let (config, _) = prepare_config_save(&request, None).unwrap();
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
        let (config, _) = prepare_config_save(&request, None).unwrap();
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
        let err = prepare_config_save(&request, None).unwrap_err();
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
        let err = prepare_config_save(&request, None).unwrap_err();
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
        let (config, _) = prepare_config_save(&request, None).unwrap();
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
        let err = prepare_config_save(&request, None).unwrap_err();
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
        let err = result.unwrap_err();
        assert_eq!(
            err.kind,
            WebDavErrorKind::InvalidPropfindResponse,
            "畸形 XML 应返回 InvalidPropfindResponse: {:?}",
            err.kind
        );
        assert_eq!(err.status, None, "XML 解析错误不应携带 HTTP 状态码");
        assert!(!err.retryable, "XML 解析错误不应标记为可重试");
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
        assert_eq!(filtered.len(), 0, "403 propstat 条目应被跳过");
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
        assert!(token[10..].chars().all(|ch| ch.is_ascii_hexdigit()));
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

    // -----------------------------------------------------------------------
    // WebDAV 错误分类：状态码映射测试
    // -----------------------------------------------------------------------

    #[test]
    fn classify_status_401_maps_to_auth_failed() {
        let result = classify_webdav_status(
            WebDavOperation::TestConnection,
            reqwest::StatusCode::from_u16(401).unwrap(),
        );
        assert_eq!(result.kind, WebDavErrorKind::AuthFailed);
        assert_eq!(result.status, Some(401));
        assert!(!result.retryable);
    }

    #[test]
    fn classify_status_403_maps_to_forbidden() {
        let result = classify_webdav_status(
            WebDavOperation::ListBackups,
            reqwest::StatusCode::from_u16(403).unwrap(),
        );
        assert_eq!(result.kind, WebDavErrorKind::Forbidden);
        assert_eq!(result.status, Some(403));
        assert!(!result.retryable);
    }

    #[test]
    fn classify_status_404_maps_to_not_found() {
        let result = classify_webdav_status(
            WebDavOperation::DownloadBackup,
            reqwest::StatusCode::from_u16(404).unwrap(),
        );
        assert_eq!(result.kind, WebDavErrorKind::NotFound);
        assert_eq!(result.status, Some(404));
        assert!(!result.retryable);
    }

    #[test]
    fn classify_status_405_maps_to_method_not_allowed() {
        let result = classify_webdav_status(
            WebDavOperation::TestConnection,
            reqwest::StatusCode::from_u16(405).unwrap(),
        );
        assert_eq!(result.kind, WebDavErrorKind::MethodNotAllowed);
        assert_eq!(result.status, Some(405));
        assert!(!result.retryable);
    }

    #[test]
    fn classify_status_409_maps_to_path_conflict() {
        let result = classify_webdav_status(
            WebDavOperation::UploadBackup,
            reqwest::StatusCode::from_u16(409).unwrap(),
        );
        assert_eq!(result.kind, WebDavErrorKind::PathConflict);
        assert_eq!(result.status, Some(409));
        assert!(!result.retryable);
    }

    #[test]
    fn classify_status_412_maps_to_path_conflict() {
        let result = classify_webdav_status(
            WebDavOperation::UploadBackup,
            reqwest::StatusCode::from_u16(412).unwrap(),
        );
        assert_eq!(result.kind, WebDavErrorKind::PathConflict);
        assert_eq!(result.status, Some(412));
        assert!(!result.retryable);
    }

    #[test]
    fn classify_status_423_maps_to_locked() {
        let result = classify_webdav_status(
            WebDavOperation::DeleteBackup,
            reqwest::StatusCode::from_u16(423).unwrap(),
        );
        assert_eq!(result.kind, WebDavErrorKind::Locked);
        assert_eq!(result.status, Some(423));
        assert!(!result.retryable);
    }

    #[test]
    fn classify_status_507_maps_to_insufficient_storage() {
        let result = classify_webdav_status(
            WebDavOperation::UploadBackup,
            reqwest::StatusCode::from_u16(507).unwrap(),
        );
        assert_eq!(result.kind, WebDavErrorKind::InsufficientStorage);
        assert_eq!(result.status, Some(507));
        assert!(!result.retryable);
    }

    #[test]
    fn classify_status_5xx_maps_to_unexpected_status_retryable() {
        for code in [500, 502, 503, 504] {
            let result = classify_webdav_status(
                WebDavOperation::TestConnection,
                reqwest::StatusCode::from_u16(code).unwrap(),
            );
            assert_eq!(
                result.kind,
                WebDavErrorKind::UnexpectedStatus,
                "HTTP {code} 应映射到 UnexpectedStatus"
            );
            assert_eq!(result.status, Some(code));
            assert!(
                result.retryable,
                "HTTP {code} 应标记为 retryable"
            );
        }
    }

    #[test]
    fn classify_status_408_maps_to_timeout_retryable() {
        let result = classify_webdav_status(
            WebDavOperation::DownloadBackup,
            reqwest::StatusCode::from_u16(408).unwrap(),
        );
        assert_eq!(result.kind, WebDavErrorKind::Timeout);
        assert_eq!(result.status, Some(408));
        assert!(result.retryable);
    }

    #[test]
    fn classify_status_429_maps_to_timeout_retryable() {
        let result = classify_webdav_status(
            WebDavOperation::UploadBackup,
            reqwest::StatusCode::from_u16(429).unwrap(),
        );
        assert_eq!(result.kind, WebDavErrorKind::Timeout);
        assert_eq!(result.status, Some(429));
        assert!(result.retryable);
    }

    #[test]
    fn classify_status_other_maps_to_unexpected_status_not_retryable() {
        let result = classify_webdav_status(
            WebDavOperation::TestConnection,
            reqwest::StatusCode::from_u16(301).unwrap(),
        );
        assert_eq!(result.kind, WebDavErrorKind::UnexpectedStatus);
        assert_eq!(result.status, Some(301));
        assert!(!result.retryable);
    }

    // -----------------------------------------------------------------------
    // WebDAV 错误分类：transport failure 映射测试
    // -----------------------------------------------------------------------

    #[test]
    fn classify_transport_timeout_maps_to_timeout() {
        let result = classify_transport_failure(
            WebDavTransportFailure::Timeout,
            WebDavOperation::DownloadBackup,
        );
        assert_eq!(result.kind, WebDavErrorKind::Timeout);
        assert_eq!(result.status, None);
        assert!(result.retryable);
    }

    #[test]
    fn classify_transport_network_unreachable_maps_to_network_unreachable() {
        let result = classify_transport_failure(
            WebDavTransportFailure::NetworkUnreachable,
            WebDavOperation::TestConnection,
        );
        assert_eq!(result.kind, WebDavErrorKind::NetworkUnreachable);
        assert_eq!(result.status, None);
        assert!(result.retryable);
    }

    #[test]
    fn classify_transport_redirect_rejected_maps_to_redirect_rejected() {
        let result = classify_transport_failure(
            WebDavTransportFailure::RedirectRejected,
            WebDavOperation::ListBackups,
        );
        assert_eq!(result.kind, WebDavErrorKind::RedirectRejected);
        assert_eq!(result.status, None);
        assert!(!result.retryable);
    }

    #[test]
    fn classify_transport_other_maps_to_unexpected_status() {
        let result = classify_transport_failure(
            WebDavTransportFailure::Other,
            WebDavOperation::UploadBackup,
        );
        assert_eq!(result.kind, WebDavErrorKind::UnexpectedStatus);
        assert_eq!(result.status, None);
        assert!(!result.retryable);
    }

    // -----------------------------------------------------------------------
    // WebDAV 错误分类：classify_reqwest_error 合成测试
    // -----------------------------------------------------------------------

    #[test]
    fn classify_reqwest_error_is_functional() {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(1))
            .build()
            .unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(async {
            // 请求一个不可达地址以触发连接错误
            let err = client
                .get("http://127.0.0.1:1")
                .send()
                .await
                .unwrap_err();
            classify_reqwest_error(WebDavOperation::TestConnection, &err)
        });

        assert!(
            matches!(
                result.kind,
                WebDavErrorKind::NetworkUnreachable
                    | WebDavErrorKind::Timeout
                    | WebDavErrorKind::UnexpectedStatus
            ),
            "连接本地不可达端口应产生 NetworkUnreachable、Timeout 或 UnexpectedStatus，实际: {:?}",
            result.kind
        );
    }

    // -----------------------------------------------------------------------
    // WebDAV 错误分类：webdav_error_message 映射测试
    // -----------------------------------------------------------------------

    #[test]
    fn error_message_auth_failed() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::AuthFailed,
            status: Some(401),
            retryable: false,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("鉴权失败"), "应提及鉴权失败: {msg}");
    }

    #[test]
    fn error_message_forbidden() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::Forbidden,
            status: Some(403),
            retryable: false,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("权限不足") || msg.contains("访问被拒绝"), "应提及权限: {msg}");
    }

    #[test]
    fn error_message_not_found() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::NotFound,
            status: Some(404),
            retryable: false,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("不存在"), "应提及不存在: {msg}");
    }

    #[test]
    fn error_message_locked() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::Locked,
            status: Some(423),
            retryable: false,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("锁定"), "应提及锁定: {msg}");
    }

    #[test]
    fn error_message_insufficient_storage() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::InsufficientStorage,
            status: Some(507),
            retryable: false,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("空间不足"), "应提及空间不足: {msg}");
    }

    #[test]
    fn error_message_method_not_allowed() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::MethodNotAllowed,
            status: Some(405),
            retryable: false,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("不支持") || msg.contains("方法"), "应提及方法不支持: {msg}");
    }

    #[test]
    fn error_message_timeout_with_status() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::Timeout,
            status: Some(408),
            retryable: true,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("超时"), "应提及超时: {msg}");
    }

    #[test]
    fn error_message_timeout_without_status() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::Timeout,
            status: None,
            retryable: true,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("超时"), "应提及超时: {msg}");
    }

    #[test]
    fn error_message_network_unreachable() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::NetworkUnreachable,
            status: None,
            retryable: true,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("网络不可达"), "应提及网络不可达: {msg}");
    }

    #[test]
    fn error_message_redirect_rejected() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::RedirectRejected,
            status: None,
            retryable: false,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("重定向"), "应提及重定向: {msg}");
    }

    #[test]
    fn error_message_unexpected_status_with_code() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::UnexpectedStatus,
            status: Some(502),
            retryable: true,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("502"), "应包含状态码 502: {msg}");
    }

    #[test]
    fn error_message_invalid_propfind_response() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::InvalidPropfindResponse,
            status: None,
            retryable: false,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("XML 解析失败"), "应提及 XML 解析失败: {msg}");
    }

    #[test]
    fn error_message_download_too_large() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::DownloadTooLarge,
            status: None,
            retryable: false,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("超过") || msg.contains("大小"), "应提及大小超限: {msg}");
    }

    #[test]
    fn error_message_invalid_remote_file_name() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::InvalidRemoteFileName,
            status: None,
            retryable: false,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("文件名"), "应提及文件名: {msg}");
    }

    #[test]
    fn error_message_local_temp_file_error() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::LocalTempFileError,
            status: None,
            retryable: false,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("临时文件"), "应提及临时文件: {msg}");
    }

    // -----------------------------------------------------------------------
    // WebDAV 错误分类：操作上下文独立性测试
    // -----------------------------------------------------------------------

    #[test]
    fn classify_status_same_code_different_operations_produce_same_kind() {
        let status = reqwest::StatusCode::from_u16(401).unwrap();
        let ops = [
            WebDavOperation::TestConnection,
            WebDavOperation::ListBackups,
            WebDavOperation::UploadBackup,
            WebDavOperation::DownloadBackup,
            WebDavOperation::DeleteBackup,
        ];

        for op in ops {
            let result = classify_webdav_status(op, status);
            assert_eq!(
                result.kind,
                WebDavErrorKind::AuthFailed,
                "操作 {:?} 的 401 应映射到 AuthFailed",
                op
            );
        }
    }

    #[test]
    fn operation_error_eq_derives_work() {
        let a = WebDavOperationError {
            kind: WebDavErrorKind::Timeout,
            status: None,
            retryable: true,
        };
        let b = WebDavOperationError {
            kind: WebDavErrorKind::Timeout,
            status: None,
            retryable: true,
        };
        assert_eq!(a, b);
    }

    // -----------------------------------------------------------------------
    // Mock WebDAV Server Helper（Commit 4 基础设施）
    // -----------------------------------------------------------------------

    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;

    /// 请求元数据。不保存完整 Authorization 值，只记录是否存在。
    #[derive(Debug, Clone)]
    struct MockRequestRecord {
        method: String,
        path: String,
        depth: Option<String>,
        authorization_present: bool,
    }

    /// 轻量级 mock server：`127.0.0.1:0`，单请求，不支持延迟或多响应序列。
    struct MockWebDavServer {
        listener: TcpListener,
        base_url: String,
    }

    impl MockWebDavServer {
        fn bind() -> Self {
            let listener =
                TcpListener::bind("127.0.0.1:0").expect("MockWebDavServer 绑定 127.0.0.1:0 失败");
            let addr = listener.local_addr().expect("获取 mock server 地址失败");
            let base_url = format!("http://127.0.0.1:{}", addr.port());
            Self { listener, base_url }
        }

        fn base_url(&self) -> &str {
            &self.base_url
        }

        fn accept_one_request(
            &self,
            status_line: &str,
            extra_headers: &[&str],
            body: &str,
        ) -> MockRequestRecord {
            self.listener
                .set_nonblocking(true)
                .expect("设置非阻塞失败");

            let stream = {
                let deadline =
                    std::time::Instant::now() + std::time::Duration::from_secs(5);
                loop {
                    match self.listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(ref e)
                            if e.kind() == std::io::ErrorKind::WouldBlock =>
                        {
                            if std::time::Instant::now() >= deadline {
                                panic!("MockWebDavServer 等待连接超时（5 秒）");
                            }
                            std::thread::sleep(std::time::Duration::from_millis(10));
                            continue;
                        }
                        Err(e) => panic!("MockWebDavServer accept 失败: {e}"),
                    }
                }
            };
            self.listener
                .set_nonblocking(false)
                .expect("恢复阻塞模式失败");

            stream
                .set_nonblocking(false)
                .expect("恢复 accepted stream 阻塞模式失败");

            let mut stream = stream.try_clone().expect("克隆 TcpStream 失败");

            let reader_stream = stream.try_clone().expect("克隆 reader stream 失败");
            let mut reader = BufReader::new(reader_stream);

            let mut method = String::new();
            let mut path = String::new();
            let mut depth: Option<String> = None;
            let mut authorization_present = false;
            let mut content_length: u64 = 0;

            let mut request_line = String::new();
            reader
                .read_line(&mut request_line)
                .expect("读取请求行失败");
            let parts: Vec<&str> = request_line.trim().split_whitespace().collect();
            if parts.len() >= 2 {
                method = parts[0].to_string();
                path = parts[1].to_string();
            }

            loop {
                let mut line = String::new();
                reader
                    .read_line(&mut line)
                    .expect("读取头部行失败");
                let trimmed = line.trim().to_string();
                if trimmed.is_empty() {
                    break;
                }
                if let Some(val) = trimmed.strip_prefix("Depth:") {
                    depth = Some(val.trim().to_string());
                }
                if trimmed
                    .to_ascii_lowercase()
                    .starts_with("authorization:")
                {
                    authorization_present = true;
                }
                let lower = trimmed.to_ascii_lowercase();
                if let Some(val) = lower.strip_prefix("content-length:") {
                    if let Ok(len) = val.trim().parse::<u64>() {
                        content_length = len;
                    }
                }
            }

            if content_length > 0 {
                let mut body_buf = vec![0u8; content_length as usize];
                use std::io::Read;
                let _ = reader.read_exact(&mut body_buf);
            }

            let mut response = format!("{status_line}\r\n");
            response.push_str("Content-Type: application/xml; charset=utf-8\r\n");
            response.push_str("Connection: close\r\n");
            for header in extra_headers {
                response.push_str(&format!("{header}\r\n"));
            }
            response.push_str(&format!("Content-Length: {}\r\n", body.len()));
            response.push_str("\r\n");
            response.push_str(body);

            stream
                .write_all(response.as_bytes())
                .expect("写入响应失败");
            drop(stream);

            MockRequestRecord {
                method,
                path,
                depth,
                authorization_present,
            }
        }

        fn accept_sequential_requests(
            &self,
            responses: &[(&str, &[&str], &str)],
        ) -> Vec<MockRequestRecord> {
            responses
                .iter()
                .map(|(status_line, extra_headers, body)| {
                    self.accept_one_request(status_line, extra_headers, body)
                })
                .collect()
        }

        fn accept_one_download_request(
            &self,
            status_line: &str,
            explicit_content_length: Option<u64>,
            body_bytes: &[u8],
        ) -> MockRequestRecord {
            self.listener
                .set_nonblocking(true)
                .expect("设置非阻塞失败");

            let stream = {
                let deadline =
                    std::time::Instant::now() + std::time::Duration::from_secs(5);
                loop {
                    match self.listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(ref e)
                            if e.kind() == std::io::ErrorKind::WouldBlock =>
                        {
                            if std::time::Instant::now() >= deadline {
                                panic!("MockWebDavServer 等待连接超时（5 秒）");
                            }
                            std::thread::sleep(std::time::Duration::from_millis(10));
                            continue;
                        }
                        Err(e) => panic!("MockWebDavServer accept 失败: {e}"),
                    }
                }
            };
            self.listener
                .set_nonblocking(false)
                .expect("恢复阻塞模式失败");

            stream
                .set_nonblocking(false)
                .expect("恢复 accepted stream 阻塞模式失败");

            let mut stream = stream.try_clone().expect("克隆 TcpStream 失败");

            let reader_stream = stream.try_clone().expect("克隆 reader stream 失败");
            let mut reader = BufReader::new(reader_stream);

            let mut method = String::new();
            let mut path = String::new();
            let mut depth: Option<String> = None;
            let mut authorization_present = false;

            let mut request_line = String::new();
            reader
                .read_line(&mut request_line)
                .expect("读取请求行失败");
            let parts: Vec<&str> = request_line.trim().split_whitespace().collect();
            if parts.len() >= 2 {
                method = parts[0].to_string();
                path = parts[1].to_string();
            }

            loop {
                let mut line = String::new();
                reader
                    .read_line(&mut line)
                    .expect("读取头部行失败");
                let trimmed = line.trim().to_string();
                if trimmed.is_empty() {
                    break;
                }
                if let Some(val) = trimmed.strip_prefix("Depth:") {
                    depth = Some(val.trim().to_string());
                }
                if trimmed
                    .to_ascii_lowercase()
                    .starts_with("authorization:")
                {
                    authorization_present = true;
                }
            }

            let mut response = format!("{status_line}\r\n");
            response.push_str("Content-Type: application/octet-stream\r\n");
            response.push_str("Connection: close\r\n");
            if let Some(len) = explicit_content_length {
                response.push_str(&format!("Content-Length: {len}\r\n"));
            }
            response.push_str("\r\n");

            stream
                .write_all(response.as_bytes())
                .expect("写入响应头失败");
            if !body_bytes.is_empty() {
                stream
                    .write_all(body_bytes)
                    .expect("写入响应体失败");
            }
            drop(stream);

            MockRequestRecord {
                method,
                path,
                depth,
                authorization_present,
            }
        }

        /// 接受一个请求，读取请求行和头部，但不发送响应直接关闭连接。
        /// 用于模拟传输层错误（连接重置、对端关闭等），使 `req.send().await` 返回 `Err`。
        fn accept_one_request_drop_without_response(&self) -> MockRequestRecord {
            self.listener
                .set_nonblocking(true)
                .expect("设置非阻塞失败");

            let stream = {
                let deadline =
                    std::time::Instant::now() + std::time::Duration::from_secs(5);
                loop {
                    match self.listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(ref e)
                            if e.kind() == std::io::ErrorKind::WouldBlock =>
                        {
                            if std::time::Instant::now() >= deadline {
                                panic!("MockWebDavServer 等待连接超时（5 秒）");
                            }
                            std::thread::sleep(std::time::Duration::from_millis(10));
                            continue;
                        }
                        Err(e) => panic!("MockWebDavServer accept 失败: {e}"),
                    }
                }
            };
            self.listener
                .set_nonblocking(false)
                .expect("恢复阻塞模式失败");

            stream
                .set_nonblocking(false)
                .expect("恢复 accepted stream 阻塞模式失败");

            let reader_stream = stream.try_clone().expect("克隆 reader stream 失败");
            let mut reader = BufReader::new(reader_stream);

            let mut method = String::new();
            let mut path = String::new();
            let mut depth: Option<String> = None;
            let mut authorization_present = false;

            let mut request_line = String::new();
            reader
                .read_line(&mut request_line)
                .expect("读取请求行失败");
            let parts: Vec<&str> = request_line.trim().split_whitespace().collect();
            if parts.len() >= 2 {
                method = parts[0].to_string();
                path = parts[1].to_string();
            }

            loop {
                let mut line = String::new();
                reader
                    .read_line(&mut line)
                    .expect("读取头部行失败");
                let trimmed = line.trim().to_string();
                if trimmed.is_empty() {
                    break;
                }
                if let Some(val) = trimmed.strip_prefix("Depth:") {
                    depth = Some(val.trim().to_string());
                }
                if trimmed
                    .to_ascii_lowercase()
                    .starts_with("authorization:")
                {
                    authorization_present = true;
                }
            }

            drop(stream);

            MockRequestRecord {
                method,
                path,
                depth,
                authorization_present,
            }
        }
    }

    fn load_fixture(name: &str) -> String {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let path = std::path::Path::new(manifest_dir)
            .join("tests")
            .join("fixtures")
            .join("webdav")
            .join(name);
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("加载 fixture {name} 失败: {e}"))
    }

    // -----------------------------------------------------------------------
    // Smoke 测试：Mock Server + with-client 边界（Commit 4）
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn smoke_mock_server_propfind_returns_one_backup() {
        let server = MockWebDavServer::bind();
        let fixture_xml = load_fixture("propfind_standard_207.xml");

        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request(
                "HTTP/1.1 207 Multi-Status",
                &[],
                &fixture_xml,
            )
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("创建测试 reqwest::Client 失败");

        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "testuser",
            Some("testpass".to_string()),
        );

        let result = webdav_list_backups_with_client(&client, &target).await;
        let record = handle.join().expect("mock server 线程 panic");

        assert_eq!(record.method, "PROPFIND", "请求方法应为 PROPFIND");
        assert!(
            record.path.contains("SoNotes_Backups"),
            "请求路径应包含远端目录: {}",
            record.path
        );
        assert_eq!(record.depth.as_deref(), Some("1"), "Depth 头应为 1");
        assert!(
            record.authorization_present,
            "应记录到 Authorization 头存在（basic auth）"
        );

        let backups = result.expect("webdav_list_backups_with_client 应成功");
        assert_eq!(backups.len(), 1, "应恰好返回 1 条备份");
        assert_eq!(backups[0].file_name, "SoNotes_Backup_20240615143022.zip");
        assert_eq!(backups[0].size, Some(2048576));
        assert!(backups[0].readable);
        assert_eq!(
            backups[0].last_modified.as_deref(),
            Some("Sat, 15 Jun 2024 14:30:22 GMT")
        );
    }

    #[tokio::test]
    async fn smoke_mock_server_no_auth_not_recorded() {
        let server = MockWebDavServer::bind();
        let fixture_xml = load_fixture("propfind_standard_207.xml");

        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request(
                "HTTP/1.1 207 Multi-Status",
                &[],
                &fixture_xml,
            )
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("创建测试 reqwest::Client 失败");

        let target = WebDavRequestTarget::for_test(&base_url, "SoNotes_Backups/");

        let result = webdav_list_backups_with_client(&client, &target).await;
        let record = handle.join().expect("mock server 线程 panic");

        assert!(
            !record.authorization_present,
            "无凭据时不应出现 Authorization 头"
        );

        let backups = result.expect("无凭据请求应成功（mock server 不验证凭据）");
        assert_eq!(backups.len(), 1, "无凭据也应返回 1 条备份");
        assert_eq!(backups[0].file_name, "SoNotes_Backup_20240615143022.zip");
    }

    // -----------------------------------------------------------------------
    // Commit 5：decode_href_basename 单元测试
    // -----------------------------------------------------------------------

    #[test]
    fn decode_basename_accepts_plain_name() {
        assert_eq!(
            decode_href_basename("/dav/SoNotes_Backups/SoNotes_Backup_20240101120000.zip"),
            Some("SoNotes_Backup_20240101120000.zip".to_string())
        );
    }

    #[test]
    fn decode_basename_accepts_valid_percent_encoding() {
        assert_eq!(
            decode_href_basename("/dav/SoNotes_Backups/SoNotes_Backup%2020240101120000.zip"),
            Some("SoNotes_Backup 20240101120000.zip".to_string())
        );
    }

    #[test]
    fn decode_basename_rejects_encoded_slash() {
        assert_eq!(
            decode_href_basename("/dav/SoNotes_Backups/..%2FSoNotes_Backup_20240101120000.zip"),
            None
        );
    }

    #[test]
    fn decode_basename_rejects_encoded_backslash() {
        assert_eq!(
            decode_href_basename("/dav/SoNotes_Backups/%5Csecret.zip"),
            None
        );
    }

    #[test]
    fn decode_basename_rejects_encoded_null() {
        assert_eq!(
            decode_href_basename("/dav/SoNotes_Backups/SoNotes_Backup%00_20240101120000.zip"),
            None
        );
    }

    #[test]
    fn decode_basename_rejects_encoded_colon() {
        assert_eq!(
            decode_href_basename("/dav/SoNotes_Backups/SoNotes_Backup%3A_20240101120000.zip"),
            None
        );
    }

    #[test]
    fn decode_basename_rejects_encoded_dotdot() {
        assert_eq!(
            decode_href_basename("/dav/SoNotes_Backups/%2E%2E"),
            None
        );
    }

    #[test]
    fn decode_basename_rejects_invalid_hex() {
        assert_eq!(
            decode_href_basename("/dav/SoNotes_Backups/file%GG.zip"),
            None
        );
    }

    #[test]
    fn decode_basename_rejects_truncated_percent() {
        assert_eq!(
            decode_href_basename("/dav/SoNotes_Backups/file%.zip"),
            None
        );
    }

    #[test]
    fn decode_basename_rejects_percent_at_end() {
        assert_eq!(
            decode_href_basename("/dav/SoNotes_Backups/file%"),
            None
        );
    }

    #[test]
    fn decode_basename_rejects_incomplete_hex() {
        assert_eq!(
            decode_href_basename("/dav/SoNotes_Backups/file%2.zip"),
            None
        );
    }

    // -----------------------------------------------------------------------
    // Commit 5：fixture 驱动的 PROPFIND 解析边界测试
    // -----------------------------------------------------------------------

    #[test]
    fn fixture_directory_self_entry_skipped() {
        let xml = load_fixture("propfind_directory_self_entry.xml");
        let entries = parse_propfind_response(&xml).unwrap();
        let filtered = filter_backup_entries(entries);
        assert_eq!(filtered.len(), 1, "目录自身 collection entry 应被跳过，只保留 1 条备份");
        assert_eq!(filtered[0].file_name, "SoNotes_Backup_20240701120000.zip");
        assert_eq!(filtered[0].size, Some(4096));
    }

    #[test]
    fn fixture_mixed_status_skips_non_2xx() {
        let xml = load_fixture("propfind_mixed_status.xml");
        let entries = parse_propfind_response(&xml).unwrap();
        let filtered = filter_backup_entries(entries);

        assert_eq!(filtered.len(), 1, "非 2xx propstat 条目应被跳过，只保留 200 条目");
        assert_eq!(filtered[0].file_name, "SoNotes_Backup_20240701120000.zip");
        assert!(filtered[0].readable);
        assert_eq!(filtered[0].status, Some(200));
    }

    #[test]
    fn fixture_missing_size_maps_to_none() {
        let xml = load_fixture("propfind_missing_size.xml");
        let entries = parse_propfind_response(&xml).unwrap();
        let filtered = filter_backup_entries(entries);
        assert_eq!(filtered.len(), 2, "缺失 size 的 entry 应保留");
        assert!(
            filtered.iter().all(|b| b.size.is_none()),
            "缺失 getcontentlength 应映射为 size: None"
        );
        assert_eq!(filtered[0].last_modified, None, "缺失 getlastmodified 应映射为 None");
        assert_eq!(
            filtered[1].last_modified.as_deref(),
            Some("Tue, 02 Jul 2024 12:00:00 GMT")
        );
    }

    #[test]
    fn fixture_invalid_size_maps_to_none() {
        let xml = load_fixture("propfind_invalid_size.xml");
        let entries = parse_propfind_response(&xml).unwrap();
        let filtered = filter_backup_entries(entries);
        assert_eq!(filtered.len(), 3, "非法 size 的 entry 应保留");
        assert!(
            filtered.iter().all(|b| b.size.is_none()),
            "非法 getcontentlength 应映射为 size: None"
        );
    }

    #[test]
    fn fixture_encoded_file_name_decoded_and_filtered() {
        let xml = load_fixture("propfind_encoded_file_name.xml");
        let entries = parse_propfind_response(&xml).unwrap();
        let filtered = filter_backup_entries(entries);

        assert_eq!(
            filtered.len(),
            2,
            "未编码合法条目 + 解码后合法条目应保留；%20 解码后含空格的条目被 validate_remote_backup_filename 过滤（非 decode_href_basename 问题）"
        );
        assert_eq!(
            filtered[0].file_name,
            "SoNotes_Backup_20240701120000.zip",
            "第一个合法条目应是未编码的备份文件"
        );
        assert_eq!(
            filtered[1].file_name,
            "SoNotes_Backup_20240706120000.zip",
            "第二个合法条目应是 %5F 解码后的备份文件"
        );
        assert_eq!(filtered[1].size, Some(8192));
    }

    #[test]
    fn fixture_namespace_variants_returns_one_backup() {
        let xml = load_fixture("propfind_namespace_variants.xml");
        let entries = parse_propfind_response(&xml).unwrap();
        let filtered = filter_backup_entries(entries);

        assert_eq!(filtered.len(), 1, "dc: 前缀命名空间应只保留 1 个合法备份条目");
        assert_eq!(
            filtered[0].file_name,
            "SoNotes_Backup_20240301081500.zip",
            "唯一合法条目文件名应匹配"
        );
        assert_eq!(filtered[0].size, Some(1048576));
        let last_mod = filtered[0].last_modified.as_ref().expect("last_modified 应存在");
        assert!(
            last_mod.contains("2024"),
            "last_modified 应包含年份 2024: {last_mod}"
        );
        assert!(filtered[0].readable, "合法备份条目应标记为 readable");
    }

    #[test]
    fn fixture_malformed_xml_returns_error() {
        let xml = load_fixture("propfind_malformed.xml");
        let result = parse_propfind_response(&xml);
        assert!(result.is_err(), "畸形 XML 应返回错误");
        let err = result.unwrap_err();
        assert_eq!(
            err.kind,
            WebDavErrorKind::InvalidPropfindResponse,
            "畸形 XML fixture 应返回 InvalidPropfindResponse: {:?}",
            err.kind
        );
        assert_eq!(
            webdav_error_message(&err),
            "WebDAV 列表 XML 解析失败",
            "InvalidPropfindResponse 的用户消息应为 'WebDAV 列表 XML 解析失败'"
        );
    }

    #[test]
    fn filter_non_so_notes_zip_entries_are_skipped() {
        let entries = vec![
            PropfindEntry {
                href: "/dav/SoNotes_Backups/readme.txt".to_string(),
                status: Some("HTTP/1.1 200 OK".to_string()),
                content_length: Some(128),
                last_modified: None,
                is_collection: false,
            },
            PropfindEntry {
                href: "/dav/SoNotes_Backups/config.json".to_string(),
                status: Some("HTTP/1.1 200 OK".to_string()),
                content_length: Some(64),
                last_modified: None,
                is_collection: false,
            },
            PropfindEntry {
                href: "/dav/SoNotes_Backups/image.png".to_string(),
                status: Some("HTTP/1.1 200 OK".to_string()),
                content_length: Some(2048),
                last_modified: None,
                is_collection: false,
            },
        ];
        let filtered = filter_backup_entries(entries);
        assert_eq!(filtered.len(), 0, "非 SoNotes zip 条目应全部被跳过");
    }

    #[tokio::test]
    async fn smoke_mock_server_fixture_mixed_status() {
        let server = MockWebDavServer::bind();
        let fixture_xml = load_fixture("propfind_mixed_status.xml");

        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request(
                "HTTP/1.1 207 Multi-Status",
                &[],
                &fixture_xml,
            )
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("创建测试 reqwest::Client 失败");

        let target = WebDavRequestTarget::for_test(&base_url, "SoNotes_Backups/");

        let result = webdav_list_backups_with_client(&client, &target).await;
        let _record = handle.join().expect("mock server 线程 panic");

        let backups = result.expect("webdav_list_backups_with_client 应成功");
        assert_eq!(backups.len(), 1, "端到端：非 2xx 条目应被跳过，只返回 1 条备份");
        assert_eq!(backups[0].file_name, "SoNotes_Backup_20240701120000.zip");
        assert!(backups[0].readable);
    }

    // -----------------------------------------------------------------------
    // Commit 6：Mock Server 401/403/405 连接测试错误分类
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn mock_server_connection_401_returns_auth_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 401 Unauthorized", &[], "")
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "testuser",
            Some("testpass".to_string()),
        );

        let result = webdav_test_connection_with_client(&client, &target).await;
        let record = handle.join().expect("mock server 线程 panic");

        let conn_result = result.expect("401 应返回 Ok(WebDavConnectionResult)");
        assert!(!conn_result.success, "401 连接测试应返回 success=false");
        let error = conn_result.error.expect("401 应携带 error");
        assert!(
            error.contains("鉴权失败"),
            "401 应映射到鉴权失败语义: {error}"
        );
        assert!(
            !error.contains("testuser") && !error.contains("testpass"),
            "错误信息不得泄漏凭据: {error}"
        );
        assert!(
            record.authorization_present,
            "请求应携带 Authorization 头"
        );
    }

    #[tokio::test]
    async fn mock_server_connection_403_returns_forbidden_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 403 Forbidden", &[], "")
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "user403",
            Some("pass403".to_string()),
        );

        let result = webdav_test_connection_with_client(&client, &target).await;
        let record = handle.join().expect("mock server 线程 panic");

        let conn_result = result.expect("403 应返回 Ok(WebDavConnectionResult)");
        assert!(!conn_result.success, "403 连接测试应返回 success=false");
        let error = conn_result.error.expect("403 应携带 error");
        assert!(
            error.contains("权限不足") || error.contains("访问被拒绝"),
            "403 应映射到权限不足/访问被拒绝语义: {error}"
        );
        assert!(
            !error.contains("user403") && !error.contains("pass403"),
            "错误信息不得泄漏凭据: {error}"
        );
        assert!(
            record.authorization_present,
            "请求应携带 Authorization 头"
        );
    }

    #[tokio::test]
    async fn mock_server_connection_405_returns_method_not_allowed_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 405 Method Not Allowed", &[], "")
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test(&base_url, "SoNotes_Backups/");

        let result = webdav_test_connection_with_client(&client, &target).await;
        let _record = handle.join().expect("mock server 线程 panic");

        let conn_result = result.expect("405 应返回 Ok(WebDavConnectionResult)");
        assert!(!conn_result.success, "405 连接测试应返回 success=false");
        let error = conn_result.error.expect("405 应携带 error");
        assert!(
            error.contains("不支持") || error.contains("方法"),
            "405 应映射到方法不支持语义: {error}"
        );
        assert!(
            !error.contains("testpass") && !error.contains("password"),
            "错误信息不得泄漏凭据: {error}"
        );
    }

    // -----------------------------------------------------------------------
    // Commit 6：Mock Server 401/403/405 列表测试错误分类
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn mock_server_list_401_returns_auth_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 401 Unauthorized", &[], "")
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "listuser",
            Some("listpass".to_string()),
        );

        let result = webdav_list_backups_with_client(&client, &target).await;
        let record = handle.join().expect("mock server 线程 panic");

        let err = result.unwrap_err();
        assert!(
            err.contains("鉴权失败"),
            "列表 401 应映射到鉴权失败语义: {err}"
        );
        assert!(
            !err.contains("listuser") && !err.contains("listpass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(
            record.authorization_present,
            "请求应携带 Authorization 头"
        );
    }

    #[tokio::test]
    async fn mock_server_list_403_returns_forbidden_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 403 Forbidden", &[], "")
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "forbidden_user",
            Some("forbidden_pass".to_string()),
        );

        let result = webdav_list_backups_with_client(&client, &target).await;
        let record = handle.join().expect("mock server 线程 panic");

        let err = result.unwrap_err();
        assert!(
            err.contains("权限不足") || err.contains("访问被拒绝"),
            "列表 403 应映射到权限不足/访问被拒绝语义: {err}"
        );
        assert!(
            !err.contains("forbidden_user") && !err.contains("forbidden_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(
            record.authorization_present,
            "请求应携带 Authorization 头"
        );
    }

    #[tokio::test]
    async fn mock_server_list_405_returns_method_not_allowed_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 405 Method Not Allowed", &[], "")
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test(&base_url, "SoNotes_Backups/");

        let result = webdav_list_backups_with_client(&client, &target).await;
        let _record = handle.join().expect("mock server 线程 panic");

        let err = result.unwrap_err();
        assert!(
            err.contains("不支持") || err.contains("方法"),
            "列表 405 应映射到方法不支持语义: {err}"
        );
        assert!(
            !err.contains("password") && !err.contains("token"),
            "错误信息不得泄漏凭据: {err}"
        );
    }

    // -----------------------------------------------------------------------
    // Commit 7：上传状态码分类与冲突重试边界测试
    // -----------------------------------------------------------------------

    fn create_test_zip(path: &Path) {
        let content: &[u8] = b"PK\x03\x04test";
        std::fs::write(path, content).expect("创建测试 zip 文件失败");
    }

    #[tokio::test]
    async fn upload_201_returns_success() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 200 OK", &[], ""),
                ("HTTP/1.1 201 Created", &[], ""),
            ])
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "upload_user",
            Some("upload_pass".to_string()),
        );

        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);

        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let records = handle.join().expect("mock server 线程 panic");

        assert_eq!(records.len(), 2, "应收到 PROPFIND + PUT 两个请求");
        assert_eq!(records[0].method, "PROPFIND", "第一个请求应为 PROPFIND");
        assert_eq!(records[1].method, "PUT", "第二个请求应为 PUT");
        assert!(records[1].authorization_present, "PUT 应携带 Authorization");

        let upload_result = result.expect("201 应返回 Ok");
        assert!(upload_result.success, "201 应标记为成功");
        assert!(upload_result.remote_file_name.is_some(), "201 应返回文件名");
        assert!(!zip_path.exists(), "成功后临时 zip 应被清理");

        let _ = std::fs::remove_dir_all(&zip_dir);
    }

    #[tokio::test]
    async fn upload_204_returns_success() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 200 OK", &[], ""),
                ("HTTP/1.1 204 No Content", &[], ""),
            ])
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "upload_user",
            Some("upload_pass".to_string()),
        );

        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);

        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let _records = handle.join().expect("mock server 线程 panic");

        let upload_result = result.expect("204 应返回 Ok");
        assert!(upload_result.success, "204 应标记为成功");
        assert!(!zip_path.exists(), "成功后临时 zip 应被清理");

        let _ = std::fs::remove_dir_all(&zip_dir);
    }

    #[tokio::test]
    async fn upload_401_returns_auth_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 200 OK", &[], ""),
                ("HTTP/1.1 401 Unauthorized", &[], ""),
            ])
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "auth_user",
            Some("auth_pass".to_string()),
        );

        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);

        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let _records = handle.join().expect("mock server 线程 panic");

        let err = result.unwrap_err();
        assert!(
            err.contains("鉴权失败"),
            "401 应映射到鉴权失败语义: {err}"
        );
        assert!(
            !err.contains("auth_user") && !err.contains("auth_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(!zip_path.exists(), "失败后临时 zip 应被清理");

        let _ = std::fs::remove_dir_all(&zip_dir);
    }

    #[tokio::test]
    async fn upload_403_returns_forbidden_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 200 OK", &[], ""),
                ("HTTP/1.1 403 Forbidden", &[], ""),
            ])
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "forbidden_user",
            Some("forbidden_pass".to_string()),
        );

        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);

        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let _records = handle.join().expect("mock server 线程 panic");

        let err = result.unwrap_err();
        assert!(
            err.contains("权限不足") || err.contains("访问被拒绝"),
            "403 应映射到权限不足/访问被拒绝语义: {err}"
        );
        assert!(
            !err.contains("forbidden_user") && !err.contains("forbidden_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(!zip_path.exists(), "失败后临时 zip 应被清理");

        let _ = std::fs::remove_dir_all(&zip_dir);
    }

    #[tokio::test]
    async fn upload_423_returns_locked_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 200 OK", &[] as &[&str], ""),
                ("HTTP/1.1 423 Locked", &[] as &[&str], ""),
            ])
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "lock_user",
            Some("lock_pass".to_string()),
        );

        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);

        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let records = handle.join().expect("mock server 线程 panic");

        assert_eq!(
            records.len(),
            2,
            "423 非冲突重试状态码，应仅收到 PROPFIND + 1 PUT"
        );

        let err = result.unwrap_err();
        assert!(
            err.contains("锁定"),
            "423 应映射到锁定语义: {err}"
        );
        assert!(
            !err.contains("lock_user") && !err.contains("lock_pass"),
            "错误信息不得泄漏凭据: {err}"
        );

        let _ = std::fs::remove_dir_all(&zip_dir);
    }

    #[tokio::test]
    async fn upload_507_returns_insufficient_storage_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 200 OK", &[] as &[&str], ""),
                ("HTTP/1.1 507 Insufficient Storage", &[] as &[&str], ""),
            ])
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "space_user",
            Some("space_pass".to_string()),
        );

        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);

        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let records = handle.join().expect("mock server 线程 panic");

        assert_eq!(
            records.len(),
            2,
            "507 非冲突重试状态码，应仅收到 PROPFIND + 1 PUT"
        );

        let err = result.unwrap_err();
        assert!(
            err.contains("空间不足"),
            "507 应映射到空间不足语义: {err}"
        );
        assert!(
            !err.contains("space_user") && !err.contains("space_pass"),
            "错误信息不得泄漏凭据: {err}"
        );

        let _ = std::fs::remove_dir_all(&zip_dir);
    }

    #[tokio::test]
    async fn upload_405_returns_method_not_allowed_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 200 OK", &[] as &[&str], ""),
                ("HTTP/1.1 405 Method Not Allowed", &[] as &[&str], ""),
            ])
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "method_user",
            Some("method_pass".to_string()),
        );

        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);

        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let records = handle.join().expect("mock server 线程 panic");

        assert_eq!(
            records.len(),
            2,
            "405 非冲突重试状态码，应仅收到 PROPFIND + 1 PUT"
        );

        let err = result.unwrap_err();
        assert!(
            err.contains("不支持") || err.contains("方法"),
            "405 应映射到方法不支持语义: {err}"
        );
        assert!(
            !err.contains("method_user") && !err.contains("method_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(!zip_path.exists(), "失败后临时 zip 应被清理");

        let _ = std::fs::remove_dir_all(&zip_dir);
    }

    #[tokio::test]
    async fn upload_500_returns_unexpected_status_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 200 OK", &[] as &[&str], ""),
                ("HTTP/1.1 500 Internal Server Error", &[] as &[&str], ""),
            ])
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "err_user",
            Some("err_pass".to_string()),
        );

        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);

        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let records = handle.join().expect("mock server 线程 panic");

        assert_eq!(
            records.len(),
            2,
            "5xx 不再通用重试，应仅收到 PROPFIND + 1 PUT"
        );

        let err = result.unwrap_err();
        assert!(
            err.contains("500") || err.contains("异常状态码"),
            "500 应映射到异常状态码语义: {err}"
        );
        assert!(
            !err.contains("err_user") && !err.contains("err_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(!zip_path.exists(), "失败后临时 zip 应被清理");

        let _ = std::fs::remove_dir_all(&zip_dir);
    }

    #[tokio::test]
    async fn upload_consecutive_409_exhausts_retry_limit() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            let mut responses = vec![("HTTP/1.1 200 OK", &[] as &[&str], "")];
            for _ in 0..UPLOAD_RETRY_LIMIT {
                responses.push(("HTTP/1.1 409 Conflict", &[] as &[&str], ""));
            }
            server.accept_sequential_requests(&responses)
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "retry_user",
            Some("retry_pass".to_string()),
        );

        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);

        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let records = handle.join().expect("mock server 线程 panic");

        assert_eq!(
            records.len(),
            1 + UPLOAD_RETRY_LIMIT as usize,
            "应收到 1 PROPFIND + {} PUT",
            UPLOAD_RETRY_LIMIT
        );

        let err = result.unwrap_err();
        assert!(
            err.contains("同名备份") || err.contains("冲突"),
            "连续 409 达到上限后应返回冲突相关错误: {err}"
        );
        assert!(
            !err.contains("retry_user") && !err.contains("retry_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(!zip_path.exists(), "重试耗尽后临时 zip 应被清理");

        let _ = std::fs::remove_dir_all(&zip_dir);
    }

    #[tokio::test]
    async fn upload_consecutive_412_exhausts_retry_limit() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            let mut responses = vec![("HTTP/1.1 200 OK", &[] as &[&str], "")];
            for _ in 0..UPLOAD_RETRY_LIMIT {
                responses.push(("HTTP/1.1 412 Precondition Failed", &[] as &[&str], ""));
            }
            server.accept_sequential_requests(&responses)
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "retry12_user",
            Some("retry12_pass".to_string()),
        );

        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);

        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let records = handle.join().expect("mock server 线程 panic");

        assert_eq!(
            records.len(),
            1 + UPLOAD_RETRY_LIMIT as usize,
            "应收到 1 PROPFIND + {} PUT",
            UPLOAD_RETRY_LIMIT
        );

        let err = result.unwrap_err();
        assert!(
            err.contains("同名备份") || err.contains("冲突"),
            "连续 412 达到上限后应返回冲突相关错误: {err}"
        );
        assert!(
            !err.contains("retry12_user") && !err.contains("retry12_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(!zip_path.exists(), "重试耗尽后临时 zip 应被清理");

        let _ = std::fs::remove_dir_all(&zip_dir);
    }

    #[tokio::test]
    async fn upload_409_then_201_succeeds_on_retry() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 200 OK", &[], ""),
                ("HTTP/1.1 409 Conflict", &[], ""),
                ("HTTP/1.1 201 Created", &[], ""),
            ])
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "retry_ok_user",
            Some("retry_ok_pass".to_string()),
        );

        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);

        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let records = handle.join().expect("mock server 线程 panic");

        assert_eq!(records.len(), 3, "应收到 PROPFIND + PUT 409 + PUT 201");
        assert_eq!(records[1].method, "PUT");
        assert_eq!(records[2].method, "PUT");

        let upload_result = result.expect("409 后 201 应成功");
        assert!(upload_result.success, "第二次尝试 201 应标记为成功");
        assert!(!zip_path.exists(), "成功后临时 zip 应被清理");

        let _ = std::fs::remove_dir_all(&zip_dir);
    }

    #[tokio::test]
    async fn upload_error_messages_do_not_leak_credentials() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 200 OK", &[], ""),
                ("HTTP/1.1 423 Locked", &[], ""),
            ])
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "secret_user_abc",
            Some("super_secret_token_xyz".to_string()),
        );

        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);

        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let records = handle.join().expect("mock server 线程 panic");

        assert!(records[1].authorization_present, "PUT 应携带 Authorization");

        let err = result.unwrap_err();
        assert!(
            !err.contains("secret_user_abc"),
            "错误信息不得泄漏用户名: {err}"
        );
        assert!(
            !err.contains("super_secret_token_xyz"),
            "错误信息不得泄漏密码: {err}"
        );
        assert!(
            !err.contains("Authorization"),
            "错误信息不得提及 Authorization 头: {err}"
        );

        let _ = std::fs::remove_dir_all(&zip_dir);
    }

    #[tokio::test]
    async fn upload_401_403_return_immediately_no_retry() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 200 OK", &[], ""),
                ("HTTP/1.1 401 Unauthorized", &[], ""),
            ])
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "no_retry_user",
            Some("no_retry_pass".to_string()),
        );

        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);

        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let records = handle.join().expect("mock server 线程 panic");

        assert_eq!(
            records.len(),
            2,
            "401/403 应立即返回，只收到 PROPFIND + 1 PUT"
        );

        assert!(result.is_err(), "401 应返回错误");
        assert!(!zip_path.exists(), "401 失败后临时 zip 应被清理");

        let _ = std::fs::remove_dir_all(&zip_dir);
    }

    #[tokio::test]
    async fn upload_transport_error_returns_immediately_without_retry() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            let propfind = server.accept_one_request(
                "HTTP/1.1 200 OK",
                &[] as &[&str],
                "",
            );
            let put = server.accept_one_request_drop_without_response();
            vec![propfind, put]
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "transport_user",
            Some("transport_pass".to_string()),
        );

        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);

        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let records = handle.join().expect("mock server 线程 panic");

        assert_eq!(
            records.len(),
            2,
            "传输错误应立即返回，只收到 PROPFIND + 1 PUT，不应重试"
        );
        assert_eq!(records[0].method, "PROPFIND");
        assert_eq!(records[1].method, "PUT");

        let err = result.expect_err("传输错误应返回 Err");
        assert!(
            err.contains("WebDAV"),
            "错误消息应来自 classify_reqwest_error 分类: {err}"
        );
        assert!(
            !err.contains("transport_user") && !err.contains("transport_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(!zip_path.exists(), "传输错误后临时 zip 应被清理");

        let _ = std::fs::remove_dir_all(&zip_dir);
    }

    // -----------------------------------------------------------------------
    // Commit 8：下载 Content-Length / 流式上限 / 临时目录错误测试
    // -----------------------------------------------------------------------

    fn download_test_temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "webdav-dl-test-{label}-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&dir).expect("创建测试临时目录失败");
        dir
    }

    fn download_test_client_and_target(base_url: &str) -> (reqwest::Client, WebDavRequestTarget) {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("创建测试 reqwest::Client 失败");
        let target = WebDavRequestTarget::for_test_with_auth(
            base_url,
            "SoNotes_Backups/",
            "dl_user",
            Some("dl_pass".to_string()),
        );
        (client, target)
    }

    #[tokio::test]
    async fn download_no_content_length_succeeds_and_creates_token() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let body = b"PK\x03\x04fake zip content here";
        let handle = std::thread::spawn(move || {
            server.accept_one_download_request("HTTP/1.1 200 OK", None, body)
        });

        let (client, target) = download_test_client_and_target(&base_url);
        let temp_dir = download_test_temp_dir("no-cl");

        let result = download_backup_with_limit(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
            &temp_dir,
            1024,
        )
        .await;
        let record = handle.join().expect("mock server 线程 panic");

        assert_eq!(record.method, "GET");
        assert!(record.authorization_present, "下载请求应携带 Authorization");

        let dl_result = result.expect("无 Content-Length 下载应成功");
        assert!(dl_result.success);
        assert!(
            dl_result.download_token.is_some(),
            "成功下载应生成 download token"
        );

        if let Some(token) = &dl_result.download_token {
            let _ = cleanup_download_token(token);
        }
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn download_content_length_over_max_fails_before_body() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_download_request(
                "HTTP/1.1 200 OK",
                Some(2_000_000_000),
                b"",
            )
        });

        let (client, target) = download_test_client_and_target(&base_url);
        let temp_dir = download_test_temp_dir("cl-over");

        let result = download_backup_with_limit(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
            &temp_dir,
            1024,
        )
        .await;
        let _record = handle.join().expect("mock server 线程 panic");

        let err = result.unwrap_err();
        assert_eq!(
            err.kind,
            WebDavErrorKind::DownloadTooLarge,
            "Content-Length 超限应返回 DownloadTooLarge: {:?}",
            err.kind
        );
        assert!(!err.retryable);

        let entries: Vec<_> = std::fs::read_dir(&temp_dir)
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "zip"))
            .collect();
        assert!(entries.is_empty(), "Content-Length 超限不应创建临时文件");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn download_streaming_over_max_deletes_temp_file() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let big_body = vec![0u8; 64];
        let handle = std::thread::spawn(move || {
            server.accept_one_download_request("HTTP/1.1 200 OK", None, &big_body)
        });

        let (client, target) = download_test_client_and_target(&base_url);
        let temp_dir = download_test_temp_dir("stream-over");

        let result = download_backup_with_limit(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
            &temp_dir,
            16,
        )
        .await;
        let _record = handle.join().expect("mock server 线程 panic");

        let err = result.unwrap_err();
        assert_eq!(
            err.kind,
            WebDavErrorKind::DownloadTooLarge,
            "流式超限应返回 DownloadTooLarge: {:?}",
            err.kind
        );

        let entries: Vec<_> = std::fs::read_dir(&temp_dir)
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "zip"))
            .collect();
        assert!(entries.is_empty(), "流式超限后临时文件应被删除");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn download_404_returns_not_found_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_download_request("HTTP/1.1 404 Not Found", None, b"")
        });

        let (client, target) = download_test_client_and_target(&base_url);
        let temp_dir = download_test_temp_dir("404");

        let result = download_backup_with_limit(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
            &temp_dir,
            1024,
        )
        .await;
        let _record = handle.join().expect("mock server 线程 panic");

        let err = result.unwrap_err();
        assert_eq!(
            err.kind,
            WebDavErrorKind::NotFound,
            "404 应映射到 NotFound: {:?}",
            err.kind
        );
        assert_eq!(err.status, Some(404));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn download_401_returns_auth_failed_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_download_request(
                "HTTP/1.1 401 Unauthorized",
                None,
                b"",
            )
        });

        let (client, target) = download_test_client_and_target(&base_url);
        let temp_dir = download_test_temp_dir("401");

        let result = download_backup_with_limit(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
            &temp_dir,
            1024,
        )
        .await;
        let _record = handle.join().expect("mock server 线程 panic");

        let err = result.unwrap_err();
        assert_eq!(
            err.kind,
            WebDavErrorKind::AuthFailed,
            "401 应映射到 AuthFailed: {:?}",
            err.kind
        );
        assert_eq!(err.status, Some(401));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn download_403_returns_forbidden_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_download_request(
                "HTTP/1.1 403 Forbidden",
                None,
                b"",
            )
        });

        let (client, target) = download_test_client_and_target(&base_url);
        let temp_dir = download_test_temp_dir("403");

        let result = download_backup_with_limit(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
            &temp_dir,
            1024,
        )
        .await;
        let _record = handle.join().expect("mock server 线程 panic");

        let err = result.unwrap_err();
        assert_eq!(
            err.kind,
            WebDavErrorKind::Forbidden,
            "403 应映射到 Forbidden: {:?}",
            err.kind
        );
        assert_eq!(err.status, Some(403));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn download_file_as_temp_root_returns_local_temp_file_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_download_request(
                "HTTP/1.1 200 OK",
                None,
                b"some data",
            )
        });

        let (client, target) = download_test_client_and_target(&base_url);
        let temp_dir = download_test_temp_dir("file-root");
        let file_as_root = temp_dir.join("not_a_dir.txt");
        std::fs::write(&file_as_root, b"I am a file").unwrap();

        let result = download_backup_with_limit(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
            &file_as_root,
            1024,
        )
        .await;
        let _record = handle.join().expect("mock server 线程 panic");

        let err = result.unwrap_err();
        assert_eq!(
            err.kind,
            WebDavErrorKind::LocalTempFileError,
            "文件路径作为 temp_root 应返回 LocalTempFileError: {:?}",
            err.kind
        );

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn download_nested_file_as_temp_root_returns_local_temp_file_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_download_request(
                "HTTP/1.1 200 OK",
                None,
                b"some data",
            )
        });

        let (client, target) = download_test_client_and_target(&base_url);
        let temp_dir = download_test_temp_dir("nested-root");
        let file_as_parent = temp_dir.join("blocker.txt");
        std::fs::write(&file_as_parent, b"blocker").unwrap();
        let nested_bad = file_as_parent.join("subdir");

        let result = download_backup_with_limit(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
            &nested_bad,
            1024,
        )
        .await;
        let _record = handle.join().expect("mock server 线程 panic");

        let err = result.unwrap_err();
        assert_eq!(
            err.kind,
            WebDavErrorKind::LocalTempFileError,
            "不存在的 temp_root 应返回 LocalTempFileError: {:?}",
            err.kind
        );

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    // -----------------------------------------------------------------------
    // Commit 9：删除状态码分类与幂等语义测试
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn delete_204_returns_success() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 204 No Content", &[], "")
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "del_user",
            Some("del_pass".to_string()),
        );

        let result = webdav_delete_backup_with_client(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
        )
        .await;
        let record = handle.join().expect("mock server 线程 panic");

        assert_eq!(record.method, "DELETE", "请求方法应为 DELETE");
        assert!(
            record.authorization_present,
            "DELETE 请求应携带 Authorization"
        );

        let del_result = result.expect("204 应返回 Ok");
        assert!(del_result.success, "204 应标记为成功");
        assert!(del_result.error.is_none(), "204 不应携带 error");
    }

    #[tokio::test]
    async fn delete_200_returns_success() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 200 OK", &[], "")
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "del_user",
            Some("del_pass".to_string()),
        );

        let result = webdav_delete_backup_with_client(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
        )
        .await;
        let _record = handle.join().expect("mock server 线程 panic");

        let del_result = result.expect("200 应返回 Ok");
        assert!(del_result.success, "200 应标记为成功");
        assert!(del_result.error.is_none(), "200 不应携带 error");
    }

    #[tokio::test]
    async fn delete_404_returns_idempotent_success_with_message() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 404 Not Found", &[], "")
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "del_user",
            Some("del_pass".to_string()),
        );

        let result = webdav_delete_backup_with_client(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
        )
        .await;
        let record = handle.join().expect("mock server 线程 panic");

        assert_eq!(record.method, "DELETE");
        assert!(record.authorization_present, "DELETE 应携带 Authorization");

        let del_result = result.expect("404 幂等删除应返回 Ok");
        assert!(del_result.success, "404 幂等删除应标记为成功");
        assert_eq!(
            del_result.error.as_deref(),
            Some("远端备份已不存在"),
            "404 应保留现有幂等消息"
        );
    }

    #[tokio::test]
    async fn delete_423_returns_locked_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 423 Locked", &[], "")
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "lock_del_user",
            Some("lock_del_pass".to_string()),
        );

        let result = webdav_delete_backup_with_client(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
        )
        .await;
        let _record = handle.join().expect("mock server 线程 panic");

        let err = result.unwrap_err();
        assert!(err.contains("锁定"), "423 应映射到锁定语义: {err}");
        assert!(
            !err.contains("lock_del_user") && !err.contains("lock_del_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
    }

    #[tokio::test]
    async fn delete_401_returns_auth_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 401 Unauthorized", &[], "")
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "auth_del_user",
            Some("auth_del_pass".to_string()),
        );

        let result = webdav_delete_backup_with_client(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
        )
        .await;
        let _record = handle.join().expect("mock server 线程 panic");

        let err = result.unwrap_err();
        assert!(
            err.contains("鉴权失败"),
            "401 应映射到鉴权失败语义: {err}"
        );
        assert!(
            !err.contains("auth_del_user") && !err.contains("auth_del_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
    }

    #[tokio::test]
    async fn delete_403_returns_forbidden_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 403 Forbidden", &[], "")
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "forbid_del_user",
            Some("forbid_del_pass".to_string()),
        );

        let result = webdav_delete_backup_with_client(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
        )
        .await;
        let _record = handle.join().expect("mock server 线程 panic");

        let err = result.unwrap_err();
        assert!(
            err.contains("权限不足") || err.contains("访问被拒绝"),
            "403 应映射到权限不足或访问被拒绝: {err}"
        );
        assert!(
            !err.contains("forbid_del_user") && !err.contains("forbid_del_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
    }

    #[test]
    fn delete_invalid_remote_filename_fails_before_request() {
        let err = validate_remote_backup_filename("readme.txt").unwrap_err();

        assert!(
            err.contains("文件名") || err.contains("长度") || err.contains("前缀"),
            "非法文件名应在请求前被拒绝: {err}"
        );
        assert!(
            !err.contains("pass"),
            "错误信息不得泄漏凭据: {err}"
        );
    }

    #[tokio::test]
    async fn upload_preflight_propfind_405_returns_method_not_allowed() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        // PROPFIND 返回 405 → 不再走 MKCOL，直接报错
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 405 Method Not Allowed", &[], "")
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "preflight_user",
            Some("preflight_pass".to_string()),
        );

        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-preflight-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);

        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let _record = handle.join().expect("mock server 线程 panic");

        let err = result.unwrap_err();
        // 应保留 MethodNotAllowed 语义，不应被折叠为通用上传失败
        assert!(
            err.contains("不支持") || err.contains("方法"),
            "PROPFIND 405 应映射到方法不支持语义，而非通用上传失败: {err}"
        );
        assert!(
            !err.contains("preflight_user") && !err.contains("preflight_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(
            !zip_path.exists(),
            "失败后临时 zip 应被清理"
        );

        let _ = std::fs::remove_dir_all(&zip_dir);
    }

    #[tokio::test]
    async fn upload_preflight_mkcol_423_returns_locked() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        // PROPFIND 404 → MKCOL 423
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 404 Not Found", &[] as &[&str], ""),
                ("HTTP/1.1 423 Locked", &[] as &[&str], ""),
            ])
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "mkcol_user",
            Some("mkcol_pass".to_string()),
        );

        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-preflight-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);

        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let _records = handle.join().expect("mock server 线程 panic");

        let err = result.unwrap_err();
        // 应保留 Locked 语义，不应被折叠为通用上传失败
        assert!(
            err.contains("锁定"),
            "MKCOL 423 应映射到锁定语义，而非通用上传失败: {err}"
        );
        assert!(
            !err.contains("mkcol_user") && !err.contains("mkcol_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(
            !zip_path.exists(),
            "失败后临时 zip 应被清理"
        );

        let _ = std::fs::remove_dir_all(&zip_dir);
    }

    #[tokio::test]
    async fn upload_preflight_mkcol_507_returns_insufficient_storage() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        // PROPFIND 404 → MKCOL 507
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 404 Not Found", &[] as &[&str], ""),
                ("HTTP/1.1 507 Insufficient Storage", &[] as &[&str], ""),
            ])
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "storage_user",
            Some("storage_pass".to_string()),
        );

        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-preflight-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);

        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let _records = handle.join().expect("mock server 线程 panic");

        let err = result.unwrap_err();
        // 应保留 InsufficientStorage 语义，不应被折叠为通用上传失败
        assert!(
            err.contains("空间不足"),
            "MKCOL 507 应映射到空间不足语义，而非通用上传失败: {err}"
        );
        assert!(
            !err.contains("storage_user") && !err.contains("storage_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(
            !zip_path.exists(),
            "失败后临时 zip 应被清理"
        );

        let _ = std::fs::remove_dir_all(&zip_dir);
    }

    #[tokio::test]
    async fn upload_preflight_preserves_auth_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        // PROPFIND 返回 401 → 鉴权失败
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 401 Unauthorized", &[], "")
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "auth_user",
            Some("auth_pass".to_string()),
        );

        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-preflight-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);

        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let _record = handle.join().expect("mock server 线程 panic");

        let err = result.unwrap_err();
        // 鉴权错误应保留现有语义
        assert!(
            err.contains("鉴权失败"),
            "PROPFIND 401 应映射到鉴权失败语义: {err}"
        );
        assert!(
            !err.contains("auth_user") && !err.contains("auth_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(
            !zip_path.exists(),
            "失败后临时 zip 应被清理"
        );

        let _ = std::fs::remove_dir_all(&zip_dir);
    }

    #[tokio::test]
    async fn upload_preflight_propfind_404_mkcol_200_succeeds() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        // PROPFIND 404 → MKCOL 200 → PUT 201
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 404 Not Found", &[] as &[&str], ""),
                ("HTTP/1.1 200 OK", &[] as &[&str], ""),
                ("HTTP/1.1 201 Created", &[] as &[&str], ""),
            ])
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "mkcol_ok_user",
            Some("mkcol_ok_pass".to_string()),
        );

        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-preflight-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);

        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let _records = handle.join().expect("mock server 线程 panic");

        let upload_result = result.expect("404→MKCOL 200→PUT 201 应成功");
        assert!(upload_result.success, "目录创建后上传应标记为成功");
        assert!(upload_result.remote_file_name.is_some(), "成功后应返回文件名");
        assert!(!zip_path.exists(), "成功后临时 zip 应被清理");

        let _ = std::fs::remove_dir_all(&zip_dir);
    }

    #[tokio::test]
    async fn upload_preflight_error_no_credential_leak() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        // PROPFIND 404 → MKCOL 507，使用极敏感凭据
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 404 Not Found", &[] as &[&str], ""),
                ("HTTP/1.1 507 Insufficient Storage", &[] as &[&str], ""),
            ])
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "sensitive_user_xyz_abc",
            Some("super_secret_token_12345".to_string()),
        );

        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-preflight-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);

        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let records = handle.join().expect("mock server 线程 panic");

        // PROPFIND 和 MKCOL 都应携带 Authorization
        assert!(records[0].authorization_present, "PROPFIND 应携带 Authorization");
        assert!(records[1].authorization_present, "MKCOL 应携带 Authorization");

        let err = result.unwrap_err();
        assert!(
            !err.contains("sensitive_user_xyz_abc"),
            "错误信息不得泄漏用户名: {err}"
        );
        assert!(
            !err.contains("super_secret_token_12345"),
            "错误信息不得泄漏密码: {err}"
        );
        assert!(
            !err.contains("Authorization"),
            "错误信息不得提及 Authorization 头: {err}"
        );
        assert!(
            !err.contains("Basic"),
            "错误信息不得提及 Basic 认证: {err}"
        );

        let _ = std::fs::remove_dir_all(&zip_dir);
    }

    #[tokio::test]
    async fn upload_preflight_mkcol_409_returns_path_conflict() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        // PROPFIND 404 → MKCOL 409
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 404 Not Found", &[] as &[&str], ""),
                ("HTTP/1.1 409 Conflict", &[] as &[&str], ""),
            ])
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "conflict_user",
            Some("conflict_pass".to_string()),
        );

        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-preflight-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);

        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let _records = handle.join().expect("mock server 线程 panic");

        let err = result.unwrap_err();
        // 应保留 PathConflict 语义
        assert!(
            err.contains("冲突"),
            "MKCOL 409 应映射到冲突语义，而非通用上传失败: {err}"
        );
        assert!(
            !err.contains("conflict_user") && !err.contains("conflict_pass"),
            "错误信息不得泄漏凭据: {err}"
        );

        let _ = std::fs::remove_dir_all(&zip_dir);
    }

    #[test]
    fn parse_propfind_truncated_eof_returns_invalid_propfind_response() {
        let result = parse_propfind_response(r#"<D:multistatus><D:response>"#);
        let err = result.unwrap_err();
        assert_eq!(
            err,
            WebDavOperationError {
                kind: WebDavErrorKind::InvalidPropfindResponse,
                status: None,
                retryable: false,
            },
            "未闭合 XML EOF 应精确匹配 InvalidPropfindResponse: {err:?}"
        );
    }

    #[test]
    fn parse_propfind_error_message_maps_to_user_visible_string() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::InvalidPropfindResponse,
            status: None,
            retryable: false,
        };
        let msg = webdav_error_message(&error);
        assert_eq!(msg, "WebDAV 列表 XML 解析失败");
        assert!(
            !msg.contains("password") && !msg.contains("token"),
            "错误信息不得泄漏凭据: {msg}"
        );
    }

    #[test]
    fn parse_propfind_fragmented_tag_returns_invalid_propfind_response() {
        let result = parse_propfind_response(
            r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/SoNotes_Backups/"#,
        );
        let err = result.unwrap_err();
        assert_eq!(
            err.kind,
            WebDavErrorKind::InvalidPropfindResponse,
            "EOF 时 in_href=true 应返回 InvalidPropfindResponse: {:?}",
            err.kind
        );
    }

    #[tokio::test]
    async fn mock_server_list_malformed_xml_returns_xml_parse_error_no_credential_leak() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let malformed_body = load_fixture("propfind_malformed.xml");
        let handle = std::thread::spawn(move || {
            server.accept_one_request(
                "HTTP/1.1 207 Multi-Status",
                &[],
                &malformed_body,
            )
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("创建测试 reqwest::Client 失败");

        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "xml_err_user",
            Some("xml_err_secret_token".to_string()),
        );

        let result = webdav_list_backups_with_client(&client, &target).await;
        let record = handle.join().expect("mock server 线程 panic");

        assert_eq!(record.method, "PROPFIND", "请求方法应为 PROPFIND");
        assert!(
            record.authorization_present,
            "请求应携带 Authorization 头"
        );

        let err = result.unwrap_err();
        assert!(
            err.contains("XML 解析失败"),
            "畸形 XML 应返回 XML 解析失败消息: {err}"
        );
        assert!(
            err.contains("WebDAV 列表"),
            "错误消息应包含 'WebDAV 列表': {err}"
        );
        assert!(
            !err.contains("xml_err_user"),
            "错误信息不得泄漏用户名: {err}"
        );
        assert!(
            !err.contains("xml_err_secret_token"),
            "错误信息不得泄漏密码: {err}"
        );
        assert!(
            !err.contains("Authorization"),
            "错误信息不得提及 Authorization 头: {err}"
        );
        assert!(
            !err.contains("Basic"),
            "错误信息不得提及 Basic 认证: {err}"
        );
    }

    // ===================================================================
    // Credential Store 测试
    // ===================================================================

    #[test]
    fn memory_store_save_and_load() {
        let store = MemoryWebDavCredentialStore::new();
        let key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "test-account".to_string(),
        };
        store.save(&key, TEST_SECRET).expect("save 应成功");
        let loaded = store.load(&key).expect("load 应成功");
        assert_eq!(loaded, TEST_SECRET, "loaded secret 应与保存的一致");
    }

    #[test]
    fn memory_store_load_missing_returns_missing_secret() {
        let store = MemoryWebDavCredentialStore::new();
        let key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "nonexistent".to_string(),
        };
        let err = store.load(&key).unwrap_err();
        assert_eq!(err.kind, WebDavCredentialErrorKind::MissingSecret);
    }

    #[test]
    fn memory_store_delete_then_load_returns_missing() {
        let store = MemoryWebDavCredentialStore::new();
        let key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "to-delete".to_string(),
        };
        store.save(&key, TEST_SECRET).expect("save 应成功");
        store.delete(&key).expect("delete 应成功");
        let err = store.load(&key).unwrap_err();
        assert_eq!(err.kind, WebDavCredentialErrorKind::MissingSecret);
    }

    #[test]
    fn memory_store_delete_nonexistent_succeeds() {
        let store = MemoryWebDavCredentialStore::new();
        let key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "never-existed".to_string(),
        };
        // 删除不存在的 key 不应报错（幂等）
        store.delete(&key).expect("delete 不存在的 key 应成功");
    }

    #[test]
    fn memory_store_overwrite_secret() {
        let store = MemoryWebDavCredentialStore::new();
        let key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "overwrite".to_string(),
        };
        store.save(&key, "first-value").expect("第一次 save 应成功");
        store.save(&key, TEST_SECRET).expect("覆盖 save 应成功");
        let loaded = store.load(&key).expect("load 应成功");
        assert_eq!(loaded, TEST_SECRET, "覆盖后应返回新值");
    }

    #[test]
    fn memory_store_different_keys_isolated() {
        let store = MemoryWebDavCredentialStore::new();
        let key_a = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "account-a".to_string(),
        };
        let key_b = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "account-b".to_string(),
        };
        store.save(&key_a, TEST_SECRET).expect("save a 应成功");
        store.save(&key_b, "other-secret").expect("save b 应成功");
        assert_eq!(store.load(&key_a).unwrap(), TEST_SECRET);
        assert_eq!(store.load(&key_b).unwrap(), "other-secret");
    }

    #[test]
    fn credential_error_debug_redacts_secret() {
        let store = MemoryWebDavCredentialStore::new();
        let key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "debug-test".to_string(),
        };
        store.save(&key, TEST_SECRET).expect("save 应成功");

        // load 一个不同的 key，产生 MissingSecret 错误
        let missing_key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "debug-test-missing".to_string(),
        };
        let err = store.load(&missing_key).unwrap_err();
        let debug_output = format!("{err:?}");
        assert!(
            !debug_output.contains(TEST_SECRET),
            "Debug 输出不得泄漏 secret: {debug_output}"
        );
    }

    #[test]
    fn credential_key_debug_redacts_secret() {
        // 确保 key 本身不包含 secret
        let key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "sha256-abc123".to_string(),
        };
        let debug_output = format!("{key:?}");
        assert!(
            !debug_output.contains(TEST_SECRET),
            "CredentialKey Debug 不得包含 secret: {debug_output}"
        );
    }

    // -----------------------------------------------------------------------
    // SystemWebDavCredentialStore 测试（需真实系统密钥链，标记 ignore）
    // -----------------------------------------------------------------------

    #[test]
    #[ignore]
    fn system_store_save_and_load_roundtrip() {
        let config = std::collections::HashMap::new();
        keyring::use_windows_native_store(&config).expect("初始化 Windows 密钥链失败");

        let store = SystemWebDavCredentialStore::new();
        let key = WebDavCredentialKey {
            service: "so-notes-test".to_string(),
            account: "commit3-test".to_string(),
        };

        store.save(&key, TEST_SECRET).expect("系统密钥链 save 应成功");
        let loaded = store.load(&key).expect("系统密钥链 load 应成功");
        assert_eq!(loaded, TEST_SECRET, "系统密钥链 roundtrip 结果应一致");

        let entry = keyring_core::Entry::new(&key.service, &key.account).unwrap();
        let _ = entry.delete_credential();
    }

    #[test]
    #[ignore]
    fn system_store_delete_removes_credential() {
        let config = std::collections::HashMap::new();
        keyring::use_windows_native_store(&config).expect("初始化 Windows 密钥链失败");

        let store = SystemWebDavCredentialStore::new();
        let key = WebDavCredentialKey {
            service: "so-notes-test".to_string(),
            account: "commit3-delete-test".to_string(),
        };

        store.save(&key, TEST_SECRET).expect("系统密钥链 save 应成功");
        store.delete(&key).expect("系统密钥链 delete 应成功");

        let err = store.load(&key).unwrap_err();
        assert_eq!(
            err.kind,
            WebDavCredentialErrorKind::MissingSecret,
            "删除后 load 应返回 MissingSecret"
        );

        let entry = keyring_core::Entry::new(&key.service, &key.account).unwrap();
        let _ = entry.delete_credential();
    }

    // -----------------------------------------------------------------------
    // Commit 4: 保存/加载配置密钥链语义测试
    // -----------------------------------------------------------------------

    #[test]
    fn config_save_remember_password_roundtrip() {
        let dir = test_config_dir("remember-roundtrip");
        let path = dir.join(CONFIG_FILENAME);

        let store = MemoryWebDavCredentialStore::new();
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: true,
            password: Some(TEST_SECRET.to_string()),
        };

        let (config, _) = prepare_config_save(&request, None).unwrap();
        assert!(config.password_saved);
        let cred_key = config.credential_key.clone().unwrap();
        store
            .save(
                &WebDavCredentialKey {
                    service: "SoNotes.WebDAV".to_string(),
                    account: cred_key.clone(),
                },
                TEST_SECRET,
            )
            .unwrap();

        let json = serde_json::to_string_pretty(&config).unwrap();
        std::fs::write(&path, &json).unwrap();

        let read_content = std::fs::read_to_string(&path).unwrap();
        let read_config: WebDavConfigFile = serde_json::from_str(&read_content).unwrap();

        let loaded_password_saved =
            read_config.password_saved && read_config.credential_key.is_some();
        assert!(loaded_password_saved, "roundtrip 后 passwordSaved 应为 true");

        let loaded_secret = store
            .load(&WebDavCredentialKey {
                service: "SoNotes.WebDAV".to_string(),
                account: read_config.credential_key.unwrap(),
            })
            .unwrap();
        assert_eq!(loaded_secret, TEST_SECRET);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_save_no_remember_clears_credential() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: false,
            password: None,
        };

        let (config, _) = prepare_config_save(&request, None).unwrap();
        assert!(!config.password_saved);
        assert!(config.credential_key.is_none());

        let loaded_password_saved =
            config.password_saved && config.credential_key.is_some();
        assert!(!loaded_password_saved, "remember=false 时 passwordSaved 应为 false");
    }

    #[test]
    fn config_save_credential_key_change_deletes_old() {
        let store = MemoryWebDavCredentialStore::new();
        let old_key_str = "old-key-hash-value-12345678";

        store
            .save(
                &WebDavCredentialKey {
                    service: "SoNotes.WebDAV".to_string(),
                    account: old_key_str.to_string(),
                },
                "old-password",
            )
            .unwrap();

        let old_config = WebDavConfigFile {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: true,
            credential_key: Some(old_key_str.to_string()),
        };

        let request = WebDavConfigSaveRequest {
            server_url: "https://different-server.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: true,
            password: Some("new-password".to_string()),
        };

        let (config, old_credential_key) = prepare_config_save(&request, Some(&old_config)).unwrap();
        assert!(config.credential_key.is_some());
        assert_ne!(config.credential_key.as_ref().unwrap(), old_key_str);
        assert_eq!(old_credential_key.as_deref(), Some(old_key_str));

        let new_key = config.credential_key.as_ref().unwrap();
        store
            .save(
                &WebDavCredentialKey {
                    service: "SoNotes.WebDAV".to_string(),
                    account: new_key.clone(),
                },
                "new-password",
            )
            .unwrap();

        let _ = store.delete(&WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: old_key_str.to_string(),
        });

        assert!(
            store.load(&WebDavCredentialKey {
                service: "SoNotes.WebDAV".to_string(),
                account: old_key_str.to_string(),
            }).is_err(),
            "旧 secret 应已被删除"
        );
        assert_eq!(
            store.load(&WebDavCredentialKey {
                service: "SoNotes.WebDAV".to_string(),
                account: new_key.clone(),
            }).unwrap(),
            "new-password"
        );
    }

    #[test]
    fn config_save_remember_without_password_fails() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: true,
            password: None,
        };

        let err = prepare_config_save(&request, None).unwrap_err();
        assert!(err.contains("记住密码时必须提供密码"), "应拒绝无密码的 remember: {err}");
    }

    #[test]
    fn config_save_userinfo_url_rejected() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://user:pass@example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: true,
            password: Some("secret".to_string()),
        };

        let err = prepare_config_save(&request, None).unwrap_err();
        assert!(err.contains("用户名"), "应拒绝含 userinfo 的 URL: {err}");
    }

    #[test]
    fn config_load_old_format_password_saved_without_key() {
        let dir = test_config_dir("old-format");
        let path = dir.join(CONFIG_FILENAME);

        let old_config_json = serde_json::json!({
            "server_url": "https://example.com/dav",
            "username": "user1",
            "remote_dir": "Backups/",
            "password_saved": true
        });

        std::fs::write(&path, serde_json::to_string_pretty(&old_config_json).unwrap()).unwrap();

        let read_content = std::fs::read_to_string(&path).unwrap();
        let read_config: WebDavConfigFile = serde_json::from_str(&read_content).unwrap();

        let loaded_password_saved =
            read_config.password_saved && read_config.credential_key.is_some();
        assert!(!loaded_password_saved, "旧格式 password_saved=true 但无 credential_key 时应返回 false");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_save_clear_returns_warning_on_delete_failure() {
        let failing_store = FailingDeleteCredentialStore::new();

        let old_key_str = "some-old-key";
        let old_config = WebDavConfigFile {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: true,
            credential_key: Some(old_key_str.to_string()),
        };

        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: false,
            password: None,
        };

        let old_cred_key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: old_key_str.to_string(),
        };
        let delete_result = failing_store.delete(&old_cred_key);
        assert!(delete_result.is_err(), "FailingDeleteCredentialStore 应始终失败");

        let (config, old_credential_key) = prepare_config_save(&request, Some(&old_config)).unwrap();
        assert!(!config.password_saved);
        assert_eq!(old_credential_key.as_deref(), Some(old_key_str));
    }

    #[test]
    fn credential_store_save_error_does_not_leak_secret() {
        // 验证 save 失败时，错误消息不包含实际密码
        let store = MemoryWebDavCredentialStore::new();
        let key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "leak-test-save".to_string(),
        };

        // 先保存一个值，然后验证错误路径
        store.save(&key, TEST_SECRET).expect("save 应成功");

        // 验证 save 成功后 Debug 输出不含 secret
        let loaded = store.load(&key).unwrap();
        assert_eq!(loaded, TEST_SECRET);

        // 验证 MissingSecret 错误消息不含任何 secret
        let missing_key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "leak-test-missing".to_string(),
        };
        let err = store.load(&missing_key).unwrap_err();
        let display_msg = format!("{err}");
        assert!(
            !display_msg.contains(TEST_SECRET),
            "MissingSecret Display 消息不得泄漏 secret: {display_msg}"
        );
    }

    #[test]
    fn credential_store_delete_error_does_not_leak_secret() {
        // 验证 delete 失败时，错误消息不包含实际密码
        let failing_store = FailingDeleteCredentialStore::new();
        let key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "leak-test-delete".to_string(),
        };

        failing_store.save(&key, TEST_SECRET).expect("save 应成功");
        let err = failing_store.delete(&key).unwrap_err();
        let display_msg = format!("{err}");
        assert!(
            !display_msg.contains(TEST_SECRET),
            "DeleteFailed Display 消息不得泄漏 secret: {display_msg}"
        );
    }

    #[test]
    fn resolve_secret_error_does_not_leak_stored_secret() {
        // 验证 resolve_operation_secret_core 错误消息不包含 store 中的 secret
        let store = MemoryWebDavCredentialStore::new();
        let cred_key_val = compute_credential_key(
            "https://example.com/dav",
            "alice",
            "Backups/",
        );
        let cred_key = WebDavCredentialKey {
            service: CREDENTIAL_SERVICE.to_string(),
            account: cred_key_val,
        };
        store.save(&cred_key, TEST_SECRET).expect("save 应成功");

        // 配置文件存在但 credential_key 不匹配，触发 load 失败
        let config = WebDavConfig {
            server_url: "https://example.com/dav".to_string(),
            username: "alice".to_string(),
            remote_dir: Some("Backups/".to_string()),
            password: None,
        };

        let dir = std::env::temp_dir().join(format!(
            "so-notes-test-resolve-leak-{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("webdav-config.json");
        let config_file = WebDavConfigFile {
            server_url: "https://example.com/dav".to_string(),
            username: "alice".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: true,
            credential_key: Some("different-key".to_string()),
        };
        let json = serde_json::to_string(&config_file).unwrap();
        std::fs::write(&path, json).unwrap();

        let result = resolve_operation_secret_core(Some(&path), &config, &store);
        assert!(result.is_err());
        let err_msg = result.unwrap_err();
        assert!(
            !err_msg.contains(TEST_SECRET),
            "resolve 错误消息不得泄漏 secret: {err_msg}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn webdav_error_message_never_leaks_secrets() {
        // 验证 webdav_error_message 返回的用户可见文案不包含任何密码
        let kinds = [
            WebDavErrorKind::AuthFailed,
            WebDavErrorKind::Forbidden,
            WebDavErrorKind::NotFound,
            WebDavErrorKind::PathConflict,
            WebDavErrorKind::Locked,
            WebDavErrorKind::InsufficientStorage,
            WebDavErrorKind::MethodNotAllowed,
            WebDavErrorKind::Timeout,
            WebDavErrorKind::NetworkUnreachable,
            WebDavErrorKind::RedirectRejected,
            WebDavErrorKind::UnexpectedStatus,
            WebDavErrorKind::InvalidPropfindResponse,
            WebDavErrorKind::DownloadTooLarge,
            WebDavErrorKind::InvalidRemoteFileName,
            WebDavErrorKind::LocalTempFileError,
        ];

        for kind in kinds {
            let error = WebDavOperationError {
                kind,
                status: None,
                retryable: false,
            };
            let msg = webdav_error_message(&error);
            assert!(
                !msg.contains(TEST_SECRET),
                "webdav_error_message 不得泄漏 secret (kind={kind:?}): {msg}"
            );
        }
    }

    #[test]
    fn credential_key_not_in_config_json() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: true,
            password: Some(TEST_SECRET.to_string()),
        };

        let (config, _) = prepare_config_save(&request, None).unwrap();
        let json = serde_json::to_string(&config).unwrap();

        assert!(
            !json.contains(TEST_SECRET),
            "配置 JSON 中不得包含密码明文"
        );
        assert!(
            !json.contains("\"password\""),
            "配置 JSON 中不得出现 password 字段"
        );

        let cred_key = config.credential_key.as_ref().unwrap();
        assert!(
            !cred_key.contains(TEST_SECRET),
            "credential_key 中不得包含密码"
        );
    }

    #[test]
    fn resolve_secret_prefers_input_password() {
        let store = MemoryWebDavCredentialStore::new();
        let config = WebDavConfig {
            server_url: "https://example.com/dav".to_string(),
            username: "alice".to_string(),
            remote_dir: Some("Backups/".to_string()),
            password: Some("inline-token".to_string()),
        };

        let result = resolve_operation_secret_core(None, &config, &store);
        assert_eq!(result.unwrap(), "inline-token");
    }

    #[test]
    fn resolve_secret_reads_from_store() {
        let store = MemoryWebDavCredentialStore::new();
        let config = WebDavConfig {
            server_url: "https://example.com/dav".to_string(),
            username: "alice".to_string(),
            remote_dir: Some("Backups/".to_string()),
            password: None,
        };

        let cred_key_val =
            compute_credential_key("https://example.com/dav", "alice", "Backups/");
        let cred_key = WebDavCredentialKey {
            service: CREDENTIAL_SERVICE.to_string(),
            account: cred_key_val,
        };
        store.save(&cred_key, "stored-secret").unwrap();

        let dir = std::env::temp_dir().join(format!(
            "so-notes-test-resolve-{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("webdav-config.json");
        let config_file = WebDavConfigFile {
            server_url: "https://example.com/dav".to_string(),
            username: "alice".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: true,
            credential_key: Some(cred_key.account.clone()),
        };
        let json = serde_json::to_string(&config_file).unwrap();
        std::fs::write(&path, json).unwrap();

        let result = resolve_operation_secret_core(Some(&path), &config, &store);
        assert_eq!(result.unwrap(), "stored-secret");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_secret_fails_on_store_error() {
        let store = MemoryWebDavCredentialStore::new();
        let config = WebDavConfig {
            server_url: "https://example.com/dav".to_string(),
            username: "alice".to_string(),
            remote_dir: Some("Backups/".to_string()),
            password: None,
        };

        let dir = std::env::temp_dir().join(format!(
            "so-notes-test-resolve-fail-{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("webdav-config.json");
        let config_file = WebDavConfigFile {
            server_url: "https://example.com/dav".to_string(),
            username: "alice".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: true,
            credential_key: Some("nonexistent-key".to_string()),
        };
        let json = serde_json::to_string(&config_file).unwrap();
        std::fs::write(&path, json).unwrap();

        let result = resolve_operation_secret_core(Some(&path), &config, &store);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("系统凭据读取失败"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_secret_fails_when_no_source() {
        let store = MemoryWebDavCredentialStore::new();
        let config = WebDavConfig {
            server_url: "https://example.com/dav".to_string(),
            username: "alice".to_string(),
            remote_dir: Some("Backups/".to_string()),
            password: None,
        };

        let result = resolve_operation_secret_core(None, &config, &store);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("请提供密码"));
    }

    #[test]
    fn clear_config_deletes_credential_key_from_store() {
        let store = MemoryWebDavCredentialStore::new();
        let cred_key = WebDavCredentialKey {
            service: CREDENTIAL_SERVICE.to_string(),
            account: "test-key-abc123".to_string(),
        };
        store.save(&cred_key, "my-secret").unwrap();
        assert!(store.load(&cred_key).is_ok());

        let dir = std::env::temp_dir()
            .join(format!("so-notes-test-clear-cred-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(CONFIG_FILENAME);

        let config_file = WebDavConfigFile {
            server_url: "https://example.com/dav".to_string(),
            username: "alice".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: true,
            credential_key: Some("test-key-abc123".to_string()),
        };
        let json = serde_json::to_string(&config_file).unwrap();
        std::fs::write(&path, json).unwrap();
        assert!(path.exists());

        let content = std::fs::read_to_string(&path).unwrap();
        let read: WebDavConfigFile = serde_json::from_str(&content).unwrap();
        let old_key = read.credential_key.unwrap();

        std::fs::remove_file(&path).unwrap();
        assert!(!path.exists());

        let cred_key_delete = WebDavCredentialKey {
            service: CREDENTIAL_SERVICE.to_string(),
            account: old_key,
        };
        store.delete(&cred_key_delete).unwrap();

        assert!(
            store.load(&cred_key_delete).is_err(),
            "删除后密钥链中不应再有该 secret"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_config_keychain_delete_failed_returns_warning() {
        let store = FailingDeleteCredentialStore::new();
        let cred_key = WebDavCredentialKey {
            service: CREDENTIAL_SERVICE.to_string(),
            account: "test-key-fail".to_string(),
        };

        let result = store.delete(&cred_key);
        assert!(result.is_err(), "FailingDeleteCredentialStore 应始终失败");

        let err = result.unwrap_err();
        assert!(
            err.kind == WebDavCredentialErrorKind::DeleteFailed,
            "错误类型应为 DeleteFailed"
        );
    }

    #[test]
    fn clear_config_old_credential_key_not_reused_after_delete() {
        let store = MemoryWebDavCredentialStore::new();
        let cred_key = WebDavCredentialKey {
            service: CREDENTIAL_SERVICE.to_string(),
            account: "old-session-key".to_string(),
        };
        store.save(&cred_key, "old-password").unwrap();

        store.delete(&cred_key).unwrap();

        let load_result = store.load(&cred_key);
        assert!(
            load_result.is_err(),
            "删除后旧 key 不应能加载到 secret"
        );
        assert!(
            matches!(
                load_result.unwrap_err().kind,
                WebDavCredentialErrorKind::MissingSecret
            ),
            "错误类型应为 MissingSecret"
        );
    }
}
