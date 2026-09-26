//! Tauri-facing wrappers for the palette aggregator.
//!
//! Holds the DB mutex only for the duration of the SQL fan-out and the
//! UPSERT that records a pick. The work is sync so we avoid holding the
//! guard across an `.await`.

use serde::Deserialize;
use tauri::State;

use super::AppState;
use crate::palette::{
    self,
    types::{PaletteHit, PaletteSearchArgs},
};

/// Wrapper struct so the frontend can pass the args object as a single
/// `args` field without us having to expose every PaletteSearchArgs field
/// at the tauri command boundary.
#[derive(Debug, Deserialize)]
pub struct PaletteSearchPayload {
    pub args: PaletteSearchArgs,
}

#[tauri::command]
pub async fn palette_search(
    state: State<'_, AppState>,
    payload: PaletteSearchPayload,
) -> Result<Vec<PaletteHit>, String> {
    let conn = state.db.lock();
    palette::search::run(&conn, payload.args).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn palette_record_use(
    state: State<'_, AppState>,
    target_type: String,
    target_id: String,
) -> Result<(), String> {
    let conn = state.db.lock();
    palette::usage::record(&conn, &target_type, &target_id).map_err(|e| e.to_string())
}
