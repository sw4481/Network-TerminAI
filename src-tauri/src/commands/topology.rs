//! Plan 13 Phase 1.3 — Tauri commands exposing the topology module.
//!
//! Frontend integration:
//!   - When a `show cdp/lldp neighbor*` block completes, the frontend
//!     calls `topology_ingest_from_block(blockId, vendor, platform,
//!     deviceRef, deviceKind)`. Vendor/platform live on the Tab in
//!     in-memory frontend state; the same pattern is used by
//!     `structured_auto_parse`.
//!   - The other commands are CRUD wrappers used by the Topology tab and
//!     the inline topology panel.

use regex::Regex;
use rusqlite::params;
use std::sync::OnceLock;
use tauri::State;

use super::AppState;
use crate::topology::{
    cache, graph, ingest,
    interchange::{ImportPreview, TopologyImporter},
    lookup, CaptureOutcome, CaptureStatus, DiscoverySummary, GraphSnapshot, IngestSummary,
    NeighborCacheRow, NodePosition, SavedDeviceLookup, TopologyGraph, TopologyNode,
    GLOBAL_GRAPH_ID,
};

#[tauri::command]
pub async fn topology_discovery_start(
    state: State<'_, AppState>,
    request: crate::topology::discovery::DiscoveryRequest,
) -> Result<crate::topology::discovery::DiscoveryReport, String> {
    state.topology_discovery.start(request)
}

#[tauri::command]
pub fn topology_discovery_status(
    state: State<'_, AppState>,
    run_id: Option<String>,
) -> Result<Option<crate::topology::discovery::DiscoveryReport>, String> {
    state.topology_discovery.status(run_id.as_deref())
}

#[tauri::command]
pub fn topology_discovery_cancel(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<crate::topology::discovery::DiscoveryReport, String> {
    state.topology_discovery.cancel(&run_id)
}

/// Captures the protocol token from a topology-trigger show command.
///
/// Phase 1 covered CDP/LLDP; Phase 5 Task 5.2 extended to routing
/// adjacencies (BGP / OSPF / IS-IS).
fn protocol_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)^\s*show\s+(?:(?P<cdp>cdp)\s+neigh(?:bor)?|(?P<lldp>lldp)\s+neigh(?:bor)?|ip\s+(?P<bgp>bgp)\s+summ(?:ary)?|ip\s+(?P<ospf>ospf)\s+neigh(?:bor)?|(?P<isis>isis)\s+neigh(?:bors)?)",
        )
        .expect("topology protocol regex must compile")
    })
}

fn detect_protocol(cmd: &str) -> Option<String> {
    let caps = protocol_re().captures(cmd)?;
    for name in ["cdp", "lldp", "bgp", "ospf", "isis"] {
        if caps.name(name).is_some() {
            return Some(name.to_string());
        }
    }
    None
}

/// Read `(cmd, output)` for a block. `output` is BLOB in the schema; we
/// decode lossily because show-output is virtually always UTF-8 ANSI.
fn read_block(conn: &rusqlite::Connection, block_id: &str) -> anyhow::Result<(String, String)> {
    let row: (String, Vec<u8>) = conn.query_row(
        "SELECT cmd, output FROM command_blocks WHERE id = ?1",
        params![block_id],
        |r| Ok::<(String, Vec<u8>), rusqlite::Error>((r.get(0)?, r.get(1)?)),
    )?;
    let output = String::from_utf8_lossy(&row.1).into_owned();
    Ok((row.0, output))
}

/// Parse + ingest neighbors from the given completed block.
#[tauri::command]
pub async fn topology_ingest_from_block(
    state: State<'_, AppState>,
    block_id: String,
    vendor: String,
    platform: String,
    device_ref: String,
    device_kind: String,
) -> Result<IngestSummary, String> {
    // 1. Read the block's cmd + output (sync; release the lock before sidecar I/O).
    let (cmd, raw_output) = {
        let conn = state.db.lock();
        read_block(&conn, &block_id).map_err(|e| e.to_string())?
    };

    // 2. Detect cdp vs lldp from the command string.
    let protocol = detect_protocol(&cmd).ok_or_else(|| {
        format!(
            "topology_ingest_from_block: command does not match a supported topology trigger (cdp/lldp/bgp/ospf/isis): {cmd}"
        )
    })?;

    // 3. Call the sidecar to normalize the output.
    let records = state
        .parser_bridge
        .neighbors(&protocol, &vendor, &platform, &cmd, &raw_output)
        .await
        .map_err(|e| e.to_string())?;

    // 4. Persist into neighbor_cache + topology_{nodes,edges}.
    let summary = {
        let conn = state.db.lock();
        ingest::ingest_neighbors(
            &conn,
            &device_ref,
            &device_kind,
            &cmd,
            &raw_output,
            &records,
        )
        .map_err(|e| e.to_string())?
    };

    Ok(summary)
}

/// Manual topology ingestion from raw text (for Terminal mode SSH sessions).
///
/// This command allows users to manually trigger topology ingestion without
/// requiring a block ID. Useful for SSH sessions in Terminal mode where
/// automatic block-based ingestion doesn't work.
#[tauri::command]
pub async fn topology_ingest_from_text(
    state: State<'_, AppState>,
    command: String,
    output: String,
    vendor: String,
    platform: String,
    device_ref: String,
    device_kind: String,
) -> Result<IngestSummary, String> {
    // 1. Detect protocol from the command string.
    let protocol = detect_protocol(&command).ok_or_else(|| {
        format!(
            "topology_ingest_from_text: command does not match a supported topology trigger (cdp/lldp/bgp/ospf/isis): {command}"
        )
    })?;

    // 2. Call the sidecar to normalize the output.
    let records = state
        .parser_bridge
        .neighbors(&protocol, &vendor, &platform, &command, &output)
        .await
        .map_err(|e| e.to_string())?;

    // 3. Persist into neighbor_cache + topology_{nodes,edges}.
    let summary = {
        let conn = state.db.lock();
        ingest::ingest_neighbors(
            &conn,
            &device_ref,
            &device_kind,
            &command,
            &output,
            &records,
        )
        .map_err(|e| e.to_string())?
    };

    Ok(summary)
}

#[tauri::command]
pub fn topology_list_graphs(state: State<'_, AppState>) -> Result<Vec<TopologyGraph>, String> {
    let conn = state.db.lock();
    graph::list_graphs(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn topology_get_graph(
    state: State<'_, AppState>,
    graph_id: String,
) -> Result<GraphSnapshot, String> {
    let conn = state.db.lock();
    graph::snapshot(&conn, &graph_id).map_err(|e| e.to_string())
}

/// Authoritative offline preview; accepts content only, never a path or URL.
#[tauri::command]
pub fn topology_preview_import(content: String) -> Result<ImportPreview, String> {
    TopologyImporter::preview(&content).map_err(|e| format!("{e:#}"))
}

/// Reparse before atomically creating an independent named graph.
#[tauri::command]
pub fn topology_import_graph(
    state: State<'_, AppState>,
    content: String,
    name: String,
) -> Result<GraphSnapshot, String> {
    TopologyImporter::import(&state.db.lock(), &content, &name).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn topology_create_graph(
    state: State<'_, AppState>,
    name: String,
    description: Option<String>,
) -> Result<TopologyGraph, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let conn = state.db.lock();
    graph::create_graph(&conn, &id, &name, description.as_deref()).map_err(|e| e.to_string())?;
    graph::get_graph(&conn, &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "topology_create_graph: row vanished immediately after insert".to_string())
}

#[tauri::command]
pub fn topology_delete_graph(state: State<'_, AppState>, graph_id: String) -> Result<(), String> {
    let conn = state.db.lock();
    graph::delete_graph(&conn, &graph_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn topology_clear_graph(state: State<'_, AppState>, graph_id: String) -> Result<(), String> {
    let conn = state.db.lock();
    graph::clear_graph(&conn, &graph_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn topology_save_layout(
    state: State<'_, AppState>,
    graph_id: String,
    positions: Vec<NodePosition>,
) -> Result<(), String> {
    graph::save_layout(&state.db.lock(), &graph_id, &positions).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn topology_reset_layout(state: State<'_, AppState>, graph_id: String) -> Result<(), String> {
    graph::reset_layout(&state.db.lock(), &graph_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn topology_neighbor_cache_list(
    state: State<'_, AppState>,
) -> Result<Vec<NeighborCacheRow>, String> {
    let conn = state.db.lock();
    cache::list_recent(&conn, 256).map_err(|e| e.to_string())
}

/// Plan 13 Phase 3.2 — resolve a clicked topology neighbor to a saved
/// SSH connection or NETCONF device.
///
/// The frontend (`src/lib/topology.ts::openNeighbor`) invokes this with
/// `{ ref }` (the camelCase JS identifier `ref`). Because `ref` is a
/// reserved Rust keyword, we use the raw-identifier form `r#ref` here;
/// Tauri's serde layer maps the JSON field `ref` to it transparently.
///
/// SSH is the primary interactive path; when a host is saved in BOTH
/// tables we prefer SSH so click-to-SSH stays predictable. See
/// `topology::lookup::lookup_device_by_ref` for the underlying SQL.
#[tauri::command]
pub fn device_lookup_by_ref(
    state: State<'_, AppState>,
    r#ref: String,
) -> Result<Option<SavedDeviceLookup>, String> {
    let conn = state.db.lock();
    lookup::lookup_device_by_ref(&conn, &r#ref).map_err(|e| e.to_string())
}

/// Saved metadata snapshot, resolved before transport or parser awaits.
/// Only the existing fixture-backed Cisco IOS/IOS-XE manual commands are enabled.
pub struct DiscoveryDevice {
    pub source: TopologyNode,
}

impl DiscoveryDevice {
    pub fn load(
        conn: &rusqlite::Connection,
        graph_id: &str,
        connection_id: &str,
    ) -> Result<Self, String> {
        let unavailable = || "Unable to resolve topology graph or saved SSH connection".to_string();
        if graph::get_graph(conn, graph_id)
            .map_err(|_| unavailable())?
            .is_none()
        {
            return Err(unavailable());
        }
        let source = conn
            .query_row(
                "SELECT host, name, vendor, platform FROM ssh_connections WHERE id = ?1",
                [connection_id],
                |row| {
                    let host: String = row.get(0)?;
                    Ok(TopologyNode {
                        graph_id: graph_id.to_string(),
                        device_ref: host.clone(),
                        device_kind: "ssh".into(),
                        label: row.get(1)?,
                        vendor: Some(row.get(2)?),
                        platform: Some(row.get(3)?),
                        mgmt_ip: host.parse::<std::net::IpAddr>().ok().map(|_| host),
                    })
                },
            )
            .map_err(|_| unavailable())?;
        let ports: i64 = conn
            .query_row(
                "SELECT COUNT(DISTINCT COALESCE(port, 22)) FROM ssh_connections WHERE host = ?1",
                [&source.device_ref],
                |row| row.get(0),
            )
            .map_err(|_| unavailable())?;
        if ports > 1 {
            return Err("Saved host maps to multiple SSH ports; use an unambiguous saved host for topology collection".into());
        }
        Ok(Self { source })
    }

    pub fn supports_manual_collection(&self) -> bool {
        self.source
            .vendor
            .as_deref()
            .is_some_and(|v| v.eq_ignore_ascii_case("cisco"))
            && self
                .source
                .platform
                .as_deref()
                .is_some_and(|p| p.eq_ignore_ascii_case("ios") || p.eq_ignore_ascii_case("iosxe"))
    }
}

/// Manual saved-device collection into an explicit graph (Global by default).
/// No database lock is held across SSH/parser awaits; accepted captures commit independently.
#[tauri::command]
pub async fn topology_discover_device(
    state: State<'_, AppState>,
    connection_id: String,
    vendor: Option<String>,
    platform: Option<String>,
    password: Option<String>,
    graph_id: Option<String>,
) -> Result<DiscoverySummary, String> {
    // Legacy arguments remain accepted, but saved metadata is authoritative.
    let _ = (vendor, platform);
    let graph_id = graph_id.as_deref().unwrap_or(GLOBAL_GRAPH_ID);
    let device = DiscoveryDevice::load(&state.db.lock(), graph_id, &connection_id)?;
    let commands = [
        ("cdp", "show cdp neighbors detail"),
        ("lldp", "show lldp neighbors detail"),
    ];
    let attempts = {
        let conn = state.db.lock();
        let tx = conn
            .unchecked_transaction()
            .map_err(|_| "Could not record collection attempt")?;
        let mut attempts = std::collections::HashMap::new();
        for (_, command) in &commands {
            let token = crate::topology::evidence::CaptureEvidence::attempt(
                &tx,
                graph_id,
                &device.source.device_ref,
                command,
                if device.supports_manual_collection() {
                    "incomplete"
                } else {
                    "unsupported"
                },
            )
            .map_err(|_| "Could not record collection attempt")?;
            attempts.insert(*command, token);
        }
        tx.commit()
            .map_err(|_| "Could not record collection attempt")?;
        attempts
    };
    let record_outcome = |command: &str, status: &str| {
        crate::topology::evidence::CaptureEvidence::finish(
            &state.db.lock(),
            graph_id,
            &device.source.device_ref,
            command,
            &attempts[command],
            status,
        )
    };
    if !device.supports_manual_collection() {
        return Ok(DiscoverySummary::from_captures(
            commands
                .iter()
                .map(|(protocol, _)| CaptureOutcome {
                    protocol: (*protocol).into(),
                    status: CaptureStatus::Unsupported,
                    records: 0,
                    error: Some(
                        "Manual collection supports saved Cisco IOS/IOS-XE profiles only".into(),
                    ),
                })
                .collect(),
        ));
    }
    let (target, _) = crate::ssh_exec::resolve_target(&state.db, &connection_id, password)
        .map_err(|_| {
            let recorded = commands.iter().fold(true, |ok, (_, command)| {
                record_outcome(command, "failed").is_ok() && ok
            });
            if recorded {
                "Unable to resolve SSH credentials for topology collection"
            } else {
                "Unable to resolve SSH credentials; receipt outcome could not be recorded"
            }
            .to_string()
        })?;
    let mut captures = Vec::with_capacity(commands.len());
    for (protocol, cmd) in commands {
        let mut outcome = CaptureOutcome {
            protocol: protocol.into(),
            status: CaptureStatus::Failed,
            records: 0,
            error: None,
        };
        let raw_output =
            match crate::ssh_exec::run_command(&target, cmd, crate::ssh_exec::DEFAULT_CMD_TIMEOUT)
                .await
            {
                Ok(output) => output,
                Err(_) => {
                    outcome.error = Some(
                        if record_outcome(cmd, "failed").is_ok() {
                            "SSH command failed or timed out"
                        } else {
                            "SSH command failed; receipt outcome could not be recorded"
                        }
                        .into(),
                    );
                    captures.push(outcome);
                    continue;
                }
            };
        match state
            .parser_bridge
            .neighbor_capture(
                protocol,
                device.source.vendor.as_deref().unwrap_or(""),
                device.source.platform.as_deref().unwrap_or(""),
                cmd,
                &raw_output,
            )
            .await
        {
            Ok(capture) if capture.status == CaptureStatus::Unsupported => {
                outcome.status = CaptureStatus::Unsupported;
                outcome.error =
                    Some("No supported neighbor parser for this saved profile and command".into());
            }
            Ok(capture) if capture.status != CaptureStatus::Completed => {
                outcome.error = Some("Parser did not complete neighbor capture".into());
            }
            Ok(capture) => {
                match ingest::ingest_owned_capture(
                    &state.db.lock(),
                    &device.source,
                    cmd,
                    &raw_output,
                    &capture.records,
                    &attempts[cmd],
                ) {
                    Ok(summary) => {
                        outcome.status = CaptureStatus::Completed;
                        outcome.records = summary.nodes_added;
                    }
                    Err(_) => outcome.error = Some("Failed to persist neighbor capture".into()),
                }
            }
            Err(_) => outcome.error = Some("Failed to parse neighbor command output".into()),
        }
        if outcome.status != CaptureStatus::Completed {
            let status = if outcome.status == CaptureStatus::Unsupported {
                "unsupported"
            } else {
                "failed"
            };
            if record_outcome(cmd, status).is_err() {
                outcome.status = CaptureStatus::Failed;
                outcome.error =
                    Some("Capture did not complete; receipt outcome could not be recorded".into());
            }
        }
        captures.push(outcome);
    }
    Ok(DiscoverySummary::from_captures(captures))
}
