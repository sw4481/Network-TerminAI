//! TLS option coverage: self-signed accept/reject + custom CA bundle.
//!
//! We generate a cert on the fly with `rcgen`, stand up a tiny axum-server
//! HTTPS listener on `127.0.0.1` bound to port 0, then drive the executor
//! against it. Tests verify:
//!   * a fresh client rejects a self-signed cert (the real-world default),
//!   * `insecure_skip_verify=true` accepts it,
//!   * `tls_ca_bundle` pointing at the self-signed CA pem accepts it
//!     without lowering verification.
//!
//! mTLS (client_cert) is covered via an acceptance check on the loader —
//! round-tripping a full mTLS handshake from axum-server is overkill for
//! what we need to guarantee at this layer.

use ccie_terminal_lib::api_runner::types::{
    ApiAuth, ApiRequest, BodyKind, BodyKindDefault, HttpMethod,
};
use ccie_terminal_lib::api_runner::execute_request;
use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tempfile::TempDir;

fn req(url: impl Into<String>) -> ApiRequest {
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

/// Stand up a one-shot self-signed HTTPS server and return
/// `(base_url, cert_pem_path, _guard)`. The guard keeps the temp dir alive.
async fn start_tls_server() -> (String, std::path::PathBuf, TempDir, tokio::task::JoinHandle<()>) {
    // Ensure a crypto provider is installed for rustls 0.23.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let cert = rcgen::generate_simple_self_signed(vec!["localhost".into(), "127.0.0.1".into()])
        .expect("generate self-signed cert");
    let cert_pem = cert.cert.pem();
    let key_pem = cert.key_pair.serialize_pem();

    let tmp = TempDir::new().unwrap();
    let cert_path = tmp.path().join("cert.pem");
    let key_path = tmp.path().join("key.pem");
    std::fs::write(&cert_path, &cert_pem).unwrap();
    std::fs::write(&key_path, &key_pem).unwrap();

    let tls_config =
        axum_server::tls_rustls::RustlsConfig::from_pem_file(&cert_path, &key_path)
            .await
            .expect("build rustls config");

    // Listener on a random free port.
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    let base_url = format!("https://127.0.0.1:{}", addr.port());

    let app = axum::Router::new().route(
        "/hello",
        axum::routing::get(|| async { "hi" }),
    );

    let handle = tokio::spawn(async move {
        axum_server::from_tcp_rustls(listener, tls_config)
            .serve(app.into_make_service())
            .await
            .ok();
    });

    // Small grace so the bind completes before the first request.
    tokio::time::sleep(Duration::from_millis(50)).await;

    (base_url, cert_path, tmp, handle)
}

#[tokio::test]
async fn rejects_self_signed_by_default() {
    let (base, _cert, _tmp, handle) = start_tls_server().await;
    let r = req(format!("{base}/hello"));
    let resp = execute_request(r).await;
    assert_eq!(resp.status_code, 0, "expected transport error");
    assert!(resp.error.is_some());
    handle.abort();
}

#[tokio::test]
async fn accepts_self_signed_when_insecure_skip_verify() {
    let (base, _cert, _tmp, handle) = start_tls_server().await;
    let mut r = req(format!("{base}/hello"));
    r.insecure_skip_verify = true;
    let resp = execute_request(r).await;
    assert_eq!(resp.status_code, 200);
    assert_eq!(resp.body, b"hi");
    handle.abort();
}

#[tokio::test]
async fn accepts_self_signed_when_ca_bundle_provided() {
    let (base, cert_path, _tmp, handle) = start_tls_server().await;
    let mut r = req(format!("{base}/hello"));
    r.tls_ca_bundle = Some(cert_path.to_string_lossy().into_owned());
    let resp = execute_request(r).await;
    // If rustls backend accepted the custom CA, we get 200.
    assert_eq!(
        resp.status_code, 200,
        "expected 200 with custom CA, got {resp:?}"
    );
    handle.abort();
}

#[tokio::test]
async fn invalid_ca_bundle_path_surfaces_as_error() {
    let mut r = req("https://127.0.0.1:1/does-not-matter");
    r.tls_ca_bundle = Some("/nonexistent-xyz-123/ca.pem".into());
    let resp = execute_request(r).await;
    assert_eq!(resp.status_code, 0);
    assert!(resp
        .error
        .unwrap_or_default()
        .to_ascii_lowercase()
        .contains("ca bundle"));
}

#[tokio::test]
async fn invalid_client_cert_path_surfaces_as_error() {
    let mut r = req("https://127.0.0.1:1/does-not-matter");
    r.tls_client_cert = Some("/nonexistent-xyz-123/client.pem".into());
    let resp = execute_request(r).await;
    assert_eq!(resp.status_code, 0);
    assert!(resp
        .error
        .unwrap_or_default()
        .to_ascii_lowercase()
        .contains("client cert"));
}

// Keep the import list quiet on unused imports for async_trait/etc.
#[allow(dead_code)]
fn _unused() {
    let _: Arc<()> = Arc::new(());
}
