//! End-to-end runner test: parse a real fixture markdown into cells, then
//! drive the runner with a mocked PTY and assertion evaluator. Mirrors the
//! shape of the production code path without needing AppState.

use ccie_terminal_lib::notebooks::model::*;
use ccie_terminal_lib::notebooks::parser::parse_markdown;
use ccie_terminal_lib::notebooks::runner::{
    self, AssertionEvaluator, AssertionOutcome, ControlMsg, NotebookRunner, PtyExecutor,
    PtyRunResult, RunEvent, RunStatus, RunnerConfig, RunnerContext,
};

use async_trait::async_trait;
use parking_lot::Mutex;
use rusqlite::Connection;
use std::sync::Arc;
use tokio::sync::mpsc;

const FIXTURE: &str = include_str!("../src/notebooks/tests/fixtures/bgp_peer_bringup.mop.md");

struct StubPty {
    queue: Mutex<Vec<Result<PtyRunResult, String>>>,
    calls: Mutex<Vec<String>>,
}

#[async_trait]
impl PtyExecutor for StubPty {
    async fn run_command(
        &self,
        _tab_id: &str,
        cmd: &str,
        _block_id: &str,
    ) -> anyhow::Result<PtyRunResult> {
        self.calls.lock().push(cmd.to_string());
        let mut q = self.queue.lock();
        if q.is_empty() {
            anyhow::bail!("no stub response queued for {cmd}");
        }
        q.remove(0).map_err(|e| anyhow::anyhow!(e))
    }
}

struct StubAssertions {
    queue: Mutex<Vec<Result<AssertionOutcome, String>>>,
}

#[async_trait]
impl AssertionEvaluator for StubAssertions {
    async fn evaluate(
        &self,
        _tab_id: &str,
        _spec: &AssertionSpec,
        _params: &serde_json::Map<String, serde_json::Value>,
    ) -> anyhow::Result<AssertionOutcome> {
        let mut q = self.queue.lock();
        if q.is_empty() {
            anyhow::bail!("no stub assertion outcome queued");
        }
        q.remove(0).map_err(|e| anyhow::anyhow!(e))
    }
}

fn schema_db() -> Arc<Mutex<Connection>> {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE notebook_runs (
            id TEXT PRIMARY KEY,
            notebook_id TEXT NOT NULL,
            tab_id TEXT NOT NULL,
            status TEXT NOT NULL,
            params_json TEXT NOT NULL DEFAULT '{}',
            started_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            ended_at INTEGER
        );
        CREATE TABLE notebook_cell_runs (
            run_id TEXT NOT NULL,
            cell_idx INTEGER NOT NULL,
            status TEXT NOT NULL,
            block_id TEXT,
            error TEXT,
            started_at INTEGER,
            ended_at INTEGER,
            PRIMARY KEY (run_id, cell_idx)
        );
        "#,
    )
    .unwrap();
    Arc::new(Mutex::new(conn))
}

#[tokio::test]
async fn bgp_fixture_runs_to_completion_with_approval_and_assertion() {
    let nb = parse_markdown(FIXTURE).expect("parse");
    let db = schema_db();

    let ok_cmd = || {
        Ok(PtyRunResult {
            output: String::new(),
            exit_code: Some(0),
            duration_ms: 1,
        })
    };

    let pty = Arc::new(StubPty {
        queue: Mutex::new(vec![ok_cmd(), ok_cmd()]), // pre-check, configure
        calls: Mutex::new(vec![]),
    });
    let assertions = Arc::new(StubAssertions {
        queue: Mutex::new(vec![Ok(AssertionOutcome::Passed {
            actual: serde_json::json!("Established"),
        })]),
    });

    let (ctrl_tx, ctrl_rx) = mpsc::channel::<ControlMsg>(8);
    let (ev_tx, mut ev_rx) = mpsc::channel::<RunEvent>(64);

    let mut params = serde_json::Map::new();
    params.insert("peer_ip".into(), serde_json::json!("10.0.0.99"));
    params.insert("peer_asn".into(), serde_json::json!("65099"));

    runner::create_run_row(&db, "run-int-1", "nb-int-1", "tab-int", &params).unwrap();

    let runner_handle = NotebookRunner {
        cfg: RunnerConfig {
            run_id: "run-int-1".into(),
            notebook_id: "nb-int-1".into(),
            tab_id: "tab-int".into(),
            start_at_idx: 0,
        },
        notebook: nb,
        params,
        ctrl_rx,
        event_tx: ev_tx,
    };

    let ctx = RunnerContext {
        db: db.clone(),
        pty: pty.clone(),
        assertions,
        guardrail: None,
    };

    let h = tokio::spawn(runner_handle.run(ctx));

    let mut saw_approval = false;
    let mut saw_finished = false;
    while let Some(ev) = ev_rx.recv().await {
        match ev {
            RunEvent::AwaitingApproval { .. } => {
                saw_approval = true;
                ctrl_tx.send(ControlMsg::Approve).await.unwrap();
            }
            RunEvent::RunFinished { .. } => {
                saw_finished = true;
                break;
            }
            _ => {}
        }
    }
    assert!(saw_approval, "approval cell must produce AwaitingApproval");
    assert!(saw_finished, "run must emit RunFinished");
    assert_eq!(h.await.unwrap().unwrap(), RunStatus::Completed);

    // The PTY should have been called twice (pre-check, configure) and the
    // configure command should have substituted parameters.
    let calls = pty.calls.lock().clone();
    assert_eq!(calls.len(), 2, "expected 2 command cells, got {calls:?}");
    assert!(calls[0].contains("show ip bgp summary"));
    assert!(
        calls[1].contains("10.0.0.99") && calls[1].contains("65099"),
        "configure cell must substitute {{{{peer_ip}}}} and {{{{peer_asn}}}}: {}",
        calls[1]
    );

    // DB must reflect the final run state.
    let conn = db.lock();
    let status: String = conn
        .query_row(
            "SELECT status FROM notebook_runs WHERE id = 'run-int-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(status, "completed");
    let cell_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM notebook_cell_runs WHERE run_id='run-int-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        cell_count >= 4,
        "≥4 cells executed (incl. markdown skips), got {cell_count}"
    );
}

#[tokio::test]
async fn assertion_failure_marks_run_failed_with_resumable_idx() {
    let nb = parse_markdown(FIXTURE).expect("parse");
    let db = schema_db();

    let ok_cmd = || {
        Ok(PtyRunResult {
            output: String::new(),
            exit_code: Some(0),
            duration_ms: 1,
        })
    };

    let pty = Arc::new(StubPty {
        queue: Mutex::new(vec![ok_cmd(), ok_cmd()]),
        calls: Mutex::new(vec![]),
    });
    let assertions = Arc::new(StubAssertions {
        queue: Mutex::new(vec![Ok(AssertionOutcome::Failed {
            actual: serde_json::json!("Idle"),
            expected: serde_json::json!("Established"),
            reason: "session_state mismatch".into(),
        })]),
    });

    let (ctrl_tx, ctrl_rx) = mpsc::channel::<ControlMsg>(8);
    let (ev_tx, mut ev_rx) = mpsc::channel::<RunEvent>(64);

    let mut params = serde_json::Map::new();
    params.insert("peer_ip".into(), serde_json::json!("10.0.0.99"));
    params.insert("peer_asn".into(), serde_json::json!("65099"));
    runner::create_run_row(&db, "run-int-2", "nb-1", "tab-1", &params).unwrap();

    let runner_handle = NotebookRunner {
        cfg: RunnerConfig {
            run_id: "run-int-2".into(),
            notebook_id: "nb-1".into(),
            tab_id: "tab-1".into(),
            start_at_idx: 0,
        },
        notebook: nb,
        params,
        ctrl_rx,
        event_tx: ev_tx,
    };

    let ctx = RunnerContext {
        db: db.clone(),
        pty,
        assertions,
        guardrail: None,
    };

    let h = tokio::spawn(runner_handle.run(ctx));
    while let Some(ev) = ev_rx.recv().await {
        if let RunEvent::AwaitingApproval { .. } = ev {
            ctrl_tx.send(ControlMsg::Approve).await.unwrap();
        }
        if matches!(ev, RunEvent::RunFinished { .. }) {
            break;
        }
    }
    assert_eq!(h.await.unwrap().unwrap(), RunStatus::Failed);

    let failed_idx = runner::last_failed_cell_idx(&db, "run-int-2").unwrap();
    assert!(
        failed_idx.is_some(),
        "run must record a failed cell idx for resume"
    );
}

#[tokio::test]
async fn resume_from_failed_idx_runs_only_remaining_cells() {
    // Build a simpler 3-cell notebook: cmd, cmd, cmd. Fail on idx 1, then resume.
    let nb = Notebook {
        frontmatter: Frontmatter::default(),
        cells: vec![
            NotebookCell::Command {
                content: "first".into(),
                metadata: Default::default(),
            },
            NotebookCell::Command {
                content: "second".into(),
                metadata: Default::default(),
            },
            NotebookCell::Command {
                content: "third".into(),
                metadata: Default::default(),
            },
        ],
        body_markdown: String::new(),
    };
    let db = schema_db();

    let ok = |code: i32| {
        Ok(PtyRunResult {
            output: String::new(),
            exit_code: Some(code),
            duration_ms: 1,
        })
    };

    // First run: idx 0 ok, idx 1 fails (exit 2).
    let pty1 = Arc::new(StubPty {
        queue: Mutex::new(vec![ok(0), ok(2)]),
        calls: Mutex::new(vec![]),
    });
    let assertions1 = Arc::new(StubAssertions {
        queue: Mutex::new(vec![]),
    });
    let (_t1, r1) = mpsc::channel::<ControlMsg>(8);
    let (e1, _er1) = mpsc::channel::<RunEvent>(64);
    runner::create_run_row(&db, "run-3", "nb-3", "tab-1", &Default::default()).unwrap();
    let s1 = NotebookRunner {
        cfg: RunnerConfig {
            run_id: "run-3".into(),
            notebook_id: "nb-3".into(),
            tab_id: "tab-1".into(),
            start_at_idx: 0,
        },
        notebook: nb.clone(),
        params: Default::default(),
        ctrl_rx: r1,
        event_tx: e1,
    }
    .run(RunnerContext {
        db: db.clone(),
        pty: pty1,
        assertions: assertions1,
        guardrail: None,
    })
    .await
    .unwrap();
    assert_eq!(s1, RunStatus::Failed);
    assert_eq!(runner::last_failed_cell_idx(&db, "run-3").unwrap(), Some(1));

    // Resume run from idx 1 — only cells 1 and 2 should execute.
    let pty2 = Arc::new(StubPty {
        queue: Mutex::new(vec![ok(0), ok(0)]),
        calls: Mutex::new(vec![]),
    });
    let assertions2 = Arc::new(StubAssertions {
        queue: Mutex::new(vec![]),
    });
    let (_t2, r2) = mpsc::channel::<ControlMsg>(8);
    let (e2, _er2) = mpsc::channel::<RunEvent>(64);
    let s2 = NotebookRunner {
        cfg: RunnerConfig {
            run_id: "run-3".into(),
            notebook_id: "nb-3".into(),
            tab_id: "tab-1".into(),
            start_at_idx: 1,
        },
        notebook: nb,
        params: Default::default(),
        ctrl_rx: r2,
        event_tx: e2,
    }
    .run(RunnerContext {
        db: db.clone(),
        pty: pty2.clone(),
        assertions: assertions2,
        guardrail: None,
    })
    .await
    .unwrap();
    assert_eq!(s2, RunStatus::Completed);
    let calls = pty2.calls.lock().clone();
    assert_eq!(calls, vec!["second".to_string(), "third".to_string()]);
}
