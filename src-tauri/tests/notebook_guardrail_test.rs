//! Final security review — Finding 1.
//!
//! The notebook runner auto-executes `command` cells against a tab's
//! PTY. When that tab is NETCONF or SSH-to-device, every cell command
//! MUST be classified by the Plan 09 guardrail. A Tier-3 command
//! (`reload`, `write erase`) authored in a notebook MUST NOT reach
//! `pty.run_command`.
//!
//! Local PTY tabs (`tab_type = 'terminal'`) keep their pre-existing
//! exemption — the runner is constructed with `guardrail = None` for
//! those and the gate is skipped. That's the same scope guard that
//! `pty_guardrail_bypass_test.rs` enforces at the source-tree level.

use async_trait::async_trait;
use ccie_terminal_lib::guardrails::rules::RuleSet;
use ccie_terminal_lib::notebooks::model::{
    CommandMeta, Frontmatter, Notebook, NotebookCell,
};
use ccie_terminal_lib::notebooks::runner::{
    self, AssertionEvaluator, AssertionOutcome, ControlMsg, NotebookGuardrail,
    NotebookRunner, PtyExecutor, PtyRunResult, RunEvent, RunStatus, RunnerConfig,
    RunnerContext,
};
use parking_lot::Mutex;
use rusqlite::Connection;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

/// Counts every call to `run_command`. Test invariant: counter MUST be
/// 0 after dispatching a Tier-3 cell.
struct CountingPty {
    counter: Arc<AtomicUsize>,
}

#[async_trait]
impl PtyExecutor for CountingPty {
    async fn run_command(
        &self,
        _tab_id: &str,
        _command: &str,
        _block_id: &str,
    ) -> anyhow::Result<PtyRunResult> {
        self.counter.fetch_add(1, Ordering::SeqCst);
        Ok(PtyRunResult {
            output: "ok".into(),
            exit_code: Some(0),
            duration_ms: 1,
        })
    }
}

struct StubAssertions;
#[async_trait]
impl AssertionEvaluator for StubAssertions {
    async fn evaluate(
        &self,
        _tab_id: &str,
        _spec: &ccie_terminal_lib::notebooks::model::AssertionSpec,
        _params: &serde_json::Map<String, serde_json::Value>,
    ) -> anyhow::Result<AssertionOutcome> {
        unreachable!("no assertion cells in these tests")
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
    ).unwrap();
    Arc::new(Mutex::new(conn))
}

fn ruleset_arc() -> Arc<parking_lot::RwLock<RuleSet>> {
    Arc::new(parking_lot::RwLock::new(
        RuleSet::load_builtin().expect("builtin rules"),
    ))
}

fn nb_with_cells(cells: Vec<NotebookCell>) -> Notebook {
    Notebook {
        frontmatter: Frontmatter::default(),
        cells,
        body_markdown: String::new(),
    }
}

#[tokio::test]
async fn tier3_reload_is_blocked_before_pty_runs() {
    let db = schema_db();
    let nb = nb_with_cells(vec![
        NotebookCell::Command {
            content: "reload".into(),
            metadata: CommandMeta::default(),
        },
        NotebookCell::Command {
            content: "show version".into(),
            metadata: CommandMeta::default(),
        },
    ]);
    let counter = Arc::new(AtomicUsize::new(0));
    let pty = Arc::new(CountingPty {
        counter: counter.clone(),
    });
    let assertions = Arc::new(StubAssertions);
    let (_ctrl_tx, ctrl_rx) = mpsc::channel::<ControlMsg>(8);
    let (ev_tx, mut ev_rx) = mpsc::channel::<RunEvent>(64);

    runner::create_run_row(&db, "run-1", "nb-1", "tab-netconf", &Default::default()).unwrap();

    let runner_handle = NotebookRunner {
        cfg: RunnerConfig {
            run_id: "run-1".into(),
            notebook_id: "nb-1".into(),
            tab_id: "tab-netconf".into(),
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
        // SECURITY GATE — this is the key wiring. NETCONF / SSH-to-device
        // tabs supply a `NotebookGuardrail`; local PTY tabs would pass
        // `None` here and the gate is skipped (see scope guard).
        guardrail: Some(NotebookGuardrail {
            ruleset: ruleset_arc(),
            vendor: "cisco".into(),
            platform: "iosxe".into(),
        }),
    };
    let status = runner_handle.run(ctx).await.unwrap();

    assert_eq!(status, RunStatus::Failed, "Tier-3 cell must fail the run");
    assert_eq!(
        counter.load(Ordering::SeqCst),
        0,
        "PTY MUST NOT be invoked for Tier-3 reload"
    );

    // Drain events and verify the cell surfaced as awaiting_approval.
    let mut saw_awaiting = false;
    while let Some(ev) = ev_rx.recv().await {
        if let RunEvent::CellFinished {
            status: ccie_terminal_lib::notebooks::runner::CellStatus::AwaitingApproval,
            ..
        } = ev
        {
            saw_awaiting = true;
        }
    }
    assert!(saw_awaiting, "expected an AwaitingApproval CellFinished event");
}

#[tokio::test]
async fn tier3_write_erase_is_blocked_before_pty_runs() {
    let db = schema_db();
    let nb = nb_with_cells(vec![NotebookCell::Command {
        content: "write erase".into(),
        metadata: CommandMeta::default(),
    }]);
    let counter = Arc::new(AtomicUsize::new(0));
    let pty = Arc::new(CountingPty {
        counter: counter.clone(),
    });
    let assertions = Arc::new(StubAssertions);
    let (_ctrl_tx, ctrl_rx) = mpsc::channel::<ControlMsg>(8);
    let (ev_tx, _ev_rx) = mpsc::channel::<RunEvent>(64);

    runner::create_run_row(&db, "run-2", "nb-2", "tab-ssh", &Default::default()).unwrap();
    let runner_handle = NotebookRunner {
        cfg: RunnerConfig {
            run_id: "run-2".into(),
            notebook_id: "nb-2".into(),
            tab_id: "tab-ssh".into(),
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
        guardrail: Some(NotebookGuardrail {
            ruleset: ruleset_arc(),
            vendor: "cisco".into(),
            platform: "iosxe".into(),
        }),
    };
    let status = runner_handle.run(ctx).await.unwrap();
    assert_eq!(status, RunStatus::Failed);
    assert_eq!(counter.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn local_pty_tab_with_no_guardrail_runs_normally() {
    // `guardrail = None` is the production wiring for `tab_type = 'terminal'`
    // tabs. The runner MUST NOT classify in that case — the user typing
    // `rm -rf` in their own shell isn't our business.
    let db = schema_db();
    let nb = nb_with_cells(vec![NotebookCell::Command {
        content: "rm -rf /tmp/anything-the-user-wants".into(),
        metadata: CommandMeta::default(),
    }]);
    let counter = Arc::new(AtomicUsize::new(0));
    let pty = Arc::new(CountingPty {
        counter: counter.clone(),
    });
    let assertions = Arc::new(StubAssertions);
    let (_ctrl_tx, ctrl_rx) = mpsc::channel::<ControlMsg>(8);
    let (ev_tx, _ev_rx) = mpsc::channel::<RunEvent>(64);

    runner::create_run_row(&db, "run-3", "nb-3", "tab-local", &Default::default()).unwrap();
    let runner_handle = NotebookRunner {
        cfg: RunnerConfig {
            run_id: "run-3".into(),
            notebook_id: "nb-3".into(),
            tab_id: "tab-local".into(),
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
        guardrail: None, // local PTY scope guard — see pty_guardrail_bypass_test.rs
    };
    let status = runner_handle.run(ctx).await.unwrap();
    assert_eq!(status, RunStatus::Completed);
    assert_eq!(
        counter.load(Ordering::SeqCst),
        1,
        "local PTY tab — gate is bypassed by design",
    );
}

#[tokio::test]
async fn shell_chain_injection_in_cell_is_blocked() {
    let db = schema_db();
    let nb = nb_with_cells(vec![NotebookCell::Command {
        content: "show version ; reload".into(),
        metadata: CommandMeta::default(),
    }]);
    let counter = Arc::new(AtomicUsize::new(0));
    let pty = Arc::new(CountingPty {
        counter: counter.clone(),
    });
    let assertions = Arc::new(StubAssertions);
    let (_ctrl_tx, ctrl_rx) = mpsc::channel::<ControlMsg>(8);
    let (ev_tx, _ev_rx) = mpsc::channel::<RunEvent>(64);

    runner::create_run_row(&db, "run-4", "nb-4", "tab-netconf", &Default::default()).unwrap();
    let runner_handle = NotebookRunner {
        cfg: RunnerConfig {
            run_id: "run-4".into(),
            notebook_id: "nb-4".into(),
            tab_id: "tab-netconf".into(),
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
        guardrail: Some(NotebookGuardrail {
            ruleset: ruleset_arc(),
            vendor: "cisco".into(),
            platform: "iosxe".into(),
        }),
    };
    let status = runner_handle.run(ctx).await.unwrap();
    assert_eq!(status, RunStatus::Failed);
    assert_eq!(
        counter.load(Ordering::SeqCst),
        0,
        "shell-chained reload MUST NOT reach the PTY",
    );
}
