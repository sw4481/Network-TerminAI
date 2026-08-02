//! Structured diff engine on top of the `similar` crate.
//!
//! Produces a `DriftPatch` that the UI can render as a tree of changed
//! blocks (interface, router-bgp, acl, …) with severity tags. Severity
//! follows a simple rule:
//!
//! - `none`        — no changes detected
//! - `additive`    — only insertions (intent contains lines not on device)
//! - `destructive` — at least one deletion (device has config the intent
//!                   does NOT have, OR a value differs)
//! - `error`       — diff failed (set by callers, never produced here)

use serde::{Deserialize, Serialize};
use similar::{ChangeTag, TextDiff};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DriftSeverity {
    None,
    Additive,
    Destructive,
    Error,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "tag", rename_all = "lowercase")]
pub enum LineChange {
    Equal { line: String },
    Insert { line: String },
    Delete { line: String },
}

impl LineChange {
    pub fn line(&self) -> &str {
        match self {
            LineChange::Equal { line }
            | LineChange::Insert { line }
            | LineChange::Delete { line } => line.as_str(),
        }
    }
}

/// One contiguous group of changes (with optional context). The block path
/// is the nearest "section header" line above this group — for IOS-like
/// configs that's the `interface ...` / `router bgp ...` / `ip access-list`
/// line; for Junos, the curly-brace stanza.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct DriftBlock {
    pub block_path: String,
    pub changes: Vec<LineChange>,
    pub severity: DriftSeverity,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct DriftPatch {
    pub status: String, // "in_sync" | "drift"
    pub severity: DriftSeverity,
    pub blocks: Vec<DriftBlock>,
    pub stats: DriftStats,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct DriftStats {
    pub additions: usize,
    pub deletions: usize,
    pub blocks_changed: usize,
}

const CONTEXT_LINES: usize = 2;

/// Diff intent (left side, "what we want") against running config
/// (right side, "what's actually there").
///
/// Insertions = lines in intent not in running (additive drift).
/// Deletions  = lines in running not in intent (destructive drift).
pub fn diff_intent_vs_running(intent: &str, running: &str) -> DriftPatch {
    let diff = TextDiff::from_lines(intent, running);
    let groups = diff.grouped_ops(CONTEXT_LINES);

    let mut blocks: Vec<DriftBlock> = Vec::new();
    let mut total_add = 0usize;
    let mut total_del = 0usize;

    let intent_lines: Vec<&str> = intent.lines().collect();

    for group in &groups {
        let mut changes: Vec<LineChange> = Vec::new();
        let mut group_add = 0usize;
        let mut group_del = 0usize;
        let mut earliest_intent_line: Option<usize> = None;

        for op in group {
            for change in diff.iter_changes(op) {
                let line = change.value().trim_end_matches('\n').to_string();
                if let Some(idx) = change.old_index() {
                    if earliest_intent_line.is_none_or(|cur| idx < cur) {
                        earliest_intent_line = Some(idx);
                    }
                }
                match change.tag() {
                    ChangeTag::Equal => changes.push(LineChange::Equal { line }),
                    ChangeTag::Insert => {
                        // similar's "Insert" = present in `new` but not `old`.
                        // For us: present in running but not in intent → DELETION
                        // from the intent's POV. Flip naming: we want "what's
                        // missing from intent".
                        group_del += 1;
                        changes.push(LineChange::Delete { line });
                    }
                    ChangeTag::Delete => {
                        group_add += 1;
                        changes.push(LineChange::Insert { line });
                    }
                }
            }
        }

        if group_add == 0 && group_del == 0 {
            continue;
        }

        let block_path = nearest_block_header(&intent_lines, earliest_intent_line.unwrap_or(0));
        let severity = if group_del > 0 {
            DriftSeverity::Destructive
        } else if group_add > 0 {
            DriftSeverity::Additive
        } else {
            DriftSeverity::None
        };

        total_add += group_add;
        total_del += group_del;
        blocks.push(DriftBlock {
            block_path,
            changes,
            severity,
        });
    }

    let overall = if total_add == 0 && total_del == 0 {
        DriftSeverity::None
    } else if total_del > 0 {
        DriftSeverity::Destructive
    } else {
        DriftSeverity::Additive
    };
    let status = if matches!(overall, DriftSeverity::None) {
        "in_sync"
    } else {
        "drift"
    };
    DriftPatch {
        status: status.to_string(),
        severity: overall,
        stats: DriftStats {
            additions: total_add,
            deletions: total_del,
            blocks_changed: blocks.len(),
        },
        blocks,
    }
}

/// Find the nearest "section header" line at or before `line_idx`.
/// IOS-like headers: `interface ...`, `router bgp ...`, `ip access-list ...`,
/// `vrf definition ...`, `class-map ...`, `policy-map ...`, `line vty ...`,
/// `route-map ...`, `crypto ...`, `aaa ...`. Plus Junos `<word> {`.
/// Falls back to "<root>" if nothing matches.
fn nearest_block_header(lines: &[&str], line_idx: usize) -> String {
    if lines.is_empty() {
        return "<root>".to_string();
    }
    for i in (0..=line_idx.min(lines.len().saturating_sub(1))).rev() {
        let ln = lines[i].trim();
        if ln.is_empty() || ln == "!" {
            continue;
        }
        if is_block_header(ln) {
            return ln.to_string();
        }
        // Indented child line: not a header, keep scanning upward.
    }
    "<root>".to_string()
}

fn is_block_header(line: &str) -> bool {
    if line.starts_with(' ') || line.starts_with('\t') {
        return false; // indented = child of a previous header
    }
    let lc = line.to_ascii_lowercase();
    let ios_prefixes = [
        "interface ",
        "router ",
        "ip access-list ",
        "ipv6 access-list ",
        "vrf definition ",
        "class-map ",
        "policy-map ",
        "line vty",
        "line con",
        "line aux",
        "route-map ",
        "crypto ",
        "aaa ",
        "ip prefix-list ",
        "ip community-list ",
        "object-group ",
    ];
    if ios_prefixes.iter().any(|p| lc.starts_with(p)) {
        return true;
    }
    // Junos top-level stanza opener: `system {`, `interfaces {`, etc.
    // Single token followed by `{` at column 0.
    let trimmed = line.trim_end();
    if let Some(stripped) = trimmed.strip_suffix('{') {
        let head = stripped.trim();
        if !head.is_empty() && !head.contains(' ') {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_inputs_in_sync() {
        let cfg = "hostname x\n!\n";
        let p = diff_intent_vs_running(cfg, cfg);
        assert_eq!(p.status, "in_sync");
        assert_eq!(p.severity, DriftSeverity::None);
        assert!(p.blocks.is_empty());
    }
}
