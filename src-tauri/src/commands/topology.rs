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
    cache, graph, ingest, lookup, GraphSnapshot, IngestSummary, NeighborCacheRow,
    SavedDeviceLookup, TopologyGraph,
};

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
    let g = graph::get_graph(&conn, &graph_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("topology graph not found: {graph_id}"))?;
    let nodes = graph::list_nodes(&conn, &graph_id).map_err(|e| e.to_string())?;
    let edges = graph::list_edges(&conn, &graph_id).map_err(|e| e.to_string())?;
    Ok(GraphSnapshot {
        graph: g,
        nodes,
        edges,
    })
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

/// Automated topology discovery: SSH to a device and run neighbor discovery commands.
///
/// This command:
/// 1. Looks up the saved SSH connection by ID
/// 2. Connects via SSH using russh
/// 3. Runs 'show cdp neighbors detail' and 'show lldp neighbors detail'
/// 4. Calls topology_ingest_from_text for each command
/// 5. Returns summary of neighbors discovered
#[tauri::command]
pub async fn topology_discover_device(
    state: State<'_, AppState>,
    connection_id: String,
    vendor: String,
    platform: String,
    password: Option<String>,
) -> Result<IngestSummary, String> {
    // 1. Resolve the saved SSH connection into a target (decrypts/overrides
    //    password). Shared with the other SSH-direct features.
    let (target, device_name) =
        crate::ssh_exec::resolve_target(&state.db, &connection_id, password)?;

    // 2. Run discovery commands via the shared sshpass-backed executor.
    //    russh has limited algorithm support; the system ssh client works
    //    with more devices.
    let commands = [
        ("cdp", "show cdp neighbors detail"),
        ("lldp", "show lldp neighbors detail"),
    ];

    let mut total_nodes = 0;
    let mut total_edges = 0;

    for (protocol, cmd) in commands {
        let raw_output =
            match crate::ssh_exec::run_command(&target, cmd, crate::ssh_exec::DEFAULT_CMD_TIMEOUT)
                .await
            {
                Ok(out) => out,
                Err(e) => {
                    eprintln!("{} command failed: {}", protocol.to_uppercase(), e);
                    continue; // Try next protocol even if this one fails
                }
            };

        // Parse and ingest this protocol
        match state
            .parser_bridge
            .neighbors(protocol, &vendor, &platform, cmd, &raw_output)
            .await
        {
            Ok(records) => {
                let conn = state.db.lock();
                match ingest::ingest_neighbors(
                    &conn,
                    &device_name,
                    "ssh",
                    cmd,
                    &raw_output,
                    &records,
                ) {
                    Ok(summary) => {
                        total_nodes += summary.nodes_added;
                        total_edges += summary.edges_added;
                    }
                    Err(e) => eprintln!("{} ingest failed: {}", protocol.to_uppercase(), e),
                }
            }
            Err(e) => eprintln!("{} parse failed: {}", protocol.to_uppercase(), e),
        }
    }

    Ok(IngestSummary {
        nodes_added: total_nodes,
        edges_added: total_edges,
        cache_updated: true,
    })
}
