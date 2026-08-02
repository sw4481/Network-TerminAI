use chrono::Utc;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use super::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct PaneLayout {
    pub id: String,
    pub tab_id: String,
    pub layout_json: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Get the pane layout for a given tab_id.
/// Returns the layout_json string, or None if no layout exists.
#[tauri::command]
pub async fn panes_get_layout(
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Option<String>, String> {
    let conn = state.db.lock();

    let result = conn
        .query_row(
            "SELECT layout_json FROM pane_layouts WHERE tab_id = ?",
            rusqlite::params![tab_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    Ok(result)
}

/// Save or update the pane layout for a given tab_id.
/// Uses UPSERT logic to either insert a new record or update the existing one.
#[tauri::command]
pub async fn panes_save_layout(
    state: State<'_, AppState>,
    tab_id: String,
    layout_json: String,
) -> Result<(), String> {
    let conn = state.db.lock();
    let now = Utc::now().timestamp();

    // Check if a layout already exists for this tab
    let existing_id: Option<String> = conn
        .query_row(
            "SELECT id FROM pane_layouts WHERE tab_id = ?",
            rusqlite::params![&tab_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let id = existing_id.unwrap_or_else(|| Uuid::new_v4().to_string());

    conn.execute(
        "INSERT INTO pane_layouts (id, tab_id, layout_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(tab_id) DO UPDATE SET
           layout_json = excluded.layout_json,
           updated_at = excluded.updated_at",
        rusqlite::params![id, tab_id, layout_json, now, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Delete the pane layout for a given tab_id.
#[tauri::command]
pub async fn panes_delete_layout(state: State<'_, AppState>, tab_id: String) -> Result<(), String> {
    let conn = state.db.lock();

    conn.execute(
        "DELETE FROM pane_layouts WHERE tab_id = ?",
        rusqlite::params![tab_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}
