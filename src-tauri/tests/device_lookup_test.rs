//! Plan 13 Phase 3.2 — integration coverage for `topology::lookup`.
//!
//! These tests exercise the SQL UNION-priority logic against a fresh
//! migrated DB. They drive the underlying `lookup_device_by_ref`
//! function directly rather than the Tauri command (which requires a
//! full app context). The command in `commands/topology.rs` is a thin
//! wrapper that locks `state.db` and delegates here, so coverage of the
//! SQL semantics is sufficient for Phase 3.2.

use ccie_terminal_lib::db;
use ccie_terminal_lib::topology::{lookup, SavedDeviceLookup};
use rusqlite::{params, Connection};
use tempfile::TempDir;

fn open_test_db() -> (TempDir, Connection) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("t.db");
    let conn = db::open_and_migrate(&path).unwrap();
    (dir, conn)
}

fn seed_ssh(conn: &Connection, name: &str, host: &str) {
    conn.execute(
        "INSERT INTO ssh_connections(name, host, user, port) VALUES (?1, ?2, ?3, ?4)",
        params![name, host, "admin", 22],
    )
    .unwrap();
}

fn seed_netconf(conn: &Connection, name: &str, host: &str) {
    // netconf_devices requires name, host, username; port + platform default.
    conn.execute(
        "INSERT INTO netconf_devices(name, host, username) VALUES (?1, ?2, ?3)",
        params![name, host, "admin"],
    )
    .unwrap();
}

#[test]
fn lookup_returns_ssh_for_saved_ssh_host() {
    let (_dir, conn) = open_test_db();
    seed_ssh(&conn, "lab-r2", "10.0.0.2");

    let got = lookup::lookup_device_by_ref(&conn, "10.0.0.2").unwrap();
    assert_eq!(
        got,
        Some(SavedDeviceLookup {
            kind: "ssh".into(),
            device_ref: "10.0.0.2".into(),
        })
    );
}

#[test]
fn lookup_returns_netconf_for_saved_netconf_host() {
    let (_dir, conn) = open_test_db();
    seed_netconf(&conn, "lab-r3", "10.0.0.3");

    let got = lookup::lookup_device_by_ref(&conn, "10.0.0.3").unwrap();
    assert_eq!(
        got,
        Some(SavedDeviceLookup {
            kind: "netconf".into(),
            device_ref: "10.0.0.3".into(),
        })
    );
}

#[test]
fn lookup_returns_none_for_unknown_ref() {
    let (_dir, conn) = open_test_db();
    // Seed unrelated rows to make sure the WHERE clause filters correctly.
    seed_ssh(&conn, "lab-r2", "10.0.0.2");
    seed_netconf(&conn, "lab-r3", "10.0.0.3");

    let got = lookup::lookup_device_by_ref(&conn, "10.0.0.99").unwrap();
    assert_eq!(got, None);
}

#[test]
fn lookup_trims_whitespace_on_query_ref() {
    // CDP/LLDP normalizers should produce clean refs, but defensive
    // trimming protects against stray whitespace from any future caller.
    let (_dir, conn) = open_test_db();
    seed_ssh(&conn, "lab-r2", "10.0.0.2");

    let got = lookup::lookup_device_by_ref(&conn, "  10.0.0.2 ").unwrap();
    assert_eq!(
        got,
        Some(SavedDeviceLookup {
            kind: "ssh".into(),
            device_ref: "10.0.0.2".into(),
        }),
        "lookup_device_by_ref should trim whitespace before matching",
    );
}

#[test]
fn lookup_prefers_ssh_when_both_kinds_match() {
    // SSH is the primary interactive path; when the same host is saved
    // in both ssh_connections and netconf_devices, the SQL UNION ordering
    // (priority 1 = ssh, priority 2 = netconf) must surface the SSH row.
    let (_dir, conn) = open_test_db();
    seed_ssh(&conn, "lab-r4-ssh", "10.0.0.4");
    seed_netconf(&conn, "lab-r4-netconf", "10.0.0.4");

    let got = lookup::lookup_device_by_ref(&conn, "10.0.0.4").unwrap();
    assert_eq!(
        got,
        Some(SavedDeviceLookup {
            kind: "ssh".into(),
            device_ref: "10.0.0.4".into(),
        }),
        "click-to-SSH must stay predictable when a host is saved in both tables",
    );
}
