//! Integration test for the `ccie-terminal://` deep-link URL parser.
//!
//! The Tauri plugin delivers raw URL strings to our `on_open_url` handler,
//! and we route them through `commands::blocks::parse_share_url`. This test
//! exercises the parser directly so we don't need to spin up a Tauri runtime
//! to verify the handler logic. The OS-level behaviour (`open ccie-terminal://...`)
//! is covered by the manual checklist in `docs/E2E_REGRESSION.md`.

use ccie_terminal_lib::commands::blocks::parse_share_url;

#[test]
fn parses_valid_block_share_url() {
    let share_id = "abc-123";
    let url = format!("ccie-terminal://block/{share_id}");
    assert_eq!(parse_share_url(&url), Some(share_id.to_string()));
}

#[test]
fn parses_uuid_share_id() {
    // The Rust backend mints share ids as UUIDv4 — make sure the parser
    // round-trips a realistic id verbatim.
    let url = "ccie-terminal://block/550e8400-e29b-41d4-a716-446655440000";
    assert_eq!(
        parse_share_url(url),
        Some("550e8400-e29b-41d4-a716-446655440000".to_string()),
    );
}

#[test]
fn ignores_extra_path_segments() {
    let url = "ccie-terminal://block/abc-123/extra/parts";
    assert_eq!(parse_share_url(url), Some("abc-123".to_string()));
}

#[test]
fn strips_query_and_fragment() {
    assert_eq!(
        parse_share_url("ccie-terminal://block/abc-123?ref=mac"),
        Some("abc-123".to_string()),
    );
    assert_eq!(
        parse_share_url("ccie-terminal://block/abc-123#anchor"),
        Some("abc-123".to_string()),
    );
}

#[test]
fn rejects_wrong_scheme() {
    assert_eq!(parse_share_url("https://example.com/block/abc"), None);
    assert_eq!(parse_share_url("myapp://block/abc"), None);
    assert_eq!(parse_share_url("file:///block/abc"), None);
}

#[test]
fn rejects_wrong_host_or_path() {
    assert_eq!(parse_share_url("ccie-terminal://other/x"), None);
    assert_eq!(parse_share_url("ccie-terminal://block"), None);
    assert_eq!(parse_share_url("ccie-terminal://"), None);
}

#[test]
fn rejects_empty_share_id() {
    assert_eq!(parse_share_url("ccie-terminal://block/"), None);
    assert_eq!(parse_share_url("ccie-terminal://block//trailing"), None);
}

#[test]
fn rejects_plain_garbage() {
    assert_eq!(parse_share_url(""), None);
    assert_eq!(parse_share_url("not a url"), None);
}
