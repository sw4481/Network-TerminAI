//! Phase 3E — get_pane_metadata command. Resolves the focused pane's shell pid
//! (via the ptys map, keyed by terminal_id), then delegates to
//! metadata::get_metadata. SSH context comes solely from the foreground-process
//! fallback (`via process`); the former session-chain read path was removed
//! when chaining was retired in favor of Fan-Out.

use crate::commands::AppState;
use crate::metadata::{self, PaneMetadata};
use tauri::State;

#[tauri::command]
pub async fn get_pane_metadata(
    state: State<'_, AppState>,
    terminal_id: String,
    cwd: String,
    _tab_id: String,
) -> Result<PaneMetadata, String> {
    // Resolve the pane's shell pid from the ptys map (keyed by terminal_id).
    let pid = {
        let ptys = state.ptys.lock();
        match ptys.get(&terminal_id) {
            Some(h) => h.pid(),
            None => {
                // Unknown terminal_id is the one genuine error case.
                return Err(format!("Unknown terminal_id '{}'", terminal_id));
            }
        }
    };

    // gather_ports + gather_ssh_from_process shell out (blocking) — run the
    // whole assembly off the async runtime's core threads. SSH context is
    // resolved purely from the foreground process (no chain binding anymore).
    let now = chrono::Utc::now().timestamp();
    let meta = tokio::task::spawn_blocking(move || metadata::get_metadata(&cwd, pid, None, now))
        .await
        .map_err(|e| format!("metadata join error: {}", e))?;

    Ok(meta)
}
