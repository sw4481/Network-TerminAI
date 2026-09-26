//! Coverage for block_tags / block_pins / block_shares pure helpers.
//! Follows the api_runner/history.rs pattern: pure `&Connection` helpers
//! exercised with a fully-migrated tempdir DB.

use ccie_terminal_lib::commands::blocks::{
    add_tag, block_share_create_inner, block_share_fetch_inner, block_share_revoke_inner,
    blocks_by_tag_inner, list_pinned_inner, list_tags, pin_block, remove_tag,
    set_collapsed_inner, unpin_block, BlockDto,
};
use ccie_terminal_lib::db;
use rusqlite::{params, Connection};
use tempfile::TempDir;

fn open_test_db() -> (TempDir, Connection) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("t.db");
    let conn = db::open_and_migrate(&path).unwrap();
    // Some hosts default foreign_keys=ON. The production app does not rely on
    // FK enforcement (mirrors api_history_test.rs), so disable for determinism.
    conn.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
    (dir, conn)
}

fn seed_tab(conn: &Connection, tab_id: &str) {
    conn.execute(
        "INSERT INTO tabs (id, title, shell_cmd, cwd) VALUES (?, 'tab', '/bin/zsh', '/')",
        params![tab_id],
    )
    .unwrap();
}

fn seed_block(conn: &Connection, tab_id: &str, cmd: &str) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO command_blocks (id, tab_id, cmd, output, started_at, cwd)
         VALUES (?, ?, ?, '', 1, '/')",
        params![id, tab_id, cmd],
    )
    .unwrap();
    id
}

#[test]
fn tag_add_list_remove() {
    let (_dir, conn) = open_test_db();
    seed_tab(&conn, "tab1");
    let bid = seed_block(&conn, "tab1", "show run");

    add_tag(&conn, &bid, "site-atl").unwrap();
    add_tag(&conn, &bid, "golden").unwrap();
    let tags = list_tags(&conn, &bid).unwrap();
    assert_eq!(tags, vec!["golden".to_string(), "site-atl".to_string()]);

    remove_tag(&conn, &bid, "golden").unwrap();
    assert_eq!(list_tags(&conn, &bid).unwrap(), vec!["site-atl".to_string()]);
}

#[test]
fn tag_add_is_idempotent() {
    let (_dir, conn) = open_test_db();
    seed_tab(&conn, "tab1");
    let bid = seed_block(&conn, "tab1", "show run");

    add_tag(&conn, &bid, "x").unwrap();
    add_tag(&conn, &bid, "x").unwrap();
    assert_eq!(list_tags(&conn, &bid).unwrap(), vec!["x".to_string()]);
}

#[test]
fn blocks_by_tag_returns_only_matching_in_tab() {
    let (_dir, conn) = open_test_db();
    seed_tab(&conn, "tab1");
    seed_tab(&conn, "tab2");

    let b1 = seed_block(&conn, "tab1", "show ip");
    let b2 = seed_block(&conn, "tab1", "show ver");
    let b3 = seed_block(&conn, "tab2", "show run");

    add_tag(&conn, &b1, "golden").unwrap();
    add_tag(&conn, &b3, "golden").unwrap();
    add_tag(&conn, &b2, "experimental").unwrap();

    let golden_in_tab1 = blocks_by_tag_inner(&conn, "tab1", "golden").unwrap();
    let ids: Vec<&str> = golden_in_tab1.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(ids, vec![b1.as_str()]);
}

#[test]
fn pin_unpin_round_trip() {
    let (_dir, conn) = open_test_db();
    seed_tab(&conn, "tab1");
    let bid = seed_block(&conn, "tab1", "show run");

    pin_block(&conn, &bid, 0).unwrap();
    let pinned = list_pinned_inner(&conn, "tab1").unwrap();
    assert_eq!(pinned.len(), 1);
    assert_eq!(pinned[0].id, bid);

    unpin_block(&conn, &bid).unwrap();
    assert!(list_pinned_inner(&conn, "tab1").unwrap().is_empty());
}

#[test]
fn pinned_blocks_ordered_by_position_then_pinned_at() {
    let (_dir, conn) = open_test_db();
    seed_tab(&conn, "tab1");
    let b1 = seed_block(&conn, "tab1", "a");
    let b2 = seed_block(&conn, "tab1", "b");
    let b3 = seed_block(&conn, "tab1", "c");

    pin_block(&conn, &b1, 2).unwrap();
    pin_block(&conn, &b2, 0).unwrap();
    pin_block(&conn, &b3, 1).unwrap();

    let pinned = list_pinned_inner(&conn, "tab1").unwrap();
    let ids: Vec<&str> = pinned.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(ids, vec![b2.as_str(), b3.as_str(), b1.as_str()]);
}

#[test]
fn share_create_and_fetch_roundtrip() {
    let (_dir, conn) = open_test_db();
    seed_tab(&conn, "tab1");
    let bid = seed_block(&conn, "tab1", "show ver");

    let share_id = block_share_create_inner(&conn, &bid).unwrap();
    assert_eq!(share_id.len(), 36, "share id should be uuid");

    let dto: BlockDto = block_share_fetch_inner(&conn, &share_id).unwrap();
    assert_eq!(dto.id, bid);
    assert_eq!(dto.cmd, "show ver");
}

#[test]
fn collapsed_persists_round_trip() {
    let (_dir, conn) = open_test_db();
    seed_tab(&conn, "tab1");
    let bid = seed_block(&conn, "tab1", "show ver");

    set_collapsed_inner(&conn, &bid, true).unwrap();
    let collapsed: i64 = conn
        .query_row(
            "SELECT collapsed FROM command_blocks WHERE id = ?",
            params![bid],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(collapsed, 1);

    set_collapsed_inner(&conn, &bid, false).unwrap();
    let collapsed: i64 = conn
        .query_row(
            "SELECT collapsed FROM command_blocks WHERE id = ?",
            params![bid],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(collapsed, 0);
}

#[test]
fn share_survives_block_deletion() {
    let (_dir, conn) = open_test_db();
    seed_tab(&conn, "tab1");
    let bid = seed_block(&conn, "tab1", "show ver");
    let share_id = block_share_create_inner(&conn, &bid).unwrap();

    conn.execute("DELETE FROM command_blocks WHERE id = ?", params![bid])
        .unwrap();

    let dto = block_share_fetch_inner(&conn, &share_id).unwrap();
    assert_eq!(dto.cmd, "show ver");
}

#[test]
fn share_revoke_makes_fetch_fail() {
    let (_dir, conn) = open_test_db();
    seed_tab(&conn, "tab1");
    let bid = seed_block(&conn, "tab1", "show ver");

    // Create a share and confirm fetch succeeds.
    let share_id = block_share_create_inner(&conn, &bid).unwrap();
    let dto = block_share_fetch_inner(&conn, &share_id).unwrap();
    assert_eq!(dto.cmd, "show ver");

    // Revoke it.
    block_share_revoke_inner(&conn, &share_id).unwrap();

    // Subsequent fetch must fail (no row matches).
    let result = block_share_fetch_inner(&conn, &share_id);
    assert!(
        result.is_err(),
        "fetching a revoked share should return Err, got {:?}",
        result
    );

    // Revoking an already-revoked share is a no-op (idempotent).
    block_share_revoke_inner(&conn, &share_id).unwrap();
}

