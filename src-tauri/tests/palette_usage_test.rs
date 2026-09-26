//! Coverage for palette_usage UPSERT semantics.

use ccie_terminal_lib::db;
use ccie_terminal_lib::palette::usage;
use rusqlite::Connection;
use tempfile::TempDir;

fn open_test_db() -> (TempDir, Connection) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("t.db");
    let conn = db::open_and_migrate(&path).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
    (dir, conn)
}

#[test]
fn record_use_upserts_and_increments() {
    let (_dir, conn) = open_test_db();
    usage::record(&conn, "block", "b1").unwrap();
    usage::record(&conn, "block", "b1").unwrap();
    usage::record(&conn, "block", "b1").unwrap();

    let row = usage::get(&conn, "block", "b1").unwrap().unwrap();
    assert_eq!(row.use_count, 3);
    assert!(row.last_used_at > 0);
    assert_eq!(row.target_type, "block");
    assert_eq!(row.target_id, "b1");
}

#[test]
fn record_use_different_ids_are_independent() {
    let (_dir, conn) = open_test_db();
    usage::record(&conn, "block", "b1").unwrap();
    usage::record(&conn, "block", "b2").unwrap();
    usage::record(&conn, "workflow", "b1").unwrap();

    assert_eq!(
        usage::get(&conn, "block", "b1").unwrap().unwrap().use_count,
        1
    );
    assert_eq!(
        usage::get(&conn, "block", "b2").unwrap().unwrap().use_count,
        1
    );
    assert_eq!(
        usage::get(&conn, "workflow", "b1")
            .unwrap()
            .unwrap()
            .use_count,
        1
    );
}

#[test]
fn map_for_type_keys_by_target_id() {
    let (_dir, conn) = open_test_db();
    usage::record(&conn, "ssh", "c1").unwrap();
    usage::record(&conn, "ssh", "c1").unwrap();
    usage::record(&conn, "ssh", "c2").unwrap();
    usage::record(&conn, "block", "b1").unwrap();

    let map = usage::map_for_type(&conn, "ssh").unwrap();
    assert_eq!(map.len(), 2);
    assert_eq!(map.get("c1").unwrap().use_count, 2);
    assert_eq!(map.get("c2").unwrap().use_count, 1);
    assert!(!map.contains_key("b1"), "must not bleed across types");
}

#[test]
fn get_returns_none_for_missing() {
    let (_dir, conn) = open_test_db();
    assert!(usage::get(&conn, "block", "nope").unwrap().is_none());
}

#[test]
fn trim_keeps_top_n_per_target_type() {
    let (_dir, conn) = open_test_db();
    // Seed 10 rows per type with descending last_used_at.
    for kind in ["block", "ssh", "command"] {
        for i in 0..10 {
            conn.execute(
                "INSERT INTO palette_usage (target_type, target_id, last_used_at, use_count)
                 VALUES (?, ?, ?, 1)",
                rusqlite::params![kind, format!("id-{i}"), 1000 - i as i64],
            )
            .unwrap();
        }
    }
    let total_before: i64 = conn
        .query_row("SELECT count(*) FROM palette_usage", [], |row| row.get(0))
        .unwrap();
    assert_eq!(total_before, 30);

    let deleted = usage::trim(&conn, 5).unwrap();
    assert_eq!(deleted, 15);

    // Each type now has exactly 5 rows, and they are the most recent 5.
    for kind in ["block", "ssh", "command"] {
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM palette_usage WHERE target_type = ?",
                rusqlite::params![kind],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 5, "{kind} should have 5 rows after trim");
        // The remaining ids are the freshest five (id-0..id-4).
        let oldest_kept: i64 = conn
            .query_row(
                "SELECT MIN(last_used_at) FROM palette_usage WHERE target_type = ?",
                rusqlite::params![kind],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(oldest_kept, 996);
    }
}

#[test]
fn trim_with_keep_zero_clears_the_table() {
    let (_dir, conn) = open_test_db();
    usage::record(&conn, "block", "b1").unwrap();
    let deleted = usage::trim(&conn, 0).unwrap();
    assert_eq!(deleted, 1);
    assert!(usage::get(&conn, "block", "b1").unwrap().is_none());
}

#[test]
fn trim_noop_when_under_limit() {
    let (_dir, conn) = open_test_db();
    usage::record(&conn, "block", "b1").unwrap();
    usage::record(&conn, "block", "b2").unwrap();
    let deleted = usage::trim(&conn, 100).unwrap();
    assert_eq!(deleted, 0);
}

#[test]
fn record_use_updates_last_used_at_each_time() {
    let (_dir, conn) = open_test_db();
    usage::record(&conn, "block", "b1").unwrap();
    let first = usage::get(&conn, "block", "b1")
        .unwrap()
        .unwrap()
        .last_used_at;
    // Sleep just over a second so strftime('%s','now') ticks.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    usage::record(&conn, "block", "b1").unwrap();
    let second = usage::get(&conn, "block", "b1")
        .unwrap()
        .unwrap()
        .last_used_at;
    assert!(
        second >= first,
        "last_used_at must be monotonic (got {first} then {second})"
    );
}
