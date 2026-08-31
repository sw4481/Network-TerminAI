//! Tauri commands for runnable notebooks (MOPs).
//!
//! Distinct from `commands::notebooks` (which serves the legacy "snapshot of
//! blocks" model from V0021). All command names are prefixed `notebook_*` and
//! operate against the V0030 schema.

use parking_lot::Mutex;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::mpsc;

use super::AppState;
use crate::notebooks::model::*;
use crate::notebooks::parser;
use crate::notebooks::runner::{
    self, AssertionEvaluator, CellStatus, ControlMsg, DefaultAssertionEvaluator, NotebookRunner,
    PtyExecutor, RunEvent, RunStatus, RunnerConfig, RunnerContext,
};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct RunnableNotebookDto {
    pub id: String,
    pub frontmatter: Frontmatter,
    pub cells: Vec<NotebookCell>,
    pub body_markdown: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct RunnableNotebookSummaryDto {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub vendor: Option<String>,
    pub platform: Option<String>,
    pub cell_count: i64,
    pub updated_at: i64,
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn encode_cell(c: &NotebookCell) -> (&'static str, String, String) {
    match c {
        NotebookCell::Markdown { content } => ("markdown", content.clone(), "{}".into()),
        NotebookCell::Command { content, metadata } => (
            "command",
            content.clone(),
            serde_json::to_string(metadata).unwrap_or_else(|_| "{}".into()),
        ),
        NotebookCell::Approval { content } => ("approval", content.clone(), "{}".into()),
        NotebookCell::Assertion { spec } => (
            "assertion",
            String::new(),
            serde_json::to_string(spec).unwrap_or_else(|_| "{}".into()),
        ),
        NotebookCell::Parameter { params } => (
            "parameter",
            String::new(),
            serde_json::to_string(&serde_json::json!({ "params": params }))
                .unwrap_or_else(|_| "{}".into()),
        ),
    }
}

fn decode_cell(
    cell_type: &str,
    content: &str,
    metadata_json: &str,
) -> Result<NotebookCell, String> {
    match cell_type {
        "markdown" => Ok(NotebookCell::Markdown {
            content: content.to_string(),
        }),
        "command" => {
            let metadata: CommandMeta = serde_json::from_str(metadata_json).unwrap_or_default();
            Ok(NotebookCell::Command {
                content: content.to_string(),
                metadata,
            })
        }
        "approval" => Ok(NotebookCell::Approval {
            content: content.to_string(),
        }),
        "assertion" => {
            let spec: AssertionSpec = serde_json::from_str(metadata_json)
                .map_err(|e| format!("invalid assertion metadata: {e}"))?;
            Ok(NotebookCell::Assertion { spec })
        }
        "parameter" => {
            let v: serde_json::Value = serde_json::from_str(metadata_json)
                .map_err(|e| format!("invalid parameter metadata: {e}"))?;
            let params: Vec<ParameterSpec> =
                serde_json::from_value(v.get("params").cloned().unwrap_or(serde_json::Value::Null))
                    .map_err(|e| format!("invalid parameter list: {e}"))?;
            Ok(NotebookCell::Parameter { params })
        }
        other => Err(format!("unknown cell_type in DB: {other}")),
    }
}

// -------- impl helpers (callable from tests with a raw rusqlite::Connection) --------

pub fn import_markdown_impl(conn: &Connection, markdown: &str) -> Result<String, String> {
    let nb = parser::parse_markdown(markdown).map_err(|e| e.to_string())?;
    let id = format!("nb-{}", uuid::Uuid::new_v4());
    let now = now_unix();
    let frontmatter_json = serde_json::to_string(&nb.frontmatter).map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO notebooks (id, title, description, vendor, platform, frontmatter_json, body_markdown, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        rusqlite::params![
            id,
            nb.frontmatter.title,
            nb.frontmatter.description,
            nb.frontmatter.vendor,
            nb.frontmatter.platform,
            frontmatter_json,
            nb.body_markdown,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;

    for (idx, cell) in nb.cells.iter().enumerate() {
        let (cell_type, content, meta) = encode_cell(cell);
        conn.execute(
            "INSERT INTO notebook_cells (notebook_id, idx, cell_type, content, metadata_json)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, idx as i64, cell_type, content, meta],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(id)
}

pub fn list_runnable_impl(
    conn: &Connection,
    vendor: Option<&str>,
    limit: Option<u32>,
) -> Result<Vec<RunnableNotebookSummaryDto>, String> {
    let limit = limit.unwrap_or(200) as i64;
    let (sql, params): (&str, Vec<Box<dyn rusqlite::ToSql>>) = match vendor {
        Some(v) => (
            "SELECT n.id, n.title, n.description, n.vendor, n.platform, n.updated_at,
                    COALESCE((SELECT COUNT(*) FROM notebook_cells c WHERE c.notebook_id = n.id), 0) AS cell_count
             FROM notebooks n
             WHERE n.vendor = ?1
             ORDER BY n.updated_at DESC
             LIMIT ?2",
            vec![Box::new(v.to_string()), Box::new(limit)],
        ),
        None => (
            "SELECT n.id, n.title, n.description, n.vendor, n.platform, n.updated_at,
                    COALESCE((SELECT COUNT(*) FROM notebook_cells c WHERE c.notebook_id = n.id), 0) AS cell_count
             FROM notebooks n
             ORDER BY n.updated_at DESC
             LIMIT ?1",
            vec![Box::new(limit)],
        ),
    };

    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
    let rows = stmt
        .query_map(param_refs.as_slice(), |r| {
            Ok(RunnableNotebookSummaryDto {
                id: r.get(0)?,
                title: r.get(1)?,
                description: r.get(2)?,
                vendor: r.get(3)?,
                platform: r.get(4)?,
                updated_at: r.get(5)?,
                cell_count: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn get_runnable_impl(conn: &Connection, id: &str) -> Result<RunnableNotebookDto, String> {
    let (title, description, vendor, platform, frontmatter_json, body_markdown, created_at, updated_at): (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        String,
        i64,
        i64,
    ) = conn
        .query_row(
            "SELECT title, description, vendor, platform, frontmatter_json, body_markdown, created_at, updated_at
             FROM notebooks WHERE id = ?1",
            rusqlite::params![id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?;

    let frontmatter: Frontmatter =
        serde_json::from_str(&frontmatter_json).unwrap_or_else(|_| Frontmatter {
            title: title.clone(),
            description: description.clone(),
            vendor: vendor.clone(),
            platform: platform.clone(),
            parameters: Vec::new(),
        });

    let mut stmt = conn
        .prepare(
            "SELECT cell_type, content, metadata_json FROM notebook_cells
             WHERE notebook_id = ?1 ORDER BY idx ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![id], |r| {
            let ct: String = r.get(0)?;
            let content: String = r.get(1)?;
            let meta: String = r.get(2)?;
            Ok((ct, content, meta))
        })
        .map_err(|e| e.to_string())?;

    let mut cells: Vec<NotebookCell> = Vec::new();
    for row in rows {
        let (ct, content, meta) = row.map_err(|e| e.to_string())?;
        cells.push(decode_cell(&ct, &content, &meta)?);
    }

    Ok(RunnableNotebookDto {
        id: id.to_string(),
        frontmatter,
        cells,
        body_markdown,
        created_at,
        updated_at,
    })
}

pub fn delete_runnable_impl(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM notebooks WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn export_markdown_impl(conn: &Connection, id: &str) -> Result<String, String> {
    let md: String = conn
        .query_row(
            "SELECT body_markdown FROM notebooks WHERE id = ?1",
            rusqlite::params![id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(md)
}

// -------- Tauri command surface --------

#[tauri::command]
pub async fn notebook_import_markdown(
    state: State<'_, AppState>,
    markdown: String,
) -> Result<String, String> {
    let conn = state.db.lock();
    import_markdown_impl(&conn, &markdown)
}

#[tauri::command]
pub async fn notebook_list_runnable(
    state: State<'_, AppState>,
    vendor: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<RunnableNotebookSummaryDto>, String> {
    let conn = state.db.lock();
    list_runnable_impl(&conn, vendor.as_deref(), limit)
}

#[tauri::command]
pub async fn notebook_get_runnable(
    state: State<'_, AppState>,
    id: String,
) -> Result<RunnableNotebookDto, String> {
    let conn = state.db.lock();
    get_runnable_impl(&conn, &id)
}

#[tauri::command]
pub async fn notebook_delete_runnable(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let conn = state.db.lock();
    delete_runnable_impl(&conn, &id)
}

#[tauri::command]
pub async fn notebook_export_markdown(
    state: State<'_, AppState>,
    id: String,
) -> Result<String, String> {
    let conn = state.db.lock();
    export_markdown_impl(&conn, &id)
}

const MAX_NOTEBOOK_BODY_BYTES: usize = 2 * 1024 * 1024; // 2 MiB

/// Fetch a `.mop.md` file from a URL and import it. Body is capped at 2 MiB.
#[tauri::command]
pub async fn notebook_import_url(
    state: State<'_, AppState>,
    url: String,
) -> Result<String, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("invalid URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http/https URLs are allowed".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("fetch failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    if let Some(len) = resp.content_length() {
        if (len as usize) > MAX_NOTEBOOK_BODY_BYTES {
            return Err(format!(
                "response too large: {len} bytes (max {MAX_NOTEBOOK_BODY_BYTES})"
            ));
        }
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_NOTEBOOK_BODY_BYTES {
        return Err(format!(
            "response too large: {} bytes (max {MAX_NOTEBOOK_BODY_BYTES})",
            bytes.len()
        ));
    }
    let markdown = String::from_utf8(bytes.to_vec())
        .map_err(|e| format!("response is not valid UTF-8: {e}"))?;
    let conn = state.db.lock();
    import_markdown_impl(&conn, &markdown)
}

// -------- Run control --------

/// Holds control-channel senders for live runs keyed by run_id.
#[derive(Default)]
pub struct RunRegistry {
    pub senders: Mutex<HashMap<String, mpsc::Sender<ControlMsg>>>,
}

impl RunRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    pub fn insert(&self, run_id: &str, tx: mpsc::Sender<ControlMsg>) {
        self.senders.lock().insert(run_id.to_string(), tx);
    }
    pub fn remove(&self, run_id: &str) -> Option<mpsc::Sender<ControlMsg>> {
        self.senders.lock().remove(run_id)
    }
    pub fn get(&self, run_id: &str) -> Option<mpsc::Sender<ControlMsg>> {
        self.senders.lock().get(run_id).cloned()
    }
}

fn build_pty_executor(state: &AppState) -> Arc<dyn PtyExecutor> {
    Arc::new(crate::pty_runner::AppStatePtyExecutor {
        state_db: state.db.clone(),
        ptys: state.ptys.clone(),
        terminal_agent: state.terminal_agent.clone(),
        waiters: state.block_end_waiters.clone(),
    })
}

/// Plan 09 — gate notebook command cells against the project-wide guardrail
/// ruleset, but ONLY when the target tab actually talks to a network device.
/// Local PTY (`tab_type = 'terminal'`) tabs are exempt per Plan 09's scope
/// guard (see `pty_guardrail_bypass_test.rs`).
///
/// Returns `Some(NotebookGuardrail)` when the tab is NETCONF or SSH-to-device,
/// else `None`. Failure to look up the tab type errs on the safe side and
/// returns `None` (so a missing tab can't poison a notebook run that targets
/// a freshly-created tab whose row hasn't committed yet — the runner will
/// fail at the PTY layer instead).
fn build_notebook_guardrail(
    state: &AppState,
    tab_id: &str,
    vendor: String,
    platform: String,
) -> Option<runner::NotebookGuardrail> {
    let tab_type: Option<String> = {
        let conn = state.db.lock();
        conn.query_row(
            "SELECT tab_type FROM tabs WHERE id = ?1",
            rusqlite::params![tab_id],
            |r| r.get::<_, String>(0),
        )
        .ok()
    };
    let is_device_tab = matches!(tab_type.as_deref(), Some("netconf") | Some("ssh"));
    if is_device_tab {
        Some(runner::NotebookGuardrail {
            ruleset: state.guardrails_ruleset.clone(),
            vendor,
            platform,
        })
    } else {
        None
    }
}

fn build_assertion_evaluator(
    state: &AppState,
    pty: Arc<dyn PtyExecutor>,
    vendor: String,
    platform: String,
) -> Arc<dyn AssertionEvaluator> {
    let bridge = state.parser_bridge.clone();
    let parse_fn: runner::ParseFn = Arc::new(move |v, p, c, r| {
        // Block on the parser bridge in a current thread runtime — the
        // runner is already async so we use tokio's Handle.
        let v = v.to_string();
        let p = p.to_string();
        let c = c.to_string();
        let r = r.to_string();
        let bridge = bridge.clone();
        let result = futures::executor::block_on(async move { bridge.parse(&v, &p, &c, &r).await });
        result.map(|po| po.data)
    });
    Arc::new(DefaultAssertionEvaluator {
        pty,
        parse_fn,
        vendor,
        platform,
    })
}

#[tauri::command]
pub async fn notebook_run_start(
    state: State<'_, AppState>,
    notebook_id: String,
    tab_id: String,
    params: serde_json::Value,
    on_event: Channel<RunEvent>,
    // SSH-direct execution (Plan 03 over interactive SSH): when a saved
    // connection id is supplied, notebook cells run over one-shot SSH sessions
    // instead of the OSC-133 PTY runner (which times out per cell on real
    // network devices). Omit to keep the legacy PTY behaviour.
    connection_id: Option<String>,
    password: Option<String>,
) -> Result<String, String> {
    let dto = {
        let conn = state.db.lock();
        get_runnable_impl(&conn, &notebook_id)?
    };

    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let params_map: serde_json::Map<String, serde_json::Value> = match params {
        serde_json::Value::Object(m) => m,
        _ => Default::default(),
    };
    runner::create_run_row(&state.db, &run_id, &notebook_id, &tab_id, &params_map)
        .map_err(|e| e.to_string())?;

    let (ctrl_tx, ctrl_rx) = mpsc::channel::<ControlMsg>(8);
    let (ev_tx, mut ev_rx) = mpsc::channel::<RunEvent>(64);

    state.notebook_runs.insert(&run_id, ctrl_tx);

    // Forward events to the frontend channel.
    let on_event_clone = on_event.clone();
    tokio::spawn(async move {
        while let Some(ev) = ev_rx.recv().await {
            let _ = on_event_clone.send(ev);
        }
    });

    // Pick the executor: SSH-direct when a connection is supplied, else the
    // legacy OSC-133 PTY runner.
    let pty: Arc<dyn PtyExecutor> = match &connection_id {
        Some(conn_id) => {
            let (target, _name) = crate::ssh_exec::resolve_target(&state.db, conn_id, password)?;
            Arc::new(crate::ssh_exec::SshPtyExecutor::from_target(target))
        }
        None => build_pty_executor(&state),
    };
    let vendor = dto
        .frontmatter
        .vendor
        .clone()
        .unwrap_or_else(|| "generic".into());
    let platform = dto
        .frontmatter
        .platform
        .clone()
        .unwrap_or_else(|| "generic".into());
    let assertions =
        build_assertion_evaluator(&state, pty.clone(), vendor.clone(), platform.clone());
    let guardrail = build_notebook_guardrail(&state, &tab_id, vendor, platform);

    let nb = Notebook {
        frontmatter: dto.frontmatter,
        cells: dto.cells,
        body_markdown: dto.body_markdown,
    };

    let runner_handle = NotebookRunner {
        cfg: RunnerConfig {
            run_id: run_id.clone(),
            notebook_id,
            tab_id,
            start_at_idx: 0,
        },
        notebook: nb,
        params: params_map,
        ctrl_rx,
        event_tx: ev_tx,
    };

    let ctx = RunnerContext {
        db: state.db.clone(),
        pty,
        assertions,
        guardrail,
    };

    let registry = state.notebook_runs.clone();
    let run_id_for_cleanup = run_id.clone();
    tokio::spawn(async move {
        let _ = runner_handle.run(ctx).await;
        registry.remove(&run_id_for_cleanup);
    });

    Ok(run_id)
}

async fn send_control(state: &AppState, run_id: &str, msg: ControlMsg) -> Result<(), String> {
    let tx = state
        .notebook_runs
        .get(run_id)
        .ok_or_else(|| format!("no live run {run_id}"))?;
    tx.send(msg).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notebook_run_approve(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<(), String> {
    send_control(&state, &run_id, ControlMsg::Approve).await
}

#[tauri::command]
pub async fn notebook_run_cancel(state: State<'_, AppState>, run_id: String) -> Result<(), String> {
    send_control(&state, &run_id, ControlMsg::Cancel).await
}

#[tauri::command]
pub async fn notebook_run_pause(state: State<'_, AppState>, run_id: String) -> Result<(), String> {
    send_control(&state, &run_id, ControlMsg::Pause).await
}

#[tauri::command]
pub async fn notebook_run_resume(
    state: State<'_, AppState>,
    run_id: String,
    tab_id: String,
    on_event: Channel<RunEvent>,
    connection_id: Option<String>,
    password: Option<String>,
) -> Result<(), String> {
    // If the run is still live, just send Resume.
    if state.notebook_runs.get(&run_id).is_some() {
        return send_control(&state, &run_id, ControlMsg::Resume).await;
    }

    // Otherwise, find the failed cell index and re-spawn the runner from there.
    let start_at_idx = {
        runner::last_failed_cell_idx(&state.db, &run_id)
            .map_err(|e| e.to_string())?
            .unwrap_or(0)
    };

    let notebook_id: String = {
        let conn = state.db.lock();
        conn.query_row(
            "SELECT notebook_id FROM notebook_runs WHERE id = ?1",
            rusqlite::params![run_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?
    };
    let dto = {
        let conn = state.db.lock();
        get_runnable_impl(&conn, &notebook_id)?
    };
    let params_json: String = {
        let conn = state.db.lock();
        conn.query_row(
            "SELECT params_json FROM notebook_runs WHERE id = ?1",
            rusqlite::params![run_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?
    };
    let params_map: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(&params_json).unwrap_or_default();

    runner::update_run_status(&state.db, &run_id, RunStatus::Running, false)
        .map_err(|e| e.to_string())?;

    let (ctrl_tx, ctrl_rx) = mpsc::channel::<ControlMsg>(8);
    let (ev_tx, mut ev_rx) = mpsc::channel::<RunEvent>(64);
    state.notebook_runs.insert(&run_id, ctrl_tx);

    let on_event_clone = on_event.clone();
    tokio::spawn(async move {
        while let Some(ev) = ev_rx.recv().await {
            let _ = on_event_clone.send(ev);
        }
    });

    // Pick the executor: SSH-direct when a connection is supplied, else the
    // legacy OSC-133 PTY runner.
    let pty: Arc<dyn PtyExecutor> = match &connection_id {
        Some(conn_id) => {
            let (target, _name) = crate::ssh_exec::resolve_target(&state.db, conn_id, password)?;
            Arc::new(crate::ssh_exec::SshPtyExecutor::from_target(target))
        }
        None => build_pty_executor(&state),
    };
    let vendor = dto
        .frontmatter
        .vendor
        .clone()
        .unwrap_or_else(|| "generic".into());
    let platform = dto
        .frontmatter
        .platform
        .clone()
        .unwrap_or_else(|| "generic".into());
    let assertions =
        build_assertion_evaluator(&state, pty.clone(), vendor.clone(), platform.clone());
    let guardrail = build_notebook_guardrail(&state, &tab_id, vendor, platform);

    let nb = Notebook {
        frontmatter: dto.frontmatter,
        cells: dto.cells,
        body_markdown: dto.body_markdown,
    };

    let runner_handle = NotebookRunner {
        cfg: RunnerConfig {
            run_id: run_id.clone(),
            notebook_id,
            tab_id,
            start_at_idx,
        },
        notebook: nb,
        params: params_map,
        ctrl_rx,
        event_tx: ev_tx,
    };

    let ctx = RunnerContext {
        db: state.db.clone(),
        pty,
        assertions,
        guardrail,
    };

    let registry = state.notebook_runs.clone();
    let run_id_for_cleanup = run_id.clone();
    tokio::spawn(async move {
        let _ = runner_handle.run(ctx).await;
        registry.remove(&run_id_for_cleanup);
    });

    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RunStatusDto {
    pub run_id: String,
    pub status: String,
    pub current_cell_idx: Option<i64>,
    pub cell_statuses: Vec<CellStatusRow>,
    pub params_json: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CellStatusRow {
    pub cell_idx: i64,
    pub status: String,
    pub block_id: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn notebook_run_status(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<RunStatusDto, String> {
    let conn = state.db.lock();
    let (status, params_json): (String, String) = conn
        .query_row(
            "SELECT status, params_json FROM notebook_runs WHERE id = ?1",
            rusqlite::params![run_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT cell_idx, status, block_id, error FROM notebook_cell_runs
             WHERE run_id = ?1 ORDER BY cell_idx ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![run_id], |r| {
            Ok(CellStatusRow {
                cell_idx: r.get(0)?,
                status: r.get(1)?,
                block_id: r.get(2)?,
                error: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let current_cell_idx = rows
        .iter()
        .find(|r| {
            r.status == CellStatus::Running.as_str()
                || r.status == CellStatus::AwaitingApproval.as_str()
        })
        .map(|r| r.cell_idx);

    Ok(RunStatusDto {
        run_id,
        status,
        current_cell_idx,
        cell_statuses: rows,
        params_json,
    })
}
