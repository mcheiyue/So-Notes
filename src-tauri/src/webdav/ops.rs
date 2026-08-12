//! WebDAV 操作层：single-flight 锁、upload/download、token、temp cleanup
use crate::backup;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};
use tauri::Manager;

use super::config::*;
use super::credential::*;
use super::error::*;
use super::ssrf::*;
use super::transport::*;
use super::types::*;

// ---------------------------------------------------------------------------
/// 全局互斥锁，确保同一时间只有一个任务进入 create-zip + upload 流程。
///
/// 锁的持有范围覆盖 `create_local_backup`（含 blocking 线程内的 zip 创建）
/// 和 `webdav_upload_backup_with_client`（含 409/412 重试循环）。
/// 使用 `tokio::sync::Mutex` 因为调用方是 async 上下文。
pub(crate) fn webdav_create_backup_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

// 序列化类型（前端消费，camelCase）
// ---------------------------------------------------------------------------














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
pub(crate) struct DownloadTokenEntry {
    state: DownloadTokenState,
    created_at: SystemTime,
}
pub(crate) fn download_tokens() -> &'static Mutex<HashMap<String, DownloadTokenEntry>> {
    static TOKENS: OnceLock<Mutex<HashMap<String, DownloadTokenEntry>>> = OnceLock::new();
    TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}
pub(crate) fn store_download_token(token: &str, file_path: PathBuf) {
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
pub(crate) fn store_download_token_created_at(token: &str, file_path: PathBuf, created_at: SystemTime) {
    let mut tokens = download_tokens().lock().unwrap();
    tokens.insert(
        token.to_string(),
        DownloadTokenEntry {
            state: DownloadTokenState::Ready { file_path },
            created_at,
        },
    );
}
pub(crate) fn token_is_expired(entry: &DownloadTokenEntry) -> bool {
    SystemTime::now()
        .duration_since(entry.created_at)
        .map(|age| age > DOWNLOAD_TOKEN_TTL)
        .unwrap_or(false)
}
pub(crate) fn token_file_path(state: &DownloadTokenState) -> Option<PathBuf> {
    match state {
        DownloadTokenState::Ready { file_path }
        | DownloadTokenState::Resolved { file_path } => Some(file_path.clone()),
        DownloadTokenState::Cleaned { file_path } => file_path.clone(),
    }
}
pub(crate) fn resolve_download_token(token: &str) -> Result<PathBuf, String> {
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
pub(crate) fn cleanup_download_token(token: &str) -> Result<PathBuf, String> {
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
pub(crate) fn remove_download_token(token: &str) {
    let mut tokens = download_tokens().lock().unwrap();
    tokens.remove(token);
}
// ---------------------------------------------------------------------------
// 临时路径辅助
// ---------------------------------------------------------------------------
pub(crate) fn webdav_temp_base_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("获取应用缓存目录失败: {e}"))?;
    Ok(cache_dir.join(WEBDAV_TEMP_DIR_NAME))
}
pub(crate) fn webdav_pending_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(webdav_temp_base_dir(app)?.join(WEBDAV_PENDING_DIR_NAME))
}
pub(crate) fn webdav_downloads_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(webdav_temp_base_dir(app)?.join(WEBDAV_DOWNLOADS_DIR_NAME))
}
pub(crate) fn validate_file_within_webdav_dir(path: &Path, base: &Path) -> bool {
    let normalized_path = normalize_path(path);
    let normalized_base = normalize_path(base);
    normalized_path.starts_with(&normalized_base) && normalized_path != normalized_base
}
pub(crate) fn normalize_path(path: &Path) -> PathBuf {
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
pub(crate) fn generate_download_token() -> String {
    format!("webdav-dl-{:032x}", rand::random::<u128>())
}
pub(crate) fn is_stale_file(path: &Path, max_age: Duration) -> bool {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .map(|age| age > max_age)
        .unwrap_or(false)
}
pub(crate) fn remove_stale_matching_files(dir: &Path, prefix: &str, max_age: Duration) -> Result<(), String> {
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
pub(crate) async fn webdav_upload_backup_with_client(
    client: &reqwest::Client,
    target: &WebDavRequestTarget,
    zip_path: &Path,
) -> Result<WebDavUploadResult, String> {
    let dir_url = build_remote_dir_url(&target.base_url, &target.remote_dir);
    if let Err(op_error) = ensure_remote_dir_exists(
        client,
        &dir_url,
        &target.username,
        target.password.as_deref(),
    )
    .await
    {
        let _ = std::fs::remove_file(zip_path);
        return Ok(WebDavUploadResult {
            success: false,
            remote_file_name: None,
            error: Some(webdav_error_message(&op_error)),
            error_stage: Some("ensure_dir".to_string()),
            error_code: op_error.status.map(|s| s.to_string()),
            summary: None,
            zip_size_bytes: None,
        });
    }
    let mut last_error = String::new();
    for attempt in 0..UPLOAD_RETRY_LIMIT {
        let remote_filename = if attempt == 0 {
            generate_current_remote_backup_filename()
        } else {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            generate_current_remote_backup_filename()
        };
        let upload_url = format!("{}{}", dir_url, remote_filename);
        let zip_len = match tokio::fs::metadata(zip_path).await {
            Ok(meta) => meta.len(),
            Err(_) => {
                let _ = std::fs::remove_file(zip_path);
                return Ok(WebDavUploadResult {
                    success: false,
                    remote_file_name: None,
                    error: Some("远端备份上传失败，本地数据未受影响".to_string()),
                    error_stage: Some("read_local_file".to_string()),
                    error_code: None,
                    summary: None,
                    zip_size_bytes: None,
                });
            }
        };
        let zip_file = match tokio::fs::File::open(zip_path).await {
            Ok(f) => f,
            Err(_) => {
                let _ = std::fs::remove_file(zip_path);
                return Ok(WebDavUploadResult {
                    success: false,
                    remote_file_name: None,
                    error: Some("远端备份上传失败，本地数据未受影响".to_string()),
                    error_stage: Some("read_local_file".to_string()),
                    error_code: None,
                    summary: None,
                    zip_size_bytes: None,
                });
            }
        };
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
                            error_stage: None,
                            error_code: None,
                            summary: None,
                            zip_size_bytes: None,
                        });
                    }
                    401 | 403 => {
                        let _ = std::fs::remove_file(zip_path);
                        let op_error =
                            classify_webdav_status(WebDavOperation::UploadBackup, status);
                        return Ok(WebDavUploadResult {
                            success: false,
                            remote_file_name: None,
                            error: Some(webdav_error_message(&op_error)),
                            error_stage: Some("auth".to_string()),
                            error_code: Some(status.as_u16().to_string()),
                            summary: None,
                            zip_size_bytes: None,
                        });
                    }
                    409 | 412 => {
                        last_error = "远端已存在同名备份，请稍后重试".to_string();
                        continue;
                    }
                    _ => {
                        let op_error =
                            classify_webdav_status(WebDavOperation::UploadBackup, status);
                        let _ = std::fs::remove_file(zip_path);
                        return Ok(WebDavUploadResult {
                            success: false,
                            remote_file_name: None,
                            error: Some(webdav_error_message(&op_error)),
                            error_stage: Some("upload".to_string()),
                            error_code: Some(status.as_u16().to_string()),
                            summary: None,
                            zip_size_bytes: None,
                        });
                    }
                }
            }
            Err(e) => {
                let _ = std::fs::remove_file(zip_path);
                let op_error = classify_reqwest_error(WebDavOperation::UploadBackup, &e);
                return Ok(WebDavUploadResult {
                    success: false,
                    remote_file_name: None,
                    error: Some(webdav_error_message(&op_error)),
                    error_stage: Some("network".to_string()),
                    error_code: op_error.status.map(|s| s.to_string()),
                    summary: None,
                    zip_size_bytes: None,
                });
            }
        }
    }
    let _ = std::fs::remove_file(zip_path);
    Ok(WebDavUploadResult {
        success: false,
        remote_file_name: None,
        error: Some(last_error),
        error_stage: Some("upload_retry_exhausted".to_string()),
        error_code: None,
        summary: None,
        zip_size_bytes: None,
    })
}
#[tauri::command]
pub async fn webdav_create_remote_backup(
    app: tauri::AppHandle,
    config: WebDavConfig,
) -> Result<WebDavUploadResult, String> {
    let _guard = match webdav_create_backup_lock().try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            return Ok(WebDavUploadResult {
                success: false,
                remote_file_name: None,
                error: Some(
                    "webdav_backup_busy: another backup is already in progress".to_string(),
                ),
                error_stage: Some("lock".to_string()),
                error_code: None,
                summary: None,
                zip_size_bytes: None,
            });
        }
    };
    let store = SystemWebDavCredentialStore::new();
    let secret = match resolve_webdav_operation_secret(&app, &config, &store) {
        Ok(s) => s,
        Err(e) => {
            return Ok(WebDavUploadResult {
                success: false,
                remote_file_name: None,
                error: Some(e),
                error_stage: Some("credential".to_string()),
                error_code: None,
                summary: None,
                zip_size_bytes: None,
            });
        }
    };
    let mut config = config;
    config.password = Some(secret);
    // C-W7：先 pin client，再组装请求 URL（fail-fast DNS/S2）
    let client = {
        let base_url = match normalize_webdav_url(&config.server_url) {
            Ok(u) => u,
            Err(e) => {
                return Ok(WebDavUploadResult {
                    success: false,
                    remote_file_name: None,
                    error: Some(e),
                    error_stage: Some("config".to_string()),
                    error_code: None,
                    summary: None,
                    zip_size_bytes: None,
                });
            }
        };
        let (host, port) = match authority_from_base_url(&base_url) {
            Ok(hp) => hp,
            Err(e) => {
                return Ok(WebDavUploadResult {
                    success: false,
                    remote_file_name: None,
                    error: Some(e),
                    error_stage: Some("config".to_string()),
                    error_code: None,
                    summary: None,
                    zip_size_bytes: None,
                });
            }
        };
        let trust_host = config.trust_host;
        match build_webdav_http_client(
            &host,
            port,
            Duration::from_secs(60),
            Arc::new(SystemResolver),
            trust_host,
        ) {
            Ok(c) => c,
            Err(e) => {
                return Ok(WebDavUploadResult {
                    success: false,
                    remote_file_name: None,
                    error: Some(e),
                    error_stage: Some("upload".to_string()),
                    error_code: None,
                    summary: None,
                    zip_size_bytes: None,
                });
            }
        }
    };
    let target = match build_webdav_request_target(&config) {
        Ok(t) => t,
        Err(e) => {
            return Ok(WebDavUploadResult {
                success: false,
                remote_file_name: None,
                error: Some(e),
                error_stage: Some("config".to_string()),
                error_code: None,
                summary: None,
                zip_size_bytes: None,
            });
        }
    };
    let pending_dir = match webdav_pending_dir(&app) {
        Ok(d) => d,
        Err(e) => {
            return Ok(WebDavUploadResult {
                success: false,
                remote_file_name: None,
                error: Some(e),
                error_stage: Some("create-zip".to_string()),
                error_code: None,
                summary: None,
                zip_size_bytes: None,
            });
        }
    };
    if let Err(e) = std::fs::create_dir_all(&pending_dir) {
        return Ok(WebDavUploadResult {
            success: false,
            remote_file_name: None,
            error: Some(format!("创建本地临时目录失败: {e}")),
            error_stage: Some("create-zip".to_string()),
            error_code: None,
            summary: None,
            zip_size_bytes: None,
        });
    }
    let temp_id: u64 = rand::random();
    let temp_zip_name = format!("webdav-pending-{temp_id:016x}.zip");
    let temp_zip_path = pending_dir.join(&temp_zip_name);
    let temp_zip_path_str = temp_zip_path.to_string_lossy().to_string();
    let backup_result = match backup::create_local_backup(app.clone(), temp_zip_path_str).await {
        Ok(r) => r,
        Err(e) => {
            let _ = std::fs::remove_file(&temp_zip_path);
            return Ok(WebDavUploadResult {
                success: false,
                remote_file_name: None,
                error: Some(e),
                error_stage: Some("create-zip".to_string()),
                error_code: None,
                summary: None,
                zip_size_bytes: None,
            });
        }
    };
    if !backup_result.success {
        let _ = std::fs::remove_file(&temp_zip_path);
        return Ok(WebDavUploadResult {
            success: false,
            remote_file_name: None,
            error: Some(backup_result.error.unwrap_or_else(|| "创建备份文件失败".to_string())),
            error_stage: Some("create-zip".to_string()),
            error_code: None,
            summary: None,
            zip_size_bytes: None,
        });
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
        return Ok(WebDavUploadResult {
            success: false,
            remote_file_name: None,
            error: Some("备份文件路径校验失败".to_string()),
            error_stage: Some("create-zip".to_string()),
            error_code: None,
            summary: None,
            zip_size_bytes: None,
        });
    }
    let mut upload_result = webdav_upload_backup_with_client(&client, &target, &actual_zip_path).await;
    if actual_zip_path != temp_zip_path {
        let _ = std::fs::remove_file(&temp_zip_path);
    }
    if let Ok(ref mut r) = upload_result {
        if r.success {
            r.summary = backup_result.summary;
            r.zip_size_bytes = backup_result.zip_size_bytes;
        }
    }
    upload_result
}
/// 下载核心实现：接受注入的临时目录和大小上限，便于测试。
///
/// 生产入口 `webdav_download_backup_with_client` 委托本函数，
/// 传入应用缓存目录和 `MAX_WEBDAV_BACKUP_DOWNLOAD_BYTES`。
/// 测试入口传入临时目录和较小的 `max_bytes` 以避免分配大内存。
pub(crate) async fn download_backup_with_limit(
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
pub(crate) async fn webdav_download_backup_with_client(
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
    let downloads_dir = webdav_downloads_dir(&app)?;
    std::fs::create_dir_all(&downloads_dir)
        .map_err(|_| "远端备份下载失败，本地数据未受影响".to_string())?;
    // C-W7：先 pin client，再组装请求 URL
    let base_url = normalize_webdav_url(&config.server_url)?;
    let (host, port) = authority_from_base_url(&base_url)?;
    let trust_host = config.trust_host;
    let client = build_webdav_http_client(
        &host,
        port,
        Duration::from_secs(120),
        Arc::new(SystemResolver),
        trust_host,
    )
    .map_err(|_| "远端备份下载失败，本地数据未受影响".to_string())?;
    let target = build_webdav_request_target(&config)?;
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
