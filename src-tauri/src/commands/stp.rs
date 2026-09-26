//! Native observed-state STP persistence and scheduler boundary.
//!
//! The real pyATS/Genie orchestration is intentionally behind [`StpCollector`].
//! Until that worker is wired here, the production collector reports the
//! unsupported state instead of manufacturing device evidence.

use crate::commands::{sidecar_spawn_target, AppState};
use parking_lot::Mutex;
use rusqlite::{params, types::Type, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::State;
use thiserror::Error;
use uuid::Uuid;

pub const STP_SETTINGS_SINGLETON_ID: &str = "stp";
pub const STP_SCHEMA_VERSION: i64 = 1;
pub const SUPPORTED_INTERVALS_MINUTES: [i64; 3] = [30, 60, 240];
const RETENTION_SECONDS: i64 = 7 * 24 * 60 * 60;
const MAX_SNAPSHOTS: i64 = 100;
const STP_COLLECTION_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StpSettings {
    pub singleton_id: String,
    pub schedule_enabled: bool,
    pub interval_minutes: i64,
    pub updated_at: i64,
}

impl Default for StpSettings {
    fn default() -> Self {
        Self {
            singleton_id: STP_SETTINGS_SINGLETON_ID.into(),
            schedule_enabled: false,
            interval_minutes: 60,
            updated_at: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StpTrigger {
    Manual,
    Scheduled,
}

impl StpTrigger {
    fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Scheduled => "scheduled",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StpSnapshotStatus {
    Complete,
    Partial,
    Failed,
}

impl StpSnapshotStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Complete => "complete",
            Self::Partial => "partial",
            Self::Failed => "failed",
        }
    }
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "complete" => Ok(Self::Complete),
            "partial" => Ok(Self::Partial),
            "failed" => Ok(Self::Failed),
            _ => Err(format!("invalid STP snapshot status: {value}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct StpFinding {
    pub kind: String,
    pub severity: String,
    pub device_id: Option<String>,
    pub interface: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct StpDevice {
    pub device_id: String,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct StpLink {
    pub local_device_id: String,
    pub local_interface: String,
    pub remote_device_id: Option<String>,
    #[serde(default)]
    pub instance_id: Option<String>,
    pub bidirectional: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct StpPort {
    pub device_id: String,
    pub interface: String,
    pub role: Option<String>,
    pub state: Option<String>,
    #[serde(default)]
    pub cost: Option<i64>,
    #[serde(default)]
    pub bundle_id: Option<String>,
    #[serde(default)]
    pub explicit_evidence: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct StpInstance {
    pub id: String,
    pub label: Option<String>,
    pub vlan: Option<String>,
    pub mode: Option<String>,
    pub bridge_id: Option<String>,
    pub root_id: Option<String>,
    #[serde(default)]
    pub topology_change_count: Option<i64>,
    #[serde(default)]
    pub mst_region: Option<String>,
    #[serde(default)]
    pub bridge_priority: Option<i64>,
    #[serde(default)]
    pub root_priority: Option<i64>,
    #[serde(default)]
    pub root_cost: Option<i64>,
    #[serde(default)]
    pub root_port: Option<String>,
    pub ports: Vec<StpPort>,
}

impl StpInstance {
    fn has_parsable_state(&self) -> bool {
        self.bridge_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
            || self
                .root_id
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            || self.topology_change_count.is_some()
            || self.ports.iter().any(|port| {
                port.role
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty())
                    || port
                        .state
                        .as_deref()
                        .is_some_and(|value| !value.trim().is_empty())
                    || port.cost.is_some()
                    || port
                        .bundle_id
                        .as_deref()
                        .is_some_and(|value| !value.trim().is_empty())
                    || port
                        .explicit_evidence
                        .as_deref()
                        .is_some_and(|value| !value.trim().is_empty())
            })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct StpGap {
    pub source: String,
    pub code: String,
}

/// Safe normalized evidence only. Raw CLI, credentials, and transport bodies
/// have no representation here and cannot enter a persisted payload.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct StpPayload {
    pub devices: Vec<StpDevice>,
    #[serde(default)]
    pub instances: Vec<StpInstance>,
    pub links: Vec<StpLink>,
    pub findings: Vec<StpFinding>,
    #[serde(default)]
    pub gaps: Vec<StpGap>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct StpRequiredEvidence {
    pub device_inventory: bool,
    pub spanning_tree: bool,
    pub interfaces: bool,
    pub neighbors: bool,
    #[serde(default)]
    pub supported_devices: usize,
    #[serde(default)]
    pub parsable_stp_devices: usize,
}

impl StpRequiredEvidence {
    fn is_complete(&self) -> bool {
        self.supported_devices > 0 && self.parsable_stp_devices == self.supported_devices
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StpCollection {
    pub evidence: StpRequiredEvidence,
    pub payload: StpPayload,
    pub findings: Vec<StpFinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StpSnapshot {
    pub id: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub trigger: StpTrigger,
    pub status: StpSnapshotStatus,
    pub baseline_eligible: bool,
    pub schema_version: i64,
    pub payload: StpPayload,
    pub error_summary: Option<String>,
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum StpCollectorError {
    #[error("no devices available")]
    NoDevices,
    #[error("STP collection is unsupported")]
    Unsupported,
    #[error("unsupported_platform")]
    UnsupportedPlatform,
    #[error("testbed_unavailable")]
    TestbedUnavailable,
    #[error("no_supported_devices")]
    NoSupportedDevices,
    #[error("STP collection was cancelled")]
    Cancelled,
    #[error("STP collection failed")]
    Failed,
}

#[derive(Debug, Default)]
struct StpCancellationState {
    cancelled: AtomicBool,
    process_group: Mutex<Option<u32>>,
}

#[derive(Debug, Clone, Default)]
pub struct StpCancellation(Arc<StpCancellationState>);

impl StpCancellation {
    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::SeqCst);
        if let Some(process_group) = *self.0.process_group.lock() {
            terminate_process_group(process_group);
        }
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::SeqCst)
    }

    fn register_process_group(&self, process_group: u32) -> Result<(), StpCollectorError> {
        let mut active = self.0.process_group.lock();
        if self.is_cancelled() {
            terminate_process_group(process_group);
            return Err(StpCollectorError::Cancelled);
        }
        *active = Some(process_group);
        Ok(())
    }

    fn clear_process_group(&self, process_group: u32) {
        let mut active = self.0.process_group.lock();
        if *active == Some(process_group) {
            *active = None;
        }
    }
}

/// Typed seam for future pyATS/Genie worker orchestration.
pub trait StpCollector: Send + Sync + 'static {
    fn collect(&self, cancellation: &StpCancellation) -> Result<StpCollection, StpCollectorError>;
}

pub struct UnsupportedStpCollector;
impl StpCollector for UnsupportedStpCollector {
    fn collect(&self, _cancellation: &StpCancellation) -> Result<StpCollection, StpCollectorError> {
        Err(StpCollectorError::Unsupported)
    }
}

pub struct NoDeviceStpCollector;
impl StpCollector for NoDeviceStpCollector {
    fn collect(&self, _cancellation: &StpCancellation) -> Result<StpCollection, StpCollectorError> {
        Err(StpCollectorError::NoDevices)
    }
}

/// Production collector boundary. The sidecar owns the bounded, terminable
/// pyATS worker pool and returns normalized evidence only.
pub struct SidecarStpCollector;
impl StpCollector for SidecarStpCollector {
    fn collect(&self, cancellation: &StpCancellation) -> Result<StpCollection, StpCollectorError> {
        if cancellation.is_cancelled() {
            return Err(StpCollectorError::Cancelled);
        }
        let response = call_sidecar_cancellable(cancellation)?;
        if response.get("type").and_then(Value::as_str) != Some("done") {
            return Err(StpCollectorError::Failed);
        }
        collection_from_sidecar_result(response.get("result").unwrap_or(&Value::Null))
    }
}

fn call_sidecar_cancellable(cancellation: &StpCancellation) -> Result<Value, StpCollectorError> {
    let (python, args) = sidecar_spawn_target();
    let request = serde_json::json!({
        "id": Uuid::new_v4().to_string(),
        "method": "stp.collect",
        "params": {},
    });
    call_process_cancellable(
        &python,
        &args,
        &request,
        cancellation,
        STP_COLLECTION_TIMEOUT,
    )
}

fn call_process_cancellable(
    program: &str,
    args: &[String],
    request: &Value,
    cancellation: &StpCancellation,
    timeout: Duration,
) -> Result<Value, StpCollectorError> {
    if cancellation.is_cancelled() {
        return Err(StpCollectorError::Cancelled);
    }

    let mut command = Command::new(program);
    command
        .args(args)
        .env("PYTHONUNBUFFERED", "1")
        .env("CCIE_LOG_DIR", crate::logging::default_log_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    configure_process_group(&mut command);
    let mut child = command.spawn().map_err(|_| StpCollectorError::Failed)?;
    let process_group = child.id();
    if let Err(error) = cancellation.register_process_group(process_group) {
        terminate_child_process_group(&mut child, process_group);
        return Err(error);
    }

    let Some(mut stdin) = child.stdin.take() else {
        terminate_child_process_group(&mut child, process_group);
        cancellation.clear_process_group(process_group);
        return Err(StpCollectorError::Failed);
    };
    let Some(stdout) = child.stdout.take() else {
        terminate_child_process_group(&mut child, process_group);
        cancellation.clear_process_group(process_group);
        return Err(StpCollectorError::Failed);
    };
    let request = serde_json::to_string(request).map_err(|_| StpCollectorError::Failed)?;
    if writeln!(stdin, "{request}")
        .and_then(|_| stdin.flush())
        .is_err()
    {
        terminate_child_process_group(&mut child, process_group);
        cancellation.clear_process_group(process_group);
        return Err(StpCollectorError::Failed);
    }
    drop(stdin);

    let (response_tx, response_rx) = mpsc::channel();
    let reader = thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            let read = match reader.read_line(&mut line) {
                Ok(read) => read,
                Err(_) => {
                    let _ = response_tx.send(Err(()));
                    return;
                }
            };
            if read == 0 {
                let _ = response_tx.send(Err(()));
                return;
            }
            let Ok(response) = serde_json::from_str::<Value>(line.trim()) else {
                let _ = response_tx.send(Err(()));
                return;
            };
            if response.get("type").and_then(Value::as_str) == Some("sidecar.heartbeat") {
                continue;
            }
            let _ = response_tx.send(Ok(response));
            return;
        }
    });

    let deadline = Instant::now() + timeout;
    let result = loop {
        if cancellation.is_cancelled() {
            break Err(StpCollectorError::Cancelled);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break Err(StpCollectorError::Failed);
        }
        match response_rx.recv_timeout(remaining.min(Duration::from_millis(50))) {
            Ok(Ok(response)) => break Ok(response),
            Ok(Err(())) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                break Err(if cancellation.is_cancelled() {
                    StpCollectorError::Cancelled
                } else {
                    StpCollectorError::Failed
                });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    };

    terminate_child_process_group(&mut child, process_group);
    cancellation.clear_process_group(process_group);
    let _ = reader.join();
    result
}

fn terminate_child_process_group(child: &mut Child, process_group: u32) {
    terminate_process_group(process_group);
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_process_group(process_group: u32) {
    // The dedicated sidecar and every multiprocessing worker inherit this
    // group, so one signal terminates the complete bounded collection.
    unsafe {
        libc::kill(-(process_group as libc::pid_t), libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn terminate_process_group(_process_group: u32) {}

fn collection_from_sidecar_result(result: &Value) -> Result<StpCollection, StpCollectorError> {
    let run_status = result
        .get("status")
        .and_then(Value::as_str)
        .ok_or(StpCollectorError::Failed)?;
    if !matches!(
        run_status,
        "complete" | "partial" | "failed" | "unsupported"
    ) {
        return Err(StpCollectorError::Failed);
    }
    if let Some(error) = result
        .get("code")
        .and_then(Value::as_str)
        .and_then(sidecar_failure_code)
    {
        return Err(error);
    }
    let records = result
        .get("devices")
        .and_then(Value::as_array)
        .ok_or(StpCollectorError::Failed)?;
    if records.is_empty() {
        return Err(StpCollectorError::NoDevices);
    }

    let mut devices = Vec::new();
    let mut instances = Vec::new();
    let mut links = Vec::new();
    let mut gaps = Vec::new();
    let mut evidence = StpRequiredEvidence::default();
    for record in records {
        let Some(device_id) = record.get("device").and_then(Value::as_str) else {
            return Err(StpCollectorError::Failed);
        };
        let platform = record
            .get("platform")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let record_status = record.get("status").and_then(Value::as_str);
        let supported_record =
            platform.eq_ignore_ascii_case("iosxe") || platform.eq_ignore_ascii_case("nxos");
        devices.push(StpDevice {
            device_id: device_id.to_owned(),
            platform: platform.to_owned(),
        });
        let stp = record.get("stp").and_then(Value::as_object);
        let parsed_instances = stp_instances(stp, device_id);
        let has_ports = stp
            .and_then(|value| value.get("ports"))
            .and_then(Value::as_array)
            .is_some_and(|ports| !ports.is_empty());
        let has_instances = stp
            .and_then(|value| value.get("instances"))
            .and_then(Value::as_array)
            .is_some_and(|instances| !instances.is_empty());
        let has_parsable_stp = parsed_instances.iter().any(StpInstance::has_parsable_state);
        evidence.spanning_tree |= has_ports || has_instances;
        evidence.interfaces |= has_ports;
        if supported_record {
            evidence.supported_devices += 1;
            if record_status == Some("complete") && has_parsable_stp {
                evidence.parsable_stp_devices += 1;
            }
        }
        instances.extend(parsed_instances);
        gaps.extend(stp_gaps(record));

        let neighbors = record.get("neighbors").and_then(Value::as_object);
        let cdp = neighbors
            .and_then(|value| value.get("cdp"))
            .and_then(Value::as_array);
        let lldp = neighbors
            .and_then(|value| value.get("lldp"))
            .and_then(Value::as_array);
        evidence.neighbors |= cdp.is_some() || lldp.is_some();
        for neighbor in cdp.into_iter().chain(lldp).flatten() {
            let Some(local_interface) = neighbor
                .get("local_interface")
                .or_else(|| neighbor.get("interface"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            links.push(StpLink {
                local_device_id: device_id.to_owned(),
                local_interface: local_interface.to_owned(),
                remote_device_id: neighbor
                    .get("device_id")
                    .or_else(|| neighbor.get("name"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                instance_id: neighbor
                    .get("instance")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                bidirectional: neighbor
                    .get("bidirectional")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            });
        }
    }
    evidence.device_inventory = !devices.is_empty();
    Ok(StpCollection {
        evidence,
        payload: StpPayload {
            devices,
            instances,
            links,
            findings: Vec::new(),
            gaps,
        },
        findings: Vec::new(),
    })
}

fn sidecar_failure_code(code: &str) -> Option<StpCollectorError> {
    match code {
        "unsupported_platform" => Some(StpCollectorError::UnsupportedPlatform),
        "testbed_unavailable" => Some(StpCollectorError::TestbedUnavailable),
        "no_supported_devices" => Some(StpCollectorError::NoSupportedDevices),
        _ => None,
    }
}

fn stp_text(value: &Value, fields: &[&str]) -> Option<String> {
    fields
        .iter()
        .find_map(|field| value.get(*field).and_then(Value::as_str).map(str::to_owned))
}

fn stp_region(value: &Value) -> Option<String> {
    value
        .get("mst_region")
        .or_else(|| value.get("region"))
        .and_then(|region| {
            region
                .as_str()
                .map(str::to_owned)
                .or_else(|| stp_text(region, &["name", "region_name"]))
        })
}

fn stp_ports(value: Option<&Value>, device_id: &str) -> Vec<StpPort> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|port| {
            Some(StpPort {
                device_id: device_id.to_owned(),
                interface: stp_text(port, &["interface", "name"])?,
                role: stp_text(port, &["role"]),
                state: stp_text(port, &["state", "port_state"]),
                cost: port
                    .get("cost")
                    .or_else(|| port.get("path_cost"))
                    .and_then(Value::as_i64),
                bundle_id: stp_text(port, &["bundle_id", "channel_group", "port_channel"]),
                explicit_evidence: stp_text(
                    port,
                    &[
                        "explicit_evidence",
                        "inconsistency_reason",
                        "broken_reason",
                        "diagnostic",
                    ],
                )
                .or_else(|| {
                    (port.get("inconsistent").and_then(Value::as_bool) == Some(true))
                        .then(|| "explicit inconsistency".into())
                })
                .or_else(|| {
                    (port.get("broken").and_then(Value::as_bool) == Some(true))
                        .then(|| "explicit broken state".into())
                }),
            })
        })
        .collect()
}

fn stp_instances(
    stp: Option<&serde_json::Map<String, Value>>,
    device_id: &str,
) -> Vec<StpInstance> {
    let Some(stp) = stp else {
        return Vec::new();
    };
    let mode = stp.get("mode").and_then(Value::as_str).map(str::to_owned);
    stp.get("instances")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|instance| {
            Some(StpInstance {
                id: stp_text(instance, &["id"])?,
                label: stp_text(instance, &["label", "name"]),
                vlan: stp_text(instance, &["vlan", "vlan_id"]),
                mode: mode.clone(),
                bridge_id: stp_text(instance, &["bridge_id", "bridge_address"]),
                root_id: stp_text(instance, &["root_id", "root_bridge"]),
                topology_change_count: instance
                    .get("topology_change_count")
                    .or_else(|| instance.get("topology_changes"))
                    .and_then(Value::as_i64),
                mst_region: stp_region(instance),
                bridge_priority: instance.get("bridge_priority").and_then(Value::as_i64),
                root_priority: instance.get("root_priority").and_then(Value::as_i64),
                root_cost: instance.get("root_cost").and_then(Value::as_i64),
                root_port: stp_text(instance, &["root_port"]),
                ports: stp_ports(
                    instance.get("interfaces").or_else(|| instance.get("ports")),
                    device_id,
                ),
            })
        })
        .collect()
}

fn stp_gaps(record: &Value) -> Vec<StpGap> {
    record
        .get("gaps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|gap| {
            Some(StpGap {
                source: stp_text(gap, &["source"])?,
                code: stp_text(gap, &["code"])?,
            })
        })
        .collect()
}

pub struct StpRepository;

impl StpRepository {
    pub fn get_settings(connection: &Connection) -> Result<StpSettings, String> {
        connection.query_row("SELECT singleton_id, schedule_enabled, interval_minutes, updated_at FROM stp_settings WHERE singleton_id = ?1", params![STP_SETTINGS_SINGLETON_ID], |row| Ok(StpSettings { singleton_id: row.get(0)?, schedule_enabled: row.get::<_, i64>(1)? != 0, interval_minutes: row.get(2)?, updated_at: row.get(3)? })).optional().map_err(|e| e.to_string())?.ok_or_else(|| "STP settings row is missing".into())
    }

    pub fn save_settings(
        connection: &Connection,
        settings: &mut StpSettings,
    ) -> Result<StpSettings, String> {
        validate_interval(settings.interval_minutes)?;
        settings.singleton_id = STP_SETTINGS_SINGLETON_ID.into();
        settings.updated_at = now_secs();
        connection.execute("INSERT INTO stp_settings (singleton_id, schedule_enabled, interval_minutes, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(singleton_id) DO UPDATE SET schedule_enabled = excluded.schedule_enabled, interval_minutes = excluded.interval_minutes, updated_at = excluded.updated_at", params![settings.singleton_id, if settings.schedule_enabled { 1 } else { 0 }, settings.interval_minutes, settings.updated_at]).map_err(|e| e.to_string())?;
        Ok(settings.clone())
    }

    pub fn insert_snapshot(connection: &Connection, snapshot: &StpSnapshot) -> Result<(), String> {
        let payload_json = serde_json::to_string(&snapshot.payload).map_err(|e| e.to_string())?;
        connection.execute("INSERT INTO stp_snapshots (id, started_at, finished_at, trigger, status, baseline_eligible, schema_version, payload_json, error_summary) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)", params![snapshot.id, snapshot.started_at, snapshot.finished_at, snapshot.trigger.as_str(), snapshot.status.as_str(), if snapshot.baseline_eligible { 1 } else { 0 }, snapshot.schema_version, payload_json, snapshot.error_summary]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_snapshot(connection: &Connection, id: &str) -> Result<Option<StpSnapshot>, String> {
        connection.query_row("SELECT id, started_at, finished_at, trigger, status, baseline_eligible, schema_version, payload_json, error_summary FROM stp_snapshots WHERE id = ?1", params![id], map_snapshot).optional().map_err(|e| e.to_string())
    }

    pub fn list_snapshots(
        connection: &Connection,
        limit: Option<u32>,
    ) -> Result<Vec<StpSnapshot>, String> {
        let limit = i64::from(limit.unwrap_or(100).clamp(1, 100));
        let mut statement = connection.prepare("SELECT id, started_at, finished_at, trigger, status, baseline_eligible, schema_version, payload_json, error_summary FROM stp_snapshots ORDER BY started_at DESC, id DESC LIMIT ?1").map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params![limit], map_snapshot)
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn newest_complete_baseline(
        connection: &Connection,
    ) -> Result<Option<StpSnapshot>, String> {
        connection.query_row("SELECT id, started_at, finished_at, trigger, status, baseline_eligible, schema_version, payload_json, error_summary FROM stp_snapshots WHERE status = 'complete' AND baseline_eligible = 1 ORDER BY started_at DESC, id DESC LIMIT 1", [], map_snapshot).optional().map_err(|e| e.to_string())
    }

    pub fn record_schedule_event(
        connection: &Connection,
        outcome: &str,
        reason: &str,
    ) -> Result<(), String> {
        connection.execute("INSERT INTO stp_schedule_events (occurred_at, outcome, reason) VALUES (?1, ?2, ?3)", params![now_secs(), outcome, reason]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn retain(connection: &Connection, now: i64) -> Result<(), String> {
        let baseline_id: Option<String> = connection.query_row("SELECT id FROM stp_snapshots WHERE status = 'complete' AND baseline_eligible = 1 ORDER BY started_at DESC, id DESC LIMIT 1", [], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
        connection
            .execute(
                "DELETE FROM stp_snapshots WHERE started_at < ?1 AND (?2 IS NULL OR id <> ?2)",
                params![now - RETENTION_SECONDS, baseline_id],
            )
            .map_err(|e| e.to_string())?;
        connection.execute("DELETE FROM stp_snapshots WHERE id IN (SELECT id FROM stp_snapshots WHERE (?1 IS NULL OR id <> ?1) ORDER BY started_at ASC, id ASC LIMIT MAX(0, (SELECT COUNT(*) FROM stp_snapshots) - ?2))", params![baseline_id, MAX_SNAPSHOTS]).map_err(|e| e.to_string())?;
        connection
            .execute(
                "DELETE FROM stp_schedule_events WHERE occurred_at < ?1",
                params![now - RETENTION_SECONDS],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(test)]
    fn schedule_event_count(
        connection: &Connection,
        outcome: &str,
        reason: &str,
    ) -> Result<i64, String> {
        connection
            .query_row(
                "SELECT COUNT(*) FROM stp_schedule_events WHERE outcome = ?1 AND reason = ?2",
                params![outcome, reason],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())
    }
}

fn map_snapshot(row: &rusqlite::Row<'_>) -> rusqlite::Result<StpSnapshot> {
    let trigger_value: String = row.get(3)?;
    let trigger = match trigger_value.as_str() {
        "manual" => StpTrigger::Manual,
        "scheduled" => StpTrigger::Scheduled,
        value => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                3,
                Type::Text,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("invalid STP snapshot trigger: {value}"),
                )),
            ))
        }
    };
    let status_value: String = row.get(4)?;
    let status = StpSnapshotStatus::parse(&status_value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            4,
            Type::Text,
            Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
        )
    })?;
    let payload_json: String = row.get(7)?;
    let payload: StpPayload = serde_json::from_str(&payload_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            7,
            Type::Text,
            Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
        )
    })?;
    Ok(StpSnapshot {
        id: row.get(0)?,
        started_at: row.get(1)?,
        finished_at: row.get(2)?,
        trigger,
        status,
        baseline_eligible: row.get::<_, i64>(5)? != 0,
        schema_version: row.get(6)?,
        payload,
        error_summary: row.get(8)?,
    })
}

fn validate_interval(value: i64) -> Result<(), String> {
    if SUPPORTED_INTERVALS_MINUTES.contains(&value) {
        Ok(())
    } else {
        Err("STP interval must be 30, 60, or 240 minutes".into())
    }
}
fn interval_duration(minutes: i64) -> Duration {
    Duration::from_secs(minutes.max(1) as u64 * 60)
}
fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn calculate_findings(
    collection: &StpCollection,
    previous_complete_baseline: Option<&StpPayload>,
) -> Vec<StpFinding> {
    let mut findings = collection.findings.clone();
    let payload = &collection.payload;

    let mut graph: HashMap<&str, HashSet<&str>> = payload
        .devices
        .iter()
        .map(|device| (device.device_id.as_str(), HashSet::new()))
        .collect();
    for link in payload.links.iter().filter(|link| link.bidirectional) {
        if let Some(remote) = link.remote_device_id.as_deref() {
            graph
                .entry(link.local_device_id.as_str())
                .or_default()
                .insert(remote);
            graph
                .entry(remote)
                .or_default()
                .insert(link.local_device_id.as_str());
        }
    }
    let components = connected_components(&graph);
    for component in components {
        let mut roots: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
        let mut regions: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
        for instance in payload.instances.iter().filter(|instance| {
            component.contains(
                instance
                    .ports
                    .first()
                    .map(|port| port.device_id.as_str())
                    .unwrap_or_default(),
            )
        }) {
            if let Some(root) = instance.root_id.as_deref() {
                roots.entry(instance.id.as_str()).or_default().insert(root);
            }
            if instance
                .mode
                .as_deref()
                .is_some_and(|mode| mode.eq_ignore_ascii_case("mstp"))
            {
                if let Some(region) = instance.mst_region.as_deref() {
                    regions
                        .entry(instance.id.as_str())
                        .or_default()
                        .insert(region);
                }
            }
        }
        for (scope, values) in roots {
            if values.len() > 1 {
                findings.push(StpFinding {
                    kind: "ROOT_DISAGREEMENT".into(),
                    severity: "warning".into(),
                    interface: None,
                    device_id: None,
                    detail: format!("conflicting roots for instance {scope}"),
                });
            }
        }
        for (scope, values) in regions {
            if values.len() > 1 {
                findings.push(StpFinding {
                    kind: "MST_REGION_MISMATCH".into(),
                    severity: "warning".into(),
                    interface: None,
                    device_id: None,
                    detail: format!("MST regions differ for instance {scope}"),
                });
            }
        }
    }

    let Some(previous) = previous_complete_baseline else {
        return findings;
    };
    let old_instances: HashMap<(&str, &str), &StpInstance> = previous
        .instances
        .iter()
        .flat_map(|instance| {
            instance
                .ports
                .first()
                .map(|port| ((port.device_id.as_str(), instance.id.as_str()), instance))
        })
        .collect();
    let old_ports: HashMap<(&str, &str, &str), &StpPort> = previous
        .instances
        .iter()
        .flat_map(|instance| {
            instance.ports.iter().map(move |port| {
                (
                    (
                        port.device_id.as_str(),
                        instance.id.as_str(),
                        port.interface.as_str(),
                    ),
                    port,
                )
            })
        })
        .collect();
    for instance in &payload.instances {
        let Some(device_id) = instance.ports.first().map(|port| port.device_id.as_str()) else {
            continue;
        };
        if let Some(old) = old_instances.get(&(device_id, instance.id.as_str())) {
            if old.root_id.is_some()
                && instance.root_id.is_some()
                && old.root_id != instance.root_id
            {
                findings.push(StpFinding {
                    kind: "ROOT_CHANGED".into(),
                    severity: "warning".into(),
                    device_id: Some(device_id.into()),
                    interface: None,
                    detail: format!("root changed for instance {}", instance.id),
                });
            }
            if let (Some(old_count), Some(new_count)) =
                (old.topology_change_count, instance.topology_change_count)
            {
                if new_count != old_count {
                    findings.push(StpFinding {
                        kind: if new_count > old_count {
                            "TOPOLOGY_CHANGE_INCREMENT"
                        } else {
                            "COUNTER_RESET"
                        }
                        .into(),
                        severity: "informational".into(),
                        device_id: Some(device_id.into()),
                        interface: None,
                        detail: format!(
                            "topology-change counter changed for instance {}",
                            instance.id
                        ),
                    });
                }
            }
        }
        for port in &instance.ports {
            if let Some(old) = old_ports.get(&(
                port.device_id.as_str(),
                instance.id.as_str(),
                port.interface.as_str(),
            )) {
                if (old.role.as_deref(), old.state.as_deref())
                    != (port.role.as_deref(), port.state.as_deref())
                {
                    findings.push(StpFinding {
                        kind: "PORT_STATE_CHANGED".into(),
                        severity: "informational".into(),
                        device_id: Some(port.device_id.clone()),
                        interface: Some(port.interface.clone()),
                        detail: "port role/state changed".into(),
                    });
                }
            }
            if port.explicit_evidence.is_some() {
                findings.push(StpFinding {
                    kind: "PORT_INCONSISTENT_OR_BROKEN".into(),
                    severity: "warning".into(),
                    device_id: Some(port.device_id.clone()),
                    interface: Some(port.interface.clone()),
                    detail: "explicit port inconsistency evidence".into(),
                });
            }
        }
    }
    findings
}

fn connected_components<'a>(graph: &HashMap<&'a str, HashSet<&'a str>>) -> Vec<HashSet<&'a str>> {
    let mut unseen: BTreeSet<&str> = graph.keys().copied().collect();
    let mut result = Vec::new();
    while let Some(start) = unseen.iter().next().copied() {
        unseen.remove(start);
        let mut component = HashSet::from([start]);
        let mut pending = vec![start];
        while let Some(current) = pending.pop() {
            for neighbor in graph.get(current).into_iter().flatten() {
                if unseen.remove(neighbor) {
                    component.insert(neighbor);
                    pending.push(neighbor);
                }
            }
        }
        result.push(component);
    }
    result
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum CollectionStartError {
    #[error("collection_active")]
    Active,
    #[error("STP repository error: {0}")]
    Repository(String),
}

#[derive(Default)]
struct CollectionSlot {
    current: Mutex<Option<StpCancellation>>,
}

impl CollectionSlot {
    fn acquire(&self) -> Result<StpCancellation, CollectionStartError> {
        let mut current = self.current.lock();
        if current.is_some() {
            return Err(CollectionStartError::Active);
        }
        let cancellation = StpCancellation::default();
        *current = Some(cancellation.clone());
        Ok(cancellation)
    }

    fn cancel_current(&self) {
        if let Some(cancellation) = self.current.lock().as_ref() {
            cancellation.cancel();
        }
    }

    fn release(&self) {
        *self.current.lock() = None;
    }
}

enum SchedulerSignal {
    Stop,
    Reschedule,
}

pub struct StpScheduler {
    db: Arc<Mutex<Connection>>,
    collector: Arc<dyn StpCollector>,
    collection: Arc<CollectionSlot>,
    next_tick: Arc<Mutex<Option<Instant>>>,
    interval: Arc<Mutex<Duration>>,
    stop_tx: Mutex<Option<Sender<SchedulerSignal>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
    started: AtomicBool,
}

impl StpScheduler {
    pub fn new(db: Arc<Mutex<Connection>>, collector: Arc<dyn StpCollector>) -> Self {
        Self {
            db,
            collector,
            collection: Arc::new(CollectionSlot::default()),
            next_tick: Arc::new(Mutex::new(None)),
            interval: Arc::new(Mutex::new(interval_duration(60))),
            stop_tx: Mutex::new(None),
            worker: Mutex::new(None),
            started: AtomicBool::new(false),
        }
    }

    pub fn start(&self) -> Result<(), String> {
        let settings = StpRepository::get_settings(&self.db.lock())?;
        if !settings.schedule_enabled {
            return Ok(());
        }
        if self.worker.lock().is_some() {
            self.reschedule(interval_duration(settings.interval_minutes));
            return Ok(());
        }
        self.start_at(Instant::now(), interval_duration(settings.interval_minutes))?;
        let (stop_tx, stop_rx) = mpsc::channel();
        *self.stop_tx.lock() = Some(stop_tx);
        let scheduler = self.clone_for_worker();
        *self.worker.lock() = Some(thread::spawn(move || scheduler.run_loop(stop_rx)));
        Ok(())
    }

    pub fn start_at(&self, started: Instant, interval: Duration) -> Result<(), String> {
        if self.started.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        *self.interval.lock() = interval;
        *self.next_tick.lock() = Some(started + interval);
        Ok(())
    }

    fn reschedule_at(&self, started: Instant, interval: Duration) {
        *self.interval.lock() = interval;
        *self.next_tick.lock() = Some(started + interval);
    }

    fn reschedule(&self, interval: Duration) {
        self.reschedule_at(Instant::now(), interval);
        if let Some(tx) = self.stop_tx.lock().as_ref() {
            let _ = tx.send(SchedulerSignal::Reschedule);
        }
    }

    pub fn scheduled_tick(&self, at: Instant) -> StpTickOutcome {
        let due = *self.next_tick.lock();
        let Some(due) = due else {
            return StpTickOutcome::NotDue;
        };
        if at < due {
            return StpTickOutcome::NotDue;
        }
        *self.next_tick.lock() = Some(due + *self.interval.lock());
        match self.collect(StpTrigger::Scheduled) {
            Ok(snapshot) => {
                let _ = StpRepository::record_schedule_event(
                    &self.db.lock(),
                    "completed",
                    snapshot.status.as_str(),
                );
                StpTickOutcome::Collected
            }
            Err(CollectionStartError::Active) => {
                let _ = StpRepository::record_schedule_event(
                    &self.db.lock(),
                    "skipped",
                    "collection_active",
                );
                StpTickOutcome::SkippedActive
            }
            Err(CollectionStartError::Repository(_)) => StpTickOutcome::RepositoryError,
        }
    }

    pub fn begin_collection(
        &self,
        _trigger: StpTrigger,
    ) -> Result<CollectionLease, CollectionStartError> {
        self.acquire_collection().map(|_| CollectionLease {
            collection: self.collection.clone(),
        })
    }

    pub fn collect(&self, trigger: StpTrigger) -> Result<StpSnapshot, CollectionStartError> {
        let cancellation = self.acquire_collection()?;
        let started_at = now_secs();
        let baseline = match StpRepository::newest_complete_baseline(&self.db.lock()) {
            Ok(snapshot) => snapshot.map(|item| item.payload),
            Err(error) => {
                self.release_collection();
                return Err(CollectionStartError::Repository(error));
            }
        };
        let snapshot = match self.collector.collect(&cancellation) {
            Ok(collection) => {
                let status = if collection.evidence.is_complete() {
                    StpSnapshotStatus::Complete
                } else if collection.evidence.parsable_stp_devices > 0 {
                    StpSnapshotStatus::Partial
                } else {
                    StpSnapshotStatus::Failed
                };
                let findings = calculate_findings(&collection, baseline.as_ref());
                let mut payload = collection.payload;
                payload.findings = findings;
                StpSnapshot {
                    id: Uuid::new_v4().to_string(),
                    started_at,
                    finished_at: Some(now_secs()),
                    trigger,
                    status,
                    baseline_eligible: status == StpSnapshotStatus::Complete,
                    schema_version: STP_SCHEMA_VERSION,
                    payload,
                    error_summary: None,
                }
            }
            Err(error) => StpSnapshot {
                id: Uuid::new_v4().to_string(),
                started_at,
                finished_at: Some(now_secs()),
                trigger,
                status: StpSnapshotStatus::Failed,
                baseline_eligible: false,
                schema_version: STP_SCHEMA_VERSION,
                payload: StpPayload::default(),
                error_summary: Some(error.to_string()),
            },
        };
        let result = {
            let connection = self.db.lock();
            StpRepository::insert_snapshot(&connection, &snapshot)
                .and_then(|_| StpRepository::retain(&connection, now_secs()))
        };
        self.release_collection();
        result.map_err(CollectionStartError::Repository)?;
        Ok(snapshot)
    }

    pub fn cancel_current(&self) {
        self.collection.cancel_current();
    }

    pub fn shutdown(&self) -> Result<(), String> {
        self.cancel_current();
        if let Some(tx) = self.stop_tx.lock().take() {
            let _ = tx.send(SchedulerSignal::Stop);
        }
        if let Some(worker) = self.worker.lock().take() {
            worker
                .join()
                .map_err(|_| "STP scheduler thread panicked".to_string())?;
        }
        self.started.store(false, Ordering::SeqCst);
        *self.next_tick.lock() = None;
        Ok(())
    }

    fn acquire_collection(&self) -> Result<StpCancellation, CollectionStartError> {
        self.collection.acquire()
    }

    fn release_collection(&self) {
        self.collection.release();
    }

    fn run_loop(self: Arc<Self>, stop_rx: Receiver<SchedulerSignal>) {
        loop {
            let due = *self.next_tick.lock();
            let now = Instant::now();
            let wait = due
                .map(|at| at.saturating_duration_since(now))
                .unwrap_or(Duration::from_secs(60));
            match stop_rx.recv_timeout(wait) {
                Ok(SchedulerSignal::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Ok(SchedulerSignal::Reschedule) => continue,
                Err(mpsc::RecvTimeoutError::Timeout) => self.handle_timeout(due, now),
            }
        }
    }

    fn handle_timeout(&self, due: Option<Instant>, now: Instant) {
        if due.is_some_and(|at| at < now) {
            *self.next_tick.lock() = Some(now + *self.interval.lock());
            let _ = StpRepository::record_schedule_event(&self.db.lock(), "skipped", "overdue");
        } else if let Some(at) = due {
            let _ = self.scheduled_tick(at);
        }
    }

    fn clone_for_worker(&self) -> Arc<Self> {
        Arc::new(Self {
            db: self.db.clone(),
            collector: self.collector.clone(),
            collection: self.collection.clone(),
            next_tick: self.next_tick.clone(),
            interval: self.interval.clone(),
            stop_tx: Mutex::new(None),
            worker: Mutex::new(None),
            started: AtomicBool::new(true),
        })
    }
}

pub struct CollectionLease {
    collection: Arc<CollectionSlot>,
}
impl Drop for CollectionLease {
    fn drop(&mut self) {
        self.collection.release();
    }
}

impl Drop for StpScheduler {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StpTickOutcome {
    NotDue,
    Disabled,
    Collected,
    SkippedActive,
    RepositoryError,
}

pub struct StpService {
    pub scheduler: Arc<StpScheduler>,
}
impl StpService {
    pub fn new(db: Arc<Mutex<Connection>>, collector: Arc<dyn StpCollector>) -> Self {
        Self {
            scheduler: Arc::new(StpScheduler::new(db, collector)),
        }
    }
    pub fn collect(&self, trigger: StpTrigger) -> Result<StpSnapshot, String> {
        self.scheduler.collect(trigger).map_err(|e| e.to_string())
    }
    pub fn start(&self) -> Result<(), String> {
        self.scheduler.start()
    }
    pub fn shutdown(&self) -> Result<(), String> {
        self.scheduler.shutdown()
    }
}

#[tauri::command]
pub fn stp_settings_get(state: State<'_, AppState>) -> Result<StpSettings, String> {
    StpRepository::get_settings(&state.db.lock())
}

#[tauri::command]
pub fn stp_settings_save(
    state: State<'_, AppState>,
    mut settings: StpSettings,
) -> Result<StpSettings, String> {
    let saved = StpRepository::save_settings(&state.db.lock(), &mut settings)?;
    if saved.schedule_enabled {
        state.stp.start()?;
    } else {
        state.stp.shutdown()?;
    }
    Ok(saved)
}

#[tauri::command]
pub fn stp_collect_now(state: State<'_, AppState>) -> Result<StpSnapshot, String> {
    state.stp.collect(StpTrigger::Manual)
}

#[tauri::command]
pub fn stp_snapshot_list(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<StpSnapshot>, String> {
    StpRepository::list_snapshots(&state.db.lock(), limit)
}

#[tauri::command]
pub fn stp_snapshot_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<StpSnapshot>, String> {
    StpRepository::get_snapshot(&state.db.lock(), &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_db() -> Connection {
        let file = tempfile::NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();
        std::mem::forget(file);
        crate::db::open_and_migrate(&path).unwrap()
    }

    #[test]
    fn v0090_creates_typed_stp_tables_and_default_settings() {
        let connection = open_db();
        let tables = connection
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'stp_%'")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(tables.len(), 3);
        assert!(tables.contains(&"stp_settings".to_string()));
        assert!(tables.contains(&"stp_snapshots".to_string()));
        assert!(tables.contains(&"stp_schedule_events".to_string()));
        let settings = StpRepository::get_settings(&connection).unwrap();
        assert_eq!(settings.singleton_id, STP_SETTINGS_SINGLETON_ID);
        assert!(!settings.schedule_enabled);
        assert_eq!(settings.interval_minutes, 60);

        let invalid_baseline =
            test_snapshot("partial-baseline", 1, StpSnapshotStatus::Partial, true);
        assert!(StpRepository::insert_snapshot(&connection, &invalid_baseline).is_err());
    }

    #[test]
    fn settings_round_trip_accepts_only_supported_intervals() {
        let connection = open_db();
        let mut settings = StpSettings {
            singleton_id: "caller-value-is-ignored".into(),
            schedule_enabled: true,
            interval_minutes: 240,
            updated_at: 0,
        };
        let saved = StpRepository::save_settings(&connection, &mut settings).unwrap();
        assert_eq!(saved.singleton_id, STP_SETTINGS_SINGLETON_ID);
        assert!(saved.updated_at > 0);
        assert_eq!(StpRepository::get_settings(&connection).unwrap(), saved);
        for interval in [0, 29, 31, 120, 241] {
            settings.interval_minutes = interval;
            assert!(StpRepository::save_settings(&connection, &mut settings).is_err());
        }
    }

    #[test]
    fn collection_status_requires_all_evidence_and_calculates_findings_before_baseline() {
        let service = StpService::new(
            Arc::new(Mutex::new(open_db())),
            Arc::new(StaticCollector::complete()),
        );
        let snapshot = service.collect(StpTrigger::Manual).unwrap();
        assert_eq!(snapshot.status, StpSnapshotStatus::Complete);
        assert!(snapshot.baseline_eligible);
        assert_eq!(snapshot.payload.findings.len(), 1);
        assert_eq!(snapshot.payload.findings[0].kind, "root-change");
    }

    #[test]
    fn mixed_device_collection_is_partial_and_not_baseline_eligible() {
        let collection = collection_from_sidecar_result(&serde_json::json!({
            "status": "partial",
            "devices": [
                {"device": "r1", "platform": "iosxe", "status": "complete", "stp": {"instances": [{"id": "10", "root_id": "root-a"}]}, "neighbors": {"cdp": [], "lldp": []}, "gaps": [{"source": "lldp", "code": "parse_failed"}]},
                {"device": "r2", "platform": "nxos", "status": "failed", "stp": {"instances": [{"id": "10", "root_id": "stale-root"}]}, "neighbors": {"cdp": [], "lldp": []}}
            ]
        }))
        .unwrap();
        let service = StpService::new(
            Arc::new(Mutex::new(open_db())),
            Arc::new(StaticCollector { collection }),
        );

        let snapshot = service.collect(StpTrigger::Manual).unwrap();

        assert_eq!(snapshot.status, StpSnapshotStatus::Partial);
        assert!(!snapshot.baseline_eligible);
    }

    #[test]
    fn no_parsable_stp_devices_is_failed_and_never_becomes_a_baseline() {
        let collection = collection_from_sidecar_result(&serde_json::json!({
            "status": "failed",
            "devices": [
                {"device": "r1", "platform": "iosxe", "status": "failed", "stp": {"instances": [], "ports": []}},
                {"device": "r2", "platform": "nxos", "status": "failed", "stp": {"instances": [], "ports": []}}
            ]
        }))
        .unwrap();
        let connection = Arc::new(Mutex::new(open_db()));
        let service = StpService::new(connection.clone(), Arc::new(StaticCollector { collection }));

        let snapshot = service.collect(StpTrigger::Manual).unwrap();

        assert_eq!(snapshot.status, StpSnapshotStatus::Failed);
        assert!(!snapshot.baseline_eligible);
        assert!(StpRepository::newest_complete_baseline(&connection.lock())
            .unwrap()
            .is_none());
    }

    #[test]
    fn auxiliary_evidence_cannot_make_zero_parsable_stp_complete() {
        let collection = StpCollection {
            evidence: StpRequiredEvidence {
                device_inventory: true,
                spanning_tree: true,
                interfaces: true,
                neighbors: true,
                supported_devices: 0,
                parsable_stp_devices: 0,
            },
            payload: StpPayload::default(),
            findings: Vec::new(),
        };
        let service = StpService::new(
            Arc::new(Mutex::new(open_db())),
            Arc::new(StaticCollector { collection }),
        );

        let snapshot = service.collect(StpTrigger::Manual).unwrap();

        assert_eq!(snapshot.status, StpSnapshotStatus::Failed);
        assert!(!snapshot.baseline_eligible);
    }

    #[test]
    fn structural_stp_placeholders_are_not_parsable_baseline_state() {
        let collection = collection_from_sidecar_result(&serde_json::json!({
            "status": "complete",
            "devices": [{
                "device": "r1",
                "platform": "iosxe",
                "status": "complete",
                "stp": {
                    "instances": [{}],
                    "ports": [{"interface": "Gi1"}]
                }
            }]
        }))
        .unwrap();
        let service = StpService::new(
            Arc::new(Mutex::new(open_db())),
            Arc::new(StaticCollector { collection }),
        );

        let snapshot = service.collect(StpTrigger::Manual).unwrap();

        assert_eq!(snapshot.status, StpSnapshotStatus::Failed);
        assert!(!snapshot.baseline_eligible);
    }

    #[test]
    fn unsupported_platform_records_do_not_downgrade_supported_stp_state() {
        let collection = collection_from_sidecar_result(&serde_json::json!({
            "status": "complete",
            "devices": [
                {"device": "r1", "platform": "iosxe", "status": "complete", "stp": {"instances": [{"id": "10", "root_id": "root-a"}]}},
                {"device": "r2", "platform": "eos", "status": "failed", "stp": {"instances": []}}
            ]
        }))
        .unwrap();
        let service = StpService::new(
            Arc::new(Mutex::new(open_db())),
            Arc::new(StaticCollector { collection }),
        );

        let snapshot = service.collect(StpTrigger::Manual).unwrap();

        assert_eq!(snapshot.status, StpSnapshotStatus::Complete);
        assert!(snapshot.baseline_eligible);
    }

    #[test]
    fn auxiliary_evidence_gaps_do_not_invalidate_complete_stp_baseline() {
        let collection = collection_from_sidecar_result(&serde_json::json!({
            "status": "complete",
            "devices": [{
                "device": "r1",
                "platform": "iosxe",
                "status": "complete",
                "stp": {"instances": [{"id": "10", "root_id": "root-a"}]},
                "neighbors": {},
                "bundle": [],
                "gaps": [
                    {"source": "cdp", "code": "parse_failed"},
                    {"source": "lldp", "code": "parse_failed"},
                    {"source": "bundle", "code": "parse_failed"}
                ]
            }]
        }))
        .unwrap();
        let service = StpService::new(
            Arc::new(Mutex::new(open_db())),
            Arc::new(StaticCollector { collection }),
        );

        let snapshot = service.collect(StpTrigger::Manual).unwrap();

        assert_eq!(snapshot.status, StpSnapshotStatus::Complete);
        assert!(snapshot.baseline_eligible);
        assert_eq!(snapshot.payload.gaps.len(), 3);
    }

    #[test]
    fn sidecar_collection_requires_an_explicit_run_status() {
        let error = collection_from_sidecar_result(&serde_json::json!({
            "devices": [{
                "device": "r1",
                "platform": "iosxe",
                "status": "complete",
                "stp": {"instances": [{"id": "10"}]}
            }]
        }))
        .unwrap_err();

        assert_eq!(error, StpCollectorError::Failed);
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_terminates_the_sidecar_process_group_and_reader() {
        let directory = tempfile::tempdir().unwrap();
        let started_path = directory.path().join("started");
        let cancellation = StpCancellation::default();
        let call_cancellation = cancellation.clone();
        let (done_tx, done_rx) = mpsc::channel();
        let args = vec![
            "-c".to_string(),
            "read request; sleep 30 & echo started > \"$1\"; wait".to_string(),
            "stp-sidecar-test".to_string(),
            started_path.to_string_lossy().into_owned(),
        ];
        let call = thread::spawn(move || {
            let result = call_process_cancellable(
                "/bin/sh",
                &args,
                &serde_json::json!({"method": "stp.collect"}),
                &call_cancellation,
                Duration::from_secs(10),
            );
            let _ = done_tx.send(result);
        });

        let started_deadline = Instant::now() + Duration::from_secs(2);
        while !started_path.exists() && Instant::now() < started_deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(started_path.exists(), "test sidecar process did not start");

        cancellation.cancel();

        let result = done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("cancelled sidecar process did not terminate");
        assert!(matches!(result, Err(StpCollectorError::Cancelled)));
        call.join().unwrap();
    }

    #[test]
    fn production_findings_compare_against_previous_complete_baseline() {
        let baseline = StpPayload {
            devices: vec![StpDevice {
                device_id: "r1".into(),
                platform: "iosxe".into(),
            }],
            instances: vec![StpInstance {
                id: "10".into(),
                mode: Some("mstp".into()),
                bridge_id: Some("b".into()),
                root_id: Some("r1".into()),
                topology_change_count: Some(4),
                ports: vec![StpPort {
                    device_id: "r1".into(),
                    interface: "Gi1".into(),
                    role: Some("designated".into()),
                    state: Some("forwarding".into()),
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        let current = StpCollection {
            evidence: StpRequiredEvidence {
                device_inventory: true,
                spanning_tree: true,
                interfaces: true,
                supported_devices: 1,
                parsable_stp_devices: 1,
                ..Default::default()
            },
            payload: StpPayload {
                devices: baseline.devices.clone(),
                instances: vec![StpInstance {
                    id: "10".into(),
                    mode: Some("mstp".into()),
                    bridge_id: Some("b".into()),
                    root_id: Some("r2".into()),
                    topology_change_count: Some(2),
                    ports: vec![StpPort {
                        device_id: "r1".into(),
                        interface: "Gi1".into(),
                        role: Some("root".into()),
                        state: Some("blocking".into()),
                        explicit_evidence: Some("inconsistent".into()),
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            },
            findings: Vec::new(),
        };

        let findings = calculate_findings(&current, Some(&baseline));
        let kinds: std::collections::BTreeSet<_> = findings
            .iter()
            .map(|finding| finding.kind.as_str())
            .collect();
        assert!(kinds.contains("ROOT_CHANGED"));
        assert!(kinds.contains("COUNTER_RESET"));
        assert!(kinds.contains("PORT_STATE_CHANGED"));
        assert!(kinds.contains("PORT_INCONSISTENT_OR_BROKEN"));
    }

    #[test]
    fn alternate_blocking_port_without_explicit_evidence_is_not_inconsistent() {
        let baseline = StpPayload {
            instances: vec![StpInstance {
                id: "10".into(),
                ports: vec![StpPort {
                    device_id: "r1".into(),
                    interface: "Gi1".into(),
                    role: Some("designated".into()),
                    state: Some("forwarding".into()),
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        let collection = StpCollection {
            evidence: StpRequiredEvidence::default(),
            payload: StpPayload {
                instances: vec![StpInstance {
                    id: "10".into(),
                    ports: vec![StpPort {
                        device_id: "r1".into(),
                        interface: "Gi1".into(),
                        role: Some("alternate".into()),
                        state: Some("blocking".into()),
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            },
            findings: Vec::new(),
        };

        let findings = calculate_findings(&collection, Some(&baseline));

        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].kind, "PORT_STATE_CHANGED");
        assert_eq!(findings[0].severity, "informational");
    }

    #[test]
    fn findings_order_is_deterministic_across_disconnected_components() {
        let mut payload = StpPayload::default();
        for index in (0..12).rev() {
            let left = format!("r{index:02}a");
            let right = format!("r{index:02}b");
            let instance_id = format!("{index:02}");
            payload.devices.extend([
                StpDevice {
                    device_id: left.clone(),
                    platform: "iosxe".into(),
                },
                StpDevice {
                    device_id: right.clone(),
                    platform: "nxos".into(),
                },
            ]);
            payload.links.push(StpLink {
                local_device_id: left.clone(),
                local_interface: "Gi1".into(),
                remote_device_id: Some(right.clone()),
                bidirectional: true,
                ..Default::default()
            });
            payload.instances.extend([
                StpInstance {
                    id: instance_id.clone(),
                    root_id: Some("root-a".into()),
                    ports: vec![StpPort {
                        device_id: left,
                        interface: "Gi1".into(),
                        ..Default::default()
                    }],
                    ..Default::default()
                },
                StpInstance {
                    id: instance_id,
                    root_id: Some("root-b".into()),
                    ports: vec![StpPort {
                        device_id: right,
                        interface: "Gi1".into(),
                        ..Default::default()
                    }],
                    ..Default::default()
                },
            ]);
        }
        let collection = StpCollection {
            evidence: StpRequiredEvidence::default(),
            payload,
            findings: Vec::new(),
        };
        let expected: Vec<_> = (0..12)
            .map(|index| format!("conflicting roots for instance {index:02}"))
            .collect();

        let actual: Vec<_> = calculate_findings(&collection, None)
            .into_iter()
            .map(|finding| finding.detail)
            .collect();

        assert_eq!(actual, expected);
    }

    #[test]
    fn complete_collection_uses_persisted_baseline_before_promoting_current_snapshot() {
        let connection = Arc::new(Mutex::new(open_db()));
        let mut first = StaticCollector::complete().collection;
        first.findings.clear();
        first.payload.instances = vec![StpInstance {
            id: "10".into(),
            root_id: Some("root-a".into()),
            topology_change_count: Some(1),
            ports: vec![StpPort {
                device_id: "r1".into(),
                interface: "Gi1".into(),
                role: Some("designated".into()),
                state: Some("forwarding".into()),
                ..Default::default()
            }],
            ..Default::default()
        }];
        let mut second = first.clone();
        second.payload.instances[0].root_id = Some("root-b".into());
        second.payload.instances[0].topology_change_count = Some(2);
        let service = StpService::new(
            connection.clone(),
            Arc::new(SequenceCollector::new(vec![Ok(first), Ok(second)])),
        );

        let first_snapshot = service.collect(StpTrigger::Manual).unwrap();
        assert_eq!(
            StpRepository::newest_complete_baseline(&connection.lock())
                .unwrap()
                .unwrap()
                .id,
            first_snapshot.id
        );

        let second_snapshot = service.collect(StpTrigger::Manual).unwrap();
        let finding_kinds: BTreeSet<_> = second_snapshot
            .payload
            .findings
            .iter()
            .map(|finding| finding.kind.as_str())
            .collect();
        assert!(finding_kinds.contains("ROOT_CHANGED"));
        assert!(finding_kinds.contains("TOPOLOGY_CHANGE_INCREMENT"));
        assert!(second_snapshot.baseline_eligible);
        assert_eq!(
            StpRepository::get_snapshot(&connection.lock(), &second_snapshot.id)
                .unwrap()
                .unwrap()
                .payload
                .findings,
            second_snapshot.payload.findings
        );
    }

    #[test]
    fn partial_collection_does_not_replace_newest_complete_baseline() {
        let connection = Arc::new(Mutex::new(open_db()));
        let service = StpService::new(
            connection.clone(),
            Arc::new(SequenceCollector::new(vec![
                Ok(StaticCollector::complete().collection),
                Ok(StaticCollector::partial().collection),
            ])),
        );
        let complete = service.collect(StpTrigger::Manual).unwrap();
        let partial = service.collect(StpTrigger::Manual).unwrap();
        assert!(complete.baseline_eligible);
        assert_eq!(partial.status, StpSnapshotStatus::Partial);
        assert!(!partial.baseline_eligible);
        assert_eq!(
            StpRepository::newest_complete_baseline(&connection.lock())
                .unwrap()
                .unwrap()
                .id,
            complete.id
        );
    }

    #[test]
    fn retention_keeps_newest_complete_baseline() {
        let connection = open_db();
        let now = 2_000_000_000;
        let baseline = test_snapshot(
            "baseline",
            now - 10 * 24 * 60 * 60,
            StpSnapshotStatus::Complete,
            true,
        );
        let old_partial = test_snapshot(
            "old-partial",
            now - 10 * 24 * 60 * 60,
            StpSnapshotStatus::Partial,
            false,
        );
        StpRepository::insert_snapshot(&connection, &baseline).unwrap();
        StpRepository::insert_snapshot(&connection, &old_partial).unwrap();
        StpRepository::retain(&connection, now).unwrap();
        assert!(StpRepository::get_snapshot(&connection, "baseline")
            .unwrap()
            .is_some());
        assert!(StpRepository::get_snapshot(&connection, "old-partial")
            .unwrap()
            .is_none());
    }

    #[test]
    fn scheduler_waits_a_full_interval_and_skips_active_ticks_without_queueing() {
        let connection = Arc::new(Mutex::new(open_db()));
        let scheduler =
            StpScheduler::new(connection.clone(), Arc::new(StaticCollector::complete()));
        let started = Instant::now();
        scheduler
            .start_at(started, Duration::from_millis(100))
            .unwrap();
        assert_eq!(scheduler.scheduled_tick(started), StpTickOutcome::NotDue);
        assert_eq!(
            scheduler.scheduled_tick(started + Duration::from_millis(100)),
            StpTickOutcome::Collected
        );
        let _lease = scheduler.begin_collection(StpTrigger::Scheduled).unwrap();
        assert_eq!(
            scheduler.scheduled_tick(started + Duration::from_millis(200)),
            StpTickOutcome::SkippedActive
        );
        assert_eq!(
            StpRepository::schedule_event_count(&connection.lock(), "skipped", "collection_active")
                .unwrap(),
            1
        );
        scheduler.cancel_current();
        scheduler.shutdown().unwrap();
    }

    #[test]
    fn collection_slot_publishes_one_cancellable_owner_atomically() {
        let slot = CollectionSlot::default();

        let first = slot.acquire().unwrap();
        assert!(matches!(slot.acquire(), Err(CollectionStartError::Active)));

        slot.cancel_current();
        assert!(first.is_cancelled());

        slot.release();
        let second = slot.acquire().unwrap();
        assert!(!second.is_cancelled());
    }

    #[test]
    fn scheduler_records_overdue_ticks_without_replaying_collection() {
        let connection = Arc::new(Mutex::new(open_db()));
        let scheduler = StpScheduler::new(
            connection.clone(),
            Arc::new(DelayedCollector::new(Duration::from_millis(120))),
        );
        let now = Instant::now();

        scheduler.handle_timeout(Some(now - Duration::from_secs(2)), now);

        assert_eq!(
            StpRepository::schedule_event_count(&connection.lock(), "skipped", "overdue"),
            Ok(1)
        );
    }

    #[test]
    fn rescheduling_uses_the_saved_enabled_interval() {
        let scheduler = StpScheduler::new(
            Arc::new(Mutex::new(open_db())),
            Arc::new(StaticCollector::complete()),
        );
        let started = Instant::now();
        scheduler
            .start_at(started, Duration::from_millis(100))
            .unwrap();
        scheduler.reschedule_at(started, Duration::from_millis(200));

        assert_eq!(
            scheduler.scheduled_tick(started + Duration::from_millis(100)),
            StpTickOutcome::NotDue
        );
        assert_eq!(
            scheduler.scheduled_tick(started + Duration::from_millis(200)),
            StpTickOutcome::Collected
        );
    }

    #[test]
    fn live_reschedule_wakes_worker_for_the_new_earlier_deadline() {
        let connection = Arc::new(Mutex::new(open_db()));
        let mut settings = StpSettings {
            schedule_enabled: true,
            interval_minutes: 240,
            ..Default::default()
        };
        StpRepository::save_settings(&connection.lock(), &mut settings).unwrap();
        let (collected_tx, collected_rx) = mpsc::channel();
        let scheduler = StpScheduler::new(
            connection,
            Arc::new(NotifyingCollector {
                collected: Mutex::new(Some(collected_tx)),
            }),
        );
        scheduler.start().unwrap();
        thread::sleep(Duration::from_millis(100));

        scheduler.reschedule(Duration::from_millis(20));

        collected_rx
            .recv_timeout(Duration::from_millis(500))
            .expect("rescheduled worker kept waiting for the old deadline");
        scheduler.shutdown().unwrap();
    }

    #[test]
    fn collection_preserves_repository_errors() {
        let connection = Arc::new(Mutex::new(open_db()));
        connection
            .lock()
            .execute("DROP TABLE stp_snapshots", [])
            .unwrap();
        let service = StpService::new(connection, Arc::new(StaticCollector::complete()));

        assert!(matches!(
            service.scheduler.collect(StpTrigger::Manual),
            Err(CollectionStartError::Repository(_))
        ));
    }

    #[test]
    fn sidecar_payload_whitelists_normalized_evidence() {
        let collection = collection_from_sidecar_result(&serde_json::json!({
            "status": "complete",
            "devices": [{
                "device": "r1",
                "platform": "iosxe",
                "stp": {"ports": [{"interface": "Gi1", "state": "forwarding"}]},
                "neighbors": {"cdp": [], "lldp": []},
                "password": "must-not-cross-the-boundary",
                "output": "raw-cli-must-not-cross-the-boundary"
            }]
        }))
        .unwrap();

        let persisted = serde_json::to_string(&collection).unwrap();
        assert_eq!(collection.payload.devices[0].device_id, "r1");
        assert!(!persisted.contains("must-not-cross-the-boundary"));
        assert!(!persisted.contains("raw-cli-must-not-cross-the-boundary"));
    }

    #[test]
    fn sidecar_payload_preserves_safe_instance_details_and_collection_gaps() {
        let collection = collection_from_sidecar_result(&serde_json::json!({
            "status": "complete",
            "devices": [{
                "device": "r1",
                "platform": "iosxe",
                "stp": {
                    "mode": "pvst",
                    "instances": [{
                        "id": "10",
                        "mode": "pvst",
                        "bridge_id": "32768.r1",
                        "root_id": "32768.r1",
                        "topology_change_count": 7,
                        "mst_region": "campus/1/abc123",
                        "bridge_priority": 32768,
                        "root_priority": 32768,
                        "root_cost": 4,
                        "root_port": "Gi1/0/1",
                        "interfaces": [{
                            "interface": "Gi1/0/1",
                            "role": "designated",
                            "state": "forwarding"
                        }]
                    }]
                },
                "neighbors": {"cdp": [{
                    "device_id": "r2",
                    "local_interface": "Gi1/0/1",
                    "instance": "10",
                    "bidirectional": true
                }], "lldp": []},
                "gaps": [{"source": "lldp", "code": "parse_failed"}],
                "raw": "must-not-cross-the-boundary"
            }]
        }))
        .unwrap();

        assert_eq!(collection.payload.instances[0].id, "10");
        assert_eq!(
            collection.payload.instances[0].mode.as_deref(),
            Some("pvst")
        );
        assert_eq!(
            collection.payload.instances[0].bridge_id.as_deref(),
            Some("32768.r1")
        );
        assert_eq!(
            collection.payload.instances[0].root_id.as_deref(),
            Some("32768.r1")
        );
        assert_eq!(
            collection.payload.instances[0].topology_change_count,
            Some(7)
        );
        assert_eq!(
            collection.payload.instances[0].mst_region.as_deref(),
            Some("campus/1/abc123")
        );
        assert_eq!(collection.payload.instances[0].bridge_priority, Some(32768));
        assert_eq!(collection.payload.instances[0].root_priority, Some(32768));
        assert_eq!(collection.payload.instances[0].root_cost, Some(4));
        assert_eq!(
            collection.payload.instances[0].root_port.as_deref(),
            Some("Gi1/0/1")
        );
        assert_eq!(
            collection.payload.instances[0].ports[0].interface,
            "Gi1/0/1"
        );
        assert_eq!(
            collection.payload.instances[0].ports[0].role.as_deref(),
            Some("designated")
        );
        assert_eq!(
            collection.payload.instances[0].ports[0].state.as_deref(),
            Some("forwarding")
        );
        assert_eq!(collection.payload.gaps[0].code, "parse_failed");
        assert_eq!(
            collection.payload.links[0].instance_id.as_deref(),
            Some("10")
        );
        assert!(collection.payload.links[0].bidirectional);
        let serialized = serde_json::to_value(&collection.payload).unwrap();
        assert_eq!(serialized["instances"][0]["bridgeId"], "32768.r1");
        assert_eq!(serialized["instances"][0]["mode"], "pvst");
        assert_eq!(serialized["instances"][0]["topologyChangeCount"], 7);
        assert_eq!(serialized["instances"][0]["mstRegion"], "campus/1/abc123");
        assert_eq!(serialized["instances"][0]["bridgePriority"], 32768);
        assert_eq!(serialized["instances"][0]["rootPriority"], 32768);
        assert_eq!(serialized["instances"][0]["rootCost"], 4);
        assert_eq!(serialized["instances"][0]["rootPort"], "Gi1/0/1");
        assert_eq!(
            serialized["instances"][0]["ports"][0]["interface"],
            "Gi1/0/1"
        );
        assert_eq!(serialized["instances"][0]["ports"][0]["role"], "designated");
        assert_eq!(
            serialized["instances"][0]["ports"][0]["state"],
            "forwarding"
        );
        assert_eq!(serialized["links"][0]["instanceId"], "10");
        assert!(serialized.get("raw").is_none());
    }

    #[test]
    fn legacy_stp_payloads_load_without_new_evidence_fields() {
        let payload: StpPayload = serde_json::from_value(serde_json::json!({
            "devices": [],
            "links": [{
                "localDeviceId": "r1",
                "localInterface": "Gi1/0/1",
                "remoteDeviceId": "r2",
                "bidirectional": false
            }],
            "findings": []
        }))
        .unwrap();

        assert!(payload.instances.is_empty());
        assert!(payload.gaps.is_empty());
        assert_eq!(payload.links[0].instance_id, None);
    }

    #[test]
    fn sidecar_failure_codes_map_to_stable_collection_errors() {
        let cases = [
            (
                "unsupported_platform",
                StpCollectorError::UnsupportedPlatform,
            ),
            ("testbed_unavailable", StpCollectorError::TestbedUnavailable),
            (
                "no_supported_devices",
                StpCollectorError::NoSupportedDevices,
            ),
        ];

        for (code, expected) in cases {
            let error = collection_from_sidecar_result(&serde_json::json!({
                "status": "failed",
                "code": code,
                "devices": []
            }))
            .unwrap_err();
            assert_eq!(error, expected);
        }
    }

    #[test]
    fn stable_collection_errors_are_persisted_for_the_ui() {
        let connection = Arc::new(Mutex::new(open_db()));
        let service = StpService::new(
            connection,
            Arc::new(SequenceCollector::new(vec![Err(
                StpCollectorError::TestbedUnavailable,
            )])),
        );

        let snapshot = service.collect(StpTrigger::Manual).unwrap();

        assert_eq!(
            snapshot.error_summary.as_deref(),
            Some("testbed_unavailable")
        );
    }

    #[test]
    fn unsupported_and_no_devices_states_are_typed_failures() {
        let connection = Arc::new(Mutex::new(open_db()));
        let unsupported = StpService::new(connection.clone(), Arc::new(UnsupportedStpCollector));
        assert_eq!(
            unsupported.collect(StpTrigger::Manual).unwrap().status,
            StpSnapshotStatus::Failed
        );
        let no_devices = StpService::new(connection, Arc::new(NoDeviceStpCollector));
        let snapshot = no_devices.collect(StpTrigger::Manual).unwrap();
        assert_eq!(snapshot.status, StpSnapshotStatus::Failed);
        assert_eq!(
            snapshot.error_summary.as_deref(),
            Some("no devices available")
        );
    }

    #[derive(Clone)]
    struct StaticCollector {
        collection: StpCollection,
    }
    impl StaticCollector {
        fn complete() -> Self {
            Self {
                collection: StpCollection {
                    evidence: StpRequiredEvidence {
                        device_inventory: true,
                        spanning_tree: true,
                        interfaces: true,
                        neighbors: true,
                        supported_devices: 1,
                        parsable_stp_devices: 1,
                    },
                    payload: StpPayload {
                        devices: vec![StpDevice {
                            device_id: "r1".into(),
                            platform: "iosxe".into(),
                        }],
                        ..Default::default()
                    },
                    findings: vec![StpFinding {
                        kind: "root-change".into(),
                        severity: "info".into(),
                        detail: "root changed".into(),
                        ..Default::default()
                    }],
                },
            }
        }
        fn partial() -> Self {
            Self {
                collection: StpCollection {
                    evidence: StpRequiredEvidence {
                        device_inventory: true,
                        supported_devices: 2,
                        parsable_stp_devices: 1,
                        ..Default::default()
                    },
                    payload: StpPayload::default(),
                    findings: Vec::new(),
                },
            }
        }
    }
    impl StpCollector for StaticCollector {
        fn collect(
            &self,
            cancellation: &StpCancellation,
        ) -> Result<StpCollection, StpCollectorError> {
            if cancellation.is_cancelled() {
                return Err(StpCollectorError::Cancelled);
            }
            Ok(self.collection.clone())
        }
    }

    struct DelayedCollector {
        delay: Duration,
    }

    struct NotifyingCollector {
        collected: Mutex<Option<Sender<()>>>,
    }

    impl StpCollector for NotifyingCollector {
        fn collect(
            &self,
            _cancellation: &StpCancellation,
        ) -> Result<StpCollection, StpCollectorError> {
            if let Some(collected) = self.collected.lock().take() {
                let _ = collected.send(());
            }
            Ok(StaticCollector::complete().collection)
        }
    }

    impl DelayedCollector {
        fn new(delay: Duration) -> Self {
            Self { delay }
        }
    }
    impl StpCollector for DelayedCollector {
        fn collect(
            &self,
            cancellation: &StpCancellation,
        ) -> Result<StpCollection, StpCollectorError> {
            thread::sleep(self.delay);
            if cancellation.is_cancelled() {
                return Err(StpCollectorError::Cancelled);
            }
            Ok(StaticCollector::complete().collection)
        }
    }

    struct SequenceCollector {
        results: Mutex<Vec<Result<StpCollection, StpCollectorError>>>,
    }
    impl SequenceCollector {
        fn new(results: Vec<Result<StpCollection, StpCollectorError>>) -> Self {
            Self {
                results: Mutex::new(results.into_iter().rev().collect()),
            }
        }
    }
    impl StpCollector for SequenceCollector {
        fn collect(
            &self,
            _cancellation: &StpCancellation,
        ) -> Result<StpCollection, StpCollectorError> {
            self.results.lock().pop().unwrap()
        }
    }

    fn test_snapshot(
        id: &str,
        started_at: i64,
        status: StpSnapshotStatus,
        baseline_eligible: bool,
    ) -> StpSnapshot {
        StpSnapshot {
            id: id.into(),
            started_at,
            finished_at: Some(started_at),
            trigger: StpTrigger::Manual,
            status,
            baseline_eligible,
            schema_version: STP_SCHEMA_VERSION,
            payload: StpPayload::default(),
            error_summary: None,
        }
    }
}
