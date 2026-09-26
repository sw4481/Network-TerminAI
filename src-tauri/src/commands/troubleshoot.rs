//! Plan 15 Phase 1 — Tauri commands for the troubleshooting playbook
//! catalogue.
//!
//! Phase 1 ships CRUD only. Phase 2 will add `start_run` /
//! `pause_run` / `resume_run` / `cancel_run` / `answer_prompt` here as
//! well; that's why this file lives in `commands/` (alongside `vault.rs`
//! and `recording.rs`) rather than under the engine module.
//!
//! ## Builtin protection
//!
//! `delete_playbook` refuses rows with `builtin = 1`. `upsert_playbook`
//! always writes with `builtin = 0` and on conflict only overwrites rows
//! whose existing builtin flag is 0 — so a user CANNOT accidentally (or
//! intentionally, from this surface) clobber a shipped playbook. The
//! seed loader is the only path that writes `builtin = 1`.
//!
//! ## Validation
//!
//! `upsert_playbook` parses the YAML through `Playbook::parse_yaml`
//! before persisting, so structurally-broken or unknown-field YAML never
//! reaches the DB. The Phase 6 Monaco editor will additionally surface
//! the sidecar's loader errors live; this server-side parse is the
//! load-bearing one because the editor schema can be bypassed.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use super::AppState;
use crate::agent_bridge::AgentResponse;
use crate::troubleshoot::context::{RunContext, RunStatus, StepResult};
use crate::troubleshoot::engine::{run_tree, run_tree_from, StepExecutor};
use crate::troubleshoot::narrator_bridge::{
    is_terminal, produce_conclusion, LiveNarratorBridge, NarratorBridge,
};
use crate::troubleshoot::playbook::Playbook;

/// Lightweight metadata row returned by [`list_playbooks`]. Frontend uses
/// this to render the picker without paying the cost of loading every
/// `body_yaml` blob up front.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybookMeta {
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub platform: String,
    pub symptom_keywords: Vec<String>,
    pub builtin: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Return the catalogue of available playbooks ordered builtin-first
/// (so the picker shows the curated set on top), then by name.
#[tauri::command]
pub async fn list_playbooks(state: State<'_, AppState>) -> Result<Vec<PlaybookMeta>, String> {
    let conn = state.db.lock();
    let mut stmt = conn
        .prepare(
            "SELECT id, name, vendor, platform, symptom_keywords, builtin, created_at, updated_at
               FROM troubleshoot_playbooks
              ORDER BY builtin DESC, name ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let keywords_json: String = r.get(4)?;
            let keywords: Vec<String> = serde_json::from_str(&keywords_json).unwrap_or_default();
            let builtin: i64 = r.get(5)?;
            Ok(PlaybookMeta {
                id: r.get(0)?,
                name: r.get(1)?,
                vendor: r.get(2)?,
                platform: r.get(3)?,
                symptom_keywords: keywords,
                builtin: builtin != 0,
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Return the raw YAML body for a single playbook so the editor / engine
/// can re-parse it. We deliberately don't return the parsed `Playbook`
/// struct from this command — the engine and the editor each have their
/// own parse paths and we want a single source of truth (the YAML).
#[tauri::command]
pub async fn get_playbook(id: String, state: State<'_, AppState>) -> Result<String, String> {
    let conn = state.db.lock();
    conn.query_row(
        "SELECT body_yaml FROM troubleshoot_playbooks WHERE id = ?1",
        params![id],
        |r| r.get::<_, String>(0),
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => format!("playbook not found: {id}"),
        other => other.to_string(),
    })
}

/// Insert or update a USER playbook (always `builtin = 0`).
///
/// * Re-parses + cross-checks via `Playbook::parse_yaml`. Note: serde_yaml
///   alone enforces the structural shape but NOT cross-references; the
///   sidecar's `yaml_loader.py` provides the full check, and Phase 6
///   wires this command to the sidecar `parse_playbook` NDJSON method
///   for parity. For Phase 1 the structural parse is enough — Phase 6
///   tightens this and adds an explicit user-flow regression test.
/// * Refuses to overwrite `builtin = 1` rows: the `WHERE builtin = 0`
///   clause on the UPSERT silently no-ops, then the post-write SELECT
///   verifies the row really is the user's.
#[tauri::command]
pub async fn upsert_playbook(
    id: String,
    body_yaml: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Validate: parse the YAML through our Rust mirror of the schema.
    // Anything that would crash the engine fails here loudly with a
    // human-readable serde message.
    let pb = Playbook::parse_yaml(&body_yaml).map_err(|e| format!("invalid playbook: {e}"))?;
    if pb.id != id {
        return Err(format!(
            "id mismatch: command argument '{id}' vs body 'id: {}' field",
            pb.id
        ));
    }

    let conn = state.db.lock();

    // Refuse to overwrite a builtin via this command surface.
    let existing_builtin: Option<i64> = conn
        .query_row(
            "SELECT builtin FROM troubleshoot_playbooks WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .ok();
    if let Some(b) = existing_builtin {
        if b == 1 {
            return Err(format!(
                "playbook '{id}' is a builtin and cannot be overwritten via upsert"
            ));
        }
    }

    let keywords = serde_json::to_string(&pb.symptom_keywords).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO troubleshoot_playbooks
             (id, name, symptom_keywords, vendor, platform, body_yaml, builtin)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)
         ON CONFLICT(id) DO UPDATE SET
             name             = excluded.name,
             symptom_keywords = excluded.symptom_keywords,
             vendor           = excluded.vendor,
             platform         = excluded.platform,
             body_yaml        = excluded.body_yaml,
             updated_at       = strftime('%s','now')
         WHERE builtin = 0",
        params![pb.id, pb.name, keywords, pb.vendor, pb.platform, body_yaml],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// =====================================================================
// Phase 2 — run lifecycle commands.
// =====================================================================

/// Row + steps representation used by [`get_run`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunDetails {
    pub run_id: String,
    pub playbook_id: String,
    pub tab_id: String,
    pub symptom: String,
    pub status: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub conclusion_json: Option<serde_json::Value>,
    pub steps: Vec<StoredStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredStep {
    pub idx: i64,
    pub step_type: String,
    pub step_ref: String,
    pub status: String,
    pub result_json: Option<serde_json::Value>,
    pub parent_idx: Option<i64>,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
}

/// Convert a [`StepResult`] into the SQL fields. The `step_type`
/// column is inferred from the playbook's step variant — passed
/// through as a separate arg so we don't have to round-trip
/// through the playbook to figure it out.
fn persist_step_result<R: tauri::Runtime>(
    db: &Arc<parking_lot::Mutex<rusqlite::Connection>>,
    app: &tauri::AppHandle<R>,
    run_id: &str,
    step_type: &str,
    result: &StepResult,
) -> rusqlite::Result<()> {
    let conn = db.lock();
    // Per-step transaction: BEGIN…COMMIT around a single
    // INSERT…ON CONFLICT UPDATE so a panic mid-driver leaves the
    // table consistent.
    let tx_begin = conn.execute("BEGIN", [])?;
    let _ = tx_begin;
    let result_json = serde_json::to_string(&result.result_json).unwrap_or_else(|_| "null".into());
    let res = conn.execute(
        "INSERT INTO troubleshoot_steps
            (run_id, idx, step_type, step_ref, status, result_json,
             parent_idx, started_at, ended_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL,
                 strftime('%s','now'), strftime('%s','now'))
         ON CONFLICT(run_id, idx) DO UPDATE SET
             status      = excluded.status,
             result_json = excluded.result_json,
             ended_at    = strftime('%s','now')",
        params![
            run_id,
            result.idx,
            step_type,
            result.step_id,
            result.status.as_str(),
            result_json,
        ],
    );
    match res {
        Ok(_) => {
            let _ = conn.execute("COMMIT", []);
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", []);
            return Err(e);
        }
    }
    drop(conn);
    let _ = app.emit(
        "troubleshoot:step_update",
        serde_json::json!({
            "run_id": run_id,
            "step": result,
            "step_type": step_type,
        }),
    );
    Ok(())
}

/// Phase 2 placeholder for SSH transport.
///
/// The real SSH transport is the per-tab session abstraction
/// from `session.rs`; wiring it requires a tab session to be
/// present, which is per-runtime state. Phase 2 ships the
/// engine + guardrail enforcement; the transport lands in a
/// follow-up. Calling this from a real run produces a clear
/// error rather than silently succeeding.
struct UnimplementedSsh;

#[async_trait::async_trait]
impl crate::troubleshoot::live_executor::SshExec for UnimplementedSsh {
    async fn exec(&self, _tab_id: &str, _command: &str) -> anyhow::Result<String> {
        anyhow::bail!(
            "troubleshoot SSH transport not yet wired: pass a connection_id to \
             start_run/resume_run to run over SSH"
        )
    }
}

/// Build the playbook's SSH transport: a direct one-shot SSH executor when a
/// saved connection is supplied, else the explicit-error stub.
fn build_troubleshoot_ssh(
    state: &AppState,
    connection_id: &Option<String>,
    password: Option<String>,
) -> Result<Arc<dyn crate::troubleshoot::live_executor::SshExec>, String> {
    match connection_id {
        Some(conn_id) => {
            let (target, _name) = crate::ssh_exec::resolve_target(&state.db, conn_id, password)?;
            Ok(Arc::new(crate::ssh_exec::TroubleshootSshExec::from_target(
                target,
            )))
        }
        None => Ok(Arc::new(UnimplementedSsh)),
    }
}

/// Look up the YAML step variant for a `step_id` so we can write
/// the right `step_type` column.
fn step_type_for(pb: &Playbook, step_id: &str) -> &'static str {
    use crate::troubleshoot::playbook::Step;
    match pb.find_step(step_id) {
        Some(Step::Command { .. }) => "command",
        Some(Step::Assertion { .. }) => "assertion",
        Some(Step::Branch { .. }) => "branch",
        Some(Step::Narration { .. }) => "narration",
        Some(Step::UserPrompt { .. }) => "user_prompt",
        None => "unknown",
    }
}

/// Spawn the engine task. `start_at` is `None` for fresh starts
/// and `Some(step_id)` for resumes.
///
/// Phase 3 — `narrator_bridge` is invoked once on terminal status
/// (Completed/Failed) to call `troubleshoot.conclude` and persist
/// the result into `troubleshoot_runs.conclusion_json`. The caller
/// supplies the bridge so tests can inject a mock without spinning
/// up a real sidecar.
#[allow(clippy::too_many_arguments)]
async fn spawn_engine_task<R: tauri::Runtime>(
    app: AppHandle<R>,
    db: Arc<parking_lot::Mutex<rusqlite::Connection>>,
    troubleshoot: Arc<crate::troubleshoot::state::TroubleshootState>,
    pb: Playbook,
    run_id: String,
    tab_id: String,
    symptom: String,
    vars: HashMap<String, serde_json::Value>,
    last_parsed: Option<serde_json::Value>,
    start_at: Option<String>,
    start_idx: i64,
    exec: Arc<dyn StepExecutor>,
    narrator_bridge: Arc<dyn NarratorBridge>,
) {
    let handle = troubleshoot.register(&run_id);
    let join = tokio::spawn({
        let app = app.clone();
        let db = db.clone();
        let pb = pb.clone();
        let run_id = run_id.clone();
        let troubleshoot = troubleshoot.clone();
        async move {
            let mut ctx = RunContext::new(run_id.clone(), tab_id.clone(), vars);
            ctx.last_parsed = last_parsed;

            // Phase 3 — collect the run's StepResults + their step_type
            // tags as we go, so we can build the conclusion payload
            // after the engine returns. Wrapped in a `Mutex` because
            // the engine's `record` closure is `FnMut` but the
            // surrounding async block treats it as a move closure.
            let history: Arc<parking_lot::Mutex<Vec<(StepResult, &'static str)>>> =
                Arc::new(parking_lot::Mutex::new(Vec::new()));

            let pb_for_record = pb.clone();
            let app_for_record = app.clone();
            let db_for_record = db.clone();
            let run_id_for_record = run_id.clone();
            let history_for_record = history.clone();
            let result = if start_at.is_some() {
                run_tree_from(
                    &pb,
                    &mut ctx,
                    exec,
                    start_at,
                    start_idx,
                    move |r: &StepResult| {
                        let step_type = step_type_for(&pb_for_record, &r.step_id);
                        history_for_record.lock().push((r.clone(), step_type));
                        persist_step_result(
                            &db_for_record,
                            &app_for_record,
                            &run_id_for_record,
                            step_type,
                            r,
                        )
                        .map_err(|e| anyhow::anyhow!(e))
                    },
                )
                .await
            } else {
                run_tree(&pb, &mut ctx, exec, move |r: &StepResult| {
                    let step_type = step_type_for(&pb_for_record, &r.step_id);
                    history_for_record.lock().push((r.clone(), step_type));
                    persist_step_result(
                        &db_for_record,
                        &app_for_record,
                        &run_id_for_record,
                        step_type,
                        r,
                    )
                    .map_err(|e| anyhow::anyhow!(e))
                })
                .await
            };

            let final_status = match (result.as_ref(), ctx.status) {
                (Err(_), _) => RunStatus::Failed,
                (Ok(_), s) => s,
            };

            // Persist status + ended_at for terminal states; for
            // Paused, only update status (ended_at stays NULL).
            {
                let conn = db.lock();
                let ended = matches!(final_status, RunStatus::Completed | RunStatus::Failed);
                if ended {
                    let _ = conn.execute(
                        "UPDATE troubleshoot_runs
                            SET status = ?1, ended_at = strftime('%s','now')
                          WHERE id = ?2",
                        params![final_status.as_str(), run_id],
                    );
                } else {
                    let _ = conn.execute(
                        "UPDATE troubleshoot_runs SET status = ?1 WHERE id = ?2",
                        params![final_status.as_str(), run_id],
                    );
                }
            }

            // Phase 3 — produce + persist + emit a run conclusion.
            // ONLY on terminal status. Paused runs may resume later.
            if is_terminal(final_status) {
                let snapshot: Vec<(StepResult, &'static str)> = {
                    let h = history.lock();
                    h.clone()
                };
                let results: Vec<StepResult> = snapshot.iter().map(|(r, _)| r.clone()).collect();
                let types: Vec<&str> = snapshot.iter().map(|(_, t)| *t).collect();

                let conclusion = produce_conclusion(
                    narrator_bridge.as_ref(),
                    &run_id,
                    &symptom,
                    &pb.vendor,
                    &pb.platform,
                    final_status,
                    &results,
                    &types,
                )
                .await;
                let conclusion_str =
                    serde_json::to_string(&conclusion).unwrap_or_else(|_| "{}".to_string());

                {
                    let conn = db.lock();
                    let _ = conn.execute(
                        "UPDATE troubleshoot_runs SET conclusion_json = ?1 WHERE id = ?2",
                        params![conclusion_str, run_id],
                    );
                }

                let _ = app.emit(
                    "troubleshoot:conclusion",
                    serde_json::json!({
                        "run_id": run_id,
                        "conclusion": conclusion,
                    }),
                );
            }

            let _ = app.emit(
                "troubleshoot:status",
                serde_json::json!({
                    "run_id": run_id,
                    "status": final_status.as_str(),
                }),
            );

            // Drop the registry entry on terminal status.
            if matches!(final_status, RunStatus::Completed | RunStatus::Failed) {
                troubleshoot.remove(&run_id);
            }
        }
    });
    *handle.task.lock() = Some(join);
}

/// Start a fresh run.
///
/// Phase 2 limitation: actually wiring SSH requires a per-tab
/// session handle from `session.rs`; we plumb the executor here
/// but the SSH transport is the existing Plan 03 PTY runner —
/// for tabs without a live session, the run will fail at
/// `run_command`. Tests use the engine directly with a
/// MockExecutor; this command targets real interactive use only.
#[tauri::command]
pub async fn start_run(
    playbook_id: String,
    tab_id: String,
    symptom: String,
    vars: serde_json::Value,
    state: State<'_, AppState>,
    app: AppHandle,
    // SSH-direct execution (Plan 15 over interactive SSH): supply a saved
    // connection id (and optional prompted password) to run the playbook's
    // commands over one-shot SSH. Omit and the run uses the explicit-error
    // stub (no transport wired), preserving prior behaviour.
    connection_id: Option<String>,
    password: Option<String>,
) -> Result<String, String> {
    // Load the YAML out of the catalogue.
    let yaml_text: String = {
        let conn = state.db.lock();
        conn.query_row(
            "SELECT body_yaml FROM troubleshoot_playbooks WHERE id = ?1",
            params![playbook_id],
            |r| r.get::<_, String>(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => format!("playbook not found: {playbook_id}"),
            other => other.to_string(),
        })?
    };
    let pb = Playbook::parse_yaml(&yaml_text).map_err(|e| format!("invalid playbook: {e}"))?;

    let run_id = uuid::Uuid::new_v4().to_string();

    // Insert run row.
    {
        let conn = state.db.lock();
        conn.execute(
            "INSERT INTO troubleshoot_runs (id, playbook_id, tab_id, symptom, status)
             VALUES (?1, ?2, ?3, ?4, 'running')",
            params![run_id, playbook_id, tab_id, symptom],
        )
        .map_err(|e| e.to_string())?;
    }

    // Build the executor. The production wiring uses the Plan 03
    // PTY runner — but that surface is per-tab and requires a
    // live session. For Phase 2 we keep the catalogue commands
    // wired but the transport is left as a follow-up; the engine
    // and the guardrail gate are exercised by the dedicated
    // unit + enforcement tests. A no-op SSH executor returns an
    // explicit error so a stray attempt to drive a real run from
    // the UI surfaces a clear message rather than silently
    // succeeding.
    let ssh = build_troubleshoot_ssh(&state, &connection_id, password)?;
    let exec: Arc<dyn StepExecutor> =
        Arc::new(crate::troubleshoot::live_executor::LiveStepExecutor::new(
            state.agent.clone(),
            state.guardrails_ruleset.clone(),
            state.parser_bridge.clone(),
            ssh,
            pb.vendor.clone(),
            pb.platform.clone(),
            app.clone(),
        ));

    let vars_map: HashMap<String, serde_json::Value> = match vars {
        serde_json::Value::Object(m) => m.into_iter().collect(),
        serde_json::Value::Null => HashMap::new(),
        _ => return Err("vars must be an object or null".into()),
    };

    let narrator: Arc<dyn NarratorBridge> = Arc::new(LiveNarratorBridge::new(state.agent.clone()));

    spawn_engine_task(
        app,
        state.db.clone(),
        state.troubleshoot.clone(),
        pb,
        run_id.clone(),
        tab_id,
        symptom,
        vars_map,
        None,
        None,
        0,
        exec,
        narrator,
    )
    .await;

    Ok(run_id)
}

#[tauri::command]
pub async fn pause_run(
    run_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    if let Some(h) = state.troubleshoot.get(&run_id) {
        h.cancel_flag
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
    {
        let conn = state.db.lock();
        conn.execute(
            "UPDATE troubleshoot_runs SET status = 'paused' WHERE id = ?1",
            params![run_id],
        )
        .map_err(|e| e.to_string())?;
    }
    let _ = app.emit(
        "troubleshoot:status",
        serde_json::json!({"run_id": run_id, "status": "paused"}),
    );
    Ok(())
}

#[tauri::command]
pub async fn resume_run(
    run_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
    connection_id: Option<String>,
    password: Option<String>,
) -> Result<(), String> {
    // Look up the run row + last persisted step to figure out
    // where to resume.
    let (playbook_id, tab_id, symptom, last_idx, last_step_id, last_result_json): (
        String,
        String,
        String,
        Option<i64>,
        Option<String>,
        Option<String>,
    ) = {
        let conn = state.db.lock();
        let pb_row: (String, String, String) = conn
            .query_row(
                "SELECT playbook_id, tab_id, symptom FROM troubleshoot_runs WHERE id = ?1",
                params![run_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| e.to_string())?;
        let last: Option<(i64, String, Option<String>)> = conn
            .query_row(
                "SELECT idx, step_ref, result_json
                   FROM troubleshoot_steps
                  WHERE run_id = ?1
                  ORDER BY idx DESC
                  LIMIT 1",
                params![run_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok();
        let (a, b, c) = match last {
            Some((i, sid, rj)) => (Some(i), Some(sid), rj),
            None => (None, None, None),
        };
        (pb_row.0, pb_row.1, pb_row.2, a, b, c)
    };

    let yaml_text: String = {
        let conn = state.db.lock();
        conn.query_row(
            "SELECT body_yaml FROM troubleshoot_playbooks WHERE id = ?1",
            params![playbook_id],
            |r| r.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())?
    };
    let pb = Playbook::parse_yaml(&yaml_text).map_err(|e| format!("invalid playbook: {e}"))?;

    // Resume strategy: re-run from the step AFTER the last
    // persisted one in linear order (or from the natural follow
    // if branch). For Phase 2 we keep this simple — start from
    // the next step in pb.steps.
    let start_at = match last_step_id {
        Some(sid) => {
            let pos = pb.steps.iter().position(|s| s.id() == sid);
            pos.and_then(|p| pb.steps.get(p + 1).map(|s| s.id().to_string()))
        }
        None => pb.steps.first().map(|s| s.id().to_string()),
    };
    let start_idx = last_idx.map(|v| v + 1).unwrap_or(0);
    let last_parsed: Option<serde_json::Value> =
        last_result_json.and_then(|j| serde_json::from_str(&j).ok());

    {
        let conn = state.db.lock();
        conn.execute(
            "UPDATE troubleshoot_runs SET status = 'running' WHERE id = ?1",
            params![run_id],
        )
        .map_err(|e| e.to_string())?;
    }
    let _ = app.emit(
        "troubleshoot:status",
        serde_json::json!({"run_id": run_id, "status": "running"}),
    );

    if start_at.is_none() {
        // Nothing left to do — mark Completed.
        let conn = state.db.lock();
        conn.execute(
            "UPDATE troubleshoot_runs
                SET status = 'completed', ended_at = strftime('%s','now')
              WHERE id = ?1",
            params![run_id],
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let ssh = build_troubleshoot_ssh(&state, &connection_id, password)?;
    let exec: Arc<dyn StepExecutor> =
        Arc::new(crate::troubleshoot::live_executor::LiveStepExecutor::new(
            state.agent.clone(),
            state.guardrails_ruleset.clone(),
            state.parser_bridge.clone(),
            ssh,
            pb.vendor.clone(),
            pb.platform.clone(),
            app.clone(),
        ));

    let narrator: Arc<dyn NarratorBridge> = Arc::new(LiveNarratorBridge::new(state.agent.clone()));

    spawn_engine_task(
        app,
        state.db.clone(),
        state.troubleshoot.clone(),
        pb,
        run_id,
        tab_id,
        symptom,
        HashMap::new(),
        last_parsed,
        start_at,
        start_idx,
        exec,
        narrator,
    )
    .await;
    Ok(())
}

#[tauri::command]
pub async fn cancel_run(
    run_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    if let Some(h) = state.troubleshoot.get(&run_id) {
        h.cancel_flag
            .store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(task) = h.task.lock().take() {
            task.abort();
        }
    }
    {
        let conn = state.db.lock();
        // Mark all pending/running steps as skipped.
        let _ = conn.execute(
            "UPDATE troubleshoot_steps
                SET status = 'skipped'
              WHERE run_id = ?1 AND status IN ('pending','running','awaiting_user')",
            params![run_id],
        );
        conn.execute(
            "UPDATE troubleshoot_runs
                SET status = 'failed', ended_at = strftime('%s','now')
              WHERE id = ?1",
            params![run_id],
        )
        .map_err(|e| e.to_string())?;
    }
    state.troubleshoot.remove(&run_id);
    let _ = app.emit(
        "troubleshoot:status",
        serde_json::json!({"run_id": run_id, "status": "failed", "reason": "cancelled"}),
    );
    Ok(())
}

/// Phase 2 lifecycle: capture an operator's answer to the most
/// recent `awaiting_user` step and continue.
///
/// Strategy:
/// 1. Mark the awaiting step as `passed` with the answer
///    captured into `result_json`.
/// 2. Set the run row back to `running`.
/// 3. Emit `troubleshoot:status` so the UI clears the modal.
///
/// Phase 2 deliberately does NOT auto-resume execution from
/// here; the operator presses Resume (which calls `resume_run`)
/// to drive the next steps. This keeps the security invariant
/// crystal-clear: a paused Tier-1+ command CANNOT be unpaused
/// just by clicking past a prompt — the operator has to
/// explicitly invoke `resume_run` after acknowledging the gate.
#[tauri::command]
pub async fn answer_prompt(
    run_id: String,
    answer: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    {
        let conn = state.db.lock();
        let row: Option<(i64, String)> = conn
            .query_row(
                "SELECT idx, step_ref FROM troubleshoot_steps
                  WHERE run_id = ?1 AND status = 'awaiting_user'
                  ORDER BY idx DESC LIMIT 1",
                params![run_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        if let Some((idx, _step_ref)) = row {
            let result_json = serde_json::to_string(&serde_json::json!({"answer": answer}))
                .unwrap_or_else(|_| "{}".into());
            conn.execute(
                "UPDATE troubleshoot_steps
                    SET status = 'passed', result_json = ?1, ended_at = strftime('%s','now')
                  WHERE run_id = ?2 AND idx = ?3",
                params![result_json, run_id, idx],
            )
            .map_err(|e| e.to_string())?;
        }
        conn.execute(
            "UPDATE troubleshoot_runs SET status = 'paused' WHERE id = ?1",
            params![run_id],
        )
        .map_err(|e| e.to_string())?;
    }
    let _ = app.emit(
        "troubleshoot:status",
        serde_json::json!({
            "run_id": run_id,
            "status": "paused",
            "reason": "answered; awaiting explicit resume",
        }),
    );
    Ok(())
}

#[tauri::command]
pub async fn mark_root_cause(
    run_id: String,
    step_idx: i64,
    note: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock();
    // Read existing result_json, merge `root_cause` into it,
    // write back. Conclusion_json on the run mirrors the note for
    // quick lookup.
    let existing: Option<String> = conn
        .query_row(
            "SELECT result_json FROM troubleshoot_steps
              WHERE run_id = ?1 AND idx = ?2",
            params![run_id, step_idx],
            |r| r.get(0),
        )
        .ok();
    let mut value: serde_json::Value = existing
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(map) = value.as_object_mut() {
        map.insert(
            "root_cause".to_string(),
            serde_json::Value::String(note.clone()),
        );
    }
    let result_json = serde_json::to_string(&value).unwrap_or_else(|_| "{}".into());
    conn.execute(
        "UPDATE troubleshoot_steps SET result_json = ?1
          WHERE run_id = ?2 AND idx = ?3",
        params![result_json, run_id, step_idx],
    )
    .map_err(|e| e.to_string())?;

    let conclusion = serde_json::json!({
        "root_cause": note,
        "step_idx": step_idx,
    });
    let conclusion_json = serde_json::to_string(&conclusion).unwrap_or_else(|_| "{}".into());
    conn.execute(
        "UPDATE troubleshoot_runs SET conclusion_json = ?1 WHERE id = ?2",
        params![conclusion_json, run_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_run(run_id: String, state: State<'_, AppState>) -> Result<RunDetails, String> {
    let conn = state.db.lock();
    let (playbook_id, tab_id, symptom, status, started_at, ended_at, conclusion_json): (
        String,
        String,
        String,
        String,
        i64,
        Option<i64>,
        Option<String>,
    ) = conn
        .query_row(
            "SELECT playbook_id, tab_id, symptom, status, started_at, ended_at, conclusion_json
               FROM troubleshoot_runs WHERE id = ?1",
            params![run_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            },
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => format!("run not found: {run_id}"),
            other => other.to_string(),
        })?;

    let conclusion = conclusion_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());

    let mut stmt = conn
        .prepare(
            "SELECT idx, step_type, step_ref, status, result_json,
                    parent_idx, started_at, ended_at
               FROM troubleshoot_steps WHERE run_id = ?1 ORDER BY idx ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![run_id], |r| {
            let result_json_text: Option<String> = r.get(4)?;
            let result_json = result_json_text
                .as_deref()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
            Ok(StoredStep {
                idx: r.get(0)?,
                step_type: r.get(1)?,
                step_ref: r.get(2)?,
                status: r.get(3)?,
                result_json,
                parent_idx: r.get(5)?,
                started_at: r.get(6)?,
                ended_at: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut steps = Vec::new();
    for row in rows {
        steps.push(row.map_err(|e| e.to_string())?);
    }

    Ok(RunDetails {
        run_id,
        playbook_id,
        tab_id,
        symptom,
        status,
        started_at,
        ended_at,
        conclusion_json: conclusion,
        steps,
    })
}

// =====================================================================
// Phase 5 — Symptom-to-playbook matcher.
// =====================================================================

/// Single match result returned by [`match_symptom`].
///
/// Mirrors the sidecar's matcher payload. ``score`` is roughly in
/// [0, 1]; the UI enforces the 0.35 threshold for a "good match".
/// ``reasons`` is human-readable text (e.g. "keyword 'bgp' matched")
/// rendered as chips beside each suggestion.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchResult {
    pub id: String,
    pub score: f64,
    pub reasons: Vec<String>,
}

/// Rank the playbook catalogue against a free-form symptom string.
///
/// We load every playbook (parsed from `body_yaml` so the sidecar can
/// see `description` + `symptom_keywords` directly) and forward to the
/// sidecar's `troubleshoot.match_symptom` handler. The sidecar runs
/// BM25 + embedding cosine + vendor/platform filtering; we just shuttle
/// the typed result back to the UI.
///
/// `vendor` / `platform` may be empty strings — the sidecar treats
/// those as wildcards.
#[tauri::command]
pub async fn match_symptom(
    symptom: String,
    vendor: Option<String>,
    platform: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<MatchResult>, String> {
    // Load every playbook body and parse it. The matcher needs the
    // full {id, name, symptom_keywords, vendor, platform, description}
    // tuple — the lightweight `PlaybookMeta` row doesn't carry the
    // description, so we reach into `body_yaml`.
    let yaml_blobs: Vec<String> = {
        let conn = state.db.lock();
        let mut stmt = conn
            .prepare("SELECT body_yaml FROM troubleshoot_playbooks")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        out
    };

    let mut playbooks_payload: Vec<serde_json::Value> = Vec::with_capacity(yaml_blobs.len());
    for yaml_text in &yaml_blobs {
        // We only forward a slim projection — keeps the NDJSON
        // payload small even for catalogues with hundreds of
        // playbooks. Skip any blob that fails to parse so a single
        // corrupt user playbook doesn't take down the whole matcher.
        let pb = match Playbook::parse_yaml(yaml_text) {
            Ok(p) => p,
            Err(_) => continue,
        };
        playbooks_payload.push(serde_json::json!({
            "id": pb.id,
            "name": pb.name,
            "symptom_keywords": pb.symptom_keywords,
            "vendor": pb.vendor,
            "platform": pb.platform,
            "description": pb.description.unwrap_or_default(),
        }));
    }

    let payload = serde_json::json!({
        "symptom": symptom,
        "vendor": vendor,
        "platform": platform,
        "playbooks": playbooks_payload,
    });

    let response = state
        .agent
        .call("troubleshoot.match_symptom", payload)
        .await
        .map_err(|e| format!("sidecar bridge error: {e}"))?;

    match response {
        AgentResponse::Done { result } => {
            // Expected shape: `{ "matches": [{ id, score, reasons }, ...] }`.
            let matches_value = result
                .get("matches")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let matches: Vec<MatchResult> =
                serde_json::from_value(matches_value).unwrap_or_default();
            Ok(matches)
        }
        AgentResponse::Error { message } => Err(format!("matcher error: {message}")),
        AgentResponse::Token { .. } => Ok(Vec::new()),
    }
}

/// Result of AI playbook generation: the YAML buffer plus an optional
/// soft warning (e.g. schema violation) the editor can surface without
/// discarding the generated text.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratedPlaybook {
    pub yaml: String,
    pub error: Option<String>,
}

/// Playbook editor "Generate with AI" — author a schema-valid playbook
/// YAML from a free-form symptom using the Settings-page LLM (same
/// provider config the chat panel uses).
#[tauri::command]
pub async fn generate_playbook(
    symptom: String,
    vendor: Option<String>,
    platform: Option<String>,
    state: State<'_, AppState>,
) -> Result<GeneratedPlaybook, String> {
    let payload = serde_json::json!({
        "symptom": symptom,
        "vendor": vendor,
        "platform": platform,
    });

    let response = state
        .agent
        .call("troubleshoot.generate_playbook", payload)
        .await
        .map_err(|e| format!("sidecar bridge error: {e}"))?;

    match response {
        AgentResponse::Done { result } => {
            let yaml = result
                .get("yaml")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let error = result
                .get("error")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            if yaml.is_empty() {
                return Err(
                    error.unwrap_or_else(|| "AI generation returned no playbook".to_string())
                );
            }
            Ok(GeneratedPlaybook { yaml, error })
        }
        AgentResponse::Error { message } => Err(format!("generation error: {message}")),
        AgentResponse::Token { .. } => {
            Err("unexpected streaming token from generate_playbook".to_string())
        }
    }
}

/// Delete a USER playbook. Refuses to delete builtins.
#[tauri::command]
pub async fn delete_playbook(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock();
    let builtin: Option<i64> = conn
        .query_row(
            "SELECT builtin FROM troubleshoot_playbooks WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .ok();
    match builtin {
        None => Err(format!("playbook not found: {id}")),
        Some(1) => Err(format!(
            "playbook '{id}' is a builtin and cannot be deleted"
        )),
        Some(_) => {
            conn.execute(
                "DELETE FROM troubleshoot_playbooks WHERE id = ?1 AND builtin = 0",
                params![id],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        }
    }
}
