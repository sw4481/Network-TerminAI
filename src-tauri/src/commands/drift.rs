use crate::commands::AppState;
use crate::drift::archive::{ConfigSnapshot, ConfigSnapshotRepo};
use crate::drift::exception::{DriftException, DriftExceptionRepo};
use crate::drift::intent::{IntentRepo, IntentSelector, IntentTemplate};
use crate::drift::normalize::{normalize, Vendor};
use crate::drift::render::render_intent;
use crate::drift::report::{DriftReport, DriftReportRepo};
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn intent_create(state: State<'_, AppState>, tpl: IntentTemplate) -> Result<String, String> {
    IntentRepo::create(&state.db.lock(), tpl).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn intent_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<IntentTemplate>, String> {
    IntentRepo::get(&state.db.lock(), &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn intent_list(
    state: State<'_, AppState>,
    vendor: Option<String>,
    platform: Option<String>,
) -> Result<Vec<IntentTemplate>, String> {
    IntentRepo::list_filtered(&state.db.lock(), vendor.as_deref(), platform.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn intent_update_body(
    state: State<'_, AppState>,
    id: String,
    body: String,
) -> Result<(), String> {
    IntentRepo::update_body(&state.db.lock(), &id, &body).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn intent_update_vars(
    state: State<'_, AppState>,
    id: String,
    vars_yaml: String,
) -> Result<(), String> {
    IntentRepo::update_vars(&state.db.lock(), &id, &vars_yaml).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn intent_update_selector(
    state: State<'_, AppState>,
    id: String,
    selector: IntentSelector,
) -> Result<(), String> {
    IntentRepo::update_selector(&state.db.lock(), &id, &selector).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn intent_update_match_mode(
    state: State<'_, AppState>,
    id: String,
    match_mode: String,
) -> Result<(), String> {
    let mode = crate::drift::intent::MatchMode::parse(&match_mode)?;
    IntentRepo::update_match_mode(&state.db.lock(), &id, mode).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn intent_rename(state: State<'_, AppState>, id: String, name: String) -> Result<(), String> {
    IntentRepo::rename(&state.db.lock(), &id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn intent_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    IntentRepo::delete(&state.db.lock(), &id).map_err(|e| e.to_string())
}

/// Render a stored intent. Caller may supply `override_vars_yaml` to
/// override default YAML vars (jinja kind only).
#[tauri::command]
pub fn intent_render(
    state: State<'_, AppState>,
    id: String,
    override_vars_yaml: Option<String>,
) -> Result<String, String> {
    let tpl = IntentRepo::get(&state.db.lock(), &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("intent {id} not found"))?;
    render_intent(&tpl, override_vars_yaml.as_deref()).map_err(|e| e.to_string())
}

/// Normalize a raw running-config string using per-vendor rules.
#[tauri::command]
pub fn config_normalize(vendor: String, platform: String, raw: String) -> Result<String, String> {
    let v = Vendor::parse(&vendor, &platform);
    Ok(normalize(v, &raw))
}

/// Run a drift check on demand: dispatch `show running-config` to every
/// device the intent's selector resolves to via Plan 07 fan-out, then for
/// each finished result render+normalize+diff and persist a drift_reports row.
#[tauri::command]
pub async fn drift_run_on_demand(
    state: State<'_, AppState>,
    app: AppHandle,
    template_id: String,
) -> Result<Vec<DriftReport>, String> {
    let executor = ensure_drift_executor(&state, &app);
    crate::drift::runner::run_on_demand(state.db.clone(), executor, &template_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn drift_reports_list(
    state: State<'_, AppState>,
    template_id: String,
    limit: Option<i64>,
) -> Result<Vec<DriftReport>, String> {
    DriftReportRepo::list_by_template(&state.db.lock(), &template_id, limit.unwrap_or(50))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn drift_report_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<DriftReport>, String> {
    DriftReportRepo::get(&state.db.lock(), &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn drift_schedule_create(
    state: State<'_, AppState>,
    app: AppHandle,
    template_id: String,
    cron_expr: String,
) -> Result<crate::drift::schedule::DriftSchedule, String> {
    let sched = ensure_drift_scheduler(&state, &app)
        .await
        .map_err(|e| e.to_string())?;
    sched
        .add_schedule(&template_id, &cron_expr)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn drift_schedule_pause(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
) -> Result<(), String> {
    let sched = ensure_drift_scheduler(&state, &app)
        .await
        .map_err(|e| e.to_string())?;
    sched.pause(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn drift_schedule_resume(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
) -> Result<(), String> {
    let sched = ensure_drift_scheduler(&state, &app)
        .await
        .map_err(|e| e.to_string())?;
    sched.resume(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn drift_schedule_delete(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
) -> Result<(), String> {
    let sched = ensure_drift_scheduler(&state, &app)
        .await
        .map_err(|e| e.to_string())?;
    sched.delete(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn drift_schedule_list(
    state: State<'_, AppState>,
) -> Result<Vec<crate::drift::schedule::DriftSchedule>, String> {
    crate::drift::schedule::DriftScheduleRepo::list(&state.db.lock()).map_err(|e| e.to_string())
}

async fn ensure_drift_scheduler(
    state: &State<'_, AppState>,
    app: &AppHandle,
) -> anyhow::Result<crate::drift::scheduler::DriftScheduler> {
    use tauri::Emitter;
    struct TauriScheduleSink {
        app: AppHandle,
    }
    impl crate::drift::scheduler::ScheduleSink for TauriScheduleSink {
        fn emit_run_completed(
            &self,
            schedule_id: &str,
            template_id: &str,
            ok: bool,
            summary: &str,
        ) {
            let payload = serde_json::json!({
                "schedule_id": schedule_id,
                "template_id": template_id,
                "ok": ok,
                "summary": summary,
            });
            let _ = self.app.emit("drift://schedule_run", payload);
        }
    }
    {
        let slot = state.drift_scheduler.lock();
        if let Some(s) = slot.as_ref() {
            return Ok(s.clone());
        }
    }
    let executor = ensure_drift_executor(state, app);
    let s = crate::drift::scheduler::DriftScheduler::new(
        state.db.clone(),
        executor,
        Arc::new(TauriScheduleSink { app: app.clone() }),
    );
    s.start().await?;
    *state.drift_scheduler.lock() = Some(s.clone());
    Ok(s)
}

#[tauri::command]
pub fn drift_reports_by_device(
    state: State<'_, AppState>,
    device_id: String,
    device_kind: String,
    limit: Option<i64>,
) -> Result<Vec<DriftReport>, String> {
    DriftReportRepo::list_recent_by_device(
        &state.db.lock(),
        &device_id,
        &device_kind,
        limit.unwrap_or(50),
    )
    .map_err(|e| e.to_string())
}

fn ensure_drift_executor(
    state: &State<'_, AppState>,
    app: &AppHandle,
) -> crate::fanout::executor::Executor {
    use tauri::Emitter;
    struct TauriSink {
        app: AppHandle,
    }
    impl crate::fanout::executor::EventSink for TauriSink {
        fn emit(&self, event: &crate::fanout::events::FanoutEvent) {
            let _ = self.app.emit(crate::fanout::events::CHANNEL, event);
        }
    }
    let mut slot = state.fanout_executor.lock();
    if let Some(ex) = slot.as_ref() {
        return ex.clone();
    }
    let ex = crate::fanout::executor::Executor::new(
        state.db.clone(),
        Arc::new(crate::fanout::worker_live::LiveFactory),
        Arc::new(TauriSink { app: app.clone() }),
        Arc::new(crate::fanout::executor::NoopParse),
    );
    *slot = Some(ex.clone());
    ex
}

/// Diff a stored intent against a running-config blob. Both sides are
/// normalized first using the vendor/platform from the stored intent so
/// the diff is deterministic.
#[tauri::command]
pub fn drift_diff(
    state: State<'_, AppState>,
    intent_id: String,
    running_raw: String,
    override_vars_yaml: Option<String>,
) -> Result<crate::drift::diff::DriftPatch, String> {
    let tpl = IntentRepo::get(&state.db.lock(), &intent_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("intent {intent_id} not found"))?;
    let v = Vendor::parse(&tpl.vendor, &tpl.platform);
    let rendered = render_intent(&tpl, override_vars_yaml.as_deref()).map_err(|e| e.to_string())?;
    let intent_norm = normalize(v, &rendered);
    let running_norm = normalize(v, &running_raw);
    Ok(crate::drift::diff::diff_intent_vs_running(
        &intent_norm,
        &running_norm,
    ))
}

/// Capture a device's running-config into the archive WITHOUT running an
/// intent diff. SSHes to a saved connection (auto-decrypts saved password;
/// caller may pass an explicit one). Returns None if deduped.
#[tauri::command]
pub async fn drift_snapshot_device(
    state: State<'_, AppState>,
    connection_id: String,
    vendor: String,
    platform: String,
    password: Option<String>,
) -> Result<Option<ConfigSnapshot>, String> {
    // resolve_target takes &Arc<Mutex<Connection>> (state.db) and locks
    // internally; call it BEFORE acquiring any other db lock. Returns
    // (SshTarget, name). Verified: ssh_exec/mod.rs:67 resolve_target,
    // :175 run_command, :114 DEFAULT_CMD_TIMEOUT.
    let (target, _name) = crate::ssh_exec::resolve_target(&state.db, &connection_id, password)?;
    let raw = crate::ssh_exec::run_command(
        &target,
        "show running-config",
        crate::ssh_exec::DEFAULT_CMD_TIMEOUT,
    )
    .await
    .map_err(|e| e.to_string())?;
    let v = Vendor::parse(&vendor, &platform);
    let norm = normalize(v, &raw);
    // Acquire the db lock only AFTER the SSH call completes.
    let db = state.db.lock();
    ConfigSnapshotRepo::insert(
        &db,
        &connection_id,
        "ssh",
        &vendor,
        &platform,
        &norm,
        "manual",
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn config_snapshots_list(
    state: State<'_, AppState>,
    device_id: String,
    device_kind: String,
    limit: Option<i64>,
) -> Result<Vec<ConfigSnapshot>, String> {
    ConfigSnapshotRepo::list_for_device(
        &state.db.lock(),
        &device_id,
        &device_kind,
        limit.unwrap_or(15),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn config_snapshot_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<ConfigSnapshot>, String> {
    ConfigSnapshotRepo::get(&state.db.lock(), &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn config_snapshot_set_label(
    state: State<'_, AppState>,
    id: String,
    label: Option<String>,
) -> Result<(), String> {
    ConfigSnapshotRepo::set_label(&state.db.lock(), &id, label.as_deref())
        .map_err(|e| e.to_string())
}

/// Diff two archived snapshots (a = older/left, b = newer/right).
#[tauri::command]
pub fn config_snapshots_diff(
    state: State<'_, AppState>,
    a_id: String,
    b_id: String,
) -> Result<crate::drift::diff::DriftPatch, String> {
    let db = state.db.lock();
    let a = ConfigSnapshotRepo::get(&db, &a_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("snapshot {a_id} not found"))?;
    let b = ConfigSnapshotRepo::get(&db, &b_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("snapshot {b_id} not found"))?;
    Ok(crate::drift::diff::diff_intent_vs_running(
        &a.normalized_config,
        &b.normalized_config,
    ))
}

#[tauri::command]
pub fn drift_exception_add(
    state: State<'_, AppState>,
    template_id: String,
    line: String,
    note: Option<String>,
) -> Result<DriftException, String> {
    DriftExceptionRepo::add(&state.db.lock(), &template_id, &line, note.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn drift_exceptions_list(
    state: State<'_, AppState>,
    template_id: String,
) -> Result<Vec<DriftException>, String> {
    DriftExceptionRepo::list(&state.db.lock(), &template_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn drift_exception_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    DriftExceptionRepo::delete(&state.db.lock(), &id).map_err(|e| e.to_string())
}
