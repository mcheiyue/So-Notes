//! WebDAV 远端备份基础类型、URL/目录规范化与配置持久化
//!
//! 本模块提供 WebDAV 远端备份的配置闭环、连接测试、远端列表、上传、下载与
//! 下载 token 生命周期管理。
mod types;
mod error;

use crate::backup;
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};
use tauri::Manager;
use url::{Host, Url};

pub use types::*;
pub use error::*;
// 单次执行锁（single-flight guard）
// ---------------------------------------------------------------------------
/// 全局互斥锁，确保同一时间只有一个任务进入 create-zip + upload 流程。
///
/// 锁的持有范围覆盖 `create_local_backup`（含 blocking 线程内的 zip 创建）
/// 和 `webdav_upload_backup_with_client`（含 409/412 重试循环）。
/// 使用 `tokio::sync::Mutex` 因为调用方是 async 上下文。
fn webdav_create_backup_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

// 序列化类型（前端消费，camelCase）
// ---------------------------------------------------------------------------













// credential_key 计算
// ---------------------------------------------------------------------------
/// 基于 server_url / username / remote_dir 计算密钥链 account 标识。
///
/// 输入格式：`v1\n{server_url}\n{username}\n{remote_dir}`
/// 输出：SHA-256 哈希的前 32 字符十六进制字符串。
/// 不包含 password，确保配置文件中不泄露凭据。
fn compute_credential_key(server_url: &str, username: &str, remote_dir: &str) -> String {
    let username = username.trim();
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
/// 脱敏对外错误：内部 detail 不进前端，返回笼统文案。
/// ponytail: 无直接 tracing 依赖；detail 仅用于分支，不拼进对外 String。

/// DNS 解析抽象，默认走系统 to_socket_addrs。
pub(crate) trait HostResolver: Send + Sync {
    fn resolve(&self, host: &str, port: u16) -> Result<Vec<SocketAddr>, String>;
}
pub(crate) struct SystemResolver;
impl HostResolver for SystemResolver {
    fn resolve(&self, host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
        (host, port)
            .to_socket_addrs()
            .map(|iter| iter.collect())
            .map_err(|e| format!("DNS 解析失败: {e}"))
    }
}
/// 测试用 MockResolver：按调用顺序消费 responses；耗尽返回 Err（禁止复用末条）。
#[cfg(test)]
pub(crate) struct MockResolver {
    pub responses: Vec<Result<Vec<SocketAddr>, String>>,
    pub call_count: std::sync::atomic::AtomicUsize,
}
#[cfg(test)]
impl HostResolver for MockResolver {
    fn resolve(&self, _host: &str, _port: u16) -> Result<Vec<SocketAddr>, String> {
        let idx = self
            .call_count
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        match self.responses.get(idx) {
            Some(r) => r.clone(),
            None => Err("MockResolver: 响应队列已耗尽".into()),
        }
    }
}
/// 单次 resolve + S2 校验。IP 字面量跳过 DNS；trust 时 DNS fail 仅重试一次。
pub(crate) fn resolve_and_check(
    host: &str,
    port: u16,
    resolver: &dyn HostResolver,
    trust_host: bool,
) -> Result<Vec<SocketAddr>, String> {
    let bare = host
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(ip) = bare.parse::<IpAddr>() {
        let addr = SocketAddr::new(ip, port);
        if is_disallowed_webdav_ip(ip) {
            return Err(sanitize_webdav_error("IP 字面量命中 S2 黑名单"));
        }
        return Ok(vec![addr]);
    }
    let addrs = match resolver.resolve(host, port) {
        Ok(addrs) => addrs,
        Err(_e) if trust_host => {
            resolver.resolve(host, port).map_err(|_e2| {
                sanitize_webdav_error("DNS 解析失败（重试后仍失败）")
            })?
        }
        Err(_e) => {
            return Err(sanitize_webdav_error("DNS 解析失败"));
        }
    };
    if addrs.is_empty() {
        return Err(sanitize_webdav_error("DNS 解析失败：未返回任何地址"));
    }
    for addr in &addrs {
        if is_disallowed_webdav_ip(addr.ip()) {
            return Err(sanitize_webdav_error("主机校验失败：不能指向本机或内网"));
        }
    }
    Ok(addrs)
}
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
    // 检查 scheme。C-W1：域名路径禁止 DNS；仅字面量 IP / localhost 字面量早拒绝。
    match parsed.scheme() {
        "https" => match &host {
            Host::Domain(domain) => {
                if domain
                    .trim_end_matches('.')
                    .eq_ignore_ascii_case("localhost")
                {
                    return Err("WebDAV HTTPS 地址不能指向本机或内网地址".to_string());
                }
                // 域名：仅格式规范化，不调用 reject_internal / resolve
            }
            Host::Ipv4(ip) => reject_disallowed_https_ip(IpAddr::V4(*ip))?,
            Host::Ipv6(ip) => reject_disallowed_https_ip(IpAddr::V6(*ip))?,
        },
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
    // 构造规范化 URL：scheme + canonical host + port（如有）+ path
    // pin key / 请求 host / redirect original_host 同源（P0-3）
    let host_str = canonical_host(host);
    let mut normalized = format!("{}://{}", parsed.scheme(), host_str);
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
fn reject_internal_https_host(
    parsed: &Url,
    host: &Host<&str>,
    resolver: &dyn HostResolver,
    trust_host: bool,
) -> Result<(), String> {
    match host {
        Host::Domain(domain) => {
            if domain
                .trim_end_matches('.')
                .eq_ignore_ascii_case("localhost")
            {
                return Err(sanitize_webdav_error(
                    "主机校验失败：不能指向本机或内网",
                ));
            }
            let port = parsed.port_or_known_default().unwrap_or(443);
            resolve_and_check(domain, port, resolver, trust_host).map(|_| ())
        }
        Host::Ipv4(ip) => reject_disallowed_https_ip(IpAddr::V4(*ip)),
        Host::Ipv6(ip) => reject_disallowed_https_ip(IpAddr::V6(*ip)),
    }
}
fn reject_disallowed_https_ip(ip: IpAddr) -> Result<(), String> {
    if is_disallowed_webdav_ip(ip) {
        // normalize 路径保留可读文案；连接/redirect 路径经 sanitize 的调用方另有出口
        Err("WebDAV HTTPS 地址不能指向本机或内网地址".to_string())
    } else {
        Ok(())
    }
}
fn is_disallowed_webdav_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private() // 10/8, 172.16/12, 192.168/16
                || v4.is_link_local() // 169.254/16
                || v4.is_unspecified() // 0.0.0.0
                || is_unspecified_net(v4) // 0.0.0.0/8（不仅 0.0.0.0）
                || v4.is_multicast() // 224/4
                || v4.is_broadcast() // 255.255.255.255
                || is_cgnat(v4) // 100.64/10
                || is_test_net(v4) // 192.0.2/24, 198.51.100/24, 203.0.113/24
                || is_reserved_240(v4) // 240/4
                || is_benchmark(v4) // 198.18.0.0/15（RFC 2544）
                || is_ietf_shared(v4) // 192.0.0.0/24（RFC 6890）
        }
        IpAddr::V6(v6) => {
            // IPv4-mapped → 递归 V4
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_disallowed_webdav_ip(IpAddr::V4(v4));
            }
            // 6to4 嵌入 IPv4 → 解嵌后递归
            if let Some(v4) = extract_6to4(v6) {
                return is_disallowed_webdav_ip(IpAddr::V4(v4));
            }
            // NAT64 WKP 嵌入 IPv4 → 解嵌后递归
            if let Some(v4) = extract_nat64(v6) {
                return is_disallowed_webdav_ip(IpAddr::V4(v4));
            }
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_unique_local() // fc00::/7（使用 std 方法）
                || v6.is_unicast_link_local() // fe80::/10
                || v6.is_multicast() // ff00::/8
                || is_documentation_ipv6(v6) // 2001:db8::/32, 3fff::/20
                || is_deprecated_site_local(v6) // fec0::/10（RFC 3849 已废弃，但安全起见仍拒绝）
                || is_nat64_non_wkp(v6) // 64:ff9b:1::/48（RFC 6052 NAT64 非 WKP）
                || is_discard_only_ipv6(v6) // 100::/64（RFC 6666 Discard-Only）
                || is_benchmarking_ipv6(v6) // 2001:2::/48（RFC 5180 Benchmarking）
                || is_teredo(v6) // 2001:0::/32（RFC 4380 Teredo）
        }
    }
}
fn is_unspecified_net(ip: Ipv4Addr) -> bool {
    ip.octets()[0] == 0 // 0.0.0.0/8（不仅 0.0.0.0）
}
fn is_cgnat(ip: Ipv4Addr) -> bool {
    ip.octets()[0] == 100 && (ip.octets()[1] >= 64 && ip.octets()[1] <= 127)
}
fn is_test_net(ip: Ipv4Addr) -> bool {
    matches!(
        ip.octets(),
        [192, 0, 2, _] | [198, 51, 100, _] | [203, 0, 113, _]
    )
}
fn is_reserved_240(ip: Ipv4Addr) -> bool {
    ip.octets()[0] >= 240
}
fn is_benchmark(ip: Ipv4Addr) -> bool {
    ip.octets()[0] == 198 && (ip.octets()[1] >= 18 && ip.octets()[1] <= 19) // 198.18.0.0/15
}
/// 192.0.0.0/24（RFC 6890 IETF Protocol Assignments / Shared Address Space）
/// 该段用于 DS-Lite 等运营商内部，非用户可达公网
fn is_ietf_shared(ip: Ipv4Addr) -> bool {
    ip.octets()[0] == 192 && ip.octets()[1] == 0 && ip.octets()[2] == 0
}
fn is_documentation_ipv6(ip: Ipv6Addr) -> bool {
    // 2001:db8::/32 (RFC 3849)
    (ip.segments()[0] == 0x2001 && ip.segments()[1] == 0x0db8)
    // 3fff::/20 (RFC 9637) — 首段 = 0x3fff，第二段高 4 位 = 0
        || (ip.segments()[0] == 0x3fff && (ip.segments()[1] & 0xf000) == 0)
}
/// fec0::/10（已废弃的 site-local，RFC 3849）
/// fec0::/10 = fec0:: to febf::... — 前 10 位 = 1111111011
fn is_deprecated_site_local(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfec0
}
/// 64:ff9b:1::/48（RFC 6052 NAT64 非 WKP，local-use）
/// 与 WKP 64:ff9b::/96 区分：此段允许本地部署的 NAT64 前缀
fn is_nat64_non_wkp(ip: Ipv6Addr) -> bool {
    ip.segments()[0] == 0x0064
        && ip.segments()[1] == 0xff9b
        && ip.segments()[2] == 0x0001
    // segments[3..] 可以是任意值（/48 前缀后）
}
/// 100::/64（RFC 6666 Discard-Only Address Block）
fn is_discard_only_ipv6(ip: Ipv6Addr) -> bool {
    ip.segments()[0] == 0x0100
        && ip.segments()[1] == 0
        && ip.segments()[2] == 0
        && ip.segments()[3] == 0
        && ip.segments()[4] == 0
        && ip.segments()[5] == 0
    // segments[6..7] 可以是任意值（/64 前缀后）
}
/// 2001:2::/48（RFC 5180 Benchmarking）
fn is_benchmarking_ipv6(ip: Ipv6Addr) -> bool {
    ip.segments()[0] == 0x2001 && ip.segments()[1] == 0x0002
    // segments[2..] 可以是任意值（/48 前缀后）
}
/// Teredo 隧道 2001:0::/32（RFC 4380）
/// Teredo 地段嵌入客户端 IPv4，易被用于 SSRF 绕过
fn is_teredo(ip: Ipv6Addr) -> bool {
    ip.segments()[0] == 0x2001 && ip.segments()[1] == 0
}
/// 6to4 (2002::/16) 嵌入 IPv4 提取
fn extract_6to4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    if ip.segments()[0] == 0x2002 {
        let v4_bits = ((ip.segments()[1] as u32) << 16) | (ip.segments()[2] as u32);
        Some(Ipv4Addr::from(v4_bits))
    } else {
        None
    }
}
/// NAT64 WKP (64:ff9b::/96) 嵌入 IPv4 提取
fn extract_nat64(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    if ip.segments()[0] == 0x0064
        && ip.segments()[1] == 0xff9b
        && ip.segments()[2] == 0
        && ip.segments()[3] == 0
        && ip.segments()[4] == 0
        && ip.segments()[5] == 0
    {
        // NAT64 /96 前缀后，IPv4 占 segments[6..8]（高16位+低16位）
        let v4_bits = ((ip.segments()[6] as u32) << 16) | (ip.segments()[7] as u32);
        Some(Ipv4Addr::from(v4_bits))
    } else {
        None
    }
}
/// 规范化 host 用于 pin key / 比较：Domain 小写去 trailing-dot；IPv6 固定 `[ip]`。
fn canonical_host(host: Host<&str>) -> String {
    match host {
        Host::Domain(d) => {
            let lower = d.to_ascii_lowercase();
            lower.trim_end_matches('.').to_string()
        }
        Host::Ipv4(ip) => ip.to_string(),
        Host::Ipv6(ip) => format!("[{ip}]"),
    }
}
/// 从字符串规范化 host（pin key / original_host 唯一来源）。
fn canonical_host_from_str(host: &str) -> String {
    let trimmed = host.trim();
    let bare = trimmed
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(trimmed);
    if let Ok(ip) = bare.parse::<Ipv4Addr>() {
        return ip.to_string();
    }
    if let Ok(ip) = bare.parse::<Ipv6Addr>() {
        return format!("[{ip}]");
    }
    let lower = trimmed.to_ascii_lowercase();
    lower.trim_end_matches('.').to_string()
}
fn validate_webdav_redirect_url(
    url: &Url,
    original_host: &str,
    original_port: u16,
    resolver: &dyn HostResolver,
) -> Result<(), String> {
    if url.scheme() != "https" {
        return Err(sanitize_webdav_error("重定向目标必须使用 HTTPS"));
    }
    let host = url
        .host()
        .ok_or_else(|| sanitize_webdav_error("重定向目标缺少主机名"))?;
    // trailing-dot 一律拒绝（防止 pin key 失配回退系统 DNS）
    if let Host::Domain(d) = host {
        if d.to_ascii_lowercase().ends_with('.') {
            return Err(sanitize_webdav_error(
                "重定向目标 host 含末尾点（trailing-dot），已拒绝",
            ));
        }
    }
    // 同 host only：与 pin key 字节级全等，不做规范化
    let redirect_host_raw = url
        .host_str()
        .ok_or_else(|| sanitize_webdav_error("重定向目标缺少主机名"))?;
    if redirect_host_raw != original_host {
        return Err(sanitize_webdav_error(
            "重定向目标 host 与 pin key 不一致（字节级全等要求）",
        ));
    }
    let redirect_port = url.port_or_known_default().unwrap_or(443);
    if redirect_port != original_port {
        return Err(sanitize_webdav_error("重定向目标 port 不匹配"));
    }
    // 重定向永不 trust（C-W3）
    reject_internal_https_host(url, &host, resolver, false).map_err(|e| {
        if e.starts_with("主机校验") || e.starts_with("DNS") || e.starts_with("重定向") {
            e
        } else {
            sanitize_webdav_error(&e)
        }
    })
}
fn webdav_redirect_policy(
    original_host: String,
    original_port: u16,
    resolver: Arc<dyn HostResolver>,
) -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= MAX_WEBDAV_REDIRECTS {
            attempt.error("WebDAV redirect limit exceeded")
        } else if validate_webdav_redirect_url(
            attempt.url(),
            &original_host,
            original_port,
            resolver.as_ref(),
        )
        .is_err()
        {
            attempt.error("WebDAV redirect target rejected")
        } else {
            attempt.follow()
        }
    })
}
/// 从已规范化 base_url 提取 canonical host / port（与 pin key 同源）。
fn authority_from_base_url(base_url: &str) -> Result<(String, u16), String> {
    let parsed = Url::parse(base_url).map_err(|_| sanitize_webdav_error("WebDAV 地址格式无效"))?;
    let host = parsed
        .host()
        .ok_or_else(|| sanitize_webdav_error("WebDAV 地址缺少主机名"))?;
    let host_str = canonical_host(host);
    let port = parsed.port_or_known_default().unwrap_or(443);
    Ok((host_str, port))
}
/// 字面量 loopback host（normalize 已保证 https loopback 不会到达连接路径）。
fn is_literal_loopback_host(host: &str) -> bool {
    let bare = host
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(host);
    bare.eq_ignore_ascii_case("localhost")
        || bare
            .parse::<IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}
/// 解析 + 校验 + 准备 pin 列表（纯函数，可单测）。
/// 入口强制 canonicalize，防止 pin key 与请求 host 不一致。
/// ClientBuilder 仅在 `build_webdav_http_client` 内创建（C-W7 工厂硬门）。
fn resolve_and_pin(
    host: &str,
    port: u16,
    resolver: &dyn HostResolver,
    trust_host: bool,
) -> Result<(String, Vec<SocketAddr>), String> {
    let canonical_host = canonical_host_from_str(host);
    let addrs = resolve_and_check(&canonical_host, port, resolver, trust_host)?;
    Ok((canonical_host, addrs))
}
/// 构建 HTTP 客户端：resolve_and_check → resolve_to_addrs 一次 pin 全部（S1）。
fn build_webdav_http_client(
    host: &str,
    port: u16,
    timeout: Duration,
    resolver: Arc<dyn HostResolver>,
    trust_host: bool,
) -> Result<reqwest::Client, String> {
    // http localhost 开发例外：字面量 loopback 跳过 S2（https loopback 已在 normalize 拒绝）
    let (canonical_host, addrs_opt) = if is_literal_loopback_host(host) {
        (canonical_host_from_str(host), None)
    } else {
        let (canon, addrs) = resolve_and_pin(host, port, resolver.as_ref(), trust_host)?;
        (canon, Some(addrs))
    };
    // Client::builder 仅允许本工厂（C-W7）
    let mut builder = reqwest::Client::builder()
        .user_agent(WEBDAV_USER_AGENT)
        .timeout(timeout);
    // 一次 pin 全部已校验地址（禁止循环 resolve 覆盖）
    if let Some(ref addrs) = addrs_opt {
        builder = builder.resolve_to_addrs(&canonical_host, addrs);
    }
    // redirect：捕获 canonical host:port + resolver（同 host:port only；永不 trust）
    builder = builder.redirect(webdav_redirect_policy(
        canonical_host,
        port,
        Arc::clone(&resolver),
    ));
    builder
        .build()
        .map_err(|_e| sanitize_webdav_error("HTTP client 构建失败"))
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
fn webdav_config_backup_path(path: &Path) -> Result<PathBuf, String> {
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
fn replace_webdav_config_file(tmp_path: &Path, path: &Path) -> Result<(), String> {
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
fn replace_webdav_config_file(tmp_path: &Path, path: &Path) -> Result<(), String> {
    std::fs::rename(tmp_path, path).map_err(|e| format!("替换 WebDAV 配置文件失败: {e}"))
}
#[cfg(windows)]
fn recover_orphaned_webdav_config_backup_if_missing(path: &Path) -> Result<(), String> {
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
fn recover_orphaned_webdav_config_backup_if_missing(_path: &Path) -> Result<(), String> {
    Ok(())
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
    replace_webdav_config_file(&tmp_path, path)?;
    guard.disarm();
    Ok(())
}
fn load_existing_webdav_config_for_save(path: &Path) -> Result<Option<WebDavConfigFile>, String> {
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
fn delete_replaced_credential_after_config_write(
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
fn rollback_saved_credential_after_config_write_failure(
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
fn save_webdav_config_to_path(
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
fn save_webdav_config_to_path_with_writer(
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
fn remove_webdav_config_backup_if_exists(path: &Path) -> Result<(), String> {
    let backup_path = webdav_config_backup_path(path)?;
    if backup_path.exists() {
        std::fs::remove_file(&backup_path)
            .map_err(|e| format!("删除 WebDAV 配置备份文件失败: {e}"))?;
    }
    Ok(())
}
fn clear_webdav_config_from_path(
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
fn resolve_operation_secret_from_path(
    path: &Path,
    config: &WebDavConfig,
    store: &dyn WebDavCredentialStore,
) -> Result<String, String> {
    recover_orphaned_webdav_config_backup_if_missing(path)?;
    resolve_operation_secret_core(Some(path), config, store)
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
fn resolve_trust_host_for_load(file: &WebDavConfigFile) -> bool {
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
fn prepare_config_save(
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
fn resolve_webdav_operation_secret(
    app: &tauri::AppHandle,
    config: &WebDavConfig,
    store: &dyn WebDavCredentialStore,
) -> Result<String, String> {
    let path = config_file_path(app)?;
    resolve_operation_secret_from_path(&path, config, store)
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
// ===========================================================================
// 单元测试
// ===========================================================================
#[cfg(test)]
mod tests;
