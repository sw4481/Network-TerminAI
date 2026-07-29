//! SQL helpers for the `neighbor_cache` table (V0040).
//!
//! Each row stores the most recent capture of a `show cdp/lldp neighbor*`
//! output for one `(device_ref, device_kind, source_cmd)` triple, along
//! with the normalised `NeighborRecord[]` JSON. The frontend reads
//! `parsed_json` to render an inline topology snippet without re-parsing.

use anyhow::Result;
use rusqlite::{params, Connection};

use super::NeighborCacheRow;

/// Insert or replace the cache row for `(device_ref, device_kind, source_cmd)`.
/// On conflict, refresh `raw_output`, `parsed_json`, and bump `captured_at`
/// to the current epoch.
pub fn upsert_neighbor_cache(
    conn: &Connection,
    device_ref: &str,
    device_kind: &str,
    source_cmd: &str,
    raw_output: &str,
    parsed_json: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO neighbor_cache(device_ref, device_kind, source_cmd, raw_output, parsed_json)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(device_ref, device_kind, source_cmd) DO UPDATE SET
            raw_output  = excluded.raw_output,
            parsed_json = excluded.parsed_json,
            captured_at = strftime('%s','now')",
        params![device_ref, device_kind, source_cmd, raw_output, parsed_json],
    )?;
    Ok(())
}

/// Look up a single cache row, if any.
pub fn get_neighbor_cache(
    conn: &Connection,
    device_ref: &str,
    device_kind: &str,
    source_cmd: &str,
) -> Result<Option<NeighborCacheRow>> {
    let mut stmt = conn.prepare(
        "SELECT device_ref, device_kind, source_cmd, captured_at, parsed_json
         FROM neighbor_cache
         WHERE device_ref = ?1 AND device_kind = ?2 AND source_cmd = ?3",
    )?;
    let mut rows = stmt.query(params![device_ref, device_kind, source_cmd])?;
    if let Some(row) = rows.next()? {
        Ok(Some(NeighborCacheRow {
            device_ref: row.get(0)?,
            device_kind: row.get(1)?,
            source_cmd: row.get(2)?,
            captured_at: row.get(3)?,
            parsed_json: row.get(4)?,
        }))
    } else {
        Ok(None)
    }
}

/// Most-recent-first list of cache rows, capped at `limit`.
pub fn list_recent(conn: &Connection, limit: usize) -> Result<Vec<NeighborCacheRow>> {
    let mut stmt = conn.prepare(
        "SELECT device_ref, device_kind, source_cmd, captured_at, parsed_json
         FROM neighbor_cache
         ORDER BY captured_at DESC
         LIMIT ?1",
    )?;
    let rows = stmt
        .query_map(params![limit as i64], |row| {
            Ok(NeighborCacheRow {
                device_ref: row.get(0)?,
                device_kind: row.get(1)?,
                source_cmd: row.get(2)?,
                captured_at: row.get(3)?,
                parsed_json: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
