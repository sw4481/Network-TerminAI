//! Auth strategies (Step 2: static header, HTTP Basic, Bearer) against
//! wiremock. Token-login and session-cookie flows arrive in Step 5 and will
//! extend this file.

use ccie_terminal_lib::api_runner::types::{ApiAuth, ApiRequest, BodyKindDefault, HttpMethod};
use ccie_terminal_lib::api_runner::{auth::apply_auth, execute_request};
use reqwest::header::{HeaderMap, AUTHORIZATION};
use std::collections::BTreeMap;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn base_req(m: HttpMethod, url: impl Into<String>) -> ApiRequest {
    ApiRequest {
        method: m,
        url: url.into(),
        headers: BTreeMap::new(),
        query: BTreeMap::new(),
        body_kind: BodyKindDefault::default(),
        body_text: None,
        body_bytes: None,
        auth: ApiAuth::None,
        timeout_secs: Some(5),
        insecure_skip_verify: false,
        tls_ca_bundle: None,
        tls_client_cert: None,
    }
}

// ---- unit-level apply_auth --------------------------------------------

#[test]
fn apply_header_auth_inserts_named_header() {
    let mut h = HeaderMap::new();
    let auth = ApiAuth::Header {
        name: "X-Cisco-Meraki-API-Key".to_string(),
        value: "deadbeef".to_string(),
    };
    apply_auth(&auth, &mut h).unwrap();
    assert_eq!(h.get("x-cisco-meraki-api-key").unwrap(), "deadbeef");
}

#[test]
fn apply_basic_encodes_credentials_correctly() {
    let mut h = HeaderMap::new();
    let auth = ApiAuth::Basic {
        username: "admin".to_string(),
        password: "Pa$$w0rd!".to_string(),
    };
    apply_auth(&auth, &mut h).unwrap();
    let got = h.get(AUTHORIZATION).unwrap().to_str().unwrap();
    // Expected base64 of "admin:Pa$$w0rd!"
    assert_eq!(got, "Basic YWRtaW46UGEkJHcwcmQh");
}

#[test]
fn apply_basic_rejects_colon_in_username() {
    let mut h = HeaderMap::new();
    let auth = ApiAuth::Basic {
        username: "bad:user".to_string(),
        password: "p".to_string(),
    };
    let result = apply_auth(&auth, &mut h);
    assert!(result.is_err(), "colon in username must error");
}

#[test]
fn apply_basic_handles_unicode_password() {
    // RFC 7617 recommends UTF-8; we just need to ensure we don't panic or
    // truncate. Exact encoding is verified via Base64 decode in the test.
    let mut h = HeaderMap::new();
    let auth = ApiAuth::Basic {
        username: "user".to_string(),
        password: "пароль".to_string(),
    };
    apply_auth(&auth, &mut h).unwrap();
    let got = h.get(AUTHORIZATION).unwrap().to_str().unwrap();
    assert!(got.starts_with("Basic "));
    let b64 = &got["Basic ".len()..];
    use base64::{engine::general_purpose::STANDARD, Engine};
    let decoded = STANDARD.decode(b64).unwrap();
    assert_eq!(decoded, b"user:\xd0\xbf\xd0\xb0\xd1\x80\xd0\xbe\xd0\xbb\xd1\x8c");
}

#[test]
fn apply_bearer_inserts_authorization_header() {
    let mut h = HeaderMap::new();
    let auth = ApiAuth::Bearer {
        token: "ghp_abc123".to_string(),
    };
    apply_auth(&auth, &mut h).unwrap();
    assert_eq!(
        h.get(AUTHORIZATION).unwrap().to_str().unwrap(),
        "Bearer ghp_abc123"
    );
}

#[test]
fn apply_none_leaves_headers_untouched() {
    let mut h = HeaderMap::new();
    apply_auth(&ApiAuth::None, &mut h).unwrap();
    assert!(h.is_empty());
}

#[test]
fn apply_header_rejects_invalid_name() {
    let mut h = HeaderMap::new();
    let auth = ApiAuth::Header {
        name: "X-Bad Header".to_string(), // space is illegal in header names
        value: "v".to_string(),
    };
    assert!(apply_auth(&auth, &mut h).is_err());
}

// ---- end-to-end against wiremock -------------------------------------

#[tokio::test]
async fn header_auth_reaches_wire() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/orgs"))
        .and(header("x-cisco-meraki-api-key", "DEADBEEF"))
        .respond_with(ResponseTemplate::new(200).set_body_string("[]"))
        .mount(&server)
        .await;

    let mut r = base_req(HttpMethod::Get, format!("{}/orgs", server.uri()));
    r.auth = ApiAuth::Header {
        name: "X-Cisco-Meraki-API-Key".to_string(),
        value: "DEADBEEF".to_string(),
    };
    let resp = execute_request(r).await;
    assert_eq!(resp.status_code, 200);
}

#[tokio::test]
async fn basic_auth_reaches_wire() {
    let server = MockServer::start().await;
    // base64("admin:ciscoxyz")
    Mock::given(method("GET"))
        .and(path("/ers/config/endpoint"))
        .and(header("authorization", "Basic YWRtaW46Y2lzY294eXo="))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let mut r = base_req(
        HttpMethod::Get,
        format!("{}/ers/config/endpoint", server.uri()),
    );
    r.auth = ApiAuth::Basic {
        username: "admin".to_string(),
        password: "ciscoxyz".to_string(),
    };
    let resp = execute_request(r).await;
    assert_eq!(resp.status_code, 200);
}

#[tokio::test]
async fn bearer_auth_reaches_wire() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/me"))
        .and(header("authorization", "Bearer my-token"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let mut r = base_req(HttpMethod::Get, format!("{}/v1/me", server.uri()));
    r.auth = ApiAuth::Bearer {
        token: "my-token".to_string(),
    };
    let resp = execute_request(r).await;
    assert_eq!(resp.status_code, 200);
}

#[tokio::test]
async fn explicit_auth_header_is_overridden_by_bearer_choice() {
    // Regression guard: if a user sets Authorization manually AND picks a
    // Bearer auth, the Bearer must take effect (explicit choice wins).
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/x"))
        .and(header("authorization", "Bearer chosen"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let mut r = base_req(HttpMethod::Get, format!("{}/x", server.uri()));
    r.headers
        .insert("authorization".to_string(), "Basic stale".to_string());
    r.auth = ApiAuth::Bearer {
        token: "chosen".to_string(),
    };
    let resp = execute_request(r).await;
    assert_eq!(resp.status_code, 200);
}
