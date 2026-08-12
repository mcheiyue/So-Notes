//! WebDAV 远端备份：配置闭环、连接测试、远端列表、上传、下载与 token 生命周期
mod types;
mod error;
mod ssrf;
mod credential;
mod config;
mod transport;
mod ops;

pub use types::*;
pub use error::*;
pub(crate) use ssrf::*;
pub(crate) use credential::*;
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

// ponytail: tests 外置后共享原同文件 use
pub(crate) use std::net::SocketAddr;
pub(crate) use std::path::{Path, PathBuf};
pub(crate) use std::sync::{Arc, Mutex};
pub(crate) use std::time::{Duration, SystemTime};
pub(crate) use url::Url;
pub(crate) use std::io::Write;

#[cfg(test)]
mod tests;
