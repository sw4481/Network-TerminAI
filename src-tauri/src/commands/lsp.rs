//! Tauri commands exposing workspace-scoped LSP sessions to the frontend.

use super::AppState;
use crate::lsp::{LspConfig, LspSessionInfo};
use serde_json::Value;
use std::path::Path;
use tauri::State;

fn config_for(language: &str, workspace_root: &str) -> Result<LspConfig, String> {
    let root = Path::new(workspace_root);
    match language {
        "python" => crate::lsp::python::get_python_lsp_config(root),
        "yaml" | "yml" => crate::lsp::yaml::get_yaml_lsp_config(root),
        _ => return Err(format!("unsupported LSP language: {language}")),
    }
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn lsp_start(
    state: State<'_, AppState>,
    language: String,
    workspace_root: String,
    client_id: String,
) -> Result<LspSessionInfo, String> {
    let config = config_for(&language, &workspace_root)?;
    state
        .lsp_manager
        .start_lsp(&language, &workspace_root, &client_id, config)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn lsp_stop(
    state: State<'_, AppState>,
    language: String,
    workspace_root: String,
    client_id: String,
) -> Result<(), String> {
    state
        .lsp_manager
        .stop_lsp(&language, &workspace_root, &client_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn lsp_request(
    state: State<'_, AppState>,
    language: String,
    workspace_root: String,
    method: String,
    params: Value,
) -> Result<Value, String> {
    state
        .lsp_manager
        .send_request(&language, &workspace_root, &method, params)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn lsp_document_open(
    state: State<'_, AppState>,
    language: String,
    workspace_root: String,
    client_id: String,
    uri: String,
    language_id: String,
    text: String,
) -> Result<(), String> {
    state
        .lsp_manager
        .document_open(
            &language,
            &workspace_root,
            &client_id,
            &uri,
            &language_id,
            &text,
        )
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn lsp_document_change(
    state: State<'_, AppState>,
    language: String,
    workspace_root: String,
    client_id: String,
    uri: String,
    text: String,
) -> Result<(), String> {
    state
        .lsp_manager
        .document_change(&language, &workspace_root, &client_id, &uri, &text)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn lsp_document_close(
    state: State<'_, AppState>,
    language: String,
    workspace_root: String,
    client_id: String,
    uri: String,
) -> Result<(), String> {
    state
        .lsp_manager
        .document_close(&language, &workspace_root, &client_id, &uri)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn lsp_is_running(
    state: State<'_, AppState>,
    language: String,
    workspace_root: String,
) -> Result<bool, String> {
    state
        .lsp_manager
        .is_running(&language, &workspace_root)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn lsp_check_available(workspace_root: String) -> Result<Vec<String>, String> {
    let root = Path::new(&workspace_root);
    let mut available = Vec::new();
    if crate::lsp::python::check_python_lsp_installed(root) {
        available.push("python".to_string());
    }
    if crate::lsp::yaml::check_yaml_ls_installed(root) {
        available.push("yaml".to_string());
    }
    Ok(available)
}
