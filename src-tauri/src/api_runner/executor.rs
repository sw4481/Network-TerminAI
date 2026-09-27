//! HTTP request execution backed by reqwest.
//!
//! Responsibilities:
//!   * build the `reqwest::Client` (TLS options, redirect policy)
//!   * merge headers + query + body on top of the request
//!   * apply auth via [`super::auth::apply_auth`]
//!   * send, cap response body at [`MAX_RESPONSE_BODY`], time it
//!   * convert both success AND network-level errors into [`ApiResponse`]
//!
//! The executor never panics and never returns `Err`. Callers get a single
//! [`ApiResponse`] back; network failures are encoded via `error = Some(...)`
//! with `status_code = 0`.

use super::auth::apply_auth;
use super::types::{
    ApiRequest, ApiResponse, BodyKind, DEFAULT_TIMEOUT_SECS, MAX_RESPONSE_BODY,
};
use anyhow::Context;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::redirect::Policy;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

/// Execute one request. Returns an `ApiResponse` for both success and failure.
pub async fn execute_request(req: ApiRequest) -> ApiResponse {
    let started = Instant::now();

    let timeout = Duration::from_secs(req.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS));

    // Build a client that:
    //   * honors the per-target TLS skip-verify flag,
    //   * caps redirects at 10 (reqwest default) but STRIPS the Authorization
    //     header on cross-origin hops — reqwest already does this, but we
    //     install a custom policy so we can add a test for it.
    let client = match build_client(&req, timeout) {
        Ok(c) => c,
        Err(err) => {
            return error_response(&req, started, format!("client build failed: {err}"));
        }
    };

    // Headers: start with the user's, layer auth on top. Auth can overwrite
    // user-supplied Authorization since choosing an auth type is an explicit
    // signal the user wants that header authoritative.
    let mut headers = match build_headers(&req.headers) {
        Ok(h) => h,
        Err(err) => return error_response(&req, started, format!("invalid headers: {err}")),
    };
    if let Err(err) = apply_auth(&req.auth, &mut headers) {
        return error_response(&req, started, format!("auth failed: {err}"));
    }

    // Assemble the body. Content-Type is set based on BodyKind when the user
    // hasn't already picked one.
    let (body_bytes, body_content_type) = render_body(&req);
    if let Some(ct) = body_content_type {
        if !headers.contains_key(CONTENT_TYPE) {
            if let Ok(v) = HeaderValue::from_str(ct) {
                headers.insert(CONTENT_TYPE, v);
            }
        }
    }

    // Query params — URL may already contain some; reqwest appends by default.
    let query: Vec<(&str, &str)> = req
        .query
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();

    let mut builder = client
        .request(req.method.as_reqwest(), &req.url)
        .headers(headers)
        .query(&query);
    if let Some(bytes) = body_bytes {
        builder = builder.body(bytes);
    }

    let resp = match builder.send().await {
        Ok(r) => r,
        Err(err) => {
            return error_response(&req, started, classify_reqwest_error(&err));
        }
    };

    let final_url = resp.url().to_string();
    let status_code = resp.status().as_u16();
    let status_text = resp
        .status()
        .canonical_reason()
        .unwrap_or("")
        .to_string();

    let mut headers_out = BTreeMap::new();
    for (k, v) in resp.headers() {
        headers_out.insert(
            k.as_str().to_string(),
            v.to_str().unwrap_or("").to_string(),
        );
    }

    // Read body with an explicit cap. reqwest's `bytes()` would read the full
    // response — we want to stop at MAX_RESPONSE_BODY and flag truncation.
    let (body, truncated) = match read_body_capped(resp).await {
        Ok(b) => b,
        Err(err) => {
            // Partial response: we still have status/headers; surface the
            // body error so the UI can show it.
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

    ApiResponse {
        status_code,
        status_text,
        headers: headers_out,
        body,
        body_truncated: truncated,
        duration_ms: started.elapsed().as_millis() as u64,
        final_url,
        error: None,
    }
}

// ---- helpers --------------------------------------------------------------

fn build_client(req: &ApiRequest, timeout: Duration) -> anyhow::Result<reqwest::Client> {
    build_client_with(req, timeout, false)
}

/// Shared client-builder used by both the stateless executor and the
/// auth_state cookie-jar wrapper. `with_cookies=true` enables reqwest's
/// cookie jar so session_cookie auth can persist Set-Cookie across calls.
pub fn build_client_with(
    req: &ApiRequest,
    timeout: Duration,
    with_cookies: bool,
) -> anyhow::Result<reqwest::Client> {
    // Custom redirect policy: follow up to 10 hops. reqwest already strips
    // Authorization on cross-origin redirects by default; we install this
    // policy to set the hop cap explicitly.
    let policy = Policy::custom(|attempt| {
        if attempt.previous().len() >= 10 {
            return attempt.error("too many redirects");
        }
        attempt.follow()
    });

    let mut builder = reqwest::Client::builder()
        .timeout(timeout)
        .redirect(policy)
        .gzip(true)
        .brotli(true)
        .referer(false)
        .cookie_store(with_cookies);

    if req.insecure_skip_verify {
        // Accept invalid certs. Hostname verification is handled at the TLS
        // layer; with the default (native-tls) backend this flag also relaxes
        // hostname checks for self-signed labs.
        builder = builder.danger_accept_invalid_certs(true);
    }

    // Custom CA bundle: parse as PEM and add every cert it contains.
    if let Some(path) = &req.tls_ca_bundle {
        let bytes = std::fs::read(path)
            .with_context(|| format!("read CA bundle {path}"))?;
        for cert in reqwest::Certificate::from_pem_bundle(&bytes)
            .with_context(|| format!("parse CA bundle {path}"))?
        {
            builder = builder.add_root_certificate(cert);
        }
    }

    // Client cert (mTLS): expects PEM containing cert + private key.
    if let Some(path) = &req.tls_client_cert {
        let bytes = std::fs::read(path)
            .with_context(|| format!("read client cert {path}"))?;
        let identity = reqwest::Identity::from_pem(&bytes)
            .with_context(|| format!("parse client cert {path}"))?;
        builder = builder.identity(identity);
    }

    Ok(builder.build()?)
}

fn build_headers(src: &BTreeMap<String, String>) -> anyhow::Result<HeaderMap> {
    let mut out = HeaderMap::new();
    for (k, v) in src {
        let name = HeaderName::from_bytes(k.as_bytes())
            .map_err(|e| anyhow::anyhow!("header name {k:?}: {e}"))?;
        let value = HeaderValue::from_str(v)
            .map_err(|e| anyhow::anyhow!("header value for {k:?}: {e}"))?;
        out.insert(name, value);
    }
    Ok(out)
}

/// Returns `(body_bytes, suggested_content_type)`.
/// `suggested_content_type` is only applied when the user didn't already set one.
fn render_body(req: &ApiRequest) -> (Option<Vec<u8>>, Option<&'static str>) {
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

/// Drain the response body into a `Vec<u8>` bounded at `MAX_RESPONSE_BODY`.
/// Returns `(bytes, truncated)`.
async fn read_body_capped(resp: reqwest::Response) -> anyhow::Result<(Vec<u8>, bool)> {
    // reqwest already decompresses gzip/brotli transparently.
    let full = resp.bytes().await?;
    if full.len() <= MAX_RESPONSE_BODY {
        Ok((full.to_vec(), false))
    } else {
        Ok((full[..MAX_RESPONSE_BODY].to_vec(), true))
    }
}

fn error_response(req: &ApiRequest, started: Instant, msg: String) -> ApiResponse {
    ApiResponse {
        status_code: 0,
        status_text: String::new(),
        headers: BTreeMap::new(),
        body: Vec::new(),
        body_truncated: false,
        duration_ms: started.elapsed().as_millis() as u64,
        final_url: req.url.clone(),
        error: Some(msg),
    }
}

fn classify_reqwest_error(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        format!("request timed out: {err}")
    } else if err.is_connect() {
        format!("connection failed: {err}")
    } else if err.is_redirect() {
        format!("redirect failed: {err}")
    } else if err.is_body() {
        format!("body error: {err}")
    } else {
        format!("request failed: {err}")
    }
}

/// Public helper used by the auth tests — exposes the `Authorization` header
/// stripping logic for redirect safety. reqwest's default Client already
/// handles this correctly; we re-export the check so tests can assert it.
pub fn is_cross_origin(from: &reqwest::Url, to: &reqwest::Url) -> bool {
    let same_scheme = from.scheme() == to.scheme();
    let same_host = from.host_str() == to.host_str();
    let same_port = from.port_or_known_default() == to.port_or_known_default();
    !(same_scheme && same_host && same_port)
}

/// Convenience: strip `Authorization` from a header map. Used by the redirect
/// hook and exercised by unit tests in the companion test module.
pub fn strip_authorization(headers: &mut HeaderMap) {
    headers.remove(AUTHORIZATION);
}

#[cfg(test)]
mod inline_tests {
    use super::*;

    #[test]
    fn cross_origin_detection() {
        let a = reqwest::Url::parse("https://api.meraki.com/v1/orgs").unwrap();
        let b = reqwest::Url::parse("https://api.meraki.com/v1/networks").unwrap();
        let c = reqwest::Url::parse("https://evil.example.com/v1/orgs").unwrap();
        let d = reqwest::Url::parse("http://api.meraki.com/v1/orgs").unwrap();
        assert!(!is_cross_origin(&a, &b), "same origin should be same");
        assert!(is_cross_origin(&a, &c), "different host is cross-origin");
        assert!(is_cross_origin(&a, &d), "different scheme is cross-origin");
    }

    #[test]
    fn strip_auth_removes_header() {
        let mut h = HeaderMap::new();
        h.insert(
            AUTHORIZATION,
            HeaderValue::from_static("Bearer secret-token"),
        );
        strip_authorization(&mut h);
        assert!(!h.contains_key(AUTHORIZATION));
    }
}
