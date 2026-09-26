//! Rust coverage for `api_runner::history` + the `${response.name.path}`
//! chaining resolver.

use ccie_terminal_lib::api_runner::history::{
    delete_saved_request, get_history_detail, get_saved_by_id, list_history,
    list_saved_requests, lookup_latest_response_body, save_request, validate_saved_name,
    HistoryFilter, NewSavedRequest,
};
use ccie_terminal_lib::api_runner::resolver::{resolve, ResolverContext};
use ccie_terminal_lib::db;
use rusqlite::{params, Connection};
use tempfile::TempDir;

fn open_test_db() -> (TempDir, Connection) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("t.db");
    let conn = db::open_and_migrate(&path).unwrap();
    // Some test hosts enable foreign_keys by default; to keep these tests
    // independent of that quirk, explicitly turn it OFF. The production
    // code enforces referential integrity at the application layer.
    conn.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
    (dir, conn)
}

/// Insert a synthetic api_history row. Returns the generated id.
fn insert_history(
    conn: &Connection,
    tab_id: Option<&str>,
    saved_request_id: Option<&str>,
    method: &str,
    url: &str,
    status: Option<i64>,
    body: Option<&[u8]>,
    sent_at: i64,
) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO api_history
            (id, tab_id, saved_request_id, target_id, environment,
             method, url, request_headers_json, request_body,
             status_code, response_headers_json, response_body,
             response_body_truncated, duration_ms, error, sent_at)
         VALUES (?, ?, ?, NULL, NULL, ?, ?, '{}', NULL, ?, '{}', ?, 0, 42, NULL, ?)",
        params![id, tab_id, saved_request_id, method, url, status, body, sent_at],
    )
    .unwrap();
    id
}

// ---- validate_saved_name ------------------------------------------------

#[test]
fn validate_saved_name_accepts_reasonable_titles() {
    assert!(validate_saved_name("list-orgs").is_ok());
    assert!(validate_saved_name("Meraki audit 2026.04").is_ok());
    assert!(validate_saved_name("probe_v2").is_ok());
}

#[test]
fn validate_saved_name_rejects_bad_shapes() {
    for bad in ["", "   ", "a/b", "a\\b", "a;b", "a\nb", "a*b", &"x".repeat(129)] {
        assert!(
            validate_saved_name(bad).is_err(),
            "expected rejection for {bad:?}"
        );
    }
}

// ---- Saved requests CRUD ------------------------------------------------

#[test]
fn save_request_round_trip_preserves_every_field() {
    let (_dir, conn) = open_test_db();
    let saved = save_request(
        &conn,
        NewSavedRequest {
            name: "list-orgs",
            target_id: Some("meraki"),
            environment: Some("lab"),
            method: "GET",
            url: "https://api.meraki.com/api/v1/organizations",
            headers_json: r#"{"Accept":"application/json"}"#,
            query_json: "{}",
            body_kind: "none",
            body_text: None,
        },
    )
    .unwrap();
    assert_eq!(saved.name, "list-orgs");
    assert_eq!(saved.target_id.as_deref(), Some("meraki"));

    let again = get_saved_by_id(&conn, &saved.id).unwrap().unwrap();
    assert_eq!(again.url, saved.url);
    assert_eq!(again.headers_json, r#"{"Accept":"application/json"}"#);
    assert_eq!(again.body_kind, "none");
}

#[test]
fn save_request_upserts_by_name_in_place() {
    let (_dir, conn) = open_test_db();
    let a = save_request(
        &conn,
        NewSavedRequest {
            name: "probe",
            target_id: None,
            environment: None,
            method: "GET",
            url: "https://a/",
            headers_json: "{}",
            query_json: "{}",
            body_kind: "none",
            body_text: None,
        },
    )
    .unwrap();
    let b = save_request(
        &conn,
        NewSavedRequest {
            name: "probe",
            target_id: None,
            environment: None,
            method: "POST",
            url: "https://b/",
            headers_json: "{}",
            query_json: "{}",
            body_kind: "none",
            body_text: None,
        },
    )
    .unwrap();
    assert_eq!(a.id, b.id, "same name must reuse the same row");
    assert_eq!(b.method, "POST");
    assert_eq!(b.url, "https://b/");

    let all = list_saved_requests(&conn).unwrap();
    assert_eq!(all.len(), 1);
}

#[test]
fn save_request_rejects_invalid_names() {
    let (_dir, conn) = open_test_db();
    let err = save_request(
        &conn,
        NewSavedRequest {
            name: "bad/name",
            target_id: None,
            environment: None,
            method: "GET",
            url: "https://x",
            headers_json: "{}",
            query_json: "{}",
            body_kind: "none",
            body_text: None,
        },
    )
    .unwrap_err();
    assert!(err.to_string().to_lowercase().contains("invalid"));
}

#[test]
fn list_saved_requests_is_sorted_case_insensitive() {
    let (_dir, conn) = open_test_db();
    for name in ["zebra", "Alpha", "mike"] {
        save_request(
            &conn,
            NewSavedRequest {
                name,
                target_id: None,
                environment: None,
                method: "GET",
                url: "https://x",
                headers_json: "{}",
                query_json: "{}",
                body_kind: "none",
                body_text: None,
            },
        )
        .unwrap();
    }
    let names: Vec<_> = list_saved_requests(&conn)
        .unwrap()
        .into_iter()
        .map(|r| r.name)
        .collect();
    assert_eq!(names, vec!["Alpha", "mike", "zebra"]);
}

#[test]
fn delete_saved_request_removes_row_but_leaves_history() {
    let (_dir, conn) = open_test_db();
    // This test verifies the `ON DELETE SET NULL` cascade, which only
    // fires when FK enforcement is enabled. Flip it on just for this test.
    conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();

    let saved = save_request(
        &conn,
        NewSavedRequest {
            name: "probe",
            target_id: None,
            environment: None,
            method: "GET",
            url: "https://x",
            headers_json: "{}",
            query_json: "{}",
            body_kind: "none",
            body_text: None,
        },
    )
    .unwrap();
    let h = insert_history(
        &conn,
        None,
        Some(&saved.id),
        "GET",
        "https://x",
        Some(200),
        Some(b"[]"),
        1,
    );

    delete_saved_request(&conn, &saved.id).unwrap();
    assert!(get_saved_by_id(&conn, &saved.id).unwrap().is_none());

    // History row survives (FK cascade is SET NULL, not DELETE).
    let detail = get_history_detail(&conn, &h).unwrap();
    assert!(detail.is_some());
    assert!(detail.unwrap().summary.saved_request_id.is_none());
}

// ---- History listing -----------------------------------------------------

#[test]
fn list_history_returns_newest_first() {
    let (_dir, conn) = open_test_db();
    insert_history(&conn, Some("tab-1"), None, "GET", "/a", Some(200), None, 10);
    insert_history(&conn, Some("tab-1"), None, "GET", "/b", Some(200), None, 20);
    insert_history(&conn, Some("tab-1"), None, "GET", "/c", Some(200), None, 15);

    let rows = list_history(
        &conn,
        &HistoryFilter {
            tab_id: Some("tab-1".to_string()),
            ..Default::default()
        },
    )
    .unwrap();
    let urls: Vec<_> = rows.iter().map(|r| r.url.clone()).collect();
    assert_eq!(urls, vec!["/b", "/c", "/a"]);
}

#[test]
fn list_history_respects_tab_filter() {
    let (_dir, conn) = open_test_db();
    insert_history(&conn, Some("tab-1"), None, "GET", "/x", Some(200), None, 1);
    insert_history(&conn, Some("tab-2"), None, "GET", "/y", Some(200), None, 2);

    let only_1 = list_history(
        &conn,
        &HistoryFilter {
            tab_id: Some("tab-1".to_string()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(only_1.len(), 1);
    assert_eq!(only_1[0].url, "/x");
}

#[test]
fn list_history_limit_and_offset_paginate_correctly() {
    let (_dir, conn) = open_test_db();
    for i in 0..5 {
        insert_history(&conn, None, None, "GET", &format!("/{i}"), Some(200), None, i);
    }
    let page1 = list_history(
        &conn,
        &HistoryFilter {
            limit: 2,
            offset: 0,
            ..Default::default()
        },
    )
    .unwrap();
    let page2 = list_history(
        &conn,
        &HistoryFilter {
            limit: 2,
            offset: 2,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(page1.len(), 2);
    assert_eq!(page2.len(), 2);
    assert_ne!(page1[0].id, page2[0].id);
}

#[test]
fn get_history_detail_returns_body_bytes() {
    let (_dir, conn) = open_test_db();
    let id = insert_history(
        &conn,
        None,
        None,
        "GET",
        "/x",
        Some(200),
        Some(b"hello"),
        0,
    );
    let detail = get_history_detail(&conn, &id).unwrap().unwrap();
    assert_eq!(detail.response_body.as_deref(), Some(b"hello".as_slice()));
}

#[test]
fn get_history_detail_missing_id_returns_none() {
    let (_dir, conn) = open_test_db();
    assert!(get_history_detail(&conn, "nonexistent").unwrap().is_none());
}

// ---- lookup_latest_response_body ----------------------------------------

#[test]
fn lookup_latest_picks_newest_successful_row() {
    let (_dir, conn) = open_test_db();
    let saved = save_request(
        &conn,
        NewSavedRequest {
            name: "probe",
            target_id: None,
            environment: None,
            method: "GET",
            url: "/probe",
            headers_json: "{}",
            query_json: "{}",
            body_kind: "none",
            body_text: None,
        },
    )
    .unwrap();
    insert_history(&conn, None, Some(&saved.id), "GET", "/probe", Some(200), Some(b"old"), 1);
    insert_history(&conn, None, Some(&saved.id), "GET", "/probe", Some(200), Some(b"newer"), 5);
    insert_history(&conn, None, Some(&saved.id), "GET", "/probe", Some(200), Some(b"mid"), 3);

    let body = lookup_latest_response_body(&conn, "probe").unwrap().unwrap();
    assert_eq!(body, b"newer");
}

#[test]
fn lookup_latest_skips_transport_failures() {
    let (_dir, conn) = open_test_db();
    let saved = save_request(
        &conn,
        NewSavedRequest {
            name: "probe",
            target_id: None,
            environment: None,
            method: "GET",
            url: "/probe",
            headers_json: "{}",
            query_json: "{}",
            body_kind: "none",
            body_text: None,
        },
    )
    .unwrap();
    // status=0 = transport failure; must not be picked even though it's newest.
    insert_history(&conn, None, Some(&saved.id), "GET", "/probe", Some(200), Some(b"ok"), 1);
    insert_history(&conn, None, Some(&saved.id), "GET", "/probe", Some(0), Some(b"fail"), 10);

    let body = lookup_latest_response_body(&conn, "probe").unwrap().unwrap();
    assert_eq!(body, b"ok");
}

#[test]
fn lookup_latest_returns_none_when_saved_has_no_history() {
    let (_dir, conn) = open_test_db();
    save_request(
        &conn,
        NewSavedRequest {
            name: "unsent",
            target_id: None,
            environment: None,
            method: "GET",
            url: "/x",
            headers_json: "{}",
            query_json: "{}",
            body_kind: "none",
            body_text: None,
        },
    )
    .unwrap();
    assert!(lookup_latest_response_body(&conn, "unsent").unwrap().is_none());
}

// ---- ${response.NAME.path} chaining resolver ----------------------------

fn ctx_with_response(name: &str, body: &[u8]) -> ResolverContext {
    let mut c = ResolverContext::default();
    c.insert_response(name, body);
    c
}

#[test]
fn chaining_extracts_top_level_string() {
    let ctx = ctx_with_response("probe", br#"{"id": "abc123"}"#);
    let out = resolve("/x/${response.probe.id}", &ctx).unwrap();
    assert_eq!(out, "/x/abc123");
}

#[test]
fn chaining_with_dollar_prefix() {
    let ctx = ctx_with_response("probe", br#"{"id": "abc"}"#);
    let out = resolve("${response.probe.$.id}", &ctx).unwrap();
    assert_eq!(out, "abc");
}

#[test]
fn chaining_with_array_index() {
    let ctx = ctx_with_response(
        "orgs",
        br#"[{"id":"L_1","name":"a"},{"id":"L_2","name":"b"}]"#,
    );
    let out = resolve("/networks?org=${response.orgs.[0].id}", &ctx).unwrap();
    assert_eq!(out, "/networks?org=L_1");
}

#[test]
fn chaining_numeric_values_are_stringified() {
    let ctx = ctx_with_response("probe", br#"{"count": 42}"#);
    let out = resolve("?c=${response.probe.count}", &ctx).unwrap();
    assert_eq!(out, "?c=42");
}

#[test]
fn chaining_missing_name_surfaces_as_unresolved() {
    let ctx = ResolverContext::default();
    let err = resolve("/${response.never-sent.id}", &ctx).unwrap_err();
    match err {
        ccie_terminal_lib::api_runner::resolver::ResolveError::Unresolved(names) => {
            assert!(names.iter().any(|n| n == "response.never-sent"));
        }
        other => panic!("expected Unresolved, got {other:?}"),
    }
}

#[test]
fn chaining_missing_path_leaves_literal() {
    // If the saved name IS resolved but the path inside doesn't match,
    // we keep the literal placeholder so the user sees what failed.
    let ctx = ctx_with_response("probe", br#"{"id":"abc"}"#);
    let out = resolve("/x/${response.probe.missing}", &ctx).unwrap();
    assert_eq!(out, "/x/${response.probe.missing}");
}

#[test]
fn chaining_with_non_json_body_still_works_as_string() {
    let ctx = ctx_with_response("probe", b"not valid json");
    // Whole body is exposed under root — the `/x/` prefix survives.
    let out = resolve("/x/${response.probe}", &ctx).unwrap();
    assert_eq!(out, "/x/not valid json");
}
