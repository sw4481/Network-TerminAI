//! CRUD on `parsed_snapshots`. Phase 3.

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SnapshotRow {
    pub id: i64,
    pub tab_id: String,
    pub name: String,
    pub parsed_output_id: i64,
    pub captured_at: i64,
    pub command: String,
    pub parser: String,
    pub vendor: String,
    pub platform: String,
}

/// Pin the current parsed_outputs row for `block_id` under `name`.
pub fn create(conn: &Connection, block_id: &str, name: &str) -> Result<i64> {
    let parsed: (i64, String) = conn
        .query_row(
            "SELECT po.id, cb.tab_id
             FROM parsed_outputs po
             JOIN command_blocks cb ON cb.id = po.block_id
             WHERE po.block_id = ?1",
            params![block_id],
            |r| Ok::<(i64, String), rusqlite::Error>((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| anyhow!("no parsed output for block {block_id}: {e}"))?;
    let parsed_output_id = parsed.0;
    let tab_id = parsed.1;
    conn.execute(
        "INSERT INTO parsed_snapshots(tab_id, name, parsed_output_id) VALUES (?1, ?2, ?3)",
        params![tab_id, name, parsed_output_id],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_for_tab(conn: &Connection, tab_id: &str) -> Result<Vec<SnapshotRow>> {
    let mut stmt = conn.prepare(
        "SELECT ps.id, ps.tab_id, ps.name, ps.parsed_output_id, ps.captured_at,
                po.command, po.parser, po.vendor, po.platform
         FROM parsed_snapshots ps
         JOIN parsed_outputs po ON po.id = ps.parsed_output_id
         WHERE ps.tab_id = ?1
         ORDER BY ps.captured_at DESC",
    )?;
    let rows = stmt
        .query_map(params![tab_id], |r| {
            Ok(SnapshotRow {
                id: r.get(0)?,
                tab_id: r.get(1)?,
                name: r.get(2)?,
                parsed_output_id: r.get(3)?,
                captured_at: r.get(4)?,
                command: r.get(5)?,
                parser: r.get(6)?,
                vendor: r.get(7)?,
                platform: r.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn rename(conn: &Connection, id: i64, new_name: &str) -> Result<()> {
    let n = conn.execute(
        "UPDATE parsed_snapshots SET name = ?1 WHERE id = ?2",
        params![new_name, id],
    )?;
    if n == 0 {
        return Err(anyhow!("snapshot {id} not found"));
    }
    Ok(())
}

pub fn delete(conn: &Connection, id: i64) -> Result<()> {
    conn.execute(
        "DELETE FROM parsed_snapshots WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}
