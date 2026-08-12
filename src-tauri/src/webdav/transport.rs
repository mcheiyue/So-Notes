//! WebDAV 传输层：RequestTarget、PROPFIND、test/list/delete
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;

use super::config::{
    config_file_path, normalize_remote_dir, resolve_operation_secret_from_path,
    resolve_webdav_operation_secret, validate_remote_backup_filename,
};
use super::credential::{
    compute_credential_key, SystemWebDavCredentialStore, WebDavCredentialKey,
    WebDavCredentialStore, CREDENTIAL_SERVICE,
};
use super::error::*;
use super::ssrf::*;
use super::types::*;

// ---------------------------------------------------------------------------
// URL 构建
// ---------------------------------------------------------------------------
pub(crate) fn build_remote_dir_url(base_url: &str, remote_dir: &str) -> String {
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
// ---------------------------------------------------------------------------
// PROPFIND 请求
// ---------------------------------------------------------------------------
pub(crate) fn propfind_request(
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
pub(crate) fn webdav_request_with_auth(
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
pub(crate) async fn ensure_remote_dir_exists(
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
pub(crate) struct PropfindEntry {
    pub(crate) href: String,
    pub(crate) status: Option<String>,
    pub(crate) content_length: Option<u64>,
    pub(crate) last_modified: Option<String>,
    pub(crate) is_collection: bool,
}
pub(crate) fn parse_propfind_response(xml: &str) -> Result<Vec<PropfindEntry>, WebDavOperationError> {
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
pub(crate) fn extract_status_code(status: &str) -> Option<u16> {
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
pub(crate) fn decode_href_basename(href: &str) -> Option<String> {
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
pub(crate) fn hex_val(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}
pub(crate) fn filter_backup_entries(entries: Vec<PropfindEntry>) -> Vec<WebDavRemoteBackup> {
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
pub(crate) async fn webdav_test_connection_with_client(
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
    // C-W7：先 pin client，再组装请求 URL
    let base_url = normalize_webdav_url(&config.server_url)?;
    let (host, port) = authority_from_base_url(&base_url)?;
    let trust_host = config.trust_host;
    let client = build_webdav_http_client(
        &host,
        port,
        Duration::from_secs(15),
        Arc::new(SystemResolver),
        trust_host,
    )
    .map_err(|_| "WebDAV 地址不可访问".to_string())?;
    let target = build_webdav_request_target(&config)?;
    webdav_test_connection_with_client(&client, &target).await
}
pub(crate) async fn webdav_list_backups_with_client(
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
    // C-W7：先 pin client，再组装请求 URL
    let base_url = normalize_webdav_url(&config.server_url)?;
    let (host, port) = authority_from_base_url(&base_url)?;
    let trust_host = config.trust_host;
    let client = build_webdav_http_client(
        &host,
        port,
        Duration::from_secs(15),
        Arc::new(SystemResolver),
        trust_host,
    )
    .map_err(|_| "远端备份列表读取失败".to_string())?;
    let target = build_webdav_request_target(&config)?;
    webdav_list_backups_with_client(&client, &target).await
}
pub(crate) async fn webdav_delete_backup_with_client(
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
    // C-W7：先 pin client，再组装请求 URL
    let base_url = normalize_webdav_url(&config.server_url)?;
    let (host, port) = authority_from_base_url(&base_url)?;
    let trust_host = config.trust_host;
    let client = build_webdav_http_client(
        &host,
        port,
        Duration::from_secs(30),
        Arc::new(SystemResolver),
        trust_host,
    )
    .map_err(|_| "远端备份删除失败".to_string())?;
    let target = build_webdav_request_target(&config)?;
    webdav_delete_backup_with_client(&client, &target, &remote_file_name).await
}
