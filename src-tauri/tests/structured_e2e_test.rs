//! Plan 05 Phase 5 — canonical 8-show end-to-end exercise.
//!
//! Each fixture lives in `sidecar/tests/fixtures/show_outputs/<cmd>.golden.json`.
//! For every fixture:
//!   1. Seed a tab + block.
//!   2. Run the FakeParser-backed `auto_parse` to mimic a sidecar-driven parse.
//!   3. Pin a snapshot, run a perturbed parse + pin a 2nd snapshot.
//!   4. Call `diff_snapshots`; assert at least one Changed cell when perturbed,
//!      OR all-Unchanged when fixtures are identical.
//!
//! This is the closest we can get to a true E2E without a live sidecar; the
//! true Tauri + Playwright run requires a built binary and a mocked PTY,
//! which is out of scope for the in-repo test suite.

use ccie_terminal_lib::db;
use ccie_terminal_lib::structured::auto_parse::testing::FakeParser;
use ccie_terminal_lib::structured::{auto_parse, diff_snapshots, snapshot, DiffStatus};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::Arc;
use tempfile::TempDir;

fn open_test_db() -> (TempDir, Arc<Mutex<Connection>>) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("t.db");
    let conn = db::open_and_migrate(&path).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
    (dir, Arc::new(Mutex::new(conn)))
}

fn fixtures_dir() -> PathBuf {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    PathBuf::from(manifest_dir)
        .join("..")
        .join("sidecar")
        .join("tests")
        .join("fixtures")
        .join("show_outputs")
}

fn read_fixture(name: &str) -> serde_json::Value {
    let path = fixtures_dir().join(name);
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read fixture {}: {}", path.display(), e));
    serde_json::from_str(&raw).unwrap()
}

fn seed_tab(db: &Arc<Mutex<Connection>>, tab_id: &str) {
    let conn = db.lock();
    conn.execute(
        "INSERT OR IGNORE INTO tabs (id, title, shell_cmd, cwd) VALUES (?, 'tab', '/bin/zsh', '/')",
        params![tab_id],
    )
    .unwrap();
}

fn seed_block(db: &Arc<Mutex<Connection>>, tab_id: &str, cmd: &str) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let conn = db.lock();
    conn.execute(
        "INSERT INTO command_blocks (id, tab_id, cmd, output, started_at, cwd)
         VALUES (?, ?, ?, '', 1, '/')",
        params![id, tab_id, cmd],
    )
    .unwrap();
    id
}

async fn parse_and_pin(
    db: &Arc<Mutex<Connection>>,
    tab_id: &str,
    cmd: &str,
    payload: &serde_json::Value,
    snap_name: &str,
) -> i64 {
    let bid = seed_block(db, tab_id, cmd);
    let parser = FakeParser::new(&payload.to_string());
    auto_parse::on_block_completed(db.clone(), &parser, &bid, "cisco", "iosxe")
        .await
        .unwrap();
    let conn = db.lock();
    snapshot::create(&conn, &bid, snap_name).unwrap()
}

fn perturb(value: &serde_json::Value) -> serde_json::Value {
    // For list-of-dicts, mutate the first row's first non-key field;
    // for nested dicts, swap in a `__perturbed__: true` flag deep inside.
    if let Some(arr) = value.as_array() {
        let mut new = serde_json::json!([]);
        for (i, row) in arr.iter().enumerate() {
            let mut row_clone = row.clone();
            if i == 0 {
                if let Some(obj) = row_clone.as_object_mut() {
                    // Mutate the LAST string-valued field. (First field is
                    // typically the unique alignment key — leave it alone or
                    // diff_snapshots will treat the row as Removed/Added.)
                    let last_key = obj
                        .iter()
                        .filter(|(_, v)| v.is_string())
                        .map(|(k, _)| k.clone())
                        .next_back();
                    if let Some(k) = last_key {
                        obj.insert(k, serde_json::json!("PERTURBED"));
                    }
                }
            }
            new.as_array_mut().unwrap().push(row_clone);
        }
        new
    } else if let Some(obj) = value.as_object() {
        let mut clone = obj.clone();
        clone.insert("__perturbed__".into(), serde_json::json!(true));
        serde_json::Value::Object(clone)
    } else {
        value.clone()
    }
}

async fn round_trip(cmd: &str, fixture_name: &str) {
    let (_dir, db) = open_test_db();
    let tab = format!("t-{cmd}").replace(' ', "-");
    seed_tab(&db, &tab);

    let golden = read_fixture(fixture_name);
    let perturbed = perturb(&golden);

    // Snapshot a — original parse. Snapshot b — perturbed parse.
    let a = parse_and_pin(&db, &tab, cmd, &golden, "before").await;
    let b = parse_and_pin(&db, &tab, cmd, &perturbed, "after").await;

    let cells =
        diff_snapshots(a, b, db.clone()).unwrap_or_else(|e| panic!("diff failed for {cmd}: {e}"));

    assert!(!cells.is_empty(), "{cmd}: diff produced no rows");

    let any_change = cells
        .iter()
        .any(|c| !matches!(c.status, DiffStatus::Unchanged));
    assert!(
        any_change,
        "{cmd}: perturbed input did not produce any non-unchanged cell"
    );
}

#[tokio::test]
async fn show_version_round_trip() {
    round_trip("show version", "show_version.golden.json").await;
}

#[tokio::test]
async fn show_ip_interface_brief_round_trip() {
    round_trip(
        "show ip interface brief",
        "show_ip_interface_brief.golden.json",
    )
    .await;
}

#[tokio::test]
async fn show_ip_route_round_trip() {
    round_trip("show ip route", "show_ip_route.golden.json").await;
}

#[tokio::test]
async fn show_ip_bgp_summary_round_trip() {
    round_trip("show ip bgp summary", "show_ip_bgp_summary.golden.json").await;
}

#[tokio::test]
async fn show_interfaces_round_trip() {
    round_trip("show interfaces", "show_interfaces.golden.json").await;
}

#[tokio::test]
async fn show_vlan_brief_round_trip() {
    round_trip("show vlan brief", "show_vlan_brief.golden.json").await;
}

#[tokio::test]
async fn show_cdp_neighbors_round_trip() {
    round_trip("show cdp neighbors", "show_cdp_neighbors.golden.json").await;
}

#[tokio::test]
async fn show_running_config_round_trip() {
    round_trip("show running-config", "show_running_config.golden.json").await;
}
