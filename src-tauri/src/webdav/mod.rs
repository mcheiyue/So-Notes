//! WebDAV remote backup module facade (config / transport / ops / ssrf / credential).
//!
//! 配置闭环、连接测试、远端列表、上传、下载与 download-token 生命周期。
mod types;
mod error;
mod ssrf;
mod credential;
mod config;
mod transport;
mod ops;

pub use types::*;
pub use error::*;
pub(crate) use config::*;
pub(crate) use transport::*;
pub(crate) use ops::*;

// 显式 pub 再导出 lib.rs invoke 表面
pub use config::{webdav_clear_config, webdav_load_config, webdav_save_config};
pub use ops::{
    cleanup_downloaded_backup, cleanup_webdav_temp_files, resolve_downloaded_backup,
    webdav_create_remote_backup, webdav_download_backup,
};
pub use transport::{webdav_delete_backup, webdav_list_backups, webdav_test_connection};

// tests.rs 用 `use super::*`；仅 test 目标 re-export，避免 lib 构建 unused
#[cfg(test)]
pub(crate) use ssrf::*;
#[cfg(test)]
pub(crate) use credential::*;
#[cfg(test)]
pub(crate) use std::io::Write;
#[cfg(test)]
pub(crate) use std::net::SocketAddr;
#[cfg(test)]
pub(crate) use std::path::{Path, PathBuf};
#[cfg(test)]
pub(crate) use std::sync::{Arc, Mutex};
#[cfg(test)]
pub(crate) use std::time::{Duration, SystemTime};
#[cfg(test)]
pub(crate) use url::Url;

#[cfg(test)]
mod tests;
