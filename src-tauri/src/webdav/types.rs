//! WebDAV 类型与常量
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::backup;

pub(crate) const DEFAULT_REMOTE_DIR_NAME: &str = "SoNotes_Backups";
pub(crate) const REMOTE_BACKUP_FILENAME_PATTERN: &str = "SoNotes_Backup_";
pub(crate) const DATETIME_LEN: usize = 14;
pub(crate) const REMOTE_BACKUP_FILENAME_LEN: usize = 15 + DATETIME_LEN + 4; // 33
pub(crate) const CONFIG_FILENAME: &str = "webdav-config.json";
pub(crate) const MAX_WEBDAV_BACKUP_DOWNLOAD_BYTES: u64 = 1024 * 1024 * 1024;
pub(crate) const WEBDAV_TEMP_DIR_NAME: &str = "webdav-backups";
pub(crate) const WEBDAV_PENDING_DIR_NAME: &str = "pending";
pub(crate) const WEBDAV_DOWNLOADS_DIR_NAME: &str = "downloads";
pub(crate) const UPLOAD_RETRY_LIMIT: u32 = 3;
pub(crate) const MAX_WEBDAV_REDIRECTS: usize = 10;
pub(crate) const WEBDAV_USER_AGENT: &str = "SoNotes/1.5";
pub(crate) const WEBDAV_HTTP_TIMEOUT_SECS: u64 = 30;
pub(crate) const DOWNLOAD_TOKEN_TTL: Duration = Duration::from_secs(24 * 60 * 60);
pub(crate) const WEBDAV_TEMP_FILE_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfig {
    pub server_url: String,
    pub username: String,
    pub remote_dir: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub trust_host: bool,
}
impl std::fmt::Debug for WebDavConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebDavConfig")
            .field("server_url", &self.server_url)
            .field("username", &self.username)
            .field("remote_dir", &self.remote_dir)
            .field("password", &self.password.as_ref().map(|_| "[REDACTED]"))
            .field("trust_host", &self.trust_host)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConnectionResult {
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavRemoteBackup {
    pub file_name: String,
    pub size: Option<u64>,
    pub last_modified: Option<String>,
    pub status: Option<u16>,
    pub readable: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfigSaveRequest {
    pub server_url: String,
    pub username: String,
    pub remote_dir: Option<String>,
    pub remember_password: bool,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub trust_host: bool,
}
impl std::fmt::Debug for WebDavConfigSaveRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebDavConfigSaveRequest")
            .field("server_url", &self.server_url)
            .field("username", &self.username)
            .field("remote_dir", &self.remote_dir)
            .field("remember_password", &self.remember_password)
            .field("password", &self.password.as_ref().map(|_| "[REDACTED]"))
            .field("trust_host", &self.trust_host)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfigLoadResult {
    pub success: bool,
    pub server_url: Option<String>,
    pub username: Option<String>,
    pub remote_dir: Option<String>,
    pub password_saved: bool,
    pub error: Option<String>,
    #[serde(default)]
    pub trust_host: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfigSaveResult {
    pub success: bool,
    pub warning: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfigClearResult {
    pub success: bool,
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_cleanup_warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavUploadResult {
    pub success: bool,
    pub remote_file_name: Option<String>,
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_stage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<backup::BackupSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zip_size_bytes: Option<u64>,
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

// ponytail: 磁盘格式保持 snake_case（与历史配置文件兼容），不加 rename_all
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct WebDavConfigFile {
    pub(crate) server_url: String,
    pub(crate) username: String,
    pub(crate) remote_dir: String,
    pub(crate) password_saved: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub(crate) credential_key: Option<String>,
    #[serde(default)]
    pub(crate) trust_host: bool,
    #[serde(default)]
    pub(crate) trusted_host: Option<String>,
}
