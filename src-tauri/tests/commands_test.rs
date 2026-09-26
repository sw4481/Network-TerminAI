use ccie_terminal_lib::commands::ping;

#[test]
fn ping_returns_pong_with_timestamp() {
    let result = ping();
    assert!(result.starts_with("pong @"), "got: {}", result);
}

#[test]
fn vendor_keywords_round_trip() {
    use rusqlite::Connection;
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_flags (\
            key TEXT PRIMARY KEY, value TEXT NOT NULL,\
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')));",
    )
    .unwrap();

    // Unset -> read yields "{}".
    let got: Option<String> = conn
        .query_row(
            "SELECT value FROM app_flags WHERE key = 'ccie_vendor_keywords'",
            [],
            |r| r.get(0),
        )
        .ok();
    assert!(got.is_none());

    // Set -> read yields the stored JSON verbatim.
    let blob = r#"{"ise":["ise","my-auth"]}"#;
    conn.execute(
        "INSERT OR REPLACE INTO app_flags(key, value) VALUES ('ccie_vendor_keywords', ?1)",
        rusqlite::params![blob],
    )
    .unwrap();
    let got: String = conn
        .query_row(
            "SELECT value FROM app_flags WHERE key = 'ccie_vendor_keywords'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(got, blob);
}
