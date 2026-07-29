//! Tauri commands exposing the LSP manager to the frontend.

use super::AppState;
use tauri::State;

#[tauri::command]
pub async fn lsp_start(
    state: State<'_, AppState>,
    language: String,
) -> Result<(), String> {
    let config = match language.as_str() {
        "python" => crate::lsp::python::get_python_lsp_config(),
        "yaml" => crate::lsp::yaml::get_yaml_lsp_config(),
        _ => return Err(format!("Unsupported language: {}", language)),
    };

    state
        .lsp_manager
        .start_lsp(&language, config)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lsp_stop(
    state: State<'_, AppState>,
    language: String,
) -> Result<(), String> {
    state
        .lsp_manager
        .stop_lsp(&language)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lsp_request(
    state: State<'_, AppState>,
    language: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    state
        .lsp_manager
        .send_request(&language, request)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lsp_is_running(
    state: State<'_, AppState>,
    language: String,
) -> Result<bool, String> {
    Ok(state.lsp_manager.is_running(&language).await)
}

#[tauri::command]
pub async fn lsp_check_available() -> Result<Vec<String>, String> {
    let mut available = Vec::new();

    if crate::lsp::python::check_pylsp_installed() {
        available.push("python".to_string());
    }

    if crate::lsp::yaml::check_yaml_ls_installed() {
        available.push("yaml".to_string());
    }

    Ok(available)
}
