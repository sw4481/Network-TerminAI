//! Notebook source — reads runnable notebooks (V0030).

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
    if !table_exists(conn, "notebooks")? {
        return Ok(Vec::new());
    }

    let like = if query.is_empty() {
        "%".to_string()
    } else {
        format!("%{}%", query.replace('%', r"\%").replace('_', r"\_"))
    };

    let mut stmt = conn.prepare(
        "SELECT id, title, description, vendor, platform
         FROM notebooks
         WHERE title LIKE ?1 ESCAPE '\\' OR COALESCE(description, '') LIKE ?1 ESCAPE '\\'
         ORDER BY updated_at DESC
         LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![like, limit as i64], |row| {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let description: Option<String> = row.get(2)?;
            let vendor: Option<String> = row.get(3)?;
            let platform: Option<String> = row.get(4)?;
            Ok(PaletteHit {
                kind: PaletteKind::Notebook,
                target_id: id.clone(),
                title,
                subtitle: description
                    .or_else(|| match (&vendor, &platform) {
                        (Some(v), Some(p)) => Some(format!("{}/{}", v, p)),
                        (Some(v), None) => Some(v.clone()),
                        _ => None,
                    }),
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
