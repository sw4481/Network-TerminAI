//! Block source — FTS5 search over `palette_index` (V0031).
//!
//! Hits land here when the user query matches the command, a block tag, or
//! (post-Plan 05) vendor/platform metadata. Returns
//! `Ok(vec![])` if `palette_index` is missing so partially-migrated DBs
//! don't break the picker.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde_json::json;

use crate::palette::types::{PaletteHit, PaletteKind, PaletteScope};
use crate::palette::util::escape_fts5_query;

pub fn search(
    conn: &Connection,
    query: &str,
    scope: PaletteScope,
    active_tab_id: Option<&str>,
    limit: usize,
) -> Result<Vec<PaletteHit>> {
    search_with_device(conn, query, scope, active_tab_id, None, limit)
}

pub fn search_with_device(
    conn: &Connection,
    query: &str,
    scope: PaletteScope,
    active_tab_id: Option<&str>,
    active_device_id: Option<&str>,
    limit: usize,
) -> Result<Vec<PaletteHit>> {
    if !table_exists(conn, "palette_index")? {
        return Ok(Vec::new());
    }

    // Empty query → no FTS match (FTS5 MATCH "" is a syntax error). Phase 3
    // routes empty queries through the "recent picks" branch in search::run
    // before any source sees them.
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let q = escape_fts5_query(query);

    let rows: Vec<PaletteHit> = match scope {
        PaletteScope::Tab => {
            let tab = match active_tab_id {
                Some(t) => t,
                None => return Ok(Vec::new()),
            };
            let mut stmt = conn.prepare(
                "SELECT pi.block_id, pi.tab_id, pi.cmd,
                        bm25(palette_index) AS rank
                 FROM palette_index pi
                 WHERE palette_index MATCH ?1
                   AND pi.tab_id = ?2
                 ORDER BY rank ASC
                 LIMIT ?3",
            )?;
            let collected = stmt
                .query_map(params![q, tab, limit as i64], row_to_hit)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            collected
        }
        PaletteScope::Device => {
            let device = match active_device_id {
                Some(d) => d,
                None => return Ok(Vec::new()),
            };
            if !table_exists(conn, "netconf_tab_state")? {
                return Ok(Vec::new());
            }
            let mut stmt = conn.prepare(
                "SELECT pi.block_id, pi.tab_id, pi.cmd,
                        bm25(palette_index) AS rank
                 FROM palette_index pi
                 WHERE palette_index MATCH ?1
                   AND pi.tab_id IN (
                     SELECT tab_id FROM netconf_tab_state WHERE device_id = ?2
                   )
                 ORDER BY rank ASC
                 LIMIT ?3",
            )?;
            let collected = stmt
                .query_map(params![q, device, limit as i64], row_to_hit)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            collected
        }
        PaletteScope::Global => {
            let mut stmt = conn.prepare(
                "SELECT pi.block_id, pi.tab_id, pi.cmd,
                        bm25(palette_index) AS rank
                 FROM palette_index pi
                 WHERE palette_index MATCH ?1
                 ORDER BY rank ASC
                 LIMIT ?2",
            )?;
            let collected = stmt
                .query_map(params![q, limit as i64], row_to_hit)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            collected
        }
    };

    Ok(rows)
}

fn row_to_hit(row: &rusqlite::Row) -> rusqlite::Result<PaletteHit> {
    let block_id: String = row.get(0)?;
    let tab_id: String = row.get(1)?;
    let cmd: String = row.get(2)?;
    let bm25: f64 = row.get(3)?;
    // bm25 is "lower = better"; flip into a 0..1 score by `1/(1+|bm25|)`.
    let score = 1.0 / (1.0 + bm25.abs());
    Ok(PaletteHit {
        kind: PaletteKind::Block,
        target_id: block_id.clone(),
        title: cmd,
        subtitle: Some(format!("tab {}", tab_id)),
        score,
        recency_boost: 0.0,
        frequency_boost: 0.0,
        meta: json!({ "block_id": block_id, "tab_id": tab_id, "bm25": bm25 }),
    })
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type IN ('table','view') AND name = ?1",
        params![name],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}
