//! Plan 05 (SSH-direct) — parse_and_store_adhoc lets the structured layer
//! parse output captured from an interactive SSH session, with no command
//! block created by the OSC-133 pipeline. A synthetic command_blocks row is
//! created so the result still flows through the Structured tab / snapshot /
//! diff UI unchanged.

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

#[tokio::test]
async fn adhoc_parse_persists_a_parsed_output_without_a_real_block() {
    let (_dir, db) = open_test_db();
    seed_tab(&db, "t1");
    let parser = FakeParser::new(r#"{"version":"17.09.04"}"#);

    let block_id = auto_parse::parse_and_store_adhoc(
        db.clone(),
        &parser,
        "t1",
        "show version",
        "Cisco IOS XE Software, Version 17.09.04",
        "cisco",
        "iosxe",
    )
    .await
    .expect("adhoc parse should succeed");

    let conn = db.lock();
    let rows = auto_parse::list_parsed_outputs_for_tab(&conn, "t1").unwrap();
    assert_eq!(rows.len(), 1, "one parsed output should be stored");
    assert_eq!(rows[0].block_id, block_id);
    assert_eq!(rows[0].command, "show version");
    assert_eq!(rows[0].parser, "genie");
}

#[tokio::test]
async fn adhoc_parse_result_is_fetchable_via_get_parsed_output() {
    let (_dir, db) = open_test_db();
    seed_tab(&db, "t1");
    let parser = FakeParser::new(r#"{"hostname":"R1"}"#);

    let block_id = auto_parse::parse_and_store_adhoc(
        db.clone(),
        &parser,
        "t1",
        "show running-config",
        "Building configuration...",
        "cisco",
        "iosxe",
    )
    .await
    .unwrap();

    let conn = db.lock();
    let row = auto_parse::get_parsed_output(&conn, &block_id)
        .unwrap()
        .expect("parsed output must be retrievable");
    assert_eq!(row.command, "show running-config");
    assert!(row.data_json.contains("R1"));
}

#[tokio::test]
async fn adhoc_parse_propagates_parser_errors() {
    // Unlike the block-completion hook (which swallows parser errors so it
    // never blocks a block from completing), the ad-hoc path is user-invoked
    // and should surface a parse failure so the UI can report it.
    let (_dir, db) = open_test_db();
    seed_tab(&db, "t1");

    let result = auto_parse::parse_and_store_adhoc(
        db.clone(),
        &FailingParser,
        "t1",
        "show foo",
        "garbage",
        "cisco",
        "iosxe",
    )
    .await;

    assert!(result.is_err(), "parser failure should propagate to caller");

    let conn = db.lock();
    let rows = auto_parse::list_parsed_outputs_for_tab(&conn, "t1").unwrap();
    assert_eq!(rows.len(), 0, "nothing should be stored on parse failure");
}

#[tokio::test]
async fn adhoc_synthetic_blocks_are_hidden_from_list_blocks() {
    // The synthetic block exists only to satisfy the parsed_outputs FK; it
    // must NOT appear in the tab's scrollback / block list alongside the
    // user's real shell commands.
    use ccie_terminal_lib::session;

    let (_dir, db) = open_test_db();
    seed_tab(&db, "t1");
    let parser = FakeParser::new(r#"{"v":"1"}"#);

    auto_parse::parse_and_store_adhoc(
        db.clone(), &parser, "t1", "show version", "out", "cisco", "iosxe",
    )
    .await
    .unwrap();

    let conn = db.lock();
    let blocks = session::list_blocks(&conn, "t1").unwrap();
    assert_eq!(
        blocks.len(),
        0,
        "synthetic ssh-adhoc block must be excluded from list_blocks"
    );
    let parsed = auto_parse::list_parsed_outputs_for_tab(&conn, "t1").unwrap();
    assert_eq!(parsed.len(), 1);
}

#[tokio::test]
async fn adhoc_parse_each_call_creates_a_distinct_block() {
    let (_dir, db) = open_test_db();
    seed_tab(&db, "t1");
    let parser = FakeParser::new(r#"{"ok":true}"#);

    let b1 = auto_parse::parse_and_store_adhoc(
        db.clone(), &parser, "t1", "show version", "out1", "cisco", "iosxe",
    )
    .await
    .unwrap();
    let b2 = auto_parse::parse_and_store_adhoc(
        db.clone(), &parser, "t1", "show version", "out2", "cisco", "iosxe",
    )
    .await
    .unwrap();

    assert_ne!(b1, b2, "each ad-hoc capture is its own synthetic block");
    let conn = db.lock();
    let rows = auto_parse::list_parsed_outputs_for_tab(&conn, "t1").unwrap();
    assert_eq!(rows.len(), 2);
}
