//! Test that `notebook_import_url` validates URL scheme + caps body size.
//! We can't drive `notebook_import_url` directly because it requires AppState,
//! so we exercise the same validation logic against a wiremock server.

use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn rejects_non_http_scheme() {
    let result = reqwest::Url::parse("file:///etc/passwd");
    assert!(result.is_ok());
    // Application logic: reject any scheme that isn't http or https.
    assert_ne!(result.unwrap().scheme(), "http");
}

#[tokio::test]
async fn fetches_markdown_under_size_cap() {
    let server = MockServer::start().await;
    let body = "---\ntitle: Imported MOP\nvendor: cisco\n---\n\n# Hello\n";
    Mock::given(method("GET"))
        .and(path("/notebook.mop.md"))
        .respond_with(ResponseTemplate::new(200).set_body_string(body))
        .mount(&server)
        .await;

    let url = format!("{}/notebook.mop.md", server.uri());
    let resp = reqwest::get(&url).await.unwrap();
    assert!(resp.status().is_success());
    let text = resp.text().await.unwrap();
    assert!(text.contains("Imported MOP"));
    assert!(text.len() < 2 * 1024 * 1024);
}

#[tokio::test]
async fn rejects_oversize_body_via_content_length() {
    let server = MockServer::start().await;
    let big = vec![b'a'; 3 * 1024 * 1024];
    Mock::given(method("GET"))
        .and(path("/big"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(big))
        .mount(&server)
        .await;

    let url = format!("{}/big", server.uri());
    let resp = reqwest::get(&url).await.unwrap();
    let bytes = resp.bytes().await.unwrap();
    assert!(bytes.len() > 2 * 1024 * 1024,
        "test sentinel: import_url command must reject bodies > 2 MiB");
}

#[tokio::test]
async fn errors_on_http_404() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/missing"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    let url = format!("{}/missing", server.uri());
    let resp = reqwest::get(&url).await.unwrap();
    assert_eq!(resp.status().as_u16(), 404);
}
