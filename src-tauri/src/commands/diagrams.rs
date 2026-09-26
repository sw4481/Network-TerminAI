//! Persist and read agent-generated diagrams (draw.io / mermaid / etc.).
//!
//! A diagram produced by the sandbox drawio helper used to live only in an
//! in-memory frontend store, so it vanished on reload. These commands back the
//! `saved_diagrams` table (migration V0083) so the Diagram viewer can list and
//! reopen diagrams across restarts.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::AppState;

/// A saved diagram row, shaped to match the frontend `StoredDiagram`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedDiagram {
    pub id: String,
    pub title: String,
    pub format: String,
    pub xml: Option<String>,
    pub source: Option<String>,
    pub url: String,
    pub image_url: Option<String>,
    pub agent_id: Option<String>,
    pub tab_id: Option<String>,
    pub created_at: i64,
}

/// Upsert a diagram. `INSERT OR REPLACE` on the caller-supplied id makes the
/// frontend's auto-save idempotent (re-saving the same diagram is a no-op).
#[tauri::command]
pub fn diagram_save(state: State<'_, AppState>, diagram: SavedDiagram) -> Result<(), String> {
    let conn = state.db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO saved_diagrams
            (id, title, format, xml, source, url, image_url, agent_id, tab_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                 COALESCE(?10, strftime('%s','now')))",
        params![
            diagram.id,
            diagram.title,
            diagram.format,
            diagram.xml,
            diagram.source,
            diagram.url,
            diagram.image_url,
            diagram.agent_id,
            diagram.tab_id,
            if diagram.created_at > 0 {
                Some(diagram.created_at)
            } else {
                None
            },
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// List saved diagrams, most recent first.
#[tauri::command]
pub fn diagram_list(state: State<'_, AppState>) -> Result<Vec<SavedDiagram>, String> {
    let conn = state.db.lock();
    let mut stmt = conn
        .prepare(
            "SELECT id, title, format, xml, source, url, image_url, agent_id, tab_id, created_at
               FROM saved_diagrams
              ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(SavedDiagram {
                id: r.get(0)?,
                title: r.get(1)?,
                format: r.get(2)?,
                xml: r.get(3)?,
                source: r.get(4)?,
                url: r.get(5)?,
                image_url: r.get(6)?,
                agent_id: r.get(7)?,
                tab_id: r.get(8)?,
                created_at: r.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// Delete one saved diagram by id.
#[tauri::command]
pub fn diagram_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.db.lock();
    conn.execute("DELETE FROM saved_diagrams WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
