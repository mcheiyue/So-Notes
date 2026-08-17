//! WebDAV 凭据 key / store
use sha2::Digest;
#[cfg(test)]
use std::collections::HashMap;
pub(crate) const CREDENTIAL_SERVICE: &str = "SoNotes.WebDAV";

// credential_key 计算
// ---------------------------------------------------------------------------
/// 基于 server_url / username / remote_dir 计算密钥链 account 标识。
///
/// 输入格式：`v1\n{server_url}\n{username}\n{remote_dir}`
/// 输出：SHA-256 哈希的前 32 字符十六进制字符串。
/// 不包含 password，确保配置文件中不泄露凭据。
pub(crate) fn compute_credential_key(server_url: &str, username: &str, remote_dir: &str) -> String {
    let username = username.trim();
    let input = format!("v1\n{server_url}\n{username}\n{remote_dir}");
    let hash = sha2::Sha256::digest(input.as_bytes());
    let hex: String = hash.iter().map(|b| format!("{b:02x}")).collect();
    hex[..32].to_string()
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
    #[allow(dead_code)] // 平台无密钥链时预留；测试与未来接入
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
/// 生产环境使用 `SystemWebDavCredentialStore`（keyring-core + 平台 store）；
/// 测试环境使用 `MemoryWebDavCredentialStore`（内存 HashMap）。
pub trait WebDavCredentialStore: Send + Sync {
    fn save(&self, key: &WebDavCredentialKey, secret: &str) -> Result<(), WebDavCredentialError>;
    fn load(&self, key: &WebDavCredentialKey) -> Result<String, WebDavCredentialError>;
    fn delete(&self, key: &WebDavCredentialKey) -> Result<(), WebDavCredentialError>;
}
/// 内存 credential store，仅用于单元测试。
///
/// 使用 `Mutex<HashMap>` 实现 `Send + Sync`，不依赖系统密钥链。
#[cfg(test)]
pub struct MemoryWebDavCredentialStore {
    inner: std::sync::Mutex<HashMap<String, String>>,
}
#[cfg(test)]
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
#[cfg(test)]
impl Default for MemoryWebDavCredentialStore {
    fn default() -> Self {
        Self::new()
    }
}
#[cfg(test)]
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
/// 系统密钥链 credential store，通过 keyring-core + 平台 store 接入 OS 凭据管理器。
///
/// 每次操作按需创建 `keyring_core::Entry`，不缓存实例。
/// 应用启动时需 `keyring_core::set_default_store(windows_native_keyring_store::Store::…)`。
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
#[cfg(test)]
pub struct FailingDeleteCredentialStore;
#[cfg(test)]
impl FailingDeleteCredentialStore {
    pub fn new() -> Self {
        Self
    }
}
#[cfg(test)]
impl Default for FailingDeleteCredentialStore {
    fn default() -> Self {
        Self::new()
    }
}
#[cfg(test)]
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
