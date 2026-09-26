//! Classifies cell-level deltas (from Plan 05's diff engine) into red/yellow/green
//! severities using per-command-family rules. Drops `Unchanged` entries.

use serde::{Deserialize, Serialize};

use super::command_family::{classify_command, family_name, CommandFamily};
use crate::structured::diff::{CellDiff, DiffStatus};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Red,
    Yellow,
    Green,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassifiedDelta {
    pub command: String,
    pub family: String,
    pub severity: Severity,
    pub path: String,
    pub before: serde_json::Value,
    pub after: serde_json::Value,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct ClassifierThresholds {
    pub route_count_yellow_pct: f64,
}

impl Default for ClassifierThresholds {
    fn default() -> Self {
        Self {
            route_count_yellow_pct: 10.0,
        }
    }
}

/// Build a path string from a CellDiff. For list-of-dicts diffs, row_key is
/// the alignment key value (e.g. "10.0.0.2") and column is the field name
/// (e.g. "state") → path = "/10.0.0.2/state". For nested-dict diffs, row_key
/// is the dotted path and column is empty → path = "/some/nested/key".
fn cell_path(d: &CellDiff) -> String {
    if d.column.is_empty() {
        format!("/{}", d.row_key.trim_start_matches('/'))
    } else {
        format!("/{}/{}", d.row_key.trim_start_matches('/'), d.column)
    }
}

/// The semantic field name a delta refers to. For list-of-dicts diffs that's
/// `column` (e.g. "state"). For nested-dict diffs `column` is always "value"
/// and the real field name is the last dotted segment of `row_key`
/// (e.g. "cdp.index.1.hold_time" → "hold_time",
/// "vrf.default.route_source.static.memory_bytes" → "memory_bytes").
fn effective_field(d: &CellDiff) -> &str {
    if d.column.is_empty() || d.column == "value" {
        d.row_key.rsplit('.').next().unwrap_or(&d.row_key)
    } else {
        &d.column
    }
}

/// Counters / liveness fields that tick on every poll and have no semantic
/// meaning for change-verification. Drop these before emitting a delta so
/// long change windows don't flood reports with mechanical-counter noise.
fn is_ignorable_counter(family: CommandFamily, field: &str) -> bool {
    let c = field.to_lowercase();
    match family {
        CommandFamily::BgpNeighbor => matches!(
            c.as_str(),
            "msgrcvd" | "msgsent" | "msg_received" | "msg_sent"
            | "tblver" | "tbl_ver" | "table_version"
            | "uptime" | "up_down" | "up/down"
            | "inq" | "outq" | "in_q" | "out_q"
        ),
        CommandFamily::OspfNeighbor => matches!(
            c.as_str(),
            "dead_time" | "deadtime" | "hello_timer" | "uptime"
        ),
        // hold_time is a liveness countdown advertised by each neighbor; it
        // ticks between every poll and says nothing about a config change.
        CommandFamily::CdpNeighbor => matches!(c.as_str(), "hold_time" | "holdtime"),
        // Byte-accounting fields are derived purely from route counts, so a
        // count change already reports the real signal. Emitting these too
        // just triples the noise (memory_bytes + overhead + the count itself).
        CommandFamily::RouteSummary => matches!(c.as_str(), "memory_bytes" | "overhead"),
        _ => false,
    }
}

fn json_or_null(v: &Option<serde_json::Value>) -> serde_json::Value {
    v.clone().unwrap_or(serde_json::Value::Null)
}

pub fn classify(
    command: &str,
    deltas: &[CellDiff],
    th: &ClassifierThresholds,
) -> Vec<ClassifiedDelta> {
    let family = classify_command(command);
    deltas
        .iter()
        .filter(|d| d.status != DiffStatus::Unchanged)
        .filter(|d| !is_ignorable_counter(family, effective_field(d)))
        .map(|d| {
            let path = cell_path(d);
            let before = json_or_null(&d.a);
            let after = json_or_null(&d.b);
            let (severity, message) = severity_for(family, d, &path, &before, &after, th);
            ClassifiedDelta {
                command: command.into(),
                family: family_name(family).into(),
                severity,
                path,
                before,
                after,
                message,
            }
        })
        .collect()
}

fn severity_for(
    family: CommandFamily,
    d: &CellDiff,
    path: &str,
    before: &serde_json::Value,
    after: &serde_json::Value,
    th: &ClassifierThresholds,
) -> (Severity, String) {
    use serde_json::Value;
    match family {
        CommandFamily::InterfaceStatus => {
            if d.column == "oper_status" || d.column == "status" {
                if let Value::String(after_s) = after {
                    let a = after_s.to_lowercase();
                    if a == "down" || a == "administratively down" || a == "admin-down" {
                        return (
                            Severity::Red,
                            format!(
                                "Interface {} went to {} (was {:?})",
                                d.row_key, after_s, before
                            ),
                        );
                    }
                }
            }
            (
                Severity::Yellow,
                format!("Interface metadata changed at {path}"),
            )
        }
        CommandFamily::BgpNeighbor => {
            if d.status == DiffStatus::Removed {
                return (
                    Severity::Red,
                    format!("BGP neighbor {} disappeared", d.row_key),
                );
            }
            if d.column == "state"
                || d.column == "session_state"
                || d.column.contains("state_pfxrcd")
            {
                if let Value::String(after_s) = after {
                    let ok_state = matches!(
                        after_s.as_str(),
                        "Established" | "established" | "Estab"
                    );
                    let is_numeric_pfx = after_s.parse::<u64>().is_ok();
                    if !ok_state && !is_numeric_pfx {
                        return (
                            Severity::Red,
                            format!("BGP neighbor {} state is now {}", d.row_key, after_s),
                        );
                    }
                }
            }
            (
                Severity::Yellow,
                format!("BGP counter changed at {path}"),
            )
        }
        CommandFamily::OspfNeighbor => {
            if d.status == DiffStatus::Removed {
                return (
                    Severity::Red,
                    format!("OSPF adjacency lost: {}", d.row_key),
                );
            }
            if d.column == "state" {
                if let Value::String(after_s) = after {
                    if !after_s.contains("FULL") {
                        return (
                            Severity::Red,
                            format!("OSPF neighbor {} not FULL: {}", d.row_key, after_s),
                        );
                    }
                }
            }
            (Severity::Yellow, format!("OSPF state change at {path}"))
        }
        CommandFamily::RouteSummary => {
            if let (Value::Number(b), Value::Number(a)) = (before, after) {
                let bv = b.as_f64().unwrap_or(0.0);
                let av = a.as_f64().unwrap_or(0.0);
                if bv > 0.0 {
                    let pct = ((av - bv).abs() / bv) * 100.0;
                    if pct >= th.route_count_yellow_pct * 2.0 {
                        return (
                            Severity::Red,
                            format!("Route count at {path} changed by {pct:.1}% ({b} → {a})"),
                        );
                    }
                    if pct >= th.route_count_yellow_pct {
                        return (
                            Severity::Yellow,
                            format!("Route count at {path} changed by {pct:.1}% ({b} → {a})"),
                        );
                    }
                } else if av > 0.0 {
                    // Routes appeared from a zero baseline — still notable.
                    return (
                        Severity::Yellow,
                        format!("Route count at {path} went from 0 to {a}"),
                    );
                }
            }
            (
                Severity::Green,
                format!("Route-summary delta at {path} within tolerance"),
            )
        }
        CommandFamily::CdpNeighbor => {
            if d.status == DiffStatus::Removed {
                return (
                    Severity::Red,
                    format!("CDP neighbor lost: {}", d.row_key),
                );
            }
            if d.status == DiffStatus::Added {
                return (
                    Severity::Yellow,
                    format!("New CDP neighbor appeared: {}", d.row_key),
                );
            }
            (
                Severity::Yellow,
                format!("CDP attribute changed at {path}"),
            )
        }
        CommandFamily::Unknown => (Severity::Yellow, format!("Unclassified delta at {path}")),
    }
}
