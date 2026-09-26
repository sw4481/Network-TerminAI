//! End-to-end Phase 3 test: run pre, run post (with a perturbed mock that
//! changes the BGP neighbor's state), run_post_and_report, assert at least
//! one red severity is surfaced and the report was persisted.

use ccie_terminal_lib::change_verify::classifier::{ClassifiedDelta, Severity};
use ccie_terminal_lib::change_verify::model::{NewCheckBundle, SnapshotLabel};
use ccie_terminal_lib::change_verify::report::{reclassify_with_approvals, ExpectedDelta};
use ccie_terminal_lib::change_verify::transport_mock::MockTransport;
use ccie_terminal_lib::change_verify::{bundles, runner};
use ccie_terminal_lib::db;
use ccie_terminal_lib::structured::auto_parse::testing::FakeParser;
use ccie_terminal_lib::structured::auto_parse::Parser;
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde_json::json;
use std::sync::Arc;
use tempfile::TempDir;

fn open_db() -> (TempDir, Arc<Mutex<Connection>>) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("t.db");
    let conn = db::open_and_migrate(&path).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
    (dir, Arc::new(Mutex::new(conn)))
}

fn seed_tab(conn: &Connection, tab_id: &str) {
    conn.execute(
        "INSERT INTO tabs(id,title,shell_cmd,cwd) VALUES (?1,'t','sh','/')",
        params![tab_id],
    )
    .unwrap();
}

#[tokio::test]
async fn pre_post_flow_detects_bgp_state_change() {
    let (_dir, db) = open_db();
    let bundle_id = {
        let mut c = db.lock();
        seed_tab(&c, "tab1");
        bundles::create(
            &mut c,
            NewCheckBundle {
                name: "bgp".into(),
                description: None,
                vendor: "cisco".into(),
                platform: "iosxe".into(),
                commands: vec!["show ip bgp summary".into()],
            },
        )
        .unwrap()
        .id
    };

    // Pre: neighbor Established
    let pre_mock = Arc::new(MockTransport::new("cisco", "iosxe"));
    pre_mock.set("show ip bgp summary", "raw-pre");
    let pre_parser: Arc<dyn Parser> = Arc::new(FakeParser::new(
        r#"[{"neighbor":"10.0.0.2","state":"Established"}]"#,
    ));
    let pre = runner::run_snapshot(
        db.clone(),
        pre_mock,
        pre_parser,
        "tab1",
        &bundle_id,
        SnapshotLabel::Pre,
    )
    .await
    .unwrap();

    // Post: same neighbor, state Active.
    let post_mock = Arc::new(MockTransport::new("cisco", "iosxe"));
    post_mock.set("show ip bgp summary", "raw-post");
    let post_parser: Arc<dyn Parser> = Arc::new(FakeParser::new(
        r#"[{"neighbor":"10.0.0.2","state":"Active"}]"#,
    ));

    let (report_id, summary, _created_at) = runner::run_post_and_report(
        db.clone(),
        post_mock,
        post_parser,
        "tab1",
        &bundle_id,
        &pre.id,
        vec![],
        Some("test change window".into()),
    )
    .await
    .unwrap();

    assert!(summary.counts.red >= 1, "expected at least one red, got {:?}", summary.counts);
    assert!(summary.deltas.iter().any(|d| d.family == "bgp-neighbor"));
    assert_eq!(summary.bundle_id, bundle_id);

    // Report row was persisted.
    let conn = db.lock();
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM change_reports WHERE id = ?1",
            params![&report_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);

    // get_report round-trips.
    let (rt_summary, rt_approved, _ts) = runner::get_report(&conn, &report_id).unwrap();
    assert_eq!(rt_summary.bundle_id, bundle_id);
    assert_eq!(rt_approved.len(), 0);
}

#[tokio::test]
async fn approvals_downgrade_red_to_green() {
    let (_dir, db) = open_db();
    let bundle_id = {
        let mut c = db.lock();
        seed_tab(&c, "tab1");
        bundles::create(
            &mut c,
            NewCheckBundle {
                name: "bgp".into(),
                description: None,
                vendor: "cisco".into(),
                platform: "iosxe".into(),
                commands: vec!["show ip bgp summary".into()],
            },
        )
        .unwrap()
        .id
    };

    let pre_mock = Arc::new(MockTransport::new("cisco", "iosxe"));
    pre_mock.set("show ip bgp summary", "raw-pre");
    let pre_parser: Arc<dyn Parser> = Arc::new(FakeParser::new(
        r#"[{"neighbor":"10.0.0.5","state":"Established"}]"#,
    ));
    let pre = runner::run_snapshot(
        db.clone(),
        pre_mock,
        pre_parser,
        "tab1",
        &bundle_id,
        SnapshotLabel::Pre,
    )
    .await
    .unwrap();

    let post_mock = Arc::new(MockTransport::new("cisco", "iosxe"));
    post_mock.set("show ip bgp summary", "raw-post");
    let post_parser: Arc<dyn Parser> = Arc::new(FakeParser::new(
        r#"[{"neighbor":"10.0.0.5","state":"Active"}]"#,
    ));

    let approved = vec![ExpectedDelta {
        command_substring: "bgp summary".into(),
        path_substring: "10.0.0.5".into(),
        note: "Expected — decommissioning peer".into(),
    }];

    let (_report_id, summary, _created_at) = runner::run_post_and_report(
        db.clone(),
        post_mock,
        post_parser,
        "tab1",
        &bundle_id,
        &pre.id,
        approved,
        None,
    )
    .await
    .unwrap();

    assert_eq!(summary.counts.red, 0, "approved delta should be green, not red");
    assert!(summary.counts.green >= 1);
    assert_eq!(summary.matched_approved.len(), 1);
    assert!(summary.matched_approved[0].note.contains("decommissioning"));
}

fn d(command: &str, path: &str) -> ClassifiedDelta {
    ClassifiedDelta {
        command: command.into(),
        family: "bgp-neighbor".into(),
        severity: Severity::Red,
        path: path.into(),
        before: json!({}),
        after: json!({}),
        message: "before".into(),
    }
}

#[test]
fn approval_does_not_match_substring_collision() {
    let deltas = vec![
        d("show ip bgp summary", "/10.0.0.5/state"),
        d("show ip bgp summary", "/10.0.0.50/state"),
    ];
    let approved = vec![ExpectedDelta {
        command_substring: "bgp summary".into(),
        path_substring: "10.0.0.5".into(),
        note: "expected".into(),
    }];
    let (out, matches) = reclassify_with_approvals(deltas, &approved);
    // Only the exact 10.0.0.5 should be approved; 10.0.0.50 stays red.
    let approved_paths: Vec<_> = matches.iter().map(|m| m.delta_path.as_str()).collect();
    assert_eq!(approved_paths, vec!["/10.0.0.5/state"]);
    assert_eq!(out.iter().filter(|x| x.severity == Severity::Red).count(), 1);
    assert_eq!(out.iter().filter(|x| x.severity == Severity::Green).count(), 1);
}

#[test]
fn approval_rejects_too_short_substring() {
    let deltas = vec![d("show ip bgp summary", "/10.0.0.5/state")];
    let approved = vec![ExpectedDelta {
        command_substring: "bg".into(), // 2 chars — below 3-char floor
        path_substring: "10.0.0.5".into(),
        note: "n".into(),
    }];
    let (out, matches) = reclassify_with_approvals(deltas, &approved);
    assert_eq!(matches.len(), 0);
    assert_eq!(out[0].severity, Severity::Red);
}

#[tokio::test]
async fn append_approval_persists_and_reclassifies() {
    let (_dir, db) = open_db();
    let bundle_id = {
        let mut c = db.lock();
        seed_tab(&c, "tab1");
        bundles::create(
            &mut c,
            NewCheckBundle {
                name: "bgp".into(),
                description: None,
                vendor: "cisco".into(),
                platform: "iosxe".into(),
                commands: vec!["show ip bgp summary".into()],
            },
        )
        .unwrap()
        .id
    };

    // Pre: neighbor Established
    let pre_mock = Arc::new(MockTransport::new("cisco", "iosxe"));
    pre_mock.set("show ip bgp summary", "raw-pre");
    let pre_parser: Arc<dyn Parser> = Arc::new(FakeParser::new(
        r#"[{"neighbor":"10.0.0.2","state":"Established"}]"#,
    ));
    let pre = runner::run_snapshot(
        db.clone(),
        pre_mock,
        pre_parser,
        "tab1",
        &bundle_id,
        SnapshotLabel::Pre,
    )
    .await
    .unwrap();

    // Post: neighbor state changed to Active.
    let post_mock = Arc::new(MockTransport::new("cisco", "iosxe"));
    post_mock.set("show ip bgp summary", "raw-post");
    let post_parser: Arc<dyn Parser> = Arc::new(FakeParser::new(
        r#"[{"neighbor":"10.0.0.2","state":"Active"}]"#,
    ));

    let (report_id, summary_v1, _created_at) = runner::run_post_and_report(
        db.clone(),
        post_mock,
        post_parser,
        "tab1",
        &bundle_id,
        &pre.id,
        vec![],
        None,
    )
    .await
    .unwrap();

    // Initial: at least 1 red.
    assert!(summary_v1.counts.red >= 1);

    // Append an approval that matches the red delta.
    let conn = db.lock();
    let approval = ExpectedDelta {
        command_substring: "bgp summary".into(),
        path_substring: "10.0.0.2".into(),
        note: "approved post-hoc".into(),
    };
    let (summary_v2, approved_v2) = runner::append_approval(&conn, &report_id, approval).unwrap();

    // After: 0 red, +1 green, approval list size 1.
    assert_eq!(summary_v2.counts.red, 0);
    assert!(summary_v2.counts.green >= 1);
    assert_eq!(approved_v2.len(), 1);
    assert!(approved_v2[0].note.contains("post-hoc"));

    // Reload from DB — should match summary_v2.
    let (reloaded, reloaded_approved, _) = runner::get_report(&conn, &report_id).unwrap();
    assert_eq!(reloaded.counts.red, summary_v2.counts.red);
    assert_eq!(reloaded_approved.len(), approved_v2.len());
}
