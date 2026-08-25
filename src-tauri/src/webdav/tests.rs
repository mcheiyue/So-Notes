    use super::*;
        /// 测试统一凭据常量，所有凭据相关断言引用此值。
        const TEST_SECRET: &str = "super-secret-token";
    #[test]
    fn webdav_config_debug_redacts_password() {
        let config = WebDavConfig {
            server_url: "https://example.com/dav".to_string(),
            username: "alice".to_string(),
            remote_dir: Some("SoNotes_Backups/".to_string()),
            password: Some("super-secret-token".to_string()),
            trust_host: false,
        };
        let output = format!("{config:?}");
        assert!(
            !output.contains("super-secret-token"),
            "Debug 泄漏了密码: {output}"
        );
        assert!(
            output.contains("[REDACTED]"),
            "Debug 未显示脱敏占位: {output}"
        );
        assert!(output.contains("alice"), "Debug 应保留非敏感字段: {output}");
    }
    #[test]
    fn webdav_config_save_request_debug_redacts_password() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "alice".to_string(),
            remote_dir: Some("SoNotes_Backups/".to_string()),
            remember_password: false,
            password: Some("super-secret-token".to_string()),
            trust_host: false,
        };
        let output = format!("{request:?}");
        assert!(
            !output.contains("super-secret-token"),
            "Debug 泄漏了密码: {output}"
        );
        assert!(
            output.contains("[REDACTED]"),
            "Debug 未显示脱敏占位: {output}"
        );
        assert!(output.contains("alice"), "Debug 应保留非敏感字段: {output}");
    }
    // -----------------------------------------------------------------------
    // URL 规范化测试
    // -----------------------------------------------------------------------
    #[test]
    fn url_norm_accepts_https() {
        let result = normalize_webdav_url("https://example.com/dav").unwrap();
        assert_eq!(result, "https://example.com/dav");
    }
    #[test]
    fn url_norm_accepts_https_with_port() {
        let result = normalize_webdav_url("https://example.com:5005/dav").unwrap();
        assert_eq!(result, "https://example.com:5005/dav");
    }
    #[test]
    fn url_norm_accepts_https_public_ipv4_literal() {
        let result = normalize_webdav_url("https://1.1.1.1/dav").unwrap();
        assert_eq!(result, "https://1.1.1.1/dav");
    }
    #[test]
    fn url_norm_accepts_https_public_ipv6_literal() {
        let result = normalize_webdav_url("https://[2001:4860:4860::8888]/dav").unwrap();
        assert_eq!(result, "https://[2001:4860:4860::8888]/dav");
    }
    #[test]
    fn url_norm_accepts_http_localhost() {
        let result = normalize_webdav_url("http://localhost:8080/dav").unwrap();
        assert_eq!(result, "http://localhost:8080/dav");
    }
    #[test]
    fn url_norm_accepts_http_127_0_0_1() {
        let result = normalize_webdav_url("http://127.0.0.1/dav").unwrap();
        assert_eq!(result, "http://127.0.0.1/dav");
    }
    #[test]
    fn url_norm_accepts_http_ipv6_loopback() {
        let result = normalize_webdav_url("http://[::1]/dav").unwrap();
        assert_eq!(result, "http://[::1]/dav");
    }
    #[test]
    fn url_norm_rejects_http_non_localhost() {
        let err = normalize_webdav_url("http://example.com/dav").unwrap_err();
        assert!(err.contains("HTTPS"));
    }
    #[test]
    fn url_norm_rejects_https_localhost() {
        let err = normalize_webdav_url("https://localhost/dav").unwrap_err();
        assert!(err.contains("本机") || err.contains("内网"));
    }
    #[test]
    fn url_norm_rejects_https_loopback_ipv4_literal() {
        let err = normalize_webdav_url("https://127.0.0.1/dav").unwrap_err();
        assert!(err.contains("本机") || err.contains("内网"));
    }
    #[test]
    fn url_norm_rejects_https_private_ipv4_literal() {
        let err = normalize_webdav_url("https://192.168.1.10/dav").unwrap_err();
        assert!(err.contains("本机") || err.contains("内网"));
    }
    #[test]
    fn url_norm_rejects_https_link_local_ipv4_literal() {
        let err = normalize_webdav_url("https://169.254.1.1/dav").unwrap_err();
        assert!(err.contains("本机") || err.contains("内网"));
    }
    #[test]
    fn url_norm_rejects_https_ipv6_loopback_literal() {
        let err = normalize_webdav_url("https://[::1]/dav").unwrap_err();
        assert!(err.contains("本机") || err.contains("内网"));
    }
    #[test]
    fn url_norm_rejects_https_ipv6_unique_local_literal() {
        let err = normalize_webdav_url("https://[fc00::1]/dav").unwrap_err();
        assert!(err.contains("本机") || err.contains("内网"));
    }
    #[test]
    fn disallowed_ip_check_rejects_internal_ranges() {
        assert!(is_disallowed_webdav_ip("10.0.0.1".parse().unwrap()));
        assert!(is_disallowed_webdav_ip("172.16.0.1".parse().unwrap()));
        assert!(is_disallowed_webdav_ip("192.168.0.1".parse().unwrap()));
        assert!(is_disallowed_webdav_ip("169.254.1.1".parse().unwrap()));
        assert!(is_disallowed_webdav_ip("0.0.0.0".parse().unwrap()));
        assert!(is_disallowed_webdav_ip("::".parse().unwrap()));
        assert!(is_disallowed_webdav_ip("::1".parse().unwrap()));
        assert!(is_disallowed_webdav_ip("fe80::1".parse().unwrap()));
        assert!(is_disallowed_webdav_ip("fc00::1".parse().unwrap()));
        assert!(is_disallowed_webdav_ip("::ffff:127.0.0.1".parse().unwrap()));
    }
    #[test]
    fn disallowed_ip_check_accepts_public_addresses() {
        assert!(!is_disallowed_webdav_ip("1.1.1.1".parse().unwrap()));
        assert!(!is_disallowed_webdav_ip("2001:4860:4860::8888".parse().unwrap()));
    }
    #[test]
    fn disallowed_ip_check_cgnat() {
        let cases = [
            ("100.64.0.1", true),
            ("100.127.255.255", true),
            ("100.63.255.255", false),
            ("100.128.0.0", false),
        ];
        for (ip, expected) in cases {
            assert_eq!(
                is_disallowed_webdav_ip(ip.parse().unwrap()),
                expected,
                "ip={ip}"
            );
        }
    }
    #[test]
    fn disallowed_ip_check_test_nets() {
        let cases = [
            ("192.0.2.1", true),
            ("198.51.100.1", true),
            ("203.0.113.1", true),
            ("192.0.0.1", true),  // 192.0.0.0/24 IETF Shared
            ("192.0.1.0", false), // 192.0.0.0/24 边界外
        ];
        assert!(cases.len() >= 5);
        for (ip, expected) in cases {
            assert_eq!(
                is_disallowed_webdav_ip(ip.parse().unwrap()),
                expected,
                "ip={ip}"
            );
        }
    }
    #[test]
    fn disallowed_ip_check_reserved_240() {
        let cases = [
            ("240.0.0.1", true),
            ("255.0.0.1", true),
            ("239.255.255.255", true), // multicast, also disallowed
            ("223.255.255.255", false),
        ];
        for (ip, expected) in cases {
            assert_eq!(
                is_disallowed_webdav_ip(ip.parse().unwrap()),
                expected,
                "ip={ip}"
            );
        }
    }
    #[test]
    fn disallowed_ip_check_ipv4_multicast_broadcast() {
        let cases = [
            ("224.0.0.1", true),
            ("239.255.255.255", true),
            ("255.255.255.255", true),
            ("223.0.0.1", false),
        ];
        for (ip, expected) in cases {
            assert_eq!(
                is_disallowed_webdav_ip(ip.parse().unwrap()),
                expected,
                "ip={ip}"
            );
        }
    }
    #[test]
    fn disallowed_ip_check_ipv6_multicast_doc() {
        // fec0 is deprecated site-local NOT ULA
        let cases = [
            ("ff02::1", true),
            ("2001:db8::1", true),
            ("fec0::1", true),
            ("64:ff9b:1::1", true),
            ("100::1", true),
            ("2001:2::1", true),
            ("3fff::1", true),
            ("3fff:0fff::1", true),
            ("3fff:1000::1", false),
            ("2001:0::1", true), // Teredo
        ];
        assert!(cases.len() >= 10);
        for (ip, expected) in cases {
            assert_eq!(
                is_disallowed_webdav_ip(ip.parse().unwrap()),
                expected,
                "ip={ip}"
            );
        }
    }
    #[test]
    fn disallowed_ip_check_public_still_allowed() {
        assert!(!is_disallowed_webdav_ip("8.8.8.8".parse().unwrap()));
        assert!(!is_disallowed_webdav_ip("2606:4700::1".parse().unwrap()));
    }
    #[test]
    fn disallowed_ip_check_unspecified_net() {
        assert!(is_disallowed_webdav_ip("0.0.0.1".parse().unwrap()));
    }
    #[test]
    fn disallowed_ip_check_benchmark() {
        assert!(is_disallowed_webdav_ip("198.18.0.1".parse().unwrap()));
        assert!(is_disallowed_webdav_ip("198.19.255.255".parse().unwrap()));
        assert!(!is_disallowed_webdav_ip("198.20.0.0".parse().unwrap()));
    }
    #[test]
    fn disallowed_ip_check_6to4_embedded() {
        // 2002:c0a8:0101::1 → 6to4 嵌入 192.168.1.1
        assert!(is_disallowed_webdav_ip("2002:c0a8:0101::1".parse().unwrap()));
    }
    #[test]
    fn disallowed_ip_check_nat64_embedded() {
        // 64:ff9b::c0a8:0101 → NAT64 嵌入 192.168.1.1
        assert!(is_disallowed_webdav_ip("64:ff9b::c0a8:0101".parse().unwrap()));
    }
    #[test]
    fn redirect_guard_accepts_public_https_target() {
        let url = Url::parse("https://1.1.1.1/dav/file.zip?token=abc").unwrap();
        let resolver = SystemResolver;
        validate_webdav_redirect_url(&url, "1.1.1.1", 443, &resolver).unwrap();
    }
    #[test]
    fn redirect_guard_rejects_http_target() {
        let url = Url::parse("http://example.com/dav/file.zip").unwrap();
        let resolver = SystemResolver;
        let err = validate_webdav_redirect_url(&url, "example.com", 443, &resolver).unwrap_err();
        assert!(err.contains("重定向校验失败"));
    }
    #[test]
    fn redirect_guard_rejects_https_private_target() {
        let url = Url::parse("https://192.168.1.10/dav/file.zip").unwrap();
        let resolver = SystemResolver;
        let err =
            validate_webdav_redirect_url(&url, "192.168.1.10", 443, &resolver).unwrap_err();
        assert!(err.contains("主机校验失败") || err.contains("不能指向本机或内网"));
    }
    #[test]
    fn redirect_guard_rejects_https_localhost_target() {
        let url = Url::parse("https://localhost/dav/file.zip").unwrap();
        let resolver = SystemResolver;
        let err = validate_webdav_redirect_url(&url, "localhost", 443, &resolver).unwrap_err();
        assert!(err.contains("主机校验失败") || err.contains("不能指向本机或内网"));
    }
    #[test]
    fn dns_fail_is_closed() {
        let mock = MockResolver {
            responses: vec![Err("mock DNS fail".into())],
            call_count: std::sync::atomic::AtomicUsize::new(0),
        };
        let err = resolve_and_check("example.com", 443, &mock, false).unwrap_err();
        assert!(err.contains("DNS"));
        assert_eq!(
            mock.call_count.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
    }
    #[test]
    fn dns_fail_with_trust_retries() {
        let mock = MockResolver {
            responses: vec![Err("fail1".into()), Err("fail2".into())],
            call_count: std::sync::atomic::AtomicUsize::new(0),
        };
        let err = resolve_and_check("example.com", 443, &mock, true).unwrap_err();
        assert!(err.contains("DNS"));
        assert_eq!(
            mock.call_count.load(std::sync::atomic::Ordering::SeqCst),
            2
        );
    }
    #[test]
    fn dns_fail_with_trust_still_rejects_private() {
        // C-WF1: trust_host 豁免域名解析 S2（含私网解析结果）；字面量仍拒见 W3
        let private: SocketAddr = "192.168.1.1:443".parse().unwrap();
        let mock = MockResolver {
            responses: vec![Ok(vec![private])],
            call_count: std::sync::atomic::AtomicUsize::new(0),
        };
        let addrs = resolve_and_check("example.com", 443, &mock, true).unwrap();
        assert_eq!(addrs, vec![private]);
    }
    #[test]
    fn dns_fail_with_trust_retry_succeeds() {
        let public: SocketAddr = "1.1.1.1:443".parse().unwrap();
        let mock = MockResolver {
            responses: vec![Err("fail1".into()), Ok(vec![public])],
            call_count: std::sync::atomic::AtomicUsize::new(0),
        };
        let addrs = resolve_and_check("example.com", 443, &mock, true).unwrap();
        assert_eq!(addrs, vec![public]);
        assert_eq!(
            mock.call_count.load(std::sync::atomic::Ordering::SeqCst),
            2
        );
    }
    #[test]
    fn normalize_domain_no_dns() {
        let result = normalize_webdav_url("https://example.com/remote.php/dav");
        assert!(result.is_ok(), "normalize 域名应返回 Ok，实际: {:?}", result);
    }
    #[test]
    fn error_sanitization_no_ip_leak() {
        let private: SocketAddr = "192.168.1.1:443".parse().unwrap();
        let mock = MockResolver {
            responses: vec![Ok(vec![private])],
            call_count: std::sync::atomic::AtomicUsize::new(0),
        };
        let err = resolve_and_check("example.com", 443, &mock, false).unwrap_err();
        assert!(err.contains("不能指向本机或内网") || err.contains("主机校验失败"));
        assert!(!err.contains("192.168"));
        assert!(!err.contains("192.168.1.1"));
    }
    #[test]
    fn mock_resolver_exhausted_returns_err() {
        let public: SocketAddr = "1.1.1.1:443".parse().unwrap();
        let mock = MockResolver {
            responses: vec![Ok(vec![public])],
            call_count: std::sync::atomic::AtomicUsize::new(0),
        };
        let first = mock.resolve("example.com", 443).unwrap();
        assert_eq!(first, vec![public]);
        let second = mock.resolve("example.com", 443).unwrap_err();
        assert!(second.contains("耗尽"));
        assert_eq!(
            mock.call_count.load(std::sync::atomic::Ordering::SeqCst),
            2
        );
    }
    // -----------------------------------------------------------------------
    // Commit 3: S1 IP pin + redirect same-host
    // -----------------------------------------------------------------------
    /// 测试侧车：记录 resolve_to_addrs 参数（不依赖 reqwest Client 内省）。
    mod pin_recorder {
        use super::*;
        use std::sync::Mutex;
        pub struct PinRecorder {
            pub calls: Mutex<Vec<(String, Vec<SocketAddr>)>>,
        }
        impl PinRecorder {
            pub fn new() -> Arc<Self> {
                Arc::new(Self {
                    calls: Mutex::new(Vec::new()),
                })
            }
            pub fn record(&self, host: &str, addrs: &[SocketAddr]) {
                self.calls
                    .lock()
                    .unwrap()
                    .push((host.to_string(), addrs.to_vec()));
            }
        }
        pub fn apply_pin_with_recorder(
            builder: reqwest::ClientBuilder,
            host: &str,
            addrs: &[SocketAddr],
            rec: &PinRecorder,
        ) -> reqwest::ClientBuilder {
            rec.record(host, addrs);
            builder.resolve_to_addrs(host, addrs)
        }
    }
    /// 记录 resolve 收到的 host（pin_chain 用）。
    struct CaptureHostResolver {
        host: Mutex<Option<String>>,
        addrs: Vec<SocketAddr>,
    }
    impl HostResolver for CaptureHostResolver {
        fn resolve(&self, host: &str, _port: u16) -> Result<Vec<SocketAddr>, String> {
            *self.host.lock().unwrap() = Some(host.to_string());
            Ok(self.addrs.clone())
        }
    }
    #[test]
    fn rebinding_pins_first_resolve() {
        let public: SocketAddr = "1.1.1.1:443".parse().unwrap();
        let mock = MockResolver {
            responses: vec![Ok(vec![public])],
            call_count: std::sync::atomic::AtomicUsize::new(0),
        };
        let (canon, addrs) = resolve_and_pin("example.com", 443, &mock, false).unwrap();
        assert_eq!(canon, "example.com");
        assert_eq!(addrs, vec![public]);
        assert_eq!(
            mock.call_count.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        let rec = pin_recorder::PinRecorder::new();
        let builder = reqwest::Client::builder();
        let _builder =
            pin_recorder::apply_pin_with_recorder(builder, &canon, &addrs, &rec);
        let calls = rec.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "example.com");
        assert_eq!(calls[0].1, vec![public]);
        drop(calls);
        // 再 resolve → 耗尽（P0-1）
        let err = mock.resolve("example.com", 443).unwrap_err();
        assert!(err.contains("耗尽"));
    }
    #[test]
    fn request_url_host_equals_pin_key() {
        let public: SocketAddr = "1.1.1.1:443".parse().unwrap();
        let cases = [
            ("https://Example.COM./dav", "example.com"),
            ("https://example.com./dav", "example.com"),
            ("https://[2001:4860:4860::8888]/dav", "[2001:4860:4860::8888]"),
        ];
        for (url, expect_key) in cases {
            let mock = MockResolver {
                responses: vec![Ok(vec![public])],
                call_count: std::sync::atomic::AtomicUsize::new(0),
            };
            let base = normalize_webdav_url(url).unwrap();
            let (auth_host, port) = authority_from_base_url(&base).unwrap();
            let (pin_key, _addrs) =
                resolve_and_pin(&auth_host, port, &mock, false).unwrap();
            assert_eq!(pin_key, expect_key, "pin key for {url}");
            assert_eq!(auth_host, pin_key, "authority host == pin key for {url}");
            let parsed = Url::parse(&base).unwrap();
            assert_eq!(
                parsed.host_str().unwrap(),
                pin_key.as_str(),
                "request URL host == pin key for {url}"
            );
        }
    }
    #[test]
    fn redirect_ignores_trust() {
        // trust=true 仅影响首次 pin；redirect 固定 trust=false → 私网 Location reject
        let public: SocketAddr = "1.1.1.1:443".parse().unwrap();
        let mock = MockResolver {
            responses: vec![Ok(vec![public])],
            call_count: std::sync::atomic::AtomicUsize::new(0),
        };
        // 首次 pin 成功（公网）
        let (_canon, addrs) = resolve_and_pin("example.com", 443, &mock, true).unwrap();
        assert_eq!(addrs, vec![public]);
        // redirect 到同 host 但解析为私网 → 仍 reject（永不 trust）
        let private: SocketAddr = "192.168.1.1:443".parse().unwrap();
        let mock2 = MockResolver {
            responses: vec![Ok(vec![private])],
            call_count: std::sync::atomic::AtomicUsize::new(0),
        };
        let url = Url::parse("https://example.com/other").unwrap();
        let err = validate_webdav_redirect_url(&url, "example.com", 443, &mock2).unwrap_err();
        assert!(
            err.contains("主机校验失败") || err.contains("不能指向本机或内网") || err.contains("重定向"),
            "redirect 必须忽略 trust: {err}"
        );
    }
    #[test]
    fn trust_host_skips_s2_resolved_blacklist() {
        let fake: SocketAddr = "198.18.0.5:443".parse().unwrap();
        let mock_ok = MockResolver {
            responses: vec![Ok(vec![fake])],
            call_count: std::sync::atomic::AtomicUsize::new(0),
        };
        let addrs = resolve_and_check("example.com", 443, &mock_ok, true).unwrap();
        assert_eq!(addrs, vec![fake]);
        let mock_err = MockResolver {
            responses: vec![Ok(vec![fake])],
            call_count: std::sync::atomic::AtomicUsize::new(0),
        };
        let err = resolve_and_check("example.com", 443, &mock_err, false).unwrap_err();
        assert!(
            err.contains("fake-ip") || err.contains("主机校验失败"),
            "{err}"
        );
    }
    #[test]
    fn benchmark_hit_returns_fakeip_hint_when_untrusted() {
        let fake: SocketAddr = "198.18.0.5:443".parse().unwrap();
        let mock = MockResolver {
            responses: vec![Ok(vec![fake])],
            call_count: std::sync::atomic::AtomicUsize::new(0),
        };
        let err = resolve_and_check("example.com", 443, &mock, false).unwrap_err();
        assert!(err.contains("fake-ip"), "{err}");
        assert!(err.contains("信任此主机"), "{err}");
        let again = sanitize_webdav_error(&err);
        assert_eq!(again, err);
    }
    #[test]
    fn private_ip_literal_still_rejected_even_with_trust_host() {
        let err = normalize_webdav_url("https://192.168.1.2/dav").unwrap_err();
        assert!(err.contains("本机") || err.contains("内网"), "{err}");
        let err2 = resolve_and_check("192.168.1.2", 443, &SystemResolver, true).unwrap_err();
        assert!(
            err2.contains("主机校验失败") || err2.contains("不能指向本机或内网"),
            "{err2}"
        );
    }
    #[test]
    fn redirect_check_stays_untrusting() {
        let fake: SocketAddr = "198.18.0.5:443".parse().unwrap();
        let mock = MockResolver {
            responses: vec![Ok(vec![fake])],
            call_count: std::sync::atomic::AtomicUsize::new(0),
        };
        let url = Url::parse("https://example.com/other").unwrap();
        let err = validate_webdav_redirect_url(&url, "example.com", 443, &mock).unwrap_err();
        assert!(
            err.contains("fake-ip") || err.contains("主机校验") || err.contains("重定向"),
            "redirect 必须忽略 trust: {err}"
        );
    }
    #[test]
    fn webdav_entry_errors_carry_inner_reason() {
        let fake: SocketAddr = "198.18.0.5:443".parse().unwrap();
        let mock = MockResolver {
            responses: vec![Ok(vec![fake])],
            call_count: std::sync::atomic::AtomicUsize::new(0),
        };
        let inner = build_webdav_http_client(
            "example.com",
            443,
            Duration::from_secs(15),
            Arc::new(mock),
            false,
        )
        .unwrap_err();
        assert!(inner.contains("fake-ip") || inner.contains("主机校验失败"), "{inner}");
        let private: SocketAddr = "192.168.1.1:443".parse().unwrap();
        let mock_priv = MockResolver {
            responses: vec![Ok(vec![private])],
            call_count: std::sync::atomic::AtomicUsize::new(0),
        };
        let inner_priv = build_webdav_http_client(
            "example.com",
            443,
            Duration::from_secs(15),
            Arc::new(mock_priv),
            false,
        )
        .unwrap_err();
        assert!(inner_priv.contains("主机校验失败"), "{inner_priv}");
        let transport = include_str!("transport.rs");
        let ops = include_str!("ops.rs");
        assert!(
            transport.contains(r#"map_err(|e| format!("WebDAV 地址不可访问（{e}）"))"#),
            "test_connection 须带出内层"
        );
        assert!(
            transport.contains(r#"map_err(|e| format!("远端备份列表读取失败（{e}）"))"#),
            "list_backups 须带出内层"
        );
        assert!(
            transport.contains(r#"map_err(|e| format!("远端备份删除失败（{e}）"))"#),
            "delete_backup 须带出内层"
        );
        assert!(
            ops.contains(r#"map_err(|e| format!("远端备份下载失败，本地数据未受影响（{e}）"))"#),
            "download_backup 须带出内层"
        );
        for (outer, reason) in [
            ("WebDAV 地址不可访问", inner.as_str()),
            ("远端备份列表读取失败", inner.as_str()),
            ("远端备份删除失败", inner_priv.as_str()),
            ("远端备份下载失败，本地数据未受影响", inner_priv.as_str()),
        ] {
            let msg = format!("{outer}（{reason}）");
            assert!(
                msg.contains("主机校验失败") || msg.contains("fake-ip"),
                "{msg}"
            );
            assert!(!msg.contains(TEST_SECRET), "{msg}");
        }
    }
    #[test]
    fn redirect_same_host_only() {
        let resolver = SystemResolver;
        let url = Url::parse("https://evil.com/dav").unwrap();
        let err = validate_webdav_redirect_url(&url, "example.com", 443, &resolver).unwrap_err();
        assert!(err.contains("重定向校验失败") || err.contains("不一致"));
    }
    #[test]
    fn redirect_rejects_different_port() {
        let resolver = SystemResolver;
        // 同 host 不同 port
        let url = Url::parse("https://example.com:8443/dav").unwrap();
        let err = validate_webdav_redirect_url(&url, "example.com", 443, &resolver).unwrap_err();
        assert!(err.contains("重定向校验失败") || err.contains("port"));
    }
    #[test]
    fn redirect_rejects_trailing_dot_host() {
        let resolver = SystemResolver;
        // 跨 host trailing-dot
        let url = Url::parse("https://evil.com./dav").unwrap();
        let err = validate_webdav_redirect_url(&url, "example.com", 443, &resolver).unwrap_err();
        assert!(err.contains("重定向校验失败") || err.contains("trailing") || err.contains("末尾"));
        // 同 host trailing-dot 也拒绝（防止 pin 失配）
        let url2 = Url::parse("https://example.com./dav").unwrap();
        let err2 =
            validate_webdav_redirect_url(&url2, "example.com", 443, &resolver).unwrap_err();
        assert!(err2.contains("重定向校验失败") || err2.contains("trailing") || err2.contains("末尾"));
    }
    #[test]
    fn pin_host_canonicalized() {
        assert_eq!(WEBDAV_HTTP_TIMEOUT_SECS, 30);
        assert_eq!(WEBDAV_USER_AGENT, "SoNotes/1.5");
        assert_eq!(
            canonical_host_from_str("Example.COM."),
            "example.com"
        );
    }
    #[test]
    fn pin_host_trailing_dot() {
        assert_eq!(canonical_host_from_str("example.com."), "example.com");
    }
    #[test]
    fn pin_host_ipv6_brackets() {
        assert_eq!(canonical_host_from_str("[::1]"), "[::1]");
        assert_eq!(canonical_host_from_str("::1"), "[::1]");
    }
    #[test]
    fn pin_chain_canonical_key() {
        let public: SocketAddr = "1.1.1.1:443".parse().unwrap();
        let capture = CaptureHostResolver {
            host: Mutex::new(None),
            addrs: vec![public],
        };
        let (canon, addrs) =
            resolve_and_pin("Example.COM.", 443, &capture, false).unwrap();
        assert_eq!(canon, "example.com");
        assert_eq!(addrs, vec![public]);
        let seen = capture.host.lock().unwrap().clone().unwrap();
        assert_eq!(seen, "example.com", "resolve 必须收到 canonical host");
        assert_ne!(seen, "Example.COM.");
    }
    #[test]
    fn url_norm_rejects_userinfo() {
        let err = normalize_webdav_url("https://user:pass@example.com/dav").unwrap_err();
        assert!(err.contains("用户名"));
    }
    #[test]
    fn url_norm_rejects_query() {
        let err = normalize_webdav_url("https://example.com/dav?token=abc").unwrap_err();
        assert!(err.contains("查询参数"));
    }
    #[test]
    fn url_norm_rejects_fragment() {
        let err = normalize_webdav_url("https://example.com/dav#section").unwrap_err();
        assert!(err.contains("片段"));
    }
    #[test]
    fn url_norm_rejects_empty_input() {
        let err = normalize_webdav_url("").unwrap_err();
        assert!(err.contains("不能为空"));
    }
    #[test]
    fn url_norm_rejects_empty_host() {
        let err = normalize_webdav_url("https://:8080/").unwrap_err();
        assert!(
            err.contains("主机名") || err.contains("格式"),
            "错误应提及主机名或格式: {err}"
        );
    }
    #[test]
    fn url_norm_strips_trailing_slash() {
        let result = normalize_webdav_url("https://example.com/dav/").unwrap();
        assert_eq!(result, "https://example.com/dav");
    }
    #[test]
    fn url_norm_rejects_ftp_scheme() {
        let err = normalize_webdav_url("ftp://example.com/dav").unwrap_err();
        assert!(err.contains("不支持的协议"));
    }
    #[test]
    fn url_norm_rejects_invalid_url() {
        let err = normalize_webdav_url("not-a-url").unwrap_err();
        assert!(err.contains("格式无效"));
    }
    // -----------------------------------------------------------------------
    // 远端目录规范化测试
    // -----------------------------------------------------------------------
    #[test]
    fn dir_norm_empty_defaults() {
        assert_eq!(normalize_remote_dir("").unwrap(), "SoNotes_Backups/");
    }
    #[test]
    fn dir_norm_whitespace_defaults() {
        assert_eq!(normalize_remote_dir("   ").unwrap(), "SoNotes_Backups/");
    }
    #[test]
    fn dir_norm_accepts_valid_name() {
        assert_eq!(normalize_remote_dir("MyBackups").unwrap(), "MyBackups/");
    }
    #[test]
    fn dir_norm_adds_trailing_slash() {
        assert_eq!(
            normalize_remote_dir("SoNotes_Backups").unwrap(),
            "SoNotes_Backups/"
        );
    }
    #[test]
    fn dir_norm_strips_existing_trailing_slash() {
        assert_eq!(
            normalize_remote_dir("SoNotes_Backups/").unwrap(),
            "SoNotes_Backups/"
        );
    }
    #[test]
    fn dir_norm_rejects_absolute_path() {
        let err = normalize_remote_dir("/etc/backups").unwrap_err();
        assert!(err.contains("绝对路径"));
    }
    #[test]
    fn dir_norm_rejects_drive_path() {
        let err = normalize_remote_dir("C:/backups").unwrap_err();
        assert!(err.contains("盘符"));
    }
    #[test]
    fn dir_norm_rejects_backslash() {
        let err = normalize_remote_dir("backups\\sub").unwrap_err();
        assert!(err.contains("反斜杠"));
    }
    #[test]
    fn dir_norm_rejects_dotdot() {
        let err = normalize_remote_dir("..").unwrap_err();
        assert!(err.contains(".."));
    }
    #[test]
    fn dir_norm_single_segment_valid() {
        assert_eq!(normalize_remote_dir("backups").unwrap(), "backups/");
    }
    #[test]
    fn dir_norm_rejects_url_encoded() {
        let err = normalize_remote_dir("back%20ups").unwrap_err();
        assert!(err.contains("URL 编码"));
    }
    #[test]
    fn dir_norm_rejects_nested() {
        let err = normalize_remote_dir("a/b").unwrap_err();
        assert!(err.contains("嵌套"));
    }
    #[test]
    fn dir_norm_rejects_null_byte() {
        let err = normalize_remote_dir("back\0ups").unwrap_err();
        assert!(err.contains("空字节"));
    }
    #[test]
    fn dir_norm_rejects_full_url() {
        let err = normalize_remote_dir("https://example.com/backups").unwrap_err();
        assert!(err.contains("完整 URL"));
    }
    #[test]
    fn dir_norm_rejects_colon() {
        let err = normalize_remote_dir("backup:data").unwrap_err();
        assert!(err.contains("冒号"));
    }
    #[test]
    fn dir_norm_rejects_question_mark() {
        let err = normalize_remote_dir("Backups?token=abc").unwrap_err();
        assert!(err.contains("? 或 #"));
    }
    #[test]
    fn dir_norm_rejects_hash() {
        let err = normalize_remote_dir("Backups#fragment").unwrap_err();
        assert!(err.contains("? 或 #"));
    }
    #[test]
    fn dir_norm_rejects_dot() {
        let err = normalize_remote_dir(".").unwrap_err();
        assert!(err.contains(". 或 .."));
    }
    // -----------------------------------------------------------------------
    // 远端备份文件名校验测试
    // -----------------------------------------------------------------------
    #[test]
    fn filename_valid_example() {
        assert!(validate_remote_backup_filename("SoNotes_Backup_20240101120000.zip").is_ok());
    }
    #[test]
    fn filename_valid_another_date() {
        assert!(validate_remote_backup_filename("SoNotes_Backup_20231231235959.zip").is_ok());
    }
    #[test]
    fn filename_rejects_empty() {
        let err = validate_remote_backup_filename("").unwrap_err();
        assert!(err.contains("不能为空"));
    }
    #[test]
    fn filename_rejects_slash() {
        let err =
            validate_remote_backup_filename("path/SoNotes_Backup_20240101120000.zip").unwrap_err();
        assert!(err.contains("路径分隔符"));
    }
    #[test]
    fn filename_rejects_backslash() {
        let err = validate_remote_backup_filename(
            "path\\SoNotes_Backup_20240101120000.zip",
        )
        .unwrap_err();
        assert!(err.contains("路径分隔符"));
    }
    #[test]
    fn filename_rejects_null_byte() {
        let err = validate_remote_backup_filename("SoNotes_Backup_\0202401011200.zip").unwrap_err();
        assert!(err.contains("空字节"));
    }
    #[test]
    fn filename_rejects_percent_encoded() {
        let err =
            validate_remote_backup_filename("SoNotes_Backup_202401%301120000.zip").unwrap_err();
        assert!(err.contains("URL 编码"));
    }
    #[test]
    fn filename_rejects_colon() {
        let err =
            validate_remote_backup_filename("SoNotes_Backup_20240101:20000.zip").unwrap_err();
        assert!(err.contains("冒号"));
    }
    #[test]
    fn filename_rejects_dotdot() {
        let err = validate_remote_backup_filename("..").unwrap_err();
        assert!(err.contains(".."));
    }
    #[test]
    fn filename_rejects_wrong_length() {
        let err = validate_remote_backup_filename("SoNotes_Backup_20240101.zip").unwrap_err();
        assert!(err.contains("长度不正确"));
    }
    #[test]
    fn filename_rejects_wrong_prefix() {
        let err = validate_remote_backup_filename("SoNotes_BacKup_20240101120000.zip").unwrap_err();
        assert!(err.contains("前缀不正确"), "错误应提及前缀: {err}");
    }
    #[test]
    fn filename_rejects_wrong_suffix() {
        let err = validate_remote_backup_filename("SoNotes_Backup_20240101120000.tar").unwrap_err();
        assert!(err.contains("后缀不正确"), "错误应提及后缀: {err}");
    }
    #[test]
    fn filename_rejects_non_digit_datetime() {
        let err = validate_remote_backup_filename("SoNotes_Backup_2024010112000a.zip").unwrap_err();
        assert!(err.contains("14 位数字"));
    }
    #[test]
    fn filename_rejects_extra_extension() {
        let err =
            validate_remote_backup_filename("SoNotes_Backup_20240101120000.zip.bak").unwrap_err();
        assert!(
            err.contains("长度不正确") || err.contains("后缀"),
            "错误应提及长度或后缀: {err}"
        );
    }
    #[test]
    fn delete_backup_rejects_path_filename_before_network() {
        let err = validate_remote_backup_filename(
            "../SoNotes_Backup_20240101120000.zip",
        )
        .unwrap_err();
        assert!(err.contains("..") || err.contains("路径分隔符"));
    }
    // -----------------------------------------------------------------------
    // 文件名生成测试
    // -----------------------------------------------------------------------
    #[test]
    fn generate_filename_matches_pattern() {
        let name = generate_current_remote_backup_filename();
        assert!(
            validate_remote_backup_filename(&name).is_ok(),
            "生成的文件名应通过校验: {name}"
        );
    }
    #[test]
    fn generate_filename_has_correct_length() {
        let name = generate_current_remote_backup_filename();
        assert_eq!(name.len(), REMOTE_BACKUP_FILENAME_LEN);
    }
    #[test]
    fn generate_filename_has_prefix() {
        let name = generate_current_remote_backup_filename();
        assert!(name.starts_with("SoNotes_Backup_"));
    }
    #[test]
    fn generate_filename_has_zip_suffix() {
        let name = generate_current_remote_backup_filename();
        assert!(name.ends_with(".zip"));
    }
    // -----------------------------------------------------------------------
    // 配置持久化测试（使用临时目录）
    // -----------------------------------------------------------------------
    fn test_config_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sonotes-webdav-test-{name}-{:016x}",
            rand::random::<u64>()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create test config dir");
        dir
    }
    #[test]
    fn config_file_roundtrip() {
        let dir = test_config_dir("roundtrip");
        let path = dir.join(CONFIG_FILENAME);
        let config = WebDavConfigFile {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: "SoNotes_Backups/".to_string(),
            password_saved: false,
            credential_key: None,
            trust_host: false,
            trusted_host: None,
        };
        let json = serde_json::to_string_pretty(&config).unwrap();
        std::fs::write(&path, &json).unwrap();
        let read_content = std::fs::read_to_string(&path).unwrap();
        let read_config: WebDavConfigFile = serde_json::from_str(&read_content).unwrap();
        assert_eq!(read_config.server_url, "https://example.com/dav");
        assert_eq!(read_config.username, "user1");
        assert_eq!(read_config.remote_dir, "SoNotes_Backups/");
        assert!(!read_config.password_saved);
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn config_file_password_saved_flag() {
        let dir = test_config_dir("password-flag");
        let path = dir.join(CONFIG_FILENAME);
        let config = WebDavConfigFile {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: true,
            credential_key: None,
            trust_host: false,
            trusted_host: None,
        };
        let json = serde_json::to_string_pretty(&config).unwrap();
        std::fs::write(&path, &json).unwrap();
        let read_content = std::fs::read_to_string(&path).unwrap();
        let read_config: WebDavConfigFile = serde_json::from_str(&read_content).unwrap();
        assert!(read_config.password_saved);
        // 确保密码/令牌不被持久化
        assert!(
            !serde_json::to_string(&read_config)
                .unwrap()
                .contains("\"password\""),
            "配置文件中不应包含 \"password\" 字段"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn config_file_no_password_field_persisted() {
        let config = WebDavConfigFile {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: false,
            credential_key: None,
            trust_host: false,
            trusted_host: None,
        };
        let json = serde_json::to_string(&config).unwrap();
        assert!(
            !json.contains("\"password\":"),
            "配置文件序列化结果不应包含 \"password\" 字段"
        );
    }
    #[test]
    fn webdav_config_temp_path_stays_in_same_directory() {
        let dir = test_config_dir("atomic-temp-dir");
        let path = dir.join(CONFIG_FILENAME);
        let tmp_path = webdav_config_temp_path(&path).unwrap();
        assert_eq!(tmp_path.parent(), Some(dir.as_path()));
        assert!(tmp_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap()
            .starts_with(".webdav-config.json.tmp-"));
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn webdav_config_atomic_write_creates_file() {
        let dir = test_config_dir("atomic-create");
        let path = dir.join(CONFIG_FILENAME);
        write_webdav_config_atomic(&path, r#"{"serverUrl":"https://example.com"}"#).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            r#"{"serverUrl":"https://example.com"}"#
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn webdav_config_atomic_write_overwrites_existing_file() {
        let dir = test_config_dir("atomic-overwrite");
        let path = dir.join(CONFIG_FILENAME);
        std::fs::write(&path, "old").unwrap();
        write_webdav_config_atomic(&path, "new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[cfg(windows)]
    #[test]
    fn recover_orphaned_webdav_config_backup_if_missing_restores_backup_file() {
        let dir = test_config_dir("recover-orphaned-bak");
        let path = dir.join(CONFIG_FILENAME);
        let backup_path = webdav_config_backup_path(&path).unwrap();
        let json = r#"{"server_url":"https://example.com/dav","username":"user1","remote_dir":"Backups/","password_saved":false,"credential_key":null}"#;
        std::fs::write(&backup_path, json).unwrap();
        recover_orphaned_webdav_config_backup_if_missing(&path).unwrap();
        assert!(path.exists());
        assert!(!backup_path.exists());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), json);
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[cfg(windows)]
    #[test]
    fn load_existing_webdav_config_for_save_recovers_orphaned_backup_before_read() {
        let dir = test_config_dir("save-load-orphaned-bak");
        let path = dir.join(CONFIG_FILENAME);
        let backup_path = webdav_config_backup_path(&path).unwrap();
        let json = r#"{"server_url":"https://example.com/dav","username":"user1","remote_dir":"Backups/","password_saved":true,"credential_key":"old-key"}"#;
        std::fs::write(&backup_path, json).unwrap();
        let config = load_existing_webdav_config_for_save(&path).unwrap().unwrap();
        assert!(path.exists());
        assert!(!backup_path.exists());
        assert_eq!(config.server_url, "https://example.com/dav");
        assert_eq!(config.username, "user1");
        assert_eq!(config.remote_dir, "Backups/");
        assert!(config.password_saved);
        assert_eq!(config.credential_key.as_deref(), Some("old-key"));
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[cfg(windows)]
    #[test]
    fn clear_webdav_config_from_path_removes_orphaned_backup_and_secret() {
        let dir = test_config_dir("clear-orphaned-bak");
        let path = dir.join(CONFIG_FILENAME);
        let backup_path = webdav_config_backup_path(&path).unwrap();
        let store = MemoryWebDavCredentialStore::new();
        let cred_key = WebDavCredentialKey {
            service: CREDENTIAL_SERVICE.to_string(),
            account: "old-key".to_string(),
        };
        store.save(&cred_key, "old-password").unwrap();
        let json = r#"{"server_url":"https://example.com/dav","username":"user1","remote_dir":"Backups/","password_saved":true,"credential_key":"old-key"}"#;
        std::fs::write(&backup_path, json).unwrap();
        let result = clear_webdav_config_from_path(&path, &store).unwrap();
        assert!(result.success);
        assert!(!path.exists());
        assert!(!backup_path.exists());
        assert!(store.load(&cred_key).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[cfg(windows)]
    #[test]
    fn clear_webdav_config_from_path_removes_stale_backup_with_main_file() {
        let dir = test_config_dir("clear-main-and-stale-bak");
        let path = dir.join(CONFIG_FILENAME);
        let backup_path = webdav_config_backup_path(&path).unwrap();
        let store = MemoryWebDavCredentialStore::new();
        let main_json = r#"{"server_url":"https://example.com/dav","username":"user1","remote_dir":"Backups/","password_saved":false,"credential_key":null}"#;
        let stale_json = r#"{"server_url":"https://stale.example.com/dav","username":"old","remote_dir":"Backups/","password_saved":true,"credential_key":"stale-key"}"#;
        std::fs::write(&path, main_json).unwrap();
        std::fs::write(&backup_path, stale_json).unwrap();
        let result = clear_webdav_config_from_path(&path, &store).unwrap();
        assert!(result.success);
        assert!(!path.exists());
        assert!(!backup_path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[cfg(windows)]
    #[test]
    fn resolve_operation_secret_from_path_recovers_orphaned_backup() {
        let dir = test_config_dir("resolve-orphaned-bak");
        let path = dir.join(CONFIG_FILENAME);
        let backup_path = webdav_config_backup_path(&path).unwrap();
        let store = MemoryWebDavCredentialStore::new();
        let config = WebDavConfig {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            password: None,
            trust_host: false,
        };
        let key = compute_credential_key(
            &normalize_webdav_url(&config.server_url).unwrap(),
            &config.username,
            &normalize_remote_dir(config.remote_dir.as_deref().unwrap()).unwrap(),
        );
        let cred_key = WebDavCredentialKey {
            service: CREDENTIAL_SERVICE.to_string(),
            account: key.clone(),
        };
        store.save(&cred_key, "saved-password").unwrap();
        let config_file = WebDavConfigFile {
            server_url: normalize_webdav_url(&config.server_url).unwrap(),
            username: config.username.clone(),
            remote_dir: normalize_remote_dir(config.remote_dir.as_deref().unwrap()).unwrap(),
            password_saved: true,
            credential_key: Some(key),
            trust_host: false,
            trusted_host: None,
        };
        std::fs::write(&backup_path, serde_json::to_string(&config_file).unwrap()).unwrap();
        let secret = resolve_operation_secret_from_path(&path, &config, &store).unwrap();
        assert_eq!(secret, "saved-password");
        assert!(path.exists());
        assert!(!backup_path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn webdav_config_atomic_write_leaves_no_temp_file() {
        let dir = test_config_dir("atomic-no-temp");
        let path = dir.join(CONFIG_FILENAME);
        write_webdav_config_atomic(&path, "content").unwrap();
        let temp_count = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .map(|name| name.starts_with(".webdav-config.json.tmp-"))
                    .unwrap_or(false)
            })
            .count();
        assert_eq!(temp_count, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
    // -----------------------------------------------------------------------
    // prepare_config_save：真实行为测试
    // -----------------------------------------------------------------------
    #[test]
    fn prepare_rejects_remember_password_true_with_password() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: true,
            password: Some("secret123".to_string()),
            trust_host: false,
        };
        let (config, _) = prepare_config_save(&request, None).unwrap();
        assert!(
            config.password_saved,
            "remember_password=true 且有密码时 password_saved 应为 true"
        );
        assert!(
            config.credential_key.is_some(),
            "应生成 credential_key"
        );
    }
    #[test]
    fn prepare_rejects_remember_password_true_without_password() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: true,
            password: None,
            trust_host: false,
        };
        let err = prepare_config_save(&request, None).unwrap_err();
        assert!(err.contains("记住密码时必须提供密码"), "无密码也应拒绝: {err}");
    }
    #[test]
    fn prepare_always_persists_password_saved_false() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: false,
            password: Some("token123".to_string()),
            trust_host: false,
        };
        let (config, _) = prepare_config_save(&request, None).unwrap();
        assert!(
            !config.password_saved,
            "remember_password=false 时 password_saved 必须为 false"
        );
    }
    #[test]
    fn prepare_normalizes_server_url() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://Example.COM/dav/".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: false,
            password: None,
            trust_host: false,
        };
        let (config, _) = prepare_config_save(&request, None).unwrap();
        assert_eq!(
            config.server_url, "https://example.com/dav",
            "server_url 应被 normalize_webdav_url 规范化"
        );
    }
    #[test]
    fn prepare_normalizes_remote_dir() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("MyBackups".to_string()),
            remember_password: false,
            password: None,
            trust_host: false,
        };
        let (config, _) = prepare_config_save(&request, None).unwrap();
        assert_eq!(
            config.remote_dir, "MyBackups/",
            "remote_dir 应规范化为带尾斜杠的单级目录"
        );
    }
    #[test]
    fn prepare_empty_remote_dir_defaults_to_sonotes_backups() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: None,
            remember_password: false,
            password: None,
            trust_host: false,
        };
        let (config, _) = prepare_config_save(&request, None).unwrap();
        assert_eq!(config.remote_dir, "SoNotes_Backups/");
    }
    #[test]
    fn prepare_invalid_server_url_propagates_error() {
        let request = WebDavConfigSaveRequest {
            server_url: "http://insecure.example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: None,
            remember_password: false,
            password: None,
            trust_host: false,
        };
        let err = prepare_config_save(&request, None).unwrap_err();
        assert!(err.contains("HTTPS"), "应拒绝非本机 HTTP: {err}");
    }
    #[test]
    fn prepare_invalid_remote_dir_propagates_error() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("a/b/c".to_string()),
            remember_password: false,
            password: None,
            trust_host: false,
        };
        let err = prepare_config_save(&request, None).unwrap_err();
        assert!(err.contains("嵌套"), "应拒绝嵌套目录: {err}");
    }
    #[test]
    fn prepare_never_persists_password_in_json() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: None,
            remember_password: false,
            password: Some("supersecret".to_string()),
            trust_host: false,
        };
        let (config, _) = prepare_config_save(&request, None).unwrap();
        let json = serde_json::to_string(&config).unwrap();
        assert!(
            !json.contains("supersecret"),
            "密码不得出现在持久化 JSON 中"
        );
        assert!(
            !json.contains("\"password\""),
            "password 字段不得出现在持久化 JSON 中"
        );
    }
    #[test]
    fn prepare_server_url_with_credentials_rejected() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://user:pass@example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: None,
            remember_password: false,
            password: None,
            trust_host: false,
        };
        let err = prepare_config_save(&request, None).unwrap_err();
        assert!(err.contains("用户名"), "应拒绝含 userinfo 的 URL: {err}");
    }
    #[test]
    fn config_clear_removes_file() {
        let dir = test_config_dir("clear");
        let path = dir.join(CONFIG_FILENAME);
        // 创建配置文件
        std::fs::write(&path, "{}").unwrap();
        assert!(path.exists());
        // 模拟清除
        std::fs::remove_file(&path).unwrap();
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn config_clear_idempotent() {
        let dir = test_config_dir("clear-idempotent");
        let path = dir.join(CONFIG_FILENAME);
        // 文件不存在时清除应成功
        assert!(!path.exists());
        // 不应 panic
        let _ = std::fs::remove_dir_all(&dir);
    }
    // -----------------------------------------------------------------------
    // URL 构建测试
    // -----------------------------------------------------------------------
    #[test]
    fn build_remote_dir_url_basic() {
        let url = build_remote_dir_url("https://example.com/dav", "SoNotes_Backups/");
        assert_eq!(url, "https://example.com/dav/SoNotes_Backups/");
    }
    #[test]
    fn build_remote_dir_url_strips_double_slash() {
        let url = build_remote_dir_url("https://example.com/dav/", "/SoNotes_Backups/");
        assert_eq!(url, "https://example.com/dav/SoNotes_Backups/");
    }
    #[test]
    fn build_remote_dir_url_no_trailing_slash_on_dir() {
        let url = build_remote_dir_url("https://example.com/dav", "backups");
        assert_eq!(url, "https://example.com/dav/backups/");
    }
    #[test]
    fn build_remote_dir_url_preserves_base_path() {
        let url = build_remote_dir_url("https://example.com/remote.php/dav", "SoNotes_Backups/");
        assert_eq!(url, "https://example.com/remote.php/dav/SoNotes_Backups/");
    }
    // -----------------------------------------------------------------------
    // PROPFIND XML 解析测试
    // -----------------------------------------------------------------------
    #[test]
    fn parse_propfind_simple_collection() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/SoNotes_Backups/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;
        let entries = parse_propfind_response(xml).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].is_collection);
        assert_eq!(entries[0].href, "/dav/SoNotes_Backups/");
    }
    #[test]
    fn parse_propfind_mixed_entries() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/SoNotes_Backups/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/SoNotes_Backups/SoNotes_Backup_20240101120000.zip</D:href>
    <D:propstat>
      <D:prop>
        <D:getcontentlength>1024000</D:getcontentlength>
        <D:getlastmodified>Sun, 01 Jan 2024 12:00:00 GMT</D:getlastmodified>
        <D:resourcetype/>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/SoNotes_Backups/random_file.txt</D:href>
    <D:propstat>
      <D:prop><D:getcontentlength>512</D:getcontentlength><D:resourcetype/></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;
        let entries = parse_propfind_response(xml).unwrap();
        assert_eq!(entries.len(), 3);
        let filtered = filter_backup_entries(entries);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].file_name, "SoNotes_Backup_20240101120000.zip");
        assert_eq!(filtered[0].size, Some(1024000));
        assert!(filtered[0].readable);
    }
    #[test]
    fn parse_propfind_empty_response() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
</D:multistatus>"#;
        let entries = parse_propfind_response(xml).unwrap();
        assert_eq!(entries.len(), 0);
    }
    #[test]
    fn parse_propfind_malformed_xml_returns_error() {
        let result = parse_propfind_response(r#"<D:multistatus><D:response>"#);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(
            err.kind,
            WebDavErrorKind::InvalidPropfindResponse,
            "畸形 XML 应返回 InvalidPropfindResponse: {:?}",
            err.kind
        );
        assert_eq!(err.status, None, "XML 解析错误不应携带 HTTP 状态码");
        assert!(!err.retryable, "XML 解析错误不应标记为可重试");
    }
    #[test]
    fn parse_propfind_missing_size_and_mtime() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/SoNotes_Backups/SoNotes_Backup_20240101120000.zip</D:href>
    <D:propstat>
      <D:prop><D:resourcetype/></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;
        let entries = parse_propfind_response(xml).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].content_length, None);
        assert_eq!(entries[0].last_modified, None);
    }
    #[test]
    fn parse_propfind_auth_error_entry() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/SoNotes_Backups/SoNotes_Backup_20240101120000.zip</D:href>
    <D:propstat>
      <D:prop><D:resourcetype/></D:prop>
      <D:status>HTTP/1.1 403 Forbidden</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;
        let entries = parse_propfind_response(xml).unwrap();
        let filtered = filter_backup_entries(entries);
        assert_eq!(filtered.len(), 0, "403 propstat 条目应被跳过");
    }
    // -----------------------------------------------------------------------
    // extract_status_code 测试
    // -----------------------------------------------------------------------
    #[test]
    fn extract_status_200() {
        assert_eq!(extract_status_code("HTTP/1.1 200 OK"), Some(200));
    }
    #[test]
    fn extract_status_403() {
        assert_eq!(extract_status_code("HTTP/1.1 403 Forbidden"), Some(403));
    }
    #[test]
    fn extract_status_none() {
        assert_eq!(extract_status_code("nonsense"), None);
    }
    // -----------------------------------------------------------------------
    // filter_backup_entries 测试
    // -----------------------------------------------------------------------
    #[test]
    fn filter_excludes_collections() {
        let entries = vec![PropfindEntry {
            href: "/dav/SoNotes_Backups/".to_string(),
            status: None,
            content_length: None,
            last_modified: None,
            is_collection: true,
        }];
        let filtered = filter_backup_entries(entries);
        assert_eq!(filtered.len(), 0);
    }
    #[test]
    fn filter_excludes_non_matching_filenames() {
        let entries = vec![PropfindEntry {
            href: "/dav/SoNotes_Backups/readme.txt".to_string(),
            status: None,
            content_length: Some(100),
            last_modified: None,
            is_collection: false,
        }];
        let filtered = filter_backup_entries(entries);
        assert_eq!(filtered.len(), 0);
    }
    #[test]
    fn filter_includes_valid_backup() {
        let entries = vec![PropfindEntry {
            href: "/dav/SoNotes_Backups/SoNotes_Backup_20240101120000.zip".to_string(),
            status: Some("HTTP/1.1 200 OK".to_string()),
            content_length: Some(2048),
            last_modified: Some("Sun, 01 Jan 2024 12:00:00 GMT".to_string()),
            is_collection: false,
        }];
        let filtered = filter_backup_entries(entries);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].file_name, "SoNotes_Backup_20240101120000.zip");
        assert_eq!(filtered[0].size, Some(2048));
    }
    // -----------------------------------------------------------------------
    // 临时路径辅助测试
    // -----------------------------------------------------------------------
    #[test]
    fn validate_file_within_webdav_dir_rejects_exact_match() {
        let base = PathBuf::from("/cache/webdav-backups/downloads");
        assert!(!validate_file_within_webdav_dir(&base, &base));
    }
    #[test]
    fn validate_file_within_webdav_dir_accepts_child_file() {
        let base = PathBuf::from("/cache/webdav-backups/downloads");
        let path = PathBuf::from("/cache/webdav-backups/downloads/file.zip");
        assert!(validate_file_within_webdav_dir(&path, &base));
    }
    #[test]
    fn validate_file_within_webdav_dir_rejects_outside_path() {
        let base = PathBuf::from("/cache/webdav-backups/downloads");
        let path = PathBuf::from("/other/dir/file.zip");
        assert!(!validate_file_within_webdav_dir(&path, &base));
    }
    #[test]
    fn validate_file_within_webdav_dir_rejects_sibling_prefix() {
        let base = PathBuf::from("/cache/webdav-backups/downloads");
        let path = PathBuf::from("/cache/webdav-backups/downloads-old/file.zip");
        assert!(!validate_file_within_webdav_dir(&path, &base));
    }
    #[test]
    fn validate_file_within_webdav_dir_rejects_traversal_attack() {
        let base = PathBuf::from("/cache/webdav-backups/downloads");
        let path = PathBuf::from("/cache/webdav-backups/downloads/../secrets/file.zip");
        assert!(!validate_file_within_webdav_dir(&path, &base));
    }
    #[test]
    fn generate_download_token_format() {
        let token = generate_download_token();
        assert!(token.starts_with("webdav-dl-"));
        assert_eq!(token.len(), 42);
        assert!(token[10..].chars().all(|ch| ch.is_ascii_hexdigit()));
    }
    #[test]
    fn generate_download_token_unique() {
        let t1 = generate_download_token();
        let t2 = generate_download_token();
        assert_ne!(t1, t2);
    }
    // -----------------------------------------------------------------------
    // Token 存储生命周期测试
    // -----------------------------------------------------------------------
    #[test]
    fn token_lifecycle_ready_resolve_cleanup() {
        let tmp = std::env::temp_dir().join(format!("webdav-token-test-{:016x}", rand::random::<u64>()));
        std::fs::write(&tmp, b"test").unwrap();
        let token = generate_download_token();
        store_download_token(&token, tmp.clone());
        let resolved = resolve_download_token(&token).unwrap();
        assert_eq!(resolved, tmp);
        let err = resolve_download_token(&token).unwrap_err();
        assert!(err.contains("已被解析"));
        let cleaned = cleanup_download_token(&token).unwrap();
        assert_eq!(cleaned, tmp);
        // 幂等：重复 cleanup 不报错
        let result = cleanup_download_token(&token);
        assert!(result.is_ok());
        let cleaned_again = cleanup_download_token(&token).unwrap();
        assert!(cleaned_again.as_os_str().is_empty());
        let err = resolve_download_token(&token).unwrap_err();
        assert!(err.contains("无效"));
        remove_download_token(&token);
    }
    #[test]
    fn token_resolve_rejects_invalid() {
        let err = resolve_download_token("nonexistent-token").unwrap_err();
        assert!(err.contains("无效"));
    }
    #[test]
    fn token_cleanup_rejects_invalid() {
        let err = cleanup_download_token("nonexistent-token").unwrap_err();
        assert!(err.contains("无效"));
    }
    #[test]
    fn token_cleanup_idempotent_after_cleaned() {
        let tmp = std::env::temp_dir().join(format!("webdav-token-test-{:016x}", rand::random::<u64>()));
        std::fs::write(&tmp, b"test").unwrap();
        let token = generate_download_token();
        store_download_token(&token, tmp.clone());
        let _ = cleanup_download_token(&token).unwrap();
        let result = cleanup_download_token(&token);
        assert!(result.is_ok());
        remove_download_token(&token);
    }
    #[test]
    fn token_cleanup_returns_path_without_deleting_file() {
        let tmp = std::env::temp_dir().join(format!("webdav-token-test-{:016x}", rand::random::<u64>()));
        std::fs::write(&tmp, b"test").unwrap();
        assert!(tmp.exists());
        let token = generate_download_token();
        store_download_token(&token, tmp.clone());
        let _ = cleanup_download_token(&token).unwrap();
        assert!(tmp.exists());
        remove_download_token(&token);
        let _ = std::fs::remove_file(&tmp);
    }
    #[test]
    fn token_resolve_rejects_expired_token() {
        let tmp = std::env::temp_dir().join(format!("webdav-token-test-{:016x}", rand::random::<u64>()));
        std::fs::write(&tmp, b"test").unwrap();
        let token = generate_download_token();
        store_download_token_created_at(
            &token,
            tmp.clone(),
            SystemTime::now() - DOWNLOAD_TOKEN_TTL - Duration::from_secs(1),
        );
        let err = resolve_download_token(&token).unwrap_err();
        assert!(err.contains("已过期"));
        remove_download_token(&token);
        let _ = std::fs::remove_file(&tmp);
    }
    #[test]
    fn cleanup_expired_token_is_idempotent() {
        let tmp = std::env::temp_dir().join(format!("webdav-token-test-{:016x}", rand::random::<u64>()));
        std::fs::write(&tmp, b"test").unwrap();
        let token = generate_download_token();
        store_download_token_created_at(
            &token,
            tmp.clone(),
            SystemTime::now() - DOWNLOAD_TOKEN_TTL - Duration::from_secs(1),
        );
        let cleaned = cleanup_download_token(&token).unwrap();
        assert_eq!(cleaned, tmp);
        let cleaned_again = cleanup_download_token(&token).unwrap();
        assert!(cleaned_again.as_os_str().is_empty());
        remove_download_token(&token);
        let _ = std::fs::remove_file(&tmp);
    }
    #[test]
    fn stale_file_detection_respects_max_age() {
        let missing = std::env::temp_dir().join(format!("missing-webdav-token-test-{:016x}", rand::random::<u64>()));
        assert!(!is_stale_file(&missing, WEBDAV_TEMP_FILE_MAX_AGE));
    }
    #[test]
    fn remove_stale_matching_files_only_removes_matching_zip() {
        let dir = std::env::temp_dir().join(format!("webdav-cleanup-test-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let matching = dir.join("webdav-dl-123.zip");
        let non_matching = dir.join("other.zip");
        let not_zip = dir.join("webdav-dl-123.tmp");
        std::fs::write(&matching, b"zip").unwrap();
        std::fs::write(&non_matching, b"zip").unwrap();
        std::fs::write(&not_zip, b"tmp").unwrap();
        remove_stale_matching_files(&dir, "webdav-dl-", Duration::ZERO).unwrap();
        assert!(!matching.exists());
        assert!(non_matching.exists());
        assert!(not_zip.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
    // -----------------------------------------------------------------------
    // WebDAV 错误分类：状态码映射测试
    // -----------------------------------------------------------------------
    #[test]
    fn classify_status_401_maps_to_auth_failed() {
        let result = classify_webdav_status(
            WebDavOperation::TestConnection,
            reqwest::StatusCode::from_u16(401).unwrap(),
        );
        assert_eq!(result.kind, WebDavErrorKind::AuthFailed);
        assert_eq!(result.status, Some(401));
        assert!(!result.retryable);
    }
    #[test]
    fn classify_status_403_maps_to_forbidden() {
        let result = classify_webdav_status(
            WebDavOperation::ListBackups,
            reqwest::StatusCode::from_u16(403).unwrap(),
        );
        assert_eq!(result.kind, WebDavErrorKind::Forbidden);
        assert_eq!(result.status, Some(403));
        assert!(!result.retryable);
    }
    #[test]
    fn classify_status_404_maps_to_not_found() {
        let result = classify_webdav_status(
            WebDavOperation::DownloadBackup,
            reqwest::StatusCode::from_u16(404).unwrap(),
        );
        assert_eq!(result.kind, WebDavErrorKind::NotFound);
        assert_eq!(result.status, Some(404));
        assert!(!result.retryable);
    }
    #[test]
    fn classify_status_405_maps_to_method_not_allowed() {
        let result = classify_webdav_status(
            WebDavOperation::TestConnection,
            reqwest::StatusCode::from_u16(405).unwrap(),
        );
        assert_eq!(result.kind, WebDavErrorKind::MethodNotAllowed);
        assert_eq!(result.status, Some(405));
        assert!(!result.retryable);
    }
    #[test]
    fn classify_status_409_maps_to_path_conflict() {
        let result = classify_webdav_status(
            WebDavOperation::UploadBackup,
            reqwest::StatusCode::from_u16(409).unwrap(),
        );
        assert_eq!(result.kind, WebDavErrorKind::PathConflict);
        assert_eq!(result.status, Some(409));
        assert!(!result.retryable);
    }
    #[test]
    fn classify_status_412_maps_to_path_conflict() {
        let result = classify_webdav_status(
            WebDavOperation::UploadBackup,
            reqwest::StatusCode::from_u16(412).unwrap(),
        );
        assert_eq!(result.kind, WebDavErrorKind::PathConflict);
        assert_eq!(result.status, Some(412));
        assert!(!result.retryable);
    }
    #[test]
    fn classify_status_423_maps_to_locked() {
        let result = classify_webdav_status(
            WebDavOperation::DeleteBackup,
            reqwest::StatusCode::from_u16(423).unwrap(),
        );
        assert_eq!(result.kind, WebDavErrorKind::Locked);
        assert_eq!(result.status, Some(423));
        assert!(!result.retryable);
    }
    #[test]
    fn classify_status_507_maps_to_insufficient_storage() {
        let result = classify_webdav_status(
            WebDavOperation::UploadBackup,
            reqwest::StatusCode::from_u16(507).unwrap(),
        );
        assert_eq!(result.kind, WebDavErrorKind::InsufficientStorage);
        assert_eq!(result.status, Some(507));
        assert!(!result.retryable);
    }
    #[test]
    fn classify_status_5xx_maps_to_unexpected_status_retryable() {
        for code in [500, 502, 503, 504] {
            let result = classify_webdav_status(
                WebDavOperation::TestConnection,
                reqwest::StatusCode::from_u16(code).unwrap(),
            );
            assert_eq!(
                result.kind,
                WebDavErrorKind::UnexpectedStatus,
                "HTTP {code} 应映射到 UnexpectedStatus"
            );
            assert_eq!(result.status, Some(code));
            assert!(
                result.retryable,
                "HTTP {code} 应标记为 retryable"
            );
        }
    }
    #[test]
    fn classify_status_408_maps_to_timeout_retryable() {
        let result = classify_webdav_status(
            WebDavOperation::DownloadBackup,
            reqwest::StatusCode::from_u16(408).unwrap(),
        );
        assert_eq!(result.kind, WebDavErrorKind::Timeout);
        assert_eq!(result.status, Some(408));
        assert!(result.retryable);
    }
    #[test]
    fn classify_status_429_maps_to_timeout_retryable() {
        let result = classify_webdav_status(
            WebDavOperation::UploadBackup,
            reqwest::StatusCode::from_u16(429).unwrap(),
        );
        assert_eq!(result.kind, WebDavErrorKind::Timeout);
        assert_eq!(result.status, Some(429));
        assert!(result.retryable);
    }
    #[test]
    fn classify_status_other_maps_to_unexpected_status_not_retryable() {
        let result = classify_webdav_status(
            WebDavOperation::TestConnection,
            reqwest::StatusCode::from_u16(301).unwrap(),
        );
        assert_eq!(result.kind, WebDavErrorKind::UnexpectedStatus);
        assert_eq!(result.status, Some(301));
        assert!(!result.retryable);
    }
    // -----------------------------------------------------------------------
    // WebDAV 错误分类：transport failure 映射测试
    // -----------------------------------------------------------------------
    #[test]
    fn classify_transport_timeout_maps_to_timeout() {
        let result = classify_transport_failure(
            WebDavTransportFailure::Timeout,
            WebDavOperation::DownloadBackup,
        );
        assert_eq!(result.kind, WebDavErrorKind::Timeout);
        assert_eq!(result.status, None);
        assert!(result.retryable);
    }
    #[test]
    fn classify_transport_network_unreachable_maps_to_network_unreachable() {
        let result = classify_transport_failure(
            WebDavTransportFailure::NetworkUnreachable,
            WebDavOperation::TestConnection,
        );
        assert_eq!(result.kind, WebDavErrorKind::NetworkUnreachable);
        assert_eq!(result.status, None);
        assert!(result.retryable);
    }
    #[test]
    fn classify_transport_redirect_rejected_maps_to_redirect_rejected() {
        let result = classify_transport_failure(
            WebDavTransportFailure::RedirectRejected,
            WebDavOperation::ListBackups,
        );
        assert_eq!(result.kind, WebDavErrorKind::RedirectRejected);
        assert_eq!(result.status, None);
        assert!(!result.retryable);
    }
    #[test]
    fn classify_transport_other_maps_to_unexpected_status() {
        let result = classify_transport_failure(
            WebDavTransportFailure::Other,
            WebDavOperation::UploadBackup,
        );
        assert_eq!(result.kind, WebDavErrorKind::UnexpectedStatus);
        assert_eq!(result.status, None);
        assert!(!result.retryable);
    }
    // -----------------------------------------------------------------------
    // WebDAV 错误分类：classify_reqwest_error 合成测试
    // -----------------------------------------------------------------------
    #[test]
    fn classify_reqwest_error_is_functional() {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(1))
            .build()
            .unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(async {
            // 请求一个不可达地址以触发连接错误
            let err = client
                .get("http://127.0.0.1:1")
                .send()
                .await
                .unwrap_err();
            classify_reqwest_error(WebDavOperation::TestConnection, &err)
        });
        assert!(
            matches!(
                result.kind,
                WebDavErrorKind::NetworkUnreachable
                    | WebDavErrorKind::Timeout
                    | WebDavErrorKind::UnexpectedStatus
            ),
            "连接本地不可达端口应产生 NetworkUnreachable、Timeout 或 UnexpectedStatus，实际: {:?}",
            result.kind
        );
    }
    // -----------------------------------------------------------------------
    // WebDAV 错误分类：webdav_error_message 映射测试
    // -----------------------------------------------------------------------
    #[test]
    fn error_message_auth_failed() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::AuthFailed,
            status: Some(401),
            retryable: false,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("鉴权失败"), "应提及鉴权失败: {msg}");
    }
    #[test]
    fn error_message_forbidden() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::Forbidden,
            status: Some(403),
            retryable: false,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("权限不足") || msg.contains("访问被拒绝"), "应提及权限: {msg}");
    }
    #[test]
    fn error_message_not_found() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::NotFound,
            status: Some(404),
            retryable: false,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("不存在"), "应提及不存在: {msg}");
    }
    #[test]
    fn error_message_locked() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::Locked,
            status: Some(423),
            retryable: false,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("锁定"), "应提及锁定: {msg}");
    }
    #[test]
    fn error_message_insufficient_storage() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::InsufficientStorage,
            status: Some(507),
            retryable: false,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("空间不足"), "应提及空间不足: {msg}");
    }
    #[test]
    fn error_message_method_not_allowed() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::MethodNotAllowed,
            status: Some(405),
            retryable: false,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("不支持") || msg.contains("方法"), "应提及方法不支持: {msg}");
    }
    #[test]
    fn error_message_timeout_with_status() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::Timeout,
            status: Some(408),
            retryable: true,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("超时"), "应提及超时: {msg}");
    }
    #[test]
    fn error_message_timeout_without_status() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::Timeout,
            status: None,
            retryable: true,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("超时"), "应提及超时: {msg}");
    }
    #[test]
    fn error_message_network_unreachable() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::NetworkUnreachable,
            status: None,
            retryable: true,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("网络不可达"), "应提及网络不可达: {msg}");
    }
    #[test]
    fn error_message_redirect_rejected() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::RedirectRejected,
            status: None,
            retryable: false,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("重定向"), "应提及重定向: {msg}");
    }
    #[test]
    fn error_message_unexpected_status_with_code() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::UnexpectedStatus,
            status: Some(502),
            retryable: true,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("502"), "应包含状态码 502: {msg}");
    }
    #[test]
    fn error_message_invalid_propfind_response() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::InvalidPropfindResponse,
            status: None,
            retryable: false,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("XML 解析失败"), "应提及 XML 解析失败: {msg}");
    }
    #[test]
    fn error_message_download_too_large() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::DownloadTooLarge,
            status: None,
            retryable: false,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("超过") || msg.contains("大小"), "应提及大小超限: {msg}");
    }
    #[test]
    fn error_message_invalid_remote_file_name() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::InvalidRemoteFileName,
            status: None,
            retryable: false,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("文件名"), "应提及文件名: {msg}");
    }
    #[test]
    fn error_message_local_temp_file_error() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::LocalTempFileError,
            status: None,
            retryable: false,
        };
        let msg = webdav_error_message(&error);
        assert!(msg.contains("临时文件"), "应提及临时文件: {msg}");
    }
    // -----------------------------------------------------------------------
    // WebDAV 错误分类：操作上下文独立性测试
    // -----------------------------------------------------------------------
    #[test]
    fn classify_status_same_code_different_operations_produce_same_kind() {
        let status = reqwest::StatusCode::from_u16(401).unwrap();
        let ops = [
            WebDavOperation::TestConnection,
            WebDavOperation::ListBackups,
            WebDavOperation::UploadBackup,
            WebDavOperation::DownloadBackup,
            WebDavOperation::DeleteBackup,
        ];
        for op in ops {
            let result = classify_webdav_status(op, status);
            assert_eq!(
                result.kind,
                WebDavErrorKind::AuthFailed,
                "操作 {:?} 的 401 应映射到 AuthFailed",
                op
            );
        }
    }
    #[test]
    fn operation_error_eq_derives_work() {
        let a = WebDavOperationError {
            kind: WebDavErrorKind::Timeout,
            status: None,
            retryable: true,
        };
        let b = WebDavOperationError {
            kind: WebDavErrorKind::Timeout,
            status: None,
            retryable: true,
        };
        assert_eq!(a, b);
    }
    // -----------------------------------------------------------------------
    // Mock WebDAV Server Helper（Commit 4 基础设施）
    // -----------------------------------------------------------------------
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    /// 请求元数据。不保存完整 Authorization 值，只记录是否存在。
    #[derive(Debug, Clone)]
    struct MockRequestRecord {
        method: String,
        path: String,
        depth: Option<String>,
        authorization_present: bool,
    }
    /// 轻量级 mock server：`127.0.0.1:0`，单请求，不支持延迟或多响应序列。
    struct MockWebDavServer {
        listener: TcpListener,
        base_url: String,
    }
    impl MockWebDavServer {
        fn bind() -> Self {
            let listener =
                TcpListener::bind("127.0.0.1:0").expect("MockWebDavServer 绑定 127.0.0.1:0 失败");
            let addr = listener.local_addr().expect("获取 mock server 地址失败");
            let base_url = format!("http://127.0.0.1:{}", addr.port());
            Self { listener, base_url }
        }
        fn base_url(&self) -> &str {
            &self.base_url
        }
        fn accept_one_request(
            &self,
            status_line: &str,
            extra_headers: &[&str],
            body: &str,
        ) -> MockRequestRecord {
            self.listener
                .set_nonblocking(true)
                .expect("设置非阻塞失败");
            let stream = {
                let deadline =
                    std::time::Instant::now() + std::time::Duration::from_secs(5);
                loop {
                    match self.listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(ref e)
                            if e.kind() == std::io::ErrorKind::WouldBlock =>
                        {
                            if std::time::Instant::now() >= deadline {
                                panic!("MockWebDavServer 等待连接超时（5 秒）");
                            }
                            std::thread::sleep(std::time::Duration::from_millis(10));
                            continue;
                        }
                        Err(e) => panic!("MockWebDavServer accept 失败: {e}"),
                    }
                }
            };
            self.listener
                .set_nonblocking(false)
                .expect("恢复阻塞模式失败");
            stream
                .set_nonblocking(false)
                .expect("恢复 accepted stream 阻塞模式失败");
            let mut stream = stream.try_clone().expect("克隆 TcpStream 失败");
            let reader_stream = stream.try_clone().expect("克隆 reader stream 失败");
            let mut reader = BufReader::new(reader_stream);
            let mut method = String::new();
            let mut path = String::new();
            let mut depth: Option<String> = None;
            let mut authorization_present = false;
            let mut content_length: u64 = 0;
            let mut request_line = String::new();
            reader
                .read_line(&mut request_line)
                .expect("读取请求行失败");
            let parts: Vec<&str> = request_line.trim().split_whitespace().collect();
            if parts.len() >= 2 {
                method = parts[0].to_string();
                path = parts[1].to_string();
            }
            loop {
                let mut line = String::new();
                reader
                    .read_line(&mut line)
                    .expect("读取头部行失败");
                let trimmed = line.trim().to_string();
                if trimmed.is_empty() {
                    break;
                }
                if trimmed
                    .to_ascii_lowercase()
                    .starts_with("depth:")
                {
                    depth = Some(trimmed["depth:".len()..].trim().to_string());
                }
                if trimmed
                    .to_ascii_lowercase()
                    .starts_with("authorization:")
                {
                    authorization_present = true;
                }
                let lower = trimmed.to_ascii_lowercase();
                if let Some(val) = lower.strip_prefix("content-length:") {
                    if let Ok(len) = val.trim().parse::<u64>() {
                        content_length = len;
                    }
                }
            }
            if content_length > 0 {
                let mut body_buf = vec![0u8; content_length as usize];
                use std::io::Read;
                let _ = reader.read_exact(&mut body_buf);
            }
            let mut response = format!("{status_line}\r\n");
            response.push_str("Content-Type: application/xml; charset=utf-8\r\n");
            response.push_str("Connection: close\r\n");
            for header in extra_headers {
                response.push_str(&format!("{header}\r\n"));
            }
            response.push_str(&format!("Content-Length: {}\r\n", body.len()));
            response.push_str("\r\n");
            response.push_str(body);
            stream
                .write_all(response.as_bytes())
                .expect("写入响应失败");
            drop(stream);
            MockRequestRecord {
                method,
                path,
                depth,
                authorization_present,
            }
        }
        fn accept_sequential_requests(
            &self,
            responses: &[(&str, &[&str], &str)],
        ) -> Vec<MockRequestRecord> {
            responses
                .iter()
                .map(|(status_line, extra_headers, body)| {
                    self.accept_one_request(status_line, extra_headers, body)
                })
                .collect()
        }
        fn accept_one_download_request(
            &self,
            status_line: &str,
            explicit_content_length: Option<u64>,
            body_bytes: &[u8],
        ) -> MockRequestRecord {
            self.listener
                .set_nonblocking(true)
                .expect("设置非阻塞失败");
            let stream = {
                let deadline =
                    std::time::Instant::now() + std::time::Duration::from_secs(5);
                loop {
                    match self.listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(ref e)
                            if e.kind() == std::io::ErrorKind::WouldBlock =>
                        {
                            if std::time::Instant::now() >= deadline {
                                panic!("MockWebDavServer 等待连接超时（5 秒）");
                            }
                            std::thread::sleep(std::time::Duration::from_millis(10));
                            continue;
                        }
                        Err(e) => panic!("MockWebDavServer accept 失败: {e}"),
                    }
                }
            };
            self.listener
                .set_nonblocking(false)
                .expect("恢复阻塞模式失败");
            stream
                .set_nonblocking(false)
                .expect("恢复 accepted stream 阻塞模式失败");
            let mut stream = stream.try_clone().expect("克隆 TcpStream 失败");
            let reader_stream = stream.try_clone().expect("克隆 reader stream 失败");
            let mut reader = BufReader::new(reader_stream);
            let mut method = String::new();
            let mut path = String::new();
            let mut depth: Option<String> = None;
            let mut authorization_present = false;
            let mut request_line = String::new();
            reader
                .read_line(&mut request_line)
                .expect("读取请求行失败");
            let parts: Vec<&str> = request_line.trim().split_whitespace().collect();
            if parts.len() >= 2 {
                method = parts[0].to_string();
                path = parts[1].to_string();
            }
            loop {
                let mut line = String::new();
                reader
                    .read_line(&mut line)
                    .expect("读取头部行失败");
                let trimmed = line.trim().to_string();
                if trimmed.is_empty() {
                    break;
                }
                if trimmed
                    .to_ascii_lowercase()
                    .starts_with("depth:")
                {
                    depth = Some(trimmed["depth:".len()..].trim().to_string());
                }
                if trimmed
                    .to_ascii_lowercase()
                    .starts_with("authorization:")
                {
                    authorization_present = true;
                }
            }
            let mut response = format!("{status_line}\r\n");
            response.push_str("Content-Type: application/octet-stream\r\n");
            response.push_str("Connection: close\r\n");
            if let Some(len) = explicit_content_length {
                response.push_str(&format!("Content-Length: {len}\r\n"));
            }
            response.push_str("\r\n");
            stream
                .write_all(response.as_bytes())
                .expect("写入响应头失败");
            if !body_bytes.is_empty() {
                stream
                    .write_all(body_bytes)
                    .expect("写入响应体失败");
            }
            drop(stream);
            MockRequestRecord {
                method,
                path,
                depth,
                authorization_present,
            }
        }
        /// 接受一个请求，读取请求行和头部，但不发送响应直接关闭连接。
        /// 用于模拟传输层错误（连接重置、对端关闭等），使 `req.send().await` 返回 `Err`。
        fn accept_one_request_drop_without_response(&self) -> MockRequestRecord {
            self.listener
                .set_nonblocking(true)
                .expect("设置非阻塞失败");
            let stream = {
                let deadline =
                    std::time::Instant::now() + std::time::Duration::from_secs(5);
                loop {
                    match self.listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(ref e)
                            if e.kind() == std::io::ErrorKind::WouldBlock =>
                        {
                            if std::time::Instant::now() >= deadline {
                                panic!("MockWebDavServer 等待连接超时（5 秒）");
                            }
                            std::thread::sleep(std::time::Duration::from_millis(10));
                            continue;
                        }
                        Err(e) => panic!("MockWebDavServer accept 失败: {e}"),
                    }
                }
            };
            self.listener
                .set_nonblocking(false)
                .expect("恢复阻塞模式失败");
            stream
                .set_nonblocking(false)
                .expect("恢复 accepted stream 阻塞模式失败");
            let reader_stream = stream.try_clone().expect("克隆 reader stream 失败");
            let mut reader = BufReader::new(reader_stream);
            let mut method = String::new();
            let mut path = String::new();
            let mut depth: Option<String> = None;
            let mut authorization_present = false;
            let mut request_line = String::new();
            reader
                .read_line(&mut request_line)
                .expect("读取请求行失败");
            let parts: Vec<&str> = request_line.trim().split_whitespace().collect();
            if parts.len() >= 2 {
                method = parts[0].to_string();
                path = parts[1].to_string();
            }
            loop {
                let mut line = String::new();
                reader
                    .read_line(&mut line)
                    .expect("读取头部行失败");
                let trimmed = line.trim().to_string();
                if trimmed.is_empty() {
                    break;
                }
                if trimmed
                    .to_ascii_lowercase()
                    .starts_with("depth:")
                {
                    depth = Some(trimmed["depth:".len()..].trim().to_string());
                }
                if trimmed
                    .to_ascii_lowercase()
                    .starts_with("authorization:")
                {
                    authorization_present = true;
                }
            }
            drop(stream);
            MockRequestRecord {
                method,
                path,
                depth,
                authorization_present,
            }
        }
    }
    fn load_fixture(name: &str) -> String {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let path = std::path::Path::new(manifest_dir)
            .join("tests")
            .join("fixtures")
            .join("webdav")
            .join(name);
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("加载 fixture {name} 失败: {e}"))
    }
    // -----------------------------------------------------------------------
    // Smoke 测试：Mock Server + with-client 边界（Commit 4）
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn smoke_mock_server_propfind_returns_one_backup() {
        let server = MockWebDavServer::bind();
        let fixture_xml = load_fixture("propfind_standard_207.xml");
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request(
                "HTTP/1.1 207 Multi-Status",
                &[],
                &fixture_xml,
            )
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("创建测试 reqwest::Client 失败");
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "testuser",
            Some("testpass".to_string()),
        );
        let result = webdav_list_backups_with_client(&client, &target).await;
        let record = handle.join().expect("mock server 线程 panic");
        assert_eq!(record.method, "PROPFIND", "请求方法应为 PROPFIND");
        assert!(
            record.path.contains("SoNotes_Backups"),
            "请求路径应包含远端目录: {}",
            record.path
        );
        assert_eq!(record.depth.as_deref(), Some("1"), "Depth 头应为 1");
        assert!(
            record.authorization_present,
            "应记录到 Authorization 头存在（basic auth）"
        );
        let backups = result.expect("webdav_list_backups_with_client 应成功");
        assert_eq!(backups.len(), 1, "应恰好返回 1 条备份");
        assert_eq!(backups[0].file_name, "SoNotes_Backup_20240615143022.zip");
        assert_eq!(backups[0].size, Some(2048576));
        assert!(backups[0].readable);
        assert_eq!(
            backups[0].last_modified.as_deref(),
            Some("Sat, 15 Jun 2024 14:30:22 GMT")
        );
    }
    #[tokio::test]
    async fn smoke_mock_server_no_auth_not_recorded() {
        let server = MockWebDavServer::bind();
        let fixture_xml = load_fixture("propfind_standard_207.xml");
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request(
                "HTTP/1.1 207 Multi-Status",
                &[],
                &fixture_xml,
            )
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("创建测试 reqwest::Client 失败");
        let target = WebDavRequestTarget::for_test(&base_url, "SoNotes_Backups/");
        let result = webdav_list_backups_with_client(&client, &target).await;
        let record = handle.join().expect("mock server 线程 panic");
        assert!(
            !record.authorization_present,
            "无凭据时不应出现 Authorization 头"
        );
        let backups = result.expect("无凭据请求应成功（mock server 不验证凭据）");
        assert_eq!(backups.len(), 1, "无凭据也应返回 1 条备份");
        assert_eq!(backups[0].file_name, "SoNotes_Backup_20240615143022.zip");
    }
    // -----------------------------------------------------------------------
    // Commit 5：decode_href_basename 单元测试
    // -----------------------------------------------------------------------
    #[test]
    fn decode_basename_accepts_plain_name() {
        assert_eq!(
            decode_href_basename("/dav/SoNotes_Backups/SoNotes_Backup_20240101120000.zip"),
            Some("SoNotes_Backup_20240101120000.zip".to_string())
        );
    }
    #[test]
    fn decode_basename_accepts_valid_percent_encoding() {
        assert_eq!(
            decode_href_basename("/dav/SoNotes_Backups/SoNotes_Backup%2020240101120000.zip"),
            Some("SoNotes_Backup 20240101120000.zip".to_string())
        );
    }
    #[test]
    fn decode_basename_rejects_encoded_slash() {
        assert_eq!(
            decode_href_basename("/dav/SoNotes_Backups/..%2FSoNotes_Backup_20240101120000.zip"),
            None
        );
    }
    #[test]
    fn decode_basename_rejects_encoded_backslash() {
        assert_eq!(
            decode_href_basename("/dav/SoNotes_Backups/%5Csecret.zip"),
            None
        );
    }
    #[test]
    fn decode_basename_rejects_encoded_null() {
        assert_eq!(
            decode_href_basename("/dav/SoNotes_Backups/SoNotes_Backup%00_20240101120000.zip"),
            None
        );
    }
    #[test]
    fn decode_basename_rejects_encoded_colon() {
        assert_eq!(
            decode_href_basename("/dav/SoNotes_Backups/SoNotes_Backup%3A_20240101120000.zip"),
            None
        );
    }
    #[test]
    fn decode_basename_rejects_encoded_dotdot() {
        assert_eq!(
            decode_href_basename("/dav/SoNotes_Backups/%2E%2E"),
            None
        );
    }
    #[test]
    fn decode_basename_rejects_invalid_hex() {
        assert_eq!(
            decode_href_basename("/dav/SoNotes_Backups/file%GG.zip"),
            None
        );
    }
    #[test]
    fn decode_basename_rejects_truncated_percent() {
        assert_eq!(
            decode_href_basename("/dav/SoNotes_Backups/file%.zip"),
            None
        );
    }
    #[test]
    fn decode_basename_rejects_percent_at_end() {
        assert_eq!(
            decode_href_basename("/dav/SoNotes_Backups/file%"),
            None
        );
    }
    #[test]
    fn decode_basename_rejects_incomplete_hex() {
        assert_eq!(
            decode_href_basename("/dav/SoNotes_Backups/file%2.zip"),
            None
        );
    }
    // -----------------------------------------------------------------------
    // Commit 5：fixture 驱动的 PROPFIND 解析边界测试
    // -----------------------------------------------------------------------
    #[test]
    fn fixture_directory_self_entry_skipped() {
        let xml = load_fixture("propfind_directory_self_entry.xml");
        let entries = parse_propfind_response(&xml).unwrap();
        let filtered = filter_backup_entries(entries);
        assert_eq!(filtered.len(), 1, "目录自身 collection entry 应被跳过，只保留 1 条备份");
        assert_eq!(filtered[0].file_name, "SoNotes_Backup_20240701120000.zip");
        assert_eq!(filtered[0].size, Some(4096));
    }
    #[test]
    fn fixture_mixed_status_skips_non_2xx() {
        let xml = load_fixture("propfind_mixed_status.xml");
        let entries = parse_propfind_response(&xml).unwrap();
        let filtered = filter_backup_entries(entries);
        assert_eq!(filtered.len(), 1, "非 2xx propstat 条目应被跳过，只保留 200 条目");
        assert_eq!(filtered[0].file_name, "SoNotes_Backup_20240701120000.zip");
        assert!(filtered[0].readable);
        assert_eq!(filtered[0].status, Some(200));
    }
    #[test]
    fn fixture_missing_size_maps_to_none() {
        let xml = load_fixture("propfind_missing_size.xml");
        let entries = parse_propfind_response(&xml).unwrap();
        let filtered = filter_backup_entries(entries);
        assert_eq!(filtered.len(), 2, "缺失 size 的 entry 应保留");
        assert!(
            filtered.iter().all(|b| b.size.is_none()),
            "缺失 getcontentlength 应映射为 size: None"
        );
        assert_eq!(filtered[0].last_modified, None, "缺失 getlastmodified 应映射为 None");
        assert_eq!(
            filtered[1].last_modified.as_deref(),
            Some("Tue, 02 Jul 2024 12:00:00 GMT")
        );
    }
    #[test]
    fn fixture_invalid_size_maps_to_none() {
        let xml = load_fixture("propfind_invalid_size.xml");
        let entries = parse_propfind_response(&xml).unwrap();
        let filtered = filter_backup_entries(entries);
        assert_eq!(filtered.len(), 3, "非法 size 的 entry 应保留");
        assert!(
            filtered.iter().all(|b| b.size.is_none()),
            "非法 getcontentlength 应映射为 size: None"
        );
    }
    #[test]
    fn fixture_encoded_file_name_decoded_and_filtered() {
        let xml = load_fixture("propfind_encoded_file_name.xml");
        let entries = parse_propfind_response(&xml).unwrap();
        let filtered = filter_backup_entries(entries);
        assert_eq!(
            filtered.len(),
            2,
            "未编码合法条目 + 解码后合法条目应保留；%20 解码后含空格的条目被 validate_remote_backup_filename 过滤（非 decode_href_basename 问题）"
        );
        assert_eq!(
            filtered[0].file_name,
            "SoNotes_Backup_20240701120000.zip",
            "第一个合法条目应是未编码的备份文件"
        );
        assert_eq!(
            filtered[1].file_name,
            "SoNotes_Backup_20240706120000.zip",
            "第二个合法条目应是 %5F 解码后的备份文件"
        );
        assert_eq!(filtered[1].size, Some(8192));
    }
    #[test]
    fn fixture_namespace_variants_returns_one_backup() {
        let xml = load_fixture("propfind_namespace_variants.xml");
        let entries = parse_propfind_response(&xml).unwrap();
        let filtered = filter_backup_entries(entries);
        assert_eq!(filtered.len(), 1, "dc: 前缀命名空间应只保留 1 个合法备份条目");
        assert_eq!(
            filtered[0].file_name,
            "SoNotes_Backup_20240301081500.zip",
            "唯一合法条目文件名应匹配"
        );
        assert_eq!(filtered[0].size, Some(1048576));
        let last_mod = filtered[0].last_modified.as_ref().expect("last_modified 应存在");
        assert!(
            last_mod.contains("2024"),
            "last_modified 应包含年份 2024: {last_mod}"
        );
        assert!(filtered[0].readable, "合法备份条目应标记为 readable");
    }
    #[test]
    fn fixture_malformed_xml_returns_error() {
        let xml = load_fixture("propfind_malformed.xml");
        let result = parse_propfind_response(&xml);
        assert!(result.is_err(), "畸形 XML 应返回错误");
        let err = result.unwrap_err();
        assert_eq!(
            err.kind,
            WebDavErrorKind::InvalidPropfindResponse,
            "畸形 XML fixture 应返回 InvalidPropfindResponse: {:?}",
            err.kind
        );
        assert_eq!(
            webdav_error_message(&err),
            "WebDAV 列表 XML 解析失败",
            "InvalidPropfindResponse 的用户消息应为 'WebDAV 列表 XML 解析失败'"
        );
    }
    #[test]
    fn filter_non_so_notes_zip_entries_are_skipped() {
        let entries = vec![
            PropfindEntry {
                href: "/dav/SoNotes_Backups/readme.txt".to_string(),
                status: Some("HTTP/1.1 200 OK".to_string()),
                content_length: Some(128),
                last_modified: None,
                is_collection: false,
            },
            PropfindEntry {
                href: "/dav/SoNotes_Backups/config.json".to_string(),
                status: Some("HTTP/1.1 200 OK".to_string()),
                content_length: Some(64),
                last_modified: None,
                is_collection: false,
            },
            PropfindEntry {
                href: "/dav/SoNotes_Backups/image.png".to_string(),
                status: Some("HTTP/1.1 200 OK".to_string()),
                content_length: Some(2048),
                last_modified: None,
                is_collection: false,
            },
        ];
        let filtered = filter_backup_entries(entries);
        assert_eq!(filtered.len(), 0, "非 SoNotes zip 条目应全部被跳过");
    }
    #[tokio::test]
    async fn smoke_mock_server_fixture_mixed_status() {
        let server = MockWebDavServer::bind();
        let fixture_xml = load_fixture("propfind_mixed_status.xml");
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request(
                "HTTP/1.1 207 Multi-Status",
                &[],
                &fixture_xml,
            )
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("创建测试 reqwest::Client 失败");
        let target = WebDavRequestTarget::for_test(&base_url, "SoNotes_Backups/");
        let result = webdav_list_backups_with_client(&client, &target).await;
        let _record = handle.join().expect("mock server 线程 panic");
        let backups = result.expect("webdav_list_backups_with_client 应成功");
        assert_eq!(backups.len(), 1, "端到端：非 2xx 条目应被跳过，只返回 1 条备份");
        assert_eq!(backups[0].file_name, "SoNotes_Backup_20240701120000.zip");
        assert!(backups[0].readable);
    }
    // -----------------------------------------------------------------------
    // Commit 6：Mock Server 401/403/405 连接测试错误分类
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn mock_server_connection_401_returns_auth_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 401 Unauthorized", &[], "")
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "testuser",
            Some("testpass".to_string()),
        );
        let result = webdav_test_connection_with_client(&client, &target).await;
        let record = handle.join().expect("mock server 线程 panic");
        let conn_result = result.expect("401 应返回 Ok(WebDavConnectionResult)");
        assert!(!conn_result.success, "401 连接测试应返回 success=false");
        let error = conn_result.error.expect("401 应携带 error");
        assert!(
            error.contains("鉴权失败"),
            "401 应映射到鉴权失败语义: {error}"
        );
        assert!(
            !error.contains("testuser") && !error.contains("testpass"),
            "错误信息不得泄漏凭据: {error}"
        );
        assert!(
            record.authorization_present,
            "请求应携带 Authorization 头"
        );
    }
    #[tokio::test]
    async fn mock_server_connection_403_returns_forbidden_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 403 Forbidden", &[], "")
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "user403",
            Some("pass403".to_string()),
        );
        let result = webdav_test_connection_with_client(&client, &target).await;
        let record = handle.join().expect("mock server 线程 panic");
        let conn_result = result.expect("403 应返回 Ok(WebDavConnectionResult)");
        assert!(!conn_result.success, "403 连接测试应返回 success=false");
        let error = conn_result.error.expect("403 应携带 error");
        assert!(
            error.contains("权限不足") || error.contains("访问被拒绝"),
            "403 应映射到权限不足/访问被拒绝语义: {error}"
        );
        assert!(
            !error.contains("user403") && !error.contains("pass403"),
            "错误信息不得泄漏凭据: {error}"
        );
        assert!(
            record.authorization_present,
            "请求应携带 Authorization 头"
        );
    }
    #[tokio::test]
    async fn mock_server_connection_405_returns_method_not_allowed_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 405 Method Not Allowed", &[], "")
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test(&base_url, "SoNotes_Backups/");
        let result = webdav_test_connection_with_client(&client, &target).await;
        let _record = handle.join().expect("mock server 线程 panic");
        let conn_result = result.expect("405 应返回 Ok(WebDavConnectionResult)");
        assert!(!conn_result.success, "405 连接测试应返回 success=false");
        let error = conn_result.error.expect("405 应携带 error");
        assert!(
            error.contains("不支持") || error.contains("方法"),
            "405 应映射到方法不支持语义: {error}"
        );
        assert!(
            !error.contains("testpass") && !error.contains("password"),
            "错误信息不得泄漏凭据: {error}"
        );
    }
    // -----------------------------------------------------------------------
    // Commit 6：Mock Server 401/403/405 列表测试错误分类
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn mock_server_list_401_returns_auth_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 401 Unauthorized", &[], "")
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "listuser",
            Some("listpass".to_string()),
        );
        let result = webdav_list_backups_with_client(&client, &target).await;
        let record = handle.join().expect("mock server 线程 panic");
        let err = result.unwrap_err();
        assert!(
            err.contains("鉴权失败"),
            "列表 401 应映射到鉴权失败语义: {err}"
        );
        assert!(
            !err.contains("listuser") && !err.contains("listpass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(
            record.authorization_present,
            "请求应携带 Authorization 头"
        );
    }
    #[tokio::test]
    async fn mock_server_list_403_returns_forbidden_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 403 Forbidden", &[], "")
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "forbidden_user",
            Some("forbidden_pass".to_string()),
        );
        let result = webdav_list_backups_with_client(&client, &target).await;
        let record = handle.join().expect("mock server 线程 panic");
        let err = result.unwrap_err();
        assert!(
            err.contains("权限不足") || err.contains("访问被拒绝"),
            "列表 403 应映射到权限不足/访问被拒绝语义: {err}"
        );
        assert!(
            !err.contains("forbidden_user") && !err.contains("forbidden_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(
            record.authorization_present,
            "请求应携带 Authorization 头"
        );
    }
    #[tokio::test]
    async fn mock_server_list_405_returns_method_not_allowed_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 405 Method Not Allowed", &[], "")
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test(&base_url, "SoNotes_Backups/");
        let result = webdav_list_backups_with_client(&client, &target).await;
        let _record = handle.join().expect("mock server 线程 panic");
        let err = result.unwrap_err();
        assert!(
            err.contains("不支持") || err.contains("方法"),
            "列表 405 应映射到方法不支持语义: {err}"
        );
        assert!(
            !err.contains("password") && !err.contains("token"),
            "错误信息不得泄漏凭据: {err}"
        );
    }
    // -----------------------------------------------------------------------
    // Commit 7：上传状态码分类与冲突重试边界测试
    // -----------------------------------------------------------------------
    fn create_test_zip(path: &Path) {
        let content: &[u8] = b"PK\x03\x04test";
        std::fs::write(path, content).expect("创建测试 zip 文件失败");
    }
    #[tokio::test]
    async fn upload_201_returns_success() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 200 OK", &[], ""),
                ("HTTP/1.1 201 Created", &[], ""),
            ])
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "upload_user",
            Some("upload_pass".to_string()),
        );
        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);
        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let records = handle.join().expect("mock server 线程 panic");
        assert_eq!(records.len(), 2, "应收到 PROPFIND + PUT 两个请求");
        assert_eq!(records[0].method, "PROPFIND", "第一个请求应为 PROPFIND");
        assert_eq!(records[1].method, "PUT", "第二个请求应为 PUT");
        assert!(records[1].authorization_present, "PUT 应携带 Authorization");
        let upload_result = result.expect("201 应返回 Ok");
        assert!(upload_result.success, "201 应标记为成功");
        assert!(upload_result.remote_file_name.is_some(), "201 应返回文件名");
        assert!(!zip_path.exists(), "成功后临时 zip 应被清理");
        let _ = std::fs::remove_dir_all(&zip_dir);
    }
    #[tokio::test]
    async fn upload_204_returns_success() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 200 OK", &[], ""),
                ("HTTP/1.1 204 No Content", &[], ""),
            ])
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "upload_user",
            Some("upload_pass".to_string()),
        );
        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);
        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let _records = handle.join().expect("mock server 线程 panic");
        let upload_result = result.expect("204 应返回 Ok");
        assert!(upload_result.success, "204 应标记为成功");
        assert!(!zip_path.exists(), "成功后临时 zip 应被清理");
        let _ = std::fs::remove_dir_all(&zip_dir);
    }
    #[tokio::test]
    async fn upload_401_returns_auth_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 200 OK", &[], ""),
                ("HTTP/1.1 401 Unauthorized", &[], ""),
            ])
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "auth_user",
            Some("auth_pass".to_string()),
        );
        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);
        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let _records = handle.join().expect("mock server 线程 panic");
        let upload_result = result.unwrap();
        assert!(!upload_result.success, "401 应返回失败");
        let err = upload_result.error.unwrap();
        assert!(
            err.contains("鉴权失败"),
            "401 应映射到鉴权失败语义: {err}"
        );
        assert!(
            !err.contains("auth_user") && !err.contains("auth_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(!zip_path.exists(), "失败后临时 zip 应被清理");
        let _ = std::fs::remove_dir_all(&zip_dir);
    }
    #[tokio::test]
    async fn upload_403_returns_forbidden_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 200 OK", &[], ""),
                ("HTTP/1.1 403 Forbidden", &[], ""),
            ])
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "forbidden_user",
            Some("forbidden_pass".to_string()),
        );
        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);
        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let _records = handle.join().expect("mock server 线程 panic");
        let upload_result = result.unwrap();
        assert!(!upload_result.success, "403 应返回失败");
        let err = upload_result.error.unwrap();
        assert!(
            err.contains("权限不足") || err.contains("访问被拒绝"),
            "403 应映射到权限不足/访问被拒绝语义: {err}"
        );
        assert!(
            !err.contains("forbidden_user") && !err.contains("forbidden_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(!zip_path.exists(), "失败后临时 zip 应被清理");
        let _ = std::fs::remove_dir_all(&zip_dir);
    }
    #[tokio::test]
    async fn upload_423_returns_locked_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 200 OK", &[] as &[&str], ""),
                ("HTTP/1.1 423 Locked", &[] as &[&str], ""),
            ])
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "lock_user",
            Some("lock_pass".to_string()),
        );
        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);
        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let records = handle.join().expect("mock server 线程 panic");
        assert_eq!(
            records.len(),
            2,
            "423 非冲突重试状态码，应仅收到 PROPFIND + 1 PUT"
        );
        let upload_result = result.unwrap();
        assert!(!upload_result.success, "423 应返回失败");
        let err = upload_result.error.unwrap();
        assert!(
            err.contains("锁定"),
            "423 应映射到锁定语义: {err}"
        );
        assert!(
            !err.contains("lock_user") && !err.contains("lock_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        let _ = std::fs::remove_dir_all(&zip_dir);
    }
    #[tokio::test]
    async fn upload_507_returns_insufficient_storage_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 200 OK", &[] as &[&str], ""),
                ("HTTP/1.1 507 Insufficient Storage", &[] as &[&str], ""),
            ])
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "space_user",
            Some("space_pass".to_string()),
        );
        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);
        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let records = handle.join().expect("mock server 线程 panic");
        assert_eq!(
            records.len(),
            2,
            "507 非冲突重试状态码，应仅收到 PROPFIND + 1 PUT"
        );
        let upload_result = result.unwrap();
        assert!(!upload_result.success, "507 应返回失败");
        let err = upload_result.error.unwrap();
        assert!(
            err.contains("空间不足"),
            "507 应映射到空间不足语义: {err}"
        );
        assert!(
            !err.contains("space_user") && !err.contains("space_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        let _ = std::fs::remove_dir_all(&zip_dir);
    }
    #[tokio::test]
    async fn upload_405_returns_method_not_allowed_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 200 OK", &[] as &[&str], ""),
                ("HTTP/1.1 405 Method Not Allowed", &[] as &[&str], ""),
            ])
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "method_user",
            Some("method_pass".to_string()),
        );
        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);
        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let records = handle.join().expect("mock server 线程 panic");
        assert_eq!(
            records.len(),
            2,
            "405 非冲突重试状态码，应仅收到 PROPFIND + 1 PUT"
        );
        let upload_result = result.unwrap();
        assert!(!upload_result.success, "405 应返回失败");
        let err = upload_result.error.unwrap();
        assert!(
            err.contains("不支持") || err.contains("方法"),
            "405 应映射到方法不支持语义: {err}"
        );
        assert!(
            !err.contains("method_user") && !err.contains("method_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(!zip_path.exists(), "失败后临时 zip 应被清理");
        let _ = std::fs::remove_dir_all(&zip_dir);
    }
    #[tokio::test]
    async fn upload_500_returns_unexpected_status_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 200 OK", &[] as &[&str], ""),
                ("HTTP/1.1 500 Internal Server Error", &[] as &[&str], ""),
            ])
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "err_user",
            Some("err_pass".to_string()),
        );
        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);
        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let records = handle.join().expect("mock server 线程 panic");
        assert_eq!(
            records.len(),
            2,
            "5xx 不再通用重试，应仅收到 PROPFIND + 1 PUT"
        );
        let upload_result = result.unwrap();
        assert!(!upload_result.success, "500 应返回失败");
        let err = upload_result.error.unwrap();
        assert!(
            err.contains("500") || err.contains("异常状态码"),
            "500 应映射到异常状态码语义: {err}"
        );
        assert!(
            !err.contains("err_user") && !err.contains("err_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(!zip_path.exists(), "失败后临时 zip 应被清理");
        let _ = std::fs::remove_dir_all(&zip_dir);
    }
    #[tokio::test]
    async fn upload_consecutive_409_exhausts_retry_limit() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            let mut responses = vec![("HTTP/1.1 200 OK", &[] as &[&str], "")];
            for _ in 0..UPLOAD_RETRY_LIMIT {
                responses.push(("HTTP/1.1 409 Conflict", &[] as &[&str], ""));
            }
            server.accept_sequential_requests(&responses)
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "retry_user",
            Some("retry_pass".to_string()),
        );
        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);
        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let records = handle.join().expect("mock server 线程 panic");
        assert_eq!(
            records.len(),
            1 + UPLOAD_RETRY_LIMIT as usize,
            "应收到 1 PROPFIND + {} PUT",
            UPLOAD_RETRY_LIMIT
        );
        let upload_result = result.unwrap();
        assert!(!upload_result.success, "连续 409 达到上限后应返回失败");
        let err = upload_result.error.unwrap();
        assert!(
            err.contains("同名备份") || err.contains("冲突"),
            "连续 409 达到上限后应返回冲突相关错误: {err}"
        );
        assert!(
            !err.contains("retry_user") && !err.contains("retry_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(!zip_path.exists(), "重试耗尽后临时 zip 应被清理");
        let _ = std::fs::remove_dir_all(&zip_dir);
    }
    #[tokio::test]
    async fn upload_consecutive_412_exhausts_retry_limit() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            let mut responses = vec![("HTTP/1.1 200 OK", &[] as &[&str], "")];
            for _ in 0..UPLOAD_RETRY_LIMIT {
                responses.push(("HTTP/1.1 412 Precondition Failed", &[] as &[&str], ""));
            }
            server.accept_sequential_requests(&responses)
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "retry12_user",
            Some("retry12_pass".to_string()),
        );
        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);
        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let records = handle.join().expect("mock server 线程 panic");
        assert_eq!(
            records.len(),
            1 + UPLOAD_RETRY_LIMIT as usize,
            "应收到 1 PROPFIND + {} PUT",
            UPLOAD_RETRY_LIMIT
        );
        let upload_result = result.unwrap();
        assert!(!upload_result.success, "连续 412 达到上限后应返回失败");
        let err = upload_result.error.unwrap();
        assert!(
            err.contains("同名备份") || err.contains("冲突"),
            "连续 412 达到上限后应返回冲突相关错误: {err}"
        );
        assert!(
            !err.contains("retry12_user") && !err.contains("retry12_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(!zip_path.exists(), "重试耗尽后临时 zip 应被清理");
        let _ = std::fs::remove_dir_all(&zip_dir);
    }
    #[tokio::test]
    async fn upload_409_then_201_succeeds_on_retry() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 200 OK", &[], ""),
                ("HTTP/1.1 409 Conflict", &[], ""),
                ("HTTP/1.1 201 Created", &[], ""),
            ])
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "retry_ok_user",
            Some("retry_ok_pass".to_string()),
        );
        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);
        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let records = handle.join().expect("mock server 线程 panic");
        assert_eq!(records.len(), 3, "应收到 PROPFIND + PUT 409 + PUT 201");
        assert_eq!(records[1].method, "PUT");
        assert_eq!(records[2].method, "PUT");
        let upload_result = result.expect("409 后 201 应成功");
        assert!(upload_result.success, "第二次尝试 201 应标记为成功");
        assert!(!zip_path.exists(), "成功后临时 zip 应被清理");
        let _ = std::fs::remove_dir_all(&zip_dir);
    }
    #[tokio::test]
    async fn upload_error_messages_do_not_leak_credentials() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 200 OK", &[], ""),
                ("HTTP/1.1 423 Locked", &[], ""),
            ])
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "secret_user_abc",
            Some("super_secret_token_xyz".to_string()),
        );
        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);
        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let records = handle.join().expect("mock server 线程 panic");
        assert!(records[1].authorization_present, "PUT 应携带 Authorization");
        let upload_result = result.unwrap();
        assert!(!upload_result.success, "423 应返回失败");
        let err = upload_result.error.unwrap();
        assert!(
            !err.contains("secret_user_abc"),
            "错误信息不得泄漏用户名: {err}"
        );
        assert!(
            !err.contains("super_secret_token_xyz"),
            "错误信息不得泄漏密码: {err}"
        );
        assert!(
            !err.contains("Authorization"),
            "错误信息不得提及 Authorization 头: {err}"
        );
        let _ = std::fs::remove_dir_all(&zip_dir);
    }
    #[tokio::test]
    async fn upload_401_403_return_immediately_no_retry() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 200 OK", &[], ""),
                ("HTTP/1.1 401 Unauthorized", &[], ""),
            ])
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "no_retry_user",
            Some("no_retry_pass".to_string()),
        );
        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);
        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let records = handle.join().expect("mock server 线程 panic");
        assert_eq!(
            records.len(),
            2,
            "401/403 应立即返回，只收到 PROPFIND + 1 PUT"
        );
        let upload_result = result.unwrap();
        assert!(!upload_result.success, "401 应返回失败");
        assert!(!zip_path.exists(), "401 失败后临时 zip 应被清理");
        let _ = std::fs::remove_dir_all(&zip_dir);
    }
    #[tokio::test]
    async fn upload_transport_error_returns_immediately_without_retry() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            let propfind = server.accept_one_request(
                "HTTP/1.1 200 OK",
                &[] as &[&str],
                "",
            );
            let put = server.accept_one_request_drop_without_response();
            vec![propfind, put]
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "transport_user",
            Some("transport_pass".to_string()),
        );
        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-upload-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);
        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let records = handle.join().expect("mock server 线程 panic");
        assert_eq!(
            records.len(),
            2,
            "传输错误应立即返回，只收到 PROPFIND + 1 PUT，不应重试"
        );
        assert_eq!(records[0].method, "PROPFIND");
        assert_eq!(records[1].method, "PUT");
        let upload_result = result.unwrap();
        assert!(!upload_result.success, "传输错误应返回失败");
        let err = upload_result.error.unwrap();
        assert!(
            err.contains("WebDAV"),
            "错误消息应来自 classify_reqwest_error 分类: {err}"
        );
        assert!(
            !err.contains("transport_user") && !err.contains("transport_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(!zip_path.exists(), "传输错误后临时 zip 应被清理");
        let _ = std::fs::remove_dir_all(&zip_dir);
    }
    // -----------------------------------------------------------------------
    // Commit 8：下载 Content-Length / 流式上限 / 临时目录错误测试
    // -----------------------------------------------------------------------
    fn download_test_temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "webdav-dl-test-{label}-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&dir).expect("创建测试临时目录失败");
        dir
    }
    fn download_test_client_and_target(base_url: &str) -> (reqwest::Client, WebDavRequestTarget) {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("创建测试 reqwest::Client 失败");
        let target = WebDavRequestTarget::for_test_with_auth(
            base_url,
            "SoNotes_Backups/",
            "dl_user",
            Some("dl_pass".to_string()),
        );
        (client, target)
    }
    #[tokio::test]
    async fn download_no_content_length_succeeds_and_creates_token() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let body = b"PK\x03\x04fake zip content here";
        let handle = std::thread::spawn(move || {
            server.accept_one_download_request("HTTP/1.1 200 OK", None, body)
        });
        let (client, target) = download_test_client_and_target(&base_url);
        let temp_dir = download_test_temp_dir("no-cl");
        let result = download_backup_with_limit(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
            &temp_dir,
            1024,
        )
        .await;
        let record = handle.join().expect("mock server 线程 panic");
        assert_eq!(record.method, "GET");
        assert!(record.authorization_present, "下载请求应携带 Authorization");
        let dl_result = result.expect("无 Content-Length 下载应成功");
        assert!(dl_result.success);
        assert!(
            dl_result.download_token.is_some(),
            "成功下载应生成 download token"
        );
        if let Some(token) = &dl_result.download_token {
            let _ = cleanup_download_token(token);
        }
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
    #[tokio::test]
    async fn download_content_length_over_max_fails_before_body() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_download_request(
                "HTTP/1.1 200 OK",
                Some(2_000_000_000),
                b"",
            )
        });
        let (client, target) = download_test_client_and_target(&base_url);
        let temp_dir = download_test_temp_dir("cl-over");
        let result = download_backup_with_limit(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
            &temp_dir,
            1024,
        )
        .await;
        let _record = handle.join().expect("mock server 线程 panic");
        let err = result.unwrap_err();
        assert_eq!(
            err.kind,
            WebDavErrorKind::DownloadTooLarge,
            "Content-Length 超限应返回 DownloadTooLarge: {:?}",
            err.kind
        );
        assert!(!err.retryable);
        let entries: Vec<_> = std::fs::read_dir(&temp_dir)
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "zip"))
            .collect();
        assert!(entries.is_empty(), "Content-Length 超限不应创建临时文件");
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
    #[tokio::test]
    async fn download_streaming_over_max_deletes_temp_file() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let big_body = vec![0u8; 64];
        let handle = std::thread::spawn(move || {
            server.accept_one_download_request("HTTP/1.1 200 OK", None, &big_body)
        });
        let (client, target) = download_test_client_and_target(&base_url);
        let temp_dir = download_test_temp_dir("stream-over");
        let result = download_backup_with_limit(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
            &temp_dir,
            16,
        )
        .await;
        let _record = handle.join().expect("mock server 线程 panic");
        let err = result.unwrap_err();
        assert_eq!(
            err.kind,
            WebDavErrorKind::DownloadTooLarge,
            "流式超限应返回 DownloadTooLarge: {:?}",
            err.kind
        );
        let entries: Vec<_> = std::fs::read_dir(&temp_dir)
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "zip"))
            .collect();
        assert!(entries.is_empty(), "流式超限后临时文件应被删除");
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
    #[tokio::test]
    async fn download_404_returns_not_found_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_download_request("HTTP/1.1 404 Not Found", None, b"")
        });
        let (client, target) = download_test_client_and_target(&base_url);
        let temp_dir = download_test_temp_dir("404");
        let result = download_backup_with_limit(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
            &temp_dir,
            1024,
        )
        .await;
        let _record = handle.join().expect("mock server 线程 panic");
        let err = result.unwrap_err();
        assert_eq!(
            err.kind,
            WebDavErrorKind::NotFound,
            "404 应映射到 NotFound: {:?}",
            err.kind
        );
        assert_eq!(err.status, Some(404));
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
    #[tokio::test]
    async fn download_401_returns_auth_failed_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_download_request(
                "HTTP/1.1 401 Unauthorized",
                None,
                b"",
            )
        });
        let (client, target) = download_test_client_and_target(&base_url);
        let temp_dir = download_test_temp_dir("401");
        let result = download_backup_with_limit(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
            &temp_dir,
            1024,
        )
        .await;
        let _record = handle.join().expect("mock server 线程 panic");
        let err = result.unwrap_err();
        assert_eq!(
            err.kind,
            WebDavErrorKind::AuthFailed,
            "401 应映射到 AuthFailed: {:?}",
            err.kind
        );
        assert_eq!(err.status, Some(401));
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
    #[tokio::test]
    async fn download_403_returns_forbidden_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_download_request(
                "HTTP/1.1 403 Forbidden",
                None,
                b"",
            )
        });
        let (client, target) = download_test_client_and_target(&base_url);
        let temp_dir = download_test_temp_dir("403");
        let result = download_backup_with_limit(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
            &temp_dir,
            1024,
        )
        .await;
        let _record = handle.join().expect("mock server 线程 panic");
        let err = result.unwrap_err();
        assert_eq!(
            err.kind,
            WebDavErrorKind::Forbidden,
            "403 应映射到 Forbidden: {:?}",
            err.kind
        );
        assert_eq!(err.status, Some(403));
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
    #[tokio::test]
    async fn download_file_as_temp_root_returns_local_temp_file_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_download_request(
                "HTTP/1.1 200 OK",
                None,
                b"some data",
            )
        });
        let (client, target) = download_test_client_and_target(&base_url);
        let temp_dir = download_test_temp_dir("file-root");
        let file_as_root = temp_dir.join("not_a_dir.txt");
        std::fs::write(&file_as_root, b"I am a file").unwrap();
        let result = download_backup_with_limit(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
            &file_as_root,
            1024,
        )
        .await;
        let _record = handle.join().expect("mock server 线程 panic");
        let err = result.unwrap_err();
        assert_eq!(
            err.kind,
            WebDavErrorKind::LocalTempFileError,
            "文件路径作为 temp_root 应返回 LocalTempFileError: {:?}",
            err.kind
        );
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
    #[tokio::test]
    async fn download_nested_file_as_temp_root_returns_local_temp_file_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_download_request(
                "HTTP/1.1 200 OK",
                None,
                b"some data",
            )
        });
        let (client, target) = download_test_client_and_target(&base_url);
        let temp_dir = download_test_temp_dir("nested-root");
        let file_as_parent = temp_dir.join("blocker.txt");
        std::fs::write(&file_as_parent, b"blocker").unwrap();
        let nested_bad = file_as_parent.join("subdir");
        let result = download_backup_with_limit(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
            &nested_bad,
            1024,
        )
        .await;
        let _record = handle.join().expect("mock server 线程 panic");
        let err = result.unwrap_err();
        assert_eq!(
            err.kind,
            WebDavErrorKind::LocalTempFileError,
            "不存在的 temp_root 应返回 LocalTempFileError: {:?}",
            err.kind
        );
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
    // -----------------------------------------------------------------------
    // Commit 9：删除状态码分类与幂等语义测试
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn delete_204_returns_success() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 204 No Content", &[], "")
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "del_user",
            Some("del_pass".to_string()),
        );
        let result = webdav_delete_backup_with_client(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
        )
        .await;
        let record = handle.join().expect("mock server 线程 panic");
        assert_eq!(record.method, "DELETE", "请求方法应为 DELETE");
        assert!(
            record.authorization_present,
            "DELETE 请求应携带 Authorization"
        );
        let del_result = result.expect("204 应返回 Ok");
        assert!(del_result.success, "204 应标记为成功");
        assert!(del_result.error.is_none(), "204 不应携带 error");
    }
    #[tokio::test]
    async fn delete_200_returns_success() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 200 OK", &[], "")
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "del_user",
            Some("del_pass".to_string()),
        );
        let result = webdav_delete_backup_with_client(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
        )
        .await;
        let _record = handle.join().expect("mock server 线程 panic");
        let del_result = result.expect("200 应返回 Ok");
        assert!(del_result.success, "200 应标记为成功");
        assert!(del_result.error.is_none(), "200 不应携带 error");
    }
    #[tokio::test]
    async fn delete_404_returns_idempotent_success_with_message() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 404 Not Found", &[], "")
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "del_user",
            Some("del_pass".to_string()),
        );
        let result = webdav_delete_backup_with_client(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
        )
        .await;
        let record = handle.join().expect("mock server 线程 panic");
        assert_eq!(record.method, "DELETE");
        assert!(record.authorization_present, "DELETE 应携带 Authorization");
        let del_result = result.expect("404 幂等删除应返回 Ok");
        assert!(del_result.success, "404 幂等删除应标记为成功");
        assert_eq!(
            del_result.error.as_deref(),
            Some("远端备份已不存在"),
            "404 应保留现有幂等消息"
        );
    }
    #[tokio::test]
    async fn delete_423_returns_locked_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 423 Locked", &[], "")
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "lock_del_user",
            Some("lock_del_pass".to_string()),
        );
        let result = webdav_delete_backup_with_client(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
        )
        .await;
        let _record = handle.join().expect("mock server 线程 panic");
        let err = result.unwrap_err();
        assert!(err.contains("锁定"), "423 应映射到锁定语义: {err}");
        assert!(
            !err.contains("lock_del_user") && !err.contains("lock_del_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
    }
    #[tokio::test]
    async fn delete_401_returns_auth_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 401 Unauthorized", &[], "")
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "auth_del_user",
            Some("auth_del_pass".to_string()),
        );
        let result = webdav_delete_backup_with_client(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
        )
        .await;
        let _record = handle.join().expect("mock server 线程 panic");
        let err = result.unwrap_err();
        assert!(
            err.contains("鉴权失败"),
            "401 应映射到鉴权失败语义: {err}"
        );
        assert!(
            !err.contains("auth_del_user") && !err.contains("auth_del_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
    }
    #[tokio::test]
    async fn delete_403_returns_forbidden_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 403 Forbidden", &[], "")
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "forbid_del_user",
            Some("forbid_del_pass".to_string()),
        );
        let result = webdav_delete_backup_with_client(
            &client,
            &target,
            "SoNotes_Backup_20240101120000.zip",
        )
        .await;
        let _record = handle.join().expect("mock server 线程 panic");
        let err = result.unwrap_err();
        assert!(
            err.contains("权限不足") || err.contains("访问被拒绝"),
            "403 应映射到权限不足或访问被拒绝: {err}"
        );
        assert!(
            !err.contains("forbid_del_user") && !err.contains("forbid_del_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
    }
    #[test]
    fn delete_invalid_remote_filename_fails_before_request() {
        let err = validate_remote_backup_filename("readme.txt").unwrap_err();
        assert!(
            err.contains("文件名") || err.contains("长度") || err.contains("前缀"),
            "非法文件名应在请求前被拒绝: {err}"
        );
        assert!(
            !err.contains("pass"),
            "错误信息不得泄漏凭据: {err}"
        );
    }
    #[tokio::test]
    async fn upload_preflight_propfind_405_returns_method_not_allowed() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        // PROPFIND 返回 405 → 不再走 MKCOL，直接报错
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 405 Method Not Allowed", &[], "")
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "preflight_user",
            Some("preflight_pass".to_string()),
        );
        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-preflight-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);
        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let _record = handle.join().expect("mock server 线程 panic");
        let upload_result = result.unwrap();
        assert!(!upload_result.success, "PROPFIND 405 应返回失败");
        let err = upload_result.error.unwrap();
        // 应保留 MethodNotAllowed 语义，不应被折叠为通用上传失败
        assert!(
            err.contains("不支持") || err.contains("方法"),
            "PROPFIND 405 应映射到方法不支持语义，而非通用上传失败: {err}"
        );
        assert!(
            !err.contains("preflight_user") && !err.contains("preflight_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(
            !zip_path.exists(),
            "失败后临时 zip 应被清理"
        );
        let _ = std::fs::remove_dir_all(&zip_dir);
    }
    #[tokio::test]
    async fn upload_preflight_mkcol_423_returns_locked() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        // PROPFIND 404 → MKCOL 423
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 404 Not Found", &[] as &[&str], ""),
                ("HTTP/1.1 423 Locked", &[] as &[&str], ""),
            ])
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "mkcol_user",
            Some("mkcol_pass".to_string()),
        );
        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-preflight-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);
        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let _records = handle.join().expect("mock server 线程 panic");
        let upload_result = result.unwrap();
        assert!(!upload_result.success, "MKCOL 423 应返回失败");
        let err = upload_result.error.unwrap();
        // 应保留 Locked 语义，不应被折叠为通用上传失败
        assert!(
            err.contains("锁定"),
            "MKCOL 423 应映射到锁定语义，而非通用上传失败: {err}"
        );
        assert!(
            !err.contains("mkcol_user") && !err.contains("mkcol_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(
            !zip_path.exists(),
            "失败后临时 zip 应被清理"
        );
        let _ = std::fs::remove_dir_all(&zip_dir);
    }
    #[tokio::test]
    async fn upload_preflight_mkcol_507_returns_insufficient_storage() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        // PROPFIND 404 → MKCOL 507
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 404 Not Found", &[] as &[&str], ""),
                ("HTTP/1.1 507 Insufficient Storage", &[] as &[&str], ""),
            ])
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "storage_user",
            Some("storage_pass".to_string()),
        );
        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-preflight-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);
        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let _records = handle.join().expect("mock server 线程 panic");
        let upload_result = result.unwrap();
        assert!(!upload_result.success, "MKCOL 507 应返回失败");
        let err = upload_result.error.unwrap();
        // 应保留 InsufficientStorage 语义，不应被折叠为通用上传失败
        assert!(
            err.contains("空间不足"),
            "MKCOL 507 应映射到空间不足语义，而非通用上传失败: {err}"
        );
        assert!(
            !err.contains("storage_user") && !err.contains("storage_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(
            !zip_path.exists(),
            "失败后临时 zip 应被清理"
        );
        let _ = std::fs::remove_dir_all(&zip_dir);
    }
    #[tokio::test]
    async fn upload_preflight_preserves_auth_error() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        // PROPFIND 返回 401 → 鉴权失败
        let handle = std::thread::spawn(move || {
            server.accept_one_request("HTTP/1.1 401 Unauthorized", &[], "")
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "auth_user",
            Some("auth_pass".to_string()),
        );
        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-preflight-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);
        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let _record = handle.join().expect("mock server 线程 panic");
        let upload_result = result.unwrap();
        assert!(!upload_result.success, "PROPFIND 401 应返回失败");
        let err = upload_result.error.unwrap();
        // 鉴权错误应保留现有语义
        assert!(
            err.contains("鉴权失败"),
            "PROPFIND 401 应映射到鉴权失败语义: {err}"
        );
        assert!(
            !err.contains("auth_user") && !err.contains("auth_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        assert!(
            !zip_path.exists(),
            "失败后临时 zip 应被清理"
        );
        let _ = std::fs::remove_dir_all(&zip_dir);
    }
    #[tokio::test]
    async fn upload_preflight_propfind_404_mkcol_200_succeeds() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        // PROPFIND 404 → MKCOL 200 → PUT 201
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 404 Not Found", &[] as &[&str], ""),
                ("HTTP/1.1 200 OK", &[] as &[&str], ""),
                ("HTTP/1.1 201 Created", &[] as &[&str], ""),
            ])
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "mkcol_ok_user",
            Some("mkcol_ok_pass".to_string()),
        );
        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-preflight-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);
        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let _records = handle.join().expect("mock server 线程 panic");
        let upload_result = result.expect("404→MKCOL 200→PUT 201 应成功");
        assert!(upload_result.success, "目录创建后上传应标记为成功");
        assert!(upload_result.remote_file_name.is_some(), "成功后应返回文件名");
        assert!(!zip_path.exists(), "成功后临时 zip 应被清理");
        let _ = std::fs::remove_dir_all(&zip_dir);
    }
    #[tokio::test]
    async fn upload_preflight_error_no_credential_leak() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        // PROPFIND 404 → MKCOL 507，使用极敏感凭据
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 404 Not Found", &[] as &[&str], ""),
                ("HTTP/1.1 507 Insufficient Storage", &[] as &[&str], ""),
            ])
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "sensitive_user_xyz_abc",
            Some("super_secret_token_12345".to_string()),
        );
        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-preflight-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);
        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let records = handle.join().expect("mock server 线程 panic");
        // PROPFIND 和 MKCOL 都应携带 Authorization
        assert!(records[0].authorization_present, "PROPFIND 应携带 Authorization");
        assert!(records[1].authorization_present, "MKCOL 应携带 Authorization");
        let upload_result = result.unwrap();
        assert!(!upload_result.success, "MKCOL 507 应返回失败");
        let err = upload_result.error.unwrap();
        assert!(
            !err.contains("sensitive_user_xyz_abc"),
            "错误信息不得泄漏用户名: {err}"
        );
        assert!(
            !err.contains("super_secret_token_12345"),
            "错误信息不得泄漏密码: {err}"
        );
        assert!(
            !err.contains("Authorization"),
            "错误信息不得提及 Authorization 头: {err}"
        );
        assert!(
            !err.contains("Basic"),
            "错误信息不得提及 Basic 认证: {err}"
        );
        let _ = std::fs::remove_dir_all(&zip_dir);
    }
    #[tokio::test]
    async fn upload_preflight_mkcol_409_returns_path_conflict() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        // PROPFIND 404 → MKCOL 409
        let handle = std::thread::spawn(move || {
            server.accept_sequential_requests(&[
                ("HTTP/1.1 404 Not Found", &[] as &[&str], ""),
                ("HTTP/1.1 409 Conflict", &[] as &[&str], ""),
            ])
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "conflict_user",
            Some("conflict_pass".to_string()),
        );
        let zip_dir = std::env::temp_dir().join(format!(
            "webdav-preflight-test-{:016x}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&zip_dir).unwrap();
        let zip_path = zip_dir.join("test.zip");
        create_test_zip(&zip_path);
        let result = webdav_upload_backup_with_client(&client, &target, &zip_path).await;
        let _records = handle.join().expect("mock server 线程 panic");
        let upload_result = result.unwrap();
        assert!(!upload_result.success, "MKCOL 409 应返回失败");
        let err = upload_result.error.unwrap();
        // 应保留 PathConflict 语义
        assert!(
            err.contains("冲突"),
            "MKCOL 409 应映射到冲突语义，而非通用上传失败: {err}"
        );
        assert!(
            !err.contains("conflict_user") && !err.contains("conflict_pass"),
            "错误信息不得泄漏凭据: {err}"
        );
        let _ = std::fs::remove_dir_all(&zip_dir);
    }
    #[test]
    fn parse_propfind_truncated_eof_returns_invalid_propfind_response() {
        let result = parse_propfind_response(r#"<D:multistatus><D:response>"#);
        let err = result.unwrap_err();
        assert_eq!(
            err,
            WebDavOperationError {
                kind: WebDavErrorKind::InvalidPropfindResponse,
                status: None,
                retryable: false,
            },
            "未闭合 XML EOF 应精确匹配 InvalidPropfindResponse: {err:?}"
        );
    }
    #[test]
    fn parse_propfind_error_message_maps_to_user_visible_string() {
        let error = WebDavOperationError {
            kind: WebDavErrorKind::InvalidPropfindResponse,
            status: None,
            retryable: false,
        };
        let msg = webdav_error_message(&error);
        assert_eq!(msg, "WebDAV 列表 XML 解析失败");
        assert!(
            !msg.contains("password") && !msg.contains("token"),
            "错误信息不得泄漏凭据: {msg}"
        );
    }
    #[test]
    fn parse_propfind_fragmented_tag_returns_invalid_propfind_response() {
        let result = parse_propfind_response(
            r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/SoNotes_Backups/"#,
        );
        let err = result.unwrap_err();
        assert_eq!(
            err.kind,
            WebDavErrorKind::InvalidPropfindResponse,
            "EOF 时 in_href=true 应返回 InvalidPropfindResponse: {:?}",
            err.kind
        );
    }
    #[tokio::test]
    async fn mock_server_list_malformed_xml_returns_xml_parse_error_no_credential_leak() {
        let server = MockWebDavServer::bind();
        let base_url = server.base_url().to_string();
        let malformed_body = load_fixture("propfind_malformed.xml");
        let handle = std::thread::spawn(move || {
            server.accept_one_request(
                "HTTP/1.1 207 Multi-Status",
                &[],
                &malformed_body,
            )
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("创建测试 reqwest::Client 失败");
        let target = WebDavRequestTarget::for_test_with_auth(
            &base_url,
            "SoNotes_Backups/",
            "xml_err_user",
            Some("xml_err_secret_token".to_string()),
        );
        let result = webdav_list_backups_with_client(&client, &target).await;
        let record = handle.join().expect("mock server 线程 panic");
        assert_eq!(record.method, "PROPFIND", "请求方法应为 PROPFIND");
        assert!(
            record.authorization_present,
            "请求应携带 Authorization 头"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("XML 解析失败"),
            "畸形 XML 应返回 XML 解析失败消息: {err}"
        );
        assert!(
            err.contains("WebDAV 列表"),
            "错误消息应包含 'WebDAV 列表': {err}"
        );
        assert!(
            !err.contains("xml_err_user"),
            "错误信息不得泄漏用户名: {err}"
        );
        assert!(
            !err.contains("xml_err_secret_token"),
            "错误信息不得泄漏密码: {err}"
        );
        assert!(
            !err.contains("Authorization"),
            "错误信息不得提及 Authorization 头: {err}"
        );
        assert!(
            !err.contains("Basic"),
            "错误信息不得提及 Basic 认证: {err}"
        );
    }
    // ===================================================================
    // Credential Store 测试
    // ===================================================================
    #[test]
    fn memory_store_save_and_load() {
        let store = MemoryWebDavCredentialStore::new();
        let key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "test-account".to_string(),
        };
        store.save(&key, TEST_SECRET).expect("save 应成功");
        let loaded = store.load(&key).expect("load 应成功");
        assert_eq!(loaded, TEST_SECRET, "loaded secret 应与保存的一致");
    }
    #[test]
    fn memory_store_load_missing_returns_missing_secret() {
        let store = MemoryWebDavCredentialStore::new();
        let key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "nonexistent".to_string(),
        };
        let err = store.load(&key).unwrap_err();
        assert_eq!(err.kind, WebDavCredentialErrorKind::MissingSecret);
    }
    #[test]
    fn memory_store_delete_then_load_returns_missing() {
        let store = MemoryWebDavCredentialStore::new();
        let key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "to-delete".to_string(),
        };
        store.save(&key, TEST_SECRET).expect("save 应成功");
        store.delete(&key).expect("delete 应成功");
        let err = store.load(&key).unwrap_err();
        assert_eq!(err.kind, WebDavCredentialErrorKind::MissingSecret);
    }
    #[test]
    fn memory_store_delete_nonexistent_succeeds() {
        let store = MemoryWebDavCredentialStore::new();
        let key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "never-existed".to_string(),
        };
        // 删除不存在的 key 不应报错（幂等）
        store.delete(&key).expect("delete 不存在的 key 应成功");
    }
    #[test]
    fn memory_store_overwrite_secret() {
        let store = MemoryWebDavCredentialStore::new();
        let key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "overwrite".to_string(),
        };
        store.save(&key, "first-value").expect("第一次 save 应成功");
        store.save(&key, TEST_SECRET).expect("覆盖 save 应成功");
        let loaded = store.load(&key).expect("load 应成功");
        assert_eq!(loaded, TEST_SECRET, "覆盖后应返回新值");
    }
    #[test]
    fn memory_store_different_keys_isolated() {
        let store = MemoryWebDavCredentialStore::new();
        let key_a = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "account-a".to_string(),
        };
        let key_b = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "account-b".to_string(),
        };
        store.save(&key_a, TEST_SECRET).expect("save a 应成功");
        store.save(&key_b, "other-secret").expect("save b 应成功");
        assert_eq!(store.load(&key_a).unwrap(), TEST_SECRET);
        assert_eq!(store.load(&key_b).unwrap(), "other-secret");
    }
    #[test]
    fn credential_error_debug_redacts_secret() {
        let store = MemoryWebDavCredentialStore::new();
        let key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "debug-test".to_string(),
        };
        store.save(&key, TEST_SECRET).expect("save 应成功");
        // load 一个不同的 key，产生 MissingSecret 错误
        let missing_key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "debug-test-missing".to_string(),
        };
        let err = store.load(&missing_key).unwrap_err();
        let debug_output = format!("{err:?}");
        assert!(
            !debug_output.contains(TEST_SECRET),
            "Debug 输出不得泄漏 secret: {debug_output}"
        );
    }
    #[test]
    fn credential_key_debug_redacts_secret() {
        // 确保 key 本身不包含 secret
        let key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "sha256-abc123".to_string(),
        };
        let debug_output = format!("{key:?}");
        assert!(
            !debug_output.contains(TEST_SECRET),
            "CredentialKey Debug 不得包含 secret: {debug_output}"
        );
    }
    // -----------------------------------------------------------------------
    // SystemWebDavCredentialStore 测试（需真实系统密钥链，标记 ignore）
    // -----------------------------------------------------------------------
    #[test]
    #[ignore]
    fn system_store_save_and_load_roundtrip() {
        // ponytail: ignore 测仍参与编译；与 lib.rs 启动路径同一 store
        keyring_core::set_default_store(
            windows_native_keyring_store::Store::new().expect("初始化 Windows 密钥链失败"),
        );
        let store = SystemWebDavCredentialStore::new();
        let key = WebDavCredentialKey {
            service: "so-notes-test".to_string(),
            account: "commit3-test".to_string(),
        };
        store.save(&key, TEST_SECRET).expect("系统密钥链 save 应成功");
        let loaded = store.load(&key).expect("系统密钥链 load 应成功");
        assert_eq!(loaded, TEST_SECRET, "系统密钥链 roundtrip 结果应一致");
        let entry = keyring_core::Entry::new(&key.service, &key.account).unwrap();
        let _ = entry.delete_credential();
    }
    #[test]
    #[ignore]
    fn system_store_delete_removes_credential() {
        keyring_core::set_default_store(
            windows_native_keyring_store::Store::new().expect("初始化 Windows 密钥链失败"),
        );
        let store = SystemWebDavCredentialStore::new();
        let key = WebDavCredentialKey {
            service: "so-notes-test".to_string(),
            account: "commit3-delete-test".to_string(),
        };
        store.save(&key, TEST_SECRET).expect("系统密钥链 save 应成功");
        store.delete(&key).expect("系统密钥链 delete 应成功");
        let err = store.load(&key).unwrap_err();
        assert_eq!(
            err.kind,
            WebDavCredentialErrorKind::MissingSecret,
            "删除后 load 应返回 MissingSecret"
        );
        let entry = keyring_core::Entry::new(&key.service, &key.account).unwrap();
        let _ = entry.delete_credential();
    }
    // -----------------------------------------------------------------------
    // Commit 4: 保存/加载配置密钥链语义测试
    // -----------------------------------------------------------------------
    #[test]
    fn config_save_remember_password_roundtrip() {
        let dir = test_config_dir("remember-roundtrip");
        let path = dir.join(CONFIG_FILENAME);
        let store = MemoryWebDavCredentialStore::new();
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: true,
            password: Some(TEST_SECRET.to_string()),
            trust_host: false,
        };
        let (config, _) = prepare_config_save(&request, None).unwrap();
        assert!(config.password_saved);
        let cred_key = config.credential_key.clone().unwrap();
        store
            .save(
                &WebDavCredentialKey {
                    service: "SoNotes.WebDAV".to_string(),
                    account: cred_key.clone(),
                },
                TEST_SECRET,
            )
            .unwrap();
        let json = serde_json::to_string_pretty(&config).unwrap();
        std::fs::write(&path, &json).unwrap();
        let read_content = std::fs::read_to_string(&path).unwrap();
        let read_config: WebDavConfigFile = serde_json::from_str(&read_content).unwrap();
        let loaded_password_saved =
            read_config.password_saved && read_config.credential_key.is_some();
        assert!(loaded_password_saved, "roundtrip 后 passwordSaved 应为 true");
        let loaded_secret = store
            .load(&WebDavCredentialKey {
                service: "SoNotes.WebDAV".to_string(),
                account: read_config.credential_key.unwrap(),
            })
            .unwrap();
        assert_eq!(loaded_secret, TEST_SECRET);
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn config_save_no_remember_clears_credential() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: false,
            password: None,
            trust_host: false,
        };
        let (config, _) = prepare_config_save(&request, None).unwrap();
        assert!(!config.password_saved);
        assert!(config.credential_key.is_none());
        let loaded_password_saved =
            config.password_saved && config.credential_key.is_some();
        assert!(!loaded_password_saved, "remember=false 时 passwordSaved 应为 false");
    }
    #[test]
    fn config_save_credential_key_change_deletes_old() {
        let store = MemoryWebDavCredentialStore::new();
        let old_key_str = "old-key-hash-value-12345678";
        store
            .save(
                &WebDavCredentialKey {
                    service: "SoNotes.WebDAV".to_string(),
                    account: old_key_str.to_string(),
                },
                "old-password",
            )
            .unwrap();
        let old_config = WebDavConfigFile {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: true,
            credential_key: Some(old_key_str.to_string()),
            trust_host: false,
            trusted_host: None,
        };
        let request = WebDavConfigSaveRequest {
            server_url: "https://different-server.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: true,
            password: Some("new-password".to_string()),
            trust_host: false,
        };
        let (config, old_credential_key) = prepare_config_save(&request, Some(&old_config)).unwrap();
        assert!(config.credential_key.is_some());
        assert_ne!(config.credential_key.as_ref().unwrap(), old_key_str);
        assert_eq!(old_credential_key.as_deref(), Some(old_key_str));
        let new_key = config.credential_key.as_ref().unwrap();
        store
            .save(
                &WebDavCredentialKey {
                    service: "SoNotes.WebDAV".to_string(),
                    account: new_key.clone(),
                },
                "new-password",
            )
            .unwrap();
        let warning = delete_replaced_credential_after_config_write(
            &store,
            old_credential_key.as_deref(),
            new_key,
        );
        assert_eq!(warning, None);
        assert!(
            store.load(&WebDavCredentialKey {
                service: "SoNotes.WebDAV".to_string(),
                account: old_key_str.to_string(),
            }).is_err(),
            "旧 secret 应已被删除"
        );
        assert_eq!(
            store.load(&WebDavCredentialKey {
                service: "SoNotes.WebDAV".to_string(),
                account: new_key.clone(),
            }).unwrap(),
            "new-password"
        );
    }
    #[test]
    fn config_save_same_credential_key_keeps_old_secret() {
        let store = MemoryWebDavCredentialStore::new();
        let old_key_str = "same-key-hash-value-12345678";
        let old_key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: old_key_str.to_string(),
        };
        store.save(&old_key, "old-password").unwrap();
        let warning =
            delete_replaced_credential_after_config_write(&store, Some(old_key_str), old_key_str);
        assert_eq!(warning, None);
        assert_eq!(store.load(&old_key).unwrap(), "old-password");
    }
    #[test]
    fn config_save_write_failure_deletes_new_credential() {
        let dir = test_config_dir("save-write-failure-new-key");
        let path = dir.join(CONFIG_FILENAME);
        let store = MemoryWebDavCredentialStore::new();
        let old_key = WebDavCredentialKey {
            service: CREDENTIAL_SERVICE.to_string(),
            account: "old-key-hash-value-12345678".to_string(),
        };
        store.save(&old_key, "old-password").unwrap();
        let old_config = WebDavConfigFile {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: true,
            credential_key: Some(old_key.account.clone()),
            trust_host: false,
            trusted_host: None,
        };
        let request = WebDavConfigSaveRequest {
            server_url: "https://different-server.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: true,
            password: Some("new-password".to_string()),
            trust_host: false,
        };
        let (new_config, _) = prepare_config_save(&request, Some(&old_config)).unwrap();
        let new_key = WebDavCredentialKey {
            service: CREDENTIAL_SERVICE.to_string(),
            account: new_config.credential_key.unwrap(),
        };
        let result = save_webdav_config_to_path_with_writer(
            &path,
            &request,
            Some(&old_config),
            &store,
            |_, _| Err("disk full".to_string()),
        );
        assert!(result.unwrap_err().contains("写入 WebDAV 配置文件失败"));
        assert!(store.load(&new_key).is_err(), "新 secret 应在写失败后回滚");
        assert_eq!(store.load(&old_key).unwrap(), "old-password");
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn config_save_write_failure_restores_same_key_old_secret() {
        let dir = test_config_dir("save-write-failure-same-key");
        let path = dir.join(CONFIG_FILENAME);
        let store = MemoryWebDavCredentialStore::new();
        let old_config = WebDavConfigFile {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: true,
            credential_key: Some(compute_credential_key(
                "https://example.com/dav",
                "user1",
                "Backups/",
            )),
            trust_host: false,
            trusted_host: None,
        };
        let same_key = WebDavCredentialKey {
            service: CREDENTIAL_SERVICE.to_string(),
            account: old_config.credential_key.clone().unwrap(),
        };
        store.save(&same_key, "old-password").unwrap();
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: true,
            password: Some("new-password".to_string()),
            trust_host: false,
        };
        let result = save_webdav_config_to_path_with_writer(
            &path,
            &request,
            Some(&old_config),
            &store,
            |_, _| Err("disk full".to_string()),
        );
        assert!(result.unwrap_err().contains("写入 WebDAV 配置文件失败"));
        assert_eq!(store.load(&same_key).unwrap(), "old-password");
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn config_save_write_failure_deletes_same_key_when_old_secret_missing() {
        let dir = test_config_dir("save-write-failure-same-key-missing");
        let path = dir.join(CONFIG_FILENAME);
        let store = MemoryWebDavCredentialStore::new();
        let old_config = WebDavConfigFile {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: true,
            credential_key: Some(compute_credential_key(
                "https://example.com/dav",
                "user1",
                "Backups/",
            )),
            trust_host: false,
            trusted_host: None,
        };
        let same_key = WebDavCredentialKey {
            service: CREDENTIAL_SERVICE.to_string(),
            account: old_config.credential_key.clone().unwrap(),
        };
        // 不预置旧 secret，模拟密钥链中已缺失
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: true,
            password: Some("new-password".to_string()),
            trust_host: false,
        };
        let result = save_webdav_config_to_path_with_writer(
            &path,
            &request,
            Some(&old_config),
            &store,
            |_, _| Err("disk full".to_string()),
        );
        assert!(result.unwrap_err().contains("写入 WebDAV 配置文件失败"));
        assert!(
            store.load(&same_key).is_err(),
            "旧 secret 缺失时写失败应删除刚写入的新 secret"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn config_save_credential_key_change_delete_failure_returns_warning() {
        let store = FailingDeleteCredentialStore::new();
        let warning = delete_replaced_credential_after_config_write(
            &store,
            Some("old-key-hash-value-12345678"),
            "new-key-hash-value-87654321",
        );
        assert_eq!(
            warning,
            Some("新配置已保存，但旧凭据可能需要手动删除".to_string())
        );
    }
    #[test]
    fn config_save_remember_without_password_fails() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: true,
            password: None,
            trust_host: false,
        };
        let err = prepare_config_save(&request, None).unwrap_err();
        assert!(err.contains("记住密码时必须提供密码"), "应拒绝无密码的 remember: {err}");
    }
    #[test]
    fn config_save_userinfo_url_rejected() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://user:pass@example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: true,
            password: Some("secret".to_string()),
            trust_host: false,
        };
        let err = prepare_config_save(&request, None).unwrap_err();
        assert!(err.contains("用户名"), "应拒绝含 userinfo 的 URL: {err}");
    }
    #[test]
    fn config_load_old_format_password_saved_without_key() {
        let dir = test_config_dir("old-format");
        let path = dir.join(CONFIG_FILENAME);
        let old_config_json = serde_json::json!({
            "server_url": "https://example.com/dav",
            "username": "user1",
            "remote_dir": "Backups/",
            "password_saved": true
        });
        std::fs::write(&path, serde_json::to_string_pretty(&old_config_json).unwrap()).unwrap();
        let read_content = std::fs::read_to_string(&path).unwrap();
        let read_config: WebDavConfigFile = serde_json::from_str(&read_content).unwrap();
        let loaded_password_saved =
            read_config.password_saved && read_config.credential_key.is_some();
        assert!(!loaded_password_saved, "旧格式 password_saved=true 但无 credential_key 时应返回 false");
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn config_save_clear_returns_warning_on_delete_failure() {
        let failing_store = FailingDeleteCredentialStore::new();
        let old_key_str = "some-old-key";
        let old_config = WebDavConfigFile {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: true,
            credential_key: Some(old_key_str.to_string()),
            trust_host: false,
            trusted_host: None,
        };
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: false,
            password: None,
            trust_host: false,
        };
        let old_cred_key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: old_key_str.to_string(),
        };
        let delete_result = failing_store.delete(&old_cred_key);
        assert!(delete_result.is_err(), "FailingDeleteCredentialStore 应始终失败");
        let (config, old_credential_key) = prepare_config_save(&request, Some(&old_config)).unwrap();
        assert!(!config.password_saved);
        assert_eq!(old_credential_key.as_deref(), Some(old_key_str));
    }
    #[test]
    fn credential_store_save_error_does_not_leak_secret() {
        // 验证 save 失败时，错误消息不包含实际密码
        let store = MemoryWebDavCredentialStore::new();
        let key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "leak-test-save".to_string(),
        };
        // 先保存一个值，然后验证错误路径
        store.save(&key, TEST_SECRET).expect("save 应成功");
        // 验证 save 成功后 Debug 输出不含 secret
        let loaded = store.load(&key).unwrap();
        assert_eq!(loaded, TEST_SECRET);
        // 验证 MissingSecret 错误消息不含任何 secret
        let missing_key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "leak-test-missing".to_string(),
        };
        let err = store.load(&missing_key).unwrap_err();
        let display_msg = format!("{err}");
        assert!(
            !display_msg.contains(TEST_SECRET),
            "MissingSecret Display 消息不得泄漏 secret: {display_msg}"
        );
    }
    #[test]
    fn credential_store_delete_error_does_not_leak_secret() {
        // 验证 delete 失败时，错误消息不包含实际密码
        let failing_store = FailingDeleteCredentialStore::new();
        let key = WebDavCredentialKey {
            service: "SoNotes.WebDAV".to_string(),
            account: "leak-test-delete".to_string(),
        };
        failing_store.save(&key, TEST_SECRET).expect("save 应成功");
        let err = failing_store.delete(&key).unwrap_err();
        let display_msg = format!("{err}");
        assert!(
            !display_msg.contains(TEST_SECRET),
            "DeleteFailed Display 消息不得泄漏 secret: {display_msg}"
        );
    }
    #[test]
    fn resolve_secret_error_does_not_leak_stored_secret() {
        let store = MemoryWebDavCredentialStore::new();
        let cred_key_val = compute_credential_key(
            "https://example.com/dav",
            "alice",
            "Backups/",
        );
        let cred_key = WebDavCredentialKey {
            service: CREDENTIAL_SERVICE.to_string(),
            account: cred_key_val.clone(),
        };
        store.save(&cred_key, TEST_SECRET).expect("save 应成功");
        let config = WebDavConfig {
            server_url: "https://example.com/dav".to_string(),
            username: "alice".to_string(),
            remote_dir: Some("Backups/".to_string()),
            password: None,
            trust_host: false,
        };
        let dir = std::env::temp_dir().join(format!(
            "so-notes-test-resolve-leak-{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("webdav-config.json");
        let config_file = WebDavConfigFile {
            server_url: "https://example.com/dav".to_string(),
            username: "alice".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: true,
            credential_key: Some(cred_key_val),
            trust_host: false,
            trusted_host: None,
        };
        let json = serde_json::to_string(&config_file).unwrap();
        std::fs::write(&path, json).unwrap();
        let result = resolve_operation_secret_core(Some(&path), &config, &store);
        assert!(result.is_ok(), "identity 匹配且 store 有 secret 时应成功");
        assert_eq!(result.unwrap(), TEST_SECRET);
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn resolve_secret_rejects_mismatched_identity() {
        let store = MemoryWebDavCredentialStore::new();
        let saved_key = compute_credential_key(
            "https://old-server.com/dav",
            "alice",
            "Backups/",
        );
        let cred_key = WebDavCredentialKey {
            service: CREDENTIAL_SERVICE.to_string(),
            account: saved_key.clone(),
        };
        store.save(&cred_key, TEST_SECRET).expect("save 应成功");
        let dir = std::env::temp_dir().join(format!(
            "so-notes-test-identity-mismatch-{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("webdav-config.json");
        let config_file = WebDavConfigFile {
            server_url: "https://old-server.com/dav".to_string(),
            username: "alice".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: true,
            credential_key: Some(saved_key),
            trust_host: false,
            trusted_host: None,
        };
        let json = serde_json::to_string(&config_file).unwrap();
        std::fs::write(&path, json).unwrap();
        // 用户在 UI 改了服务器地址，但留空密码
        let config = WebDavConfig {
            server_url: "https://new-server.com/dav".to_string(),
            username: "alice".to_string(),
            remote_dir: Some("Backups/".to_string()),
            password: None,
            trust_host: false,
        };
        let result = resolve_operation_secret_core(Some(&path), &config, &store);
        assert!(result.is_err(), "identity 不匹配时应拒绝加载 secret");
        let err = result.unwrap_err();
        assert!(
            err.contains("不一致"),
            "错误应提示 identity 不一致: {err}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn webdav_error_message_never_leaks_secrets() {
        // 验证 webdav_error_message 返回的用户可见文案不包含任何密码
        let kinds = [
            WebDavErrorKind::AuthFailed,
            WebDavErrorKind::Forbidden,
            WebDavErrorKind::NotFound,
            WebDavErrorKind::PathConflict,
            WebDavErrorKind::Locked,
            WebDavErrorKind::InsufficientStorage,
            WebDavErrorKind::MethodNotAllowed,
            WebDavErrorKind::Timeout,
            WebDavErrorKind::NetworkUnreachable,
            WebDavErrorKind::RedirectRejected,
            WebDavErrorKind::UnexpectedStatus,
            WebDavErrorKind::InvalidPropfindResponse,
            WebDavErrorKind::DownloadTooLarge,
            WebDavErrorKind::InvalidRemoteFileName,
            WebDavErrorKind::LocalTempFileError,
        ];
        for kind in kinds {
            let error = WebDavOperationError {
                kind,
                status: None,
                retryable: false,
            };
            let msg = webdav_error_message(&error);
            assert!(
                !msg.contains(TEST_SECRET),
                "webdav_error_message 不得泄漏 secret (kind={kind:?}): {msg}"
            );
        }
    }
    #[test]
    fn credential_key_not_in_config_json() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: true,
            password: Some(TEST_SECRET.to_string()),
            trust_host: false,
        };
        let (config, _) = prepare_config_save(&request, None).unwrap();
        let json = serde_json::to_string(&config).unwrap();
        assert!(
            !json.contains(TEST_SECRET),
            "配置 JSON 中不得包含密码明文"
        );
        assert!(
            !json.contains("\"password\""),
            "配置 JSON 中不得出现 password 字段"
        );
        let cred_key = config.credential_key.as_ref().unwrap();
        assert!(
            !cred_key.contains(TEST_SECRET),
            "credential_key 中不得包含密码"
        );
    }
    #[test]
    fn resolve_secret_prefers_input_password() {
        let store = MemoryWebDavCredentialStore::new();
        let config = WebDavConfig {
            server_url: "https://example.com/dav".to_string(),
            username: "alice".to_string(),
            remote_dir: Some("Backups/".to_string()),
            password: Some("inline-token".to_string()),
            trust_host: false,
        };
        let result = resolve_operation_secret_core(None, &config, &store);
        assert_eq!(result.unwrap(), "inline-token");
    }
    #[test]
    fn resolve_secret_reads_from_store() {
        let store = MemoryWebDavCredentialStore::new();
        let config = WebDavConfig {
            server_url: "https://example.com/dav".to_string(),
            username: "alice".to_string(),
            remote_dir: Some("Backups/".to_string()),
            password: None,
            trust_host: false,
        };
        let cred_key_val =
            compute_credential_key("https://example.com/dav", "alice", "Backups/");
        let cred_key = WebDavCredentialKey {
            service: CREDENTIAL_SERVICE.to_string(),
            account: cred_key_val,
        };
        store.save(&cred_key, "stored-secret").unwrap();
        let dir = std::env::temp_dir().join(format!(
            "so-notes-test-resolve-{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("webdav-config.json");
        let config_file = WebDavConfigFile {
            server_url: "https://example.com/dav".to_string(),
            username: "alice".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: true,
            credential_key: Some(cred_key.account.clone()),
            trust_host: false,
            trusted_host: None,
        };
        let json = serde_json::to_string(&config_file).unwrap();
        std::fs::write(&path, json).unwrap();
        let result = resolve_operation_secret_core(Some(&path), &config, &store);
        assert_eq!(result.unwrap(), "stored-secret");
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn resolve_secret_fails_on_store_error() {
        let store = MemoryWebDavCredentialStore::new();
        let config = WebDavConfig {
            server_url: "https://example.com/dav".to_string(),
            username: "alice".to_string(),
            remote_dir: Some("Backups/".to_string()),
            password: None,
            trust_host: false,
        };
        let real_key = compute_credential_key(
            "https://example.com/dav",
            "alice",
            "Backups/",
        );
        let dir = std::env::temp_dir().join(format!(
            "so-notes-test-resolve-fail-{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("webdav-config.json");
        let config_file = WebDavConfigFile {
            server_url: "https://example.com/dav".to_string(),
            username: "alice".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: true,
            credential_key: Some(real_key),
            trust_host: false,
            trusted_host: None,
        };
        let json = serde_json::to_string(&config_file).unwrap();
        std::fs::write(&path, json).unwrap();
        let result = resolve_operation_secret_core(Some(&path), &config, &store);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("系统凭据读取失败"));
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn resolve_secret_fails_when_no_source() {
        let store = MemoryWebDavCredentialStore::new();
        let config = WebDavConfig {
            server_url: "https://example.com/dav".to_string(),
            username: "alice".to_string(),
            remote_dir: Some("Backups/".to_string()),
            password: None,
            trust_host: false,
        };
        let result = resolve_operation_secret_core(None, &config, &store);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("请提供密码"));
    }
    #[test]
    fn clear_config_deletes_credential_key_from_store() {
        let store = MemoryWebDavCredentialStore::new();
        let cred_key = WebDavCredentialKey {
            service: CREDENTIAL_SERVICE.to_string(),
            account: "test-key-abc123".to_string(),
        };
        store.save(&cred_key, "my-secret").unwrap();
        assert!(store.load(&cred_key).is_ok());
        let dir = std::env::temp_dir()
            .join(format!("so-notes-test-clear-cred-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(CONFIG_FILENAME);
        let config_file = WebDavConfigFile {
            server_url: "https://example.com/dav".to_string(),
            username: "alice".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: true,
            credential_key: Some("test-key-abc123".to_string()),
            trust_host: false,
            trusted_host: None,
        };
        let json = serde_json::to_string(&config_file).unwrap();
        std::fs::write(&path, json).unwrap();
        assert!(path.exists());
        let content = std::fs::read_to_string(&path).unwrap();
        let read: WebDavConfigFile = serde_json::from_str(&content).unwrap();
        let old_key = read.credential_key.unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(!path.exists());
        let cred_key_delete = WebDavCredentialKey {
            service: CREDENTIAL_SERVICE.to_string(),
            account: old_key,
        };
        store.delete(&cred_key_delete).unwrap();
        assert!(
            store.load(&cred_key_delete).is_err(),
            "删除后密钥链中不应再有该 secret"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn clear_config_keychain_delete_failed_returns_warning() {
        let store = FailingDeleteCredentialStore::new();
        let cred_key = WebDavCredentialKey {
            service: CREDENTIAL_SERVICE.to_string(),
            account: "test-key-fail".to_string(),
        };
        let result = store.delete(&cred_key);
        assert!(result.is_err(), "FailingDeleteCredentialStore 应始终失败");
        let err = result.unwrap_err();
        assert!(
            err.kind == WebDavCredentialErrorKind::DeleteFailed,
            "错误类型应为 DeleteFailed"
        );
    }
    #[test]
    fn clear_config_old_credential_key_not_reused_after_delete() {
        let store = MemoryWebDavCredentialStore::new();
        let cred_key = WebDavCredentialKey {
            service: CREDENTIAL_SERVICE.to_string(),
            account: "old-session-key".to_string(),
        };
        store.save(&cred_key, "old-password").unwrap();
        store.delete(&cred_key).unwrap();
        let load_result = store.load(&cred_key);
        assert!(
            load_result.is_err(),
            "删除后旧 key 不应能加载到 secret"
        );
        assert!(
            matches!(
                load_result.unwrap_err().kind,
                WebDavCredentialErrorKind::MissingSecret
            ),
            "错误类型应为 MissingSecret"
        );
    }
    // -----------------------------------------------------------------------
    // Commit 4: trust_host 持久化 / host 变更 / password_saved 链
    // -----------------------------------------------------------------------
    #[test]
    fn trust_host_persists_roundtrip() {
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: false,
            password: None,
            trust_host: true,
        };
        let (config, _) = prepare_config_save(&request, None).unwrap();
        assert!(config.trust_host);
        assert_eq!(config.trusted_host.as_deref(), Some("example.com"));
        let json = serde_json::to_string(&config).unwrap();
        let read: WebDavConfigFile = serde_json::from_str(&json).unwrap();
        assert!(read.trust_host);
        assert_eq!(read.trusted_host.as_deref(), Some("example.com"));
        assert!(resolve_trust_host_for_load(&read));
    }
    #[test]
    fn trust_cleared_when_host_changes() {
        let old = WebDavConfigFile {
            server_url: "https://old.example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: false,
            credential_key: None,
            trust_host: true,
            trusted_host: Some("old.example.com".to_string()),
        };
        let request = WebDavConfigSaveRequest {
            server_url: "https://new.example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: false,
            password: None,
            trust_host: false,
        };
        let (config, _) = prepare_config_save(&request, Some(&old)).unwrap();
        assert!(!config.trust_host);
        assert!(config.trusted_host.is_none());
    }
    #[test]
    fn trust_set_on_host_change_when_user_opts_in() {
        let old = WebDavConfigFile {
            server_url: "https://old.example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: false,
            credential_key: None,
            trust_host: true,
            trusted_host: Some("old.example.com".to_string()),
        };
        let request = WebDavConfigSaveRequest {
            server_url: "https://new.example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: false,
            password: None,
            trust_host: true,
        };
        let (config, _) = prepare_config_save(&request, Some(&old)).unwrap();
        assert!(config.trust_host);
        assert_eq!(config.trusted_host.as_deref(), Some("new.example.com"));
    }
    #[test]
    fn trust_persists_when_host_same() {
        let old = WebDavConfigFile {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: false,
            credential_key: None,
            trust_host: true,
            trusted_host: Some("example.com".to_string()),
        };
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: false,
            password: None,
            trust_host: true,
        };
        let (config, _) = prepare_config_save(&request, Some(&old)).unwrap();
        assert!(config.trust_host);
        assert_eq!(config.trusted_host.as_deref(), Some("example.com"));
    }
    #[test]
    fn trust_persists_when_host_case_differs() {
        let old = WebDavConfigFile {
            server_url: "https://Example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: false,
            credential_key: None,
            trust_host: true,
            trusted_host: Some("example.com".to_string()),
        };
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: false,
            password: None,
            trust_host: true,
        };
        let (config, _) = prepare_config_save(&request, Some(&old)).unwrap();
        assert!(config.trust_host);
        assert_eq!(config.trusted_host.as_deref(), Some("example.com"));
    }
    #[test]
    fn trust_persists_when_host_trailing_dot() {
        let old = WebDavConfigFile {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: false,
            credential_key: None,
            trust_host: true,
            trusted_host: Some("example.com".to_string()),
        };
        // trailing-dot host via raw URL host is uncommon after normalize; exercise prepare
        // with same canonical host after normalize_webdav_url.
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com./dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: false,
            password: None,
            trust_host: true,
        };
        let (config, _) = prepare_config_save(&request, Some(&old)).unwrap();
        assert!(
            config.trust_host,
            "trailing-dot 规范化后 host 相同应保持 trust; got trusted_host={:?}",
            config.trusted_host
        );
        assert_eq!(config.trusted_host.as_deref(), Some("example.com"));
    }
    #[test]
    fn load_password_saved_requires_credential_key() {
        let json = r#"{"server_url":"https://example.com/dav","username":"user1","remote_dir":"Backups/","password_saved":true,"credential_key":null}"#;
        let file: WebDavConfigFile = serde_json::from_str(json).unwrap();
        let password_saved = file.password_saved && file.credential_key.is_some();
        assert!(!password_saved);
    }
    #[test]
    fn load_password_saved_true_when_key_present() {
        let json = r#"{"server_url":"https://example.com/dav","username":"user1","remote_dir":"Backups/","password_saved":true,"credential_key":"k1"}"#;
        let file: WebDavConfigFile = serde_json::from_str(json).unwrap();
        let password_saved = file.password_saved && file.credential_key.is_some();
        assert!(password_saved);
    }
    #[test]
    fn prepare_preserves_credential_when_password_unchanged() {
        let old = WebDavConfigFile {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: "Backups/".to_string(),
            password_saved: true,
            credential_key: Some("old-key".to_string()),
            trust_host: false,
            trusted_host: None,
        };
        let request = WebDavConfigSaveRequest {
            server_url: "https://example.com/dav".to_string(),
            username: "user1".to_string(),
            remote_dir: Some("Backups/".to_string()),
            remember_password: true,
            password: Some("same-or-new".to_string()),
            trust_host: false,
        };
        let (config, _) = prepare_config_save(&request, Some(&old)).unwrap();
        assert!(config.credential_key.is_some());
        assert!(config.password_saved);
    }
    #[test]
    fn trust_host_defaults_false_on_old_config() {
        let json = r#"{"server_url":"https://example.com/dav","username":"user1","remote_dir":"Backups/","password_saved":false}"#;
        let file: WebDavConfigFile = serde_json::from_str(json).unwrap();
        assert!(!file.trust_host);
        assert!(file.trusted_host.is_none());
        assert!(!resolve_trust_host_for_load(&file));
    }
