//! Notebook execution engine — sequential runner with control channel.
//!
//! The runner is plumbed through two traits so it can be unit-tested without
//! spawning real PTYs or the Python sidecar:
//!
//! * [`PtyExecutor`] — write a command to a tab's PTY and await its
//!   `CommandComplete`. Concrete impl: `MockPtyExecutor` (tests) — the
//!   production runner uses an `EchoPtyExecutor` for the `vendor=generic`
//!   smoke path; integration with the real PTY event bus lands when
//!   PtyHandle gains `run_and_await`.
//! * [`AssertionEvaluator`] — evaluate an `AssertionSpec` against the result
//!   of running its `command`. Concrete impl: [`DefaultAssertionEvaluator`]
//!   which calls `parse_show` (Plan 00) and applies the JSONPath predicate.
//!
//! Resume-from-failure works by re-running with a non-zero `start_at_idx`;
//! the run row is mutated rather than a new run created so the audit trail
//! reflects "this run ultimately succeeded after retry from cell N".

use anyhow::Result;
use async_trait::async_trait;
use parking_lot::Mutex;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;

use super::model::*;
use super::substitution::substitute;

// -------- status / event types --------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RunStatus::Running => "running",
            RunStatus::Paused => "paused",
            RunStatus::Completed => "completed",
            RunStatus::Failed => "failed",
            RunStatus::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CellStatus {
    Pending,
    Running,
    Passed,
    Failed,
    Skipped,
    AwaitingApproval,
}

impl CellStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            CellStatus::Pending => "pending",
            CellStatus::Running => "running",
            CellStatus::Passed => "passed",
            CellStatus::Failed => "failed",
            CellStatus::Skipped => "skipped",
            CellStatus::AwaitingApproval => "awaiting_approval",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RunEvent {
    CellStarted {
        cell_idx: usize,
    },
    CellFinished {
        cell_idx: usize,
        status: CellStatus,
        block_id: Option<String>,
        error: Option<String>,
    },
    AwaitingApproval {
        cell_idx: usize,
        prompt: String,
    },
    RunFinished {
        status: RunStatus,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ControlMsg {
    Approve,
    Cancel,
    Pause,
    Resume,
}

// -------- pluggable executors --------

#[derive(Debug, Clone)]
pub struct PtyRunResult {
    pub output: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
}

#[async_trait]
pub trait PtyExecutor: Send + Sync {
    async fn run_command(
        &self,
        tab_id: &str,
        command: &str,
        block_id: &str,
    ) -> Result<PtyRunResult>;
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum AssertionOutcome {
    Passed {
        actual: serde_json::Value,
    },
    Failed {
        actual: serde_json::Value,
        expected: serde_json::Value,
        reason: String,
    },
}

#[async_trait]
pub trait AssertionEvaluator: Send + Sync {
    async fn evaluate(
        &self,
        tab_id: &str,
        spec: &AssertionSpec,
        params: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<AssertionOutcome>;
}

// -------- default assertion evaluator --------

pub type ParseFn = Arc<
    dyn Fn(&str, &str, &str, &str) -> Result<serde_json::Value> + Send + Sync,
>;

pub struct DefaultAssertionEvaluator {
    pub pty: Arc<dyn PtyExecutor>,
    pub parse_fn: ParseFn,
    pub vendor: String,
    pub platform: String,
}

#[async_trait]
impl AssertionEvaluator for DefaultAssertionEvaluator {
    async fn evaluate(
        &self,
        tab_id: &str,
        spec: &AssertionSpec,
        params: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<AssertionOutcome> {
        let cmd = substitute(&spec.command, params);
        let jp = substitute(&spec.jsonpath, params);
        let expected = spec.expected.clone();

        let block_id = format!("assert-{}", uuid::Uuid::new_v4());
        let result = self
            .pty
            .run_command(tab_id, &cmd, &block_id)
            .await?;

        // First try the configured parser. If parsing fails (no parser for
        // this vendor/command, or the sidecar is unreachable), fall back to a
        // generic shape so generic-vendor smoke tests still work.
        // TODO(plan 05): remove this fallback once the parser matrix is live.
        let parsed: serde_json::Value =
            match (self.parse_fn)(&self.vendor, &self.platform, &cmd, &result.output) {
                Ok(v) => v,
                Err(_) if self.vendor == "generic" => {
                    serde_json::json!({ "stdout": result.output })
                }
                Err(e) => return Err(e),
            };

        let matches = jsonpath_lib::select(&parsed, &jp)
            .map_err(|e| anyhow::anyhow!("JSONPath error: {e}"))?;
        let actual: serde_json::Value = match matches.as_slice() {
            [] => serde_json::Value::Null,
            [single] => (*single).clone(),
            many => serde_json::Value::Array(many.iter().map(|v| (*v).clone()).collect()),
        };

        let passed = match spec.op {
            AssertionOp::Equals => actual == expected,
            AssertionOp::NotEquals => actual != expected,
            AssertionOp::Contains => contains(&actual, &expected),
            AssertionOp::GreaterThan => num_cmp(&actual, &expected, |a, b| a > b),
            AssertionOp::LessThan => num_cmp(&actual, &expected, |a, b| a < b),
            AssertionOp::Exists => !actual.is_null(),
        };

        Ok(if passed {
            AssertionOutcome::Passed { actual }
        } else {
            AssertionOutcome::Failed {
                actual,
                expected,
                reason: format!("{:?} assertion not satisfied", spec.op),
            }
        })
    }
}

fn contains(actual: &serde_json::Value, expected: &serde_json::Value) -> bool {
    match (actual, expected) {
        (serde_json::Value::Array(items), needle) => items.iter().any(|i| i == needle),
        (serde_json::Value::String(s), serde_json::Value::String(n)) => s.contains(n),
        (serde_json::Value::Object(map), serde_json::Value::String(key)) => map.contains_key(key),
        _ => false,
    }
}

fn num_cmp(
    a: &serde_json::Value,
    b: &serde_json::Value,
    cmp: impl Fn(f64, f64) -> bool,
) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => cmp(x, y),
        _ => false,
    }
}

// -------- runner --------

#[derive(Debug, Clone)]
pub struct RunnerConfig {
    pub run_id: String,
    pub notebook_id: String,
    pub tab_id: String,
    pub start_at_idx: usize,
}

pub struct NotebookRunner {
    pub cfg: RunnerConfig,
    pub notebook: Notebook,
    pub params: serde_json::Map<String, serde_json::Value>,
    pub ctrl_rx: mpsc::Receiver<ControlMsg>,
    pub event_tx: mpsc::Sender<RunEvent>,
}

pub struct RunnerContext {
    pub db: Arc<Mutex<Connection>>,
    pub pty: Arc<dyn PtyExecutor>,
    pub assertions: Arc<dyn AssertionEvaluator>,
    /// Plan 09 guardrail integration. When `Some`, every command cell is
    /// classified before `pty.run_command` and a non-Tier-0 chunk pauses
    /// the run with `CellStatus::AwaitingApproval`. When `None`, the
    /// runner does NOT classify — used both by unit tests and by local
    /// PTY tabs (per Plan 09's scope guard, local shell tabs must not
    /// classify). The supplier of the context decides which path to take
    /// based on the tab's `tab_type`.
    pub guardrail: Option<NotebookGuardrail>,
}

/// Bundle of guardrail inputs the notebook runner needs to classify a
/// command cell. `vendor`/`platform` are looked up from the notebook's
/// frontmatter (Plan 03); the ruleset is the project-wide
/// `AppState::guardrails_ruleset`.
#[derive(Clone)]
pub struct NotebookGuardrail {
    pub ruleset: Arc<parking_lot::RwLock<crate::guardrails::rules::RuleSet>>,
    pub vendor: String,
    pub platform: String,
}

impl NotebookRunner {
    /// Drive the run to completion. Returns the final status.
    ///
    /// Per-cell status is persisted to `notebook_cell_runs` and the run row
    /// `notebook_runs.status` is updated as the runner transitions.
    pub async fn run(mut self, ctx: RunnerContext) -> Result<RunStatus> {
        // Validate parameters: every required (no default) parameter must be
        // present in `self.params`, otherwise fail the run before touching
        // the PTY.
        for spec in &self.notebook.frontmatter.parameters {
            if spec.default.is_none() && !self.params.contains_key(&spec.name) {
                let final_status = RunStatus::Failed;
                update_run_status(&ctx.db, &self.cfg.run_id, final_status, true)?;
                let _ = self
                    .event_tx
                    .send(RunEvent::CellFinished {
                        cell_idx: 0,
                        status: CellStatus::Failed,
                        block_id: None,
                        error: Some(format!("missing required parameter '{}'", spec.name)),
                    })
                    .await;
                let _ = self
                    .event_tx
                    .send(RunEvent::RunFinished {
                        status: final_status,
                    })
                    .await;
                return Ok(final_status);
            }
        }
        // Apply defaults for any unset parameters.
        for spec in &self.notebook.frontmatter.parameters {
            if !self.params.contains_key(&spec.name) {
                if let Some(d) = &spec.default {
                    self.params.insert(spec.name.clone(), d.clone().into());
                }
            }
        }

        let cells = self.notebook.cells.clone();
        let mut final_status = RunStatus::Completed;

        for (cell_idx, cell) in cells.iter().enumerate() {
            if cell_idx < self.cfg.start_at_idx {
                continue;
            }

            cell_run_upsert(
                &ctx.db,
                &self.cfg.run_id,
                cell_idx,
                CellStatus::Running,
                None,
                None,
            )?;
            let _ = self
                .event_tx
                .send(RunEvent::CellStarted { cell_idx })
                .await;

            // SECURITY GATE — Plan 09. For Command cells: when this
            // notebook's runner was given a `NotebookGuardrail` (i.e.
            // the tab is NETCONF or SSH-to-device), classify each
            // shell-split chunk of the substituted command. A
            // non-Tier-0 chunk MUST NOT auto-execute — surface the cell
            // as `AwaitingApproval` and stop the run. Local PTY tabs
            // pass `guardrail = None`, so this gate is skipped (per
            // Plan 09's scope guard, see `pty_guardrail_bypass_test.rs`).
            if let NotebookCell::Command { content, .. } = cell {
                if let Some(g) = &ctx.guardrail {
                    let substituted = substitute(content, &self.params);
                    if let Err(reason) =
                        classify_command_for_notebook(g, &substituted)
                    {
                        cell_run_upsert(
                            &ctx.db,
                            &self.cfg.run_id,
                            cell_idx,
                            CellStatus::AwaitingApproval,
                            None,
                            Some(reason.clone()),
                        )?;
                        let _ = self
                            .event_tx
                            .send(RunEvent::CellFinished {
                                cell_idx,
                                status: CellStatus::AwaitingApproval,
                                block_id: None,
                                error: Some(reason),
                            })
                            .await;
                        final_status = RunStatus::Failed;
                        break;
                    }
                }
            }

            let outcome = match cell {
                NotebookCell::Markdown { .. } => CellOutcome::Skipped,
                NotebookCell::Parameter { .. } => CellOutcome::Skipped,
                NotebookCell::Command { content, .. } => {
                    let cmd = substitute(content, &self.params);
                    let block_id = format!("nb-{}-{}", self.cfg.run_id, cell_idx);
                    match ctx.pty.run_command(&self.cfg.tab_id, &cmd, &block_id).await {
                        Ok(r) => match r.exit_code {
                            None | Some(0) => CellOutcome::Passed { block_id: Some(block_id) },
                            Some(code) => CellOutcome::Failed {
                                block_id: Some(block_id),
                                error: format!("command exited with code {code}"),
                            },
                        },
                        Err(e) => CellOutcome::Failed {
                            block_id: None,
                            error: format!("pty error: {e}"),
                        },
                    }
                }
                NotebookCell::Assertion { spec } => {
                    match ctx
                        .assertions
                        .evaluate(&self.cfg.tab_id, spec, &self.params)
                        .await
                    {
                        Ok(AssertionOutcome::Passed { .. }) => CellOutcome::Passed { block_id: None },
                        Ok(AssertionOutcome::Failed { reason, .. }) => CellOutcome::Failed {
                            block_id: None,
                            error: reason,
                        },
                        Err(e) => CellOutcome::Failed {
                            block_id: None,
                            error: format!("assertion infrastructure error: {e}"),
                        },
                    }
                }
                NotebookCell::Approval { content } => {
                    cell_run_upsert(
                        &ctx.db,
                        &self.cfg.run_id,
                        cell_idx,
                        CellStatus::AwaitingApproval,
                        None,
                        None,
                    )?;
                    update_run_status(&ctx.db, &self.cfg.run_id, RunStatus::Paused, false)?;
                    let _ = self
                        .event_tx
                        .send(RunEvent::AwaitingApproval {
                            cell_idx,
                            prompt: content.clone(),
                        })
                        .await;
                    match self.ctrl_rx.recv().await {
                        Some(ControlMsg::Approve) => {
                            update_run_status(
                                &ctx.db,
                                &self.cfg.run_id,
                                RunStatus::Running,
                                false,
                            )?;
                            CellOutcome::Passed { block_id: None }
                        }
                        Some(ControlMsg::Cancel) | None => CellOutcome::Cancelled,
                        Some(ControlMsg::Pause) => CellOutcome::Cancelled, // pause-while-paused = cancel
                        Some(ControlMsg::Resume) => CellOutcome::Passed { block_id: None },
                    }
                }
            };

            match outcome {
                CellOutcome::Skipped => {
                    cell_run_upsert(
                        &ctx.db,
                        &self.cfg.run_id,
                        cell_idx,
                        CellStatus::Skipped,
                        None,
                        None,
                    )?;
                    let _ = self
                        .event_tx
                        .send(RunEvent::CellFinished {
                            cell_idx,
                            status: CellStatus::Skipped,
                            block_id: None,
                            error: None,
                        })
                        .await;
                }
                CellOutcome::Passed { block_id } => {
                    cell_run_upsert(
                        &ctx.db,
                        &self.cfg.run_id,
                        cell_idx,
                        CellStatus::Passed,
                        block_id.clone(),
                        None,
                    )?;
                    let _ = self
                        .event_tx
                        .send(RunEvent::CellFinished {
                            cell_idx,
                            status: CellStatus::Passed,
                            block_id,
                            error: None,
                        })
                        .await;
                }
                CellOutcome::Failed { block_id, error } => {
                    cell_run_upsert(
                        &ctx.db,
                        &self.cfg.run_id,
                        cell_idx,
                        CellStatus::Failed,
                        block_id.clone(),
                        Some(error.clone()),
                    )?;
                    let _ = self
                        .event_tx
                        .send(RunEvent::CellFinished {
                            cell_idx,
                            status: CellStatus::Failed,
                            block_id,
                            error: Some(error),
                        })
                        .await;
                    final_status = RunStatus::Failed;
                    break;
                }
                CellOutcome::Cancelled => {
                    cell_run_upsert(
                        &ctx.db,
                        &self.cfg.run_id,
                        cell_idx,
                        CellStatus::Skipped,
                        None,
                        Some("cancelled".into()),
                    )?;
                    let _ = self
                        .event_tx
                        .send(RunEvent::CellFinished {
                            cell_idx,
                            status: CellStatus::Skipped,
                            block_id: None,
                            error: Some("cancelled".into()),
                        })
                        .await;
                    final_status = RunStatus::Cancelled;
                    break;
                }
            }
        }

        update_run_status(&ctx.db, &self.cfg.run_id, final_status, true)?;
        let _ = self
            .event_tx
            .send(RunEvent::RunFinished {
                status: final_status,
            })
            .await;
        Ok(final_status)
    }
}

enum CellOutcome {
    Skipped,
    Passed { block_id: Option<String> },
    Failed { block_id: Option<String>, error: String },
    Cancelled,
}

/// Classify each shell-split chunk of `command` against the guardrail
/// ruleset bundled in `g`. Returns `Ok(())` if every chunk is Tier-0,
/// otherwise `Err(reason)` describing the highest-tier offending chunk.
fn classify_command_for_notebook(
    g: &NotebookGuardrail,
    command: &str,
) -> std::result::Result<(), String> {
    use crate::guardrails::classifier::{classify, Tier};
    use crate::guardrails::shell_split::split_for_classification;
    let rs = g.ruleset.read();
    let chunks = split_for_classification(command);
    let mut highest = Tier::T0;
    let mut offending: Option<String> = None;
    for chunk in &chunks {
        let d = classify(&rs, &g.vendor, &g.platform, chunk);
        let rank = |t: Tier| match t {
            Tier::T0 => 0u8,
            Tier::Ambiguous => 1,
            Tier::T1 => 2,
            Tier::T2 => 3,
            Tier::T3 => 4,
        };
        if rank(d.tier) > rank(highest) {
            highest = d.tier;
            offending = Some(chunk.clone());
        }
    }
    if matches!(highest, Tier::T0) {
        Ok(())
    } else {
        Err(format!(
            "command above Tier-0 ({}); offending chunk = {:?}",
            highest.as_str(),
            offending.unwrap_or_else(|| command.to_string())
        ))
    }
}

// -------- DB helpers --------

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn cell_run_upsert(
    db: &Arc<Mutex<Connection>>,
    run_id: &str,
    cell_idx: usize,
    status: CellStatus,
    block_id: Option<String>,
    error: Option<String>,
) -> Result<()> {
    let conn = db.lock();
    let now = now_unix();
    conn.execute(
        "INSERT INTO notebook_cell_runs (run_id, cell_idx, status, block_id, error, started_at, ended_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, CASE WHEN ?3 IN ('passed','failed','skipped') THEN ?6 ELSE NULL END)
         ON CONFLICT(run_id, cell_idx) DO UPDATE SET
            status = excluded.status,
            block_id = COALESCE(excluded.block_id, notebook_cell_runs.block_id),
            error = excluded.error,
            ended_at = CASE WHEN excluded.status IN ('passed','failed','skipped') THEN ?6 ELSE notebook_cell_runs.ended_at END",
        rusqlite::params![run_id, cell_idx as i64, status.as_str(), block_id, error, now],
    )?;
    Ok(())
}

pub fn update_run_status(
    db: &Arc<Mutex<Connection>>,
    run_id: &str,
    status: RunStatus,
    finalize: bool,
) -> Result<()> {
    let conn = db.lock();
    let now = now_unix();
    if finalize {
        conn.execute(
            "UPDATE notebook_runs SET status = ?2, ended_at = ?3 WHERE id = ?1",
            rusqlite::params![run_id, status.as_str(), now],
        )?;
    } else {
        conn.execute(
            "UPDATE notebook_runs SET status = ?2 WHERE id = ?1",
            rusqlite::params![run_id, status.as_str()],
        )?;
    }
    Ok(())
}

pub fn create_run_row(
    db: &Arc<Mutex<Connection>>,
    run_id: &str,
    notebook_id: &str,
    tab_id: &str,
    params: &serde_json::Map<String, serde_json::Value>,
) -> Result<()> {
    let conn = db.lock();
    let params_json = serde_json::to_string(params)?;
    conn.execute(
        "INSERT INTO notebook_runs (id, notebook_id, tab_id, status, params_json) VALUES (?1, ?2, ?3, 'running', ?4)",
        rusqlite::params![run_id, notebook_id, tab_id, params_json],
    )?;
    Ok(())
}

pub fn last_failed_cell_idx(db: &Arc<Mutex<Connection>>, run_id: &str) -> Result<Option<usize>> {
    let conn = db.lock();
    let idx: Option<i64> = conn
        .query_row(
            "SELECT MIN(cell_idx) FROM notebook_cell_runs WHERE run_id = ?1 AND status = 'failed'",
            rusqlite::params![run_id],
            |r| r.get(0),
        )
        .ok();
    Ok(idx.map(|n| n as usize))
}

// -------- tests --------

#[cfg(test)]
pub mod tests {
    use super::*;
    use parking_lot::Mutex as PMutex;

    pub struct MockPtyExecutor {
        pub responses: PMutex<Vec<Result<PtyRunResult, String>>>,
        pub calls: PMutex<Vec<(String, String, String)>>,
    }

    impl MockPtyExecutor {
        pub fn new(responses: Vec<Result<PtyRunResult, String>>) -> Arc<Self> {
            Arc::new(Self {
                responses: PMutex::new(responses),
                calls: PMutex::new(vec![]),
            })
        }
    }

    #[async_trait]
    impl PtyExecutor for MockPtyExecutor {
        async fn run_command(
            &self,
            tab_id: &str,
            command: &str,
            block_id: &str,
        ) -> Result<PtyRunResult> {
            self.calls
                .lock()
                .push((tab_id.into(), command.into(), block_id.into()));
            let mut q = self.responses.lock();
            if q.is_empty() {
                return Err(anyhow::anyhow!("no mock response queued"));
            }
            let r = q.remove(0);
            r.map_err(|e| anyhow::anyhow!(e))
        }
    }

    pub struct MockAssertionEvaluator {
        pub outcomes: PMutex<Vec<Result<AssertionOutcome, String>>>,
    }

    #[async_trait]
    impl AssertionEvaluator for MockAssertionEvaluator {
        async fn evaluate(
            &self,
            _tab_id: &str,
            _spec: &AssertionSpec,
            _params: &serde_json::Map<String, serde_json::Value>,
        ) -> Result<AssertionOutcome> {
            let mut q = self.outcomes.lock();
            if q.is_empty() {
                return Err(anyhow::anyhow!("no mock outcome queued"));
            }
            q.remove(0).map_err(|e| anyhow::anyhow!(e))
        }
    }

    fn schema_db() -> Arc<Mutex<Connection>> {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE notebooks (id TEXT PRIMARY KEY, body_markdown TEXT, frontmatter_json TEXT, title TEXT NOT NULL, description TEXT, vendor TEXT, platform TEXT, created_at INTEGER, updated_at INTEGER);
            CREATE TABLE notebook_cells (notebook_id TEXT, idx INTEGER, cell_type TEXT, content TEXT, metadata_json TEXT, PRIMARY KEY (notebook_id, idx));
            CREATE TABLE notebook_runs (id TEXT PRIMARY KEY, notebook_id TEXT, tab_id TEXT, status TEXT NOT NULL, params_json TEXT NOT NULL DEFAULT '{}', started_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), ended_at INTEGER);
            CREATE TABLE notebook_cell_runs (run_id TEXT, cell_idx INTEGER, status TEXT NOT NULL, block_id TEXT, error TEXT, started_at INTEGER, ended_at INTEGER, PRIMARY KEY (run_id, cell_idx));
            "#,
        )
        .unwrap();
        Arc::new(Mutex::new(conn))
    }

    fn nb_with_cells(cells: Vec<NotebookCell>) -> Notebook {
        Notebook {
            frontmatter: Frontmatter::default(),
            cells,
            body_markdown: String::new(),
        }
    }

    fn ok_pty(output: &str) -> Result<PtyRunResult, String> {
        Ok(PtyRunResult {
            output: output.into(),
            exit_code: Some(0),
            duration_ms: 1,
        })
    }

    #[tokio::test]
    async fn happy_path_runs_all_cells() {
        let db = schema_db();
        let nb = nb_with_cells(vec![
            NotebookCell::Markdown { content: "hi".into() },
            NotebookCell::Command {
                content: "echo hello".into(),
                metadata: CommandMeta::default(),
            },
        ]);
        let pty = MockPtyExecutor::new(vec![ok_pty("hello\n")]);
        let assertions = Arc::new(MockAssertionEvaluator {
            outcomes: PMutex::new(vec![]),
        });
        let (ctrl_tx, ctrl_rx) = mpsc::channel(8);
        let (ev_tx, mut ev_rx) = mpsc::channel(64);
        drop(ctrl_tx);

        create_run_row(&db, "run-1", "nb-1", "tab-1", &Default::default()).unwrap();

        let runner = NotebookRunner {
            cfg: RunnerConfig {
                run_id: "run-1".into(),
                notebook_id: "nb-1".into(),
                tab_id: "tab-1".into(),
                start_at_idx: 0,
            },
            notebook: nb,
            params: Default::default(),
            ctrl_rx,
            event_tx: ev_tx,
        };

        let ctx = RunnerContext {
            db: db.clone(),
            pty,
            assertions,
            guardrail: None,
        };

        let status = runner.run(ctx).await.unwrap();
        assert_eq!(status, RunStatus::Completed);

        // Drain events.
        let mut count = 0;
        while ev_rx.recv().await.is_some() {
            count += 1;
        }
        assert!(count >= 4, "expected ≥4 events (2 cells × 2 + run finished), got {count}");

        // Verify DB rows.
        let conn = db.lock();
        let cell_rows: Vec<(i64, String)> = conn
            .prepare("SELECT cell_idx, status FROM notebook_cell_runs WHERE run_id='run-1' ORDER BY cell_idx")
            .unwrap()
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(cell_rows, vec![(0, "skipped".into()), (1, "passed".into())]);
        let run_status: String = conn
            .query_row("SELECT status FROM notebook_runs WHERE id='run-1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(run_status, "completed");
    }

    #[tokio::test]
    async fn approval_cell_blocks_until_approve() {
        let db = schema_db();
        let nb = nb_with_cells(vec![
            NotebookCell::Approval {
                content: "Continue?".into(),
            },
            NotebookCell::Command {
                content: "echo done".into(),
                metadata: Default::default(),
            },
        ]);
        let pty = MockPtyExecutor::new(vec![ok_pty("done\n")]);
        let assertions = Arc::new(MockAssertionEvaluator {
            outcomes: PMutex::new(vec![]),
        });
        let (ctrl_tx, ctrl_rx) = mpsc::channel(8);
        let (ev_tx, mut ev_rx) = mpsc::channel(64);

        create_run_row(&db, "run-2", "nb-1", "tab-1", &Default::default()).unwrap();
        let runner = NotebookRunner {
            cfg: RunnerConfig {
                run_id: "run-2".into(),
                notebook_id: "nb-1".into(),
                tab_id: "tab-1".into(),
                start_at_idx: 0,
            },
            notebook: nb,
            params: Default::default(),
            ctrl_rx,
            event_tx: ev_tx,
        };

        let ctx = RunnerContext {
            db: db.clone(),
            pty,
            assertions,
            guardrail: None,
        };

        let h = tokio::spawn(runner.run(ctx));

        // Wait for the AwaitingApproval event, then approve.
        let mut approved = false;
        while let Some(ev) = ev_rx.recv().await {
            if matches!(ev, RunEvent::AwaitingApproval { .. }) {
                ctrl_tx.send(ControlMsg::Approve).await.unwrap();
                approved = true;
            }
            if matches!(ev, RunEvent::RunFinished { .. }) {
                break;
            }
        }
        assert!(approved);
        assert_eq!(h.await.unwrap().unwrap(), RunStatus::Completed);
    }

    #[tokio::test]
    async fn cancel_during_approval_marks_run_cancelled() {
        let db = schema_db();
        let nb = nb_with_cells(vec![NotebookCell::Approval {
            content: "Continue?".into(),
        }]);
        let pty = MockPtyExecutor::new(vec![]);
        let assertions = Arc::new(MockAssertionEvaluator {
            outcomes: PMutex::new(vec![]),
        });
        let (ctrl_tx, ctrl_rx) = mpsc::channel(8);
        let (ev_tx, mut ev_rx) = mpsc::channel(64);

        create_run_row(&db, "run-c", "nb-1", "tab-1", &Default::default()).unwrap();
        let runner = NotebookRunner {
            cfg: RunnerConfig {
                run_id: "run-c".into(),
                notebook_id: "nb-1".into(),
                tab_id: "tab-1".into(),
                start_at_idx: 0,
            },
            notebook: nb,
            params: Default::default(),
            ctrl_rx,
            event_tx: ev_tx,
        };

        let ctx = RunnerContext {
            db: db.clone(),
            pty,
            assertions,
            guardrail: None,
        };

        let h = tokio::spawn(runner.run(ctx));
        while let Some(ev) = ev_rx.recv().await {
            if matches!(ev, RunEvent::AwaitingApproval { .. }) {
                ctrl_tx.send(ControlMsg::Cancel).await.unwrap();
            }
            if matches!(ev, RunEvent::RunFinished { .. }) {
                break;
            }
        }
        assert_eq!(h.await.unwrap().unwrap(), RunStatus::Cancelled);
    }

    #[tokio::test]
    async fn failed_command_stops_run_and_records_failure() {
        let db = schema_db();
        let nb = nb_with_cells(vec![
            NotebookCell::Command {
                content: "false".into(),
                metadata: Default::default(),
            },
            NotebookCell::Command {
                content: "should not run".into(),
                metadata: Default::default(),
            },
        ]);
        let pty = MockPtyExecutor::new(vec![Ok(PtyRunResult {
            output: String::new(),
            exit_code: Some(1),
            duration_ms: 0,
        })]);
        let assertions = Arc::new(MockAssertionEvaluator {
            outcomes: PMutex::new(vec![]),
        });
        let (_ctrl_tx, ctrl_rx) = mpsc::channel(8);
        let (ev_tx, _ev_rx) = mpsc::channel(64);

        create_run_row(&db, "run-f", "nb-1", "tab-1", &Default::default()).unwrap();
        let runner = NotebookRunner {
            cfg: RunnerConfig {
                run_id: "run-f".into(),
                notebook_id: "nb-1".into(),
                tab_id: "tab-1".into(),
                start_at_idx: 0,
            },
            notebook: nb,
            params: Default::default(),
            ctrl_rx,
            event_tx: ev_tx,
        };

        let ctx = RunnerContext {
            db: db.clone(),
            pty,
            assertions,
            guardrail: None,
        };
        let status = runner.run(ctx).await.unwrap();
        assert_eq!(status, RunStatus::Failed);

        {
            let conn = db.lock();
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM notebook_cell_runs WHERE run_id='run-f'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "second cell must not be executed");
        }
        let failed_idx = last_failed_cell_idx(&db, "run-f").unwrap();
        assert_eq!(failed_idx, Some(0));
    }

    #[tokio::test]
    async fn resume_from_failure_skips_earlier_cells() {
        let db = schema_db();
        let nb = nb_with_cells(vec![
            NotebookCell::Command {
                content: "first".into(),
                metadata: Default::default(),
            },
            NotebookCell::Command {
                content: "second".into(),
                metadata: Default::default(),
            },
        ]);
        // Only one mock response — if start_at_idx skipping fails, the runner
        // will run two commands and the second pop will error.
        let pty = MockPtyExecutor::new(vec![ok_pty("ok\n")]);
        let assertions = Arc::new(MockAssertionEvaluator {
            outcomes: PMutex::new(vec![]),
        });
        let (_ctrl_tx, ctrl_rx) = mpsc::channel(8);
        let (ev_tx, _ev_rx) = mpsc::channel(64);

        create_run_row(&db, "run-r", "nb-1", "tab-1", &Default::default()).unwrap();
        let runner = NotebookRunner {
            cfg: RunnerConfig {
                run_id: "run-r".into(),
                notebook_id: "nb-1".into(),
                tab_id: "tab-1".into(),
                start_at_idx: 1,
            },
            notebook: nb,
            params: Default::default(),
            ctrl_rx,
            event_tx: ev_tx,
        };

        let pty_for_assert = pty.clone();
        let ctx = RunnerContext {
            db: db.clone(),
            pty,
            assertions,
            guardrail: None,
        };
        let status = runner.run(ctx).await.unwrap();
        assert_eq!(status, RunStatus::Completed);
        assert_eq!(pty_for_assert.calls.lock().len(), 1);
        assert_eq!(pty_for_assert.calls.lock()[0].1, "second");
    }

    #[tokio::test]
    async fn missing_required_param_fails_run_before_pty() {
        let db = schema_db();
        let mut fm = Frontmatter::default();
        fm.parameters = vec![ParameterSpec {
            name: "host".into(),
            prompt: "Host".into(),
            default: None,
        }];
        let nb = Notebook {
            frontmatter: fm,
            cells: vec![NotebookCell::Command {
                content: "echo {{host}}".into(),
                metadata: Default::default(),
            }],
            body_markdown: String::new(),
        };
        let pty = MockPtyExecutor::new(vec![]);
        let assertions = Arc::new(MockAssertionEvaluator {
            outcomes: PMutex::new(vec![]),
        });
        let (_ctrl_tx, ctrl_rx) = mpsc::channel(8);
        let (ev_tx, _ev_rx) = mpsc::channel(64);

        create_run_row(&db, "run-p", "nb-1", "tab-1", &Default::default()).unwrap();
        let runner = NotebookRunner {
            cfg: RunnerConfig {
                run_id: "run-p".into(),
                notebook_id: "nb-1".into(),
                tab_id: "tab-1".into(),
                start_at_idx: 0,
            },
            notebook: nb,
            params: Default::default(),
            ctrl_rx,
            event_tx: ev_tx,
        };

        let ctx = RunnerContext {
            db: db.clone(),
            pty: pty.clone(),
            assertions,
            guardrail: None,
        };
        let status = runner.run(ctx).await.unwrap();
        assert_eq!(status, RunStatus::Failed);
        assert!(pty.calls.lock().is_empty(), "PTY must not be called");
    }

    #[tokio::test]
    async fn assertion_failure_stops_run() {
        let db = schema_db();
        let spec = AssertionSpec {
            command: "show v".into(),
            jsonpath: "$.x".into(),
            op: AssertionOp::Equals,
            expected: serde_json::json!("good"),
        };
        let nb = nb_with_cells(vec![NotebookCell::Assertion { spec }]);
        let pty = MockPtyExecutor::new(vec![]);
        let assertions = Arc::new(MockAssertionEvaluator {
            outcomes: PMutex::new(vec![Ok(AssertionOutcome::Failed {
                actual: serde_json::json!("bad"),
                expected: serde_json::json!("good"),
                reason: "mismatch".into(),
            })]),
        });
        let (_ctrl_tx, ctrl_rx) = mpsc::channel(8);
        let (ev_tx, _ev_rx) = mpsc::channel(64);

        create_run_row(&db, "run-a", "nb-1", "tab-1", &Default::default()).unwrap();
        let runner = NotebookRunner {
            cfg: RunnerConfig {
                run_id: "run-a".into(),
                notebook_id: "nb-1".into(),
                tab_id: "tab-1".into(),
                start_at_idx: 0,
            },
            notebook: nb,
            params: Default::default(),
            ctrl_rx,
            event_tx: ev_tx,
        };

        let ctx = RunnerContext {
            db: db.clone(),
            pty,
            assertions,
            guardrail: None,
        };
        let status = runner.run(ctx).await.unwrap();
        assert_eq!(status, RunStatus::Failed);
    }

    #[tokio::test]
    async fn default_assertion_evaluator_passes_on_match() {
        let db = schema_db();
        let pty = MockPtyExecutor::new(vec![ok_pty("17.09.04")]);
        // parse_fn returns a fixed JSON shape regardless of input.
        let parse_fn: ParseFn = Arc::new(|_v, _p, _c, _r| {
            Ok(serde_json::json!({"version": "17.09.04"}))
        });
        let evaluator = DefaultAssertionEvaluator {
            pty: pty.clone(),
            parse_fn,
            vendor: "cisco".into(),
            platform: "iosxe".into(),
        };
        let outcome = evaluator
            .evaluate(
                "tab-1",
                &AssertionSpec {
                    command: "show version".into(),
                    jsonpath: "$.version".into(),
                    op: AssertionOp::Equals,
                    expected: serde_json::json!("17.09.04"),
                },
                &Default::default(),
            )
            .await
            .unwrap();
        assert!(matches!(outcome, AssertionOutcome::Passed { .. }));
        let _ = db;
    }

    #[tokio::test]
    async fn default_assertion_evaluator_contains_array() {
        let pty = MockPtyExecutor::new(vec![ok_pty("...")]);
        let parse_fn: ParseFn = Arc::new(|_v, _p, _c, _r| {
            Ok(serde_json::json!({"neighbors": ["10.0.0.1", "10.0.0.2"]}))
        });
        let evaluator = DefaultAssertionEvaluator {
            pty,
            parse_fn,
            vendor: "cisco".into(),
            platform: "iosxe".into(),
        };
        let out = evaluator
            .evaluate(
                "t",
                &AssertionSpec {
                    command: "show ip bgp".into(),
                    jsonpath: "$.neighbors".into(),
                    op: AssertionOp::Contains,
                    expected: serde_json::json!("10.0.0.1"),
                },
                &Default::default(),
            )
            .await
            .unwrap();
        assert!(matches!(out, AssertionOutcome::Passed { .. }));
    }

    #[tokio::test]
    async fn default_assertion_evaluator_exists_on_absent_path_fails() {
        let pty = MockPtyExecutor::new(vec![ok_pty("...")]);
        let parse_fn: ParseFn = Arc::new(|_v, _p, _c, _r| Ok(serde_json::json!({"a": 1})));
        let evaluator = DefaultAssertionEvaluator {
            pty,
            parse_fn,
            vendor: "cisco".into(),
            platform: "iosxe".into(),
        };
        let out = evaluator
            .evaluate(
                "t",
                &AssertionSpec {
                    command: "show".into(),
                    jsonpath: "$.b".into(),
                    op: AssertionOp::Exists,
                    expected: serde_json::Value::Null,
                },
                &Default::default(),
            )
            .await
            .unwrap();
        assert!(matches!(out, AssertionOutcome::Failed { .. }));
    }

    #[tokio::test]
    async fn default_assertion_evaluator_propagates_parse_error() {
        let pty = MockPtyExecutor::new(vec![ok_pty("...")]);
        let parse_fn: ParseFn = Arc::new(|_v, _p, _c, _r| Err(anyhow::anyhow!("NoParserError")));
        let evaluator = DefaultAssertionEvaluator {
            pty,
            parse_fn,
            vendor: "cisco".into(),
            platform: "iosxe".into(),
        };
        let err = evaluator
            .evaluate(
                "t",
                &AssertionSpec {
                    command: "x".into(),
                    jsonpath: "$.x".into(),
                    op: AssertionOp::Exists,
                    expected: serde_json::Value::Null,
                },
                &Default::default(),
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("NoParserError"));
    }

    #[tokio::test]
    async fn default_assertion_evaluator_generic_fallback_on_parse_error() {
        let pty = MockPtyExecutor::new(vec![ok_pty("hello world\n")]);
        let parse_fn: ParseFn = Arc::new(|_v, _p, _c, _r| Err(anyhow::anyhow!("NoParserError")));
        let evaluator = DefaultAssertionEvaluator {
            pty,
            parse_fn,
            vendor: "generic".into(),
            platform: "generic".into(),
        };
        let out = evaluator
            .evaluate(
                "t",
                &AssertionSpec {
                    command: "echo hello".into(),
                    jsonpath: "$.stdout".into(),
                    op: AssertionOp::Contains,
                    expected: serde_json::json!("hello"),
                },
                &Default::default(),
            )
            .await
            .unwrap();
        assert!(matches!(out, AssertionOutcome::Passed { .. }));
    }
}
