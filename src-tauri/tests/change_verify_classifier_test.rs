use ccie_terminal_lib::change_verify::classifier::{classify, ClassifierThresholds, Severity};
use ccie_terminal_lib::structured::diff::{CellDiff, DiffStatus};
use serde_json::json;

fn changed(
    row_key: &str,
    column: &str,
    before: serde_json::Value,
    after: serde_json::Value,
) -> CellDiff {
    CellDiff {
        row_key: row_key.into(),
        column: column.into(),
        status: DiffStatus::Changed,
        a: Some(before),
        b: Some(after),
    }
}

fn removed(row_key: &str) -> CellDiff {
    CellDiff {
        row_key: row_key.into(),
        column: String::new(),
        status: DiffStatus::Removed,
        a: Some(json!({})),
        b: None,
    }
}

#[test]
fn bgp_neighbor_drop_is_red() {
    let deltas = vec![removed("10.0.0.2")];
    let out = classify("show ip bgp summary", &deltas, &ClassifierThresholds::default());
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].severity, Severity::Red);
    assert!(out[0].message.contains("10.0.0.2"));
}

#[test]
fn bgp_state_change_to_active_is_red() {
    let deltas = vec![changed(
        "10.0.0.2",
        "state",
        json!("Established"),
        json!("Active"),
    )];
    let out = classify("show ip bgp summary", &deltas, &ClassifierThresholds::default());
    assert_eq!(out[0].severity, Severity::Red);
    assert!(out[0].message.contains("Active"));
}

#[test]
fn interface_goes_down_is_red() {
    let deltas = vec![changed("Gi0_1", "oper_status", json!("up"), json!("down"))];
    let out = classify(
        "show ip interface brief",
        &deltas,
        &ClassifierThresholds::default(),
    );
    assert_eq!(out[0].severity, Severity::Red);
}

#[test]
fn small_route_count_change_is_green() {
    let deltas = vec![changed("total", "", json!(1000), json!(1005))];
    let out = classify(
        "show ip route summary",
        &deltas,
        &ClassifierThresholds::default(),
    );
    assert_eq!(out[0].severity, Severity::Green);
}

#[test]
fn medium_route_count_change_is_yellow() {
    let deltas = vec![changed("total", "", json!(1000), json!(1100))];
    let out = classify(
        "show ip route summary",
        &deltas,
        &ClassifierThresholds::default(),
    );
    assert_eq!(out[0].severity, Severity::Yellow);
}

#[test]
fn big_route_count_change_is_red() {
    let deltas = vec![changed("total", "", json!(1000), json!(500))];
    let out = classify(
        "show ip route summary",
        &deltas,
        &ClassifierThresholds::default(),
    );
    assert_eq!(out[0].severity, Severity::Red);
}

#[test]
fn ospf_adjacency_not_full_is_red() {
    let deltas = vec![changed(
        "10.1.1.1",
        "state",
        json!("FULL/DR"),
        json!("INIT"),
    )];
    let out = classify(
        "show ip ospf neighbor",
        &deltas,
        &ClassifierThresholds::default(),
    );
    assert_eq!(out[0].severity, Severity::Red);
}

#[test]
fn cdp_neighbor_added_is_yellow() {
    let deltas = vec![CellDiff {
        row_key: "newdevice".into(),
        column: String::new(),
        status: DiffStatus::Added,
        a: None,
        b: Some(json!({"platform":"cisco"})),
    }];
    let out = classify(
        "show cdp neighbor",
        &deltas,
        &ClassifierThresholds::default(),
    );
    assert_eq!(out[0].severity, Severity::Yellow);
}

#[test]
fn unchanged_entries_are_dropped() {
    let deltas = vec![CellDiff {
        row_key: "x".into(),
        column: "y".into(),
        status: DiffStatus::Unchanged,
        a: Some(json!(1)),
        b: Some(json!(1)),
    }];
    let out = classify("show ip bgp summary", &deltas, &ClassifierThresholds::default());
    assert!(
        out.is_empty(),
        "Unchanged should not produce a ClassifiedDelta"
    );
}

#[test]
fn zero_to_nonzero_route_count_is_yellow() {
    let deltas = vec![changed("total", "", json!(0), json!(50))];
    let out = classify("show ip route summary", &deltas, &ClassifierThresholds::default());
    assert_eq!(out[0].severity, Severity::Yellow);
    assert!(out[0].message.contains("0 to 50"));
}

#[test]
fn bgp_counter_changes_are_filtered() {
    let deltas = vec![
        changed("10.0.0.2", "MsgRcvd", json!(1234), json!(5678)),
        changed("10.0.0.2", "MsgSent", json!(4321), json!(8765)),
        changed("10.0.0.2", "TblVer", json!(100), json!(150)),
        changed("10.0.0.2", "Up/Down", json!("1d00h"), json!("2d00h")),
        // A real material change — should survive.
        changed("10.0.0.2", "state", json!("Established"), json!("Active")),
    ];
    let out = classify("show ip bgp summary", &deltas, &ClassifierThresholds::default());
    // Only the state change should remain.
    assert_eq!(out.len(), 1);
    assert!(out[0].path.contains("state"));
    assert_eq!(out[0].severity, Severity::Red);
}

#[test]
fn ospf_timer_changes_are_filtered() {
    let deltas = vec![
        changed("10.1.1.1", "dead_time", json!("00:00:35"), json!("00:00:34")),
        changed("10.1.1.1", "hello_timer", json!("00:00:09"), json!("00:00:08")),
        // A real material change — should survive.
        changed("10.1.1.1", "state", json!("FULL/DR"), json!("INIT")),
    ];
    let out = classify("show ip ospf neighbor", &deltas, &ClassifierThresholds::default());
    // Only the state change should remain.
    assert_eq!(out.len(), 1);
    assert!(out[0].path.contains("state"));
    assert_eq!(out[0].severity, Severity::Red);
}

#[test]
fn cdp_hold_time_changes_are_filtered() {
    // Nested-dict diff shape: column is "value", the field name is the last
    // dotted segment of row_key. hold_time is a liveness countdown — noise.
    let deltas = vec![
        changed("cdp.index.1.hold_time", "value", json!(155), json!(153)),
        changed("cdp.index.2.hold_time", "value", json!(142), json!(134)),
        changed("cdp.index.3.hold_time", "value", json!(170), json!(178)),
    ];
    let out = classify("show cdp neighbor", &deltas, &ClassifierThresholds::default());
    assert!(
        out.is_empty(),
        "CDP hold_time ticks should be filtered, got {out:?}"
    );
}

#[test]
fn route_summary_memory_and_overhead_are_filtered() {
    // Byte-accounting fields are derived from route counts and carry no
    // independent signal. Only the subnet/route counts should survive.
    let deltas = vec![
        changed(
            "vrf.default.route_source.static.memory_bytes",
            "value",
            json!(624),
            json!(312),
        ),
        changed(
            "vrf.default.route_source.static.overhead",
            "value",
            json!(224),
            json!(112),
        ),
        changed(
            "vrf.default.total_route_source.memory_bytes",
            "value",
            json!(7688),
            json!(7296),
        ),
        // The real change: a static subnet was removed (1 → 0).
        changed(
            "vrf.default.route_source.static.subnets",
            "value",
            json!(1),
            json!(0),
        ),
    ];
    let out = classify(
        "show ip route summary",
        &deltas,
        &ClassifierThresholds::default(),
    );
    assert_eq!(
        out.len(),
        1,
        "only the subnet count change should survive, got {out:?}"
    );
    assert!(out[0].path.contains("static.subnets"));
    // 1 → 0 is a 100% change → Red.
    assert_eq!(out[0].severity, Severity::Red);
}
