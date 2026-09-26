//! Saved SSH connections source — reads `ssh_connections` (V0024).
//!
//! Orders by `last_used_at DESC NULLS LAST` so the most recently used
//! connection floats to the top of the palette.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde_json::json;

use crate::palette::types::{PaletteHit, PaletteKind, PaletteScope};

pub fn search(
    conn: &Connection,
    query: &str,
    _scope: PaletteScope,
    limit: usize,
) -> Result<Vec<PaletteHit>> {
    if !table_exists(conn, "ssh_connections")? {
        return Ok(Vec::new());
    }

    let like = if query.is_empty() {
        "%".to_string()
    } else {
        format!("%{}%", query.replace('%', r"\%").replace('_', r"\_"))
    };

    let mut stmt = conn.prepare(
        "SELECT id, name, host, COALESCE(user,''), COALESCE(port, 22), last_used_at
         FROM ssh_connections
         WHERE name LIKE ?1 ESCAPE '\\'
            OR host LIKE ?1 ESCAPE '\\'
            OR COALESCE(user,'') LIKE ?1 ESCAPE '\\'
         ORDER BY (last_used_at IS NULL), last_used_at DESC, name
         LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![like, limit as i64], |row| {
            let id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let host: String = row.get(2)?;
            let user: String = row.get(3)?;
            let port: i64 = row.get(4)?;
            let last_used_at: Option<i64> = row.get(5)?;
            let subtitle = if user.is_empty() {
                format!("{}:{}", host, port)
            } else {
                format!("{}@{}:{}", user, host, port)
            };
            Ok(PaletteHit {
                kind: PaletteKind::Ssh,
                target_id: id.clone(),
                title: name,
                subtitle: Some(subtitle),
                score: 1.0,
                recency_boost: 0.0,
                frequency_boost: 0.0,
                meta: json!({
                    "id": id,
                    "host": host,
                    "user": user,
                    "port": port,
                    "last_used_at": last_used_at,
                }),
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
