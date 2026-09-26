//! Coverage for per-device scope binding (Phase 4 Task 4.1).
//!
//! When the user opens the palette with scope = Device and an
//! activeDeviceId, blocks/commands are restricted to the set of tabs whose
//! `netconf_tab_state.device_id` matches.

use ccie_terminal_lib::db;
use ccie_terminal_lib::palette::sources::{blocks, commands, devices};
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

fn seed_device_setup(conn: &Connection) {
    // Two devices.
    conn.execute(
        "INSERT INTO netconf_devices (id, name, host, port, username, platform)
         VALUES (1, 'core1', '10.10.0.1', 830, 'admin', 'iosxe')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO netconf_devices (id, name, host, port, username, platform)
         VALUES (2, 'edge1', '10.10.0.2', 830, 'admin', 'junos')",
        [],
    )
    .unwrap();

    // Two tabs: t1 → device 1, t2 → device 2, t3 → no device.
    for t in ["t1", "t2", "t3"] {
        conn.execute(
            "INSERT INTO tabs (id, title, shell_cmd, cwd) VALUES (?, 'tab', '/bin/zsh', '/')",
            params![t],
        )
        .unwrap();
    }
    conn.execute(
        "INSERT INTO netconf_tab_state (tab_id, device_id, editor_mode, editor_content, target_datastore)
         VALUES ('t1', 1, 'raw_xml', '', 'running')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO netconf_tab_state (tab_id, device_id, editor_mode, editor_content, target_datastore)
         VALUES ('t2', 2, 'raw_xml', '', 'running')",
        [],
    )
    .unwrap();

    // Blocks distributed across the three tabs.
    conn.execute(
        "INSERT INTO command_blocks (id, tab_id, cmd, output, started_at)
         VALUES ('b-core', 't1', 'show ip core', '', strftime('%s','now'))",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO command_blocks (id, tab_id, cmd, output, started_at)
         VALUES ('b-edge', 't2', 'show ip edge', '', strftime('%s','now'))",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO command_blocks (id, tab_id, cmd, output, started_at)
         VALUES ('b-orphan', 't3', 'show ip orphan', '', strftime('%s','now'))",
        [],
    )
    .unwrap();
}

#[test]
fn blocks_device_scope_restricts_to_device_tabs() {
    let (_dir, conn) = open_test_db();
    seed_device_setup(&conn);

    let hits = blocks::search_with_device(
        &conn,
        "show",
        PaletteScope::Device,
        None,
        Some("1"),
        50,
    )
    .unwrap();
    let ids: Vec<&str> = hits.iter().map(|h| h.target_id.as_str()).collect();
    assert!(ids.contains(&"b-core"));
    assert!(!ids.contains(&"b-edge"));
    assert!(!ids.contains(&"b-orphan"));
}

#[test]
fn blocks_device_scope_with_no_device_id_returns_empty() {
    let (_dir, conn) = open_test_db();
    seed_device_setup(&conn);
    let hits = blocks::search_with_device(
        &conn,
        "show",
        PaletteScope::Device,
        None,
        None,
        50,
    )
    .unwrap();
    assert!(hits.is_empty());
}

#[test]
fn commands_device_scope_restricts_to_device_tabs() {
    let (_dir, conn) = open_test_db();
    seed_device_setup(&conn);

    let hits = commands::search(
        &conn,
        "show",
        PaletteScope::Device,
        None,
        Some("1"),
        50,
    )
    .unwrap();
    let titles: Vec<&str> = hits.iter().map(|h| h.title.as_str()).collect();
    assert!(titles.iter().any(|t| t.contains("core")));
    assert!(!titles.iter().any(|t| t.contains("edge")));
    assert!(!titles.iter().any(|t| t.contains("orphan")));
}

#[test]
fn devices_device_scope_returns_only_active_device() {
    let (_dir, conn) = open_test_db();
    seed_device_setup(&conn);
    let hits = devices::search(
        &conn,
        "",
        PaletteScope::Device,
        None,
        Some("2"),
        50,
    )
    .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].kind, PaletteKind::Device);
    assert_eq!(hits[0].title, "edge1");
}

#[test]
fn devices_global_scope_returns_all_devices() {
    let (_dir, conn) = open_test_db();
    seed_device_setup(&conn);
    let hits = devices::search(&conn, "", PaletteScope::Global, None, None, 50).unwrap();
    assert_eq!(hits.len(), 2);
}
