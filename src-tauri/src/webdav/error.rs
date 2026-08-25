//! WebDAV 错误分类与消息映射（提取自 mod.rs）

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebDavOperationError {
    pub kind: WebDavErrorKind,
    pub status: Option<u16>,
    pub retryable: bool,
}

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

pub(crate) fn sanitize_webdav_error(detail: &str) -> String {
    let lower = detail.to_ascii_lowercase();
    if lower.contains("198.18") || lower.contains("fake-ip") {
        return detail.to_string();
    }
    if lower.starts_with("dns") || lower.starts_with("解析") || lower.contains("dns 解析") {
        "DNS 解析失败".to_string()
    } else if lower.contains("黑名单")
        || lower.contains("本机")
        || lower.contains("内网")
        || lower.starts_with("ip 字面量")
        || lower.contains("主机校验")
    {
        "主机校验失败：不能指向本机或内网".to_string()
    } else if lower.starts_with("重定向") || lower.contains("redirect") {
        "重定向校验失败".to_string()
    } else if lower.starts_with("reqwest")
        || lower.contains("连接")
        || lower.contains("超时")
        || lower.contains("http client")
    {
        "WebDAV 连接失败".to_string()
    } else {
        "WebDAV 操作失败".to_string()
    }
}

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