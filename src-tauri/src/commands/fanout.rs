use crate::commands::AppState;
use crate::fanout::{
    events::FanoutEvent,
    executor::{EventSink, ExecuteArgs, Executor, MemberRef, NoopParse},
    model::{
        CsvImportResult, DeviceKind, FanoutGroup, FanoutMember, FanoutRunDetail, FanoutRunSummary,
    },
    store::FanoutStore,
    worker_live::LiveFactory,
};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

/// Production sink that forwards executor events to the Tauri event bus.
struct TauriSink {
    app: AppHandle,
}

impl EventSink for TauriSink {
    fn emit(&self, event: &FanoutEvent) {
        if let Err(e) = self.app.emit(crate::fanout::events::CHANNEL, event) {
            tracing::warn!(error = %e, "fanout event emit failed");
        }
    }
}

fn ensure_executor(state: &State<'_, AppState>, app: &AppHandle) -> Executor {
    let mut slot = state.fanout_executor.lock();
    if let Some(ex) = slot.as_ref() {
        return ex.clone();
    }
    // Plan 09 — wire the project-wide guardrail ruleset so every fan-out
    // command is classified before reaching the wire. Non-Tier-0 commands
    // are refused with the `blocked_by_guardrail` failure kind.
    let ex = Executor::with_ruleset(
        state.db.clone(),
        Arc::new(LiveFactory),
        Arc::new(TauriSink { app: app.clone() }),
        Arc::new(NoopParse),
        state.guardrails_ruleset.clone(),
    );
    *slot = Some(ex.clone());
    ex
}

#[tauri::command]
pub fn fanout_group_create(
    state: State<'_, AppState>,
    name: String,
    description: Option<String>,
) -> Result<FanoutGroup, String> {
    let mut db = state.db.lock();
    FanoutStore::create_group(&mut db, &name, description.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fanout_group_get(state: State<'_, AppState>, id: String) -> Result<FanoutGroup, String> {
    FanoutStore::get_group(&state.db.lock(), &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fanout_group_update(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    description: Option<Option<String>>,
) -> Result<FanoutGroup, String> {
    let db = state.db.lock();
    let desc_arg = description.as_ref().map(|d| d.as_deref());
    FanoutStore::update_group(&db, &id, name.as_deref(), desc_arg).map_err(|e| e.to_string())?;
    FanoutStore::get_group(&db, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fanout_group_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    FanoutStore::delete_group(&state.db.lock(), &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fanout_group_list(state: State<'_, AppState>) -> Result<Vec<FanoutGroup>, String> {
    FanoutStore::list_groups(&state.db.lock()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fanout_member_add(
    state: State<'_, AppState>,
    group_id: String,
    device_id: String,
    device_kind: String,
) -> Result<(), String> {
    let kind = DeviceKind::parse(&device_kind).map_err(|e| e.to_string())?;
    FanoutStore::add_member(&state.db.lock(), &group_id, &device_id, kind)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fanout_member_add_bulk(
    state: State<'_, AppState>,
    group_id: String,
    members: Vec<(String, String)>,
) -> Result<usize, String> {
    let parsed: Result<Vec<_>, _> = members
        .into_iter()
        .map(|(id, kind)| DeviceKind::parse(&kind).map(|k| (id, k)))
        .collect();
    let parsed = parsed.map_err(|e| e.to_string())?;
    let mut db = state.db.lock();
    FanoutStore::add_members_bulk(&mut db, &group_id, &parsed).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fanout_member_remove(
    state: State<'_, AppState>,
    group_id: String,
    device_id: String,
    device_kind: String,
) -> Result<(), String> {
    let kind = DeviceKind::parse(&device_kind).map_err(|e| e.to_string())?;
    FanoutStore::remove_member(&state.db.lock(), &group_id, &device_id, kind)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fanout_member_list(
    state: State<'_, AppState>,
    group_id: String,
) -> Result<Vec<FanoutMember>, String> {
    FanoutStore::list_members(&state.db.lock(), &group_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fanout_group_import_csv(
    state: State<'_, AppState>,
    group_id: String,
    csv_body: String,
) -> Result<CsvImportResult, String> {
    let mut db = state.db.lock();
    FanoutStore::import_csv(&mut db, &group_id, &csv_body).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fanout_run_list(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<FanoutRunSummary>, String> {
    FanoutStore::list_runs(&state.db.lock(), limit.unwrap_or(50)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fanout_run_get(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<FanoutRunDetail, String> {
    FanoutStore::get_run_detail(&state.db.lock(), &run_id).map_err(|e| e.to_string())
}

#[derive(serde::Deserialize)]
pub struct StartMember {
    pub device_id: String,
    pub device_kind: String,
    pub display_name: Option<String>,
}

/// Spawn a fan-out run. Returns the run_id immediately; status flows over the
/// `fanout://event` channel.
#[tauri::command]
pub async fn fanout_run_start(
    state: State<'_, AppState>,
    app: AppHandle,
    command: String,
    group_id: Option<String>,
    member_overrides: Option<Vec<StartMember>>,
    timeout_ms: Option<u64>,
    concurrency: Option<usize>,
) -> Result<String, String> {
    // Resolve member set: explicit override beats group lookup.
    let members: Vec<MemberRef> = if let Some(overrides) = member_overrides {
        overrides
            .into_iter()
            .map(|m| {
                let kind = DeviceKind::parse(&m.device_kind)?;
                Ok(MemberRef {
                    device_id: m.device_id,
                    device_kind: kind,
                    display_name: m.display_name.unwrap_or_else(|| "(unknown)".to_string()),
                })
            })
            .collect::<Result<Vec<_>, String>>()?
    } else if let Some(gid) = group_id.as_ref() {
        let conn = state.db.lock();
        FanoutStore::list_members(&conn, gid)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|m| MemberRef {
                device_id: m.device_id,
                device_kind: m.device_kind,
                display_name: m.display_name,
            })
            .collect()
    } else {
        return Err("either group_id or member_overrides must be provided".to_string());
    };

    if members.len() > crate::fanout::executor::SEMAPHORE_CAP {
        return Err(format!(
            "fan-out cap exceeded: {} > {}",
            members.len(),
            crate::fanout::executor::SEMAPHORE_CAP
        ));
    }

    let ex = ensure_executor(&state, &app);
    let args = ExecuteArgs {
        command,
        group_id,
        members,
        timeout_ms: timeout_ms.unwrap_or(30_000),
        concurrency: concurrency
            .unwrap_or(crate::fanout::executor::SEMAPHORE_CAP)
            .min(crate::fanout::executor::SEMAPHORE_CAP),
    };
    ex.spawn_run(args).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fanout_run_cancel(
    state: State<'_, AppState>,
    app: AppHandle,
    run_id: String,
) -> Result<(), String> {
    let ex = ensure_executor(&state, &app);
    ex.cancel_run(&run_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fanout_device_cancel(
    state: State<'_, AppState>,
    app: AppHandle,
    run_id: String,
    device_id: String,
    device_kind: String,
) -> Result<(), String> {
    let kind = DeviceKind::parse(&device_kind).map_err(|e| e.to_string())?;
    let ex = ensure_executor(&state, &app);
    ex.cancel_device(&run_id, &device_id, kind)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fanout_run_export_zip(
    state: State<'_, AppState>,
    run_id: String,
    dest_path: String,
) -> Result<crate::fanout::export::ExportManifest, String> {
    let conn = state.db.lock();
    crate::fanout::export::export_run_zip(&conn, &run_id, std::path::Path::new(&dest_path))
        .map_err(|e| e.to_string())
}

/// Read the raw stdout for a block id produced by a fan-out run.
#[tauri::command]
pub fn fanout_block_output_text(
    state: State<'_, AppState>,
    block_id: String,
) -> Result<String, String> {
    let conn = state.db.lock();
    let bytes: Vec<u8> = conn
        .query_row(
            "SELECT output FROM command_blocks WHERE id = ?1",
            [&block_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub async fn fanout_device_retry(
    state: State<'_, AppState>,
    app: AppHandle,
    run_id: String,
    device_id: String,
    device_kind: String,
) -> Result<i64, String> {
    let kind = DeviceKind::parse(&device_kind).map_err(|e| e.to_string())?;
    // Pull command + display_name + timeout from existing run
    let (command, display_name, timeout_ms) = {
        let conn = state.db.lock();
        let cmd: String = conn
            .query_row(
                "SELECT command FROM fanout_runs WHERE id = ?1",
                [&run_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let to: i64 = conn
            .query_row(
                "SELECT json_extract(params_json, '$.timeout_ms') FROM fanout_runs WHERE id=?1",
                [&run_id],
                |r| r.get(0),
            )
            .unwrap_or(30_000);
        let name: Option<String> = conn
            .query_row(
                "SELECT COALESCE(s.name, n.name)
                   FROM (SELECT ?1 AS device_id, ?2 AS device_kind) k
                   LEFT JOIN ssh_connections   s ON k.device_kind='ssh'     AND s.id = k.device_id
                   LEFT JOIN netconf_devices   n ON k.device_kind='netconf' AND CAST(n.id AS TEXT) = k.device_id",
                rusqlite::params![&device_id, kind.as_str()],
                |r| r.get(0),
            )
            .ok()
            .flatten();
        (
            cmd,
            name.unwrap_or_else(|| "(unknown)".to_string()),
            to as u64,
        )
    };
    let ex = ensure_executor(&state, &app);
    ex.retry_device(
        &run_id,
        &device_id,
        kind,
        &display_name,
        &command,
        timeout_ms,
    )
    .await
    .map_err(|e| e.to_string())
}
