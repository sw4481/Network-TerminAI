use crate::agent_bridge::AgentBridge;
use crate::agents::{Agent, AgentsLoader};
use crate::commands::AppState;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanTask {
    pub id: String,
    pub title: String,
    pub details: String,
    pub pane_context: Option<String>,
    pub completion_mode: String,
    pub status: String,
    pub assigned_agent: Option<String>,
    pub result: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanRun {
    pub id: String,
    pub task_id: String,
    pub generation: i64,
    pub attempt: i64,
    pub status: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanActivity {
    pub id: String,
    pub task_id: String,
    pub run_id: Option<String>,
    pub kind: String,
    pub message: String,
    pub metadata: Value,
    pub created_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateKanbanTask {
    pub title: String,
    pub details: String,
    pub pane_context: Option<String>,
    pub completion_mode: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KanbanTaskDetail {
    pub task: KanbanTask,
    pub runs: Vec<KanbanRun>,
    pub activity: Vec<KanbanActivity>,
}

struct KanbanRepo;

impl KanbanRepo {
    fn now() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }

    fn task(conn: &Connection, id: &str) -> rusqlite::Result<Option<KanbanTask>> {
        conn.query_row(
            "SELECT id,title,details,pane_context,completion_mode,status,assigned_agent,result,created_at,updated_at FROM kanban_tasks WHERE id=?1",
            [id],
            |r| Ok(KanbanTask {
                id: r.get(0)?, title: r.get(1)?, details: r.get(2)?, pane_context: r.get(3)?,
                completion_mode: r.get(4)?, status: r.get(5)?, assigned_agent: r.get(6)?, result: r.get(7)?,
                created_at: r.get(8)?, updated_at: r.get(9)?,
            }),
        ).optional()
    }

    fn activity(
        conn: &Connection,
        task_id: &str,
        run_id: Option<&str>,
        kind: &str,
        message: &str,
        metadata: Value,
    ) -> rusqlite::Result<KanbanActivity> {
        let activity = KanbanActivity {
            id: uuid::Uuid::new_v4().to_string(),
            task_id: task_id.to_string(),
            run_id: run_id.map(str::to_string),
            kind: kind.to_string(),
            message: message.to_string(),
            metadata: sanitize_value(metadata),
            created_at: Self::now(),
        };
        conn.execute(
            "INSERT INTO kanban_activity (id,task_id,run_id,kind,message,metadata,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![activity.id, activity.task_id, activity.run_id, activity.kind, activity.message, serde_json::to_string(&activity.metadata).unwrap_or_else(|_| "{}".into()), activity.created_at],
        )?;
        Ok(activity)
    }

    fn list(conn: &Connection) -> rusqlite::Result<Vec<KanbanTask>> {
        let mut stmt = conn.prepare("SELECT id,title,details,pane_context,completion_mode,status,assigned_agent,result,created_at,updated_at FROM kanban_tasks ORDER BY created_at DESC")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(KanbanTask {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    details: r.get(2)?,
                    pane_context: r.get(3)?,
                    completion_mode: r.get(4)?,
                    status: r.get(5)?,
                    assigned_agent: r.get(6)?,
                    result: r.get(7)?,
                    created_at: r.get(8)?,
                    updated_at: r.get(9)?,
                })
            })?
            .collect();
        rows
    }

    fn retry(conn: &Connection, id: &str) -> rusqlite::Result<usize> {
        conn.execute("UPDATE kanban_tasks SET status='ready',result=NULL,assigned_agent=NULL,retry_generation=retry_generation+1,next_attempt_at=0,updated_at=strftime('%s','now') WHERE id=?1 AND status IN ('blocked','cancelled','done','review')", [id])
    }

    fn detail(conn: &Connection, id: &str) -> rusqlite::Result<Option<KanbanTaskDetail>> {
        let Some(task) = Self::task(conn, id)? else {
            return Ok(None);
        };
        let mut runs_stmt = conn.prepare("SELECT id,task_id,generation,attempt,status,started_at,finished_at,error FROM kanban_runs WHERE task_id=?1 ORDER BY started_at DESC")?;
        let runs = runs_stmt
            .query_map([id], |r| {
                Ok(KanbanRun {
                    id: r.get(0)?,
                    task_id: r.get(1)?,
                    generation: r.get(2)?,
                    attempt: r.get(3)?,
                    status: r.get(4)?,
                    started_at: r.get(5)?,
                    finished_at: r.get(6)?,
                    error: r.get(7)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut activity_stmt = conn.prepare("SELECT id,task_id,run_id,kind,message,metadata,created_at FROM kanban_activity WHERE task_id=?1 ORDER BY created_at DESC LIMIT 250")?;
        let activity = activity_stmt
            .query_map([id], |r| {
                let raw: String = r.get(5)?;
                Ok(KanbanActivity {
                    id: r.get(0)?,
                    task_id: r.get(1)?,
                    run_id: r.get(2)?,
                    kind: r.get(3)?,
                    message: r.get(4)?,
                    metadata: serde_json::from_str(&raw).unwrap_or(Value::Null),
                    created_at: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Some(KanbanTaskDetail {
            task,
            runs,
            activity,
        }))
    }
}

fn sanitize_value(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter_map(|(key, value)| {
                    let normalized = key.to_ascii_lowercase().replace('-', "_");
                    let private = [
                        "password",
                        "secret",
                        "token",
                        "api_key",
                        "authorization",
                        "credential",
                        "private",
                        "payload",
                        "body",
                        "request_body",
                    ]
                    .iter()
                    .any(|needle| normalized.contains(needle));
                    (!private).then(|| (key, sanitize_value(value)))
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(sanitize_value).collect()),
        other => other,
    }
}

fn sanitize_text(value: &str) -> String {
    static CREDENTIAL: OnceLock<regex::Regex> = OnceLock::new();
    CREDENTIAL
        .get_or_init(|| {
            regex::Regex::new(
                r#"(?i)(api[_-]?key|password|secret|token|authorization)[\"']?\s*[:=]\s*[\"']?(?:bearer|basic)?\s*[^\s,;\"'}]+"#,
            )
            .expect("valid redaction pattern")
        })
        .replace_all(value, "$1=[REDACTED]")
        .into_owned()
}

fn retry_delay_seconds(attempt: i64) -> Option<i64> {
    match attempt {
        1 => Some(30),
        2 => Some(60),
        _ => None,
    }
}

fn tool_name_for_catalog(name: &str, agent_id: &str, tool_id: &str, collisions: usize) -> String {
    if collisions > 1 {
        format!("{agent_id}__{tool_id}__{name}")
    } else {
        name.to_string()
    }
}

fn namespace_catalog_entry(
    obj: &mut serde_json::Map<String, Value>,
    name: &str,
    agent_id: &str,
    tool_id: &str,
) {
    let namespaced = tool_name_for_catalog(name, agent_id, tool_id, 2);
    obj.insert("name".into(), json!(namespaced));
    if let Some(function) = obj.get_mut("function").and_then(Value::as_object_mut) {
        function.insert("name".into(), json!(namespaced));
    }
}

#[tauri::command]
pub fn kanban_list(state: tauri::State<'_, AppState>) -> Result<Vec<KanbanTask>, String> {
    KanbanRepo::list(&state.db.lock()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn kanban_create(
    input: CreateKanbanTask,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<KanbanTask, String> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err("Task title is required".into());
    }
    if title.len() > 240 {
        return Err("Task title must be 240 characters or fewer".into());
    }
    let completion = input.completion_mode.unwrap_or_else(|| "autonomous".into());
    if !["autonomous", "human_review"].contains(&completion.as_str()) {
        return Err("Invalid completion mode".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let task = {
        let conn = state.db.lock();
        conn.execute("INSERT INTO kanban_tasks (id,title,details,pane_context,completion_mode) VALUES (?1,?2,?3,?4,?5)", params![id,title,input.details,input.pane_context,completion]).map_err(|e| e.to_string())?;
        let _ = KanbanRepo::activity(
            &conn,
            &id,
            None,
            "created",
            "Task added to the board",
            json!({}),
        )
        .map_err(|e| e.to_string())?;
        KanbanRepo::task(&conn, &id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Created task was not found".to_string())?
    };
    let _ = app.emit(
        "kanban://task_activity",
        json!({"taskId":id,"kind":"created"}),
    );
    Ok(task)
}

#[tauri::command]
pub fn kanban_get(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<KanbanTaskDetail, String> {
    KanbanRepo::detail(&state.db.lock(), &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Kanban task not found".into())
}

fn transition_task(
    id: &str,
    target: &str,
    app: &tauri::AppHandle,
    state: &AppState,
) -> Result<(), String> {
    let conn = state.db.lock();
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM kanban_tasks WHERE id=?1)",
            [id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("Kanban task not found".into());
    }
    let changed = if target == "cancelled" {
        conn.execute("UPDATE kanban_tasks SET status=?2,updated_at=strftime('%s','now') WHERE id=?1 AND status IN ('ready','running')", params![id,target])
    } else {
        conn.execute("UPDATE kanban_tasks SET status=?2,updated_at=strftime('%s','now') WHERE id=?1", params![id,target])
    }.map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("Task cannot be stopped in its current state".into());
    }
    KanbanRepo::activity(
        &conn,
        id,
        None,
        target,
        &format!("Task marked {target}"),
        json!({}),
    )
    .map_err(|e| e.to_string())?;
    let _ = app.emit("kanban://task_activity", json!({"taskId":id,"kind":target}));
    Ok(())
}

#[tauri::command]
pub fn kanban_stop(
    id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    transition_task(&id, "cancelled", &app, &state)
}

#[tauri::command]
pub fn kanban_retry(
    id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock();
    let active_run: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM kanban_runs WHERE task_id=?1 AND status='running')",
            [&id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if active_run {
        return Err("Wait for the stopped run to finish before retrying".into());
    }
    let changed = KanbanRepo::retry(&conn, &id).map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("Task cannot be retried in its current state".into());
    }
    KanbanRepo::activity(
        &conn,
        &id,
        None,
        "retry",
        "Manual retry started with a fresh retry budget",
        json!({}),
    )
    .map_err(|e| e.to_string())?;
    let _ = app.emit(
        "kanban://task_activity",
        json!({"taskId":id,"kind":"retry"}),
    );
    Ok(())
}

#[tauri::command]
pub fn kanban_approve(
    id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock();
    let changed = conn.execute("UPDATE kanban_tasks SET status='done',updated_at=strftime('%s','now') WHERE id=?1 AND status='review'", [&id]).map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("Task is not waiting for review".into());
    }
    KanbanRepo::activity(
        &conn,
        &id,
        None,
        "approved",
        "Reviewed result approved",
        json!({}),
    )
    .map_err(|e| e.to_string())?;
    let _ = app.emit(
        "kanban://task_activity",
        json!({"taskId":id,"kind":"approved"}),
    );
    Ok(())
}

struct RunStart {
    task: KanbanTask,
    run_id: String,
    attempt: i64,
}

pub struct KanbanScheduler;

impl KanbanScheduler {
    pub fn start(app: tauri::AppHandle) {
        static STARTED: AtomicBool = AtomicBool::new(false);
        if STARTED.swap(true, Ordering::AcqRel) {
            return;
        }
        tauri::async_runtime::spawn(async move {
            recover_interrupted(&app);
            loop {
                if let Some(run) = claim_next(&app) {
                    execute_run(&app, run).await;
                } else {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        });
    }
}

fn recover_interrupted(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let conn = state.db.lock();
    let mut stmt =
        match conn.prepare("SELECT id,retry_generation FROM kanban_tasks WHERE status='running'") {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(%e,"kanban: recovery query failed");
                return;
            }
        };
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>());
    let Ok(rows) = rows else { return };
    drop(stmt);
    for (id, generation) in rows {
        let _ = conn.execute("UPDATE kanban_runs SET status='failed',finished_at=strftime('%s','now'),error='Application stopped during execution' WHERE task_id=?1 AND status='running'", [&id]);
        let attempt: i64 = conn
            .query_row(
                "SELECT count(*) FROM kanban_runs WHERE task_id=?1 AND generation=?2",
                params![id, generation],
                |r| r.get(0),
            )
            .unwrap_or(1);
        let delay = retry_delay_seconds(attempt).unwrap_or(0);
        let next = if delay > 0 { "ready" } else { "blocked" };
        let _ = conn.execute("UPDATE kanban_tasks SET status=?2,next_attempt_at=strftime('%s','now')+?3,updated_at=strftime('%s','now') WHERE id=?1", params![id,next,delay]);
        let _ = KanbanRepo::activity(
            &conn,
            &id,
            None,
            "recovered",
            if next == "blocked" {
                "Interrupted task exhausted its retry budget"
            } else {
                "Interrupted task queued for retry"
            },
            json!({"retryDelaySeconds":delay}),
        );
    }
}

fn claim_next(app: &tauri::AppHandle) -> Option<RunStart> {
    let state = app.state::<AppState>();
    let conn = state.db.lock();
    let task_id: Option<String> = conn.query_row("SELECT id FROM kanban_tasks WHERE status='ready' AND next_attempt_at<=strftime('%s','now') ORDER BY created_at,id LIMIT 1", [], |r| r.get(0)).optional().ok().flatten();
    let task_id = task_id?;
    let tx = conn.unchecked_transaction().ok()?;
    let mut task = KanbanRepo::task(&tx, &task_id).ok()??;
    let generation: i64 = tx
        .query_row(
            "SELECT retry_generation FROM kanban_tasks WHERE id=?1",
            [&task_id],
            |r| r.get(0),
        )
        .ok()?;
    let attempt: i64 = tx
        .query_row(
            "SELECT count(*)+1 FROM kanban_runs WHERE task_id=?1 AND generation=?2",
            params![task_id, generation],
            |r| r.get(0),
        )
        .ok()?;
    let run_id = uuid::Uuid::new_v4().to_string();
    tx.execute("UPDATE kanban_tasks SET status='running',updated_at=strftime('%s','now') WHERE id=?1 AND status='ready'", [&task_id]).ok()?;
    tx.execute("INSERT INTO kanban_runs (id,task_id,generation,attempt,status) VALUES (?1,?2,?3,?4,'running')", params![run_id,task_id,generation,attempt]).ok()?;
    let _ = KanbanRepo::activity(
        &tx,
        &task_id,
        Some(&run_id),
        "started",
        &format!("Run attempt {attempt} started"),
        json!({"attempt":attempt}),
    );
    task.status = "running".into();
    tx.commit().ok()?;
    Some(RunStart {
        task,
        run_id,
        attempt,
    })
}

fn event_activity(
    app: &tauri::AppHandle,
    task_id: &str,
    run_id: &str,
    kind: &str,
    message: &str,
    metadata: Value,
) {
    let state = app.state::<AppState>();
    let conn = state.db.lock();
    if let Ok(activity) =
        KanbanRepo::activity(&conn, task_id, Some(run_id), kind, message, metadata)
    {
        let _ = app.emit("kanban://task_activity", &activity);
    }
}

async fn execute_run(app: &tauri::AppHandle, run: RunStart) {
    let (db, bridge, agents, task) = {
        let state = app.state::<AppState>();
        (
            state.db.clone(),
            state.agent.clone(),
            state.agents_loader.clone(),
            run.task.clone(),
        )
    };
    let result = run_agent(app, &db, &bridge, &agents, &task, &run).await;
    let conn = db.lock();
    let status_now: String = conn
        .query_row(
            "SELECT status FROM kanban_tasks WHERE id=?1",
            [&task.id],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "cancelled".into());
    if status_now == "cancelled" {
        let _ = conn.execute("UPDATE kanban_runs SET status='cancelled',finished_at=strftime('%s','now') WHERE id=?1", [&run.run_id]);
        let _ = app.emit(
            "kanban://task_activity",
            json!({"taskId":task.id,"kind":"cancelled"}),
        );
        return;
    }
    match result {
        Ok((agent_id, final_text)) => {
            let status = if task.completion_mode == "human_review" {
                "review"
            } else {
                "done"
            };
            let _ = conn.execute(
                "UPDATE kanban_runs SET status=?2,finished_at=strftime('%s','now') WHERE id=?1",
                params![run.run_id, status],
            );
            let _ = conn.execute("UPDATE kanban_tasks SET status=?2,assigned_agent=?3,result=?4,updated_at=strftime('%s','now') WHERE id=?1", params![task.id,status,agent_id,final_text]);
            let _ = KanbanRepo::activity(
                &conn,
                &task.id,
                Some(&run.run_id),
                "completed",
                if status == "review" {
                    "Execution finished and is waiting for review"
                } else {
                    "Execution finished"
                },
                json!({"agentId":agent_id}),
            );
            let _ = app.emit(
                "kanban://task_activity",
                json!({"taskId":task.id,"kind":status}),
            );
        }
        Err(error) => {
            let delay = retry_delay_seconds(run.attempt).unwrap_or(0);
            let retry_status = if delay > 0 { "ready" } else { "blocked" };
            let safe_error = sanitize_text(&error);
            let _ = conn.execute("UPDATE kanban_runs SET status='failed',finished_at=strftime('%s','now'),error=?2 WHERE id=?1", params![run.run_id,safe_error]);
            let _ = conn.execute("UPDATE kanban_tasks SET status=?2,next_attempt_at=strftime('%s','now')+?3,updated_at=strftime('%s','now'),result=?4 WHERE id=?1", params![task.id,retry_status,delay,Some(sanitize_text(&error))]);
            let _ = KanbanRepo::activity(
                &conn,
                &task.id,
                Some(&run.run_id),
                "failed",
                &safe_error,
                json!({"attempt":run.attempt,"retryDelaySeconds":delay}),
            );
            let _ = app.emit(
                "kanban://task_activity",
                json!({"taskId":task.id,"kind":retry_status}),
            );
        }
    }
}

fn kanban_runtime_agent_id(general: bool, agent_id: &str) -> &str {
    if general {
        "network-architect"
    } else {
        agent_id
    }
}

async fn attachment_vault_secrets_with<F, R>(
    runtime_agent_id: &str,
    entry: &str,
    retrieve: R,
) -> Result<Option<std::collections::HashMap<String, String>>, String>
where
    R: FnOnce() -> F,
    F: std::future::Future<Output = Result<std::collections::HashMap<String, String>, String>>,
{
    // Architect binds configured vendors itself; merged catalogs are metadata,
    // not a request to decrypt every loaded agent's credentials.
    if runtime_agent_id == "network-architect" || entry.is_empty() {
        Ok(None)
    } else {
        retrieve().await.map(Some)
    }
}

async fn run_agent(
    app: &tauri::AppHandle,
    db: &Arc<Mutex<Connection>>,
    bridge: &AgentBridge,
    loader: &Arc<AgentsLoader>,
    task: &KanbanTask,
    run: &RunStart,
) -> Result<(String, String), String> {
    let loaded = loader.list();
    if loaded.is_empty() {
        return Err("No agents are loaded".into());
    }
    let (agent_id, general) = route_task(bridge, task, &loaded).await;
    let selected = loaded
        .iter()
        .find(|agent| agent.id == agent_id)
        .unwrap_or(&loaded[0]);
    let target_agent = if general {
        loaded
            .iter()
            .find(|a| a.id == "network-architect")
            .unwrap_or(selected)
    } else {
        selected
    };
    let runtime_agent_id = kanban_runtime_agent_id(general, &target_agent.id);
    let owners: Vec<&Agent> = if general {
        loaded
            .iter()
            .filter(|a| !a.attached_tools.is_empty())
            .collect()
    } else {
        vec![target_agent]
    };
    if owners.is_empty() {
        return Err("No loaded agent has tools configured".into());
    }

    let mut attachments = Vec::new();
    let mut tool_names = std::collections::HashMap::<String, usize>::new();
    let mut catalogs = Vec::<(String, Value, String, String, String)>::new();
    for owner in &owners {
        for tool in &owner.attached_tools {
            let raw = std::fs::read_to_string(&tool.catalog)
                .map_err(|e| format!("Unable to read {} catalog: {e}", tool.id))?;
            let catalog: Value = serde_json::from_str(&raw)
                .map_err(|e| format!("Invalid {} catalog: {e}", tool.id))?;
            let mut specs = catalog.as_array().cloned().unwrap_or_default();
            for spec in &mut specs {
                let Some(obj) = spec.as_object_mut() else {
                    continue;
                };
                let name = obj
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                *tool_names.entry(name.clone()).or_default() += 1;
                obj.insert("kanbanOwner".into(),json!({"agentId":owner.id,"toolId":tool.id,"vaultEntry":tool.vault_entry,"defaultBlastRadiusAllowed":tool.default_blast_radius_allowed}));
            }
            catalogs.push((
                owner.id.clone(),
                Value::Array(specs),
                tool.vault_entry.clone(),
                tool.id.clone(),
                tool.default_blast_radius_allowed.clone(),
            ));
        }
    }
    for (owner_id, mut catalog, entry, tool_id, radius) in catalogs {
        if let Some(specs) = catalog.as_array_mut() {
            for spec in specs {
                if let Some(obj) = spec.as_object_mut() {
                    if let Some(name) = obj.get("name").and_then(Value::as_str).map(str::to_string)
                    {
                        if tool_names.get(&name).copied().unwrap_or(0) > 1 {
                            let owner_id = obj
                                .get("kanbanOwner")
                                .and_then(|owner| owner.get("agentId"))
                                .and_then(Value::as_str)
                                .unwrap_or("agent")
                                .to_string();
                            let tool_id = obj
                                .get("kanbanOwner")
                                .and_then(|owner| owner.get("toolId"))
                                .and_then(Value::as_str)
                                .unwrap_or("tool")
                                .to_string();
                            namespace_catalog_entry(obj, &name, &owner_id, &tool_id);
                        }
                    }
                }
            }
        }
        let state = app.state::<AppState>();
        let secrets = attachment_vault_secrets_with(runtime_agent_id, &entry, || {
            crate::commands::ai::_retrieve_vault_secrets(&state, &entry)
        })
        .await?;
        attachments.push(json!({"id":tool_id,"catalog":catalog,"vault_entry":entry,"vault_secrets":secrets,"default_blast_radius_allowed":"destructive","owner_agent_id":owner_id,"owner_tool_id":tool_id,"configured_blast_radius":radius}));
    }

    let prompt = task_prompt(&task.title, &task.details, task.pane_context.as_deref());
    let mut system_prompt = target_agent.system_prompt.clone();
    if general {
        system_prompt = format!("You are the General worker for CCIE Terminal. Use the tools available in this merged catalog. Select actions appropriate to the task and return a concise result.\n\n{}", system_prompt);
    }
    let assigned_label = if general {
        "General".to_string()
    } else {
        target_agent.name.clone()
    };
    let topolograph_runtime = {
        let state = app.state::<AppState>();
        crate::commands::ai::resolve_topolograph_runtime_binding(&state, runtime_agent_id)?
    };
    {
        let conn = db.lock();
        let _ = conn.execute(
            "UPDATE kanban_tasks SET assigned_agent=?2,updated_at=strftime('%s','now') WHERE id=?1 AND status='running'",
            params![task.id, assigned_label],
        );
    }
    event_activity(
        app,
        &task.id,
        &run.run_id,
        "routed",
        if general {
            "Routed to General worker"
        } else {
            "Routed to configured agent"
        },
        json!({"agentId":if general {"General"} else {target_agent.id.as_str()},"toolCount":tool_names.len()}),
    );

    let params = json!({
        "agent_id":runtime_agent_id,"message":prompt,"history":[],"system_prompt":system_prompt,"attachments":attachments,
        "engine":"deepagents","stream_output":true,"topolograph_runtime":topolograph_runtime
    });
    let task_id = task.id.clone();
    let run_id = run.run_id.clone();
    let app_handle = app.clone();
    let db_handle = db.clone();
    let final_text = Arc::new(parking_lot::Mutex::new(String::new()));
    let final_sink = final_text.clone();
    let aborted = Arc::new(AtomicBool::new(false));
    let callback_abort = aborted.clone();
    let outcome=bridge.call_stream_ex("agent.react_code_loop",params,move |ev| {
        let kind=ev.get("type").and_then(Value::as_str).unwrap_or("");
        let status: String = db_handle.lock().query_row("SELECT status FROM kanban_tasks WHERE id=?1", [&task_id], |r| r.get(0)).unwrap_or_else(|_|"cancelled".into());
        if status=="cancelled" { callback_abort.store(true,Ordering::Release); anyhow::bail!("Task cancelled"); }
        match kind {
            "thought_start" => event_activity(&app_handle,&task_id,&run_id,"progress",&format!("Working (step {})",ev.get("step").and_then(Value::as_u64).unwrap_or(0)),json!({})),
            "tool_call" => event_activity(&app_handle,&task_id,&run_id,"tool_call",ev.get("name").and_then(Value::as_str).unwrap_or("Tool call"),json!({"args":ev.get("args").cloned().unwrap_or(Value::Null),"blastRadius":ev.get("blast_radius").cloned().unwrap_or(Value::Null)})),
            "tool_result" => {
                let raw = ev.get("result").and_then(Value::as_str).unwrap_or("Tool completed");
                let clean = serde_json::from_str::<Value>(raw).map(sanitize_value).map(|value| value.to_string()).unwrap_or_else(|_| sanitize_text(raw)).chars().take(4000).collect::<String>();
                event_activity(&app_handle,&task_id,&run_id,"tool_result",&clean,json!({"success":ev.get("success").cloned().unwrap_or(Value::Null)}));
            }
            "code_start" => event_activity(&app_handle,&task_id,&run_id,"progress","Agent prepared an execution step",json!({})),
            "code_executing" => event_activity(&app_handle,&task_id,&run_id,"progress","Executing an agent step",json!({})),
            "code_result" => {
                let raw=ev.get("output").and_then(Value::as_str).unwrap_or("");
                event_activity(&app_handle,&task_id,&run_id,"tool_result",&sanitize_text(raw).chars().take(4000).collect::<String>(),json!({"success":ev.get("success").cloned().unwrap_or(Value::Null)}));
            }
            "code_error" => event_activity(&app_handle,&task_id,&run_id,"error",&sanitize_text(ev.get("error").and_then(Value::as_str).unwrap_or("Execution failed")),json!({})),
            "token" => {},
            "final" => { let text=ev.get("response").and_then(Value::as_str).unwrap_or(""); *final_sink.lock()=sanitize_text(text); event_activity(&app_handle,&task_id,&run_id,"progress","Agent produced a result",json!({})); },
            "error" => { let message=sanitize_text(ev.get("message").and_then(Value::as_str).unwrap_or("Agent execution failed")); event_activity(&app_handle,&task_id,&run_id,"error",&message,json!({})); },
            _ => {}
        }
        Ok(())
    }).await.map_err(|e|e.to_string());
    if aborted.load(Ordering::Acquire) {
        return Err("Task cancelled".into());
    }
    outcome?;
    let output = final_text.lock().clone();
    if output.trim().is_empty() {
        return Err("Agent finished without a result".into());
    }
    Ok((
        if general {
            "General".to_string()
        } else {
            target_agent.name.clone()
        },
        output,
    ))
}

fn task_prompt(title: &str, details: &str, terminal_context: Option<&str>) -> String {
    let terminal_context = terminal_context
        .filter(|context| !context.trim().is_empty())
        .map(|context| format!("\n\nPasted terminal context (reference only):\n{context}"))
        .unwrap_or_default();
    format!("Task: {title}\n\nDetails:\n{details}{terminal_context}")
}

async fn route_task(bridge: &AgentBridge, task: &KanbanTask, agents: &[Agent]) -> (String, bool) {
    let candidates = agents
        .iter()
        .map(|a| json!({"id":a.id,"name":a.name,"description":a.description}))
        .collect::<Vec<_>>();
    let prompt=format!("Choose the single best configured agent for this task. If no agent clearly fits, or your confidence is below 0.65, respond with agentId=General. Return only JSON with keys agentId and confidence.\nCandidates: {}\nTask title: {}\nTask details: {}",serde_json::to_string(&candidates).unwrap_or_default(),task.title,task.details);
    let params = json!({"session_id":uuid::Uuid::new_v4().to_string(),"messages":[{"role":"user","content":prompt}]});
    let output = Arc::new(parking_lot::Mutex::new(String::new()));
    let sink = output.clone();
    let result = bridge
        .call_stream_ex("chat.stream", params, move |ev| {
            if ev.get("type").and_then(Value::as_str) == Some("token") {
                if let Some(text) = ev
                    .get("data")
                    .or_else(|| ev.get("text"))
                    .and_then(Value::as_str)
                {
                    sink.lock().push_str(text);
                }
            }
            Ok(())
        })
        .await;
    if result.is_err() {
        return (agents[0].id.clone(), true);
    }
    let text = output.lock().clone();
    let parsed = text
        .find('{')
        .and_then(|start| text.rfind('}').map(|end| &text[start..=end]))
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let Some(parsed) = parsed else {
        return (agents[0].id.clone(), true);
    };
    let confidence = parsed
        .get("confidence")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let id = parsed
        .get("agentId")
        .and_then(Value::as_str)
        .unwrap_or("General");
    if confidence < 0.65 || id == "General" {
        return (agents[0].id.clone(), true);
    }
    if let Some(agent) = agents.iter().find(|agent| agent.id == id) {
        (agent.id.clone(), false)
    } else {
        (agents[0].id.clone(), true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn general_research_does_not_read_merged_meraki_vault() {
        let runtime_agent_id = kanban_runtime_agent_id(true, "meraki");
        assert_eq!(runtime_agent_id, "network-architect");
        assert!(
            task_prompt("Research a Minecraft game", "Compare approaches", None)
                .contains("Minecraft")
        );
        let reads = std::cell::Cell::new(0);
        let result = attachment_vault_secrets_with(runtime_agent_id, "meraki_api_key", || async {
            reads.set(reads.get() + 1);
            Err("Vault envelope 'meraki_api_key' not found. Create it in Settings → Vault.".into())
        })
        .await;
        assert_eq!(result, Ok(None));
        assert_eq!(reads.get(), 0);

        // Even an available envelope must not be decrypted for unused catalog metadata.
        let result = attachment_vault_secrets_with(runtime_agent_id, "meraki_api_key", || async {
            reads.set(reads.get() + 1);
            Ok(std::collections::HashMap::from([(
                "api_key".into(),
                "synthetic-key".into(),
            )]))
        })
        .await;
        assert_eq!(result, Ok(None));
        assert_eq!(reads.get(), 0);
    }

    #[tokio::test]
    async fn dedicated_meraki_keeps_actionable_vault_failures_and_secrets() {
        let runtime_agent_id = kanban_runtime_agent_id(false, "meraki");
        assert_eq!(runtime_agent_id, "meraki");
        for error in [
            "Vault envelope 'meraki_api_key' not found. Create it in Settings → Vault.",
            "Vault envelope 'meraki_api_key' is locked or timed out. Unlock it in Settings → Vault before using this agent.",
            "Failed to read secret 'api_key': permission denied",
            "Secret 'api_key' is not valid UTF-8",
        ] {
            let reads = std::cell::Cell::new(0);
            let result = attachment_vault_secrets_with(runtime_agent_id, "meraki_api_key", || async {
                reads.set(reads.get() + 1);
                Err(error.into())
            }).await;
            assert_eq!(result, Err(error.into()));
            assert_eq!(reads.get(), 1);
        }
        let secrets = std::collections::HashMap::from([("api_key".into(), "synthetic-key".into())]);
        assert_eq!(
            attachment_vault_secrets_with(runtime_agent_id, "meraki_api_key", || async {
                Ok(secrets.clone())
            })
            .await,
            Ok(Some(secrets)),
        );
        assert_eq!(
            attachment_vault_secrets_with(runtime_agent_id, "", || async {
                panic!("An empty vault entry must never be read")
            })
            .await,
            Ok(None),
        );
    }

    #[test]
    fn task_prompt_includes_pasted_terminal_context_as_reference() {
        assert_eq!(
            task_prompt("Smoke test", "Summarize the output", Some("pwd: /tmp")),
            "Task: Smoke test\n\nDetails:\nSummarize the output\n\nPasted terminal context (reference only):\npwd: /tmp"
        );
        assert_eq!(
            task_prompt("Smoke test", "Summarize the output", Some("  ")),
            "Task: Smoke test\n\nDetails:\nSummarize the output"
        );
    }

    #[test]
    fn activity_sanitizer_removes_private_fields_recursively() {
        let value = sanitize_value(
            json!({"name":"search","args":{"organization":"Example","api_key":"secret","nested":{"password":"secret","query":"safe"}}}),
        );
        assert_eq!(
            value,
            json!({"name":"search","args":{"organization":"Example","nested":{"query":"safe"}}})
        );
        assert!(!sanitize_text(r#"{"api_key":"secret-value"}"#).contains("secret-value"));
        assert!(!sanitize_text("Authorization: Bearer live-token").contains("live-token"));
    }

    #[test]
    fn retry_budget_uses_two_delayed_retries_then_blocks() {
        assert_eq!(retry_delay_seconds(1), Some(30));
        assert_eq!(retry_delay_seconds(2), Some(60));
        assert_eq!(retry_delay_seconds(3), None);
    }

    #[test]
    fn colliding_tool_names_keep_their_agent_and_tool_owner() {
        assert_eq!(
            tool_name_for_catalog("api_call", "meraki", "dashboard", 2),
            "meraki__dashboard__api_call"
        );
        assert_eq!(
            tool_name_for_catalog("unique", "meraki", "dashboard", 1),
            "unique"
        );
        let mut entry = json!({
            "name":"api_call",
            "function":{"name":"api_call","parameters":{}}
        });
        namespace_catalog_entry(
            entry.as_object_mut().unwrap(),
            "api_call",
            "meraki",
            "dashboard",
        );
        assert_eq!(entry["name"], "meraki__dashboard__api_call");
        assert_eq!(entry["function"]["name"], "meraki__dashboard__api_call");
    }

    #[test]
    fn manual_retry_increments_budget_generation_and_keeps_run_history() {
        let database = crate::database::Database::new_in_memory().unwrap();
        let conn = database.conn();
        conn.execute(
            "INSERT INTO kanban_tasks (id,title,status) VALUES ('task-2','Retry me','blocked')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO kanban_runs (id,task_id,generation,attempt,status) VALUES ('run-1','task-2',0,3,'failed')", []).unwrap();
        assert_eq!(KanbanRepo::retry(conn, "task-2").unwrap(), 1);
        let (status, generation): (String, i64) = conn
            .query_row(
                "SELECT status,retry_generation FROM kanban_tasks WHERE id='task-2'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        let history_count: i64 = conn
            .query_row(
                "SELECT count(*) FROM kanban_runs WHERE task_id='task-2'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            (status.as_str(), generation, history_count),
            ("ready", 1, 1)
        );
    }

    #[test]
    fn task_and_activity_persist_through_the_shared_database_migrations() {
        let database = crate::database::Database::new_in_memory().unwrap();
        let conn = database.conn();
        conn.execute(
            "INSERT INTO kanban_tasks (id,title,details) VALUES ('task-1','Inspect routing','Check the route')",
            [],
        ).unwrap();
        KanbanRepo::activity(
            conn,
            "task-1",
            None,
            "created",
            "Task added",
            json!({"api_key":"hidden","note":"safe"}),
        )
        .unwrap();
        let task = KanbanRepo::task(conn, "task-1").unwrap().unwrap();
        let detail = KanbanRepo::detail(conn, "task-1").unwrap().unwrap();
        assert_eq!(task.status, "ready");
        assert_eq!(detail.activity.len(), 1);
        assert_eq!(detail.activity[0].metadata, json!({"note":"safe"}));
    }
}
