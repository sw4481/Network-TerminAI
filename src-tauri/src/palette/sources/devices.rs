//! NETCONF device source — reads `netconf_devices` (V0015).

use anyhow::Result;
use rusqlite::{params, Connection};
use serde_json::json;

use crate::palette::types::{PaletteHit, PaletteKind, PaletteScope};

pub fn search(
    conn: &Connection,
    query: &str,
    scope: PaletteScope,
    _active_tab_id: Option<&str>,
    active_device_id: Option<&str>,
    limit: usize,
) -> Result<Vec<PaletteHit>> {
    if !table_exists(conn, "netconf_devices")? {
        return Ok(Vec::new());
    }

    // Device scope: when an active device is bound, surface only that one
    // device row (this is "stay focused on the device you're already on").
    if matches!(scope, PaletteScope::Device) {
        if let Some(d) = active_device_id {
            let mut stmt = conn.prepare(
                "SELECT id, name, host, port, username, platform
                 FROM netconf_devices WHERE id = ?1
                 LIMIT 1",
            )?;
            let rows = stmt
                .query_map(params![d], device_row_to_hit)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            return Ok(rows);
        }
    }

    let like = if query.is_empty() {
        "%".to_string()
    } else {
        format!("%{}%", query.replace('%', r"\%").replace('_', r"\_"))
    };

    let mut stmt = conn.prepare(
        "SELECT id, name, host, port, username, platform
         FROM netconf_devices
         WHERE name LIKE ?1 ESCAPE '\\'
            OR host LIKE ?1 ESCAPE '\\'
            OR username LIKE ?1 ESCAPE '\\'
            OR platform LIKE ?1 ESCAPE '\\'
         ORDER BY name
         LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![like, limit as i64], device_row_to_hit)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn device_row_to_hit(row: &rusqlite::Row) -> rusqlite::Result<PaletteHit> {
    let id: i64 = row.get(0)?;
    let name: String = row.get(1)?;
    let host: String = row.get(2)?;
    let port: i64 = row.get(3)?;
    let username: String = row.get(4)?;
    let platform: String = row.get(5)?;
    Ok(PaletteHit {
        kind: PaletteKind::Device,
        target_id: id.to_string(),
        title: name,
        subtitle: Some(format!("{}@{}:{} • {}", username, host, port, platform)),
        score: 1.0,
        recency_boost: 0.0,
        frequency_boost: 0.0,
        meta: json!({ "id": id, "host": host, "port": port, "platform": platform }),
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
