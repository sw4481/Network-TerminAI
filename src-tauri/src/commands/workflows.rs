use anyhow::{anyhow, Result};
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;
use uuid::Uuid;

use super::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowStep {
    pub idx: i64,
    pub command_template: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowParam {
    pub name: String,
    #[serde(rename = "type")]
    pub r#type: String, // 'string'|'enum'|'ip'|'int'|'interface'
    pub default_value: Option<String>,
    pub required: bool,
    pub description: String,
    pub enum_values: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workflow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub vendor: String,   // 'cisco'|'juniper'|'arista'|'meraki'|'generic'
    pub platform: String,
    pub tags: Vec<String>,
    pub steps: Vec<WorkflowStep>,
    pub params: Vec<WorkflowParam>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowRunResult {
    pub run_id: String,
    pub workflow_name: String,
    pub commands: Vec<String>,
}

// ---------------------------------------------------------------------------
// CRUD helpers (testable without Tauri State).
// ---------------------------------------------------------------------------

pub fn workflow_upsert_impl(conn: &Connection, wf: &Workflow) -> Result<()> {
    let tags_json = serde_json::to_string(&wf.tags)?;
    conn.execute(
        "INSERT INTO workflows (id, name, description, vendor, platform, tags, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%s','now'), strftime('%s','now'))
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           vendor = excluded.vendor,
           platform = excluded.platform,
           tags = excluded.tags,
           updated_at = strftime('%s','now')",
        params![wf.id, wf.name, wf.description, wf.vendor, wf.platform, tags_json],
    )?;
    conn.execute("DELETE FROM workflow_steps WHERE workflow_id = ?1", params![wf.id])?;
    for step in &wf.steps {
        conn.execute(
            "INSERT INTO workflow_steps (workflow_id, idx, command_template) VALUES (?1, ?2, ?3)",
            params![wf.id, step.idx, step.command_template],
        )?;
    }
    conn.execute("DELETE FROM workflow_params WHERE workflow_id = ?1", params![wf.id])?;
    for p in &wf.params {
        let enum_json = match &p.enum_values {
            Some(v) => Some(serde_json::to_string(v)?),
            None => None,
        };
        conn.execute(
            "INSERT INTO workflow_params (workflow_id, name, type, default_value, required, description, enum_values)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                wf.id,
                p.name,
                p.r#type,
                p.default_value,
                if p.required { 1 } else { 0 },
                p.description,
                enum_json
            ],
        )?;
    }
    Ok(())
}

pub fn workflow_get_impl(conn: &Connection, id: &str) -> Result<Option<Workflow>> {
    let row = conn
        .query_row(
            "SELECT id, name, description, vendor, platform, tags, created_at, updated_at
             FROM workflows WHERE id = ?1",
            params![id],
            |r| {
                let tags_json: String = r.get(5)?;
                Ok(Workflow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    description: r.get(2)?,
                    vendor: r.get(3)?,
                    platform: r.get(4)?,
                    tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                    steps: vec![],
                    params: vec![],
                    created_at: r.get(6)?,
                    updated_at: r.get(7)?,
                })
            },
        )
        .optional()?;
    let Some(mut wf) = row else { return Ok(None) };

    let mut steps_stmt = conn.prepare(
        "SELECT idx, command_template FROM workflow_steps WHERE workflow_id = ?1 ORDER BY idx",
    )?;
    wf.steps = steps_stmt
        .query_map(params![id], |r| {
            Ok(WorkflowStep {
                idx: r.get(0)?,
                command_template: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut params_stmt = conn.prepare(
        "SELECT name, type, default_value, required, description, enum_values
         FROM workflow_params WHERE workflow_id = ?1 ORDER BY name",
    )?;
    wf.params = params_stmt
        .query_map(params![id], |r| {
            let enum_json: Option<String> = r.get(5)?;
            let enum_values = enum_json.and_then(|s| serde_json::from_str(&s).ok());
            let required: i64 = r.get(3)?;
            Ok(WorkflowParam {
                name: r.get(0)?,
                r#type: r.get(1)?,
                default_value: r.get(2)?,
                required: required != 0,
                description: r.get(4)?,
                enum_values,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(Some(wf))
}

pub fn workflow_list_impl(
    conn: &Connection,
    vendor: Option<&str>,
    platform: Option<&str>,
    name_prefix: Option<&str>,
) -> Result<Vec<Workflow>> {
    let mut sql = String::from("SELECT id FROM workflows WHERE 1=1");
    let mut args: Vec<String> = Vec::new();
    if let Some(v) = vendor {
        // 'generic' is always included so cross-vendor workflows show up.
        sql.push_str(" AND vendor IN (?, 'generic')");
        args.push(v.to_string());
    }
    if let Some(p) = platform {
        sql.push_str(" AND (platform = ? OR platform = '' OR platform = 'generic')");
        args.push(p.to_string());
    }
    if let Some(pref) = name_prefix {
        sql.push_str(" AND name LIKE ?");
        args.push(format!("{}%", pref));
    }
    sql.push_str(" ORDER BY name");
    let mut stmt = conn.prepare(&sql)?;
    let ids: Vec<String> = stmt
        .query_map(rusqlite::params_from_iter(args.iter()), |r| {
            r.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(wf) = workflow_get_impl(conn, &id)? {
            out.push(wf);
        }
    }
    Ok(out)
}

pub fn workflow_delete_impl(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM workflows WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Template rendering + run.
// ---------------------------------------------------------------------------

static PLACEHOLDER_RE: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
    Regex::new(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}").unwrap()
});

pub fn render_template(template: &str, values: &HashMap<String, String>) -> Result<String> {
    let mut missing: Vec<String> = Vec::new();
    let rendered = PLACEHOLDER_RE
        .replace_all(template, |caps: &regex::Captures| match values.get(&caps[1]) {
            Some(v) => v.clone(),
            None => {
                missing.push(caps[1].to_string());
                String::new()
            }
        })
        .to_string();
    if !missing.is_empty() {
        return Err(anyhow!(
            "missing values for placeholders: {}",
            missing.join(", ")
        ));
    }
    Ok(rendered)
}

pub fn workflow_run_impl(
    conn: &Connection,
    workflow_id: &str,
    tab_id: &str,
    values: &HashMap<String, String>,
) -> Result<(String, Vec<String>)> {
    let wf = workflow_get_impl(conn, workflow_id)?
        .ok_or_else(|| anyhow!("workflow {} not found", workflow_id))?;

    // Merge defaults for any missing-but-non-required params.
    let mut merged: HashMap<String, String> = HashMap::new();
    for p in &wf.params {
        if let Some(v) = values.get(&p.name) {
            merged.insert(p.name.clone(), v.clone());
        } else if let Some(d) = &p.default_value {
            merged.insert(p.name.clone(), d.clone());
        } else if p.required {
            return Err(anyhow!("missing required param: {}", p.name));
        }
    }

    let mut rendered = Vec::with_capacity(wf.steps.len());
    for step in &wf.steps {
        rendered.push(render_template(&step.command_template, &merged)?);
    }

    let run_id = Uuid::new_v4().to_string();
    let params_json = serde_json::to_string(&merged)?;
    conn.execute(
        "INSERT INTO workflow_runs (id, workflow_id, tab_id, params_json) VALUES (?1, ?2, ?3, ?4)",
        params![run_id, workflow_id, tab_id, params_json],
    )?;
    Ok((run_id, rendered))
}

// ---------------------------------------------------------------------------
// Tauri commands (thin wrappers).
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn workflow_upsert(
    state: State<'_, AppState>,
    workflow: Workflow,
) -> Result<String, String> {
    let mut wf = workflow;
    if wf.id.is_empty() {
        wf.id = Uuid::new_v4().to_string();
    }
    let conn = state.db.lock();
    workflow_upsert_impl(&conn, &wf).map_err(|e| e.to_string())?;
    Ok(wf.id)
}

#[tauri::command]
pub async fn workflow_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<Workflow>, String> {
    let conn = state.db.lock();
    workflow_get_impl(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn workflow_list(
    state: State<'_, AppState>,
    vendor: Option<String>,
    platform: Option<String>,
    name_prefix: Option<String>,
) -> Result<Vec<Workflow>, String> {
    let conn = state.db.lock();
    workflow_list_impl(
        &conn,
        vendor.as_deref(),
        platform.as_deref(),
        name_prefix.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn workflow_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.db.lock();
    workflow_delete_impl(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn workflow_run(
    state: State<'_, AppState>,
    workflow_id: String,
    tab_id: String,
    values: HashMap<String, String>,
) -> Result<WorkflowRunResult, String> {
    let conn = state.db.lock();
    let wf = workflow_get_impl(&conn, &workflow_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("workflow {} not found", workflow_id))?;
    let (run_id, commands) = workflow_run_impl(&conn, &workflow_id, &tab_id, &values)
        .map_err(|e| e.to_string())?;
    Ok(WorkflowRunResult {
        run_id,
        workflow_name: wf.name,
        commands,
    })
}

#[tauri::command]
pub async fn workflow_run_complete(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<(), String> {
    let conn = state.db.lock();
    conn.execute(
        "UPDATE workflow_runs SET ended_at = strftime('%s','now') WHERE id = ?1",
        params![run_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
