//! Pre/post change-verification report builder.
//!
//! `ReportSummary` is the persisted shape of a `change_reports.summary_json`.
//! `ExpectedDelta` lets the engineer pre-declare deltas they expect (e.g.
//! "BGP neighbor 10.0.0.5 will go down — that's the change") so the report
//! re-classifies them as approved/green instead of red.

use serde::{Deserialize, Serialize};

use super::classifier::{ClassifiedDelta, Severity};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportSummary {
    pub pre_snapshot_id: String,
    pub post_snapshot_id: String,
    pub bundle_id: String,
    pub counts: SeverityCounts,
    pub deltas: Vec<ClassifiedDelta>,
    pub matched_approved: Vec<ApprovedMatch>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SeverityCounts {
    pub red: u32,
    pub yellow: u32,
    pub green: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpectedDelta {
    pub command_substring: String,
    pub path_substring: String,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovedMatch {
    pub delta_path: String,
    pub command: String,
    pub note: String,
}

/// Walk `deltas` and re-flag any whose (command, path) match an
/// `ExpectedDelta` substring pair as Green/approved. Returns the mutated
/// delta list and the list of approval matches.
pub fn reclassify_with_approvals(
    mut deltas: Vec<ClassifiedDelta>,
    approved: &[ExpectedDelta],
) -> (Vec<ClassifiedDelta>, Vec<ApprovedMatch>) {
    let mut matches = Vec::new();
    for d in deltas.iter_mut() {
        for a in approved {
            if a.command_substring.len() < 3 || a.path_substring.len() < 3 {
                continue;
            }
            if !d.command.contains(&a.command_substring) {
                continue;
            }
            if !path_matches_segment(&d.path, &a.path_substring) {
                continue;
            }
            d.severity = Severity::Green;
            d.message = format!("(approved) {}", a.note);
            matches.push(ApprovedMatch {
                delta_path: d.path.clone(),
                command: d.command.clone(),
                note: a.note.clone(),
            });
            break;
        }
    }
    (deltas, matches)
}

/// Match `needle` against `path` only if `needle` appears as one or more
/// contiguous segments of `path` (segments split on '/'). Prevents
/// false-positives like "10.0.0.5" matching "/10.0.0.50/state".
fn path_matches_segment(path: &str, needle: &str) -> bool {
    let segs: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    let needle_segs: Vec<&str> = needle.trim_start_matches('/').split('/').filter(|s| !s.is_empty()).collect();
    if needle_segs.is_empty() {
        return false;
    }
    if needle_segs.len() > segs.len() {
        return false;
    }
    segs.windows(needle_segs.len()).any(|w| w == needle_segs.as_slice())
}

pub fn count_severities(deltas: &[ClassifiedDelta]) -> SeverityCounts {
    let mut c = SeverityCounts::default();
    for d in deltas {
        match d.severity {
            Severity::Red => c.red += 1,
            Severity::Yellow => c.yellow += 1,
            Severity::Green => c.green += 1,
        }
    }
    c
}
