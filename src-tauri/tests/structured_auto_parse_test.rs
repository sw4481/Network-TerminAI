//! Plan 05 Phase 1 — auto_parse + parsed_outputs persistence.

use ccie_terminal_lib::db;
use ccie_terminal_lib::structured::auto_parse;
use ccie_terminal_lib::structured::auto_parse::testing::{FailingParser, FakeParser};
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

#[tokio::test]
async fn auto_parse_fires_only_for_show_commands() {
    let (_dir, db) = open_test_db();
    seed_tab(&db, "t1");
    let show_bid = seed_block(&db, "t1", "show version", "Cisco IOS XE 17.09.04");
    let noshow_bid = seed_block(&db, "t1", "configure terminal", "...");

    let parser = FakeParser::new(r#"{"version":"17.09.04"}"#);

    auto_parse::on_block_completed(db.clone(), &parser, &show_bid, "cisco", "iosxe")
        .await
        .unwrap();
    auto_parse::on_block_completed(db.clone(), &parser, &noshow_bid, "cisco", "iosxe")
        .await
        .unwrap();

    let conn = db.lock();
    let rows = auto_parse::list_parsed_outputs_for_tab(&conn, "t1").unwrap();
    assert_eq!(rows.len(), 1, "only the show block should have parsed output");
    assert_eq!(rows[0].block_id, show_bid);
    assert_eq!(rows[0].parser, "genie");
}

#[tokio::test]
async fn auto_parse_is_idempotent() {
    let (_dir, db) = open_test_db();
    seed_tab(&db, "t1");
    let bid = seed_block(&db, "t1", "show ip int br", "...");
    let parser = FakeParser::new(r#"[{"intf":"Gi1"}]"#);

    auto_parse::on_block_completed(db.clone(), &parser, &bid, "cisco", "iosxe")
        .await
        .unwrap();
    auto_parse::on_block_completed(db.clone(), &parser, &bid, "cisco", "iosxe")
        .await
        .unwrap();

    let conn = db.lock();
    let rows = auto_parse::list_parsed_outputs_for_tab(&conn, "t1").unwrap();
    assert_eq!(rows.len(), 1, "parsed_outputs has UNIQUE(block_id); second call updates in place");
}

#[tokio::test]
async fn auto_parse_skips_unknown_vendor() {
    let (_dir, db) = open_test_db();
    seed_tab(&db, "t1");
    let bid = seed_block(&db, "t1", "show version", "...");
    let parser = FakeParser::new(r#"{}"#);

    auto_parse::on_block_completed(db.clone(), &parser, &bid, "unknown", "unknown")
        .await
        .unwrap();
    auto_parse::on_block_completed(db.clone(), &parser, &bid, "", "iosxe")
        .await
        .unwrap();

    let conn = db.lock();
    let rows = auto_parse::list_parsed_outputs_for_tab(&conn, "t1").unwrap();
    assert_eq!(rows.len(), 0);
}

#[tokio::test]
async fn auto_parse_swallows_parser_errors() {
    let (_dir, db) = open_test_db();
    seed_tab(&db, "t1");
    let bid = seed_block(&db, "t1", "show foo", "...");

    auto_parse::on_block_completed(db.clone(), &FailingParser, &bid, "cisco", "iosxe")
        .await
        .expect("parser errors must not propagate");

    let conn = db.lock();
    let rows = auto_parse::list_parsed_outputs_for_tab(&conn, "t1").unwrap();
    assert_eq!(rows.len(), 0);
}

#[tokio::test]
async fn auto_parse_case_insensitive_show() {
    let (_dir, db) = open_test_db();
    seed_tab(&db, "t1");
    let bid = seed_block(&db, "t1", "  SHOW running-config  ", "Building configuration...");
    let parser = FakeParser::new(r#"{"hostname":"R1"}"#);

    auto_parse::on_block_completed(db.clone(), &parser, &bid, "cisco", "iosxe")
        .await
        .unwrap();

    let conn = db.lock();
    let row = auto_parse::get_parsed_output(&conn, &bid).unwrap().unwrap();
    assert_eq!(row.command, "SHOW running-config");
}
