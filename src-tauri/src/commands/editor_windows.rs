use crate::commands::AppState;
use crate::editor::{DetachedEditorWindowInfo, EditorWindowManager};
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const EDITOR_DETACHED_WINDOW_CLOSED_EVENT: &str = "editor-detached-window-closed";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachedEditorWindowClosed {
    pub window_id: String,
    pub tab_id: String,
    pub pane_id: String,
}

fn close_payload(info: &DetachedEditorWindowInfo) -> DetachedEditorWindowClosed {
    DetachedEditorWindowClosed {
        window_id: info.window_id.clone(),
        tab_id: info.tab_id.clone(),
        pane_id: info.pane_id.clone(),
    }
}

fn unregister_and_emit(app: &AppHandle, manager: &EditorWindowManager, window_id: &str) {
    if let Some(info) = manager.unregister(window_id) {
        if let Err(error) = app.emit(EDITOR_DETACHED_WINDOW_CLOSED_EVENT, close_payload(&info)) {
            tracing::warn!(
                %error,
                window_id,
                "failed to emit detached editor window close"
            );
        }
    }
}

fn clean_title(title: &str) -> String {
    let cleaned: String = title
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(120)
        .collect();
    if cleaned.is_empty() {
        "Detached Editor".to_string()
    } else {
        cleaned
    }
}

pub fn close_detached_editor_window(
    app: &AppHandle,
    manager: &EditorWindowManager,
    window_id: &str,
) -> Result<(), String> {
    let Some(info) = manager.get(window_id) else {
        // The source and detached webviews can both react to the same mode
        // change. Treat an already-closed registered window as success so
        // cleanup remains idempotent whichever webview wins that race.
        return Ok(());
    };
    if let Some(window) = app.get_webview_window(window_id) {
        window
            .destroy()
            .map_err(|error| format!("failed to destroy detached editor window: {error}"))?;
    }
    unregister_and_emit(app, manager, &info.window_id);
    Ok(())
}

pub fn close_detached_editor_windows_for_tab(
    app: &AppHandle,
    manager: &EditorWindowManager,
    tab_id: &str,
) -> Result<(), String> {
    for info in manager.by_tab(tab_id) {
        close_detached_editor_window(app, manager, &info.window_id)?;
    }
    Ok(())
}

#[tauri::command]
pub fn editor_detach_pane(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    pane_id: String,
    buffer_id: String,
    title: String,
    workspace_root: Option<String>,
) -> Result<DetachedEditorWindowInfo, String> {
    let tab_id = crate::validation::validate_tab_id(&tab_id).map_err(|error| error.to_string())?;
    let editor_mode = {
        let database = state.db.lock();
        super::editor::load_editor_mode(&database)?
    };
    if editor_mode != "zed" {
        return Err("detached editor windows require Zed Mode".to_string());
    }
    if pane_id.trim().is_empty() {
        return Err("pane_id must not be empty".to_string());
    }
    let buffer = state.editor_buffer_manager.get(&buffer_id);
    if buffer.is_none() {
        return Err(format!("editor buffer not registered: {buffer_id}"));
    }
    let workspace_root = match workspace_root {
        Some(root) if !root.trim().is_empty() => {
            let canonical = std::fs::canonicalize(&root)
                .map_err(|error| format!("invalid editor workspace root: {error}"))?;
            if !canonical.is_dir() {
                return Err("editor workspace root is not a directory".to_string());
            }
            if let Some(file_path) = buffer.and_then(|snapshot| snapshot.file_path) {
                let canonical_file = std::fs::canonicalize(&file_path)
                    .map_err(|error| format!("invalid detached editor file: {error}"))?;
                if !canonical_file.starts_with(&canonical) {
                    return Err("detached editor file is outside workspace root".to_string());
                }
            }
            Some(canonical.to_string_lossy().into_owned())
        }
        _ => None,
    };

    let window_id = format!("editor-{}", uuid::Uuid::new_v4());
    let info = DetachedEditorWindowInfo {
        window_id: window_id.clone(),
        tab_id,
        pane_id,
        buffer_id,
        title: clean_title(&title),
        workspace_root,
    };
    let manager = state.editor_window_manager.clone();
    manager.register(info.clone())?;

    let window = match WebviewWindowBuilder::new(
        &app,
        &window_id,
        WebviewUrl::App("index.html?view=editor-detached".into()),
    )
    .title(&info.title)
    .inner_size(900.0, 700.0)
    .min_inner_size(480.0, 320.0)
    .build()
    {
        Ok(window) => window,
        Err(error) => {
            manager.unregister(&window_id);
            return Err(format!("failed to create detached editor window: {error}"));
        }
    };

    let app_for_close = app.clone();
    let manager_for_close: Arc<EditorWindowManager> = manager;
    let window_id_for_close = window_id.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            unregister_and_emit(&app_for_close, &manager_for_close, &window_id_for_close);
        }
    });

    Ok(info)
}

#[tauri::command]
pub fn editor_detached_window_get_current(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<DetachedEditorWindowInfo, String> {
    let window_id = window.label();
    if !window_id.starts_with("editor-") {
        return Err("calling window is not a detached editor".to_string());
    }
    state
        .editor_window_manager
        .get(window_id)
        .ok_or_else(|| format!("detached editor metadata not found: {window_id}"))
}

#[tauri::command]
pub fn editor_detached_window_list(
    state: State<'_, AppState>,
) -> Result<Vec<DetachedEditorWindowInfo>, String> {
    Ok(state.editor_window_manager.list())
}

#[tauri::command]
pub fn editor_detached_window_focus(
    app: AppHandle,
    state: State<'_, AppState>,
    window_id: String,
) -> Result<(), String> {
    if state.editor_window_manager.get(&window_id).is_none() {
        return Err(format!("detached editor window not found: {window_id}"));
    }
    let window = app
        .get_webview_window(&window_id)
        .ok_or_else(|| format!("detached editor webview not found: {window_id}"))?;
    window
        .show()
        .map_err(|error| format!("failed to show detached editor window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("failed to focus detached editor window: {error}"))
}

#[tauri::command]
pub fn editor_detached_window_close(
    app: AppHandle,
    state: State<'_, AppState>,
    window_id: String,
) -> Result<(), String> {
    close_detached_editor_window(&app, &state.editor_window_manager, &window_id)
}

#[tauri::command]
pub fn editor_source_window_focus(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main editor window not found".to_string())?;
    window
        .show()
        .map_err(|error| format!("failed to show main window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("failed to focus main window: {error}"))
}
