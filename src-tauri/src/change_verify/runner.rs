//! Pre/post snapshot orchestrator.
//!
//! Runs every command in a check-bundle against the active session via a
//! `ShowTransport`, parses each result via Plan 05 (through the Plan 06-local
//! `parse_and_store` reconciliation helper), and persists a
//! `change_snapshots` row + one `change_snapshot_results` row per command.
//!
//! Transactional: if any command fails (transport or parse), the whole run is
//! rolled back so we never leave half-populated snapshots in the DB. The DB
//! lock is acquired in short scoped blocks between async calls — never held
//! across `.await` — so the future stays `Send` and tokio cancellation works.

use anyhow::{bail, Context, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use std::sync::Arc;
use uuid::Uuid;

use super::bundles;
use super::model::{ChangeSnapshot, ChangeSnapshotResult, SnapshotLabel};
use super::parser::parse_and_store;
use super::transport::ShowTransport;
use crate::structured::auto_parse::Parser;

pub async fn run_snapshot(
    db: Arc<Mutex<Connection>>,
    transport: Arc<dyn ShowTransport>,
    parser: Arc<dyn Parser>,
    tab_id: &str,
    bundle_id: &str,
    label: SnapshotLabel,
) -> Result<ChangeSnapshot> {
    let bundle = {
        let conn = db.lock();
        bundles::get(&conn, bundle_id).context("load bundle")?
    };

    let (vendor, platform) = transport
        .detect_platform(tab_id)
        .await
        .context("detect platform")?;
    if vendor != bundle.vendor || platform != bundle.platform {
        bail!(
            "bundle vendor/platform ({}/{}) does not match session ({}/{})",
            bundle.vendor,
            bundle.platform,
            vendor,
            platform
        );
    }

    let snapshot_id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    let label_str = match label {
        SnapshotLabel::Pre => "pre",
        SnapshotLabel::Post => "post",
    };

    {
        let conn = db.lock();
        conn.execute_batch("BEGIN").context("begin transaction")?;
    }

    let result = run_snapshot_inner(
        db.clone(),
        transport.as_ref(),
        parser.as_ref(),
        &snapshot_id,
        tab_id,
        bundle_id,
        &vendor,
        &platform,
        &bundle.commands,
        label_str,
        now,
    )
    .await;

    match result {
        Ok(results) => {
            let conn = db.lock();
            conn.execute_batch("COMMIT").context("commit transaction")?;
            Ok(ChangeSnapshot {
                id: snapshot_id,
                tab_id: tab_id.into(),
                bundle_id: bundle_id.into(),
                label,
                captured_at: now,
                results,
            })
        }
        Err(e) => {
            let conn = db.lock();
            // Best-effort rollback; surface the original error.
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_snapshot_inner(
    db: Arc<Mutex<Connection>>,
    transport: &dyn ShowTransport,
    parser: &dyn Parser,
    snapshot_id: &str,
    tab_id: &str,
    bundle_id: &str,
    vendor: &str,
    platform: &str,
    commands: &[String],
    label_str: &str,
    now: i64,
) -> Result<Vec<ChangeSnapshotResult>> {
    {
        let conn = db.lock();
        conn.execute(
            "INSERT INTO change_snapshots(id,tab_id,bundle_id,label,captured_at)
             VALUES (?1,?2,?3,?4,?5)",
            params![snapshot_id, tab_id, bundle_id, label_str, now],
        )?;
    }

    let mut results = Vec::with_capacity(commands.len());
    for cmd in commands {
        let raw = transport
            .run_show(tab_id, cmd)
            .await
            .with_context(|| format!("run_show {cmd}"))?;
        let parsed_id = parse_and_store(db.clone(), parser, tab_id, vendor, platform, cmd, &raw)
            .await
            .with_context(|| format!("parse_and_store {cmd}"))?;
        {
            let conn = db.lock();
            conn.execute(
                "INSERT INTO change_snapshot_results(snapshot_id,command,parsed_output_id)
                 VALUES (?1,?2,?3)",
                params![snapshot_id, cmd, parsed_id],
            )?;
        }
        results.push(ChangeSnapshotResult {
            command: cmd.clone(),
            parsed_output_id: parsed_id,
        });
    }
    Ok(results)
}

pub fn get_snapshot(db: &Connection, id: &str) -> Result<ChangeSnapshot> {
    let (tab_id, bundle_id, label_str, captured_at): (String, String, String, i64) = db
        .query_row(
            "SELECT tab_id,bundle_id,label,captured_at FROM change_snapshots WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
    let label = match label_str.as_str() {
        "pre" => SnapshotLabel::Pre,
        "post" => SnapshotLabel::Post,
        other => bail!("invalid snapshot label: {other}"),
    };
    let mut stmt = db.prepare(
        "SELECT command, parsed_output_id FROM change_snapshot_results
         WHERE snapshot_id = ?1 ORDER BY command ASC",
    )?;
    let results: Vec<ChangeSnapshotResult> = stmt
        .query_map(params![id], |r| {
            Ok(ChangeSnapshotResult {
                command: r.get(0)?,
                parsed_output_id: r.get(1)?,
            })
        })?
        .collect::<std::result::Result<_, _>>()?;
    Ok(ChangeSnapshot {
        id: id.into(),
        tab_id,
        bundle_id,
        label,
        captured_at,
        results,
    })
}

pub fn latest_pre_for_tab(
    db: &Connection,
    tab_id: &str,
    bundle_id: &str,
) -> Result<Option<String>> {
    let id: Option<String> = db
        .query_row(
            "SELECT id FROM change_snapshots
             WHERE tab_id = ?1 AND bundle_id = ?2 AND label = 'pre'
             ORDER BY captured_at DESC LIMIT 1",
            params![tab_id, bundle_id],
            |r| r.get(0),
        )
        .ok();
    Ok(id)
}

use super::classifier::{classify, ClassifierThresholds};
use super::diff_outputs::diff_outputs;
use super::report::{
    count_severities, reclassify_with_approvals, ApprovedMatch, ExpectedDelta, ReportSummary,
};

/// Run the post-check, diff against the named pre-snapshot, classify deltas,
/// apply approvals, persist a `change_reports` row, and return both the
/// report id and the `ReportSummary`.
///
/// Lock scoping mirrors `run_snapshot`: short scoped windows between
/// `.await` calls so the future stays `Send`.
pub async fn run_post_and_report(
    db: Arc<Mutex<Connection>>,
    transport: Arc<dyn ShowTransport>,
    parser: Arc<dyn Parser>,
    tab_id: &str,
    bundle_id: &str,
    pre_snapshot_id: &str,
    approved: Vec<ExpectedDelta>,
    notes: Option<String>,
) -> Result<(String, ReportSummary, i64)> {
    let post = run_snapshot(
        db.clone(),
        transport,
        parser,
        tab_id,
        bundle_id,
        SnapshotLabel::Post,
    )
    .await?;

    let pre = {
        let conn = db.lock();
        get_snapshot(&conn, pre_snapshot_id)?
    };

    let th = ClassifierThresholds::default();
    let mut all_deltas: Vec<super::classifier::ClassifiedDelta> = Vec::new();
    for r_post in &post.results {
        let r_pre = pre.results.iter().find(|p| p.command == r_post.command);
        let Some(r_pre) = r_pre else {
            // Command in post but not pre — skip (classifier has no baseline).
            continue;
        };
        let raw = diff_outputs(r_pre.parsed_output_id, r_post.parsed_output_id, db.clone())
            .with_context(|| format!("diff_outputs for {}", r_post.command))?;
        let classified = classify(&r_post.command, &raw, &th);
        all_deltas.extend(classified);
    }

    let (deltas, matched_approved): (Vec<_>, Vec<ApprovedMatch>) =
        reclassify_with_approvals(all_deltas, &approved);
    let counts = count_severities(&deltas);

    let summary = ReportSummary {
        pre_snapshot_id: pre.id.clone(),
        post_snapshot_id: post.id.clone(),
        bundle_id: bundle_id.into(),
        counts,
        deltas,
        matched_approved,
        notes,
    };

    let report_id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    {
        let conn = db.lock();
        conn.execute_batch("BEGIN").context("begin report txn")?;
        let insert_result = conn.execute(
            "INSERT INTO change_reports(id,pre_snapshot_id,post_snapshot_id,summary_json,approved_deltas_json,created_at)
             VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                &report_id,
                &pre.id,
                &post.id,
                serde_json::to_string(&summary)?,
                serde_json::to_string(&approved)?,
                now,
            ],
        );
        match insert_result {
            Ok(_) => {
                conn.execute_batch("COMMIT").context("commit report txn")?;
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                // Detect UNIQUE violation specifically — `(pre, post)` already has a report.
                let msg = e.to_string();
                if msg.contains("UNIQUE constraint failed") && msg.contains("change_reports") {
                    bail!(
                        "report already exists for this pre/post snapshot pair (pre={}, post={})",
                        pre.id, post.id
                    );
                }
                return Err(anyhow::Error::from(e).context("insert change_report"));
            }
        }
    }

    Ok((report_id, summary, now))
}

pub fn get_report(
    db: &Connection,
    id: &str,
) -> Result<(ReportSummary, Vec<ExpectedDelta>, i64)> {
    let (summary_json, approved_json, created_at): (String, Option<String>, i64) = db.query_row(
        "SELECT summary_json, approved_deltas_json, created_at FROM change_reports WHERE id = ?1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let summary: ReportSummary = serde_json::from_str(&summary_json)?;
    let approved: Vec<ExpectedDelta> = approved_json
        .map(|j| serde_json::from_str(&j))
        .transpose()?
        .unwrap_or_default();
    Ok((summary, approved, created_at))
}

pub fn list_reports(db: &Connection) -> Result<Vec<(String, i64, String, String)>> {
    let mut stmt = db.prepare(
        "SELECT id, created_at, pre_snapshot_id, post_snapshot_id
         FROM change_reports ORDER BY created_at DESC LIMIT 200",
    )?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows)
}

/// Append a user approval to an existing report, re-classify deltas, and persist.
pub fn append_approval(
    db: &Connection,
    report_id: &str,
    approval: ExpectedDelta,
) -> Result<(ReportSummary, Vec<ExpectedDelta>)> {
    let (mut summary, mut approved, _created_at) = get_report(db, report_id)?;

    approved.push(approval.clone());

    // Apply just the new approval to the current state.
    let new_only: Vec<ExpectedDelta> = vec![approval];
    let (deltas, new_matches) = reclassify_with_approvals(summary.deltas, &new_only);
    summary.deltas = deltas;
    summary.matched_approved.extend(new_matches);
    summary.counts = count_severities(&summary.deltas);

    db.execute(
        "UPDATE change_reports SET summary_json = ?1, approved_deltas_json = ?2 WHERE id = ?3",
        params![
            serde_json::to_string(&summary)?,
            serde_json::to_string(&approved)?,
            report_id,
        ],
    )
    .context("update change_report")?;

    Ok((summary, approved))
}
