//! Plan 05 Phase 3 — snapshot CRUD over `parsed_snapshots`.

use ccie_terminal_lib::db;
use ccie_terminal_lib::structured::{auto_parse, snapshot};
use ccie_terminal_lib::structured::auto_parse::testing::FakeParser;
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use std::sync::Arc;
use tempfile::TempDir;

fn open_test_db() -> (TempDir, Arc<Mutex<Connection>>) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("t.db");
    let conn = db::open_and_migrate(&path).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
    (dir, Arc::new(Mutex::new(conn)))
}

fn seed_tab(db: &Arc<Mutex<Connection>>, tab_id: &str) {
    let conn = db.lock();
    conn.execute(
        "INSERT INTO tabs (id, title, shell_cmd, cwd) VALUES (?, 'tab', '/bin/zsh', '/')",
        params![tab_id],
    )
    .unwrap();
}

fn seed_block(db: &Arc<Mutex<Connection>>, tab_id: &str, cmd: &str, output: &str) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let conn = db.lock();
    conn.execute(
        "INSERT INTO command_blocks (id, tab_id, cmd, output, started_at, cwd)
         VALUES (?, ?, ?, ?, 1, '/')",
        params![id, tab_id, cmd, output],
    )
    .unwrap();
    id
}

async fn parse_block(
    db: &Arc<Mutex<Connection>>,
    tab_id: &str,
    cmd: &str,
    payload: &str,
) -> String {
    let bid = seed_block(db, tab_id, cmd, "raw…");
    let parser = FakeParser::new(payload);
    auto_parse::on_block_completed(db.clone(), &parser, &bid, "cisco", "iosxe")
        .await
        .unwrap();
    bid
}

#[tokio::test]
async fn snapshot_create_inserts_row_and_returns_id() {
    let (_dir, db) = open_test_db();
    seed_tab(&db, "t1");
    let bid = parse_block(&db, "t1", "show version", r#"{"v":"17.09"}"#).await;

    let id = {
        let conn = db.lock();
        snapshot::create(&conn, &bid, "before-change").unwrap()
    };
    assert!(id > 0);

    let conn = db.lock();
    let rows = snapshot::list_for_tab(&conn, "t1").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].name, "before-change");
    assert_eq!(rows[0].command, "show version");
}

#[tokio::test]
async fn snapshot_create_fails_for_unparsed_block() {
    let (_dir, db) = open_test_db();
    seed_tab(&db, "t1");
    let bid = seed_block(&db, "t1", "ls", "x");

    let conn = db.lock();
    let err = snapshot::create(&conn, &bid, "x").unwrap_err();
    assert!(err.to_string().contains("no parsed output"));
}

#[tokio::test]
async fn snapshot_list_orders_newest_first() {
    let (_dir, db) = open_test_db();
    seed_tab(&db, "t1");
    let b1 = parse_block(&db, "t1", "show version", r#"{}"#).await;
    let b2 = parse_block(&db, "t1", "show ip int br", r#"[{"i":"Gi1"}]"#).await;

    {
        let conn = db.lock();
        snapshot::create(&conn, &b1, "older").unwrap();
        // Force a different captured_at — increment by 1.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        snapshot::create(&conn, &b2, "newer").unwrap();
    }

    let conn = db.lock();
    let rows = snapshot::list_for_tab(&conn, "t1").unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].name, "newer", "newest first");
    assert_eq!(rows[1].name, "older");
}

#[tokio::test]
async fn snapshot_rename_updates_name() {
    let (_dir, db) = open_test_db();
    seed_tab(&db, "t1");
    let bid = parse_block(&db, "t1", "show version", r#"{}"#).await;

    let id = {
        let conn = db.lock();
        snapshot::create(&conn, &bid, "old-name").unwrap()
    };
    {
        let conn = db.lock();
        snapshot::rename(&conn, id, "renamed").unwrap();
    }
    let conn = db.lock();
    let rows = snapshot::list_for_tab(&conn, "t1").unwrap();
    assert_eq!(rows[0].name, "renamed");
}

#[tokio::test]
async fn snapshot_rename_errors_for_missing_id() {
    let (_dir, db) = open_test_db();
    let conn = db.lock();
    let err = snapshot::rename(&conn, 9999, "x").unwrap_err();
    assert!(err.to_string().contains("not found"));
}

#[tokio::test]
async fn snapshot_delete_removes_row_but_keeps_parsed_output() {
    let (_dir, db) = open_test_db();
    seed_tab(&db, "t1");
    let bid = parse_block(&db, "t1", "show version", r#"{}"#).await;
    let id = {
        let conn = db.lock();
        snapshot::create(&conn, &bid, "x").unwrap()
    };
    {
        let conn = db.lock();
        snapshot::delete(&conn, id).unwrap();
    }
    let conn = db.lock();
    let rows = snapshot::list_for_tab(&conn, "t1").unwrap();
    assert_eq!(rows.len(), 0);
    // parsed_outputs still present
    let parsed = auto_parse::get_parsed_output(&conn, &bid).unwrap();
    assert!(parsed.is_some());
}
