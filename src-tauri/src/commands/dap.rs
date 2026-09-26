//! Restricted Tauri command surface for Zed Mode's Python debugger.

use super::AppState;
use crate::dap::{
    DapAvailability, DapBreakpointSet, DapEventSink, DapLaunchConfig, DapSessionInfo,
    DAP_BREAKPOINTS_CHANGED_EVENT, DAP_EVENT,
};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

fn tauri_event_sink(app: AppHandle) -> DapEventSink {
    Arc::new(move |event| {
        if let Err(error) = app.emit(DAP_EVENT, &event) {
            tracing::warn!(
                session_id = %event.session_id,
                tab_id = %event.tab_id,
                %error,
                "failed to emit DAP event"
            );
        }
    })
}

#[tauri::command]
pub async fn dap_check_available(
    state: State<'_, AppState>,
    workspace_root: String,
) -> Result<DapAvailability, String> {
    Ok(state.dap_manager.check_available(&workspace_root).await)
}

#[tauri::command]
pub fn dap_resolve_interpreter(
    state: State<'_, AppState>,
    workspace_root: String,
    explicit: Option<String>,
) -> Result<String, String> {
    state
        .dap_manager
        .resolve_interpreter(&workspace_root, explicit.as_deref())
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn dap_start(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    workspace_root: String,
    program: String,
    interpreter: Option<String>,
    args: Vec<String>,
    env: HashMap<String, String>,
    stop_on_entry: bool,
    just_my_code: bool,
) -> Result<DapSessionInfo, String> {
    state
        .dap_manager
        .start(
            DapLaunchConfig {
                tab_id,
                workspace_root,
                program,
                interpreter,
                args,
                env,
                stop_on_entry,
                just_my_code,
            },
            tauri_event_sink(app),
        )
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn dap_restart(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<DapSessionInfo, String> {
    state
        .dap_manager
        .restart(&session_id, tauri_event_sink(app))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn dap_stop(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state
        .dap_manager
        .stop(&session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn dap_clear_tab(state: State<'_, AppState>, tab_id: String) -> Result<(), String> {
    state.dap_manager.remove_tab(&tab_id).await;
    Ok(())
}

#[tauri::command]
pub async fn dap_session_for_tab(
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Option<DapSessionInfo>, String> {
    Ok(state.dap_manager.session_for_tab(&tab_id).await)
}

#[tauri::command]
pub async fn dap_breakpoints_get(
    state: State<'_, AppState>,
    tab_id: String,
    workspace_root: String,
    file_path: String,
) -> Result<DapBreakpointSet, String> {
    state
        .dap_manager
        .get_breakpoints(&tab_id, &workspace_root, &file_path)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn dap_breakpoints_set(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    workspace_root: String,
    file_path: String,
    lines: Vec<i64>,
) -> Result<DapBreakpointSet, String> {
    let changed = state
        .dap_manager
        .set_breakpoints(&tab_id, &workspace_root, &file_path, lines)
        .await
        .map_err(|error| error.to_string())?;
    if let Err(error) = app.emit(DAP_BREAKPOINTS_CHANGED_EVENT, &changed) {
        tracing::warn!(
            tab_id = %changed.tab_id,
            file_path = %changed.file_path,
            %error,
            "failed to emit DAP breakpoint change"
        );
    }
    Ok(changed)
}

async fn request(
    state: State<'_, AppState>,
    session_id: String,
    command: &str,
    arguments: Value,
) -> Result<Value, String> {
    state
        .dap_manager
        .request(&session_id, command, arguments)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn dap_threads(state: State<'_, AppState>, session_id: String) -> Result<Value, String> {
    request(state, session_id, "threads", json!({})).await
}

#[tauri::command]
pub async fn dap_stack_trace(
    state: State<'_, AppState>,
    session_id: String,
    thread_id: i64,
) -> Result<Value, String> {
    request(
        state,
        session_id,
        "stackTrace",
        json!({ "threadId": thread_id, "startFrame": 0, "levels": 200 }),
    )
    .await
}

#[tauri::command]
pub async fn dap_scopes(
    state: State<'_, AppState>,
    session_id: String,
    frame_id: i64,
) -> Result<Value, String> {
    request(state, session_id, "scopes", json!({ "frameId": frame_id })).await
}

#[tauri::command]
pub async fn dap_variables(
    state: State<'_, AppState>,
    session_id: String,
    variables_reference: i64,
) -> Result<Value, String> {
    request(
        state,
        session_id,
        "variables",
        json!({
            "variablesReference": variables_reference,
            "start": 0,
            "count": 500,
        }),
    )
    .await
}

#[tauri::command]
pub async fn dap_evaluate(
    state: State<'_, AppState>,
    session_id: String,
    expression: String,
    frame_id: Option<i64>,
) -> Result<Value, String> {
    let mut arguments = Map::from_iter([
        ("expression".to_string(), Value::String(expression)),
        ("context".to_string(), Value::String("watch".to_string())),
    ]);
    if let Some(frame_id) = frame_id {
        arguments.insert("frameId".to_string(), Value::from(frame_id));
    }
    request(state, session_id, "evaluate", Value::Object(arguments)).await
}

async fn thread_control(
    state: State<'_, AppState>,
    session_id: String,
    thread_id: i64,
    command: &str,
) -> Result<Value, String> {
    request(state, session_id, command, json!({ "threadId": thread_id })).await
}

#[tauri::command]
pub async fn dap_continue(
    state: State<'_, AppState>,
    session_id: String,
    thread_id: i64,
) -> Result<Value, String> {
    thread_control(state, session_id, thread_id, "continue").await
}

#[tauri::command]
pub async fn dap_pause(
    state: State<'_, AppState>,
    session_id: String,
    thread_id: i64,
) -> Result<Value, String> {
    thread_control(state, session_id, thread_id, "pause").await
}

#[tauri::command]
pub async fn dap_next(
    state: State<'_, AppState>,
    session_id: String,
    thread_id: i64,
) -> Result<Value, String> {
    thread_control(state, session_id, thread_id, "next").await
}

#[tauri::command]
pub async fn dap_step_in(
    state: State<'_, AppState>,
    session_id: String,
    thread_id: i64,
) -> Result<Value, String> {
    thread_control(state, session_id, thread_id, "stepIn").await
}

#[tauri::command]
pub async fn dap_step_out(
    state: State<'_, AppState>,
    session_id: String,
    thread_id: i64,
) -> Result<Value, String> {
    thread_control(state, session_id, thread_id, "stepOut").await
}
