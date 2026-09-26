//! Plan 00 / Phase 3 / Task 3.3 — sidecar heartbeat consumer + status command.

use std::sync::mpsc::{self, SyncSender};
use std::sync::Arc;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

use crate::bridge::HeartbeatPayload;
use crate::commands::AppState;

/// What the frontend status-footer chip reads.
#[derive(Debug, Clone, Serialize)]
pub struct SidecarStatus {
    pub running: bool,
    pub last_seen: Option<i64>,
    pub version: Option<String>,
    pub pid: Option<i64>,
    /// Unix timestamp (seconds) when the status was computed. Frontend uses
    /// this alongside `last_seen` to gauge liveness without depending on
    /// the client clock being synced to the server.
    pub now: i64,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Persist a single heartbeat into the `sidecar_status` row (id=1).
///
/// Runs on the worker thread (see `spawn_heartbeat_worker`), not on the
/// supervisor's reader thread, so a contended DB lock can't stall NDJSON
/// demux.
pub fn record_heartbeat(db: &Arc<Mutex<Connection>>, hb: &HeartbeatPayload) {
    let conn = db.lock();
    let res = conn.execute(
        "UPDATE sidecar_status
            SET last_seen = ?1, version = ?2, pid = ?3
          WHERE id = 1",
        params![now_secs(), hb.version, hb.pid],
    );
    if let Err(e) = res {
        tracing::warn!(error = %e, "sidecar_status update failed");
    }
}

/// Start a background thread that drains heartbeat events from the returned
/// channel and writes them to `sidecar_status`. The channel is bounded
/// (capacity 16) so a stalled DB can only drop messages, never back up the
/// reader thread. Called once from `AppState::new`.
pub fn spawn_heartbeat_worker(db: Arc<Mutex<Connection>>) -> SyncSender<HeartbeatPayload> {
    let (tx, rx) = mpsc::sync_channel::<HeartbeatPayload>(16);
    thread::Builder::new()
        .name("ccie-heartbeat-worker".into())
        .spawn(move || {
            while let Ok(hb) = rx.recv() {
                record_heartbeat(&db, &hb);
            }
        })
        .expect("spawn heartbeat worker thread");
    tx
}

#[tauri::command]
pub fn get_sidecar_status(state: State<'_, AppState>) -> Result<SidecarStatus, String> {
    let conn = state.db.lock();
    let row = conn
        .query_row(
            "SELECT last_seen, version, pid FROM sidecar_status WHERE id = 1",
            [],
            |r| {
                let last_seen: Option<i64> = r.get(0)?;
                let version: Option<String> = r.get(1)?;
                let pid: Option<i64> = r.get(2)?;
                Ok((last_seen, version, pid))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or((None, None, None));

    let now = now_secs();
    // Consider the sidecar "running" if we got a heartbeat in the last 120s.
    // That's 4× the 30s heartbeat cadence — one missed beat plus ~30s of
    // scheduler / GC jitter. Earlier iterations used 90s but the budget was
    // tight enough that a single long GC pause could flip the chip to "down"
    // on a healthy process.
    let running = row.0.map(|last| now - last <= 120).unwrap_or(false);

    Ok(SidecarStatus {
        running,
        last_seen: row.0,
        version: row.1,
        pid: row.2,
        now,
    })
}
