//! WebDAV SSRF / URL 规范化 / HTTP client 工厂
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;
use url::{Host, Url};

use super::error::sanitize_webdav_error;
use super::types::{MAX_WEBDAV_REDIRECTS, WEBDAV_USER_AGENT};
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
pub(crate) fn is_http_localhost_exception(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(ip) => ip.is_loopback(),
        Host::Ipv6(ip) => ip.is_loopback(),
    }
}
pub(crate) fn reject_internal_https_host(
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
pub(crate) fn reject_disallowed_https_ip(ip: IpAddr) -> Result<(), String> {
    if is_disallowed_webdav_ip(ip) {
        // normalize 路径保留可读文案；连接/redirect 路径经 sanitize 的调用方另有出口
        Err("WebDAV HTTPS 地址不能指向本机或内网地址".to_string())
    } else {
        Ok(())
    }
}
pub(crate) fn is_disallowed_webdav_ip(ip: IpAddr) -> bool {
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
pub(crate) fn is_unspecified_net(ip: Ipv4Addr) -> bool {
    ip.octets()[0] == 0 // 0.0.0.0/8（不仅 0.0.0.0）
}
pub(crate) fn is_cgnat(ip: Ipv4Addr) -> bool {
    ip.octets()[0] == 100 && (ip.octets()[1] >= 64 && ip.octets()[1] <= 127)
}
pub(crate) fn is_test_net(ip: Ipv4Addr) -> bool {
    matches!(
        ip.octets(),
        [192, 0, 2, _] | [198, 51, 100, _] | [203, 0, 113, _]
    )
}
pub(crate) fn is_reserved_240(ip: Ipv4Addr) -> bool {
    ip.octets()[0] >= 240
}
pub(crate) fn is_benchmark(ip: Ipv4Addr) -> bool {
    ip.octets()[0] == 198 && (ip.octets()[1] >= 18 && ip.octets()[1] <= 19) // 198.18.0.0/15
}
/// 192.0.0.0/24（RFC 6890 IETF Protocol Assignments / Shared Address Space）
/// 该段用于 DS-Lite 等运营商内部，非用户可达公网
pub(crate) fn is_ietf_shared(ip: Ipv4Addr) -> bool {
    ip.octets()[0] == 192 && ip.octets()[1] == 0 && ip.octets()[2] == 0
}
pub(crate) fn is_documentation_ipv6(ip: Ipv6Addr) -> bool {
    // 2001:db8::/32 (RFC 3849)
    (ip.segments()[0] == 0x2001 && ip.segments()[1] == 0x0db8)
    // 3fff::/20 (RFC 9637) — 首段 = 0x3fff，第二段高 4 位 = 0
        || (ip.segments()[0] == 0x3fff && (ip.segments()[1] & 0xf000) == 0)
}
/// fec0::/10（已废弃的 site-local，RFC 3849）
/// fec0::/10 = fec0:: to febf::... — 前 10 位 = 1111111011
pub(crate) fn is_deprecated_site_local(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfec0
}
/// 64:ff9b:1::/48（RFC 6052 NAT64 非 WKP，local-use）
/// 与 WKP 64:ff9b::/96 区分：此段允许本地部署的 NAT64 前缀
pub(crate) fn is_nat64_non_wkp(ip: Ipv6Addr) -> bool {
    ip.segments()[0] == 0x0064
        && ip.segments()[1] == 0xff9b
        && ip.segments()[2] == 0x0001
    // segments[3..] 可以是任意值（/48 前缀后）
}
/// 100::/64（RFC 6666 Discard-Only Address Block）
pub(crate) fn is_discard_only_ipv6(ip: Ipv6Addr) -> bool {
    ip.segments()[0] == 0x0100
        && ip.segments()[1] == 0
        && ip.segments()[2] == 0
        && ip.segments()[3] == 0
        && ip.segments()[4] == 0
        && ip.segments()[5] == 0
    // segments[6..7] 可以是任意值（/64 前缀后）
}
/// 2001:2::/48（RFC 5180 Benchmarking）
pub(crate) fn is_benchmarking_ipv6(ip: Ipv6Addr) -> bool {
    ip.segments()[0] == 0x2001 && ip.segments()[1] == 0x0002
    // segments[2..] 可以是任意值（/48 前缀后）
}
/// Teredo 隧道 2001:0::/32（RFC 4380）
/// Teredo 地段嵌入客户端 IPv4，易被用于 SSRF 绕过
pub(crate) fn is_teredo(ip: Ipv6Addr) -> bool {
    ip.segments()[0] == 0x2001 && ip.segments()[1] == 0
}
/// 6to4 (2002::/16) 嵌入 IPv4 提取
pub(crate) fn extract_6to4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    if ip.segments()[0] == 0x2002 {
        let v4_bits = ((ip.segments()[1] as u32) << 16) | (ip.segments()[2] as u32);
        Some(Ipv4Addr::from(v4_bits))
    } else {
        None
    }
}
/// NAT64 WKP (64:ff9b::/96) 嵌入 IPv4 提取
pub(crate) fn extract_nat64(ip: Ipv6Addr) -> Option<Ipv4Addr> {
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
pub(crate) fn canonical_host(host: Host<&str>) -> String {
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
pub(crate) fn canonical_host_from_str(host: &str) -> String {
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
pub(crate) fn validate_webdav_redirect_url(
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
pub(crate) fn webdav_redirect_policy(
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
pub(crate) fn authority_from_base_url(base_url: &str) -> Result<(String, u16), String> {
    let parsed = Url::parse(base_url).map_err(|_| sanitize_webdav_error("WebDAV 地址格式无效"))?;
    let host = parsed
        .host()
        .ok_or_else(|| sanitize_webdav_error("WebDAV 地址缺少主机名"))?;
    let host_str = canonical_host(host);
    let port = parsed.port_or_known_default().unwrap_or(443);
    Ok((host_str, port))
}
/// 字面量 loopback host（normalize 已保证 https loopback 不会到达连接路径）。
pub(crate) fn is_literal_loopback_host(host: &str) -> bool {
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
pub(crate) fn resolve_and_pin(
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
pub(crate) fn build_webdav_http_client(
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
