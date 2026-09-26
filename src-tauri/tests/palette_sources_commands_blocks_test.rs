//! Coverage for palette command + block source aggregators.

use ccie_terminal_lib::db;
use ccie_terminal_lib::palette::sources::{blocks, commands};
use ccie_terminal_lib::palette::types::{PaletteKind, PaletteScope};
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

fn seed_block(conn: &Connection, tab_id: &str, cmd: &str) -> String {
    let id = format!(
        "blk-{}-{}",
        tab_id,
        cmd.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>()
    );
    conn.execute(
        "INSERT INTO command_blocks (id, tab_id, cmd, output, started_at)
         VALUES (?, ?, ?, '', strftime('%s','now'))",
        params![id, tab_id, cmd],
    )
    .unwrap();
    id
}

fn seed_block_tag(conn: &Connection, block_id: &str, tag: &str) {
    conn.execute(
        "INSERT INTO block_tags (block_id, tag) VALUES (?, ?)",
        params![block_id, tag],
    )
    .unwrap();
}

#[test]
fn commands_source_returns_distinct_cmds_ranked_by_frequency() {
    let (_dir, conn) = open_test_db();
    seed_tab(&conn, "t1");
    seed_block(&conn, "t1", "show version");
    // Re-running the same cmd appends another block → freq increases.
    conn.execute(
        "INSERT INTO command_blocks (id, tab_id, cmd, output, started_at)
         VALUES ('b2', 't1', 'show version', '', strftime('%s','now') + 1)",
        [],
    )
    .unwrap();
    seed_block(&conn, "t1", "show ip route");

    let hits = commands::search(&conn, "show", PaletteScope::Global, None, None, 10).unwrap();
    assert!(hits.iter().all(|h| h.kind == PaletteKind::Command));

    let titles: Vec<&str> = hits.iter().map(|h| h.title.as_str()).collect();
    assert!(titles.contains(&"show version"));
    assert!(titles.contains(&"show ip route"));

    let sv_count = titles.iter().filter(|t| **t == "show version").count();
    assert_eq!(sv_count, 1, "must dedupe duplicate cmd values");

    // "show version" ran twice → must come before "show ip route".
    let pos_sv = titles.iter().position(|t| *t == "show version").unwrap();
    let pos_ipr = titles.iter().position(|t| *t == "show ip route").unwrap();
    assert!(pos_sv < pos_ipr, "more-frequent cmd outranks rarer cmd");
}

#[test]
fn commands_source_respects_tab_scope() {
    let (_dir, conn) = open_test_db();
    seed_tab(&conn, "t1");
    seed_tab(&conn, "t2");
    seed_block(&conn, "t1", "show run | i bgp");
    seed_block(&conn, "t2", "show run | i ospf");

    let hits =
        commands::search(&conn, "show run", PaletteScope::Tab, Some("t1"), None, 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert!(hits[0].title.contains("bgp"));
}

#[test]
fn commands_source_empty_query_lists_all_distinct() {
    let (_dir, conn) = open_test_db();
    seed_tab(&conn, "t1");
    seed_block(&conn, "t1", "show ver");
    seed_block(&conn, "t1", "show run");

    let hits = commands::search(&conn, "", PaletteScope::Global, None, None, 10).unwrap();
    assert_eq!(hits.len(), 2);
}

#[test]
fn blocks_source_matches_command_text() {
    let (_dir, conn) = open_test_db();
    seed_tab(&conn, "t1");
    let bid = seed_block(&conn, "t1", "show interfaces");

    let hits = blocks::search(&conn, "interfaces", PaletteScope::Global, None, 10).unwrap();
    assert!(!hits.is_empty());
    assert!(hits.iter().any(|h| h.target_id == bid));
    assert!(hits.iter().all(|h| h.kind == PaletteKind::Block));
}

#[test]
fn blocks_source_matches_tag_text() {
    let (_dir, conn) = open_test_db();
    seed_tab(&conn, "t1");
    let bid = seed_block(&conn, "t1", "show interfaces");
    seed_block_tag(&conn, &bid, "site-atl");

    let hits = blocks::search(&conn, "site-atl", PaletteScope::Global, None, 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].kind, PaletteKind::Block);
    assert_eq!(hits[0].target_id, bid);
}

#[test]
fn blocks_source_respects_tab_scope() {
    let (_dir, conn) = open_test_db();
    seed_tab(&conn, "t1");
    seed_tab(&conn, "t2");
    let _b1 = seed_block(&conn, "t1", "show run with bgp");
    let _b2 = seed_block(&conn, "t2", "show run with ospf");

    let hits = blocks::search(&conn, "show run", PaletteScope::Tab, Some("t1"), 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert!(hits[0].title.contains("bgp"));
}

#[test]
fn blocks_source_empty_query_returns_empty() {
    let (_dir, conn) = open_test_db();
    seed_tab(&conn, "t1");
    seed_block(&conn, "t1", "show ver");

    // FTS5 MATCH against "" is a syntax error — the source must short-circuit.
    let hits = blocks::search(&conn, "", PaletteScope::Global, None, 10).unwrap();
    assert!(hits.is_empty());
}
