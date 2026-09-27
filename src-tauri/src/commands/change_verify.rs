use crate::change_verify::{
    bundles,
    model::{ChangeSnapshot, CheckBundle, NewCheckBundle, SnapshotLabel},
    runner,
    transport_live::LiveTransport,
};
use crate::commands::AppState;
use crate::pty_runner::AppStatePtyExecutor;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn bundle_create(
    state: State<'_, AppState>,
    new: NewCheckBundle,
) -> Result<CheckBundle, String> {
    let mut db = state.db.lock();
    bundles::create(&mut db, new).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn bundle_get(state: State<'_, AppState>, id: String) -> Result<CheckBundle, String> {
    bundles::get(&state.db.lock(), &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn bundle_list(
    state: State<'_, AppState>,
    vendor: Option<String>,
    platform: Option<String>,
) -> Result<Vec<CheckBundle>, String> {
    bundles::list(&state.db.lock(), vendor.as_deref(), platform.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn bundle_update_commands(
    state: State<'_, AppState>,
    id: String,
    commands: Vec<String>,
) -> Result<(), String> {
    let mut db = state.db.lock();
    bundles::update_commands(&mut db, &id, commands).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn bundle_rename(
    state: State<'_, AppState>,
    id: String,
    name: String,
    description: Option<String>,
) -> Result<(), String> {
    bundles::rename(&state.db.lock(), &id, &name, description.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn bundle_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    bundles::delete(&state.db.lock(), &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn change_run_pre(
    state: State<'_, AppState>,
    tab_id: String,
    bundle_id: String,
    vendor: String,
    platform: String,
) -> Result<ChangeSnapshot, String> {
    run_change_snapshot(
        state,
        tab_id,
        bundle_id,
        vendor,
        platform,
        SnapshotLabel::Pre,
    )
    .await
}

#[tauri::command]
pub async fn change_run_post(
    state: State<'_, AppState>,
    tab_id: String,
    bundle_id: String,
    vendor: String,
    platform: String,
) -> Result<ChangeSnapshot, String> {
    run_change_snapshot(
        state,
        tab_id,
        bundle_id,
        vendor,
        platform,
        SnapshotLabel::Post,
    )
    .await
}

/// SSH-direct pre-snapshot: runs the bundle's commands over a one-shot SSH
/// session to a saved connection instead of the OSC-133 PTY runner, so it
/// works in interactive SSH sessions against real network devices.
#[tauri::command]
pub async fn change_run_pre_ssh(
    state: State<'_, AppState>,
    tab_id: String,
    connection_id: String,
    bundle_id: String,
    vendor: String,
    platform: String,
    password: Option<String>,
) -> Result<ChangeSnapshot, String> {
    run_change_snapshot_ssh(
        state,
        tab_id,
        connection_id,
        bundle_id,
        vendor,
        platform,
        password,
        SnapshotLabel::Pre,
    )
    .await
}

/// SSH-direct post-snapshot. See [`change_run_pre_ssh`].
#[tauri::command]
pub async fn change_run_post_ssh(
    state: State<'_, AppState>,
    tab_id: String,
    connection_id: String,
    bundle_id: String,
    vendor: String,
    platform: String,
    password: Option<String>,
) -> Result<ChangeSnapshot, String> {
    run_change_snapshot_ssh(
        state,
        tab_id,
        connection_id,
        bundle_id,
        vendor,
        platform,
        password,
        SnapshotLabel::Post,
    )
    .await
}

async fn run_change_snapshot(
    state: State<'_, AppState>,
    tab_id: String,
    bundle_id: String,
    vendor: String,
    platform: String,
    label: SnapshotLabel,
) -> Result<ChangeSnapshot, String> {
    let executor: Arc<dyn crate::notebooks::runner::PtyExecutor> = Arc::new(AppStatePtyExecutor {
        state_db: state.db.clone(),
        ptys: state.ptys.clone(),
        terminal_agent: state.terminal_agent.clone(),
        waiters: state.block_end_waiters.clone(),
    });
    let transport: Arc<dyn crate::change_verify::transport::ShowTransport> =
        Arc::new(LiveTransport::new(executor, vendor, platform));
    let parser: Arc<dyn crate::structured::auto_parse::Parser> =
        Arc::new(state.parser_bridge.clone());

    runner::run_snapshot(
        state.db.clone(),
        transport,
        parser,
        &tab_id,
        &bundle_id,
        label,
    )
    .await
    .map_err(|e| format!("{e:#}"))
}

#[allow(clippy::too_many_arguments)]
async fn run_change_snapshot_ssh(
    state: State<'_, AppState>,
    tab_id: String,
    connection_id: String,
    bundle_id: String,
    vendor: String,
    platform: String,
    password: Option<String>,
    label: SnapshotLabel,
) -> Result<ChangeSnapshot, String> {
    use crate::change_verify::transport_ssh::SshTransport;

    let (target, _name) = crate::ssh_exec::resolve_target(&state.db, &connection_id, password)?;
    let transport: Arc<dyn crate::change_verify::transport::ShowTransport> = Arc::new(
        SshTransport::from_target(vendor.clone(), platform.clone(), target),
    );
    let parser: Arc<dyn crate::structured::auto_parse::Parser> =
        Arc::new(state.parser_bridge.clone());

    runner::run_snapshot(
        state.db.clone(),
        transport,
        parser,
        &tab_id,
        &bundle_id,
        label,
    )
    .await
    .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn change_snapshot_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<ChangeSnapshot, String> {
    let db = state.db.lock();
    runner::get_snapshot(&db, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn change_latest_pre_for_tab(
    state: State<'_, AppState>,
    tab_id: String,
    bundle_id: String,
) -> Result<Option<String>, String> {
    let db = state.db.lock();
    runner::latest_pre_for_tab(&db, &tab_id, &bundle_id).map_err(|e| e.to_string())
}

use crate::change_verify::report::{ExpectedDelta, ReportSummary};

#[tauri::command]
pub async fn change_run_post_and_report(
    state: State<'_, AppState>,
    tab_id: String,
    bundle_id: String,
    vendor: String,
    platform: String,
    pre_snapshot_id: String,
    approved_deltas: Vec<ExpectedDelta>,
    notes: Option<String>,
) -> Result<(String, ReportSummary, i64), String> {
    let executor: Arc<dyn crate::notebooks::runner::PtyExecutor> = Arc::new(AppStatePtyExecutor {
        state_db: state.db.clone(),
        ptys: state.ptys.clone(),
        terminal_agent: state.terminal_agent.clone(),
        waiters: state.block_end_waiters.clone(),
    });
    let transport: Arc<dyn crate::change_verify::transport::ShowTransport> =
        Arc::new(LiveTransport::new(executor, vendor, platform));
    let parser: Arc<dyn crate::structured::auto_parse::Parser> =
        Arc::new(state.parser_bridge.clone());

    runner::run_post_and_report(
        state.db.clone(),
        transport,
        parser,
        &tab_id,
        &bundle_id,
        &pre_snapshot_id,
        approved_deltas,
        notes,
    )
    .await
    .map_err(|e| e.to_string())
}

/// SSH-direct post-and-report: runs the post snapshot over a one-shot SSH
/// session to a saved connection, then builds the change report. The
/// interactive-SSH counterpart of [`change_run_post_and_report`].
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn change_run_post_and_report_ssh(
    state: State<'_, AppState>,
    tab_id: String,
    connection_id: String,
    bundle_id: String,
    vendor: String,
    platform: String,
    pre_snapshot_id: String,
    approved_deltas: Vec<ExpectedDelta>,
    notes: Option<String>,
    password: Option<String>,
) -> Result<(String, ReportSummary, i64), String> {
    use crate::change_verify::transport_ssh::SshTransport;

    let (target, _name) = crate::ssh_exec::resolve_target(&state.db, &connection_id, password)?;
    let transport: Arc<dyn crate::change_verify::transport::ShowTransport> = Arc::new(
        SshTransport::from_target(vendor.clone(), platform.clone(), target),
    );
    let parser: Arc<dyn crate::structured::auto_parse::Parser> =
        Arc::new(state.parser_bridge.clone());

    runner::run_post_and_report(
        state.db.clone(),
        transport,
        parser,
        &tab_id,
        &bundle_id,
        &pre_snapshot_id,
        approved_deltas,
        notes,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn change_report_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<(ReportSummary, Vec<ExpectedDelta>, i64), String> {
    let db = state.db.lock();
    runner::get_report(&db, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn change_report_list(
    state: State<'_, AppState>,
) -> Result<Vec<(String, i64, String, String)>, String> {
    let db = state.db.lock();
    runner::list_reports(&db).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn change_report_append_approval(
    state: State<'_, AppState>,
    report_id: String,
    approval: ExpectedDelta,
) -> Result<(ReportSummary, Vec<ExpectedDelta>), String> {
    let db = state.db.lock();
    runner::append_approval(&db, &report_id, approval).map_err(|e| e.to_string())
}
