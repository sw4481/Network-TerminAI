//! V0015 (NETCONF Runner) migration regression tests.

use ccie_terminal_lib::db;
use rusqlite::Connection;
use tempfile::TempDir;

fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table)).unwrap();
    let cols: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    cols.iter().any(|c| c == column)
}

fn has_table(conn: &Connection, table: &str) -> bool {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
            [table],
            |r| r.get(0),
        )
        .unwrap();
    n > 0
}

fn has_index(conn: &Connection, index: &str) -> bool {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?",
            [index],
            |r| r.get(0),
        )
        .unwrap();
    n > 0
}

#[test]
fn fresh_db_gets_all_netconf_tables() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("fresh.db");
    let conn = db::open_and_migrate(&db_path).expect("migrate");

    assert!(has_table(&conn, "netconf_tab_state"));
    assert!(has_table(&conn, "netconf_devices"));
    assert!(has_table(&conn, "netconf_saved_rpcs"));
    assert!(has_table(&conn, "netconf_history"));
    assert!(has_table(&conn, "yang_releases"));
    assert!(has_table(&conn, "yang_modules"));
}

#[test]
fn netconf_tab_state_has_expected_columns() {
    let dir = TempDir::new().unwrap();
    let conn = db::open_and_migrate(&dir.path().join("c.db")).unwrap();
    for col in [
        "tab_id",
        "device_id",
        "ad_hoc_host",
        "ad_hoc_port",
        "ad_hoc_username",
        "editor_mode",
        "editor_content",
        "target_datastore",
        "session_id",
    ] {
        assert!(has_column(&conn, "netconf_tab_state", col), "missing {col}");
    }
}

#[test]
fn netconf_history_index_exists() {
    let dir = TempDir::new().unwrap();
    let conn = db::open_and_migrate(&dir.path().join("c.db")).unwrap();
    assert!(has_index(&conn, "idx_nc_hist_tab"));
}

#[test]
fn cascading_delete_removes_netconf_tab_state() {
    let dir = TempDir::new().unwrap();
    let conn = db::open_and_migrate(&dir.path().join("c.db")).unwrap();
    conn.execute("PRAGMA foreign_keys = ON", []).unwrap();

    conn.execute(
        "INSERT INTO tabs (id, title, shell_cmd, cwd, tab_type) VALUES (?, ?, '', '', 'netconf')",
        rusqlite::params!["nc-1", "test"],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO netconf_tab_state (tab_id, editor_mode, editor_content, target_datastore) VALUES (?, 'raw_xml', '', 'running')",
        ["nc-1"],
    )
    .unwrap();

    conn.execute("DELETE FROM tabs WHERE id = ?", ["nc-1"]).unwrap();
    let remaining: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM netconf_tab_state WHERE tab_id = ?",
            ["nc-1"],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(remaining, 0);
}

#[test]
fn migration_is_idempotent() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("idempotent.db");
    {
        let _c = db::open_and_migrate(&db_path).unwrap();
    }
    let conn = db::open_and_migrate(&db_path).unwrap();
    assert!(has_table(&conn, "netconf_history"));
}
