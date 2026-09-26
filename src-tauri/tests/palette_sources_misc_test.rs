//! Coverage for workflows / notebooks / devices / ssh palette sources.

use ccie_terminal_lib::db;
use ccie_terminal_lib::palette::sources::{devices, notebooks, ssh, workflows};
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

/// Open a DB at a specific schema version. Used to verify that sources tolerate
/// missing tables on partially-migrated DBs (e.g., before V0029 added `workflows`).
fn open_test_db_at(version: u32) -> (TempDir, Connection) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("t.db");
    let conn = db::open_and_migrate_to(&path, version).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
    (dir, conn)
}

#[test]
fn ssh_source_returns_connections_with_last_used_first() {
    let (_dir, conn) = open_test_db();
    conn.execute(
        "INSERT INTO ssh_connections (id, name, host, user, port, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?)",
        params!["c1", "core-sw1", "10.0.0.1", "admin", 22, 100],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO ssh_connections (id, name, host, user, port, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?)",
        params!["c2", "edge-rtr1", "10.0.0.2", "admin", 22, 500],
    )
    .unwrap();

    let hits = ssh::search(&conn, "", PaletteScope::Global, 10).unwrap();
    let names: Vec<String> = hits.iter().map(|h| h.title.clone()).collect();
    assert_eq!(names, vec!["edge-rtr1".to_string(), "core-sw1".to_string()]);
    assert!(hits.iter().all(|h| h.kind == PaletteKind::Ssh));
}

#[test]
fn ssh_source_filters_by_query() {
    let (_dir, conn) = open_test_db();
    conn.execute(
        "INSERT INTO ssh_connections (id, name, host, user, port)
         VALUES (?, ?, ?, ?, ?)",
        params!["c1", "core-sw1", "10.0.0.1", "admin", 22],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO ssh_connections (id, name, host, user, port)
         VALUES (?, ?, ?, ?, ?)",
        params!["c2", "edge-rtr1", "10.0.0.2", "admin", 22],
    )
    .unwrap();

    let hits = ssh::search(&conn, "edge", PaletteScope::Global, 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].title, "edge-rtr1");
}

#[test]
fn ssh_source_returns_empty_when_table_missing() {
    // V0023 is the last migration before V0024 added ssh_connections.
    let (_dir, conn) = open_test_db_at(23);
    let hits = ssh::search(&conn, "core", PaletteScope::Global, 10).unwrap();
    assert!(hits.is_empty());
}

#[test]
fn workflows_source_lists_matching() {
    let (_dir, conn) = open_test_db();
    conn.execute(
        "INSERT INTO workflows (id, name, description, vendor, platform)
         VALUES (?, ?, ?, ?, ?)",
        params!["wf1", "show-tech-light", "Light tech-support sweep", "cisco", "iosxe"],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO workflows (id, name, description, vendor, platform)
         VALUES (?, ?, ?, ?, ?)",
        params!["wf2", "ospf-neighbor-check", "Verify OSPF adjacency", "cisco", "iosxe"],
    )
    .unwrap();

    let hits = workflows::search(&conn, "ospf", PaletteScope::Global, None, None, 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].kind, PaletteKind::Workflow);
    assert_eq!(hits[0].title, "ospf-neighbor-check");
}

#[test]
fn workflows_source_empty_when_table_missing() {
    let (_dir, conn) = open_test_db_at(28);
    let hits =
        workflows::search(&conn, "anything", PaletteScope::Global, None, None, 10).unwrap();
    assert!(hits.is_empty(), "must feature-flag around missing table");
}

#[test]
fn notebooks_source_lists_matching() {
    let (_dir, conn) = open_test_db();
    conn.execute(
        "INSERT INTO notebooks (id, title, description, vendor, platform, body_markdown)
         VALUES (?, ?, ?, ?, ?, ?)",
        params!["nb1", "BGP Audit", "Audit eBGP neighbors", "cisco", "iosxe", "# md"],
    )
    .unwrap();
    let hits = notebooks::search(&conn, "BGP", PaletteScope::Global, None, None, 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].kind, PaletteKind::Notebook);
    assert_eq!(hits[0].title, "BGP Audit");
}

#[test]
fn notebooks_source_empty_when_table_missing() {
    // V0029 is the last migration before V0030 added notebooks.
    let (_dir, conn) = open_test_db_at(29);
    let hits = notebooks::search(&conn, "x", PaletteScope::Global, None, None, 10).unwrap();
    assert!(hits.is_empty());
}

#[test]
fn devices_source_lists_matching() {
    let (_dir, conn) = open_test_db();
    conn.execute(
        "INSERT INTO netconf_devices (name, host, port, username, platform)
         VALUES (?, ?, ?, ?, ?)",
        params!["core1", "10.10.0.1", 830, "netadmin", "iosxe"],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO netconf_devices (name, host, port, username, platform)
         VALUES (?, ?, ?, ?, ?)",
        params!["edge1", "10.10.0.2", 830, "netadmin", "junos"],
    )
    .unwrap();

    let hits = devices::search(&conn, "junos", PaletteScope::Global, None, None, 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].kind, PaletteKind::Device);
    assert_eq!(hits[0].title, "edge1");
}
