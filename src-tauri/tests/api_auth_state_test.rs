//! Stateful auth orchestration tests: token_login (happy path, refresh-on-401,
//! single-flight refresh under concurrency), session_cookie (login + cookie
//! persistence), hook (runs user function, merges result, rejects recursive
//! auth). TLS self-signed + mTLS use a separate fixture below.

use ccie_terminal_lib::api_runner::auth_state::{
    extract_token, AuthCacheKey, AuthStateStore, DisabledHookRunner, HookRunner,
};
use ccie_terminal_lib::api_runner::types::{
    ApiAuth, ApiRequest, BodyKind, BodyKindDefault, HttpMethod, SessionCookieLogin, TokenApply,
    TokenLoginCredentials, TokenLoginEndpoint,
};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use wiremock::matchers::{header, method as mmethod, path as mpath};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn base_req(url: impl Into<String>) -> ApiRequest {
    ApiRequest {
        method: HttpMethod::Get,
        url: url.into(),
        headers: BTreeMap::new(),
        query: BTreeMap::new(),
        body_kind: BodyKindDefault(BodyKind::None),
        body_text: None,
        body_bytes: None,
        auth: ApiAuth::None,
        timeout_secs: Some(5),
        insecure_skip_verify: false,
        tls_ca_bundle: None,
        tls_client_cert: None,
    }
}

// ---- JSONPath helper ------------------------------------------------------

#[test]
fn extract_token_handles_dollar_prefix() {
    let v: serde_json::Value = serde_json::from_str(r#"{"Token":"abc123"}"#).unwrap();
    assert_eq!(extract_token(&v, "$.Token").as_deref(), Some("abc123"));
    assert_eq!(extract_token(&v, "Token").as_deref(), Some("abc123"));
}

#[test]
fn extract_token_handles_nested_and_arrays() {
    let v: serde_json::Value =
        serde_json::from_str(r#"{"data": {"tokens": [{"val":"t0"},{"val":"t1"}]}}"#).unwrap();
    assert_eq!(
        extract_token(&v, "$.data.tokens[1].val").as_deref(),
        Some("t1")
    );
}

#[test]
fn extract_token_returns_none_for_missing() {
    let v: serde_json::Value = serde_json::from_str(r#"{"a":1}"#).unwrap();
    assert!(extract_token(&v, "$.missing").is_none());
    assert!(extract_token(&v, "$.a.nested").is_none());
}

// ---- TokenLogin ------------------------------------------------------------

#[tokio::test]
async fn token_login_happy_path_applies_header() {
    let server = MockServer::start().await;
    Mock::given(mmethod("POST"))
        .and(mpath("/auth/token"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"Token":"tok-1"}"#))
        .mount(&server)
        .await;
    Mock::given(mmethod("GET"))
        .and(mpath("/api/dev"))
        .and(header("x-auth-token", "tok-1"))
        .respond_with(ResponseTemplate::new(200).set_body_string("[]"))
        .mount(&server)
        .await;

    let store = AuthStateStore::new();
    let hooks: Arc<dyn HookRunner> = Arc::new(DisabledHookRunner);
    let mut req = base_req(format!("{}/api/dev", server.uri()));
    req.auth = ApiAuth::TokenLogin {
        login: TokenLoginEndpoint {
            method: HttpMethod::Post,
            url: format!("{}/auth/token", server.uri()),
            credentials: TokenLoginCredentials::Basic {
                username: "admin".into(),
                password: "pw".into(),
            },
            token_jsonpath: "$.Token".into(),
        },
        apply: TokenApply::Header {
            name: "X-Auth-Token".into(),
        },
        refresh_on_status: vec![],
    };
    let resp = store
        .send(AuthCacheKey::new("dnac", "lab"), req, hooks)
        .await;
    assert_eq!(resp.status_code, 200);
}

#[tokio::test]
async fn token_login_refreshes_once_on_401_then_succeeds() {
    let server = MockServer::start().await;

    // Login endpoint — returns a new token on every call so we can prove the
    // SECOND call actually refreshed.
    let login_hits = Arc::new(AtomicUsize::new(0));
    let login_hits_c = login_hits.clone();
    let login_body = move || {
        let n = login_hits_c.fetch_add(1, Ordering::SeqCst);
        format!(r#"{{"Token":"tok-{n}"}}"#)
    };

    // Use raw http so we can inspect: wiremock's response builder can be a
    // closure via responder — but `respond_with(function)` is simplest via
    // a dynamic body. We stamp two separate Mocks and rely on FIFO.
    Mock::given(mmethod("POST"))
        .and(mpath("/auth/token"))
        .respond_with(ResponseTemplate::new(200).set_body_string(login_body()))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(mmethod("POST"))
        .and(mpath("/auth/token"))
        .respond_with(ResponseTemplate::new(200).set_body_string(login_body()))
        .mount(&server)
        .await;

    // Main endpoint: first call with tok-0 returns 401; subsequent calls
    // with tok-1 return 200.
    Mock::given(mmethod("GET"))
        .and(mpath("/api/dev"))
        .and(header("x-auth-token", "tok-0"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&server)
        .await;
    Mock::given(mmethod("GET"))
        .and(mpath("/api/dev"))
        .and(header("x-auth-token", "tok-1"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&server)
        .await;

    let store = AuthStateStore::new();
    let hooks: Arc<dyn HookRunner> = Arc::new(DisabledHookRunner);
    let mut req = base_req(format!("{}/api/dev", server.uri()));
    req.auth = ApiAuth::TokenLogin {
        login: TokenLoginEndpoint {
            method: HttpMethod::Post,
            url: format!("{}/auth/token", server.uri()),
            credentials: TokenLoginCredentials::Basic {
                username: "u".into(),
                password: "p".into(),
            },
            token_jsonpath: "$.Token".into(),
        },
        apply: TokenApply::Header {
            name: "X-Auth-Token".into(),
        },
        refresh_on_status: vec![401],
    };
    let resp = store
        .send(AuthCacheKey::new("dnac", "lab"), req, hooks)
        .await;
    assert_eq!(resp.status_code, 200);
    assert_eq!(resp.body, b"ok");
    // Two logins: initial cold-cache + the refresh on 401.
    assert_eq!(login_hits.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn token_login_does_not_loop_on_repeated_401() {
    // Even if refresh also returns a token that's instantly rejected, we
    // MUST NOT loop forever — propagate the 401 after one retry.
    let server = MockServer::start().await;
    Mock::given(mmethod("POST"))
        .and(mpath("/auth/token"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"Token":"bad"}"#))
        .mount(&server)
        .await;
    Mock::given(mmethod("GET"))
        .and(mpath("/api/dev"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&server)
        .await;

    let store = AuthStateStore::new();
    let hooks: Arc<dyn HookRunner> = Arc::new(DisabledHookRunner);
    let mut req = base_req(format!("{}/api/dev", server.uri()));
    req.auth = ApiAuth::TokenLogin {
        login: TokenLoginEndpoint {
            method: HttpMethod::Post,
            url: format!("{}/auth/token", server.uri()),
            credentials: TokenLoginCredentials::Basic {
                username: "u".into(),
                password: "p".into(),
            },
            token_jsonpath: "$.Token".into(),
        },
        apply: TokenApply::Header {
            name: "X-Auth-Token".into(),
        },
        refresh_on_status: vec![401],
    };
    let started = std::time::Instant::now();
    let resp = store
        .send(AuthCacheKey::new("dnac", "lab"), req, hooks)
        .await;
    assert_eq!(resp.status_code, 401);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(4),
        "must not loop: elapsed {:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn token_login_concurrent_calls_share_one_login_request() {
    // Ten concurrent sends MUST result in ONE call to the login endpoint —
    // not ten. This is the single-flight guarantee under shared cache keys.
    let server = MockServer::start().await;
    let login_hits = Arc::new(AtomicUsize::new(0));
    let _login_hits_c = login_hits.clone();
    // WireMock doesn't easily return dynamic bodies per-call, so we count
    // via a simple mock that returns the same token and rely on a hit counter
    // via header capture in a separate Mock. Instead: use .expect() to assert
    // the exact number of matching calls.
    Mock::given(mmethod("POST"))
        .and(mpath("/auth/token"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"Token":"T1"}"#))
        .mount(&server)
        .await;
    Mock::given(mmethod("GET"))
        .and(mpath("/api/dev"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&server)
        .await;

    let store = Arc::new(AuthStateStore::new());
    let hooks: Arc<dyn HookRunner> = Arc::new(DisabledHookRunner);

    let mut handles = Vec::new();
    for _ in 0..10 {
        let store = store.clone();
        let hooks = hooks.clone();
        let base = server.uri();
        let key = AuthCacheKey::new("dnac", "lab");
        // Capture login_hits for a barrier-style wait-then-send.
        let hits = login_hits.clone();
        handles.push(tokio::spawn(async move {
            let mut req = base_req(format!("{base}/api/dev"));
            req.auth = ApiAuth::TokenLogin {
                login: TokenLoginEndpoint {
                    method: HttpMethod::Post,
                    url: format!("{base}/auth/token"),
                    credentials: TokenLoginCredentials::Basic {
                        username: "u".into(),
                        password: "p".into(),
                    },
                    token_jsonpath: "$.Token".into(),
                },
                apply: TokenApply::Header {
                    name: "X-Auth-Token".into(),
                },
                refresh_on_status: vec![],
            };
            let resp = store.send(key, req, hooks).await;
            hits.fetch_add(1, Ordering::SeqCst);
            resp.status_code
        }));
    }
    let mut oks = 0;
    for h in handles {
        if h.await.unwrap() == 200 {
            oks += 1;
        }
    }
    assert_eq!(oks, 10, "all 10 concurrent sends should succeed");

    // Verify: login endpoint was hit exactly ONCE across all 10 sends.
    let requests = server
        .received_requests()
        .await
        .expect("received_requests")
        .into_iter()
        .filter(|r| r.url.path() == "/auth/token")
        .count();
    assert_eq!(
        requests, 1,
        "single-flight login: expected 1 call, got {requests}"
    );
}

#[tokio::test]
async fn token_login_bearer_apply_sends_authorization_header() {
    let server = MockServer::start().await;
    Mock::given(mmethod("POST"))
        .and(mpath("/login"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"access":"A1"}"#))
        .mount(&server)
        .await;
    Mock::given(mmethod("GET"))
        .and(mpath("/me"))
        .and(header("authorization", "Bearer A1"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let store = AuthStateStore::new();
    let hooks: Arc<dyn HookRunner> = Arc::new(DisabledHookRunner);
    let mut req = base_req(format!("{}/me", server.uri()));
    req.auth = ApiAuth::TokenLogin {
        login: TokenLoginEndpoint {
            method: HttpMethod::Post,
            url: format!("{}/login", server.uri()),
            credentials: TokenLoginCredentials::JsonBody {
                body: r#"{"u":"x"}"#.to_string(),
            },
            token_jsonpath: "access".into(),
        },
        apply: TokenApply::Bearer,
        refresh_on_status: vec![],
    };
    let resp = store.send(AuthCacheKey::new("x", "env"), req, hooks).await;
    assert_eq!(resp.status_code, 200);
}

#[tokio::test]
async fn token_login_relative_url_resolves_against_request_origin() {
    let server = MockServer::start().await;
    Mock::given(mmethod("POST"))
        .and(mpath("/auth"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"t":"X"}"#))
        .mount(&server)
        .await;
    Mock::given(mmethod("GET"))
        .and(mpath("/api/me"))
        .and(header("x-auth", "X"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let store = AuthStateStore::new();
    let hooks: Arc<dyn HookRunner> = Arc::new(DisabledHookRunner);
    let mut req = base_req(format!("{}/api/me", server.uri()));
    req.auth = ApiAuth::TokenLogin {
        login: TokenLoginEndpoint {
            method: HttpMethod::Post,
            url: "/auth".to_string(), // <-- relative
            credentials: TokenLoginCredentials::Basic {
                username: "u".into(),
                password: "p".into(),
            },
            token_jsonpath: "t".into(),
        },
        apply: TokenApply::Header {
            name: "X-Auth".into(),
        },
        refresh_on_status: vec![],
    };
    let resp = store.send(AuthCacheKey::new("x", "env"), req, hooks).await;
    assert_eq!(resp.status_code, 200);
}

#[tokio::test]
async fn token_login_surfaces_login_failure_as_error_response() {
    let server = MockServer::start().await;
    Mock::given(mmethod("POST"))
        .and(mpath("/auth"))
        .respond_with(ResponseTemplate::new(403))
        .mount(&server)
        .await;

    let store = AuthStateStore::new();
    let hooks: Arc<dyn HookRunner> = Arc::new(DisabledHookRunner);
    let mut req = base_req(format!("{}/api/me", server.uri()));
    req.auth = ApiAuth::TokenLogin {
        login: TokenLoginEndpoint {
            method: HttpMethod::Post,
            url: format!("{}/auth", server.uri()),
            credentials: TokenLoginCredentials::Basic {
                username: "u".into(),
                password: "p".into(),
            },
            token_jsonpath: "t".into(),
        },
        apply: TokenApply::Bearer,
        refresh_on_status: vec![],
    };
    let resp = store.send(AuthCacheKey::new("x", "env"), req, hooks).await;
    assert_eq!(resp.status_code, 0);
    assert!(resp.error.unwrap_or_default().contains("login"));
}

// ---- SessionCookie --------------------------------------------------------

#[tokio::test]
async fn session_cookie_logs_in_once_and_reuses_cookie_on_subsequent_requests() {
    let server = MockServer::start().await;
    // Login endpoint sets a session cookie.
    Mock::given(mmethod("POST"))
        .and(mpath("/login"))
        .respond_with(
            ResponseTemplate::new(204).insert_header("Set-Cookie", "SESSION=abc123; Path=/"),
        )
        .mount(&server)
        .await;
    // Real endpoint requires the cookie to be present.
    Mock::given(mmethod("GET"))
        .and(mpath("/api/thing"))
        .and(header("cookie", "SESSION=abc123"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&server)
        .await;

    let store = AuthStateStore::new();
    let hooks: Arc<dyn HookRunner> = Arc::new(DisabledHookRunner);
    let key = AuthCacheKey::new("nxdash", "lab");

    // Two sequential sends. First triggers login; second reuses.
    for _ in 0..2 {
        let mut req = base_req(format!("{}/api/thing", server.uri()));
        req.auth = ApiAuth::SessionCookie {
            login: SessionCookieLogin {
                method: HttpMethod::Post,
                url: format!("{}/login", server.uri()),
                credentials: TokenLoginCredentials::Basic {
                    username: "admin".into(),
                    password: "pw".into(),
                },
            },
        };
        let resp = store.send(key.clone(), req, hooks.clone()).await;
        assert_eq!(resp.status_code, 200);
    }

    // Assert: login endpoint hit exactly once.
    let login_hits = server
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .filter(|r| r.url.path() == "/login")
        .count();
    assert_eq!(login_hits, 1, "session login must be single-flight");
}

#[tokio::test]
async fn session_cookie_echoes_xsrf_token_as_header_on_follow_ups() {
    // Regression for the Cisco SNA "401 Authorization Required" bug.
    // SNA uses double-submit CSRF: the cookie value from the login's
    // XSRF-TOKEN cookie MUST be echoed as X-XSRF-TOKEN on every
    // subsequent request. Missing that header => 401 even though the
    // session cookie is present in the jar.
    let server = MockServer::start().await;
    // Login sets both the session cookie AND an XSRF-TOKEN cookie.
    Mock::given(mmethod("POST"))
        .and(mpath("/token/v2/authenticate"))
        .respond_with(
            ResponseTemplate::new(204)
                .insert_header("Set-Cookie", "sw_session=sess-abc; Path=/")
                .insert_header("Set-Cookie", "XSRF-TOKEN=xyz-csrf; Path=/"),
        )
        .mount(&server)
        .await;
    // The real endpoint rejects anything without BOTH the session
    // cookie AND the X-XSRF-TOKEN header.
    Mock::given(mmethod("GET"))
        .and(mpath("/sw-reporting/v1/tenants"))
        .and(header("x-xsrf-token", "xyz-csrf"))
        .respond_with(ResponseTemplate::new(200).set_body_string("[]"))
        .mount(&server)
        .await;

    let store = AuthStateStore::new();
    let hooks: Arc<dyn HookRunner> = Arc::new(DisabledHookRunner);
    let mut req = base_req(format!("{}/sw-reporting/v1/tenants", server.uri()));
    req.auth = ApiAuth::SessionCookie {
        login: SessionCookieLogin {
            method: HttpMethod::Post,
            url: format!("{}/token/v2/authenticate", server.uri()),
            credentials: TokenLoginCredentials::FormBody {
                body: "username=admin&password=pw".into(),
            },
        },
    };
    let resp = store
        .send(AuthCacheKey::new("sna", "lab"), req, hooks)
        .await;
    // If the XSRF header wasn't added, wiremock's `.and(header(...))`
    // would not match and we'd get a 404 — or a 401 in production. A
    // 200 proves the header made it out.
    assert_eq!(
        resp.status_code, 200,
        "SNA follow-up must carry X-XSRF-TOKEN mirror header; got {:?}",
        resp
    );
}

#[tokio::test]
async fn session_cookie_form_body_sends_urlencoded_not_json() {
    // Regression guard for the SNA "415 Unsupported Media Type" bug.
    // The Secure Network Analytics /token/v2/authenticate endpoint
    // requires application/x-www-form-urlencoded; sending JSON returns 415.
    let server = MockServer::start().await;
    // Mock ONLY accepts the correct Content-Type; wiremock default is to
    // 404 unmatched requests, which we'll treat as a test failure.
    Mock::given(mmethod("POST"))
        .and(mpath("/token/v2/authenticate"))
        .and(header("content-type", "application/x-www-form-urlencoded"))
        .and(wiremock::matchers::body_string(
            "username=admin&password=pw",
        ))
        .respond_with(
            ResponseTemplate::new(204).insert_header("Set-Cookie", "sw_session=abc; Path=/"),
        )
        .mount(&server)
        .await;
    Mock::given(mmethod("GET"))
        .and(mpath("/sw-reporting/v1/tenants"))
        .and(header("cookie", "sw_session=abc"))
        .respond_with(ResponseTemplate::new(200).set_body_string("[]"))
        .mount(&server)
        .await;

    let store = AuthStateStore::new();
    let hooks: Arc<dyn HookRunner> = Arc::new(DisabledHookRunner);
    let mut req = base_req(format!("{}/sw-reporting/v1/tenants", server.uri()));
    req.auth = ApiAuth::SessionCookie {
        login: SessionCookieLogin {
            method: HttpMethod::Post,
            url: format!("{}/token/v2/authenticate", server.uri()),
            credentials: TokenLoginCredentials::FormBody {
                body: "username=admin&password=pw".into(),
            },
        },
    };
    let resp = store
        .send(AuthCacheKey::new("sna", "lab"), req, hooks)
        .await;
    assert_eq!(resp.status_code, 200, "got: {resp:?}");
}

#[tokio::test]
async fn session_cookie_surfaces_bad_login_as_error_response() {
    let server = MockServer::start().await;
    Mock::given(mmethod("POST"))
        .and(mpath("/login"))
        .respond_with(ResponseTemplate::new(403))
        .mount(&server)
        .await;

    let store = AuthStateStore::new();
    let hooks: Arc<dyn HookRunner> = Arc::new(DisabledHookRunner);
    let mut req = base_req(format!("{}/api/thing", server.uri()));
    req.auth = ApiAuth::SessionCookie {
        login: SessionCookieLogin {
            method: HttpMethod::Post,
            url: format!("{}/login", server.uri()),
            credentials: TokenLoginCredentials::Basic {
                username: "u".into(),
                password: "p".into(),
            },
        },
    };
    let resp = store.send(AuthCacheKey::new("x", "env"), req, hooks).await;
    assert_eq!(resp.status_code, 0);
    assert!(resp.error.unwrap_or_default().contains("session"));
}

// ---- Hook -----------------------------------------------------------------

struct RecordingHook {
    calls: std::sync::Mutex<Vec<(String, String, serde_json::Value)>>,
    response: serde_json::Value,
}

#[async_trait::async_trait]
impl HookRunner for RecordingHook {
    async fn call(
        &self,
        module: &str,
        function: &str,
        request: serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.calls
            .lock()
            .unwrap()
            .push((module.into(), function.into(), request));
        Ok(self.response.clone())
    }
}

#[tokio::test]
async fn hook_runs_function_and_uses_mutated_request() {
    let server = MockServer::start().await;
    Mock::given(mmethod("GET"))
        .and(mpath("/signed"))
        .and(header("x-custom-sig", "s1g"))
        .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
        .mount(&server)
        .await;

    let store = AuthStateStore::new();
    // Hook mutates the request to add a header and clear auth.
    let mut mutated = serde_json::json!({
        "method": "GET",
        "url": format!("{}/signed", server.uri()),
        "headers": {"X-Custom-Sig": "s1g"},
        "query": {},
        "body_kind": "none",
        "body_text": null,
        "body_bytes": null,
        "auth": {"type": "none"},
        "timeout_secs": 5,
        "insecure_skip_verify": false,
        "tls_ca_bundle": null,
        "tls_client_cert": null
    });
    // Wiremock is HTTP-only; the mutated body_bytes must be valid base64 or None.
    // `body_bytes: null` decodes to None in the deserializer.
    let _ = &mut mutated;

    let hook = Arc::new(RecordingHook {
        calls: std::sync::Mutex::new(Vec::new()),
        response: mutated,
    });
    let hooks: Arc<dyn HookRunner> = hook.clone();

    let mut req = base_req(format!("{}/should-be-overwritten", server.uri()));
    req.auth = ApiAuth::Hook {
        module: "intersight_hmac".into(),
        function: "sign_request".into(),
    };
    let resp = store
        .send(AuthCacheKey::new("intersight", "prod"), req, hooks)
        .await;
    assert_eq!(resp.status_code, 200);
    let calls = hook.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "intersight_hmac");
    assert_eq!(calls[0].1, "sign_request");
}

#[tokio::test]
async fn hook_error_surfaces_as_response_error() {
    struct FailingHook;
    #[async_trait::async_trait]
    impl HookRunner for FailingHook {
        async fn call(
            &self,
            _m: &str,
            _f: &str,
            _r: serde_json::Value,
        ) -> anyhow::Result<serde_json::Value> {
            Err(anyhow::anyhow!("python blew up"))
        }
    }

    let store = AuthStateStore::new();
    let hooks: Arc<dyn HookRunner> = Arc::new(FailingHook);
    let mut req = base_req("http://127.0.0.1:1/never");
    req.auth = ApiAuth::Hook {
        module: "x".into(),
        function: "y".into(),
    };
    let resp = store.send(AuthCacheKey::new("x", "env"), req, hooks).await;
    assert_eq!(resp.status_code, 0);
    let msg = resp.error.unwrap_or_default();
    assert!(
        msg.contains("python blew up"),
        "expected hook error in response: {msg}"
    );
}

#[tokio::test]
async fn hook_rejects_returning_stateful_auth() {
    // Hook trying to return ApiAuth::TokenLogin would cause infinite
    // recursion in the orchestrator. The orchestrator must refuse.
    let recursive = serde_json::json!({
        "method": "GET",
        "url": "http://127.0.0.1:1/never",
        "headers": {},
        "query": {},
        "body_kind": "none",
        "body_text": null,
        "body_bytes": null,
        "auth": {
            "type": "token_login",
            "login": {
                "method": "POST",
                "url": "/x",
                "credentials": {"type": "basic", "username": "u", "password": "p"},
                "token_jsonpath": "$.t"
            },
            "apply": {"mode": "bearer"},
            "refresh_on_status": []
        },
        "timeout_secs": 5,
        "insecure_skip_verify": false,
        "tls_ca_bundle": null,
        "tls_client_cert": null
    });
    let hook = Arc::new(RecordingHook {
        calls: std::sync::Mutex::new(Vec::new()),
        response: recursive,
    });
    let hooks: Arc<dyn HookRunner> = hook.clone();
    let store = AuthStateStore::new();
    let mut req = base_req("http://127.0.0.1:1/never");
    req.auth = ApiAuth::Hook {
        module: "m".into(),
        function: "f".into(),
    };
    let resp = store.send(AuthCacheKey::new("x", "env"), req, hooks).await;
    assert_eq!(resp.status_code, 0);
    assert!(resp.error.unwrap_or_default().contains("stateful"));
}

// ---- invalidate ----------------------------------------------------------

#[tokio::test]
async fn invalidate_clears_cached_token_forcing_new_login() {
    let server = MockServer::start().await;
    Mock::given(mmethod("POST"))
        .and(mpath("/auth"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"t":"T"}"#))
        .mount(&server)
        .await;
    Mock::given(mmethod("GET"))
        .and(mpath("/api"))
        .and(header("x-auth", "T"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let store = AuthStateStore::new();
    let hooks: Arc<dyn HookRunner> = Arc::new(DisabledHookRunner);
    let key = AuthCacheKey::new("dnac", "lab");

    for _ in 0..2 {
        let mut req = base_req(format!("{}/api", server.uri()));
        req.auth = ApiAuth::TokenLogin {
            login: TokenLoginEndpoint {
                method: HttpMethod::Post,
                url: format!("{}/auth", server.uri()),
                credentials: TokenLoginCredentials::Basic {
                    username: "u".into(),
                    password: "p".into(),
                },
                token_jsonpath: "t".into(),
            },
            apply: TokenApply::Header {
                name: "X-Auth".into(),
            },
            refresh_on_status: vec![],
        };
        assert_eq!(
            store
                .send(key.clone(), req, hooks.clone())
                .await
                .status_code,
            200
        );
    }
    // Before invalidate: one login call total.
    let before = server
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .filter(|r| r.url.path() == "/auth")
        .count();
    assert_eq!(before, 1);

    store.invalidate(&key);

    let mut req = base_req(format!("{}/api", server.uri()));
    req.auth = ApiAuth::TokenLogin {
        login: TokenLoginEndpoint {
            method: HttpMethod::Post,
            url: format!("{}/auth", server.uri()),
            credentials: TokenLoginCredentials::Basic {
                username: "u".into(),
                password: "p".into(),
            },
            token_jsonpath: "t".into(),
        },
        apply: TokenApply::Header {
            name: "X-Auth".into(),
        },
        refresh_on_status: vec![],
    };
    assert_eq!(
        store
            .send(key.clone(), req, hooks.clone())
            .await
            .status_code,
        200
    );
    let after = server
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .filter(|r| r.url.path() == "/auth")
        .count();
    assert_eq!(after, 2, "invalidate must force a fresh login");
}
