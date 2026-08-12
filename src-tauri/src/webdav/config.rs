//! WebDAV 配置路径、原子写、load/save/clear 与目录/文件名规范化
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;
use url::Url;

use super::credential::{
    compute_credential_key, SystemWebDavCredentialStore, WebDavCredentialErrorKind,
    WebDavCredentialKey, WebDavCredentialStore, CREDENTIAL_SERVICE,
};
use super::ssrf::{
    build_webdav_http_client, canonical_host_from_str, normalize_webdav_url, SystemResolver,
};
use super::types::*;

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
    if name.contains('?') || name.contains('#') {
        return Err("远端目录名不能包含 ? 或 #".to_string());
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
    // 日历合法性校验（与 TS parseRemoteBackupFileName 对齐）
    let month: u32 = datetime_part[4..6].parse().unwrap_or(u32::MAX);
    let day: u32 = datetime_part[6..8].parse().unwrap_or(u32::MAX);
    let hour: u32 = datetime_part[8..10].parse().unwrap_or(u32::MAX);
    let minute: u32 = datetime_part[10..12].parse().unwrap_or(u32::MAX);
    let second: u32 = datetime_part[12..14].parse().unwrap_or(u32::MAX);
    if month < 1 || month > 12 {
        return Err("月份必须为 01-12".to_string());
    }
    if day < 1 || day > 31 {
        return Err("日期必须为 01-31".to_string());
    }
    if hour > 23 {
        return Err("小时必须为 00-23".to_string());
    }
    if minute > 59 {
        return Err("分钟必须为 00-59".to_string());
    }
    if second > 59 {
        return Err("秒必须为 00-59".to_string());
    }
    // 使用 chrono 验证日期合法性（如 2 月 30 日）
    let year: i32 = datetime_part[0..4].parse().unwrap_or(0);
    if chrono::NaiveDate::from_ymd_opt(year, month, day).is_none() {
        return Err("日期不合法（如 2 月 30 日）".to_string());
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
pub(crate) fn chrono_now_datetime_string() -> String {
    chrono::Local::now().format("%Y%m%d%H%M%S").to_string()
}
// ---------------------------------------------------------------------------
// 配置文件路径
// ---------------------------------------------------------------------------
/// 获取 WebDAV 配置文件的路径。
pub(crate) fn config_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取应用配置目录失败: {e}"))?;
    Ok(config_dir.join(CONFIG_FILENAME))
}
pub(crate) struct WebDavTempFileGuard {
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
pub(crate) fn webdav_config_temp_path(path: &Path) -> Result<PathBuf, String> {
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
pub(crate) fn webdav_config_backup_path(path: &Path) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "WebDAV 配置文件路径缺少父目录".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "WebDAV 配置文件名无效".to_string())?;
    Ok(parent.join(format!("{file_name}.bak")))
}
#[cfg(windows)]
pub(crate) fn replace_webdav_config_file(tmp_path: &Path, path: &Path) -> Result<(), String> {
    let backup_path = webdav_config_backup_path(path)?;
    let _ = std::fs::remove_file(&backup_path);
    if path.exists() {
        std::fs::rename(path, &backup_path)
            .map_err(|e| format!("备份旧 WebDAV 配置文件失败: {e}"))?;
    }
    match std::fs::rename(tmp_path, path) {
        Ok(()) => {
            let _ = std::fs::remove_file(&backup_path);
            Ok(())
        }
        Err(e) => {
            if backup_path.exists() {
                let _ = std::fs::rename(&backup_path, path);
            }
            Err(format!("替换 WebDAV 配置文件失败: {e}"))
        }
    }
}
#[cfg(not(windows))]
pub(crate) fn replace_webdav_config_file(tmp_path: &Path, path: &Path) -> Result<(), String> {
    std::fs::rename(tmp_path, path).map_err(|e| format!("替换 WebDAV 配置文件失败: {e}"))
}
#[cfg(windows)]
pub(crate) fn recover_orphaned_webdav_config_backup_if_missing(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    let backup_path = webdav_config_backup_path(path)?;
    if !backup_path.exists() {
        return Ok(());
    }
    std::fs::rename(&backup_path, path).map_err(|e| format!("恢复 WebDAV 配置文件 .bak 失败: {e}"))
}
#[cfg(not(windows))]
pub(crate) fn recover_orphaned_webdav_config_backup_if_missing(_path: &Path) -> Result<(), String> {
    Ok(())
}
pub(crate) fn write_webdav_config_atomic(path: &Path, content: &str) -> Result<(), String> {
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
    replace_webdav_config_file(&tmp_path, path)?;
    guard.disarm();
    Ok(())
}
pub(crate) fn load_existing_webdav_config_for_save(path: &Path) -> Result<Option<WebDavConfigFile>, String> {
    recover_orphaned_webdav_config_backup_if_missing(path)?;
    if !path.exists() {
        return Ok(None);
    }
    let content =
        std::fs::read_to_string(path).map_err(|e| format!("读取 WebDAV 配置文件失败: {e}"))?;
    let config = serde_json::from_str::<WebDavConfigFile>(&content)
        .map_err(|e| format!("解析 WebDAV 配置文件失败: {e}"))?;
    Ok(Some(config))
}
pub(crate) fn delete_replaced_credential_after_config_write(
    store: &impl WebDavCredentialStore,
    old_credential_key: Option<&str>,
    new_key: &str,
) -> Option<String> {
    let Some(old_key_str) = old_credential_key else {
        return None;
    };
    if old_key_str == new_key {
        return None;
    }
    let old_cred_key = WebDavCredentialKey {
        service: "SoNotes.WebDAV".to_string(),
        account: old_key_str.to_string(),
    };
    store.delete(&old_cred_key).err().map(|_e| {
        "新配置已保存，但旧凭据可能需要手动删除".to_string()
    })
}
pub(crate) fn rollback_saved_credential_after_config_write_failure(
    store: &impl WebDavCredentialStore,
    old_credential_key: Option<&str>,
    new_key: &str,
    previous_same_key_secret: Option<String>,
) {
    let new_cred_key = WebDavCredentialKey {
        service: CREDENTIAL_SERVICE.to_string(),
        account: new_key.to_string(),
    };
    if old_credential_key == Some(new_key) {
        if let Some(secret) = previous_same_key_secret {
            let _ = store.save(&new_cred_key, &secret);
        } else {
            // 旧 secret 明确缺失时删除刚写入的新 secret，避免写盘失败后新密码残留密钥链
            let _ = store.delete(&new_cred_key);
        }
        return;
    }
    let _ = store.delete(&new_cred_key);
}
pub(crate) fn save_webdav_config_to_path(
    path: &Path,
    request: &WebDavConfigSaveRequest,
    old_config: Option<&WebDavConfigFile>,
    store: &impl WebDavCredentialStore,
) -> Result<WebDavConfigSaveResult, String> {
    save_webdav_config_to_path_with_writer(
        path,
        request,
        old_config,
        store,
        write_webdav_config_atomic,
    )
}
pub(crate) fn save_webdav_config_to_path_with_writer(
    path: &Path,
    request: &WebDavConfigSaveRequest,
    old_config: Option<&WebDavConfigFile>,
    store: &impl WebDavCredentialStore,
    write_config: impl Fn(&Path, &str) -> Result<(), String>,
) -> Result<WebDavConfigSaveResult, String> {
    let (config, old_credential_key) = prepare_config_save(request, old_config)?;
    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("序列化 WebDAV 配置失败: {e}"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建 WebDAV 配置目录失败: {e}"))?;
    }
    if request.remember_password {
        let password = request.password.as_deref().unwrap_or("");
        let new_key = config.credential_key.as_ref().unwrap();
        let new_cred_key = WebDavCredentialKey {
            service: CREDENTIAL_SERVICE.to_string(),
            account: new_key.clone(),
        };
        let previous_same_key_secret = if old_credential_key.as_deref() == Some(new_key) {
            match store.load(&new_cred_key) {
                Ok(secret) => Some(secret),
                Err(err) if err.kind == WebDavCredentialErrorKind::MissingSecret => None,
                // 读取失败时无法安全回滚旧值，拒绝覆盖密钥链中的 secret
                Err(err) => {
                    return Err(format!(
                        "读取既有凭据失败，已中止保存以避免无法回滚: {err}"
                    ));
                }
            }
        } else {
            None
        };
        store
            .save(&new_cred_key, password)
            .map_err(|e| format!("保存密码到系统凭据失败: {e}"))?;
        if let Err(e) = write_config(path, &json) {
            rollback_saved_credential_after_config_write_failure(
                store,
                old_credential_key.as_deref(),
                new_key,
                previous_same_key_secret,
            );
            return Err(format!("写入 WebDAV 配置文件失败: {e}"));
        }
        let warning = delete_replaced_credential_after_config_write(
            store,
            old_credential_key.as_deref(),
            new_key,
        );
        return Ok(WebDavConfigSaveResult {
            success: true,
            warning,
            error: None,
        });
    }
    write_config(path, &json)?;
    let warning = if let Some(ref old_key_str) = old_credential_key {
        let old_cred_key = WebDavCredentialKey {
            service: CREDENTIAL_SERVICE.to_string(),
            account: old_key_str.clone(),
        };
        store.delete(&old_cred_key).err().map(|_e| {
            "配置已更新，但系统凭据可能需要手动删除".to_string()
        })
    } else {
        None
    };
    Ok(WebDavConfigSaveResult {
        success: true,
        warning,
        error: None,
    })
}
pub(crate) fn remove_webdav_config_backup_if_exists(path: &Path) -> Result<(), String> {
    let backup_path = webdav_config_backup_path(path)?;
    if backup_path.exists() {
        std::fs::remove_file(&backup_path)
            .map_err(|e| format!("删除 WebDAV 配置备份文件失败: {e}"))?;
    }
    Ok(())
}
pub(crate) fn clear_webdav_config_from_path(
    path: &Path,
    store: &impl WebDavCredentialStore,
) -> Result<WebDavConfigClearResult, String> {
    recover_orphaned_webdav_config_backup_if_missing(path)?;
    let old_credential_key = if path.exists() {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|content| serde_json::from_str::<WebDavConfigFile>(&content).ok())
            .and_then(|config_file| config_file.credential_key)
    } else {
        None
    };
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| format!("删除 WebDAV 配置文件失败: {e}"))?;
    }
    remove_webdav_config_backup_if_exists(path)?;
    let mut secret_cleanup_warning = None;
    if let Some(key_str) = old_credential_key {
        let cred_key = WebDavCredentialKey {
            service: CREDENTIAL_SERVICE.to_string(),
            account: key_str,
        };
        if let Err(e) = store.delete(&cred_key) {
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
pub(crate) fn resolve_operation_secret_from_path(
    path: &Path,
    config: &WebDavConfig,
    store: &dyn WebDavCredentialStore,
) -> Result<String, String> {
    recover_orphaned_webdav_config_backup_if_missing(path)?;
    resolve_operation_secret_core(Some(path), config, store)
}
/// 凭据解析固定 service 常量，与 `save_config` / `load_config` 保持一致。
/// 解析远端操作所需的密码/令牌（核心逻辑，不依赖 AppHandle）。
///
/// 优先级：
/// 1. `config.password` 非空 → 直接使用（前端本次传入）。
/// 2. 读取已保存的配置文件，从中获取 `credential_key` → 从密钥链加载。
/// 3. 都无法获取 → 返回错误提示。
pub(crate) fn resolve_operation_secret_core(
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
    // 校验当前操作的 identity tuple 与 saved config 一致，
    // 防止用户修改服务器地址后旧 secret 被复用到不同目标。
    let current_url = normalize_webdav_url(&config.server_url)
        .map_err(|_| "WebDAV 地址格式错误，请检查后重新输入。".to_string())?;
    let current_dir = normalize_remote_dir(config.remote_dir.as_deref().unwrap_or(""))
        .map_err(|_| "远端目录格式错误，请检查后重新输入。".to_string())?;
    let current_key = compute_credential_key(&current_url, &config.username, &current_dir);
    if current_key != key_str {
        return Err("当前 WebDAV 地址、用户名或目录与已保存配置不一致，请重新输入密码。".to_string());
    }
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
pub(crate) fn resolve_webdav_operation_secret(
    app: &tauri::AppHandle,
    config: &WebDavConfig,
    store: &dyn WebDavCredentialStore,
) -> Result<String, String> {
    let path = config_file_path(app)?;
    resolve_operation_secret_from_path(&path, config, store)
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
    recover_orphaned_webdav_config_backup_if_missing(&path)?;
    if !path.exists() {
        return Ok(WebDavConfigLoadResult {
            success: true,
            server_url: None,
            username: None,
            remote_dir: None,
            password_saved: false,
            error: None,
            trust_host: false,
        });
    }
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("读取 WebDAV 配置文件失败: {e}"))?;
    let config: WebDavConfigFile =
        serde_json::from_str(&content).map_err(|e| format!("解析 WebDAV 配置文件失败: {e}"))?;
    let trust_host = resolve_trust_host_for_load(&config);
    Ok(WebDavConfigLoadResult {
        success: true,
        server_url: Some(config.server_url),
        username: Some(config.username),
        remote_dir: Some(config.remote_dir),
        password_saved: config.password_saved && config.credential_key.is_some(),
        error: None,
        trust_host,
    })
}
/// load 时校验 trusted_host 指纹与当前 server_url host 是否匹配。
pub(crate) fn resolve_trust_host_for_load(file: &WebDavConfigFile) -> bool {
    let host_str = Url::parse(&file.server_url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))
        .unwrap_or_default();
    let current_host = canonical_host_from_str(&host_str);
    match &file.trusted_host {
        Some(fingerprint) if *fingerprint == current_host => file.trust_host,
        Some(_) => false,
        None => file.trust_host,
    }
}
/// 纯校验+规范化：将前端保存请求转换为可安全持久化的配置结构。
///
/// 职责：
/// - 通过 `normalize_webdav_url` 规范化 `server_url`。
/// - 通过 `normalize_remote_dir` 规范化 `remote_dir`。
/// - 计算 `credential_key`（不含密码）。
/// - 永远不将密码/令牌写入磁盘。
pub(crate) fn prepare_config_save(
    request: &WebDavConfigSaveRequest,
    old_config: Option<&WebDavConfigFile>,
) -> Result<(WebDavConfigFile, Option<String>), String> {
    let server_url = normalize_webdav_url(&request.server_url)?;
    let remote_dir = normalize_remote_dir(request.remote_dir.as_deref().unwrap_or(""))?;
    let new_key = compute_credential_key(&server_url, &request.username, &remote_dir);
    let old_credential_key = old_config.and_then(|c| c.credential_key.clone());
    // trust 绑定：host 变更需用户 re-opt-in；canonical 相同则按 request 写入
    let host_str = Url::parse(&server_url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))
        .unwrap_or_default();
    let new_host = canonical_host_from_str(&host_str);
    let old_trusted = old_config.and_then(|c| c.trusted_host.clone());
    let (trust_host, trusted_host) = match old_trusted {
        Some(ref fp) if *fp == new_host => {
            if request.trust_host {
                (true, Some(new_host.clone()))
            } else {
                (false, None)
            }
        }
        Some(_) if request.trust_host => (true, Some(new_host.clone())),
        Some(_) => (false, None),
        None => {
            if request.trust_host {
                (true, Some(new_host.clone()))
            } else {
                (false, None)
            }
        }
    };
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
            trust_host,
            trusted_host,
        };
        return Ok((config, old_credential_key));
    }
    let config = WebDavConfigFile {
        server_url,
        username: request.username.clone(),
        remote_dir,
        password_saved: false,
        credential_key: None,
        trust_host,
        trusted_host,
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
    let old_config = load_existing_webdav_config_for_save(&path)?;
    let store = SystemWebDavCredentialStore::new();
    save_webdav_config_to_path(&path, &request, old_config.as_ref(), &store)
}
/// 清除 WebDAV 配置。
///
/// 删除应用配置目录中的 `webdav-config.json` 文件。
/// 如果删除失败，返回可见错误。
#[tauri::command]
pub async fn webdav_clear_config(app: tauri::AppHandle) -> Result<WebDavConfigClearResult, String> {
    let path = config_file_path(&app)?;
    let store = SystemWebDavCredentialStore::new();
    clear_webdav_config_from_path(&path, &store)
}
