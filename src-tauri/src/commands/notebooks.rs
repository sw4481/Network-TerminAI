use serde::{Deserialize, Serialize};
use tauri::State;

use super::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct Notebook {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub blocks_json: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[tauri::command]
pub async fn notebooks_save(
    state: State<'_, AppState>,
    name: String,
    description: Option<String>,
    blocks_json: String,
) -> Result<String, String> {
    let conn = state.db.lock();
    let notebook_id = format!("notebook-{}", uuid::Uuid::new_v4());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    conn.execute(
        "INSERT INTO block_notebooks (id, name, description, blocks_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![notebook_id, name, description, blocks_json, now, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(notebook_id)
}

#[tauri::command]
pub async fn notebooks_list(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<Notebook>, String> {
    let conn = state.db.lock();
    let limit = limit.unwrap_or(50);

    let mut stmt = conn
        .prepare(
            "SELECT id, name, description, blocks_json, created_at, updated_at
             FROM block_notebooks
             ORDER BY created_at DESC
             LIMIT ?",
        )
        .map_err(|e| e.to_string())?;

    let notebooks = stmt
        .query_map(rusqlite::params![limit], |row| {
            Ok(Notebook {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                blocks_json: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(notebooks)
}

#[tauri::command]
pub async fn notebooks_get(
    state: State<'_, AppState>,
    notebook_id: String,
) -> Result<Notebook, String> {
    let conn = state.db.lock();

    let notebook = conn
        .query_row(
            "SELECT id, name, description, blocks_json, created_at, updated_at
             FROM block_notebooks
             WHERE id = ?",
            rusqlite::params![notebook_id],
            |row| {
                Ok(Notebook {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    blocks_json: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    Ok(notebook)
}

#[tauri::command]
pub async fn notebooks_delete(
    state: State<'_, AppState>,
    notebook_id: String,
) -> Result<(), String> {
    let conn = state.db.lock();

    conn.execute(
        "DELETE FROM block_notebooks WHERE id = ?",
        rusqlite::params![notebook_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}
