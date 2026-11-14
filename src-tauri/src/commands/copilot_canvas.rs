use tauri::State;
use serde_json::Value;
use crate::{commands::AppState, copilot_canvas::CanvasRepository, session::Tab};

#[tauri::command]
pub fn canvas_create_workspace(state: State<'_, AppState>, title: String) -> Result<Tab, String> {
    CanvasRepository::new(&state.db.lock()).create_workspace(&title).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn canvas_list_workspaces(state: State<'_, AppState>) -> Result<Vec<Tab>, String> {
    CanvasRepository::new(&state.db.lock()).list_workspaces().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn canvas_open_workspace(state: State<'_, AppState>, workspace_id: String) -> Result<Value, String> {
    CanvasRepository::new(&state.db.lock()).open_workspace(&workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn canvas_rename_workspace(state: State<'_, AppState>, workspace_id: String, title: String) -> Result<(), String> {
    CanvasRepository::new(&state.db.lock()).rename_workspace(&workspace_id, &title).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn canvas_save_run(state: State<'_, AppState>, workspace_id: String, run: Value) -> Result<(), String> {
    CanvasRepository::new(&state.db.lock()).save_run(&workspace_id, &run).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn canvas_save_event(state: State<'_, AppState>, workspace_id: String, event: Value) -> Result<(), String> {
    CanvasRepository::new(&state.db.lock()).save_event(&workspace_id, &event).map_err(|e| e.to_string())
}
