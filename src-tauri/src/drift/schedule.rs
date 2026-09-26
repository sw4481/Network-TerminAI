//! `drift_schedules` table CRUD.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DriftSchedule {
    pub id: String,
    pub template_id: String,
    pub cron_expr: String,
    pub enabled: bool,
    pub last_run_at: Option<i64>,
    pub created_at: i64,
}

pub struct DriftScheduleRepo;

impl DriftScheduleRepo {
    pub fn create(
        conn: &Connection,
        template_id: &str,
        cron_expr: &str,
    ) -> Result<DriftSchedule> {
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO drift_schedules (id, template_id, cron_expr, enabled)
             VALUES (?1, ?2, ?3, 1)",
            params![&id, template_id, cron_expr],
        )
        .context("insert drift_schedules")?;
        Self::get(conn, &id)?.ok_or_else(|| anyhow::anyhow!("readback after insert"))
    }

    pub fn get(conn: &Connection, id: &str) -> Result<Option<DriftSchedule>> {
        let row = conn
            .query_row(
                "SELECT id, template_id, cron_expr, enabled, last_run_at, created_at
                 FROM drift_schedules WHERE id = ?1",
                [id],
                Self::map_row,
            )
            .optional()?;
        Ok(row)
    }

    pub fn list(conn: &Connection) -> Result<Vec<DriftSchedule>> {
        let mut stmt = conn.prepare(
            "SELECT id, template_id, cron_expr, enabled, last_run_at, created_at
             FROM drift_schedules ORDER BY created_at DESC",
        )?;
        let rows = stmt
            .query_map([], Self::map_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn list_enabled(conn: &Connection) -> Result<Vec<DriftSchedule>> {
        let mut stmt = conn.prepare(
            "SELECT id, template_id, cron_expr, enabled, last_run_at, created_at
             FROM drift_schedules WHERE enabled = 1 ORDER BY created_at DESC",
        )?;
        let rows = stmt
            .query_map([], Self::map_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn set_enabled(conn: &Connection, id: &str, enabled: bool) -> Result<()> {
        let n = conn.execute(
            "UPDATE drift_schedules SET enabled = ?1 WHERE id = ?2",
            params![enabled as i64, id],
        )?;
        if n == 0 {
            anyhow::bail!("drift_schedule id={id} not found");
        }
        Ok(())
    }

    pub fn update_cron(conn: &Connection, id: &str, cron_expr: &str) -> Result<()> {
        let n = conn.execute(
            "UPDATE drift_schedules SET cron_expr = ?1 WHERE id = ?2",
            params![cron_expr, id],
        )?;
        if n == 0 {
            anyhow::bail!("drift_schedule id={id} not found");
        }
        Ok(())
    }

    pub fn touch_last_run(conn: &Connection, id: &str) -> Result<()> {
        conn.execute(
            "UPDATE drift_schedules SET last_run_at = strftime('%s','now') WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }

    pub fn delete(conn: &Connection, id: &str) -> Result<()> {
        conn.execute("DELETE FROM drift_schedules WHERE id = ?1", [id])?;
        Ok(())
    }

    fn map_row(row: &rusqlite::Row) -> rusqlite::Result<DriftSchedule> {
        let enabled: i64 = row.get(3)?;
        Ok(DriftSchedule {
            id: row.get(0)?,
            template_id: row.get(1)?,
            cron_expr: row.get(2)?,
            enabled: enabled != 0,
            last_run_at: row.get(4)?,
            created_at: row.get(5)?,
        })
    }
}
