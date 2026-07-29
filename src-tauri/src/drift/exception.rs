//! Per-line drift exceptions. An acknowledged delta (template_id + exact
//! normalized line) is suppressed on future runs.

use crate::drift::diff::{DriftPatch, DriftSeverity, LineChange};
use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DriftException {
    pub id: String,
    pub template_id: String,
    pub line: String,
    pub note: Option<String>,
    pub created_at: i64,
}

pub struct DriftExceptionRepo;

impl DriftExceptionRepo {
    pub fn add(conn: &Connection, template_id: &str, line: &str, note: Option<&str>) -> Result<DriftException> {
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO intent_drift_exceptions (id, template_id, line, note) VALUES (?1, ?2, ?3, ?4)",
            params![id, template_id, line, note],
        ).context("insert intent_drift_exceptions")?;
        Ok(DriftException {
            id, template_id: template_id.into(), line: line.into(),
            note: note.map(|s| s.to_string()), created_at: 0,
        })
    }

    pub fn list(conn: &Connection, template_id: &str) -> Result<Vec<DriftException>> {
        let mut stmt = conn.prepare(
            "SELECT id, template_id, line, note, created_at FROM intent_drift_exceptions
             WHERE template_id = ?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([template_id], |r| Ok(DriftException {
            id: r.get(0)?, template_id: r.get(1)?, line: r.get(2)?, note: r.get(3)?, created_at: r.get(4)?,
        }))?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn delete(conn: &Connection, id: &str) -> Result<()> {
        conn.execute("DELETE FROM intent_drift_exceptions WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn active_lines(conn: &Connection, template_id: &str) -> Result<HashSet<String>> {
        let mut stmt = conn.prepare("SELECT line FROM intent_drift_exceptions WHERE template_id = ?1")?;
        let lines = stmt.query_map([template_id], |r| r.get::<_, String>(0))?
            .collect::<Result<HashSet<_>, _>>()?;
        Ok(lines)
    }
}

/// Map (additions, deletions) counts to a severity using the mode's polarity.
/// Partial mode: additions = Missing = Destructive (the serious case).
/// Baseline mode: deletions = device-has-extra/removed = Destructive (matches diff.rs).
fn severity_for_counts(add: usize, del: usize, mode: crate::drift::intent::MatchMode) -> DriftSeverity {
    use crate::drift::intent::MatchMode;
    if add == 0 && del == 0 {
        return DriftSeverity::None;
    }
    match mode {
        MatchMode::Partial => {
            if add > 0 { DriftSeverity::Destructive } else { DriftSeverity::Additive }
        }
        MatchMode::Baseline => {
            if del > 0 { DriftSeverity::Destructive } else { DriftSeverity::Additive }
        }
    }
}

/// Remove excepted deltas from a patch and recompute stats/severity/status.
/// `Equal` context lines are preserved.
pub fn apply_exceptions(patch: &mut DriftPatch, excepted: &HashSet<String>, mode: crate::drift::intent::MatchMode) {
    let mut add = 0usize;
    let mut del = 0usize;
    for block in patch.blocks.iter_mut() {
        block.changes.retain(|c| match c {
            LineChange::Insert { line } | LineChange::Delete { line } => !excepted.contains(line),
            LineChange::Equal { .. } => true,
        });
        // Recount this block.
        let mut b_add = 0usize;
        let mut b_del = 0usize;
        for c in &block.changes {
            match c {
                LineChange::Insert { .. } => b_add += 1,
                LineChange::Delete { .. } => b_del += 1,
                LineChange::Equal { .. } => {}
            }
        }
        block.severity = severity_for_counts(b_add, b_del, mode);
        add += b_add;
        del += b_del;
    }
    // Drop blocks with no real change left.
    patch.blocks.retain(|b| b.changes.iter().any(|c| !matches!(c, LineChange::Equal { .. })));

    patch.stats.additions = add;
    patch.stats.deletions = del;
    patch.stats.blocks_changed = patch.blocks.len();
    patch.severity = severity_for_counts(add, del, mode);
    patch.status = if matches!(patch.severity, DriftSeverity::None) { "in_sync" } else { "drift" }.to_string();
}
