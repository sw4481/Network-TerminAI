//! Variable substitution for outgoing requests.
//!
//! Supported placeholders (precedence: top-to-bottom, first match wins):
//!   1. `${var:NAME}`  — per-environment variable (from `api_env_vars` /
//!                       `api_runner::env_store`). Intended for non-secret
//!                       values like `meraki_org_id`.
//!   2. `${env:NAME}`  — same store, but the convention is UPPERCASE for
//!                       secrets (`MERAKI_API_KEY`). Functionally identical
//!                       to `var:`; the two prefixes are aliases so users
//!                       can visually distinguish secrets in their manifest.
//!
//! Escapes:
//!   * `$$`      → literal `$`
//!   * `$\{`     → literal `{`
//!   * `$\}`     → literal `}`
//!
//! Everything else passes through. Unknown placeholders raise an error
//! naming the missing variable (never a silent empty-string expansion —
//! that's how auth-header leaks happen in Postman imports).
//!
//! Nested resolution is supported up to a small fixed depth (`MAX_DEPTH`)
//! to catch accidental cycles without walking forever.
//!
//! `${response.X.Y}` and `${ask:...}` from the plan are STEP 7 — they get
//! added here without changing call sites.

use std::collections::{BTreeMap, HashSet};

/// Maximum nested-placeholder depth. `${var:a}` → `"${var:b}"` → `"${var:c}"`
/// is fine; we bail out beyond this to avoid runaway work or logic errors.
pub const MAX_DEPTH: usize = 4;

/// Container passed through the resolver. Keeping it a simple struct (not a
/// trait) makes it easy to synthesize from SQLite rows or from tests.
#[derive(Debug, Clone, Default)]
pub struct ResolverContext {
    /// All variables for the currently-active environment.
    pub vars: BTreeMap<String, String>,
    /// Responses keyed by saved-request name. Populated by the command
    /// layer from `history::lookup_latest_response_body`. `Some(bytes)`
    /// means the request has been sent successfully at least once; `None`
    /// means we haven't tried to look it up yet.
    pub responses: BTreeMap<String, serde_json::Value>,
}

impl ResolverContext {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, k: impl Into<String>, v: impl Into<String>) {
        self.vars.insert(k.into(), v.into());
    }

    pub fn with(mut self, k: impl Into<String>, v: impl Into<String>) -> Self {
        self.insert(k, v);
        self
    }

    /// Register a saved-request response for chaining. The body is parsed
    /// as JSON; non-JSON bodies produce a string fallback so lookups still
    /// work for text responses.
    pub fn insert_response(&mut self, name: impl Into<String>, body: &[u8]) {
        let parsed: serde_json::Value = std::str::from_utf8(body)
            .ok()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_else(|| {
                serde_json::Value::String(String::from_utf8_lossy(body).to_string())
            });
        self.responses.insert(name.into(), parsed);
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.vars.get(name).map(|s| s.as_str())
    }
}

/// Resolve a single string. See module docs for the grammar.
///
/// Returns:
/// * `Ok(resolved)` when every placeholder had a binding.
/// * `Err(ResolveError::Unresolved(names))` otherwise. The error names every
///   unresolved variable so the UI can surface the full set in one go.
pub fn resolve(input: &str, ctx: &ResolverContext) -> Result<String, ResolveError> {
    let mut missing = Vec::new();
    let resolved = resolve_inner(input, ctx, &mut missing, &mut HashSet::new(), 0)?;
    if missing.is_empty() {
        Ok(resolved)
    } else {
        missing.sort();
        missing.dedup();
        Err(ResolveError::Unresolved(missing))
    }
}

/// Walk every string field of a request and resolve placeholders in place.
/// Mutates `req` on success. On failure returns a single error that names
/// every unresolved variable across every field (so the user sees the
/// full set in one go instead of playing whack-a-mole).
pub fn resolve_request(
    req: &mut crate::api_runner::ApiRequest,
    ctx: &ResolverContext,
) -> Result<(), ResolveError> {
    let mut missing: Vec<String> = Vec::new();
    let mut other_err: Option<ResolveError> = None;

    let url = resolve_collect(&req.url, ctx, &mut missing, &mut other_err);

    let mut new_headers = std::collections::BTreeMap::new();
    for (k, v) in std::mem::take(&mut req.headers) {
        let rk = resolve_collect(&k, ctx, &mut missing, &mut other_err);
        let rv = resolve_collect(&v, ctx, &mut missing, &mut other_err);
        new_headers.insert(rk, rv);
    }

    let mut new_query = std::collections::BTreeMap::new();
    for (k, v) in std::mem::take(&mut req.query) {
        let rk = resolve_collect(&k, ctx, &mut missing, &mut other_err);
        let rv = resolve_collect(&v, ctx, &mut missing, &mut other_err);
        new_query.insert(rk, rv);
    }

    let body_text = req
        .body_text
        .take()
        .map(|body| resolve_collect(&body, ctx, &mut missing, &mut other_err));

    use crate::api_runner::types::{
        ApiAuth, SessionCookieLogin, TokenApply, TokenLoginCredentials, TokenLoginEndpoint,
    };
    let new_auth = match std::mem::replace(&mut req.auth, ApiAuth::None) {
        ApiAuth::None => ApiAuth::None,
        ApiAuth::Header { name, value } => ApiAuth::Header {
            name: resolve_collect(&name, ctx, &mut missing, &mut other_err),
            value: resolve_collect(&value, ctx, &mut missing, &mut other_err),
        },
        ApiAuth::Basic { username, password } => ApiAuth::Basic {
            username: resolve_collect(&username, ctx, &mut missing, &mut other_err),
            password: resolve_collect(&password, ctx, &mut missing, &mut other_err),
        },
        ApiAuth::Bearer { token } => ApiAuth::Bearer {
            token: resolve_collect(&token, ctx, &mut missing, &mut other_err),
        },
        ApiAuth::TokenLogin {
            login,
            apply,
            refresh_on_status,
        } => {
            let login = resolve_login_endpoint(login, ctx, &mut missing, &mut other_err);
            let apply = match apply {
                TokenApply::Header { name } => TokenApply::Header {
                    name: resolve_collect(&name, ctx, &mut missing, &mut other_err),
                },
                TokenApply::Bearer => TokenApply::Bearer,
            };
            ApiAuth::TokenLogin {
                login,
                apply,
                refresh_on_status,
            }
        }
        ApiAuth::SessionCookie { login } => ApiAuth::SessionCookie {
            login: SessionCookieLogin {
                method: login.method,
                url: resolve_collect(&login.url, ctx, &mut missing, &mut other_err),
                credentials: resolve_credentials(
                    login.credentials,
                    ctx,
                    &mut missing,
                    &mut other_err,
                ),
            },
        },
        ApiAuth::Hook { module, function } => ApiAuth::Hook {
            module: resolve_collect(&module, ctx, &mut missing, &mut other_err),
            function: resolve_collect(&function, ctx, &mut missing, &mut other_err),
        },
    };

    fn resolve_login_endpoint(
        e: TokenLoginEndpoint,
        ctx: &ResolverContext,
        missing: &mut Vec<String>,
        other: &mut Option<ResolveError>,
    ) -> TokenLoginEndpoint {
        TokenLoginEndpoint {
            method: e.method,
            url: resolve_collect(&e.url, ctx, missing, other),
            credentials: resolve_credentials(e.credentials, ctx, missing, other),
            token_jsonpath: resolve_collect(&e.token_jsonpath, ctx, missing, other),
        }
    }
    fn resolve_credentials(
        c: TokenLoginCredentials,
        ctx: &ResolverContext,
        missing: &mut Vec<String>,
        other: &mut Option<ResolveError>,
    ) -> TokenLoginCredentials {
        match c {
            TokenLoginCredentials::Basic { username, password } => {
                TokenLoginCredentials::Basic {
                    username: resolve_collect(&username, ctx, missing, other),
                    password: resolve_collect(&password, ctx, missing, other),
                }
            }
            TokenLoginCredentials::JsonBody { body } => TokenLoginCredentials::JsonBody {
                body: resolve_collect(&body, ctx, missing, other),
            },
            TokenLoginCredentials::FormBody { body } => TokenLoginCredentials::FormBody {
                body: resolve_collect(&body, ctx, missing, other),
            },
        }
    }

    // Non-missing errors (cycle, max depth, malformed) take priority over
    // the aggregated missing list.
    if let Some(err) = other_err {
        return Err(err);
    }
    if !missing.is_empty() {
        missing.sort();
        missing.dedup();
        return Err(ResolveError::Unresolved(missing));
    }

    req.url = url;
    req.headers = new_headers;
    req.query = new_query;
    req.body_text = body_text;
    req.auth = new_auth;
    Ok(())
}

/// Call `resolve` and route the error into one of the accumulators.
/// Returns the best-effort resolved string (which may still contain
/// placeholders when variables were missing).
fn resolve_collect(
    input: &str,
    ctx: &ResolverContext,
    missing: &mut Vec<String>,
    other: &mut Option<ResolveError>,
) -> String {
    match resolve(input, ctx) {
        Ok(s) => s,
        Err(ResolveError::Unresolved(names)) => {
            missing.extend(names);
            // Return the input so downstream continues processing.
            input.to_string()
        }
        Err(err) => {
            if other.is_none() {
                *other = Some(err);
            }
            input.to_string()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveError {
    Unresolved(Vec<String>),
    CycleDetected(String),
    MaxDepth(String),
    Malformed(String),
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unresolved(names) => {
                write!(f, "unresolved variable(s): {}", names.join(", "))
            }
            Self::CycleDetected(name) => write!(f, "variable cycle detected at {name}"),
            Self::MaxDepth(name) => {
                write!(f, "max nesting depth exceeded while resolving {name}")
            }
            Self::Malformed(msg) => write!(f, "malformed placeholder: {msg}"),
        }
    }
}

impl std::error::Error for ResolveError {}

// ---- internals -----------------------------------------------------------

fn resolve_inner(
    input: &str,
    ctx: &ResolverContext,
    missing: &mut Vec<String>,
    in_flight: &mut HashSet<String>,
    depth: usize,
) -> Result<String, ResolveError> {
    if depth > MAX_DEPTH {
        return Err(ResolveError::MaxDepth("(max depth)".into()));
    }
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        let c = bytes[i];
        if c == b'$' {
            // Escapes first.
            if i + 1 < bytes.len() {
                match bytes[i + 1] {
                    b'$' => {
                        out.push('$');
                        i += 2;
                        continue;
                    }
                    b'\\' if i + 2 < bytes.len() && (bytes[i + 2] == b'{' || bytes[i + 2] == b'}') => {
                        out.push(bytes[i + 2] as char);
                        i += 3;
                        continue;
                    }
                    b'{' => {
                        // Parse ${prefix:name}
                        let close = find_matching_brace(bytes, i + 2)
                            .ok_or_else(|| {
                                ResolveError::Malformed(format!(
                                    "unterminated placeholder near {}",
                                    snippet(input, i)
                                ))
                            })?;
                        let inner = std::str::from_utf8(&bytes[i + 2..close])
                            .map_err(|_| {
                                ResolveError::Malformed("placeholder is not UTF-8".into())
                            })?;
                        // `response.<saved>.<jsonpath>` chaining. Dot-
                        // separated because JSONPath itself needs the `:`
                        // character free for filters like `$.[*]:`.
                        if let Some(rest) = inner.strip_prefix("response.") {
                            // Split on the FIRST `.` after the name to get
                            // (saved_name, jsonpath).
                            let (saved_name, path) = match rest.find('.') {
                                Some(idx) => (&rest[..idx], &rest[idx + 1..]),
                                None => (rest, ""),
                            };
                            match ctx.responses.get(saved_name) {
                                Some(json) => {
                                    let picked = apply_jsonpath(json, path);
                                    match picked {
                                        Some(value) => out.push_str(&value),
                                        None => {
                                            // Preserve the literal so the
                                            // user sees what failed.
                                            out.push_str(&input[i..=close]);
                                        }
                                    }
                                }
                                None => {
                                    missing.push(format!("response.{saved_name}"));
                                }
                            }
                            i = close + 1;
                            continue;
                        }

                        let split = inner.split_once(':');
                        let (prefix, name) = match split {
                            Some(p) => p,
                            None => {
                                // No `prefix:` form: treat as a literal so
                                // future placeholder kinds (response, ask,
                                // jsonpath-with-dots) survive unchanged.
                                out.push_str(&input[i..=close]);
                                i = close + 1;
                                continue;
                            }
                        };
                        let name = name.trim();
                        match prefix {
                            "env" | "var" => {
                                if in_flight.contains(name) {
                                    return Err(ResolveError::CycleDetected(name.to_string()));
                                }
                                match ctx.get(name) {
                                    Some(value) => {
                                        in_flight.insert(name.to_string());
                                        let nested = resolve_inner(
                                            value,
                                            ctx,
                                            missing,
                                            in_flight,
                                            depth + 1,
                                        )?;
                                        in_flight.remove(name);
                                        out.push_str(&nested);
                                    }
                                    None => {
                                        missing.push(name.to_string());
                                    }
                                }
                            }
                            _other => {
                                // Unknown prefix: leave as literal so future
                                // prefixes (response, ask) added in Step 7
                                // don't accidentally resolve to empty strings
                                // today. The caller gets the raw placeholder
                                // back and can decide how to handle it.
                                out.push_str(&input[i..=close]);
                            }
                        }
                        // advance past the closing `}`
                        i = close + 1;
                        continue;
                    }
                    _ => { /* not a recognised escape */ }
                }
            }
        }
        // Fallback: copy the raw byte.
        out.push(c as char);
        i += 1;
    }
    Ok(out)
}

/// Very small JSONPath-ish accessor. Supports:
///   * `""` / `$` / `$.` → root (stringified)
///   * `foo.bar`, `$.foo.bar`
///   * `foo[0]`, `$.foo[0].bar`
/// Non-primitive leaves are JSON-stringified so the result can drop into
/// a URL or header string.
fn apply_jsonpath(json: &serde_json::Value, path: &str) -> Option<String> {
    let trimmed = path.trim_start_matches('$').trim_start_matches('.');
    let mut cur = json;
    if !trimmed.is_empty() {
        for segment in trimmed.split('.') {
            if segment.is_empty() {
                continue;
            }
            let (name, idx) = if let Some(open) = segment.find('[') {
                let close = segment.find(']')?;
                let idx = segment[open + 1..close].parse::<usize>().ok()?;
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
    }
    match cur {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        serde_json::Value::Null => Some(String::new()),
        other => serde_json::to_string(other).ok(),
    }
}

fn find_matching_brace(bytes: &[u8], start: usize) -> Option<usize> {
    // Simple scan: `${...}` doesn't nest inside itself in this grammar, so
    // first `}` wins.
    let mut i = start;
    while i < bytes.len() {
        if bytes[i] == b'}' {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn snippet(s: &str, idx: usize) -> &str {
    let start = idx;
    let end = (idx + 20).min(s.len());
    &s[start..end]
}
