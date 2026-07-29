//! Plan 06 Phase 2 Task 2.1 — orchestrator integration tests.
//!
//! Uses the real Plan 05 `auto_parse::testing::FakeParser` so we exercise
//! the full pipeline: transport mock → parse_and_store → parsed_outputs row →
//! change_snapshot_results row, all under transactional integrity.

use ccie_terminal_lib::change_verify::model::{NewCheckBundle, SnapshotLabel};
use ccie_terminal_lib::change_verify::transport_mock::MockTransport;
use ccie_terminal_lib::change_verify::{bundles, runner};
use ccie_terminal_lib::db;
use ccie_terminal_lib::structured::auto_parse::testing::FakeParser;
use ccie_terminal_lib::structured::auto_parse::Parser;
use parking_lot::Mutex as PlMutex;
use rusqlite::{params, Connection};
use std::sync::Arc;
use tempfile::TempDir;

fn open_db_arc() -> (TempDir, Arc<PlMutex<Connection>>) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("t.db");
    let conn = db::open_and_migrate(&path).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
    (dir, Arc::new(PlMutex::new(conn)))
}

fn seed_tab(db: &Connection, tab_id: &str) {
    db.execute(
        "INSERT INTO tabs(id,title,shell_cmd,cwd) VALUES (?1,'t','sh','/')",
        params![tab_id],
    )
    .unwrap();
}

#[tokio::test]
async fn run_pre_snapshot_happy_path() {
    let (_dir, db) = open_db_arc();
    let bundle_id = {
        let mut conn = db.lock();
        seed_tab(&conn, "tab1");
        bundles::create(
            &mut conn,
            NewCheckBundle {
                name: "t".into(),
                description: None,
                vendor: "cisco".into(),
                platform: "iosxe".into(),
                commands: vec![
                    "show ip interface brief".into(),
                    "show ip bgp summary".into(),
                ],
            },
        )
        .unwrap()
        .id
    };

    let mock = MockTransport::new("cisco", "iosxe");
    mock.set("show ip interface brief", "raw1");
    mock.set("show ip bgp summary", "raw2");

    let parser: Arc<dyn Parser> = Arc::new(FakeParser::new(r#"{"rows": []}"#));
    let snap = runner::run_snapshot(
        db.clone(),
        Arc::new(mock),
        parser,
        "tab1",
        &bundle_id,
        SnapshotLabel::Pre,
    )
    .await
    .unwrap();

    assert_eq!(snap.label, SnapshotLabel::Pre);
    assert_eq!(snap.results.len(), 2);

    // Each parsed_output_id must be a real row in parsed_outputs.
    let conn = db.lock();
    for r in &snap.results {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM parsed_outputs WHERE id = ?1",
                params![r.parsed_output_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(exists, 1, "parsed_outputs row missing for {}", r.command);
    }

    // change_snapshot_results rows persisted.
    let result_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM change_snapshot_results WHERE snapshot_id = ?1",
            params![&snap.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(result_count, 2);

    // get_snapshot round-trip.
    let fetched = runner::get_snapshot(&conn, &snap.id).unwrap();
    assert_eq!(fetched.results.len(), 2);
    assert_eq!(fetched.label, SnapshotLabel::Pre);
}

#[tokio::test]
async fn run_snapshot_fails_on_platform_mismatch() {
    let (_dir, db) = open_db_arc();
    let bundle_id = {
        let mut conn = db.lock();
        seed_tab(&conn, "tab1");
        bundles::create(
            &mut conn,
            NewCheckBundle {
                name: "t".into(),
                description: None,
                vendor: "cisco".into(),
                platform: "iosxe".into(),
                commands: vec!["show version".into()],
            },
        )
        .unwrap()
        .id
    };

    let mock = MockTransport::new("juniper", "junos");
    let parser: Arc<dyn Parser> = Arc::new(FakeParser::new("{}"));
    let err = runner::run_snapshot(
        db.clone(),
        Arc::new(mock),
        parser,
        "tab1",
        &bundle_id,
        SnapshotLabel::Pre,
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("does not match session"));

    // No snapshot row should have been written.
    let conn = db.lock();
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM change_snapshots", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn run_snapshot_rolls_back_on_mid_run_failure() {
    let (_dir, db) = open_db_arc();
    let bundle_id = {
        let mut conn = db.lock();
        seed_tab(&conn, "tab1");
        bundles::create(
            &mut conn,
            NewCheckBundle {
                name: "t".into(),
                description: None,
                vendor: "cisco".into(),
                platform: "iosxe".into(),
                commands: vec![
                    "show version".into(),
                    "show running-config".into(),
                    "show ip route".into(),
                ],
            },
        )
        .unwrap()
        .id
    };

    let mock = MockTransport::new("cisco", "iosxe");
    mock.set("show version", "v");
    // Deliberately leave "show running-config" unset so the second command fails.
    mock.set("show ip route", "r");

    let parser: Arc<dyn Parser> = Arc::new(FakeParser::new("{}"));
    let err = runner::run_snapshot(
        db.clone(),
        Arc::new(mock),
        parser,
        "tab1",
        &bundle_id,
        SnapshotLabel::Pre,
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("show running-config"));

    // Rollback: no snapshot row, no result rows, no parsed_outputs / blocks
    // from this run.
    let conn = db.lock();
    let snapshots: i64 = conn
        .query_row("SELECT COUNT(*) FROM change_snapshots", [], |r| r.get(0))
        .unwrap();
    assert_eq!(snapshots, 0, "snapshot row leaked through rollback");
    let results: i64 = conn
        .query_row("SELECT COUNT(*) FROM change_snapshot_results", [], |r| r.get(0))
        .unwrap();
    assert_eq!(results, 0, "result row leaked through rollback");
    let parsed: i64 = conn
        .query_row("SELECT COUNT(*) FROM parsed_outputs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(parsed, 0, "parsed_outputs row leaked through rollback");
}

#[tokio::test]
async fn latest_pre_for_tab_returns_most_recent() {
    let (_dir, db) = open_db_arc();
    let bundle_id = {
        let mut conn = db.lock();
        seed_tab(&conn, "tab1");
        bundles::create(
            &mut conn,
            NewCheckBundle {
                name: "t".into(),
                description: None,
                vendor: "cisco".into(),
                platform: "iosxe".into(),
                commands: vec!["show version".into()],
            },
        )
        .unwrap()
        .id
    };
    let parser: Arc<dyn Parser> = Arc::new(FakeParser::new("{}"));

    let mock1 = MockTransport::new("cisco", "iosxe");
    mock1.set("show version", "v1");
    let s1 = runner::run_snapshot(
        db.clone(),
        Arc::new(mock1),
        parser.clone(),
        "tab1",
        &bundle_id,
        SnapshotLabel::Pre,
    )
    .await
    .unwrap();
    std::thread::sleep(std::time::Duration::from_secs(1));
    let mock2 = MockTransport::new("cisco", "iosxe");
    mock2.set("show version", "v2");
    let s2 = runner::run_snapshot(
        db.clone(),
        Arc::new(mock2),
        parser,
        "tab1",
        &bundle_id,
        SnapshotLabel::Pre,
    )
    .await
    .unwrap();
    assert_ne!(s1.id, s2.id);
    let conn = db.lock();
    assert_eq!(
        runner::latest_pre_for_tab(&conn, "tab1", &bundle_id).unwrap(),
        Some(s2.id)
    );
}
