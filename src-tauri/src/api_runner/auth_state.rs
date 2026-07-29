//! Stateful auth orchestration — the wrapper that sits in front of the
//! stateless [`super::executor::execute_request`].
//!
//! Handles the three flavors that `auth.rs` bails on:
//!
//! * **`TokenLogin`** — POST creds to a login URL, extract a token from the
//!   JSON response, cache it keyed by `(target_id, env)`, attach to every
//!   subsequent call, and refresh-once on a configurable set of status
//!   codes (default `[401]`). Concurrent sends sharing a cache key serialize
//!   through a single `tokio::sync::Mutex` so we never fire N parallel
//!   refreshes.
//! * **`SessionCookie`** — build a `reqwest::Client` with a cookie jar and
//!   perform a login call once, then reuse the same client for the real
//!   request(s). Client cached per cache key.
//! * **`Hook`** — hand the request off to a Python function in the sidecar
//!   (`~/.ccie-terminal/api-hooks/<module>.py`). The hook returns a mutated
//!   request dict; we merge its headers back and send as plain HTTP.
//!
//! Stateless variants (`None`, `Header`, `Basic`, `Bearer`) pass straight
//! through to the executor with no state touched.

use super::executor::execute_request;
use super::types::{
    ApiAuth, ApiRequest, ApiResponse, SessionCookieLogin, TokenApply, TokenLoginCredentials,
    TokenLoginEndpoint,
};
use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex as SyncMutex;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;

/// Key used to cache tokens / cookie-jar clients. One slot per
/// `(target_id, environment)` pair. `target_id` may be empty for "custom"
/// tabs — that means the cache is per-environment only.
#[derive(Debug, Clone, Hash, Eq, PartialEq)]
pub struct AuthCacheKey {
    pub target_id: String,
    pub environment: String,
}

impl AuthCacheKey {
    pub fn new(target: impl Into<String>, env: impl Into<String>) -> Self {
        Self {
            target_id: target.into(),
            environment: env.into(),
        }
    }
}

/// Process-wide orchestrator. Held inside `AppState` so every Tauri
/// command sees the same cache.
#[derive(Default)]
pub struct AuthStateStore {
    /// Cached tokens from `TokenLogin`. `AsyncMutex<Option<String>>` so
    /// concurrent senders under the same key serialize through one refresh
    /// instead of N.
    tokens: SyncMutex<HashMap<AuthCacheKey, Arc<AsyncMutex<Option<String>>>>>,

    /// Cached cookie-jar-backed `reqwest::Client` plus the optional
    /// CSRF double-submit token value (e.g. Cisco SNA's
    /// `XSRF-TOKEN` cookie, which must be mirrored into the
    /// `X-XSRF-TOKEN` header on every subsequent request).
    sessions: SyncMutex<HashMap<AuthCacheKey, Arc<AsyncMutex<Option<SessionClient>>>>>,
}

/// What a session-cookie auth cache entry holds.
#[derive(Clone)]
struct SessionClient {
    client: reqwest::Client,
    /// Some SNA/Cisco appliances also require the CSRF cookie's value
    /// to be echoed in an `X-XSRF-TOKEN` header on each follow-up call.
    /// `None` for appliances that don't use double-submit CSRF.
    xsrf_token: Option<String>,
}

impl AuthStateStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Public entry point. Executes one request honoring whatever auth
    /// strategy is on it. Identical return shape to
    /// [`super::executor::execute_request`] so callers can swap them.
    pub async fn send(
        &self,
        key: AuthCacheKey,
        mut request: ApiRequest,
        hooks: Arc<dyn HookRunner>,
    ) -> ApiResponse {
        // Extract the stateful auth (if any) so we don't pass it into the
        // stateless executor — which would bail.
        let auth = std::mem::replace(&mut request.auth, ApiAuth::None);

        match auth {
            // Stateless variants go straight through unchanged.
            ApiAuth::None | ApiAuth::Header { .. } | ApiAuth::Basic { .. } | ApiAuth::Bearer { .. } => {
                request.auth = auth;
                execute_request(request).await
            }
            ApiAuth::TokenLogin {
                login,
                apply,
                refresh_on_status,
            } => {
                let statuses: Vec<u16> = if refresh_on_status.is_empty() {
                    vec![401]
                } else {
                    refresh_on_status
                };
                self.send_token_login(key, request, login, apply, statuses).await
            }
            ApiAuth::SessionCookie { login } => {
                self.send_session_cookie(key, request, login).await
            }
            ApiAuth::Hook { module, function } => {
                self.send_hook(request, module, function, hooks).await
            }
        }
    }

    // ---- TokenLogin ----------------------------------------------------

    async fn send_token_login(
        &self,
        key: AuthCacheKey,
        request: ApiRequest,
        login: TokenLoginEndpoint,
        apply: TokenApply,
        refresh_on_status: Vec<u16>,
    ) -> ApiResponse {
        let slot = self.token_slot(&key);

        // Fast path: we already have a cached token. Try once with it.
        let mut token = {
            let guard = slot.lock().await;
            guard.clone()
        };
        if token.is_none() {
            // Cold cache: take the slot lock for the full login so parallel
            // senders share ONE login call.
            let mut guard = slot.lock().await;
            if guard.is_none() {
                match run_token_login(&request, &login).await {
                    Ok(t) => *guard = Some(t.clone()),
                    Err(err) => {
                        return error_response(&request, format!("token_login failed: {err}"));
                    }
                }
            }
            token = guard.clone();
        }

        let Some(t) = token else {
            return error_response(&request, "token_login returned empty token".into());
        };
        let first = execute_with_token(&request, &apply, &t).await;
        if !refresh_on_status.contains(&first.status_code) {
            return first;
        }

        // Refresh under the slot lock — serializing ensures only ONE refresh
        // happens even if 10 concurrent calls saw a 401 simultaneously.
        let mut guard = slot.lock().await;
        // Peek: if another task already refreshed while we waited, reuse it.
        if guard.as_deref() == Some(t.as_str()) {
            match run_token_login(&request, &login).await {
                Ok(new_token) => *guard = Some(new_token),
                Err(err) => {
                    return error_response(
                        &request,
                        format!("token refresh failed: {err}"),
                    );
                }
            }
        }
        let refreshed = guard.clone();
        drop(guard);

        let Some(new_t) = refreshed else {
            return first;
        };
        execute_with_token(&request, &apply, &new_t).await
    }

    fn token_slot(&self, key: &AuthCacheKey) -> Arc<AsyncMutex<Option<String>>> {
        let mut map = self.tokens.lock();
        map.entry(key.clone())
            .or_insert_with(|| Arc::new(AsyncMutex::new(None)))
            .clone()
    }

    // ---- SessionCookie -------------------------------------------------

    async fn send_session_cookie(
        &self,
        key: AuthCacheKey,
        request: ApiRequest,
        login: SessionCookieLogin,
    ) -> ApiResponse {
        let slot = self.session_slot(&key);
        let mut guard = slot.lock().await;
        if guard.is_none() {
            match build_session_client(&request, &login).await {
                Ok(c) => *guard = Some(c),
                Err(err) => {
                    return error_response(
                        &request,
                        format!("session login failed: {err}"),
                    );
                }
            }
        }
        let session = guard.as_ref().cloned();
        drop(guard);
        let Some(session) = session else {
            return error_response(&request, "session client missing".into());
        };
        send_with_client(&session, &request).await
    }

    fn session_slot(&self, key: &AuthCacheKey) -> Arc<AsyncMutex<Option<SessionClient>>> {
        let mut map = self.sessions.lock();
        map.entry(key.clone())
            .or_insert_with(|| Arc::new(AsyncMutex::new(None)))
            .clone()
    }

    /// Test / admin entrypoint: forget any cached auth for a key. Used by
    /// the UI's "Test Connection" and "Log Out" buttons in later steps.
    pub fn invalidate(&self, key: &AuthCacheKey) {
        self.tokens.lock().remove(key);
        self.sessions.lock().remove(key);
    }

    // ---- Hook ----------------------------------------------------------

    async fn send_hook(
        &self,
        request: ApiRequest,
        module: String,
        function: String,
        hooks: Arc<dyn HookRunner>,
    ) -> ApiResponse {
        let req_json = match serde_json::to_value(&request) {
            Ok(v) => v,
            Err(err) => {
                return error_response(&request, format!("serialize request: {err}"));
            }
        };
        let mutated = match hooks.call(&module, &function, req_json).await {
            Ok(v) => v,
            Err(err) => {
                return error_response(&request, format!("hook error: {err}"));
            }
        };
        let mutated_request: ApiRequest = match serde_json::from_value(mutated) {
            Ok(r) => r,
            Err(err) => {
                return error_response(&request, format!("hook returned invalid request: {err}"));
            }
        };
        // Hook MUST leave auth set to something stateless (or None) —
        // otherwise we'd recurse.
        if matches!(
            mutated_request.auth,
            ApiAuth::TokenLogin { .. } | ApiAuth::SessionCookie { .. } | ApiAuth::Hook { .. }
        ) {
            return error_response(
                &mutated_request,
                "hook cannot return a stateful auth type".into(),
            );
        }
        execute_request(mutated_request).await
    }
}

// ---- Helpers ---------------------------------------------------------------

async fn run_token_login(req: &ApiRequest, login: &TokenLoginEndpoint) -> Result<String> {
    use crate::api_runner::types::{BodyKind, BodyKindDefault, HttpMethod as Hm};
    let mut login_req = ApiRequest {
        method: login.method,
        url: resolve_login_url(&req.url, &login.url)?,
        headers: std::collections::BTreeMap::new(),
        query: std::collections::BTreeMap::new(),
        body_kind: BodyKindDefault(BodyKind::None),
        body_text: None,
        body_bytes: None,
        auth: ApiAuth::None,
        timeout_secs: req.timeout_secs,
        insecure_skip_verify: req.insecure_skip_verify,
        tls_ca_bundle: req.tls_ca_bundle.clone(),
        tls_client_cert: req.tls_client_cert.clone(),
    };
    match &login.credentials {
        TokenLoginCredentials::Basic { username, password } => {
            login_req.auth = ApiAuth::Basic {
                username: username.clone(),
                password: password.clone(),
            };
        }
        TokenLoginCredentials::JsonBody { body } => {
            login_req.body_kind = BodyKindDefault(BodyKind::Json);
            login_req.body_text = Some(body.clone());
            // Default method for JSON body is POST if the user left GET.
            if matches!(login_req.method, Hm::Get) {
                login_req.method = Hm::Post;
            }
        }
        TokenLoginCredentials::FormBody { body } => {
            // application/x-www-form-urlencoded (SNA, legacy appliances).
            login_req.body_kind = BodyKindDefault(BodyKind::Form);
            login_req.body_text = Some(body.clone());
            if matches!(login_req.method, Hm::Get) {
                login_req.method = Hm::Post;
            }
        }
    }
    let resp = execute_request(login_req).await;
    if resp.status_code == 0 {
        return Err(anyhow!(
            "login request failed: {}",
            resp.error.unwrap_or_else(|| "unknown".to_string())
        ));
    }
    if !(200..300).contains(&resp.status_code) {
        return Err(anyhow!(
            "login returned status {} {}",
            resp.status_code,
            resp.status_text
        ));
    }
    let body_str = std::str::from_utf8(&resp.body)
        .context("login response is not UTF-8")?;
    let json: serde_json::Value =
        serde_json::from_str(body_str).context("login response is not JSON")?;
    let token = extract_token(&json, &login.token_jsonpath)
        .ok_or_else(|| anyhow!("token not found at {}", login.token_jsonpath))?;
    Ok(token)
}

/// Very small JSONPath-ish accessor. Supports:
///   * `$.foo.bar` (common Cisco flavor)
///   * `foo.bar`   (dotted shorthand)
///   * `$.foo[0].bar` (array index)
pub fn extract_token(json: &serde_json::Value, path: &str) -> Option<String> {
    let trimmed = path.trim_start_matches('$').trim_start_matches('.');
    let mut cur = json;
    for segment in trimmed.split('.') {
        if segment.is_empty() {
            continue;
        }
        // Support foo[0]
        let (name, idx) = if let Some(open) = segment.find('[') {
            let close = segment.find(']')?;
            let idx_str = &segment[open + 1..close];
            let idx = idx_str.parse::<usize>().ok()?;
            (&segment[..open], Some(idx))
        } else {
            (segment, None)
        };
        cur = if name.is_empty() {
            cur
        } else {
            cur.get(name)?
        };
        if let Some(i) = idx {
            cur = cur.get(i)?;
        }
    }
    match cur {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// If the login URL is relative (no scheme), resolve against the request's
/// base URL origin. Absolute URLs pass through untouched.
fn resolve_login_url(request_url: &str, login_url: &str) -> Result<String> {
    if login_url.starts_with("http://") || login_url.starts_with("https://") {
        return Ok(login_url.to_string());
    }
    let parsed = reqwest::Url::parse(request_url)
        .with_context(|| format!("parse request URL {request_url}"))?;
    let origin = format!(
        "{}://{}{}",
        parsed.scheme(),
        parsed
            .host_str()
            .ok_or_else(|| anyhow!("request URL missing host"))?,
        match parsed.port() {
            Some(p) => format!(":{p}"),
            None => String::new(),
        }
    );
    if login_url.starts_with('/') {
        Ok(format!("{origin}{login_url}"))
    } else {
        Ok(format!("{origin}/{login_url}"))
    }
}

async fn execute_with_token(
    request: &ApiRequest,
    apply: &TokenApply,
    token: &str,
) -> ApiResponse {
    let mut req = request.clone();
    // Apply the token as the auth strategy — then hand off to execute_request
    // which will convert it into the concrete header via auth::apply_auth.
    req.auth = match apply {
        TokenApply::Header { name } => ApiAuth::Header {
            name: name.clone(),
            value: token.to_string(),
        },
        TokenApply::Bearer => ApiAuth::Bearer {
            token: token.to_string(),
        },
    };
    execute_request(req).await
}

async fn build_session_client(
    req: &ApiRequest,
    login: &SessionCookieLogin,
) -> Result<SessionClient> {
    use crate::api_runner::types::DEFAULT_TIMEOUT_SECS;
    let timeout = std::time::Duration::from_secs(
        req.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS),
    );
    let client = super::executor::build_client_with(req, timeout, true)?;

    // Perform the login call. We use the shared client (which owns the
    // cookie jar) so any Set-Cookie lands in the jar.
    let url = resolve_login_url(&req.url, &login.url)?;
    let mut rb = client.request(login.method.as_reqwest(), url);
    match &login.credentials {
        TokenLoginCredentials::Basic { username, password } => {
            rb = rb.basic_auth(username, Some(password));
        }
        TokenLoginCredentials::JsonBody { body } => {
            rb = rb
                .header("Content-Type", "application/json")
                .body(body.clone());
        }
        TokenLoginCredentials::FormBody { body } => {
            rb = rb
                .header("Content-Type", "application/x-www-form-urlencoded")
                .body(body.clone());
        }
    }
    let resp = rb.send().await.context("session login send")?;
    if !resp.status().is_success() {
        return Err(anyhow!(
            "session login returned status {}",
            resp.status()
        ));
    }

    // Extract the XSRF-TOKEN value from Set-Cookie on the login response.
    // Cisco SNA uses a double-submit CSRF pattern: the cookie value must
    // ALSO be echoed in an `X-XSRF-TOKEN` header on every subsequent
    // request, otherwise the SMC returns 401 even though the session
    // cookie is present. Servers that don't set this cookie simply get
    // `xsrf_token: None` and follow-up requests go out unchanged.
    let xsrf_token = extract_xsrf_token(&resp);
    Ok(SessionClient {
        client,
        xsrf_token,
    })
}

/// Scan the login response's `Set-Cookie` headers for a CSRF token the
/// server expects us to echo back as a header. Case-insensitive on the
/// cookie name ("XSRF-TOKEN" is the de-facto name but CSRF variants
/// exist). Returns the URL-decoded cookie value.
fn extract_xsrf_token(resp: &reqwest::Response) -> Option<String> {
    for raw in resp.headers().get_all(reqwest::header::SET_COOKIE).iter() {
        let raw_s = raw.to_str().ok()?;
        // A Set-Cookie header looks like `NAME=value; Path=/; HttpOnly`.
        // Just grab the first `=`-delimited pair.
        let head = raw_s.split(';').next()?;
        let (name, value) = head.split_once('=')?;
        let name = name.trim();
        let value = value.trim();
        if name.eq_ignore_ascii_case("XSRF-TOKEN")
            || name.eq_ignore_ascii_case("CSRF-TOKEN")
            || name.eq_ignore_ascii_case("X-CSRF-TOKEN")
        {
            // Some servers URL-encode the value — reqwest stores it raw,
            // so we URL-decode here for symmetry with what the client
            // would send in the matching header.
            return Some(
                urlencoding_decode(value)
                    .unwrap_or_else(|| value.to_string()),
            );
        }
    }
    None
}

/// Minimal inline URL-decoder — we only need `%XX` → byte replacement,
/// no `+` → space (cookies are not form-encoded). No dep so this stays
/// in lockstep with the rest of the executor.
fn urlencoding_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h1 = (bytes[i + 1] as char).to_digit(16)?;
            let h2 = (bytes[i + 2] as char).to_digit(16)?;
            out.push((h1 * 16 + h2) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

async fn send_with_client(
    session: &SessionClient,
    request: &ApiRequest,
) -> ApiResponse {
    use crate::api_runner::types::MAX_RESPONSE_BODY;
    use std::time::Instant;
    let started = Instant::now();

    let mut headers = HeaderMap::new();
    for (k, v) in &request.headers {
        if let (Ok(n), Ok(val)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            headers.insert(n, val);
        }
    }
    // Double-submit CSRF: if login returned an XSRF cookie, every
    // follow-up request MUST echo it as X-XSRF-TOKEN, or Cisco SNA
    // rejects with 401 Authorization Required. Only add if the user
    // hasn't already set it manually.
    if let Some(token) = &session.xsrf_token {
        let already_set = request
            .headers
            .keys()
            .any(|k| k.eq_ignore_ascii_case("x-xsrf-token"));
        if !already_set {
            if let Ok(val) = HeaderValue::from_str(token) {
                headers.insert(
                    HeaderName::from_static("x-xsrf-token"),
                    val,
                );
            }
        }
    }

    let mut builder = session
        .client
        .request(request.method.as_reqwest(), &request.url)
        .headers(headers)
        .query(&request.query.iter().collect::<Vec<_>>());
    // Body
    let (bytes, ct) = render_body_for_client(request);
    if let Some(ct) = ct {
        if !request
            .headers
            .keys()
            .any(|k| k.eq_ignore_ascii_case("content-type"))
        {
            builder = builder.header("Content-Type", ct);
        }
    }
    if let Some(b) = bytes {
        builder = builder.body(b);
    }

    let resp = match builder.send().await {
        Ok(r) => r,
        Err(err) => {
            return error_response(request, format!("request failed: {err}"));
        }
    };

    let final_url = resp.url().to_string();
    let status_code = resp.status().as_u16();
    let status_text = resp
        .status()
        .canonical_reason()
        .unwrap_or("")
        .to_string();

    let mut headers_out = std::collections::BTreeMap::new();
    for (k, v) in resp.headers() {
        headers_out.insert(
            k.as_str().to_string(),
            v.to_str().unwrap_or("").to_string(),
        );
    }
    let body = match resp.bytes().await {
        Ok(b) => b,
        Err(err) => {
            return ApiResponse {
                status_code,
                status_text,
                headers: headers_out,
                body: Vec::new(),
                body_truncated: false,
                duration_ms: started.elapsed().as_millis() as u64,
                final_url,
                error: Some(format!("body read failed: {err}")),
            };
        }
    };
    let (body_vec, truncated) = if body.len() <= MAX_RESPONSE_BODY {
        (body.to_vec(), false)
    } else {
        (body[..MAX_RESPONSE_BODY].to_vec(), true)
    };

    ApiResponse {
        status_code,
        status_text,
        headers: headers_out,
        body: body_vec,
        body_truncated: truncated,
        duration_ms: started.elapsed().as_millis() as u64,
        final_url,
        error: None,
    }
}

fn render_body_for_client(req: &ApiRequest) -> (Option<Vec<u8>>, Option<&'static str>) {
    use crate::api_runner::types::BodyKind;
    match req.body_kind.0 {
        BodyKind::None => (None, None),
        BodyKind::Json => (
            req.body_text.as_ref().map(|s| s.as_bytes().to_vec()),
            Some("application/json"),
        ),
        BodyKind::Form => (
            req.body_text.as_ref().map(|s| s.as_bytes().to_vec()),
            Some("application/x-www-form-urlencoded"),
        ),
        BodyKind::Text => (req.body_text.as_ref().map(|s| s.as_bytes().to_vec()), None),
        BodyKind::Binary => (req.body_bytes.clone(), Some("application/octet-stream")),
    }
}

fn error_response(req: &ApiRequest, msg: String) -> ApiResponse {
    ApiResponse {
        status_code: 0,
        status_text: String::new(),
        headers: std::collections::BTreeMap::new(),
        body: Vec::new(),
        body_truncated: false,
        duration_ms: 0,
        final_url: req.url.clone(),
        error: Some(msg),
    }
}

// ---- Hook runner abstraction ----------------------------------------------

/// The orchestrator invokes hooks through this trait so unit tests can
/// plug in a no-op / deterministic runner without a real sidecar.
#[async_trait::async_trait]
pub trait HookRunner: Send + Sync {
    async fn call(
        &self,
        module: &str,
        function: &str,
        request: serde_json::Value,
    ) -> Result<serde_json::Value>;
}

/// No-op runner that always fails with a clear error. Used when the app
/// starts without a sidecar or hook dir configured.
pub struct DisabledHookRunner;

#[async_trait::async_trait]
impl HookRunner for DisabledHookRunner {
    async fn call(
        &self,
        _module: &str,
        _function: &str,
        _request: serde_json::Value,
    ) -> Result<serde_json::Value> {
        Err(anyhow!("hook runner is disabled"))
    }
}

/// Sidecar-backed hook runner. Defers module resolution to the Python
/// side; we just forward the request/function arguments through the
/// existing `AgentBridge`.
pub struct SidecarHookRunner {
    bridge: Arc<crate::agent_bridge::AgentBridge>,
}

impl SidecarHookRunner {
    pub fn new(bridge: Arc<crate::agent_bridge::AgentBridge>) -> Self {
        Self { bridge }
    }
}

#[async_trait::async_trait]
impl HookRunner for SidecarHookRunner {
    async fn call(
        &self,
        module: &str,
        function: &str,
        request: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let params = serde_json::json!({
            "module": module,
            "function": function,
            "request": request,
        });
        let resp = self.bridge.call("api_hook.call", params).await?;
        match resp {
            crate::agent_bridge::AgentResponse::Done { result } => Ok(result),
            crate::agent_bridge::AgentResponse::Error { message } => {
                Err(anyhow!("sidecar hook error: {message}"))
            }
            crate::agent_bridge::AgentResponse::Token { .. } => {
                Err(anyhow!("unexpected streaming response from api_hook.call"))
            }
        }
    }
}
