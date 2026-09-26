use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Deserialize;
use tauri::State;

use super::workflows::{workflow_upsert_impl, Workflow, WorkflowParam, WorkflowStep};
use super::AppState;

/// The seed pack is authored in `sidecar/data/workflows_seed.yaml` and
/// embedded into the binary at build time so first-run seeding works
/// regardless of where the app is installed.
pub const SEED_YAML: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../sidecar/data/workflows_seed.yaml"
));

const SEED_FLAG: &str = "workflows.seeded.v1";

#[derive(Deserialize)]
struct SeedFile {
    #[allow(dead_code)]
    version: u32,
    workflows: Vec<SeedEntry>,
}

#[derive(Deserialize)]
struct SeedEntry {
    id: String,
    name: String,
    #[serde(default)]
    description: String,
    vendor: String,
    #[serde(default)]
    platform: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    params: Vec<SeedParam>,
    steps: Vec<SeedStep>,
}

#[derive(Deserialize)]
struct SeedParam {
    name: String,
    #[serde(rename = "type")]
    r#type: String,
    #[serde(default)]
    default_value: Option<String>,
    #[serde(default = "default_true")]
    required: bool,
    #[serde(default)]
    description: String,
    #[serde(default)]
    enum_values: Option<Vec<String>>,
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
struct SeedStep {
    idx: i64,
    command_template: String,
}

fn ensure_app_flags_table(conn: &Connection) -> Result<()> {
    // Create on demand so unit tests using a stripped schema still work.
    // In production the table is also created by an existing init migration.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_flags (key TEXT PRIMARY KEY, value TEXT)",
        [],
    )?;
    Ok(())
}

fn already_seeded(conn: &Connection) -> Result<bool> {
    ensure_app_flags_table(conn)?;
    let val: Option<String> = conn
        .query_row(
            "SELECT value FROM app_flags WHERE key = ?1",
            params![SEED_FLAG],
            |r| r.get(0),
        )
        .ok();
    Ok(val.is_some())
}

fn mark_seeded(conn: &Connection) -> Result<()> {
    ensure_app_flags_table(conn)?;
    conn.execute(
        "INSERT OR REPLACE INTO app_flags (key, value) VALUES (?1, ?2)",
        params![SEED_FLAG, "1"],
    )?;
    Ok(())
}

/// Apply the bundled seed pack into `conn` exactly once. Subsequent calls
/// are no-ops (return 0) so user-modified workflows are never overwritten.
pub fn seed_builtin_from_yaml(conn: &Connection, yaml_src: &str) -> Result<usize> {
    if already_seeded(conn)? {
        return Ok(0);
    }
    let doc: SeedFile = serde_yaml::from_str(yaml_src)?;
    let mut n = 0;
    for e in doc.workflows {
        let wf = Workflow {
            id: e.id,
            name: e.name,
            description: e.description,
            vendor: e.vendor,
            platform: e.platform,
            tags: e.tags,
            steps: e
                .steps
                .into_iter()
                .map(|s| WorkflowStep {
                    idx: s.idx,
                    command_template: s.command_template,
                })
                .collect(),
            params: e
                .params
                .into_iter()
                .map(|p| WorkflowParam {
                    name: p.name,
                    r#type: p.r#type,
                    default_value: p.default_value,
                    required: p.required,
                    description: p.description,
                    enum_values: p.enum_values,
                })
                .collect(),
            created_at: 0,
            updated_at: 0,
        };
        workflow_upsert_impl(conn, &wf)?;
        n += 1;
    }
    mark_seeded(conn)?;
    Ok(n)
}

#[tauri::command]
pub async fn workflows_seed_builtin(state: State<'_, AppState>) -> Result<usize, String> {
    let conn = state.db.lock();
    seed_builtin_from_yaml(&conn, SEED_YAML).map_err(|e| e.to_string())
}
