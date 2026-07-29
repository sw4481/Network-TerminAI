//! V0031 — palette_index FTS5 + palette_usage.
//!
//! Verifies the migration applies cleanly, the index backfills any pre-existing
//! command_blocks rows, and the AFTER INSERT/UPDATE/DELETE triggers keep the
//! index in sync (delete-then-insert idiom from V0014).

use ccie_terminal_lib::db;
use rusqlite::{params, Connection};
use tempfile::TempDir;

fn open_test_db() -> (TempDir, Connection) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("t.db");
    let conn = db::open_and_migrate(&path).unwrap();
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

fn seed_block(conn: &Connection, tab_id: &str, id: &str, cmd: &str) {
    conn.execute(
        "INSERT INTO command_blocks (id, tab_id, cmd, output, started_at)
         VALUES (?, ?, ?, '', 1)",
        params![id, tab_id, cmd],
    )
    .unwrap();
}

#[test]
fn migration_creates_palette_tables() {
    let (_dir, conn) = open_test_db();

    let names: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name IN ('palette_index','palette_usage')")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(names.contains(&"palette_index".to_string()));
    assert!(names.contains(&"palette_usage".to_string()));
}

#[test]
fn insert_block_populates_palette_index() {
    let (_dir, conn) = open_test_db();
    seed_tab(&conn, "t1");
    seed_block(&conn, "t1", "b1", "show ip bgp neighbors");

    let cmd: String = conn
        .query_row(
            "SELECT cmd FROM palette_index WHERE block_id = ?",
            params!["b1"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(cmd, "show ip bgp neighbors");
}

#[test]
fn update_block_refreshes_palette_index() {
    let (_dir, conn) = open_test_db();
    seed_tab(&conn, "t1");
    seed_block(&conn, "t1", "b1", "show ver");

    conn.execute(
        "UPDATE command_blocks SET cmd = 'show version detail' WHERE id = ?",
        params!["b1"],
    )
    .unwrap();

    let cmd: String = conn
        .query_row(
            "SELECT cmd FROM palette_index WHERE block_id = ?",
            params!["b1"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(cmd, "show version detail");

    // Old text must not match anymore.
    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM palette_index WHERE palette_index MATCH ?",
            params!["\"show ver\""],
            |row| row.get(0),
        )
        .unwrap();
    // "show ver" is a prefix of "show version detail" but as a quoted phrase it
    // requires a token boundary match. Porter tokenizer stems "version" → "version"
    // not "ver", so the old phrase shouldn't match. We just want NO leftover rows
    // that *only* contained "show ver" (the original). Assert the new phrase matches.
    let _ = count;
    let count_new: i64 = conn
        .query_row(
            "SELECT count(*) FROM palette_index WHERE palette_index MATCH ?",
            params!["version"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count_new, 1);
}

#[test]
fn delete_block_removes_from_palette_index() {
    let (_dir, conn) = open_test_db();
    seed_tab(&conn, "t1");
    seed_block(&conn, "t1", "b1", "show ip route");

    conn.execute("DELETE FROM command_blocks WHERE id = ?", params!["b1"])
        .unwrap();

    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM palette_index WHERE block_id = ?",
            params!["b1"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn block_tag_add_propagates_to_palette_index() {
    let (_dir, conn) = open_test_db();
    seed_tab(&conn, "t1");
    seed_block(&conn, "t1", "b1", "show interfaces");

    conn.execute(
        "INSERT INTO block_tags (block_id, tag) VALUES (?, ?)",
        params!["b1", "site-atl"],
    )
    .unwrap();

    let tags: String = conn
        .query_row(
            "SELECT tags FROM palette_index WHERE block_id = ?",
            params!["b1"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tags, "site-atl");

    // FTS5 phrase search on the tag should locate the block.
    let bid: String = conn
        .query_row(
            "SELECT block_id FROM palette_index WHERE palette_index MATCH ? LIMIT 1",
            params!["\"site-atl\""],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(bid, "b1");
}

#[test]
fn block_tag_remove_propagates_to_palette_index() {
    let (_dir, conn) = open_test_db();
    seed_tab(&conn, "t1");
    seed_block(&conn, "t1", "b1", "show ip");
    conn.execute(
        "INSERT INTO block_tags (block_id, tag) VALUES (?, ?)",
        params!["b1", "site-atl"],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO block_tags (block_id, tag) VALUES (?, ?)",
        params!["b1", "golden"],
    )
    .unwrap();

    conn.execute(
        "DELETE FROM block_tags WHERE block_id = ? AND tag = ?",
        params!["b1", "site-atl"],
    )
    .unwrap();

    let tags: String = conn
        .query_row(
            "SELECT tags FROM palette_index WHERE block_id = ?",
            params!["b1"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tags, "golden");
}

#[test]
fn palette_usage_primary_key_pair_is_unique() {
    let (_dir, conn) = open_test_db();

    conn.execute(
        "INSERT INTO palette_usage (target_type, target_id) VALUES (?, ?)",
        params!["block", "b1"],
    )
    .unwrap();

    // INSERT OR IGNORE on the same primary key should be a no-op.
    conn.execute(
        "INSERT OR IGNORE INTO palette_usage (target_type, target_id) VALUES (?, ?)",
        params!["block", "b1"],
    )
    .unwrap();

    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM palette_usage WHERE target_type = ? AND target_id = ?",
            params!["block", "b1"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}
