use ccie_terminal_lib::{api_runner::history, db};
use tempfile::TempDir;

#[test]
fn v0086_preserves_native_saved_requests_with_safe_defaults() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("postman-v86.db");
    {
        let conn = db::open_and_migrate_to(&path, 85).unwrap();
        conn.execute(
            "INSERT INTO api_saved_requests
               (id, name, method, url)
             VALUES ('native', 'Native Request', 'GET', 'https://example.test')",
            [],
        )
        .unwrap();
    }

    let conn = db::open_and_migrate(&path).unwrap();
    let row: (Option<String>, String, String, String) = conn
        .query_row(
            "SELECT collection_id, folder_path, display_name, auth_json
               FROM api_saved_requests WHERE id = 'native'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        row,
        (
            None,
            String::new(),
            "Native Request".into(),
            "{\"type\":\"none\"}".into(),
        )
    );
    let collection_table: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
              WHERE type = 'table' AND name = 'api_request_collections'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(collection_table, 1);

    let native = history::save_request(
        &conn,
        history::NewSavedRequest {
            name: "New Native",
            target_id: None,
            environment: None,
            method: "GET",
            url: "https://example.test/new",
            headers_json: "{}",
            query_json: "{}",
            body_kind: "none",
            body_text: None,
        },
    )
    .unwrap();
    assert_eq!(native.display_name, "New Native");
    assert_eq!(native.auth_json, "{\"type\":\"none\"}");
    assert!(native.collection_id.is_none());
    assert!(native.collection_name.is_none());
}
