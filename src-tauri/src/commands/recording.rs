//! Plan 14 — Session recording Tauri commands.

use crate::commands::AppState;
use crate::recording::supervisor::RecordingDto;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

// Async so the command runs on Tauri's Tokio runtime: the supervisor spawns a
// background writer task, which requires an active runtime. (A synchronous
// command runs on a plain thread with no reactor and would abort.)
#[tauri::command]
pub async fn recording_start(
    state: State<'_, AppState>,
    app: AppHandle,
    tab_id: String,
    session_kind: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<RecordingDto, String> {
    let cols = cols.unwrap_or(120);
    let rows = rows.unwrap_or(40);
    // A "local" terminal recording is fed exclusively by the PTY tap, so a
    // missing PTY for this id means the cast would be empty. Catch that up
    // front instead of silently writing a header-only file. (Other session
    // kinds — api/netconf/editor — are fed via explicit APIs and legitimately
    // have no PTY, so the guard is scoped to "local".)
    let pty_keys: Vec<String> = state.ptys.lock().keys().cloned().collect();
    let has_pty = pty_keys.iter().any(|k| k == &tab_id);
    tracing::info!(requested = %tab_id, available = ?pty_keys, has_pty, "recording_start: PTY lookup");
    if session_kind == "local" && !has_pty {
        return Err(format!(
            "no active terminal to record for id {tab_id} (available PTYs: {pty_keys:?})"
        ));
    }

    let (dto, tap_tx) = state
        .recording
        .start(&tab_id, &session_kind, cols, rows)
        .map_err(|e| e.to_string())?;
    {
        let ptys = state.ptys.lock();
        if let Some(handle) = ptys.get(&tab_id) {
            handle.attach_tap(tap_tx);
        }
        // If no PTY (api/netconf/editor tab), the supervisor still runs;
        // explicit feed APIs may push bytes later.
    }
    let _ = app.emit("recording://started", &dto);
    Ok(dto)
}

#[tauri::command]
pub async fn recording_stop(
    state: State<'_, AppState>,
    app: AppHandle,
    tab_id: String,
) -> Result<RecordingDto, String> {
    {
        let ptys = state.ptys.lock();
        if let Some(handle) = ptys.get(&tab_id) {
            handle.detach_tap();
        }
    }
    let dto = state
        .recording
        .stop(&tab_id)
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit("recording://stopped", &dto);
    Ok(dto)
}

#[tauri::command]
pub fn recording_status(
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Option<RecordingDto>, String> {
    Ok(state.recording.active_recording(&tab_id))
}

#[tauri::command]
pub fn recording_list(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<RecordingDto>, String> {
    state
        .recording
        .list(limit.unwrap_or(200))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn recording_get(
    state: State<'_, AppState>,
    recording_id: String,
) -> Result<Option<RecordingDto>, String> {
    state
        .recording
        .get(&recording_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn recording_delete(state: State<'_, AppState>, recording_id: String) -> Result<(), String> {
    state
        .recording
        .delete(&recording_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn recording_export(
    state: State<'_, AppState>,
    recording_id: String,
    target_path: String,
) -> Result<(), String> {
    let dto = state
        .recording
        .get(&recording_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "recording not found".to_string())?;
    let src = PathBuf::from(&dto.path);
    let dst = PathBuf::from(&target_path);
    std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn recording_export_text(
    state: State<'_, AppState>,
    recording_id: String,
    target_path: String,
) -> Result<(), String> {
    let dto = state
        .recording
        .get(&recording_id)
        .map_err(|e| e.to_string())?;
    crate::transcript_export::export_recording_text(
        dto.as_ref(),
        std::path::Path::new(&target_path),
    )
    .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct RedactionRow {
    pub pattern: String,
    pub replacement_hash: String,
    pub matches: i64,
}

#[tauri::command]
pub fn recording_redaction_summary(
    state: State<'_, AppState>,
    recording_id: String,
) -> Result<Vec<RedactionRow>, String> {
    let rows = state
        .recording
        .redaction_summary(&recording_id)
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(p, h, m)| RedactionRow {
            pattern: p,
            replacement_hash: h,
            matches: m,
        })
        .collect())
}

#[tauri::command]
pub fn recording_read_cast(
    state: State<'_, AppState>,
    recording_id: String,
) -> Result<String, String> {
    let dto = state
        .recording
        .get(&recording_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "recording not found".to_string())?;
    std::fs::read_to_string(&dto.path).map_err(|e| e.to_string())
}
