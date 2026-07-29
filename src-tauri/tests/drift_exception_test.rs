use ccie_terminal_lib::drift::exception::{apply_exceptions, DriftExceptionRepo};
use ccie_terminal_lib::drift::diff::{DriftPatch, DriftBlock, DriftSeverity, LineChange, DriftStats};
use ccie_terminal_lib::drift::intent::MatchMode;
use std::collections::HashSet;

fn patch_with_two_deltas() -> DriftPatch {
    DriftPatch {
        status: "drift".into(),
        severity: DriftSeverity::Destructive,
        stats: DriftStats { additions: 1, deletions: 1, blocks_changed: 1 },
        blocks: vec![DriftBlock {
            block_path: "router eigrp 10".into(),
            severity: DriftSeverity::Destructive,
            changes: vec![
                LineChange::Insert { line: "passive-interface default".into() },
                LineChange::Delete { line: "metric weights 0 1 2 3 4 5".into() },
            ],
        }],
    }
}

#[test]
fn excepted_line_is_removed_and_status_recomputed() {
    let mut p = patch_with_two_deltas();
    let mut ex = HashSet::new();
    ex.insert("passive-interface default".to_string());
    ex.insert("metric weights 0 1 2 3 4 5".to_string());
    apply_exceptions(&mut p, &ex, MatchMode::Partial);
    assert_eq!(p.status, "in_sync", "all deltas excepted → in_sync");
    assert_eq!(p.severity, DriftSeverity::None);
    assert!(p.blocks.is_empty());
    assert_eq!(p.stats.additions, 0);
    assert_eq!(p.stats.deletions, 0);
}

#[test]
fn partial_exception_downgrades_severity() {
    let mut p = patch_with_two_deltas();
    let mut ex = HashSet::new();
    // Except only the Insert (Missing). A Delete (Changed) remains → additive.
    ex.insert("passive-interface default".to_string());
    apply_exceptions(&mut p, &ex, MatchMode::Partial);
    assert_eq!(p.status, "drift");
    assert_eq!(p.severity, DriftSeverity::Additive);
    assert_eq!(p.stats.additions, 0);
    assert_eq!(p.stats.deletions, 1);
}

#[test]
fn baseline_mode_keeps_delete_as_destructive() {
    // Baseline: a LineChange::Delete (device has a line intent lacks) is the
    // serious case → Destructive. Exception filtering must NOT invert this.
    let mut p = DriftPatch {
        status: "drift".into(),
        severity: DriftSeverity::Destructive,
        stats: DriftStats { additions: 0, deletions: 2, blocks_changed: 1 },
        blocks: vec![DriftBlock {
            block_path: "router bgp 65000".into(),
            severity: DriftSeverity::Destructive,
            changes: vec![
                LineChange::Delete { line: "neighbor 10.0.0.1 shutdown".into() },
                LineChange::Delete { line: "neighbor 10.0.0.2 shutdown".into() },
            ],
        }],
    };
    let mut ex = HashSet::new();
    ex.insert("neighbor 10.0.0.1 shutdown".to_string());
    apply_exceptions(&mut p, &ex, MatchMode::Baseline);
    // One Delete remains → still Destructive in baseline mode.
    assert_eq!(p.status, "drift");
    assert_eq!(p.severity, DriftSeverity::Destructive, "baseline Delete must stay destructive");
    assert_eq!(p.stats.deletions, 1);
    assert_eq!(p.stats.additions, 0);
}

#[test]
fn repo_roundtrip() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE intent_drift_exceptions (id TEXT PRIMARY KEY, template_id TEXT NOT NULL,
         line TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL DEFAULT 0);",
    ).unwrap();
    let e = DriftExceptionRepo::add(&conn, "t1", "ntp clock-period 17179869", Some("known noise")).unwrap();
    let lines = DriftExceptionRepo::active_lines(&conn, "t1").unwrap();
    assert!(lines.contains("ntp clock-period 17179869"));
    DriftExceptionRepo::delete(&conn, &e.id).unwrap();
    assert!(DriftExceptionRepo::active_lines(&conn, "t1").unwrap().is_empty());
}
