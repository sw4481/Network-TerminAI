//! Tauri commands for the structured show-output layer (Plan 05).
//!
//! Frontend integration:
//!   - When a `show *` block completes, the frontend calls
//!     `structured_auto_parse(blockId, vendor, platform)`. The Rust side
//!     looks up the block's raw output, calls the sidecar parser, and
//!     persists the result into `parsed_outputs` (idempotent on block_id).
//!   - `structured_get(blockId)` returns the parsed payload as a typed DTO.

use serde::Serialize;
use tauri::State;

use super::AppState;
use crate::structured::auto_parse;
use crate::structured::diff::{diff_snapshots, CellDiff};
use crate::structured::snapshot;

#[derive(Debug, Serialize)]
pub struct StructuredDto {
    #[serde(rename = "blockId")]
    pub block_id: String,
    pub parser: String,
    pub command: String,
    pub vendor: String,
    pub platform: String,
    pub data: serde_json::Value,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

/// Frontend invokes this when a `show *` block completes.
/// Vendor/platform are sourced from in-memory tab state on the TS side.
#[tauri::command]
pub async fn structured_auto_parse(
    state: State<'_, AppState>,
    block_id: String,
    vendor: String,
    platform: String,
) -> Result<(), String> {
    let parser = state.parser_bridge.clone();
    let db = state.db.clone();
    auto_parse::on_block_completed(db, &parser, &block_id, &vendor, &platform)
        .await
        .map_err(|e| e.to_string())
}

/// SSH-direct structured parse (Plan 05 over interactive SSH).
///
/// Block-completion only fires in Blocks mode, so a `show` command typed into
/// an interactive SSH session never gets auto-parsed. This command SSHes to a
/// saved connection, runs the command, and parses the full output directly —
/// mirroring `topology_discover_device`. Returns the synthetic block id whose
/// parsed output the Structured tab can then load via `structured_get`.
#[tauri::command]
pub async fn structured_run_and_parse(
    state: State<'_, AppState>,
    tab_id: String,
    connection_id: String,
    command: String,
    vendor: String,
    platform: String,
    password: Option<String>,
) -> Result<String, String> {
    use crate::ssh_exec;

    let (target, _name) = ssh_exec::resolve_target(&state.db, &connection_id, password)?;
    let raw = ssh_exec::run_command(&target, &command, ssh_exec::DEFAULT_CMD_TIMEOUT)
        .await
        .map_err(|e| e.to_string())?;

    let parser = state.parser_bridge.clone();
    auto_parse::parse_and_store_adhoc(
        state.db.clone(),
        &parser,
        &tab_id,
        &command,
        &raw,
        &vendor,
        &platform,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn structured_get(
    state: State<'_, AppState>,
    block_id: String,
) -> Result<Option<StructuredDto>, String> {
    let conn = state.db.lock();
    match auto_parse::get_parsed_output(&conn, &block_id).map_err(|e| e.to_string())? {
        None => Ok(None),
        Some(r) => {
            let data: serde_json::Value =
                serde_json::from_str(&r.data_json).map_err(|e| e.to_string())?;
            Ok(Some(StructuredDto {
                block_id: r.block_id,
                parser: r.parser,
                command: r.command,
                vendor: r.vendor,
                platform: r.platform,
                data,
                created_at: r.created_at,
            }))
        }
    }
}

#[derive(Debug, Serialize)]
pub struct SnapshotDto {
    pub id: i64,
    #[serde(rename = "tabId")]
    pub tab_id: String,
    pub name: String,
    #[serde(rename = "parsedOutputId")]
    pub parsed_output_id: i64,
    #[serde(rename = "capturedAt")]
    pub captured_at: i64,
    pub command: String,
    pub parser: String,
    pub vendor: String,
    pub platform: String,
}

#[tauri::command]
pub fn structured_snapshot_create(
    state: State<'_, AppState>,
    block_id: String,
    name: String,
) -> Result<i64, String> {
    let conn = state.db.lock();
    snapshot::create(&conn, &block_id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn structured_list_snapshots(
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Vec<SnapshotDto>, String> {
    let conn = state.db.lock();
    let rows = snapshot::list_for_tab(&conn, &tab_id).map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| SnapshotDto {
            id: r.id,
            tab_id: r.tab_id,
            name: r.name,
            parsed_output_id: r.parsed_output_id,
            captured_at: r.captured_at,
            command: r.command,
            parser: r.parser,
            vendor: r.vendor,
            platform: r.platform,
        })
        .collect())
}

#[tauri::command]
pub fn structured_snapshot_rename(
    state: State<'_, AppState>,
    id: i64,
    name: String,
) -> Result<(), String> {
    let conn = state.db.lock();
    snapshot::rename(&conn, id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn structured_snapshot_delete(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock();
    snapshot::delete(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn structured_snapshot_diff(
    state: State<'_, AppState>,
    a: i64,
    b: i64,
) -> Result<Vec<CellDiff>, String> {
    let db = state.db.clone();
    diff_snapshots(a, b, db).map_err(|e| e.to_string())
}
