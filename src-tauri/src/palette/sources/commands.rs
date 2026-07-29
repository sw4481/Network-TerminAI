//! Command source — distinct `cmd` strings from `command_blocks`.
//!
//! Returns one [`PaletteHit`] per *unique* command string (history dedupes
//! across runs). The `target_id` is the command string itself so that
//! `palette_usage` recency boosts attach to the command rather than to a
//! specific block — picking the same `cmd` twice in a row stacks the boost.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde_json::json;

use crate::palette::types::{PaletteHit, PaletteKind, PaletteScope};

/// Free-text + scope-aware search over distinct `command_blocks.cmd`.
pub fn search(
    conn: &Connection,
    query: &str,
    scope: PaletteScope,
    active_tab_id: Option<&str>,
    active_device_id: Option<&str>,
    limit: usize,
) -> Result<Vec<PaletteHit>> {
    // The aggregator hands us the raw user query; commands use a simple
    // case-insensitive LIKE rather than FTS5 because the column is short
    // (one shell command) and we want substring matches like "bgp" → "show ip bgp".
    let like = if query.is_empty() {
        "%".to_string()
    } else {
        format!("%{}%", query.replace('%', r"\%").replace('_', r"\_"))
    };

    let hits: Vec<PaletteHit> = match scope {
        PaletteScope::Tab => {
            let tab = match active_tab_id {
                Some(t) => t,
                None => return Ok(Vec::new()),
            };
            let mut stmt = conn.prepare(
                "SELECT cb.cmd, COUNT(*) AS freq, MAX(cb.started_at) AS last_at
                 FROM command_blocks cb
                 WHERE cb.cmd LIKE ?1 ESCAPE '\\'
                   AND cb.tab_id = ?2
                 GROUP BY cb.cmd
                 ORDER BY freq DESC, last_at DESC
                 LIMIT ?3",
            )?;
            let collected = stmt
                .query_map(params![like, tab, limit as i64], row_to_hit)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            collected
        }
        PaletteScope::Device => {
            // When a device id is supplied, restrict to tabs whose
            // netconf_tab_state.device_id matches. Returns empty if no
            // device id or netconf_tab_state is missing (e.g., on a fresh
            // DB with no NETCONF tabs).
            let device = match active_device_id {
                Some(d) => d,
                None => return Ok(Vec::new()),
            };
            if !table_exists(conn, "netconf_tab_state")? {
                return Ok(Vec::new());
            }
            let mut stmt = conn.prepare(
                "SELECT cb.cmd, COUNT(*) AS freq, MAX(cb.started_at) AS last_at
                 FROM command_blocks cb
                 WHERE cb.cmd LIKE ?1 ESCAPE '\\'
                   AND cb.tab_id IN (
                     SELECT tab_id FROM netconf_tab_state WHERE device_id = ?2
                   )
                 GROUP BY cb.cmd
                 ORDER BY freq DESC, last_at DESC
                 LIMIT ?3",
            )?;
            let collected = stmt
                .query_map(params![like, device, limit as i64], row_to_hit)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            collected
        }
        PaletteScope::Global => {
            let mut stmt = conn.prepare(
                "SELECT cb.cmd, COUNT(*) AS freq, MAX(cb.started_at) AS last_at
                 FROM command_blocks cb
                 WHERE cb.cmd LIKE ?1 ESCAPE '\\'
                 GROUP BY cb.cmd
                 ORDER BY freq DESC, last_at DESC
                 LIMIT ?2",
            )?;
            let collected = stmt
                .query_map(params![like, limit as i64], row_to_hit)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            collected
        }
    };

    Ok(hits)
}

fn row_to_hit(row: &rusqlite::Row) -> rusqlite::Result<PaletteHit> {
    let cmd: String = row.get(0)?;
    let freq: i64 = row.get(1)?;
    let last_at: i64 = row.get(2)?;
    Ok(PaletteHit {
        kind: PaletteKind::Command,
        target_id: cmd.clone(),
        title: cmd,
        subtitle: Some(format!("{}× • last used {}", freq, last_at)),
        score: 1.0,
        recency_boost: 0.0,
        frequency_boost: 0.0,
        meta: json!({ "freq": freq, "last_at": last_at }),
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
