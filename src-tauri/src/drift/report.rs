//! `drift_reports` persistence. One row per (template, device) per run.

use crate::drift::diff::DriftPatch;
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DriftReport {
    pub id: String,
    pub template_id: String,
    pub device_id: String,
    pub device_kind: String,
    pub status: String,   // "in_sync" | "drift" | "error"
    pub severity: String, // "none" | "additive" | "destructive" | "error"
    pub diff_patch: Option<DriftPatch>,
    pub error_msg: Option<String>,
    pub captured_at: i64,
}

pub struct DriftReportRepo;

impl DriftReportRepo {
    pub fn insert(
        conn: &Connection,
        template_id: &str,
        device_id: &str,
        device_kind: &str,
        patch: Option<&DriftPatch>,
        error_msg: Option<&str>,
    ) -> Result<DriftReport> {
        let id = uuid::Uuid::new_v4().to_string();
        let (status, severity, diff_text) = if let Some(p) = patch {
            let text = serde_json::to_string(p)?;
            (p.status.clone(), severity_str(&p.severity), text)
        } else {
            ("error".to_string(), "error".to_string(), String::new())
        };
        conn.execute(
            "INSERT INTO drift_reports
                (id, template_id, device_id, device_kind, status, severity, diff_patch, error_msg)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                &id,
                template_id,
                device_id,
                device_kind,
                &status,
                &severity,
                &diff_text,
                error_msg,
            ],
        )
        .context("insert drift_reports")?;
        Self::get(conn, &id)?.ok_or_else(|| anyhow::anyhow!("readback after insert"))
    }

    pub fn get(conn: &Connection, id: &str) -> Result<Option<DriftReport>> {
        let row = conn
            .query_row(
                "SELECT id, template_id, device_id, device_kind, status, severity,
                        diff_patch, error_msg, captured_at
                 FROM drift_reports WHERE id = ?1",
                [id],
                Self::map_row,
            )
            .optional()?;
        Ok(row)
    }

    pub fn list_by_template(
        conn: &Connection,
        template_id: &str,
        limit: i64,
    ) -> Result<Vec<DriftReport>> {
        let mut stmt = conn.prepare(
            "SELECT id, template_id, device_id, device_kind, status, severity,
                    diff_patch, error_msg, captured_at
             FROM drift_reports WHERE template_id = ?1
             ORDER BY captured_at DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![template_id, limit], Self::map_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn list_recent_by_device(
        conn: &Connection,
        device_id: &str,
        device_kind: &str,
        limit: i64,
    ) -> Result<Vec<DriftReport>> {
        let mut stmt = conn.prepare(
            "SELECT id, template_id, device_id, device_kind, status, severity,
                    diff_patch, error_msg, captured_at
             FROM drift_reports WHERE device_id = ?1 AND device_kind = ?2
             ORDER BY captured_at DESC LIMIT ?3",
        )?;
        let rows = stmt
            .query_map(params![device_id, device_kind, limit], Self::map_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    fn map_row(row: &rusqlite::Row) -> rusqlite::Result<DriftReport> {
        let diff_text: String = row.get(6)?;
        let patch = if diff_text.is_empty() {
            None
        } else {
            serde_json::from_str(&diff_text).ok()
        };
        Ok(DriftReport {
            id: row.get(0)?,
            template_id: row.get(1)?,
            device_id: row.get(2)?,
            device_kind: row.get(3)?,
            status: row.get(4)?,
            severity: row.get(5)?,
            diff_patch: patch,
            error_msg: row.get(7)?,
            captured_at: row.get(8)?,
        })
    }
}

fn severity_str(s: &crate::drift::diff::DriftSeverity) -> String {
    use crate::drift::diff::DriftSeverity::*;
    match s {
        None => "none".to_string(),
        Additive => "additive".to_string(),
        Destructive => "destructive".to_string(),
        Error => "error".to_string(),
    }
}
