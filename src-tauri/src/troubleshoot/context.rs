//! Plan 15 Phase 2 — runtime types for the troubleshoot engine.
//!
//! Mirrors the Plan 03 `cell_run` engine's structural pattern:
//!
//!   * [`RunStatus`]   — high-level lifecycle of a run.
//!   * [`StepStatus`]  — per-step status as written into `troubleshoot_steps`.
//!   * [`StepResult`]  — pure value emitted by each step's transition,
//!                       persisted by the engine's `record` callback.
//!   * [`RunContext`]  — mutable state threaded through every step
//!                       (vars + last-parsed JSON + the run's status).
//!
//! `RunContext` deliberately is NOT `Serialize` — it holds runtime state
//! the database doesn't need. The other three types ARE `Serialize` so
//! the Tauri command layer can emit them as events without a manual
//! shim.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Lifecycle of a single playbook run.
///
/// Maps 1:1 to the `troubleshoot_runs.status` CHECK constraint
/// (`'running'|'paused'|'completed'|'failed'`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Running,
    Paused,
    Completed,
    Failed,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RunStatus::Running => "running",
            RunStatus::Paused => "paused",
            RunStatus::Completed => "completed",
            RunStatus::Failed => "failed",
        }
    }
}

/// Per-step status. Maps to the `troubleshoot_steps.status` CHECK
/// constraint.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Pending,
    Running,
    Passed,
    Failed,
    Skipped,
    AwaitingUser,
}

impl StepStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            StepStatus::Pending => "pending",
            StepStatus::Running => "running",
            StepStatus::Passed => "passed",
            StepStatus::Failed => "failed",
            StepStatus::Skipped => "skipped",
            StepStatus::AwaitingUser => "awaiting_user",
        }
    }
}

/// Pure result emitted by a single step transition.
///
/// `idx` is the linear execution order in `troubleshoot_steps`.
/// `step_id` mirrors the YAML step id so the UI can correlate the
/// engine event back to a node on the tree canvas.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepResult {
    pub step_id: String,
    pub idx: i64,
    pub status: StepStatus,
    pub result_json: serde_json::Value,
    pub next_step_id: Option<String>,
}

/// Mutable state threaded through every step.
///
/// `vars` carries operator-supplied variables (e.g. `{"neighbor":
/// "10.0.0.5"}`); the engine substitutes `{{var}}` references in
/// `command:` strings then **re-classifies** the substituted command
/// (defeats injection — see `LiveStepExecutor::run_command`).
///
/// `last_parsed` is the JSON returned by the most recent
/// `command` step. `branch` steps evaluate JMESPath against this
/// value.
#[derive(Debug, Clone)]
pub struct RunContext {
    pub run_id: String,
    pub tab_id: String,
    pub vars: HashMap<String, serde_json::Value>,
    pub last_parsed: Option<serde_json::Value>,
    pub status: RunStatus,
}

impl RunContext {
    /// Construct a fresh context. Status starts at `Running`; the engine
    /// transitions it to `Paused`/`Completed`/`Failed` as the run
    /// progresses.
    pub fn new(
        run_id: impl Into<String>,
        tab_id: impl Into<String>,
        vars: HashMap<String, serde_json::Value>,
    ) -> Self {
        Self {
            run_id: run_id.into(),
            tab_id: tab_id.into(),
            vars,
            last_parsed: None,
            status: RunStatus::Running,
        }
    }
}
