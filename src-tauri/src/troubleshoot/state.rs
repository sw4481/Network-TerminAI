//! Plan 15 Phase 2 — in-flight run registry.
//!
//! Tracks the runtime handles for `troubleshoot_runs` rows whose
//! status is `running` or `paused`. Phase 2.3's `start_run`,
//! `pause_run`, `resume_run`, `cancel_run`, and `answer_prompt`
//! all manipulate this registry. The `Arc<TroubleshootState>`
//! lives on `AppState` so the Tauri command layer can access it
//! without re-locking the DB mutex.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::oneshot;

/// One entry per active run. Senders are consumed by their
/// matching command:
///
/// * `pause_tx`        — set by the engine driver; signalled by
///                       `pause_run` to interrupt at the next
///                       checkpoint (currently a no-op since the
///                       Phase 2 engine is synchronous-by-step).
/// * `cancel_flag`     — atomic bool toggled by `cancel_run`; the
///                       engine driver checks it after each step
///                       and exits with `RunStatus::Failed`.
/// * `prompt_tx`       — when a `user_prompt` step pauses, the
///                       driver stashes a oneshot sender here so
///                       `answer_prompt` can wake it.
/// * `task`            — the spawned tokio JoinHandle so
///                       `cancel_run` can `abort()` if needed.
pub struct RunHandle {
    pub run_id: String,
    pub cancel_flag: Arc<std::sync::atomic::AtomicBool>,
    pub prompt_tx: Mutex<Option<oneshot::Sender<Option<String>>>>,
    pub task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl RunHandle {
    pub fn new(run_id: String) -> Self {
        Self {
            run_id,
            cancel_flag: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            prompt_tx: Mutex::new(None),
            task: Mutex::new(None),
        }
    }
}

#[derive(Default)]
pub struct TroubleshootState {
    runs: Mutex<HashMap<String, Arc<RunHandle>>>,
}

impl TroubleshootState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert a fresh handle for a starting run.
    pub fn register(&self, run_id: &str) -> Arc<RunHandle> {
        let h = Arc::new(RunHandle::new(run_id.to_string()));
        self.runs.lock().insert(run_id.to_string(), h.clone());
        h
    }

    pub fn get(&self, run_id: &str) -> Option<Arc<RunHandle>> {
        self.runs.lock().get(run_id).cloned()
    }

    pub fn remove(&self, run_id: &str) {
        self.runs.lock().remove(run_id);
    }

    /// Stash a oneshot sender that `answer_prompt` will use to
    /// resume a paused user_prompt step.
    pub fn install_prompt_tx(
        &self,
        run_id: &str,
        tx: oneshot::Sender<Option<String>>,
    ) -> bool {
        if let Some(h) = self.get(run_id) {
            *h.prompt_tx.lock() = Some(tx);
            true
        } else {
            false
        }
    }

    /// Take the prompt sender out (used when answering or
    /// cancelling).
    pub fn take_prompt_tx(&self, run_id: &str) -> Option<oneshot::Sender<Option<String>>> {
        self.get(run_id).and_then(|h| h.prompt_tx.lock().take())
    }
}
