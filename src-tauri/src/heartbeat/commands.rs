use crate::commands::AppState;
use crate::heartbeat::repo::HeartbeatRepo;
use crate::heartbeat::types::*;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckInput {
    pub check_group_name: String,
    pub agent_id: String,
    pub agent_prompt: String,
    pub sort_order: i32,
}

fn require_scheduler<T>(scheduler: Option<T>) -> Result<T, String> {
    scheduler.ok_or_else(|| "Heartbeat scheduler not initialized".to_string())
}

#[tauri::command]
pub async fn heartbeat_create(
    name: String,
    description: String,
    interval_minutes: u32,
    retention_days: u32,
    checks: Vec<CheckInput>,
    state: State<'_, AppState>,
) -> Result<Heartbeat, String> {
    // An enabled heartbeat without a scheduler would be persisted but never
    // execute. Fail before creating the row or checks.
    let scheduler = {
        let lock = state.heartbeat_scheduler.lock();
        require_scheduler(lock.clone())?
    };

    let heartbeat = {
        let conn = state.db.lock();
        HeartbeatRepo::create_heartbeat(
            &conn,
            &name,
            &description,
            interval_minutes,
            retention_days,
        )
        .map_err(|e| e.to_string())?
    };

    // Add checks
    for check in checks {
        let conn = state.db.lock();
        HeartbeatRepo::add_check(
            &conn,
            &heartbeat.id,
            &check.check_group_name,
            &check.agent_id,
            &check.agent_prompt,
            check.sort_order,
        )
        .map_err(|e| e.to_string())?;
    }

    // Register with scheduler
    scheduler
        .add_heartbeat(&heartbeat)
        .await
        .map_err(|e| e.to_string())?;

    // Re-fetch heartbeat to get updated next_run_at from scheduler registration
    let updated_heartbeat = {
        let conn = state.db.lock();
        HeartbeatRepo::get_heartbeat(&conn, &heartbeat.id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Failed to fetch created heartbeat".to_string())?
    };

    Ok(updated_heartbeat)
}

#[tauri::command]
pub async fn heartbeat_list(state: State<'_, AppState>) -> Result<Vec<Heartbeat>, String> {
    let conn = state.db.lock();
    HeartbeatRepo::list_heartbeats(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn heartbeat_get(
    id: String,
    state: State<'_, AppState>,
) -> Result<HeartbeatDetail, String> {
    let conn = state.db.lock();
    HeartbeatRepo::get_heartbeat_with_checks(&conn, &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Heartbeat not found".to_string())
}

#[tauri::command]
pub async fn heartbeat_update(
    id: String,
    name: String,
    description: String,
    interval_minutes: u32,
    retention_days: u32,
    state: State<'_, AppState>,
) -> Result<Heartbeat, String> {
    // Enabled rows must remain schedulable. Check before mutating so an
    // unavailable scheduler cannot silently accept an update that will never
    // execute. Paused heartbeat metadata remains editable without a scheduler.
    let scheduler = {
        let currently_enabled = {
            let conn = state.db.lock();
            HeartbeatRepo::get_heartbeat(&conn, &id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "Heartbeat not found".to_string())?
                .enabled
        };

        if currently_enabled {
            let lock = state.heartbeat_scheduler.lock();
            Some(require_scheduler(lock.clone())?)
        } else {
            None
        }
    };

    {
        let conn = state.db.lock();
        HeartbeatRepo::update_heartbeat(
            &conn,
            &id,
            &name,
            &description,
            interval_minutes,
            retention_days,
        )
        .map_err(|e| e.to_string())?;
    }

    // Re-register with scheduler (updated interval)
    let heartbeat = {
        let conn = state.db.lock();
        HeartbeatRepo::get_heartbeat(&conn, &id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Heartbeat not found".to_string())?
    };

    if heartbeat.enabled {
        // The row may have been resumed concurrently after the initial state
        // check, so validate again before accepting an enabled result.
        let scheduler = match scheduler {
            Some(scheduler) => scheduler,
            None => {
                let lock = state.heartbeat_scheduler.lock();
                require_scheduler(lock.clone())?
            }
        };
        scheduler
            .add_heartbeat(&heartbeat)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Registration writes the new phase to next_run_at. Return a fresh row so
    // the edit modal/store never receives the pre-registration timestamp.
    let updated_heartbeat = {
        let conn = state.db.lock();
        HeartbeatRepo::get_heartbeat(&conn, &id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Heartbeat not found".to_string())?
    };

    Ok(updated_heartbeat)
}

#[tauri::command]
pub async fn heartbeat_update_checks(
    id: String,
    checks: Vec<CheckInput>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let checks_tuples: Vec<_> = checks
        .into_iter()
        .map(|c| (c.check_group_name, c.agent_id, c.agent_prompt, c.sort_order))
        .collect();

    let conn = state.db.lock();
    HeartbeatRepo::update_checks(&conn, &id, checks_tuples).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn heartbeat_pause(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let scheduler = {
        let lock = state.heartbeat_scheduler.lock();
        lock.clone()
    };
    if let Some(scheduler) = scheduler {
        scheduler.pause(&id).await.map_err(|e| e.to_string())
    } else {
        Err("Scheduler not initialized".to_string())
    }
}

#[tauri::command]
pub async fn heartbeat_resume(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let scheduler = {
        let lock = state.heartbeat_scheduler.lock();
        lock.clone()
    };
    if let Some(scheduler) = scheduler {
        scheduler.resume(&id).await.map_err(|e| e.to_string())
    } else {
        Err("Scheduler not initialized".to_string())
    }
}

#[tauri::command]
pub async fn heartbeat_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let scheduler = {
        let lock = state.heartbeat_scheduler.lock();
        lock.clone()
    };
    if let Some(scheduler) = scheduler {
        scheduler.delete(&id).await.map_err(|e| e.to_string())
    } else {
        Err("Scheduler not initialized".to_string())
    }
}

#[tauri::command]
pub async fn heartbeat_trigger_now(
    id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let scheduler = {
        let lock = state.heartbeat_scheduler.lock();
        lock.clone()
    };
    if let Some(scheduler) = scheduler {
        scheduler.trigger_now(&id).await.map_err(|e| e.to_string())
    } else {
        Err("Scheduler not initialized".to_string())
    }
}

#[tauri::command]
pub async fn heartbeat_executions(
    id: String,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<HeartbeatExecution>, String> {
    let conn = state.db.lock();
    HeartbeatRepo::get_execution_history(&conn, &id, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn heartbeat_execution_detail(
    execution_id: String,
    state: State<'_, AppState>,
) -> Result<ExecutionDetail, String> {
    let conn = state.db.lock();
    HeartbeatRepo::get_execution_detail(&conn, &execution_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Execution not found".to_string())
}

#[tauri::command]
pub async fn heartbeat_suggestions_get(
    id: String,
    state: State<'_, AppState>,
) -> Result<Vec<HeartbeatSuggestion>, String> {
    let conn = state.db.lock();
    HeartbeatRepo::get_suggestions(&conn, &id, false).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn heartbeat_suggestion_apply(
    suggestion_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Get the suggestion
    let (heartbeat_id, proposed_checks_json) = {
        let conn = state.db.lock();
        let suggestion = HeartbeatRepo::get_suggestions(&conn, &suggestion_id, true)
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|s| s.id == suggestion_id)
            .ok_or_else(|| "Suggestion not found".to_string())?;
        (suggestion.heartbeat_id, suggestion.proposed_checks_json)
    };

    // Parse the proposed checks
    let checks: Vec<CheckInput> =
        serde_json::from_str(&proposed_checks_json).map_err(|e| e.to_string())?;

    // Apply the checks
    heartbeat_update_checks(heartbeat_id, checks, state).await?;

    Ok(())
}

#[tauri::command]
pub async fn heartbeat_suggestion_dismiss(
    suggestion_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock();
    HeartbeatRepo::dismiss_suggestion(&conn, &suggestion_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn heartbeat_export(id: String, state: State<'_, AppState>) -> Result<String, String> {
    let conn = state.db.lock();
    let detail = HeartbeatRepo::get_heartbeat_with_checks(&conn, &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Heartbeat not found".to_string())?;

    let export = serde_json::json!({
        "version": "1.0",
        "exported_at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
        "heartbeat": {
            "name": detail.heartbeat.name,
            "description": detail.heartbeat.description,
            "interval_minutes": detail.heartbeat.interval_minutes,
            "retention_days": detail.heartbeat.retention_days,
            "checks": detail.checks.iter().map(|c| serde_json::json!({
                "check_group_name": c.check_group_name,
                "agent_id": c.agent_id,
                "agent_prompt": c.agent_prompt,
                "sort_order": c.sort_order,
            })).collect::<Vec<_>>(),
        }
    });

    serde_json::to_string_pretty(&export).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct ImportPayload {
    version: String,
    heartbeat: ImportHeartbeat,
}

#[derive(Deserialize)]
struct ImportHeartbeat {
    name: String,
    description: String,
    interval_minutes: u32,
    retention_days: u32,
    checks: Vec<CheckInput>,
}

#[tauri::command]
pub async fn heartbeat_import(
    json: String,
    state: State<'_, AppState>,
) -> Result<Heartbeat, String> {
    let payload: ImportPayload = serde_json::from_str(&json).map_err(|e| e.to_string())?;

    if payload.version != "1.0" {
        return Err(format!("Unsupported version: {}", payload.version));
    }

    heartbeat_create(
        payload.heartbeat.name,
        payload.heartbeat.description,
        payload.heartbeat.interval_minutes,
        payload.heartbeat.retention_days,
        payload.heartbeat.checks,
        state,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::require_scheduler;

    #[test]
    fn scheduler_requirement_rejects_uninitialized_state_with_clear_error() {
        let error = require_scheduler::<()>(None).unwrap_err();
        assert_eq!(error, "Heartbeat scheduler not initialized");
    }

    #[test]
    fn scheduler_requirement_returns_initialized_value() {
        assert_eq!(require_scheduler(Some(42)).unwrap(), 42);
    }
}
