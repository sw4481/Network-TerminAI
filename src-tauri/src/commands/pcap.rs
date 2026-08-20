//! Tauri command surface for Plan 11 — Packet Capture.
//!
//! Phase 1 surface: template CRUD + capture row CRUD + state machine.
//! Phase 2 layers `pcap_start_capture` / `pcap_cancel` on top.

use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::OnceCell;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::commands::AppState;
use crate::pcap::local::{DumpcapBackend, LocalCaptureInterface, LocalCaptureSpec, RealDumpcap};
use crate::pcap::orchestrator::{self, CaptureRegistry};
use crate::pcap::repo::{self, PcapCapture};
use crate::pcap::ssh_exec::DeviceConn;
use crate::pcap::summarize::{
    FindingRuleMetadata, FollowStreamResult, PcapBridge, PcapFindingsResult, PcapPacketBytes,
    PcapSummary,
};
use crate::pcap::templates::{self, PcapTemplate};
use crate::pcap::types::{CaptureSpec, DeviceKind};

static REGISTRY: OnceCell<Arc<CaptureRegistry>> = OnceCell::const_new();

async fn registry() -> Arc<CaptureRegistry> {
    REGISTRY
        .get_or_init(|| async { Arc::new(CaptureRegistry::default()) })
        .await
        .clone()
}

#[derive(Debug, Deserialize)]
pub struct StartCaptureArgs {
    pub spec: CaptureSpec,
    pub conn: DeviceConn,
    pub session_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct StartCaptureReply {
    pub capture_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartLocalCaptureArgs {
    pub interface_selector: String,
    pub interface_label: String,
    pub capture_filter: Option<String>,
    #[serde(default = "default_local_duration")]
    pub duration_seconds: u32,
    #[serde(default = "default_local_size")]
    pub max_size_mib: u32,
}

fn default_local_duration() -> u32 {
    30
}

fn default_local_size() -> u32 {
    100
}

#[tauri::command]
pub fn pcap_list_templates(state: State<'_, AppState>) -> Result<Vec<PcapTemplate>, String> {
    let conn = state.db.lock();
    templates::list_templates(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pcap_create_template(
    state: State<'_, AppState>,
    template: PcapTemplate,
) -> Result<String, String> {
    let conn = state.db.lock();
    let mut t = template;
    if t.id.trim().is_empty() {
        t.id = Uuid::new_v4().to_string();
    }
    t.builtin = false;
    templates::create_template(&conn, &t).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pcap_update_template(
    state: State<'_, AppState>,
    template: PcapTemplate,
) -> Result<(), String> {
    let conn = state.db.lock();
    templates::update_template(&conn, &template).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pcap_delete_template(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.db.lock();
    templates::delete_template(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pcap_capture_create(
    state: State<'_, AppState>,
    session_id: Option<String>,
    device_ref: String,
    device_kind: DeviceKind,
    interface: String,
    filter: Option<String>,
) -> Result<String, String> {
    let conn = state.db.lock();
    let id = Uuid::new_v4().to_string();
    repo::create(
        &conn,
        &id,
        session_id.as_deref(),
        &device_ref,
        device_kind,
        &interface,
        filter.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pcap_capture_update_status(
    state: State<'_, AppState>,
    id: String,
    status: String,
    error: Option<String>,
) -> Result<(), String> {
    let conn = state.db.lock();
    repo::update_status(&conn, &id, &status, error.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pcap_capture_finalize(
    state: State<'_, AppState>,
    id: String,
    local_path: String,
    packet_count: u32,
    size_bytes: u64,
) -> Result<(), String> {
    let conn = state.db.lock();
    repo::finalize(&conn, &id, &local_path, packet_count, size_bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pcap_capture_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<PcapCapture>, String> {
    let conn = state.db.lock();
    repo::get(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pcap_capture_list(
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> Result<Vec<PcapCapture>, String> {
    let conn = state.db.lock();
    repo::list(&conn, session_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pcap_capture_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.db.lock();
    repo::delete(&conn, &id).map_err(|e| e.to_string())
}

/// Start a capture against a live device. Spawns the orchestrator on a
/// background tokio task and returns immediately with the capture id; the
/// frontend listens on `pcap://progress/<id>` for state transitions.
#[tauri::command]
pub async fn pcap_start_capture(
    app: AppHandle,
    state: State<'_, AppState>,
    args: StartCaptureArgs,
) -> Result<StartCaptureReply, String> {
    let StartCaptureArgs {
        spec,
        conn,
        session_id,
    } = args;

    let capture_id = Uuid::new_v4().to_string();
    {
        let db = state.db.lock();
        repo::create(
            &db,
            &capture_id,
            session_id.as_deref(),
            &conn.host,
            spec.device_kind,
            &spec.interface,
            spec.acl.as_deref(),
        )
        .map_err(|e| e.to_string())?;
    }

    let db: Arc<Mutex<rusqlite::Connection>> = state.db.clone();
    let bridge = PcapBridge::new(state.agent.clone());
    let app_clone = app.clone();
    let id_for_task = capture_id.clone();
    let progress_event = format!("pcap://progress/{capture_id}");

    let reg = registry().await;
    let cancel = CancellationToken::new();
    reg.insert(capture_id.clone(), cancel.clone()).await;
    let reg_for_task = reg.clone();
    tokio::spawn(async move {
        let emit = |ev: orchestrator::CaptureEvent| {
            if let Err(e) = app_clone.emit(&progress_event, &ev) {
                tracing::warn!(?e, "failed to emit pcap progress event");
            }
        };
        tokio::select! {
            _ = cancel.cancelled() => {}
            result = run_live_capture(&bridge, &spec, &conn, &id_for_task, &db, &emit) => {
                if let Err(err) = result {
                    let msg = format!("{err:#}");
                    let conn_db = db.lock();
                    let _ = repo::update_status(&conn_db, &id_for_task, "failed", Some(&msg));
                    drop(conn_db);
                    emit(orchestrator::CaptureEvent::Failed { error: msg });
                }
            }
        }
        reg_for_task.remove(&id_for_task).await;
    });

    Ok(StartCaptureReply { capture_id })
}

#[tauri::command]
pub async fn pcap_list_local_interfaces() -> Result<Vec<LocalCaptureInterface>, String> {
    let dumpcap = RealDumpcap::resolve().map_err(|e| e.to_string())?;
    dumpcap.list_interfaces().await.map_err(|e| e.to_string())
}

/// Capture an interface on this computer with dumpcap. Interface identity is
/// re-enumerated and checked immediately before launch, so a stale numeric
/// selector cannot silently move the capture to another adapter.
#[tauri::command]
pub async fn pcap_start_local_capture(
    app: AppHandle,
    state: State<'_, AppState>,
    args: StartLocalCaptureArgs,
) -> Result<StartCaptureReply, String> {
    if !(1..=600).contains(&args.duration_seconds) {
        return Err("durationSeconds must be between 1 and 600".into());
    }
    if !(1..=1024).contains(&args.max_size_mib) {
        return Err("maxSizeMiB must be between 1 and 1024".into());
    }
    let selector = args.interface_selector.trim();
    let label = args.interface_label.trim();
    if selector.is_empty() || label.is_empty() {
        return Err("a dumpcap interface selector and label are required".into());
    }

    let backend = Arc::new(RealDumpcap::resolve().map_err(|e| e.to_string())?);
    let current = backend.list_interfaces().await.map_err(|e| e.to_string())?;
    if !current
        .iter()
        .any(|item| item.selector == selector && item.label == label)
    {
        return Err(
            "The selected capture interface changed or disappeared. Refresh the interface list."
                .into(),
        );
    }

    let capture_id = Uuid::new_v4().to_string();
    let output_path = crate::pcap::sftp::pcap_cache_dir()
        .map_err(|e| e.to_string())?
        .join(format!("{capture_id}.pcap"));
    {
        let db = state.db.lock();
        repo::create(
            &db,
            &capture_id,
            None,
            "This Computer",
            DeviceKind::Local,
            label,
            args.capture_filter.as_deref(),
        )
        .and_then(|_| repo::update_status(&db, &capture_id, "capturing", None))
        .map_err(|e| e.to_string())?;
    }

    let spec = LocalCaptureSpec {
        interface_selector: selector.to_string(),
        capture_filter: args.capture_filter,
        duration_seconds: args.duration_seconds,
        max_size_mib: args.max_size_mib,
    };
    let db = state.db.clone();
    let progress_event = format!("pcap://progress/{capture_id}");
    let id_for_task = capture_id.clone();
    let reg = registry().await;
    let cancel = CancellationToken::new();
    reg.insert(capture_id.clone(), cancel.clone()).await;
    let reg_for_task = reg.clone();
    tokio::spawn(async move {
        let emit = |event: orchestrator::CaptureEvent| {
            if let Err(error) = app.emit(&progress_event, &event) {
                tracing::warn!(?error, "failed to emit local pcap progress event");
            }
        };
        emit(orchestrator::CaptureEvent::Capturing);
        tokio::select! {
            _ = cancel.cancelled() => {}
            result = run_local_capture(backend.as_ref(), &spec, &output_path, &id_for_task, &db, &emit) => {
                if let Err(error) = result {
                    let message = format!("{error:#}");
                    let conn = db.lock();
                    let _ = repo::update_status(&conn, &id_for_task, "failed", Some(&message));
                    drop(conn);
                    emit(orchestrator::CaptureEvent::Failed { error: message });
                }
            }
        }
        reg_for_task.remove(&id_for_task).await;
    });

    Ok(StartCaptureReply { capture_id })
}

async fn run_local_capture<B: DumpcapBackend + ?Sized>(
    backend: &B,
    spec: &LocalCaptureSpec,
    output_path: &std::path::Path,
    capture_id: &str,
    db: &Arc<Mutex<rusqlite::Connection>>,
    emit: &impl Fn(orchestrator::CaptureEvent),
) -> anyhow::Result<()> {
    use anyhow::Context;

    let bytes = backend
        .capture(spec, output_path)
        .await
        .context("capture local interface")?;
    if bytes >= crate::pcap::PCAP_SIZE_WARN_BYTES {
        emit(orchestrator::CaptureEvent::SizeWarning { size_bytes: bytes });
    }
    let local_path = output_path
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("local pcap path is not utf-8"))?
        .to_string();
    {
        let conn = db.lock();
        repo::finalize_local(&conn, capture_id, &local_path, 0, bytes)?;
    }
    emit(orchestrator::CaptureEvent::Ready {
        local_path,
        size_bytes: bytes,
        packet_count: 0,
    });
    Ok(())
}

/// Drive a live capture via the sidecar's pyATS lifecycle (one persistent
/// session), then pull the resulting `.pcap` off-box over SCP. Updates the DB
/// row through `capturing → pulling → ready` and emits progress events.
///
/// Why the sidecar rather than the russh/ssh_exec executor: IOS-XE EPC ties the
/// capture to the session that started it. The orchestrator's old model ran
/// each command in a separate one-shot SSH session, so `monitor capture start`
/// was torn down on session close and the buffer was empty at export. pyATS
/// keeps the whole setup→start→wait→stop→export in a single session. Verified
/// against a live Catalyst 9000.
async fn run_live_capture(
    bridge: &PcapBridge,
    spec: &CaptureSpec,
    conn: &DeviceConn,
    capture_id: &str,
    db: &Arc<Mutex<rusqlite::Connection>>,
    emit: &impl Fn(orchestrator::CaptureEvent),
) -> anyhow::Result<()> {
    use crate::pcap::{scp, sftp};
    use anyhow::Context;

    {
        let c = db.lock();
        repo::update_status(&c, capture_id, "capturing", None)
            .context("transition setup→capturing")?;
    }
    emit(orchestrator::CaptureEvent::Capturing);

    let device_kind = match spec.device_kind {
        DeviceKind::IosXe => "iosxe",
        DeviceKind::Nxos => "nxos",
        DeviceKind::Junos => "junos",
        DeviceKind::Eos => "eos",
        DeviceKind::Local => return Err(anyhow::anyhow!("local capture requires dumpcap")),
    };

    let result = bridge
        .run_capture(
            &conn.host,
            conn.port,
            &conn.username,
            &conn.password,
            device_kind,
            &spec.interface,
            spec.acl.as_deref(),
            spec.buffer_mb,
            spec.duration_s,
            &spec.capture_name,
        )
        .await
        .context("run capture on device")?;

    if !result.ok {
        return Err(anyhow::anyhow!(result.error));
    }
    emit(orchestrator::CaptureEvent::Started);

    {
        let c = db.lock();
        repo::update_status(&c, capture_id, "pulling", None)
            .context("transition capturing→pulling")?;
    }

    let local_dir = sftp::pcap_cache_dir()?;
    let local_path = local_dir.join(format!("{capture_id}.pcap"));
    let bytes = scp::pull_file(conn, &result.export_path, &local_path)
        .await
        .context("scp pull")?;
    emit(orchestrator::CaptureEvent::Pulling {
        bytes,
        total: Some(bytes),
    });

    if bytes >= crate::pcap::PCAP_SIZE_WARN_BYTES {
        emit(orchestrator::CaptureEvent::SizeWarning { size_bytes: bytes });
    }

    let local_path_str = local_path
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("local pcap path not utf-8"))?
        .to_string();
    {
        let c = db.lock();
        repo::finalize(&c, capture_id, &local_path_str, 0, bytes)?;
    }
    emit(orchestrator::CaptureEvent::Ready {
        local_path: local_path_str,
        size_bytes: bytes,
        packet_count: 0,
    });
    Ok(())
}

#[tauri::command]
pub async fn pcap_cancel(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let reg = registry().await;
    if !reg.cancel(&id).await {
        return Ok(false);
    }

    // Wait briefly for the task to observe cancellation. For local captures,
    // dropping the `Command::output` future kills dumpcap before partial-file
    // cleanup. Remote capture futures are likewise stopped before DB mutation.
    for _ in 0..40 {
        if !reg.contains(&id).await {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }

    let cache_path = crate::pcap::sftp::pcap_cache_dir()
        .map_err(|e| e.to_string())?
        .join(format!("{id}.pcap"));
    let partial_path = cache_path.with_extension("pcap.partial");
    let _ = std::fs::remove_file(&cache_path);
    let _ = std::fs::remove_file(&partial_path);

    let conn = state.db.lock();
    if let Some(row) = repo::get(&conn, &id).map_err(|e| e.to_string())? {
        if matches!(row.status.as_str(), "setup" | "capturing" | "pulling") {
            repo::update_status(&conn, &id, "failed", Some("cancelled"))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(true)
}

fn capture_local_path(state: &State<'_, AppState>, id: &str) -> Result<String, String> {
    let conn = state.db.lock();
    let row = repo::get(&conn, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("capture {id} not found"))?;
    row.local_path
        .ok_or_else(|| format!("capture {id} has no local pcap yet"))
}

#[tauri::command]
pub async fn pcap_summarize(
    state: State<'_, AppState>,
    capture_id: String,
    max_packets: Option<u32>,
    display_filter: Option<String>,
) -> Result<PcapSummary, String> {
    let path = capture_local_path(&state, &capture_id)?;
    let bridge = PcapBridge::new(state.agent.clone());
    let summary = bridge
        .summarize(&path, max_packets.unwrap_or(200), display_filter.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    // Write the packet count back to the row so the UI list can render it
    // without re-summarizing on every refresh.
    {
        let conn = state.db.lock();
        let _ = conn.execute(
            "UPDATE pcap_captures SET packet_count = ?2 WHERE id = ?1 AND status = 'ready'",
            rusqlite::params![capture_id, summary.packet_count as i64],
        );
    }
    Ok(summary)
}

#[tauri::command]
pub async fn pcap_packet_bytes(
    state: State<'_, AppState>,
    capture_id: String,
    index: u32,
) -> Result<PcapPacketBytes, String> {
    let path = capture_local_path(&state, &capture_id)?;
    let bridge = PcapBridge::new(state.agent.clone());
    bridge
        .packet_bytes(&path, index)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pcap_finding_rules(
    state: State<'_, AppState>,
) -> Result<Vec<FindingRuleMetadata>, String> {
    PcapBridge::new(state.agent.clone())
        .finding_rules()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn pcap_findings(
    state: State<'_, AppState>,
    capture_id: String,
    enabled_rule_ids: Vec<String>,
) -> Result<PcapFindingsResult, String> {
    let path = capture_local_path(&state, &capture_id)?;
    PcapBridge::new(state.agent.clone())
        .findings(&path, &enabled_rule_ids)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn pcap_follow_stream(
    state: State<'_, AppState>,
    capture_id: String,
    stream_index: u32,
) -> Result<FollowStreamResult, String> {
    let path = capture_local_path(&state, &capture_id)?;
    let bridge = PcapBridge::new(state.agent.clone());
    bridge
        .follow_stream(&path, stream_index)
        .await
        .map_err(|e| e.to_string())
}

/// Copy a captured pcap to a user-chosen destination. The destination is
/// resolved by the frontend via `@tauri-apps/plugin-dialog`.
#[tauri::command]
pub fn pcap_export(
    state: State<'_, AppState>,
    capture_id: String,
    dest_path: String,
) -> Result<u64, String> {
    let local = capture_local_path(&state, &capture_id)?;
    if let Some(parent) = std::path::Path::new(&dest_path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    std::fs::copy(&local, &dest_path).map_err(|e| e.to_string())
}
