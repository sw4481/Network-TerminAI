//! Per-tab recording supervisor.
//!
//! Holds at most one active recording per tab. Each active recording owns
//! a tokio task that pulls `RawOutput` chunks from the PTY tap, runs them
//! through the `Redactor`, and writes asciinema events to the underlying
//! `CastWriter`.

use crate::pty::RawOutput;
use crate::recording::asciinema::{CastSummary, CastWriter};
use crate::recording::redactor::{PatternMatchSummary, Redactor};
use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
pub struct RecordingDto {
    pub id: String,
    #[serde(rename = "tabId")]
    pub tab_id: String,
    #[serde(rename = "startedAt")]
    pub started_at: i64,
    #[serde(rename = "endedAt")]
    pub ended_at: Option<i64>,
    pub path: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: i64,
    #[serde(rename = "durationMs")]
    pub duration_ms: i64,
    #[serde(rename = "sessionKind")]
    pub session_kind: String,
}

struct ActiveRecording {
    id: String,
    tab_id: String,
    started_at: i64,
    started_instant: Instant,
    path: PathBuf,
    session_kind: String,
    /// Sender used to push raw bytes into the writer task. Cloned out and
    /// handed to the PTY tap.
    tap_tx: mpsc::Sender<RawOutput>,
    /// Used to send a Stop signal to the writer task.
    stop_tx: tokio::sync::oneshot::Sender<()>,
    /// Handle to await on stop for the final summary + audit.
    join: tokio::task::JoinHandle<RecordingFinalState>,
}

#[derive(Debug)]
struct RecordingFinalState {
    cast: Option<CastSummary>,
    audit: Vec<PatternMatchSummary>,
}

pub struct RecordingSupervisor {
    db: Arc<Mutex<Connection>>,
    active: Mutex<HashMap<String, ActiveRecording>>,
    base_dir: Mutex<Option<PathBuf>>,
}

impl RecordingSupervisor {
    pub fn new(db: Arc<Mutex<Connection>>) -> Self {
        Self {
            db,
            active: Mutex::new(HashMap::new()),
            base_dir: Mutex::new(None),
        }
    }

    /// Override the recording directory (tests use a TempDir). Production
    /// resolves this from the Tauri app data dir on first start.
    pub fn set_base_dir(&self, dir: PathBuf) {
        *self.base_dir.lock() = Some(dir);
    }

    fn resolve_base_dir(&self) -> Result<PathBuf> {
        if let Some(dir) = self.base_dir.lock().clone() {
            return Ok(dir);
        }
        let dir = dirs::data_local_dir()
            .or_else(dirs::config_dir)
            .ok_or_else(|| anyhow!("no app data dir"))?
            .join("ccie-terminal")
            .join("recordings");
        std::fs::create_dir_all(&dir).context("create recording dir")?;
        Ok(dir)
    }

    pub fn is_active(&self, tab_id: &str) -> bool {
        self.active.lock().contains_key(tab_id)
    }

    pub fn active_recording(&self, tab_id: &str) -> Option<RecordingDto> {
        let g = self.active.lock();
        g.get(tab_id).map(|r| RecordingDto {
            id: r.id.clone(),
            tab_id: r.tab_id.clone(),
            started_at: r.started_at,
            ended_at: None,
            path: r.path.to_string_lossy().to_string(),
            size_bytes: 0,
            duration_ms: 0,
            session_kind: r.session_kind.clone(),
        })
    }

    /// Start a recording for `tab_id`. Returns the new recording's DTO and
    /// a sender that the caller wires into the PTY's tap slot.
    pub fn start(
        &self,
        tab_id: &str,
        session_kind: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(RecordingDto, mpsc::Sender<RawOutput>)> {
        if self.active.lock().contains_key(tab_id) {
            return Err(anyhow!("recording already active for tab {tab_id}"));
        }
        let id = Uuid::new_v4().simple().to_string();
        let dir = self.resolve_base_dir()?;
        let path = dir.join(format!("{id}.cast"));
        let writer = CastWriter::create(&path, cols, rows, "xterm-256color", "/bin/zsh")
            .context("create cast writer")?;

        // The writer runs on a spawned Tokio task, so a runtime must be
        // present. Verify it up front (before touching the DB) so that being
        // called from a synchronous context returns a clean error instead of
        // `tokio::spawn` panicking and aborting the whole process.
        let rt = tokio::runtime::Handle::try_current().map_err(|_| {
            anyhow!("recording must be started from within a Tokio runtime")
        })?;

        let started_at = chrono::Utc::now().timestamp();

        // Insert pending row.
        {
            let conn = self.db.lock();
            conn.execute(
                "INSERT INTO session_recordings (id, tab_id, started_at, path, session_kind)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, tab_id, started_at, path.to_string_lossy(), session_kind],
            )?;
        }

        let (tap_tx, mut tap_rx) = mpsc::channel::<RawOutput>(1024);
        let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();

        let started_instant = Instant::now();
        let join = rt.spawn(async move {
            let mut writer = writer;
            let mut redactor = match Redactor::new(&[]) {
                Ok(r) => r,
                Err(e) => {
                    tracing::error!(error=%e, "recording: redactor build failed");
                    return RecordingFinalState {
                        cast: None,
                        audit: Vec::new(),
                    };
                }
            };
            loop {
                tokio::select! {
                    _ = &mut stop_rx => break,
                    msg = tap_rx.recv() => {
                        match msg {
                            Some(raw) => {
                                let elapsed = raw.recv_at.duration_since(started_instant).as_secs_f64();
                                let redacted = redactor.feed(&raw.bytes);
                                if let Err(e) = writer.write_output(elapsed, &redacted) {
                                    tracing::warn!(error=%e, "recording: cast write failed");
                                }
                            }
                            None => break,
                        }
                    }
                }
            }
            let audit = redactor.drain_audit();
            let cast = match writer.finalize() {
                Ok(s) => Some(s),
                Err(e) => {
                    tracing::warn!(error=%e, "recording: finalize failed");
                    None
                }
            };
            RecordingFinalState { cast, audit }
        });

        let dto = RecordingDto {
            id: id.clone(),
            tab_id: tab_id.to_string(),
            started_at,
            ended_at: None,
            path: path.to_string_lossy().to_string(),
            size_bytes: 0,
            duration_ms: 0,
            session_kind: session_kind.to_string(),
        };

        self.active.lock().insert(
            tab_id.to_string(),
            ActiveRecording {
                id: id.clone(),
                tab_id: tab_id.to_string(),
                started_at,
                started_instant,
                path: path.clone(),
                session_kind: session_kind.to_string(),
                tap_tx: tap_tx.clone(),
                stop_tx,
                join,
            },
        );
        Ok((dto, tap_tx))
    }

    /// Stop a recording. Awaits the writer task, persists size/duration
    /// and per-pattern audit counts, returns the final DTO.
    pub async fn stop(&self, tab_id: &str) -> Result<RecordingDto> {
        let active = self
            .active
            .lock()
            .remove(tab_id)
            .ok_or_else(|| anyhow!("no active recording for tab {tab_id}"))?;
        let _ = active.stop_tx.send(());
        let final_state = active.join.await.context("await recording task")?;
        let ended_at = chrono::Utc::now().timestamp();
        let (size_bytes, duration_ms) = match &final_state.cast {
            Some(c) => (c.size_bytes as i64, c.duration_ms as i64),
            None => (0, 0),
        };
        {
            let conn = self.db.lock();
            conn.execute(
                "UPDATE session_recordings
                 SET ended_at = ?1, size_bytes = ?2, duration_ms = ?3
                 WHERE id = ?4",
                params![ended_at, size_bytes, duration_ms, active.id],
            )?;
            for entry in &final_state.audit {
                conn.execute(
                    "INSERT OR REPLACE INTO recording_redactions
                       (recording_id, pattern, replacement_hash, matches)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![
                        active.id,
                        entry.pattern_id,
                        entry.replacement_hash,
                        entry.matches as i64,
                    ],
                )?;
            }
        }
        let _ = active.started_instant; // suppress unused
        let _ = active.tap_tx; // dropped here
        Ok(RecordingDto {
            id: active.id,
            tab_id: active.tab_id,
            started_at: active.started_at,
            ended_at: Some(ended_at),
            path: active.path.to_string_lossy().to_string(),
            size_bytes,
            duration_ms,
            session_kind: active.session_kind,
        })
    }

    /// Reconcile recordings left `ended_at IS NULL` by a previous run that
    /// exited mid-recording (the in-memory writer task is gone, so they can
    /// never be stopped normally and would show "LIVE" forever). Marks each
    /// ended now, backfilling `size_bytes` from the actual `.cast` on disk.
    /// Returns the number of rows reconciled. Call once at startup.
    pub fn cleanup_orphan_recordings(&self) -> Result<usize> {
        let conn = self.db.lock();
        let orphans: Vec<(String, String)> = {
            let mut stmt = conn.prepare(
                "SELECT id, path FROM session_recordings WHERE ended_at IS NULL",
            )?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let now = chrono::Utc::now().timestamp();
        for (id, path) in &orphans {
            let size = std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0);
            conn.execute(
                "UPDATE session_recordings SET ended_at = ?1, size_bytes = ?2 WHERE id = ?3",
                params![now, size, id],
            )?;
        }
        Ok(orphans.len())
    }

    pub fn list(&self, limit: u32) -> Result<Vec<RecordingDto>> {
        let conn = self.db.lock();
        let mut stmt = conn.prepare(
            "SELECT id, tab_id, started_at, ended_at, path, size_bytes,
                    duration_ms, session_kind
             FROM session_recordings ORDER BY started_at DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![limit], |r| {
                Ok(RecordingDto {
                    id: r.get(0)?,
                    tab_id: r.get(1)?,
                    started_at: r.get(2)?,
                    ended_at: r.get(3)?,
                    path: r.get(4)?,
                    size_bytes: r.get(5)?,
                    duration_ms: r.get(6)?,
                    session_kind: r.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get(&self, recording_id: &str) -> Result<Option<RecordingDto>> {
        let conn = self.db.lock();
        let row = conn
            .query_row(
                "SELECT id, tab_id, started_at, ended_at, path, size_bytes,
                        duration_ms, session_kind
                 FROM session_recordings WHERE id = ?1",
                params![recording_id],
                |r| {
                    Ok(RecordingDto {
                        id: r.get(0)?,
                        tab_id: r.get(1)?,
                        started_at: r.get(2)?,
                        ended_at: r.get(3)?,
                        path: r.get(4)?,
                        size_bytes: r.get(5)?,
                        duration_ms: r.get(6)?,
                        session_kind: r.get(7)?,
                    })
                },
            )
            .ok();
        Ok(row)
    }

    pub fn delete(&self, recording_id: &str) -> Result<()> {
        let path: Option<String> = {
            let conn = self.db.lock();
            conn.query_row(
                "SELECT path FROM session_recordings WHERE id = ?1",
                params![recording_id],
                |r| r.get(0),
            )
            .ok()
        };
        if let Some(p) = path {
            let _ = std::fs::remove_file(&p);
        }
        let conn = self.db.lock();
        conn.execute(
            "DELETE FROM session_recordings WHERE id = ?1",
            params![recording_id],
        )?;
        Ok(())
    }

    pub fn redaction_summary(
        &self,
        recording_id: &str,
    ) -> Result<Vec<(String, String, i64)>> {
        let conn = self.db.lock();
        let mut stmt = conn.prepare(
            "SELECT pattern, replacement_hash, matches FROM recording_redactions
             WHERE recording_id = ?1 ORDER BY matches DESC, pattern ASC",
        )?;
        let rows = stmt
            .query_map(params![recording_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}
