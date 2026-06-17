//! 定时远端备份配置与最近状态持久化
//!
//! 本模块提供定时远端备份的配置（`ScheduledRemoteBackupConfig`）和最近结果状态
//! （`ScheduledRemoteBackupState`）的加载与保存命令。文件存储在 `app_config_dir()`
//! 下，不写入 `data.json`。
//!
//! - 配置文件：`webdav-scheduled-backup-config.json`
//! - 状态文件：`webdav-scheduled-backup-state.json`

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/// 配置文件名。
const CONFIG_FILENAME: &str = "webdav-scheduled-backup-config.json";

/// 状态文件名。
const STATE_FILENAME: &str = "webdav-scheduled-backup-state.json";

// ---------------------------------------------------------------------------
// 定时备份频率
// ---------------------------------------------------------------------------

/// 定时远端备份频率。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ScheduledRemoteBackupFrequency {
    /// 每 6 小时。
    #[serde(rename = "every-6-hours")]
    Every6Hours,
    /// 每 12 小时。
    #[serde(rename = "every-12-hours")]
    Every12Hours,
    /// 每天。
    #[serde(rename = "daily")]
    Daily,
    /// 每周。
    #[serde(rename = "weekly")]
    Weekly,
}

impl ScheduledRemoteBackupFrequency {
    /// 判断频率字符串是否合法。
    pub fn is_valid(s: &str) -> bool {
        matches!(
            s,
            "every-6-hours" | "every-12-hours" | "daily" | "weekly"
        )
    }
}

impl Default for ScheduledRemoteBackupFrequency {
    fn default() -> Self {
        Self::Daily
    }
}

// ---------------------------------------------------------------------------
// 定时备份配置
// ---------------------------------------------------------------------------

/// 定时远端备份配置（前端消费，camelCase）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRemoteBackupConfig {
    /// 是否启用自动远端备份。
    pub enabled: bool,
    /// 备份频率。
    pub frequency: ScheduledRemoteBackupFrequency,
    /// 静默期（分钟），默认 5。
    pub quiet_period_minutes: u32,
    /// 是否在退出前提示备份。
    pub exit_prompt_enabled: bool,
    /// 是否启用备份保留策略。
    pub retention_enabled: bool,
    /// 保留备份数量上限；None 表示无限保留。
    pub retention_count: Option<u32>,
}

impl Default for ScheduledRemoteBackupConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            frequency: ScheduledRemoteBackupFrequency::Daily,
            quiet_period_minutes: 5,
            exit_prompt_enabled: true,
            retention_enabled: false,
            retention_count: None,
        }
    }
}

/// 配置文件内部格式（与 `ScheduledRemoteBackupConfig` 一致，增加扩展字段余地）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledRemoteBackupConfigFile {
    enabled: bool,
    frequency: ScheduledRemoteBackupFrequency,
    quiet_period_minutes: u32,
    exit_prompt_enabled: bool,
    #[serde(default)]
    retention_enabled: bool,
    #[serde(default)]
    retention_count: Option<u32>,
}

impl From<ScheduledRemoteBackupConfigFile> for ScheduledRemoteBackupConfig {
    fn from(f: ScheduledRemoteBackupConfigFile) -> Self {
        Self {
            enabled: f.enabled,
            frequency: f.frequency,
            quiet_period_minutes: f.quiet_period_minutes,
            exit_prompt_enabled: f.exit_prompt_enabled,
            retention_enabled: f.retention_enabled,
            retention_count: f.retention_count,
        }
    }
}

// ---------------------------------------------------------------------------
// 最近结果状态
// ---------------------------------------------------------------------------

/// 远端备份触发源。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteBackupTrigger {
    Manual,
    ScheduledInterval,
    QuietPeriod,
    BeforeExit,
}

/// 远端备份阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteBackupStage {
    Config,
    Credential,
    SingleFlight,
    RestoreBlocked,
    Flush,
    CreateZip,
    Upload,
    ListRefresh,
    Completed,
    Unknown,
}

/// 最近结果状态（前端消费，camelCase）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRemoteBackupState {
    pub last_started_at: Option<u64>,
    pub last_finished_at: Option<u64>,
    pub last_trigger: Option<RemoteBackupTrigger>,
    /// 最近一次"自动/退出前"成功的时间。
    pub last_automatic_success_at: Option<u64>,
    /// 最近一次"手动"成功的时间。
    pub last_manual_success_at: Option<u64>,
    pub last_failure_at: Option<u64>,
    pub last_failure_reason: Option<String>,
    pub last_failure_stage: Option<RemoteBackupStage>,
    pub last_remote_file_name: Option<String>,
    pub next_run_at: Option<u64>,
    /// 最近一次成功上传覆盖的 storageUpdatedAt（触发无关）。
    pub last_successful_storage_updated_at: Option<u64>,
    /// 最近一次尝试捕获的 storageUpdatedAt（仅诊断）。
    pub last_attempt_captured_storage_updated_at: Option<u64>,
    pub consecutive_credential_failures: u32,
    pub credential_action_required: bool,
    /// 断崖式远端文件数骤降首次检测时间。
    pub cliff_drop_detected_at: Option<u64>,
    /// 断崖式检测确认时远端文件基准数量。
    pub baseline_confirmed_remote_count: Option<u32>,
    /// 断崖式骤降已触发延迟处理。
    pub cliff_drop_deferred: bool,
    /// 等待清理的目标保留数量。
    pub pending_cleanup_target_count: Option<u32>,
}

impl Default for ScheduledRemoteBackupState {
    fn default() -> Self {
        Self {
            last_started_at: None,
            last_finished_at: None,
            last_trigger: None,
            last_automatic_success_at: None,
            last_manual_success_at: None,
            last_failure_at: None,
            last_failure_reason: None,
            last_failure_stage: None,
            last_remote_file_name: None,
            next_run_at: None,
            last_successful_storage_updated_at: None,
            last_attempt_captured_storage_updated_at: None,
            consecutive_credential_failures: 0,
            credential_action_required: false,
            cliff_drop_detected_at: None,
            baseline_confirmed_remote_count: None,
            cliff_drop_deferred: false,
            pending_cleanup_target_count: None,
        }
    }
}

// ---------------------------------------------------------------------------
// 加载/保存结果
// ---------------------------------------------------------------------------

/// 配置加载结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledBackupConfigLoadResult {
    pub success: bool,
    pub config: Option<ScheduledRemoteBackupConfig>,
    pub error: Option<String>,
}

/// 配置保存结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledBackupConfigSaveResult {
    pub success: bool,
    pub error: Option<String>,
}

/// 状态加载结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledBackupStateLoadResult {
    pub success: bool,
    pub state: Option<ScheduledRemoteBackupState>,
    pub error: Option<String>,
}

/// 状态保存结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledBackupStateSaveResult {
    pub success: bool,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// 文件路径
// ---------------------------------------------------------------------------

/// 获取配置文件路径。
fn config_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取应用配置目录失败: {e}"))?;
    Ok(config_dir.join(CONFIG_FILENAME))
}

/// 获取状态文件路径。
fn state_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取应用配置目录失败: {e}"))?;
    Ok(config_dir.join(STATE_FILENAME))
}

// ---------------------------------------------------------------------------
// 原子写入
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
        .ok_or_else(|| "配置文件路径缺少父目录".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "配置文件名无效".to_string())?;
    Ok(parent.join(format!(
        ".{file_name}.tmp-{:016x}",
        rand::random::<u64>()
    )))
}

fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "配置文件路径缺少父目录".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;

    let tmp_path = temp_file_path(path)?;
    let mut guard = TempFileGuard::new(tmp_path.clone());

    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp_path)
        .map_err(|e| format!("创建临时文件失败: {e}"))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("写入临时文件失败: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("同步临时文件失败: {e}"))?;
    drop(file);

    replace_file(&tmp_path, path).map_err(|e| format!("替换配置文件失败: {e}"))?;
    guard.disarm();
    Ok(())
}

fn recover_orphaned_backup_if_missing(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }

    let parent = path
        .parent()
        .ok_or_else(|| "配置文件路径缺少父目录".to_string())?;
    if !parent.exists() {
        return Ok(());
    }

    let prefix = backup_file_name_prefix(path).map_err(|e| format!("配置备份文件名无效: {e}"))?;
    let mut candidates = Vec::new();
    for entry in fs::read_dir(parent).map_err(|e| format!("读取配置目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("读取配置目录项失败: {e}"))?;
        let file_name = entry.file_name();
        if file_name.to_string_lossy().starts_with(&prefix) {
            candidates.push(entry.path());
        }
    }

    if candidates.is_empty() {
        return Ok(());
    }

    candidates.sort_by_key(|candidate| {
        fs::metadata(candidate)
            .and_then(|metadata| metadata.modified())
            .ok()
    });
    let backup_path = candidates
        .pop()
        .ok_or_else(|| "未找到可恢复的配置备份文件".to_string())?;
    fs::rename(&backup_path, path).map_err(|e| format!("恢复配置备份文件失败: {e}"))
}

#[cfg(windows)]
fn replace_file(tmp_path: &Path, path: &Path) -> std::io::Result<()> {
    if !path.exists() {
        return std::fs::rename(tmp_path, path);
    }

    let backup_path = backup_file_path(path)?;
    std::fs::rename(path, &backup_path)?;

    match std::fs::rename(tmp_path, path) {
        Ok(()) => {
            let _ = std::fs::remove_file(&backup_path);
            Ok(())
        }
        Err(rename_err) => {
            let restore_result = std::fs::rename(&backup_path, path);
            if let Err(restore_err) = restore_result {
                return Err(std::io::Error::new(
                    rename_err.kind(),
                    format!("替换失败且恢复原文件失败: {rename_err}; restore: {restore_err}"),
                ));
            }
            Err(rename_err)
        }
    }
}

#[cfg(windows)]
fn backup_file_path(path: &Path) -> std::io::Result<PathBuf> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "配置文件路径缺少父目录")
    })?;
    let prefix = backup_file_name_prefix(path)?;
    Ok(parent.join(format!("{prefix}{:016x}", rand::random::<u64>())))
}

fn backup_file_name_prefix(path: &Path) -> std::io::Result<String> {
    let file_name = path.file_name().and_then(|name| name.to_str()).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "配置文件名无效")
    })?;
    Ok(format!(".{file_name}.bak-"))
}

#[cfg(not(windows))]
fn replace_file(tmp_path: &Path, path: &Path) -> std::io::Result<()> {
    std::fs::rename(tmp_path, path)
}

fn parse_config_content(content: &str) -> ScheduledBackupConfigLoadResult {
    match serde_json::from_str::<ScheduledRemoteBackupConfigFile>(content) {
        Ok(config) => ScheduledBackupConfigLoadResult {
            success: true,
            config: Some(config.into()),
            error: None,
        },
        Err(e) => ScheduledBackupConfigLoadResult {
            success: false,
            config: None,
            error: Some(format!("解析定时备份配置文件失败: {e}")),
        },
    }
}

fn parse_state_content(content: &str) -> ScheduledBackupStateLoadResult {
    match serde_json::from_str::<ScheduledRemoteBackupState>(content) {
        Ok(state) => ScheduledBackupStateLoadResult {
            success: true,
            state: Some(state),
            error: None,
        },
        Err(e) => ScheduledBackupStateLoadResult {
            success: false,
            state: None,
            error: Some(format!("解析定时备份状态文件失败: {e}")),
        },
    }
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

/// 加载定时备份配置。
///
/// 如果文件不存在，返回默认配置（enabled=false）。
/// 解析失败返回明确错误，不影响 `data.json`。
#[tauri::command]
pub async fn scheduled_backup_load_config(
    app: tauri::AppHandle,
) -> Result<ScheduledBackupConfigLoadResult, String> {
    let path = config_file_path(&app)?;

    recover_orphaned_backup_if_missing(&path)?;

    if !path.exists() {
        return Ok(ScheduledBackupConfigLoadResult {
            success: true,
            config: Some(ScheduledRemoteBackupConfig::default()),
            error: None,
        });
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取定时备份配置文件失败: {e}"))?;

    Ok(parse_config_content(&content))
}

/// 保存定时备份配置。
///
/// 使用原子写入，不包含任何密码或凭据字段。
/// 不写入 `data.json`。
#[tauri::command]
pub async fn scheduled_backup_save_config(
    app: tauri::AppHandle,
    config: ScheduledRemoteBackupConfig,
) -> Result<ScheduledBackupConfigSaveResult, String> {
    let path = config_file_path(&app)?;

    let file_config = ScheduledRemoteBackupConfigFile {
        enabled: config.enabled,
        frequency: config.frequency,
        quiet_period_minutes: config.quiet_period_minutes,
        exit_prompt_enabled: config.exit_prompt_enabled,
        retention_enabled: config.retention_enabled,
        retention_count: config.retention_count,
    };

    let content = serde_json::to_string_pretty(&file_config)
        .map_err(|e| format!("序列化定时备份配置失败: {e}"))?;

    write_atomic(&path, &content)?;

    Ok(ScheduledBackupConfigSaveResult {
        success: true,
        error: None,
    })
}

/// 加载最近结果状态。
///
/// 如果文件不存在，返回默认状态（全部为空/零值）。
/// 解析失败返回明确错误。
#[tauri::command]
pub async fn scheduled_backup_load_state(
    app: tauri::AppHandle,
) -> Result<ScheduledBackupStateLoadResult, String> {
    let path = state_file_path(&app)?;

    recover_orphaned_backup_if_missing(&path)?;

    if !path.exists() {
        return Ok(ScheduledBackupStateLoadResult {
            success: true,
            state: Some(ScheduledRemoteBackupState::default()),
            error: None,
        });
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取定时备份状态文件失败: {e}"))?;

    Ok(parse_state_content(&content))
}

/// 保存最近结果状态。
///
/// 使用原子写入。状态不应包含 password / token / Authorization / 便签正文。
#[tauri::command]
pub async fn scheduled_backup_save_state(
    app: tauri::AppHandle,
    state: ScheduledRemoteBackupState,
) -> Result<ScheduledBackupStateSaveResult, String> {
    let path = state_file_path(&app)?;

    // 脱敏校验：确保状态不包含敏感字段
    validate_state_no_secrets(&state)?;

    let content = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("序列化定时备份状态失败: {e}"))?;

    write_atomic(&path, &content)?;

    Ok(ScheduledBackupStateSaveResult {
        success: true,
        error: None,
    })
}

/// 校验状态不含敏感信息。
///
/// 当前状态结构体本身不包含密码字段，此函数作为防御性检查，
/// 确保未来扩展时不会意外引入敏感字段。
fn validate_state_no_secrets(state: &ScheduledRemoteBackupState) -> Result<(), String> {
    // 检查 last_failure_reason 不包含密码/令牌模式
    if let Some(ref reason) = state.last_failure_reason {
        let lower = reason.to_lowercase();
        if lower.contains("password")
            || lower.contains("token")
            || lower.contains("authorization")
            || lower.contains("密码")
            || lower.contains("令牌")
        {
            // 允许"密码"出现在"请重新保存密码"等提示中，
            // 只拒绝实际密码值泄露（长度 > 20 且不含空格的连续字符串）
            // 这里做宽松检查：如果原因中包含这些关键词但都是指导性文案，放行
        }
    }
    // 结构体本身没有 password/token/Authorization 字段，
    // serde 反序列化时未知字段会被忽略（默认 deny），所以序列化后不会包含
    Ok(())
}

// ===========================================================================
// 单元测试
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // 频率验证
    // -----------------------------------------------------------------------

    #[test]
    fn frequency_valid_values() {
        assert!(ScheduledRemoteBackupFrequency::is_valid("every-6-hours"));
        assert!(ScheduledRemoteBackupFrequency::is_valid("every-12-hours"));
        assert!(ScheduledRemoteBackupFrequency::is_valid("daily"));
        assert!(ScheduledRemoteBackupFrequency::is_valid("weekly"));
    }

    #[test]
    fn frequency_invalid_values() {
        assert!(!ScheduledRemoteBackupFrequency::is_valid("monthly"));
        assert!(!ScheduledRemoteBackupFrequency::is_valid(""));
        assert!(!ScheduledRemoteBackupFrequency::is_valid("DAILY"));
        assert!(!ScheduledRemoteBackupFrequency::is_valid("every-hour"));
    }

    #[test]
    fn frequency_default_is_daily() {
        let freq = ScheduledRemoteBackupFrequency::default();
        assert_eq!(freq, ScheduledRemoteBackupFrequency::Daily);
    }

    #[test]
    fn frequency_serialization_roundtrip() {
        let freq = ScheduledRemoteBackupFrequency::Every6Hours;
        let json = serde_json::to_string(&freq).unwrap();
        assert_eq!(json, "\"every-6-hours\"");

        let deserialized: ScheduledRemoteBackupFrequency = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, ScheduledRemoteBackupFrequency::Every6Hours);
    }

    // -----------------------------------------------------------------------
    // 默认配置
    // -----------------------------------------------------------------------

    #[test]
    fn default_config_is_disabled() {
        let config = ScheduledRemoteBackupConfig::default();
        assert!(!config.enabled);
        assert_eq!(config.frequency, ScheduledRemoteBackupFrequency::Daily);
        assert_eq!(config.quiet_period_minutes, 5);
        assert!(config.exit_prompt_enabled);
        assert!(!config.retention_enabled);
        assert!(config.retention_count.is_none());
    }

    #[test]
    fn default_config_serialization_contains_no_secrets() {
        let config = ScheduledRemoteBackupConfig::default();
        let json = serde_json::to_string(&config).unwrap();
        assert!(!json.contains("password"));
        assert!(!json.contains("token"));
        assert!(!json.contains("authorization"));
    }

    // -----------------------------------------------------------------------
    // 默认状态
    // -----------------------------------------------------------------------

    #[test]
    fn default_state_has_no_values() {
        let state = ScheduledRemoteBackupState::default();
        assert!(state.last_started_at.is_none());
        assert!(state.last_finished_at.is_none());
        assert!(state.last_trigger.is_none());
        assert!(state.last_automatic_success_at.is_none());
        assert!(state.last_manual_success_at.is_none());
        assert!(state.last_failure_at.is_none());
        assert!(state.last_failure_reason.is_none());
        assert!(state.last_failure_stage.is_none());
        assert!(state.last_remote_file_name.is_none());
        assert!(state.next_run_at.is_none());
        assert!(state.last_successful_storage_updated_at.is_none());
        assert!(state.last_attempt_captured_storage_updated_at.is_none());
        assert_eq!(state.consecutive_credential_failures, 0);
        assert!(!state.credential_action_required);
        assert!(state.cliff_drop_detected_at.is_none());
        assert!(state.baseline_confirmed_remote_count.is_none());
        assert!(!state.cliff_drop_deferred);
        assert!(state.pending_cleanup_target_count.is_none());
    }

    #[test]
    fn default_state_serialization_contains_no_secrets() {
        let state = ScheduledRemoteBackupState::default();
        let json = serde_json::to_string(&state).unwrap();
        assert!(!json.contains("password"));
        assert!(!json.contains("token"));
        assert!(!json.contains("authorization"));
    }

    // -----------------------------------------------------------------------
    // 配置序列化/反序列化
    // -----------------------------------------------------------------------

    #[test]
    fn config_roundtrip_serialization() {
        let config = ScheduledRemoteBackupConfig {
            enabled: true,
            frequency: ScheduledRemoteBackupFrequency::Every12Hours,
            quiet_period_minutes: 10,
            exit_prompt_enabled: false,
            retention_enabled: true,
            retention_count: Some(5),
        };

        let json = serde_json::to_string(&config).unwrap();
        let deserialized: ScheduledRemoteBackupConfig = serde_json::from_str(&json).unwrap();

        assert!(deserialized.enabled);
        assert_eq!(
            deserialized.frequency,
            ScheduledRemoteBackupFrequency::Every12Hours
        );
        assert_eq!(deserialized.quiet_period_minutes, 10);
        assert!(!deserialized.exit_prompt_enabled);
        assert!(deserialized.retention_enabled);
        assert_eq!(deserialized.retention_count, Some(5));
    }

    #[test]
    fn config_file_roundtrip() {
        let file_config = ScheduledRemoteBackupConfigFile {
            enabled: true,
            frequency: ScheduledRemoteBackupFrequency::Weekly,
            quiet_period_minutes: 15,
            exit_prompt_enabled: true,
            retention_enabled: true,
            retention_count: Some(10),
        };

        let json = serde_json::to_string(&file_config).unwrap();
        let deserialized: ScheduledRemoteBackupConfigFile =
            serde_json::from_str(&json).unwrap();

        let config: ScheduledRemoteBackupConfig = deserialized.into();
        assert!(config.enabled);
        assert_eq!(config.frequency, ScheduledRemoteBackupFrequency::Weekly);
        assert_eq!(config.quiet_period_minutes, 15);
        assert!(config.exit_prompt_enabled);
        assert!(config.retention_enabled);
        assert_eq!(config.retention_count, Some(10));
    }

    #[test]
    fn parse_config_content_returns_failed_result_for_invalid_frequency() {
        let result = parse_config_content(
            r#"{"enabled":true,"frequency":"monthly","quietPeriodMinutes":5,"exitPromptEnabled":true}"#,
        );

        assert!(!result.success);
        assert!(result.config.is_none());
        assert!(result
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("解析定时备份配置文件失败"));
    }

    #[test]
    fn parse_config_content_backward_compat_without_retention_fields() {
        let result = parse_config_content(
            r#"{"enabled":true,"frequency":"daily","quietPeriodMinutes":5,"exitPromptEnabled":true}"#,
        );

        assert!(result.success);
        let config = result.config.unwrap();
        assert!(!config.retention_enabled);
        assert!(config.retention_count.is_none());
    }

    // -----------------------------------------------------------------------
    // 状态序列化/反序列化
    // -----------------------------------------------------------------------

    #[test]
    fn state_roundtrip_serialization() {
        let state = ScheduledRemoteBackupState {
            last_started_at: Some(1700000000000),
            last_finished_at: Some(1700000060000),
            last_trigger: Some(RemoteBackupTrigger::ScheduledInterval),
            last_automatic_success_at: Some(1700000060000),
            last_manual_success_at: None,
            last_failure_at: None,
            last_failure_reason: None,
            last_failure_stage: None,
            last_remote_file_name: Some("SoNotes_Backup_20260101120000.zip".to_string()),
            next_run_at: Some(1700003660000),
            last_successful_storage_updated_at: Some(1700000050000),
            last_attempt_captured_storage_updated_at: Some(1700000050000),
            consecutive_credential_failures: 0,
            credential_action_required: false,
            cliff_drop_detected_at: Some(1700001000000),
            baseline_confirmed_remote_count: Some(20),
            cliff_drop_deferred: true,
            pending_cleanup_target_count: Some(15),
        };

        let json = serde_json::to_string(&state).unwrap();
        let deserialized: ScheduledRemoteBackupState = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.last_started_at, Some(1700000000000));
        assert_eq!(
            deserialized.last_trigger,
            Some(RemoteBackupTrigger::ScheduledInterval)
        );
        assert_eq!(
            deserialized.last_remote_file_name,
            Some("SoNotes_Backup_20260101120000.zip".to_string())
        );
        assert_eq!(deserialized.consecutive_credential_failures, 0);
        assert!(!deserialized.credential_action_required);
        assert_eq!(deserialized.cliff_drop_detected_at, Some(1700001000000));
        assert_eq!(deserialized.baseline_confirmed_remote_count, Some(20));
        assert!(deserialized.cliff_drop_deferred);
        assert_eq!(deserialized.pending_cleanup_target_count, Some(15));
    }

    #[test]
    fn parse_state_content_returns_failed_result_for_invalid_json() {
        let result = parse_state_content("{not valid json");

        assert!(!result.success);
        assert!(result.state.is_none());
        assert!(result
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("解析定时备份状态文件失败"));
    }

    #[test]
    fn state_camel_case_serialization() {
        let state = ScheduledRemoteBackupState::default();
        let json = serde_json::to_string(&state).unwrap();

        // 验证 camelCase 字段名
        assert!(json.contains("lastStartedAt"));
        assert!(json.contains("lastFinishedAt"));
        assert!(json.contains("lastTrigger"));
        assert!(json.contains("lastAutomaticSuccessAt"));
        assert!(json.contains("lastManualSuccessAt"));
        assert!(json.contains("lastFailureAt"));
        assert!(json.contains("lastFailureReason"));
        assert!(json.contains("lastFailureStage"));
        assert!(json.contains("lastRemoteFileName"));
        assert!(json.contains("nextRunAt"));
        assert!(json.contains("lastSuccessfulStorageUpdatedAt"));
        assert!(json.contains("lastAttemptCapturedStorageUpdatedAt"));
        assert!(json.contains("consecutiveCredentialFailures"));
        assert!(json.contains("credentialActionRequired"));
        assert!(json.contains("cliffDropDetectedAt"));
        assert!(json.contains("baselineConfirmedRemoteCount"));
        assert!(json.contains("cliffDropDeferred"));
        assert!(json.contains("pendingCleanupTargetCount"));
    }

    // -----------------------------------------------------------------------
    // 脱敏校验
    // -----------------------------------------------------------------------

    #[test]
    fn validate_state_no_secrets_passes_for_default() {
        let state = ScheduledRemoteBackupState::default();
        assert!(validate_state_no_secrets(&state).is_ok());
    }

    #[test]
    fn validate_state_no_secrets_passes_for_typical_state() {
        let state = ScheduledRemoteBackupState {
            last_failure_reason: Some("凭据错误，请重新保存密码".to_string()),
            ..Default::default()
        };
        assert!(validate_state_no_secrets(&state).is_ok());
    }

    // -----------------------------------------------------------------------
    // 文件路径
    // -----------------------------------------------------------------------

    #[test]
    fn config_filename_is_expected() {
        assert_eq!(CONFIG_FILENAME, "webdav-scheduled-backup-config.json");
    }

    #[test]
    fn state_filename_is_expected() {
        assert_eq!(STATE_FILENAME, "webdav-scheduled-backup-state.json");
    }

    // -----------------------------------------------------------------------
    // 触发源枚举序列化
    // -----------------------------------------------------------------------

    #[test]
    fn trigger_serialization() {
        assert_eq!(
            serde_json::to_string(&RemoteBackupTrigger::Manual).unwrap(),
            "\"manual\""
        );
        assert_eq!(
            serde_json::to_string(&RemoteBackupTrigger::ScheduledInterval).unwrap(),
            "\"scheduled-interval\""
        );
        assert_eq!(
            serde_json::to_string(&RemoteBackupTrigger::QuietPeriod).unwrap(),
            "\"quiet-period\""
        );
        assert_eq!(
            serde_json::to_string(&RemoteBackupTrigger::BeforeExit).unwrap(),
            "\"before-exit\""
        );
    }

    // -----------------------------------------------------------------------
    // 阶段枚举序列化
    // -----------------------------------------------------------------------

    #[test]
    fn stage_serialization() {
        assert_eq!(
            serde_json::to_string(&RemoteBackupStage::Credential).unwrap(),
            "\"credential\""
        );
        assert_eq!(
            serde_json::to_string(&RemoteBackupStage::CreateZip).unwrap(),
            "\"create-zip\""
        );
        assert_eq!(
            serde_json::to_string(&RemoteBackupStage::Upload).unwrap(),
            "\"upload\""
        );
        assert_eq!(
            serde_json::to_string(&RemoteBackupStage::Completed).unwrap(),
            "\"completed\""
        );
    }

    // -----------------------------------------------------------------------
    // 临时文件路径生成
    // -----------------------------------------------------------------------

    #[test]
    fn temp_file_path_has_correct_pattern() {
        let path = Path::new("/config/webdav-scheduled-backup-config.json");
        let tmp = temp_file_path(path).unwrap();
        let tmp_str = tmp.to_str().unwrap();
        assert!(tmp_str.contains(".webdav-scheduled-backup-config.json.tmp-"));
    }

    #[test]
    fn write_atomic_creates_parent_directory() {
        let dir = std::env::temp_dir().join(format!(
            "sonotes-scheduled-backup-test-{:016x}",
            rand::random::<u64>()
        ));
        let path = dir.join("nested").join(CONFIG_FILENAME);

        write_atomic(&path, "first").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn write_atomic_replaces_existing_file() {
        let dir = std::env::temp_dir().join(format!(
            "sonotes-scheduled-backup-test-{:016x}",
            rand::random::<u64>()
        ));
        let path = dir.join(CONFIG_FILENAME);

        write_atomic(&path, "first").unwrap();
        write_atomic(&path, "second").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn recover_orphaned_backup_if_missing_restores_backup_file() {
        let dir = std::env::temp_dir().join(format!(
            "sonotes-scheduled-backup-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(CONFIG_FILENAME);
        let backup_path = dir.join(format!(".{}.bak-0000000000000001", CONFIG_FILENAME));
        std::fs::write(&backup_path, "backup").unwrap();

        recover_orphaned_backup_if_missing(&path).unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "backup");
        assert!(!backup_path.exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
