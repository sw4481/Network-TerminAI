//! Shared executor for "send a command to a PTY-backed tab and capture the
//! output up through the next OSC-133 CommandEnd (or quiet-period fallback)."
//!
//! Used by:
//! - `notebooks::runner` for runnable MOPs (Plan 03).
//! - `change_verify::transport_live` for pre/post-change snapshots (Plan 06).
//!
//! Future consumers (multi-device fan-out, AI troubleshooting trees) should
//! reuse this rather than re-implementing PTY write + scrollback capture.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex;
use rusqlite::Connection;

use crate::notebooks::runner::{PtyExecutor, PtyRunResult};

/// PTY executor that drives the live AppState PtyHandle and waits for the
/// next OSC-133 CommandEnd via `block_end_waiters`. Falls back to a fixed
/// quiet window when no shell-integration end-marker fires.
pub struct AppStatePtyExecutor {
    pub state_db: Arc<Mutex<Connection>>,
    pub ptys: Arc<Mutex<HashMap<String, crate::pty::PtyHandle>>>,
    pub terminal_agent: Arc<crate::terminal_agent::TerminalAgentManager>,
    pub waiters:
        Arc<Mutex<HashMap<String, Vec<tokio::sync::oneshot::Sender<(String, Option<i32>)>>>>>,
}

#[async_trait]
impl PtyExecutor for AppStatePtyExecutor {
    async fn run_command(
        &self,
        tab_id: &str,
        command: &str,
        _block_id: &str,
    ) -> anyhow::Result<PtyRunResult> {
        self.terminal_agent
            .revoke_for_pty(tab_id, "user takeover");
        let scrollback_start = {
            let db = self.state_db.lock();
            crate::session::read_scrollback(&db, tab_id)
                .map(|v| v.len())
                .unwrap_or(0)
        };

        let (tx, rx) = tokio::sync::oneshot::channel::<(String, Option<i32>)>();
        self.waiters
            .lock()
            .entry(tab_id.to_string())
            .or_default()
            .push(tx);

        self.terminal_agent
            .cancel_saved_ssh_launch_and_write(tab_id, || {
                let ptys = self.ptys.lock();
                let h = ptys
                    .get(tab_id)
                    .ok_or_else(|| anyhow::anyhow!("no PTY for tab {tab_id}"))?;
                let mut bytes = command.as_bytes().to_vec();
                bytes.push(b'\r');
                h.write(&bytes)
                    .map_err(|e| anyhow::anyhow!("pty write: {e}"))
            })?;

        let start = std::time::Instant::now();
        let timeout = std::time::Duration::from_secs(120);
        let result = tokio::time::timeout(timeout, rx).await;
        let exit_code = match result {
            Ok(Ok((_block_id, code))) => code,
            Ok(Err(_)) => None, // sender dropped
            Err(_) => None,     // timed out — best-effort: report what we have
        };

        let scrollback_end = {
            let db = self.state_db.lock();
            crate::session::read_scrollback(&db, tab_id).unwrap_or_default()
        };
        let output = if scrollback_end.len() > scrollback_start {
            String::from_utf8_lossy(&scrollback_end[scrollback_start..]).into_owned()
        } else {
            String::new()
        };

        Ok(PtyRunResult {
            output,
            exit_code,
            duration_ms: start.elapsed().as_millis() as u64,
        })
    }
}
