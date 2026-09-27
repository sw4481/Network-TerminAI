//! Workflow source — reads `workflows` (V0029).
//!
//! Tolerates a missing `workflows` table by returning `Ok(vec![])` so the
//! palette boots cleanly on DBs that haven't applied Plan 02 yet.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde_json::json;

use crate::palette::types::{PaletteHit, PaletteKind, PaletteScope};

pub fn search(
    conn: &Connection,
    query: &str,
    _scope: PaletteScope,
    _active_tab_id: Option<&str>,
    _active_device_id: Option<&str>,
    limit: usize,
) -> Result<Vec<PaletteHit>> {
    if !table_exists(conn, "workflows")? {
        return Ok(Vec::new());
    }

    let like = if query.is_empty() {
        "%".to_string()
    } else {
        format!("%{}%", query.replace('%', r"\%").replace('_', r"\_"))
    };

    let mut stmt = conn.prepare(
        "SELECT id, name, description, vendor, platform
         FROM workflows
         WHERE name LIKE ?1 ESCAPE '\\' OR description LIKE ?1 ESCAPE '\\'
         ORDER BY updated_at DESC
         LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![like, limit as i64], |row| {
            let id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let description: String = row.get(2)?;
            let vendor: String = row.get(3)?;
            let platform: String = row.get(4)?;
            Ok(PaletteHit {
                kind: PaletteKind::Workflow,
                target_id: id.clone(),
                title: name,
                subtitle: if description.is_empty() {
                    Some(format!("{}/{}", vendor, platform))
                } else {
                    Some(description)
                },
                score: 1.0,
                recency_boost: 0.0,
                frequency_boost: 0.0,
                meta: json!({ "id": id, "vendor": vendor, "platform": platform }),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type IN ('table','view') AND name = ?1",
        params![name],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}
