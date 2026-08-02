//! Empty-query "recent picks" branch.
//!
//! When the user hits ⌘P with nothing typed, we surface the most recently
//! used items across every kind, ordered by `palette_usage.last_used_at
//! DESC`. The IDs are then hydrated back into [`PaletteHit`]s by querying
//! the source tables they came from.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde_json::json;
use std::collections::HashMap;

use super::types::{PaletteHit, PaletteKind, PaletteScope};

pub fn top_recent_picks(
    conn: &Connection,
    kind_filter: Option<PaletteKind>,
    _scope: PaletteScope,
    _active_tab_id: Option<&str>,
    _active_device_id: Option<&str>,
    limit: usize,
) -> Result<Vec<PaletteHit>> {
    // Step 1: pull the top-N usage rows by recency, optionally filtered by
    // kind. We deliberately ignore scope here — recent-picks is a "what did
    // I just do?" view; scope filtering would surprise the user when their
    // most recent pick lives in another tab.
    let mut stmt = if kind_filter.is_some() {
        conn.prepare(
            "SELECT target_type, target_id, last_used_at, use_count
             FROM palette_usage
             WHERE target_type = ?1
             ORDER BY last_used_at DESC
             LIMIT ?2",
        )?
    } else {
        conn.prepare(
            "SELECT target_type, target_id, last_used_at, use_count
             FROM palette_usage
             ORDER BY last_used_at DESC
             LIMIT ?1",
        )?
    };

    struct UsageEntry {
        target_type: String,
        target_id: String,
        last_used_at: i64,
        use_count: i64,
    }

    let rows: Vec<UsageEntry> = if let Some(k) = kind_filter {
        stmt.query_map(params![k.as_target_type(), limit as i64], |row| {
            Ok(UsageEntry {
                target_type: row.get(0)?,
                target_id: row.get(1)?,
                last_used_at: row.get(2)?,
                use_count: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        stmt.query_map(params![limit as i64], |row| {
            Ok(UsageEntry {
                target_type: row.get(0)?,
                target_id: row.get(1)?,
                last_used_at: row.get(2)?,
                use_count: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };

    // Step 2: bucket the IDs by kind so each source can be hit in batch.
    let mut buckets: HashMap<PaletteKind, Vec<&UsageEntry>> = HashMap::new();
    for entry in &rows {
        if let Some(kind) = parse_target_type(&entry.target_type) {
            buckets.entry(kind).or_default().push(entry);
        }
    }

    // Step 3: hydrate. Each kind has a small re-query helper. Anything we
    // can't hydrate (e.g., the underlying row was deleted) drops out.
    let mut hydrated: HashMap<(PaletteKind, String), PaletteHit> = HashMap::new();
    for (kind, entries) in &buckets {
        let ids: Vec<&str> = entries.iter().map(|e| e.target_id.as_str()).collect();
        match hydrate_kind(conn, *kind, &ids) {
            Ok(hits) => {
                for hit in hits {
                    hydrated.insert((hit.kind, hit.target_id.clone()), hit);
                }
            }
            Err(e) => tracing::warn!(?e, ?kind, "recent picks hydration failed"),
        }
    }

    // Step 4: re-emit in usage-row order, splicing the recency metadata in.
    let now = unix_now_seconds();
    let mut out = Vec::with_capacity(rows.len());
    for entry in rows {
        let kind = match parse_target_type(&entry.target_type) {
            Some(k) => k,
            None => continue,
        };
        if let Some(mut hit) = hydrated.remove(&(kind, entry.target_id.clone())) {
            let age = (now - entry.last_used_at).max(0) as f64;
            hit.recency_boost = (-age / 86_400.0).exp();
            hit.frequency_boost = (1.0 + entry.use_count as f64).log10() * 0.5;
            if let serde_json::Value::Object(ref mut map) = hit.meta {
                map.insert(
                    "last_used_at".to_string(),
                    serde_json::Value::from(entry.last_used_at),
                );
                map.insert(
                    "use_count".to_string(),
                    serde_json::Value::from(entry.use_count),
                );
            }
            out.push(hit);
        }
    }
    Ok(out)
}

fn parse_target_type(s: &str) -> Option<PaletteKind> {
    match s {
        "command" => Some(PaletteKind::Command),
        "workflow" => Some(PaletteKind::Workflow),
        "notebook" => Some(PaletteKind::Notebook),
        "device" => Some(PaletteKind::Device),
        "block" => Some(PaletteKind::Block),
        "ssh" => Some(PaletteKind::Ssh),
        _ => None,
    }
}

fn hydrate_kind(conn: &Connection, kind: PaletteKind, ids: &[&str]) -> Result<Vec<PaletteHit>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    match kind {
        PaletteKind::Command => hydrate_commands(conn, ids),
        PaletteKind::Block => hydrate_blocks(conn, ids),
        PaletteKind::Workflow => hydrate_workflows(conn, ids),
        PaletteKind::Notebook => hydrate_notebooks(conn, ids),
        PaletteKind::Device => hydrate_devices(conn, ids),
        PaletteKind::Ssh => hydrate_ssh(conn, ids),
    }
}

fn placeholders(n: usize) -> String {
    std::iter::repeat_n("?", n).collect::<Vec<_>>().join(",")
}

fn hydrate_commands(conn: &Connection, ids: &[&str]) -> Result<Vec<PaletteHit>> {
    let ph = placeholders(ids.len());
    let sql = format!(
        "SELECT cb.cmd, COUNT(*) AS freq, MAX(cb.started_at) AS last_at
         FROM command_blocks cb
         WHERE cb.cmd IN ({ph})
         GROUP BY cb.cmd"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params_vec: Vec<&dyn rusqlite::ToSql> =
        ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
    let rows = stmt
        .query_map(params_vec.as_slice(), |row| {
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
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn hydrate_blocks(conn: &Connection, ids: &[&str]) -> Result<Vec<PaletteHit>> {
    let ph = placeholders(ids.len());
    let sql = format!("SELECT id, tab_id, cmd FROM command_blocks WHERE id IN ({ph})");
    let mut stmt = conn.prepare(&sql)?;
    let params_vec: Vec<&dyn rusqlite::ToSql> =
        ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
    let rows = stmt
        .query_map(params_vec.as_slice(), |row| {
            let id: String = row.get(0)?;
            let tab_id: String = row.get(1)?;
            let cmd: String = row.get(2)?;
            Ok(PaletteHit {
                kind: PaletteKind::Block,
                target_id: id.clone(),
                title: cmd,
                subtitle: Some(format!("tab {}", tab_id)),
                score: 1.0,
                recency_boost: 0.0,
                frequency_boost: 0.0,
                meta: json!({ "block_id": id, "tab_id": tab_id }),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn hydrate_workflows(conn: &Connection, ids: &[&str]) -> Result<Vec<PaletteHit>> {
    if !table_exists(conn, "workflows")? {
        return Ok(Vec::new());
    }
    let ph = placeholders(ids.len());
    let sql =
        format!("SELECT id, name, description, vendor, platform FROM workflows WHERE id IN ({ph})");
    let mut stmt = conn.prepare(&sql)?;
    let params_vec: Vec<&dyn rusqlite::ToSql> =
        ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
    let rows = stmt
        .query_map(params_vec.as_slice(), |row| {
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

fn hydrate_notebooks(conn: &Connection, ids: &[&str]) -> Result<Vec<PaletteHit>> {
    if !table_exists(conn, "notebooks")? {
        return Ok(Vec::new());
    }
    let ph = placeholders(ids.len());
    let sql = format!(
        "SELECT id, title, description, vendor, platform FROM notebooks WHERE id IN ({ph})"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params_vec: Vec<&dyn rusqlite::ToSql> =
        ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
    let rows = stmt
        .query_map(params_vec.as_slice(), |row| {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let description: Option<String> = row.get(2)?;
            let vendor: Option<String> = row.get(3)?;
            let platform: Option<String> = row.get(4)?;
            Ok(PaletteHit {
                kind: PaletteKind::Notebook,
                target_id: id.clone(),
                title,
                subtitle: description.or_else(|| match (&vendor, &platform) {
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

fn hydrate_devices(conn: &Connection, ids: &[&str]) -> Result<Vec<PaletteHit>> {
    if !table_exists(conn, "netconf_devices")? {
        return Ok(Vec::new());
    }
    // Device target_id is the integer id.toString() — bind as string and let
    // SQLite coerce since the column is INTEGER.
    let ph = placeholders(ids.len());
    let sql = format!(
        "SELECT id, name, host, port, username, platform
         FROM netconf_devices WHERE id IN ({ph})"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params_vec: Vec<&dyn rusqlite::ToSql> =
        ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
    let rows = stmt
        .query_map(params_vec.as_slice(), |row| {
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
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn hydrate_ssh(conn: &Connection, ids: &[&str]) -> Result<Vec<PaletteHit>> {
    if !table_exists(conn, "ssh_connections")? {
        return Ok(Vec::new());
    }
    let ph = placeholders(ids.len());
    let sql = format!(
        "SELECT id, name, host, COALESCE(user,''), COALESCE(port, 22), last_used_at
         FROM ssh_connections WHERE id IN ({ph})"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params_vec: Vec<&dyn rusqlite::ToSql> =
        ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
    let rows = stmt
        .query_map(params_vec.as_slice(), |row| {
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
                    "id": id, "host": host, "user": user, "port": port,
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

fn unix_now_seconds() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
