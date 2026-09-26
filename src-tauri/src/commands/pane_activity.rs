use crate::commands::AppState;
use crate::pane_context::{
    load_notification_preferences, save_notification_preferences, AgentSession,
    NotificationPreferences, PaneActivity,
};
use tauri::{Emitter, State};

#[tauri::command]
pub async fn get_pane_activity(
    state: State<'_, AppState>,
    pane_id: String,
) -> Result<Option<PaneActivity>, String> {
    Ok(state.pane_manager.get_activity(&pane_id))
}

#[tauri::command]
pub async fn get_all_pane_activities(
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Vec<PaneActivity>, String> {
    Ok(state.pane_manager.get_all_activities(&tab_id))
}

#[tauri::command]
pub async fn clear_pane_notification(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    pane_id: String,
) -> Result<(), String> {
    // Clear notification state in manager
    state.pane_manager.clear_notification(&pane_id);

    // Persist to database and emit event
    {
        let db = state.db.lock();
        state
            .pane_manager
            .persist_activity(&db, &pane_id)
            .map_err(|e| e.to_string())?;
    } // Drop lock before event emission

    // Emit update event with current state
    if let Some(activity) = state.pane_manager.get_activity(&pane_id) {
        app.emit("pane_activity_updated", &activity)
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn set_pane_focus(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    pane_id: String,
) -> Result<(), String> {
    // Update focus state in manager
    state.pane_manager.set_focus(&pane_id);

    // Persist to database and emit event
    {
        let db = state.db.lock();
        state
            .pane_manager
            .persist_activity(&db, &pane_id)
            .map_err(|e| e.to_string())?;
    } // Drop lock before event emission

    // Emit update event with current state
    if let Some(activity) = state.pane_manager.get_activity(&pane_id) {
        app.emit("pane_activity_updated", &activity)
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn register_agent_session(
    pane_id: String,
    agent_type: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .pane_manager
        .register_agent_session(&pane_id, &agent_type);

    // Emit event for frontend to update UI
    app.emit("agent_session_updated", ()).ok();

    Ok(())
}

#[tauri::command]
pub async fn unregister_agent_session(
    pane_id: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.pane_manager.unregister_agent_session(&pane_id);

    app.emit("agent_session_updated", ()).ok();

    Ok(())
}

#[tauri::command]
pub async fn get_active_agent_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<AgentSession>, String> {
    Ok(state.pane_manager.get_active_agent_sessions())
}

#[tauri::command]
pub async fn update_notification_preferences(
    prefs: NotificationPreferences,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock();
    save_notification_preferences(&db, &prefs)
        .map_err(|e| format!("Failed to save preferences: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn get_notification_preferences(
    state: State<'_, AppState>,
) -> Result<NotificationPreferences, String> {
    let db = state.db.lock();
    load_notification_preferences(&db).map_err(|e| format!("Failed to load preferences: {}", e))
}

/// Current foreground agent CLI (`"claude"`/`"codex"`) running in a pane's PTY,
/// or `None`. Used by the frontend to hydrate the agent toolbelt on mount
/// (the live signal comes from the `pane_foreground_agent` event).
#[tauri::command]
pub fn get_pane_foreground_agent(
    state: State<'_, AppState>,
    pane_id: String,
) -> Result<Option<String>, String> {
    let ptys = state.ptys.lock();
    let Some(h) = ptys.get(&pane_id) else {
        return Ok(None);
    };
    let name = h.foreground_process_name();
    Ok(name.and_then(|n| crate::pane_context::foreground::foreground_agent_for(&n)))
}
