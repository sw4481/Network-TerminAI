//! `palette_usage` recency + frequency tracking.
//!
//! `record()` is an UPSERT — first pick inserts a row with `use_count = 1`,
//! subsequent picks bump `use_count += 1` and refresh `last_used_at`. This
//! is what feeds the recency/frequency boosts in [`super::search::run`].

use anyhow::Result;
use rusqlite::{params, Connection};
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct UsageRow {
    pub target_type: String,
    pub target_id: String,
    pub last_used_at: i64,
    pub use_count: i64,
}

/// UPSERT: insert a fresh row, or bump `use_count` and refresh
/// `last_used_at` if the (target_type, target_id) pair already exists.
pub fn record(conn: &Connection, target_type: &str, target_id: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO palette_usage (target_type, target_id, last_used_at, use_count)
         VALUES (?1, ?2, strftime('%s','now'), 1)
         ON CONFLICT(target_type, target_id) DO UPDATE SET
           last_used_at = strftime('%s','now'),
           use_count    = palette_usage.use_count + 1",
        params![target_type, target_id],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, target_type: &str, target_id: &str) -> Result<Option<UsageRow>> {
    let mut stmt = conn.prepare(
        "SELECT target_type, target_id, last_used_at, use_count
         FROM palette_usage WHERE target_type = ?1 AND target_id = ?2",
    )?;
    let row = stmt.query_row(params![target_type, target_id], |r| {
        Ok(UsageRow {
            target_type: r.get(0)?,
            target_id: r.get(1)?,
            last_used_at: r.get(2)?,
            use_count: r.get(3)?,
        })
    });
    match row {
        Ok(r) => Ok(Some(r)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Trim `palette_usage` so each `target_type` keeps at most `keep` rows,
/// dropping the oldest (smallest `last_used_at`) first. Run at startup so
/// the table can't grow unbounded across years of use.
///
/// Returns the number of rows deleted.
pub fn trim(conn: &Connection, keep: usize) -> Result<usize> {
    if keep == 0 {
        let n = conn.execute("DELETE FROM palette_usage", [])?;
        return Ok(n);
    }
    // For each target_type, find the (last_used_at, target_id) of the row
    // at the `keep`-th position when ordered by last_used_at DESC, then
    // delete everything older. We use a CTE so the work is one round trip.
    let n = conn.execute(
        "WITH ranked AS (
           SELECT target_type, target_id, last_used_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY target_type
                    ORDER BY last_used_at DESC, target_id ASC
                  ) AS rn
             FROM palette_usage
         )
         DELETE FROM palette_usage
         WHERE (target_type, target_id) IN (
           SELECT target_type, target_id FROM ranked WHERE rn > ?1
         )",
        params![keep as i64],
    )?;
    Ok(n)
}

/// Load every usage row of one `target_type` into a map keyed by `target_id`.
/// Used by [`crate::palette::search::run`] to apply recency/frequency boosts
/// in a single SQL round-trip per kind rather than per-hit.
pub fn map_for_type(conn: &Connection, target_type: &str) -> Result<HashMap<String, UsageRow>> {
    let mut stmt = conn.prepare(
        "SELECT target_type, target_id, last_used_at, use_count
         FROM palette_usage WHERE target_type = ?1",
    )?;
    let rows = stmt
        .query_map(params![target_type], |r| {
            Ok(UsageRow {
                target_type: r.get(0)?,
                target_id: r.get(1)?,
                last_used_at: r.get(2)?,
                use_count: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut map = HashMap::with_capacity(rows.len());
    for row in rows {
        map.insert(row.target_id.clone(), row);
    }
    Ok(map)
}
