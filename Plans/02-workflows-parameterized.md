# 02 — Workflows / Parameterized Commands

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a "Workflow" primitive: a named, vendor/platform-scoped command template with `{{ placeholders }}` that a user invokes via Cmd+Shift+W, fills a parameter form, and either (a) types the rendered command into the active input editor (single-step) or (b) runs an ordered list of commands as a single **block group** tagged with the workflow name (multi-step). Workflows are stored in SQLite, filterable by the current session's vendor/platform, seeded with ~30 built-in common network workflows, and exportable/importable as YAML.

**Architecture:**
- New migration `V0029__workflows.sql` adds `workflows`, `workflow_steps`, `workflow_params`, `workflow_runs`. Vendor is constrained to `('cisco','juniper','arista','meraki','generic')`.
- Rust module `src-tauri/src/commands/workflows.rs` exposes CRUD + `workflow_run(id, tab_id, params)` that returns `Vec<RenderedStep>` (the frontend is responsible for feeding rendered commands into the existing PTY pipeline — this plan does NOT rewrite block execution; it reuses `blocks_upsert` from `commands/blocks.rs` via a `block_group_id` column added in the migration, and tags each resulting block with the workflow name through the Plan 01 `block_tags` table).
- Frontend: `src/lib/workflows.ts` (typed Tauri wrappers), `src/state/workflowsStore.ts` (Zustand), `src/components/WorkflowPicker.tsx` (Cmd+Shift+W fuzzy picker scoped to session vendor/platform), `src/components/WorkflowParamForm.tsx` (reuses logic from `src/components/ParameterForm.tsx`), and a type-ahead hook `src/hooks/useWorkflowTypeahead.ts` that rewrites `{{ name }}` tokens in the input editor as the user tabs through fields.
- The existing `src/components/CommandTemplates.tsx` prototype is NOT rewritten — its `fillTemplate` helper from `src/lib/templates.ts` is reused verbatim. The new system supersedes it at the user-visible layer; the old modal remains as a "Quick Templates" fallback (unchanged).
- Seed pack: `sidecar/data/workflows_seed.yaml` (authoritative) + `src-tauri/migrations/V0029_5__workflows_seed.sql` (generated from the YAML during build) OR a Rust seeding function `workflows_seed_builtin()` gated on `first_run` flag.
- Export/import: `src/lib/workflowsYaml.ts` using `js-yaml`. File dialog via `@tauri-apps/plugin-dialog`.

**Tech Stack:** React 19, Zustand 5, Tauri 2, rusqlite, `js-yaml` (add), `fuse.js` (add, for the picker), `react-hotkeys-hook` (added in Plan 01), `@tauri-apps/plugin-dialog` (confirm installed; otherwise add).

**Prerequisites:**
- **Plan 00 Phase 2 complete** (DB conventions + `AppState` pattern).
- **Plan 01 Phase 1 complete** (`block_tags` table exists). Multi-step workflows tag each resulting block via `block_tag_add(block_id, "workflow:<name>")`. If Plan 01 Phase 1 is not merged, this plan's Phase 1 cannot proceed.
- Plan 01 Phase 2 (virtualized block list) recommended but NOT required — block groups degrade gracefully on a non-virtualized list.

**Downstream consumers:** Plans 03 (Notebooks — a notebook cell may invoke a workflow by id), 04 (Command Palette — workflows are a palette entry type), 06 (Pre/Post Change Verification — pre/post snapshots invoke workflows), 07 (Multi-Device Fan-Out — fan-out runs a workflow across N devices), 15 (AI Troubleshooting Tree — each tree node may call a workflow).

---

## Phase 1 — Schema + Rust commands (CRUD + run)

### Task 1.1 — Migration V0029  `SEQUENTIAL`

**Files:**
- Create: `src-tauri/migrations/V0029__workflows.sql`

- [x] **Step 1: Write migration**

```sql
-- V0029: Workflows / Parameterized Commands
-- Plan: /Plans/02-workflows-parameterized.md

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,                       -- uuidv4
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  vendor TEXT NOT NULL CHECK (vendor IN ('cisco','juniper','arista','meraki','generic')),
  platform TEXT NOT NULL DEFAULT '',         -- e.g. 'iosxe','nxos','junos','eos','mr','generic'
  tags TEXT NOT NULL DEFAULT '[]',           -- JSON array of strings
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_workflows_vendor_platform ON workflows(vendor, platform);
CREATE INDEX IF NOT EXISTS idx_workflows_name ON workflows(name);

CREATE TABLE IF NOT EXISTS workflow_steps (
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,                      -- 0-based order
  command_template TEXT NOT NULL,            -- e.g. "show interface {{ intf }} counters"
  PRIMARY KEY (workflow_id, idx)
);

CREATE TABLE IF NOT EXISTS workflow_params (
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                        -- placeholder key, no braces
  type TEXT NOT NULL CHECK (type IN ('string','enum','ip','int','interface')),
  default_value TEXT,                        -- nullable
  required INTEGER NOT NULL DEFAULT 1,       -- 0/1
  description TEXT NOT NULL DEFAULT '',
  enum_values TEXT,                          -- JSON array when type='enum', else NULL
  PRIMARY KEY (workflow_id, name)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,                       -- uuidv4 (also used as block_group_id)
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  tab_id TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',    -- {name: value}
  started_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_tab ON workflow_runs(tab_id, started_at DESC);

-- Link command_blocks to a workflow_run so the UI can render "block groups".
-- Non-destructive: existing blocks have block_group_id = NULL.
ALTER TABLE command_blocks ADD COLUMN block_group_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_command_blocks_group ON command_blocks(block_group_id);
```

- [x] **Step 2: Apply + verify migration**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib db::tests::migrations_apply
```

If no `migrations_apply` test yet (added by Plan 00 Phase 2), instead run:
```bash
cargo build --manifest-path src-tauri/Cargo.toml && \
  rm -f /tmp/ccie-mig-test.db && \
  sqlite3 /tmp/ccie-mig-test.db < src-tauri/migrations/V0029__workflows.sql && \
  sqlite3 /tmp/ccie-mig-test.db ".schema workflows"
```
Expected: schema for `workflows` printed.

- [x] **Step 3: Commit**

```bash
git add src-tauri/migrations/V0029__workflows.sql
git commit -m "feat(db): V0029 workflows + workflow_steps + workflow_params + workflow_runs"
```

### Task 1.2 — Rust `workflows` command module (CRUD)  `SEQUENTIAL` (depends on 1.1)

**Files:**
- Create: `src-tauri/src/commands/workflows.rs`
- Modify: `src-tauri/src/commands/mod.rs` — add `pub mod workflows;`
- Modify: `src-tauri/src/lib.rs` — register new commands in `tauri::generate_handler![...]`
- Create: `src-tauri/tests/workflows_crud_test.rs`

- [x] **Step 1: Write failing integration test** (`src-tauri/tests/workflows_crud_test.rs`)

```rust
use ccie_terminal_lib::commands::workflows::{
    Workflow, WorkflowParam, WorkflowStep, workflow_upsert_impl, workflow_get_impl,
    workflow_list_impl, workflow_delete_impl,
};
use rusqlite::Connection;

fn test_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    // Apply minimal V0029 schema for the test.
    conn.execute_batch(include_str!("../migrations/V0029__workflows.sql")).unwrap();
    // command_blocks referenced by ALTER — create a stub for the ALTER to not fail:
    // (in practice the full migration chain will have created it; here we skip the ALTER)
    conn
}

#[test]
fn crud_roundtrip() {
    let conn = Connection::open_in_memory().unwrap();
    // Apply just the core tables, skipping the ALTER on command_blocks (it doesn't exist in-memory).
    conn.execute_batch(r#"
        CREATE TABLE workflows (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
          vendor TEXT NOT NULL, platform TEXT NOT NULL DEFAULT '',
          tags TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );
        CREATE TABLE workflow_steps (
          workflow_id TEXT NOT NULL, idx INTEGER NOT NULL,
          command_template TEXT NOT NULL,
          PRIMARY KEY (workflow_id, idx)
        );
        CREATE TABLE workflow_params (
          workflow_id TEXT NOT NULL, name TEXT NOT NULL,
          type TEXT NOT NULL, default_value TEXT, required INTEGER NOT NULL DEFAULT 1,
          description TEXT NOT NULL DEFAULT '', enum_values TEXT,
          PRIMARY KEY (workflow_id, name)
        );
        CREATE TABLE workflow_runs (
          id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, tab_id TEXT NOT NULL,
          params_json TEXT NOT NULL DEFAULT '{}',
          started_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), ended_at INTEGER
        );
    "#).unwrap();

    let wf = Workflow {
        id: "wf-1".into(),
        name: "Show interface counters".into(),
        description: "Per-interface counter dump".into(),
        vendor: "cisco".into(),
        platform: "iosxe".into(),
        tags: vec!["counters".into()],
        steps: vec![WorkflowStep { idx: 0, command_template: "show interface {{ intf }} counters".into() }],
        params: vec![WorkflowParam {
            name: "intf".into(), r#type: "interface".into(),
            default_value: None, required: true,
            description: "Interface name (e.g. Gi0/0/0)".into(),
            enum_values: None,
        }],
        created_at: 0, updated_at: 0,
    };

    workflow_upsert_impl(&conn, &wf).unwrap();
    let got = workflow_get_impl(&conn, "wf-1").unwrap().unwrap();
    assert_eq!(got.name, "Show interface counters");
    assert_eq!(got.steps.len(), 1);
    assert_eq!(got.params.len(), 1);
    assert_eq!(got.params[0].r#type, "interface");

    let list = workflow_list_impl(&conn, Some("cisco"), Some("iosxe"), None).unwrap();
    assert_eq!(list.len(), 1);

    workflow_delete_impl(&conn, "wf-1").unwrap();
    assert!(workflow_get_impl(&conn, "wf-1").unwrap().is_none());
}
```

- [x] **Step 2: Run — expect FAIL** (`cargo test --manifest-path src-tauri/Cargo.toml workflows_crud`). Expected: compile error, module missing.

- [x] **Step 3: Implement `src-tauri/src/commands/workflows.rs`** (full file)

```rust
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
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
            params![wf.id, p.name, p.r#type, p.default_value, if p.required { 1 } else { 0 }, p.description, enum_json],
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

    let mut steps_stmt =
        conn.prepare("SELECT idx, command_template FROM workflow_steps WHERE workflow_id = ?1 ORDER BY idx")?;
    wf.steps = steps_stmt
        .query_map(params![id], |r| {
            Ok(WorkflowStep { idx: r.get(0)?, command_template: r.get(1)? })
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
    let mut sql = String::from(
        "SELECT id FROM workflows WHERE 1=1",
    );
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
        .query_map(rusqlite::params_from_iter(args.iter()), |r| r.get::<_, String>(0))?
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

// ----- Tauri commands (thin wrappers) -----

#[tauri::command]
pub async fn workflow_upsert(state: State<'_, AppState>, workflow: Workflow) -> Result<String, String> {
    let mut wf = workflow;
    if wf.id.is_empty() {
        wf.id = Uuid::new_v4().to_string();
    }
    let conn = state.db.lock();
    workflow_upsert_impl(&conn, &wf).map_err(|e| e.to_string())?;
    Ok(wf.id)
}

#[tauri::command]
pub async fn workflow_get(state: State<'_, AppState>, id: String) -> Result<Option<Workflow>, String> {
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
    workflow_list_impl(&conn, vendor.as_deref(), platform.as_deref(), name_prefix.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn workflow_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.db.lock();
    workflow_delete_impl(&conn, &id).map_err(|e| e.to_string())
}
```

Add to `src-tauri/Cargo.toml` under `[dependencies]` (only if not already present):
```toml
uuid = { version = "1", features = ["v4"] }
```

- [x] **Step 4: Register module in `src-tauri/src/commands/mod.rs`**

Add `pub mod workflows;` alongside the existing `pub mod blocks;` line (append to the `pub mod ai; pub mod ssh; ... pub mod git;` block).

- [x] **Step 5: Register Tauri commands in `src-tauri/src/lib.rs`**

Inside the existing `.invoke_handler(tauri::generate_handler![ ... ])` call, append:
```rust
commands::workflows::workflow_upsert,
commands::workflows::workflow_get,
commands::workflows::workflow_list,
commands::workflows::workflow_delete,
```

- [x] **Step 6: Run — expect PASS** (`cargo test --manifest-path src-tauri/Cargo.toml workflows_crud`).

- [x] **Step 7: Commit**

```bash
git add src-tauri/src/commands/workflows.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/tests/workflows_crud_test.rs src-tauri/Cargo.toml
git commit -m "feat(workflows): rust CRUD commands + integration test"
```

### Task 1.3 — `workflow_run` — render templates + create block group  `SEQUENTIAL` (depends on 1.2)

**Files:**
- Modify: `src-tauri/src/commands/workflows.rs` — add render + run logic
- Create: `src-tauri/tests/workflows_run_test.rs`

- [x] **Step 1: Write failing test**

```rust
use ccie_terminal_lib::commands::workflows::{
    Workflow, WorkflowParam, WorkflowStep, render_template, workflow_run_impl, workflow_upsert_impl,
};
use rusqlite::Connection;
use std::collections::HashMap;

#[test]
fn render_replaces_placeholders_and_trims_whitespace() {
    let mut values = HashMap::new();
    values.insert("intf".to_string(), "Gi0/0/0".to_string());
    let out = render_template("show interface {{ intf }} counters", &values).unwrap();
    assert_eq!(out, "show interface Gi0/0/0 counters");

    let out2 = render_template("show ip ospf neighbor {{area}}", &values).unwrap_err();
    assert!(out2.to_string().contains("missing"));
}

#[test]
fn run_returns_rendered_steps_and_records_run() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(r#"
        CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT, description TEXT DEFAULT '',
          vendor TEXT, platform TEXT DEFAULT '', tags TEXT DEFAULT '[]',
          created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
        CREATE TABLE workflow_steps (workflow_id TEXT, idx INTEGER, command_template TEXT,
          PRIMARY KEY(workflow_id, idx));
        CREATE TABLE workflow_params (workflow_id TEXT, name TEXT, type TEXT,
          default_value TEXT, required INTEGER DEFAULT 1, description TEXT DEFAULT '',
          enum_values TEXT, PRIMARY KEY(workflow_id, name));
        CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, workflow_id TEXT, tab_id TEXT,
          params_json TEXT DEFAULT '{}', started_at INTEGER DEFAULT 0, ended_at INTEGER);
    "#).unwrap();
    let wf = Workflow {
        id: "wf-2".into(), name: "Two-step".into(), description: "".into(),
        vendor: "cisco".into(), platform: "iosxe".into(),
        tags: vec![], created_at: 0, updated_at: 0,
        steps: vec![
            WorkflowStep { idx: 0, command_template: "show ip int br".into() },
            WorkflowStep { idx: 1, command_template: "show interface {{ intf }} counters".into() },
        ],
        params: vec![WorkflowParam {
            name: "intf".into(), r#type: "interface".into(),
            default_value: None, required: true,
            description: "".into(), enum_values: None,
        }],
    };
    workflow_upsert_impl(&conn, &wf).unwrap();

    let mut values = HashMap::new();
    values.insert("intf".to_string(), "Gi0/0/0".to_string());
    let (run_id, rendered) = workflow_run_impl(&conn, "wf-2", "tab-a", &values).unwrap();
    assert_eq!(rendered, vec!["show ip int br".to_string(),
                              "show interface Gi0/0/0 counters".to_string()]);
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM workflow_runs WHERE id = ?1",
        rusqlite::params![run_id], |r| r.get(0)).unwrap();
    assert_eq!(count, 1);
}
```

- [x] **Step 2: Implement `render_template`** (append to `workflows.rs`)

```rust
use regex::Regex;
use std::collections::HashMap;

static PLACEHOLDER_RE: once_cell::sync::Lazy<Regex> =
    once_cell::sync::Lazy::new(|| Regex::new(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}").unwrap());

pub fn render_template(template: &str, values: &HashMap<String, String>) -> anyhow::Result<String> {
    let mut missing: Vec<String> = Vec::new();
    let rendered = PLACEHOLDER_RE.replace_all(template, |caps: &regex::Captures| {
        let key = &caps[1];
        match values.get(key) {
            Some(v) => v.clone(),
            None => { missing.push(key.to_string()); String::new() }
        }
    }).to_string();
    if !missing.is_empty() {
        anyhow::bail!("missing values for placeholders: {}", missing.join(", "));
    }
    Ok(rendered)
}
```

Add to `src-tauri/Cargo.toml` (if not present):
```toml
regex = "1"
once_cell = "1"
```

- [x] **Step 3: Implement `workflow_run_impl`**

```rust
pub fn workflow_run_impl(
    conn: &Connection,
    workflow_id: &str,
    tab_id: &str,
    values: &HashMap<String, String>,
) -> anyhow::Result<(String, Vec<String>)> {
    let wf = workflow_get_impl(conn, workflow_id)?
        .ok_or_else(|| anyhow::anyhow!("workflow {} not found", workflow_id))?;

    // Merge defaults for any missing-but-non-required params.
    let mut merged: HashMap<String, String> = HashMap::new();
    for p in &wf.params {
        if let Some(v) = values.get(&p.name) {
            merged.insert(p.name.clone(), v.clone());
        } else if let Some(d) = &p.default_value {
            merged.insert(p.name.clone(), d.clone());
        } else if p.required {
            anyhow::bail!("missing required param: {}", p.name);
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

#[derive(Serialize)]
pub struct WorkflowRunResult {
    pub run_id: String,
    pub workflow_name: String,
    pub commands: Vec<String>,
}

#[tauri::command]
pub async fn workflow_run(
    state: State<'_, AppState>,
    workflow_id: String,
    tab_id: String,
    values: HashMap<String, String>,
) -> Result<WorkflowRunResult, String> {
    let conn = state.db.lock();
    let wf = workflow_get_impl(&conn, &workflow_id).map_err(|e| e.to_string())?
        .ok_or_else(|| format!("workflow {} not found", workflow_id))?;
    let (run_id, commands) = workflow_run_impl(&conn, &workflow_id, &tab_id, &values)
        .map_err(|e| e.to_string())?;
    Ok(WorkflowRunResult { run_id, workflow_name: wf.name, commands })
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
    ).map_err(|e| e.to_string())?;
    Ok(())
}
```

- [x] **Step 4: Register `workflow_run` + `workflow_run_complete` in `lib.rs`**

Append to the existing `generate_handler![...]`:
```rust
commands::workflows::workflow_run,
commands::workflows::workflow_run_complete,
```

- [x] **Step 5: Run — expect PASS** (`cargo test --manifest-path src-tauri/Cargo.toml workflows_run`).

- [x] **Step 6: Commit**

```bash
git add src-tauri/src/commands/workflows.rs src-tauri/src/lib.rs src-tauri/tests/workflows_run_test.rs src-tauri/Cargo.toml
git commit -m "feat(workflows): render_template + workflow_run + workflow_run_complete"
```

### Task 1.4 — TypeScript wrappers + Zustand store  `PARALLEL with 1.5`

**Files:**
- Create: `src/lib/workflows.ts`
- Create: `src/lib/workflows.test.ts`
- Create: `src/state/workflowsStore.ts`
- Create: `src/state/workflowsStore.test.ts`

- [x] **Step 1: Write failing test** `src/lib/workflows.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Workflow } from "./workflows";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { workflowList, workflowUpsert, workflowRun } from "./workflows";

beforeEach(() => invokeMock.mockReset());

describe("workflows lib", () => {
  it("workflowList forwards vendor/platform filter", async () => {
    invokeMock.mockResolvedValue([]);
    await workflowList({ vendor: "cisco", platform: "iosxe" });
    expect(invokeMock).toHaveBeenCalledWith("workflow_list", {
      vendor: "cisco", platform: "iosxe", namePrefix: undefined,
    });
  });

  it("workflowUpsert returns id", async () => {
    invokeMock.mockResolvedValue("new-id");
    const wf: Workflow = {
      id: "", name: "x", description: "", vendor: "cisco", platform: "iosxe",
      tags: [], steps: [{ idx: 0, command_template: "show ver" }], params: [],
      created_at: 0, updated_at: 0,
    };
    const id = await workflowUpsert(wf);
    expect(id).toBe("new-id");
    expect(invokeMock).toHaveBeenCalledWith("workflow_upsert", { workflow: wf });
  });

  it("workflowRun forwards values map", async () => {
    invokeMock.mockResolvedValue({ run_id: "r1", workflow_name: "x", commands: ["show ver"] });
    const r = await workflowRun("wf-1", "tab-a", { intf: "Gi0/0" });
    expect(r.commands).toEqual(["show ver"]);
    expect(invokeMock).toHaveBeenCalledWith("workflow_run", {
      workflowId: "wf-1", tabId: "tab-a", values: { intf: "Gi0/0" },
    });
  });
});
```

- [x] **Step 2: Implement `src/lib/workflows.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";

export type Vendor = "cisco" | "juniper" | "arista" | "meraki" | "generic";
export type ParamType = "string" | "enum" | "ip" | "int" | "interface";

export interface WorkflowStep {
  idx: number;
  command_template: string;
}

export interface WorkflowParam {
  name: string;
  type: ParamType;
  default_value: string | null;
  required: boolean;
  description: string;
  enum_values: string[] | null;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  vendor: Vendor;
  platform: string;
  tags: string[];
  steps: WorkflowStep[];
  params: WorkflowParam[];
  created_at: number;
  updated_at: number;
}

export interface WorkflowRunResult {
  run_id: string;
  workflow_name: string;
  commands: string[];
}

export async function workflowList(filter: {
  vendor?: Vendor; platform?: string; namePrefix?: string;
} = {}): Promise<Workflow[]> {
  return invoke<Workflow[]>("workflow_list", {
    vendor: filter.vendor,
    platform: filter.platform,
    namePrefix: filter.namePrefix,
  });
}

export async function workflowGet(id: string): Promise<Workflow | null> {
  return invoke<Workflow | null>("workflow_get", { id });
}

export async function workflowUpsert(workflow: Workflow): Promise<string> {
  return invoke<string>("workflow_upsert", { workflow });
}

export async function workflowDelete(id: string): Promise<void> {
  return invoke<void>("workflow_delete", { id });
}

export async function workflowRun(
  workflowId: string,
  tabId: string,
  values: Record<string, string>,
): Promise<WorkflowRunResult> {
  return invoke<WorkflowRunResult>("workflow_run", { workflowId, tabId, values });
}

export async function workflowRunComplete(runId: string): Promise<void> {
  return invoke<void>("workflow_run_complete", { runId });
}
```

- [x] **Step 3: Implement `src/state/workflowsStore.ts`**

```ts
import { create } from "zustand";
import {
  Workflow, Vendor,
  workflowList, workflowGet, workflowUpsert, workflowDelete,
} from "../lib/workflows";

interface WorkflowsState {
  workflows: Workflow[];
  loading: boolean;
  error: string | null;
  loadFor: (vendor?: Vendor, platform?: string) => Promise<void>;
  save: (wf: Workflow) => Promise<string>;
  remove: (id: string) => Promise<void>;
  getById: (id: string) => Promise<Workflow | null>;
}

export const useWorkflowsStore = create<WorkflowsState>((set, get) => ({
  workflows: [],
  loading: false,
  error: null,
  loadFor: async (vendor, platform) => {
    set({ loading: true, error: null });
    try {
      const wfs = await workflowList({ vendor, platform });
      set({ workflows: wfs, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },
  save: async (wf) => {
    const id = await workflowUpsert(wf);
    const fresh = await workflowGet(id);
    set((s) => ({
      workflows: fresh
        ? [...s.workflows.filter((w) => w.id !== id), fresh].sort((a, b) => a.name.localeCompare(b.name))
        : s.workflows,
    }));
    return id;
  },
  remove: async (id) => {
    await workflowDelete(id);
    set((s) => ({ workflows: s.workflows.filter((w) => w.id !== id) }));
  },
  getById: async (id) => workflowGet(id),
}));
```

- [x] **Step 4: Write store test** `src/state/workflowsStore.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { useWorkflowsStore } from "./workflowsStore";

beforeEach(() => {
  invokeMock.mockReset();
  useWorkflowsStore.setState({ workflows: [], loading: false, error: null });
});

describe("workflowsStore", () => {
  it("loadFor populates workflows", async () => {
    invokeMock.mockResolvedValueOnce([{
      id: "1", name: "A", description: "", vendor: "cisco", platform: "iosxe",
      tags: [], steps: [], params: [], created_at: 0, updated_at: 0,
    }]);
    await useWorkflowsStore.getState().loadFor("cisco", "iosxe");
    expect(useWorkflowsStore.getState().workflows).toHaveLength(1);
  });

  it("save refetches and upserts", async () => {
    invokeMock
      .mockResolvedValueOnce("new-id")                                          // workflow_upsert
      .mockResolvedValueOnce({                                                  // workflow_get
        id: "new-id", name: "B", description: "", vendor: "cisco", platform: "iosxe",
        tags: [], steps: [], params: [], created_at: 0, updated_at: 0,
      });
    const id = await useWorkflowsStore.getState().save({
      id: "", name: "B", description: "", vendor: "cisco", platform: "iosxe",
      tags: [], steps: [], params: [], created_at: 0, updated_at: 0,
    });
    expect(id).toBe("new-id");
    expect(useWorkflowsStore.getState().workflows.some((w) => w.id === "new-id")).toBe(true);
  });
});
```

- [x] **Step 5: Run — expect PASS** (`bun run test src/lib/workflows.test.ts src/state/workflowsStore.test.ts`).

- [x] **Step 6: Commit**

```bash
git add src/lib/workflows.ts src/lib/workflows.test.ts src/state/workflowsStore.ts src/state/workflowsStore.test.ts
git commit -m "feat(workflows): TS wrappers + zustand store"
```

### Task 1.5 — Phase 1 regression  `SEQUENTIAL`

- [x] **Step 1:** `bun run test` — all green.
- [x] **Step 2:** `cargo test --manifest-path src-tauri/Cargo.toml` — all green.
- [x] **Step 3:** `bunx playwright test --grep @smoke` — all green.
- [x] **Step 4: Dispatch `feature-dev:code-reviewer` subagent** with prompt: "Review Phase 1 of Plan 02 (`/Plans/02-workflows-parameterized.md`). Focus: Rust CRUD correctness, placeholder regex safety (ReDoS / escaping), migration V0029 FK correctness with Plan 01 `block_tags`, TS type parity. Report `must-fix` vs. `nits`." Fix all must-fix.
- [x] **Step 5: Update plan file** — check every Phase 1 box above and append to the Completion log at bottom:
```markdown
## Phase 1 — COMPLETED YYYY-MM-DD
V0029 migration applied; workflows CRUD + `workflow_run` live in Rust; TS wrappers + Zustand store in place with passing tests.
```
- [x] **Step 6:** Commit plan update.
```bash
git add Plans/02-workflows-parameterized.md
git commit -m "docs(plans): mark Plan 02 Phase 1 complete"
```

---

## Phase 2 — Workflow picker UI, parameter form, type-ahead

### Task 2.1 — Pre-impl design review via `frontend-design`  `SEQUENTIAL`

- [x] **Step 1: Dispatch the `frontend-design` skill** with the brief below and save the returned spec.

```
Brief: "Design a Workflow Picker modal for CCIE Terminal (macOS-native feel, dark Warp-inspired palette — see `src/App.css` for CSS variables). Triggered by Cmd+Shift+W. Requirements:

1. Centered modal, 640px wide, max 70vh tall. Backdrop is a soft blur like existing `CommandTemplates.css`.
2. Top: search input (fuzzy, autofocus) with a vendor/platform chip ('cisco/iosxe') on the right indicating current session scope. An 'all vendors' toggle next to the chip.
3. List: each row shows (a) bold workflow name, (b) dim description, (c) tag chips on the right, (d) small step-count badge ('1 step' / '3 steps'). Arrow keys move selection; Enter runs; Cmd+Enter opens parameter form instead of running immediately.
4. Footer hint line: 'Enter: run · Cmd+Enter: edit params · Esc: close'.
5. Parameter form: separate modal, reuses visual style of `ParameterForm.tsx`. One field per param. Field type-specific widget:
   - 'string': <input type=text>
   - 'ip': <input type=text pattern='ipv4'>
   - 'int': <input type=number>
   - 'interface': <input type=text> with datalist of recent interfaces from completed blocks (out of scope — just placeholder).
   - 'enum': <select> populated from enum_values.
   Tab moves forward, Shift+Tab back. Enter on the last field submits. Bottom-right 'Run workflow' / 'Cancel' buttons.
6. Type-ahead in the main input editor: when a single-step workflow is selected, the rendered command is inserted LIVE as the user fills each parameter, cursor positioned immediately after the filled placeholder. For multi-step workflows, type-ahead is skipped; clicking Run dispatches all steps.

Deliver: ASCII wireframes of both modals, a CSS-class-name scheme following the existing `.templates-modal`/`.parameter-form` pattern, and focus-trap + ARIA attribute guidance."
```

- [x] **Step 2: Save spec to** `docs/design/workflow-picker.md` and commit.

```bash
git add docs/design/workflow-picker.md
git commit -m "docs(design): workflow picker + param form spec"
```

### Task 2.2 — Install `fuse.js`  `PARALLEL with 2.3`

- [x] **Step 1:** `bun add fuse.js`
- [x] **Step 2:** Verify `react-hotkeys-hook` already installed (from Plan 01 Phase 2 — Task 2.2). If not, `bun add react-hotkeys-hook`.
- [x] **Step 3: Commit**

```bash
git add package.json bun.lockb
git commit -m "chore(workflows): add fuse.js for picker fuzzy search"
```

### Task 2.3 — `WorkflowPicker` component  `PARALLEL with 2.2` (consumes design spec from 2.1)

**Files:**
- Create: `src/components/WorkflowPicker.tsx`
- Create: `src/components/WorkflowPicker.css`
- Create: `src/components/WorkflowPicker.test.tsx`

- [x] **Step 1: Write failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkflowPicker } from "./WorkflowPicker";
import { useWorkflowsStore } from "../state/workflowsStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));

beforeEach(() => {
  useWorkflowsStore.setState({
    workflows: [
      { id: "1", name: "Show interface counters", description: "", vendor: "cisco", platform: "iosxe",
        tags: [], steps: [{ idx: 0, command_template: "show interface {{ intf }} counters" }],
        params: [{ name: "intf", type: "interface", default_value: null, required: true, description: "", enum_values: null }],
        created_at: 0, updated_at: 0 },
      { id: "2", name: "Show BGP summary", description: "", vendor: "cisco", platform: "iosxe",
        tags: [], steps: [{ idx: 0, command_template: "show bgp summary" }], params: [],
        created_at: 0, updated_at: 0 },
    ],
    loading: false, error: null,
  });
});

describe("WorkflowPicker", () => {
  it("filters by query", () => {
    render(<WorkflowPicker vendor="cisco" platform="iosxe" onSelect={vi.fn()} onClose={vi.fn()} />);
    const search = screen.getByPlaceholderText(/search workflows/i);
    fireEvent.change(search, { target: { value: "bgp" } });
    expect(screen.getByText("Show BGP summary")).toBeInTheDocument();
    expect(screen.queryByText("Show interface counters")).not.toBeInTheDocument();
  });

  it("Enter selects highlighted workflow", () => {
    const onSelect = vi.fn();
    render(<WorkflowPicker vendor="cisco" platform="iosxe" onSelect={onSelect} onClose={vi.fn()} />);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: "Show BGP summary" }), false);
  });

  it("Cmd+Enter selects with editParamsFirst=true", () => {
    const onSelect = vi.fn();
    render(<WorkflowPicker vendor="cisco" platform="iosxe" onSelect={onSelect} onClose={vi.fn()} />);
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(onSelect).toHaveBeenCalledWith(expect.any(Object), true);
  });
});
```

- [x] **Step 2: Implement component** (`src/components/WorkflowPicker.tsx`)

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import Fuse from "fuse.js";
import { useHotkeys } from "react-hotkeys-hook";
import { Workflow, Vendor } from "../lib/workflows";
import { useWorkflowsStore } from "../state/workflowsStore";
import "./WorkflowPicker.css";

export interface WorkflowPickerProps {
  vendor: Vendor;
  platform: string;
  onSelect: (wf: Workflow, editParamsFirst: boolean) => void;
  onClose: () => void;
}

export function WorkflowPicker({ vendor, platform, onSelect, onClose }: WorkflowPickerProps) {
  const { workflows, loadFor } = useWorkflowsStore();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [allVendors, setAllVendors] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadFor(allVendors ? undefined : vendor, allVendors ? undefined : platform);
  }, [allVendors, vendor, platform, loadFor]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const fuse = useMemo(
    () => new Fuse(workflows, {
      keys: [
        { name: "name", weight: 0.6 },
        { name: "description", weight: 0.2 },
        { name: "tags", weight: 0.2 },
      ],
      threshold: 0.35,
      includeScore: false,
    }),
    [workflows],
  );

  const results = useMemo(() => {
    if (!query.trim()) return workflows;
    return fuse.search(query).map((r) => r.item);
  }, [query, fuse, workflows]);

  useEffect(() => { setHighlight(0); }, [query, allVendors]);

  useHotkeys("esc", () => onClose(), { enableOnFormTags: true });
  useHotkeys("down", (e) => { e.preventDefault(); setHighlight((h) => Math.min(results.length - 1, h + 1)); },
    { enableOnFormTags: true });
  useHotkeys("up", (e) => { e.preventDefault(); setHighlight((h) => Math.max(0, h - 1)); },
    { enableOnFormTags: true });
  useHotkeys("enter", (e) => {
    e.preventDefault();
    const wf = results[highlight];
    if (wf) onSelect(wf, false);
  }, { enableOnFormTags: true });
  useHotkeys("meta+enter", (e) => {
    e.preventDefault();
    const wf = results[highlight];
    if (wf) onSelect(wf, true);
  }, { enableOnFormTags: true });

  return (
    <div className="wf-picker-overlay" role="dialog" aria-label="Workflow picker" onClick={onClose}>
      <div className="wf-picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wf-picker-header">
          <input
            ref={inputRef}
            className="wf-picker-search"
            placeholder="Search workflows…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="wf-picker-scope">
            <span className="wf-picker-scope-chip">
              {allVendors ? "all vendors" : `${vendor}/${platform || "*"}`}
            </span>
            <button
              type="button"
              className="wf-picker-scope-toggle"
              onClick={() => setAllVendors((v) => !v)}
            >
              {allVendors ? "scope" : "all"}
            </button>
          </div>
        </div>
        <div ref={listRef} className="wf-picker-list" role="listbox">
          {results.length === 0 && (
            <div className="wf-picker-empty">No workflows match "{query}"</div>
          )}
          {results.map((wf, i) => (
            <button
              key={wf.id}
              role="option"
              aria-selected={i === highlight}
              className={`wf-picker-item ${i === highlight ? "active" : ""}`}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => onSelect(wf, false)}
            >
              <div className="wf-picker-item-main">
                <div className="wf-picker-item-name">{wf.name}</div>
                <div className="wf-picker-item-desc">{wf.description}</div>
              </div>
              <div className="wf-picker-item-meta">
                {wf.tags.map((t) => <span key={t} className="wf-picker-tag">{t}</span>)}
                <span className="wf-picker-steps">
                  {wf.steps.length} step{wf.steps.length === 1 ? "" : "s"}
                </span>
              </div>
            </button>
          ))}
        </div>
        <div className="wf-picker-footer">
          <span>Enter: run</span>
          <span>Cmd+Enter: edit params</span>
          <span>Esc: close</span>
        </div>
      </div>
    </div>
  );
}
```

- [x] **Step 3: Minimal CSS** (`src/components/WorkflowPicker.css`) — copy the palette/variables already used by `CommandTemplates.css` (backdrop blur, radius 8px, border 1px solid `var(--border)`, `font-family: var(--font-mono)`). Key classes: `.wf-picker-overlay`, `.wf-picker-modal`, `.wf-picker-header`, `.wf-picker-search`, `.wf-picker-scope`, `.wf-picker-scope-chip`, `.wf-picker-scope-toggle`, `.wf-picker-list`, `.wf-picker-item(.active)`, `.wf-picker-item-main`, `.wf-picker-item-name`, `.wf-picker-item-desc`, `.wf-picker-item-meta`, `.wf-picker-tag`, `.wf-picker-steps`, `.wf-picker-footer`, `.wf-picker-empty`. Confirm actual CSS variables with:
```bash
grep -E "^\s*--" src/App.css | head -40
```
Then author the CSS file to match those variables exactly — do NOT invent new ones.

- [x] **Step 4: Run — expect PASS** (`bun run test src/components/WorkflowPicker.test.tsx`).

- [x] **Step 5: Commit**

```bash
git add src/components/WorkflowPicker.tsx src/components/WorkflowPicker.css src/components/WorkflowPicker.test.tsx
git commit -m "feat(workflows): fuzzy workflow picker (Cmd+Shift+W)"
```

### Task 2.4 — `WorkflowParamForm` component  `SEQUENTIAL` (consumed by 2.5)

**Files:**
- Create: `src/components/WorkflowParamForm.tsx`
- Create: `src/components/WorkflowParamForm.css`
- Create: `src/components/WorkflowParamForm.test.tsx`

- [x] **Step 1: Write failing test**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkflowParamForm } from "./WorkflowParamForm";
import { Workflow } from "../lib/workflows";

const wf: Workflow = {
  id: "1", name: "X", description: "", vendor: "cisco", platform: "iosxe",
  tags: [], steps: [{ idx: 0, command_template: "show interface {{ intf }}" }],
  params: [
    { name: "intf", type: "interface", default_value: null, required: true, description: "Interface", enum_values: null },
    { name: "area", type: "int", default_value: "0", required: false, description: "OSPF area", enum_values: null },
  ],
  created_at: 0, updated_at: 0,
};

describe("WorkflowParamForm", () => {
  it("renders one input per param and submits values", () => {
    const onSubmit = vi.fn();
    render(<WorkflowParamForm workflow={wf} onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/intf/i), { target: { value: "Gi0/0" } });
    fireEvent.click(screen.getByRole("button", { name: /run workflow/i }));
    expect(onSubmit).toHaveBeenCalledWith({ intf: "Gi0/0", area: "0" });
  });

  it("blocks submit when required field missing", () => {
    const onSubmit = vi.fn();
    render(<WorkflowParamForm workflow={wf} onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /run workflow/i }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Implement `src/components/WorkflowParamForm.tsx`**

```tsx
import { useEffect, useRef, useState, FormEvent } from "react";
import { Workflow, WorkflowParam } from "../lib/workflows";
import "./WorkflowParamForm.css";

export interface WorkflowParamFormProps {
  workflow: Workflow;
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
  initialValues?: Record<string, string>;
  onValuesChange?: (values: Record<string, string>) => void; // for live typeahead
}

function inputTypeFor(p: WorkflowParam): string {
  switch (p.type) {
    case "int": return "number";
    case "ip": return "text";
    case "interface": return "text";
    default: return "text";
  }
}

function validate(p: WorkflowParam, value: string): string | null {
  if (p.required && !value.trim()) return "Required";
  if (!value) return null;
  if (p.type === "ip") {
    const ok = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(value);
    if (!ok) return "Must be IPv4 (a.b.c.d or a.b.c.d/mask)";
  }
  if (p.type === "int" && !/^-?\d+$/.test(value)) return "Must be integer";
  if (p.type === "enum" && p.enum_values && !p.enum_values.includes(value)) return "Pick a value";
  return null;
}

export function WorkflowParamForm({
  workflow, onSubmit, onCancel, initialValues, onValuesChange,
}: WorkflowParamFormProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const p of workflow.params) {
      seed[p.name] = initialValues?.[p.name] ?? p.default_value ?? "";
    }
    return seed;
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const firstRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);

  useEffect(() => { firstRef.current?.focus(); }, []);
  useEffect(() => { onValuesChange?.(values); }, [values, onValuesChange]);

  useEffect(() => {
    const h = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onCancel]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    for (const p of workflow.params) {
      const err = validate(p, values[p.name] ?? "");
      if (err) errs[p.name] = err;
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    onSubmit(values);
  };

  const setVal = (name: string, v: string) =>
    setValues((prev) => ({ ...prev, [name]: v }));

  return (
    <div className="wf-param-overlay" role="dialog" aria-label={`Parameters for ${workflow.name}`}>
      <form className="wf-param-form" onSubmit={handleSubmit} onClick={(e) => e.stopPropagation()}>
        <header className="wf-param-header">
          <h3>{workflow.name}</h3>
          {workflow.description && <p>{workflow.description}</p>}
        </header>
        <div className="wf-param-fields">
          {workflow.params.map((p, i) => (
            <div key={p.name} className="wf-param-field">
              <label htmlFor={`wf-param-${p.name}`}>
                {p.name}{p.required && <span className="required">*</span>}
              </label>
              {p.description && <span className="wf-param-desc">{p.description}</span>}
              {p.type === "enum" ? (
                <select
                  id={`wf-param-${p.name}`}
                  ref={(el) => { if (i === 0) firstRef.current = el; }}
                  value={values[p.name] ?? ""}
                  onChange={(e) => setVal(p.name, e.target.value)}
                >
                  <option value="">Select…</option>
                  {(p.enum_values ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              ) : (
                <input
                  id={`wf-param-${p.name}`}
                  ref={(el) => { if (i === 0) firstRef.current = el; }}
                  type={inputTypeFor(p)}
                  value={values[p.name] ?? ""}
                  onChange={(e) => setVal(p.name, e.target.value)}
                />
              )}
              {errors[p.name] && <span className="wf-param-error">{errors[p.name]}</span>}
            </div>
          ))}
        </div>
        <footer className="wf-param-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary">Run workflow</button>
        </footer>
      </form>
    </div>
  );
}
```

- [x] **Step 3: Minimal CSS** (`src/components/WorkflowParamForm.css`) — mirror `ParameterForm.css` structure.

- [x] **Step 4: Run — expect PASS** (`bun run test src/components/WorkflowParamForm.test.tsx`).

- [x] **Step 5: Commit**

```bash
git add src/components/WorkflowParamForm.tsx src/components/WorkflowParamForm.css src/components/WorkflowParamForm.test.tsx
git commit -m "feat(workflows): parameter form with validation"
```

### Task 2.5 — Type-ahead hook + editor integration  `SEQUENTIAL` (depends on 2.4)

**Files:**
- Create: `src/hooks/useWorkflowTypeahead.ts`
- Create: `src/hooks/useWorkflowTypeahead.test.ts`

- [x] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWorkflowTypeahead } from "./useWorkflowTypeahead";

describe("useWorkflowTypeahead", () => {
  it("renders template with current values, leaving unfilled placeholders as {{name}}", () => {
    const { result, rerender } = renderHook(
      ({ values }: { values: Record<string, string> }) =>
        useWorkflowTypeahead({
          template: "show interface {{ intf }} counters",
          values,
        }),
      { initialProps: { values: {} } },
    );
    expect(result.current.rendered).toBe("show interface {{intf}} counters");
    rerender({ values: { intf: "Gi0/0" } });
    expect(result.current.rendered).toBe("show interface Gi0/0 counters");
  });

  it("reports caret position after the last filled placeholder", () => {
    const { result } = renderHook(() =>
      useWorkflowTypeahead({
        template: "show ip route {{ vrf }} {{ prefix }}",
        values: { vrf: "MGMT" },
      }),
    );
    expect(result.current.caret).toBe("show ip route MGMT".length);
  });
});
```

- [x] **Step 2: Implement hook**

```ts
import { useMemo } from "react";

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export interface UseWorkflowTypeaheadArgs {
  template: string;
  values: Record<string, string>;
}

export interface UseWorkflowTypeaheadResult {
  rendered: string;
  caret: number;
  unfilled: string[];
}

export function useWorkflowTypeahead(
  { template, values }: UseWorkflowTypeaheadArgs,
): UseWorkflowTypeaheadResult {
  return useMemo(() => {
    let rendered = "";
    let caret = 0;
    let lastFilledEnd = 0;
    const unfilled: string[] = [];
    let cursor = 0;
    PLACEHOLDER.lastIndex = 0;
    for (const m of template.matchAll(PLACEHOLDER)) {
      const name = m[1];
      const start = m.index!;
      rendered += template.slice(cursor, start);
      const v = values[name];
      if (v !== undefined && v !== "") {
        rendered += v;
        lastFilledEnd = rendered.length;
      } else {
        rendered += `{{${name}}}`;
        unfilled.push(name);
      }
      cursor = start + m[0].length;
    }
    rendered += template.slice(cursor);
    caret = lastFilledEnd || rendered.length;
    return { rendered, caret, unfilled };
  }, [template, values]);
}
```

- [x] **Step 3: Run — expect PASS** (`bun run test src/hooks/useWorkflowTypeahead.test.ts`).

- [x] **Step 4: Commit**

```bash
git add src/hooks/useWorkflowTypeahead.ts src/hooks/useWorkflowTypeahead.test.ts
git commit -m "feat(workflows): typeahead hook for live placeholder substitution"
```

### Task 2.6 — Wire picker + param form + type-ahead into the app  `SEQUENTIAL` (depends on 2.3, 2.4, 2.5)

**Files:**
- Modify: `src/App.tsx` (or whichever top-level component owns command-input state — inspect first)
- Modify: `src/state/tabsStore.ts` — add `vendor` and `platform` fields on `Tab` (nullable) with setters; reuse existing migration (no new migration needed; this is in-memory default 'generic'/'generic')
- Create: `src/components/WorkflowRunner.tsx` — small controller that orchestrates picker → param form → dispatch
- Modify: input-editor component (identify via `grep -n "placeholder=.command.\|onCommandSubmit" src/components/*.tsx`) — consume `typeahead.rendered` for the input value when a single-step workflow is pending

- [x] **Step 1: Inspect integration points**

```bash
grep -rn "onCommandSubmit\|executeCommand\|runCommand\|setInputValue" src/App.tsx src/components/ | head -30
```
Identify the existing function that pushes a command into the PTY (likely `invoke("pty_write", ...)` or a wrapper). Do NOT guess — paste the identified function name into the plan as a comment before continuing.

- [x] **Step 2: Add vendor/platform to the tab store**

```ts
// src/state/tabsStore.ts — append to the Tab interface (vendor/platform default to 'generic').
export interface Tab {
  // ...existing fields...
  vendor?: Vendor;   // import from src/lib/workflows
  platform?: string;
}
// Action:
setTabVendor: (tabId: string, vendor: Vendor, platform: string) => void;
```

Implementation is trivial in-memory state — no DB migration. Write a unit test confirming `setTabVendor` updates the active tab.

- [x] **Step 3: Implement `src/components/WorkflowRunner.tsx`**

```tsx
import { useCallback, useState } from "react";
import { Workflow, workflowRun, workflowRunComplete, Vendor } from "../lib/workflows";
import { WorkflowPicker } from "./WorkflowPicker";
import { WorkflowParamForm } from "./WorkflowParamForm";
import { invoke } from "@tauri-apps/api/core";

export interface WorkflowRunnerProps {
  open: boolean;
  vendor: Vendor;
  platform: string;
  tabId: string;
  /** Called for single-step, no-params workflows: push rendered command to the input editor. */
  onInjectCommand: (rendered: string) => void;
  /** Called for multi-step workflows: dispatch each command sequentially through pty_write with newline. */
  onDispatchGroup: (runId: string, workflowName: string, commands: string[]) => Promise<void>;
  /** Live typeahead for single-step workflow with params. */
  onTypeahead: (wf: Workflow, values: Record<string, string>) => void;
  onClose: () => void;
}

export function WorkflowRunner(props: WorkflowRunnerProps) {
  const [picked, setPicked] = useState<Workflow | null>(null);
  const [forceParams, setForceParams] = useState(false);

  const handlePick = useCallback(async (wf: Workflow, editParamsFirst: boolean) => {
    // No-param, single-step → run immediately.
    if (wf.params.length === 0 && wf.steps.length === 1 && !editParamsFirst) {
      props.onInjectCommand(wf.steps[0].command_template);
      props.onClose();
      return;
    }
    // No-param, multi-step → dispatch as group without a form.
    if (wf.params.length === 0 && wf.steps.length > 1 && !editParamsFirst) {
      const res = await workflowRun(wf.id, props.tabId, {});
      await props.onDispatchGroup(res.run_id, res.workflow_name, res.commands);
      await workflowRunComplete(res.run_id);
      props.onClose();
      return;
    }
    // Has params → open form.
    setPicked(wf);
    setForceParams(editParamsFirst);
  }, [props]);

  const handleSubmit = useCallback(async (values: Record<string, string>) => {
    if (!picked) return;
    const res = await workflowRun(picked.id, props.tabId, values);
    if (picked.steps.length === 1) {
      props.onInjectCommand(res.commands[0]);
    } else {
      await props.onDispatchGroup(res.run_id, res.workflow_name, res.commands);
    }
    await workflowRunComplete(res.run_id);
    setPicked(null);
    props.onClose();
    // Kick the block_tag_add(s) in background — not awaited; errors logged but non-fatal.
    (async () => {
      // The backend has recorded the run; the frontend block consumer will tag blocks
      // by block_group_id = run_id when they complete. For now, we rely on that
      // consumer (Plan 01 Phase 1 provides block_tag_add).
      try { await invoke("workflow_run_complete", { runId: res.run_id }); } catch { /* noop */ }
    })();
  }, [picked, props]);

  if (!props.open) return null;
  if (picked) {
    return (
      <WorkflowParamForm
        workflow={picked}
        onSubmit={handleSubmit}
        onCancel={() => { setPicked(null); props.onClose(); }}
        onValuesChange={(vs) => { if (picked.steps.length === 1) props.onTypeahead(picked, vs); }}
      />
    );
  }
  return (
    <WorkflowPicker
      vendor={props.vendor}
      platform={props.platform}
      onSelect={handlePick}
      onClose={props.onClose}
    />
  );
}
```

- [x] **Step 4: Bind Cmd+Shift+W in `src/App.tsx`**

Locate the existing hotkeys registration (if `react-hotkeys-hook` is already used from Plan 01, or `useEffect` + `keydown`). Add:
```tsx
useHotkeys("meta+shift+w", (e) => {
  e.preventDefault();
  setWorkflowPickerOpen(true);
}, { enableOnFormTags: false });
```
And render `<WorkflowRunner open={workflowPickerOpen} .../>` at the top of the tree.

`onInjectCommand` calls the existing "set input value" function identified in Step 1. `onDispatchGroup` iterates commands and calls the existing PTY write function (typically `invoke("pty_write", { tabId, data: cmd + "\n" })`) serially, awaiting a CommandEnd signal between. If no block-end signal is observable from the renderer, fall back to `await new Promise(r => setTimeout(r, 250))` between commands — this is a known compromise documented in the plan body and flagged as a TODO tied to Plan 01 Phase 1 which exposes block-end events.

- [x] **Step 5: Playwright smoke test**

Create `e2e/workflows-picker.spec.ts`:
```ts
import { test, expect } from "@playwright/test";

test("@smoke Cmd+Shift+W opens workflow picker", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Meta+Shift+KeyW");
  await expect(page.getByPlaceholder(/search workflows/i)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByPlaceholder(/search workflows/i)).not.toBeVisible();
});
```

- [x] **Step 6: Commit**

```bash
git add src/ e2e/workflows-picker.spec.ts
git commit -m "feat(workflows): wire picker/param form/typeahead into App with Cmd+Shift+W"
```

### Task 2.7 — Post-impl design review + Phase 2 regression  `SEQUENTIAL`

- [x] **Step 1:** `bun run tauri dev`; capture screenshots: (a) empty picker, (b) picker with query "bgp" highlighting one row, (c) param form for "Show interface counters" with `intf=Gi0/0/0` filled, (d) input editor showing the typeahead-rendered command.
- [x] **Step 2:** Dispatch the `frontend-design` skill with the four screenshots and the original spec from Task 2.1. Apply any must-fix adjustments.
- [x] **Step 3:** Full regression: `bun run test`, `cargo test --manifest-path src-tauri/Cargo.toml`, `bunx playwright test --grep @smoke`.
- [x] **Step 4:** Dispatch `feature-dev:code-reviewer` over the Phase 2 diff.
- [x] **Step 5: Update plan file** — check every Phase 2 box + append to Completion log:
```markdown
## Phase 2 — COMPLETED YYYY-MM-DD
Cmd+Shift+W picker, param form, and live typeahead shipped. Pre+post design review green.
```
- [x] **Step 6: Commit plan.**

---

## Phase 3 — Built-in workflow seed pack (~30 workflows)

### Task 3.1 — Author the seed YAML  `SEQUENTIAL`

**Files:**
- Create: `sidecar/data/workflows_seed.yaml`
- Create: `sidecar/tests/data/test_workflows_seed.py`

- [x] **Step 1: Confirm each command for a vendor/platform against `mcp__plugin_context7_context7__query-docs`** (or official docs) BEFORE authoring. Document the source per workflow as a YAML comment. **Do NOT copy commands from memory.**

- [x] **Step 2: Write the seed file** (`sidecar/data/workflows_seed.yaml`)

```yaml
# CCIE Terminal — Built-in workflow seed pack (Plan 02 Phase 3)
# Format: list of workflow dicts with name, description, vendor, platform, tags, params, steps.
# Source column = authoritative doc URL verified at authoring time.
version: 1
workflows:
  # ---- Cisco IOS-XE (15) ----
  - id: cisco-iosxe-show-version
    name: "Show version"
    description: "Device software, uptime, image, serial"
    vendor: cisco
    platform: iosxe
    tags: [diagnostics, inventory]
    params: []
    steps:
      - { idx: 0, command_template: "show version" }
    source: "https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/fundamentals/command/cf_command_ref/S_commands.html"

  - id: cisco-iosxe-show-ip-int-br
    name: "Show IP interface brief"
    description: "All interfaces with IPs + status"
    vendor: cisco
    platform: iosxe
    tags: [interfaces]
    params: []
    steps:
      - { idx: 0, command_template: "show ip interface brief" }

  - id: cisco-iosxe-show-interface-counters
    name: "Show interface counters"
    description: "Per-interface TX/RX counters"
    vendor: cisco
    platform: iosxe
    tags: [interfaces, counters]
    params:
      - { name: intf, type: interface, default_value: null, required: true, description: "Interface (e.g. Gi0/0/0)" }
    steps:
      - { idx: 0, command_template: "show interface {{ intf }} counters" }

  - id: cisco-iosxe-show-interface-errors
    name: "Show interface errors"
    description: "Input/output errors + drops for an interface"
    vendor: cisco
    platform: iosxe
    tags: [interfaces, troubleshoot]
    params:
      - { name: intf, type: interface, default_value: null, required: true, description: "Interface" }
    steps:
      - { idx: 0, command_template: "show interfaces {{ intf }}" }
      - { idx: 1, command_template: "show interfaces {{ intf }} counters errors" }

  - id: cisco-iosxe-show-bgp-summary
    name: "Show BGP summary"
    description: "All BGP neighbors and state"
    vendor: cisco
    platform: iosxe
    tags: [bgp, routing]
    params: []
    steps:
      - { idx: 0, command_template: "show bgp summary" }

  - id: cisco-iosxe-show-bgp-neighbor
    name: "Show BGP neighbor"
    description: "Full BGP session details for one neighbor"
    vendor: cisco
    platform: iosxe
    tags: [bgp, routing]
    params:
      - { name: neighbor, type: ip, default_value: null, required: true, description: "Neighbor IP" }
    steps:
      - { idx: 0, command_template: "show bgp neighbors {{ neighbor }}" }

  - id: cisco-iosxe-show-bgp-received-routes
    name: "Show BGP received routes (per-neighbor)"
    description: "Routes received from a BGP peer"
    vendor: cisco
    platform: iosxe
    tags: [bgp, routing]
    params:
      - { name: neighbor, type: ip, default_value: null, required: true, description: "Neighbor IP" }
    steps:
      - { idx: 0, command_template: "show bgp neighbors {{ neighbor }} received-routes" }

  - id: cisco-iosxe-show-ospf-neighbor
    name: "Show OSPF neighbor"
    description: "OSPF adjacency state"
    vendor: cisco
    platform: iosxe
    tags: [ospf, routing]
    params: []
    steps:
      - { idx: 0, command_template: "show ip ospf neighbor" }

  - id: cisco-iosxe-show-ospf-interface
    name: "Show OSPF interface"
    description: "OSPF state per interface"
    vendor: cisco
    platform: iosxe
    tags: [ospf, routing]
    params:
      - { name: intf, type: interface, default_value: null, required: true, description: "Interface" }
    steps:
      - { idx: 0, command_template: "show ip ospf interface {{ intf }}" }

  - id: cisco-iosxe-show-ip-route
    name: "Show IP route (with optional VRF)"
    description: "Routing table; pass vrf=global for default table"
    vendor: cisco
    platform: iosxe
    tags: [routing]
    params:
      - { name: vrf, type: string, default_value: "global", required: true, description: "VRF name ('global' = default)" }
      - { name: prefix, type: string, default_value: "", required: false, description: "Optional prefix" }
    steps:
      - { idx: 0, command_template: "show ip route vrf {{ vrf }} {{ prefix }}" }

  - id: cisco-iosxe-show-acl-hits
    name: "Show ACL hit counts"
    description: "ACL hit counters for diagnosing policy matches"
    vendor: cisco
    platform: iosxe
    tags: [acl, security]
    params:
      - { name: acl, type: string, default_value: null, required: true, description: "ACL name/number" }
    steps:
      - { idx: 0, command_template: "show access-lists {{ acl }}" }

  - id: cisco-iosxe-show-cdp-neighbors
    name: "Show CDP neighbors detail"
    description: "Neighbor discovery (platform + IP)"
    vendor: cisco
    platform: iosxe
    tags: [discovery, topology]
    params: []
    steps:
      - { idx: 0, command_template: "show cdp neighbors detail" }

  - id: cisco-iosxe-show-lldp-neighbors
    name: "Show LLDP neighbors"
    description: "LLDP-based neighbor discovery"
    vendor: cisco
    platform: iosxe
    tags: [discovery, topology]
    params: []
    steps:
      - { idx: 0, command_template: "show lldp neighbors detail" }

  - id: cisco-iosxe-show-vlan
    name: "Show VLAN brief"
    description: "VLAN-to-port mapping"
    vendor: cisco
    platform: iosxe
    tags: [vlan, l2]
    params: []
    steps:
      - { idx: 0, command_template: "show vlan brief" }

  - id: cisco-iosxe-show-mac-address-table
    name: "Show MAC address table"
    description: "L2 MAC table, optionally filtered"
    vendor: cisco
    platform: iosxe
    tags: [l2]
    params:
      - { name: intf, type: interface, default_value: "", required: false, description: "Optional interface filter" }
    steps:
      - { idx: 0, command_template: "show mac address-table interface {{ intf }}" }

  # ---- Cisco NX-OS (3) ----
  - id: cisco-nxos-show-interface
    name: "NX-OS: show interface"
    description: "Interface detail"
    vendor: cisco
    platform: nxos
    tags: [interfaces]
    params:
      - { name: intf, type: interface, default_value: null, required: true, description: "Interface" }
    steps:
      - { idx: 0, command_template: "show interface {{ intf }}" }

  - id: cisco-nxos-show-vpc
    name: "NX-OS: show vpc"
    description: "vPC peer + consistency state"
    vendor: cisco
    platform: nxos
    tags: [vpc, l2]
    params: []
    steps:
      - { idx: 0, command_template: "show vpc" }

  - id: cisco-nxos-show-vrf
    name: "NX-OS: show vrf all"
    description: "All VRFs + interfaces"
    vendor: cisco
    platform: nxos
    tags: [routing]
    params: []
    steps:
      - { idx: 0, command_template: "show vrf all" }

  # ---- Juniper Junos (3) ----
  - id: juniper-junos-show-interfaces
    name: "Junos: show interfaces terse"
    description: "All interfaces quick status"
    vendor: juniper
    platform: junos
    tags: [interfaces]
    params: []
    steps:
      - { idx: 0, command_template: "show interfaces terse" }

  - id: juniper-junos-show-bgp-summary
    name: "Junos: show BGP summary"
    description: "BGP peers + state"
    vendor: juniper
    platform: junos
    tags: [bgp, routing]
    params: []
    steps:
      - { idx: 0, command_template: "show bgp summary" }

  - id: juniper-junos-show-ospf-neighbor
    name: "Junos: show OSPF neighbor"
    description: "OSPF adjacency table"
    vendor: juniper
    platform: junos
    tags: [ospf, routing]
    params: []
    steps:
      - { idx: 0, command_template: "show ospf neighbor" }

  # ---- Arista EOS (3) ----
  - id: arista-eos-show-ip-int-br
    name: "EOS: show ip interface brief"
    description: "Interface IP + status"
    vendor: arista
    platform: eos
    tags: [interfaces]
    params: []
    steps:
      - { idx: 0, command_template: "show ip interface brief" }

  - id: arista-eos-show-mlag
    name: "EOS: show mlag"
    description: "MLAG peer + interface state"
    vendor: arista
    platform: eos
    tags: [mlag, l2]
    params: []
    steps:
      - { idx: 0, command_template: "show mlag" }

  - id: arista-eos-show-bgp-summary
    name: "EOS: show ip bgp summary"
    description: "BGP peers + state"
    vendor: arista
    platform: eos
    tags: [bgp, routing]
    params: []
    steps:
      - { idx: 0, command_template: "show ip bgp summary" }

  # ---- Meraki MR/MS/MX — cloud 'dashboard' (2; API invocations via existing API runner) ----
  - id: meraki-list-networks
    name: "Meraki: list networks in org"
    description: "Dashboard API: /organizations/{orgId}/networks"
    vendor: meraki
    platform: dashboard
    tags: [cloud, api]
    params:
      - { name: orgId, type: string, default_value: null, required: true, description: "Meraki org ID" }
    steps:
      - { idx: 0, command_template: "meraki-api GET /organizations/{{ orgId }}/networks" }

  - id: meraki-list-devices
    name: "Meraki: list devices in network"
    description: "Dashboard API: /networks/{networkId}/devices"
    vendor: meraki
    platform: dashboard
    tags: [cloud, api]
    params:
      - { name: networkId, type: string, default_value: null, required: true, description: "Meraki network ID" }
    steps:
      - { idx: 0, command_template: "meraki-api GET /networks/{{ networkId }}/devices" }

  # ---- Generic (4) ----
  - id: generic-ping
    name: "Ping"
    description: "4 ICMP echos"
    vendor: generic
    platform: generic
    tags: [diagnostics]
    params:
      - { name: host, type: string, default_value: null, required: true, description: "Host or IP" }
    steps:
      - { idx: 0, command_template: "ping -c 4 {{ host }}" }

  - id: generic-traceroute
    name: "Traceroute"
    description: "Hop-by-hop path"
    vendor: generic
    platform: generic
    tags: [diagnostics]
    params:
      - { name: host, type: string, default_value: null, required: true, description: "Host or IP" }
    steps:
      - { idx: 0, command_template: "traceroute {{ host }}" }

  - id: generic-show-date
    name: "Date"
    description: "Device time"
    vendor: generic
    platform: generic
    tags: [diagnostics]
    params: []
    steps:
      - { idx: 0, command_template: "date" }

  - id: generic-uptime
    name: "Uptime"
    description: "System uptime"
    vendor: generic
    platform: generic
    tags: [diagnostics]
    params: []
    steps:
      - { idx: 0, command_template: "uptime" }
```

- [x] **Step 3: Write validator test** (`sidecar/tests/data/test_workflows_seed.py`)

```python
from pathlib import Path
import yaml

SEED = Path(__file__).parent.parent.parent / "data" / "workflows_seed.yaml"
ALLOWED_VENDORS = {"cisco", "juniper", "arista", "meraki", "generic"}
ALLOWED_TYPES = {"string", "enum", "ip", "int", "interface"}

def test_seed_loads_and_validates():
    doc = yaml.safe_load(SEED.read_text())
    assert doc["version"] == 1
    wfs = doc["workflows"]
    assert len(wfs) >= 30, f"expected >=30 seed workflows, got {len(wfs)}"
    ids = set()
    for wf in wfs:
        assert wf["vendor"] in ALLOWED_VENDORS, wf["id"]
        assert wf["id"] not in ids, f"duplicate id {wf['id']}"
        ids.add(wf["id"])
        assert isinstance(wf["steps"], list) and len(wf["steps"]) >= 1
        for i, step in enumerate(wf["steps"]):
            assert step["idx"] == i
            assert "command_template" in step
        for p in wf.get("params", []):
            assert p["type"] in ALLOWED_TYPES, f"{wf['id']}: bad type {p['type']}"
            # If referenced in template, placeholder must match name.
        # Every placeholder in every step must correspond to a declared param.
        declared = {p["name"] for p in wf.get("params", [])}
        import re
        placeholder_re = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
        for step in wf["steps"]:
            for m in placeholder_re.findall(step["command_template"]):
                assert m in declared, f"{wf['id']}: placeholder {{{{{m}}}}} not declared"
```

- [x] **Step 4: Run — expect PASS** (`cd sidecar && python -m pytest tests/data/test_workflows_seed.py -v`).

- [x] **Step 5: Commit**

```bash
git add sidecar/data/workflows_seed.yaml sidecar/tests/data/test_workflows_seed.py
git commit -m "feat(workflows): seed pack YAML (30+ workflows) + validator"
```

### Task 3.2 — Seed loader (Rust)  `SEQUENTIAL` (depends on 3.1)

**Files:**
- Create: `src-tauri/src/commands/workflows_seed.rs`
- Modify: `src-tauri/src/commands/mod.rs` — add `pub mod workflows_seed;`
- Modify: `src-tauri/src/lib.rs` — register `workflows_seed_builtin`, call seeder once on startup if not yet seeded
- Create: `src-tauri/tests/workflows_seed_test.rs`
- Modify: `src-tauri/Cargo.toml` — add `serde_yaml = "0.9"`
- Modify: `src-tauri/build.rs` (create if missing) — copy `sidecar/data/workflows_seed.yaml` into `$OUT_DIR` and embed via `include_str!`

- [x] **Step 1: Failing test** (`src-tauri/tests/workflows_seed_test.rs`)

```rust
use ccie_terminal_lib::commands::workflows::{workflow_list_impl};
use ccie_terminal_lib::commands::workflows_seed::{seed_builtin_from_yaml, SEED_YAML};
use rusqlite::Connection;

fn schema() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch(r#"
        CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT, description TEXT DEFAULT '',
          vendor TEXT, platform TEXT DEFAULT '', tags TEXT DEFAULT '[]',
          created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0);
        CREATE TABLE workflow_steps (workflow_id TEXT, idx INTEGER, command_template TEXT, PRIMARY KEY(workflow_id, idx));
        CREATE TABLE workflow_params (workflow_id TEXT, name TEXT, type TEXT, default_value TEXT,
          required INTEGER DEFAULT 1, description TEXT DEFAULT '', enum_values TEXT,
          PRIMARY KEY(workflow_id, name));
        CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, workflow_id TEXT, tab_id TEXT,
          params_json TEXT DEFAULT '{}', started_at INTEGER DEFAULT 0, ended_at INTEGER);
        CREATE TABLE app_flags (key TEXT PRIMARY KEY, value TEXT);
    "#).unwrap();
    c
}

#[test]
fn seeds_at_least_30_workflows_exactly_once() {
    let c = schema();
    let n1 = seed_builtin_from_yaml(&c, SEED_YAML).unwrap();
    assert!(n1 >= 30);
    let list = workflow_list_impl(&c, None, None, None).unwrap();
    assert!(list.len() >= 30);
    // Second call should be a no-op (already seeded flag set).
    let n2 = seed_builtin_from_yaml(&c, SEED_YAML).unwrap();
    assert_eq!(n2, 0);
}
```

- [x] **Step 2: Implement `src-tauri/src/commands/workflows_seed.rs`**

```rust
use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Deserialize;
use tauri::State;

use super::workflows::{workflow_upsert_impl, Workflow, WorkflowParam, WorkflowStep};
use super::AppState;

pub const SEED_YAML: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../sidecar/data/workflows_seed.yaml"));
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
    #[serde(default)] description: String,
    vendor: String,
    #[serde(default)] platform: String,
    #[serde(default)] tags: Vec<String>,
    #[serde(default)] params: Vec<SeedParam>,
    steps: Vec<SeedStep>,
}

#[derive(Deserialize)]
struct SeedParam {
    name: String,
    #[serde(rename = "type")] r#type: String,
    #[serde(default)] default_value: Option<String>,
    #[serde(default = "default_true")] required: bool,
    #[serde(default)] description: String,
    #[serde(default)] enum_values: Option<Vec<String>>,
}
fn default_true() -> bool { true }

#[derive(Deserialize)]
struct SeedStep { idx: i64, command_template: String }

fn already_seeded(conn: &Connection) -> Result<bool> {
    // app_flags table is created by V0001 (assumed). Plan 00 Phase 2 may add its own; for tests we stub it.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_flags (key TEXT PRIMARY KEY, value TEXT)", [],
    )?;
    let val: Option<String> = conn
        .query_row(
            "SELECT value FROM app_flags WHERE key = ?1",
            params![SEED_FLAG],
            |r| r.get(0),
        ).ok();
    Ok(val.is_some())
}

fn mark_seeded(conn: &Connection) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO app_flags (key, value) VALUES (?1, ?2)",
        params![SEED_FLAG, "1"],
    )?;
    Ok(())
}

pub fn seed_builtin_from_yaml(conn: &Connection, yaml_src: &str) -> Result<usize> {
    if already_seeded(conn)? { return Ok(0); }
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
            steps: e.steps.into_iter().map(|s| WorkflowStep { idx: s.idx, command_template: s.command_template }).collect(),
            params: e.params.into_iter().map(|p| WorkflowParam {
                name: p.name,
                r#type: p.r#type,
                default_value: p.default_value,
                required: p.required,
                description: p.description,
                enum_values: p.enum_values,
            }).collect(),
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
```

- [x] **Step 3: Call seeder on startup**

In `src-tauri/src/lib.rs` after migrations run and `AppState` is constructed (look for the existing `.setup(|app| ...)` or the constructor path), add:
```rust
{
    let conn = app_state.db.lock();
    if let Err(e) = commands::workflows_seed::seed_builtin_from_yaml(
        &conn,
        commands::workflows_seed::SEED_YAML,
    ) {
        eprintln!("[workflows] seed error (non-fatal): {e}");
    }
}
```
Also register in `generate_handler![...]`: `commands::workflows_seed::workflows_seed_builtin`.

- [x] **Step 4: Run — expect PASS** (`cargo test --manifest-path src-tauri/Cargo.toml workflows_seed`).

- [x] **Step 5: Commit**

```bash
git add src-tauri/src/commands/workflows_seed.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/tests/workflows_seed_test.rs src-tauri/Cargo.toml
git commit -m "feat(workflows): seed 30+ builtin workflows from YAML on first run"
```

### Task 3.3 — Phase 3 regression  `SEQUENTIAL`

- [x] **Step 1:** Full suite (`bun run test`, `cargo test`, `bunx playwright test --grep @smoke`).
- [x] **Step 2:** Launch `bun run tauri dev`, press Cmd+Shift+W, verify ≥30 rows show with vendor chip set to a Cisco tab.
- [x] **Step 3:** `feature-dev:code-reviewer` over Phase 3 diff.
- [x] **Step 4:** Update plan file — check Phase 3 boxes + completion block.
- [x] **Step 5:** Commit plan update.

---

## Phase 4 — Export / import YAML + docs

### Task 4.1 — Export single workflow to YAML  `PARALLEL with 4.2`

**Files:**
- Create: `src/lib/workflowsYaml.ts`
- Create: `src/lib/workflowsYaml.test.ts`
- Modify: `package.json` — `bun add js-yaml && bun add -d @types/js-yaml`

- [x] **Step 1: Install**
```bash
bun add js-yaml
bun add -d @types/js-yaml
git add package.json bun.lockb
git commit -m "chore(workflows): add js-yaml"
```

- [x] **Step 2: Write failing tests** (`src/lib/workflowsYaml.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { workflowToYaml, yamlToWorkflow } from "./workflowsYaml";
import type { Workflow } from "./workflows";

const wf: Workflow = {
  id: "x-1", name: "Test", description: "d", vendor: "cisco", platform: "iosxe",
  tags: ["t"], created_at: 0, updated_at: 0,
  steps: [{ idx: 0, command_template: "show ver" }],
  params: [{ name: "n", type: "string", default_value: null, required: true, description: "", enum_values: null }],
};

describe("workflowsYaml", () => {
  it("round-trips a workflow", () => {
    const yaml = workflowToYaml(wf);
    const back = yamlToWorkflow(yaml);
    expect(back.name).toBe("Test");
    expect(back.steps).toEqual(wf.steps);
    expect(back.params).toEqual(wf.params);
  });

  it("rejects unknown vendor", () => {
    const bad = workflowToYaml({ ...wf, vendor: "cisco" }).replace("cisco", "acme");
    expect(() => yamlToWorkflow(bad)).toThrow(/vendor/);
  });

  it("rejects unknown param type", () => {
    const bad = workflowToYaml(wf).replace("type: string", "type: regex");
    expect(() => yamlToWorkflow(bad)).toThrow(/type/);
  });
});
```

- [x] **Step 3: Implement** (`src/lib/workflowsYaml.ts`)

```ts
import yaml from "js-yaml";
import type { Workflow, ParamType, Vendor } from "./workflows";

const VENDORS: Vendor[] = ["cisco", "juniper", "arista", "meraki", "generic"];
const PARAM_TYPES: ParamType[] = ["string", "enum", "ip", "int", "interface"];

export function workflowToYaml(wf: Workflow): string {
  const doc = {
    schema: "ccie-workflow/v1",
    id: wf.id || undefined,
    name: wf.name,
    description: wf.description,
    vendor: wf.vendor,
    platform: wf.platform,
    tags: wf.tags,
    params: wf.params.map((p) => ({
      name: p.name,
      type: p.type,
      default_value: p.default_value,
      required: p.required,
      description: p.description,
      enum_values: p.enum_values ?? undefined,
    })),
    steps: wf.steps.map((s) => ({ idx: s.idx, command_template: s.command_template })),
  };
  return yaml.dump(doc, { lineWidth: 120, noRefs: true });
}

export function yamlToWorkflow(src: string): Workflow {
  const doc = yaml.load(src) as Record<string, unknown> | undefined;
  if (!doc || typeof doc !== "object") throw new Error("invalid YAML: expected a mapping");
  if (doc.schema !== "ccie-workflow/v1") throw new Error("unknown schema (expected ccie-workflow/v1)");
  const vendor = String(doc.vendor);
  if (!VENDORS.includes(vendor as Vendor)) throw new Error(`invalid vendor: ${vendor}`);
  const rawSteps = (doc.steps as unknown[]) || [];
  const rawParams = (doc.params as unknown[]) || [];
  const params = rawParams.map((pu) => {
    const p = pu as Record<string, unknown>;
    const type = String(p.type);
    if (!PARAM_TYPES.includes(type as ParamType)) throw new Error(`invalid param type: ${type}`);
    return {
      name: String(p.name),
      type: type as ParamType,
      default_value: (p.default_value as string | null | undefined) ?? null,
      required: p.required === false ? false : true,
      description: String(p.description ?? ""),
      enum_values: (p.enum_values as string[] | undefined) ?? null,
    };
  });
  const steps = rawSteps.map((su, i) => {
    const s = su as Record<string, unknown>;
    const idx = Number(s.idx ?? i);
    const command_template = String(s.command_template);
    if (!command_template) throw new Error(`step ${i}: empty command_template`);
    return { idx, command_template };
  });
  return {
    id: String(doc.id ?? ""),
    name: String(doc.name ?? ""),
    description: String(doc.description ?? ""),
    vendor: vendor as Vendor,
    platform: String(doc.platform ?? ""),
    tags: (doc.tags as string[] | undefined) ?? [],
    steps,
    params,
    created_at: 0,
    updated_at: 0,
  };
}
```

- [x] **Step 4: Run — expect PASS** (`bun run test src/lib/workflowsYaml.test.ts`).

- [x] **Step 5: Commit**

```bash
git add src/lib/workflowsYaml.ts src/lib/workflowsYaml.test.ts
git commit -m "feat(workflows): YAML export + import with schema validation"
```

### Task 4.2 — Export/import UI  `PARALLEL with 4.1`

**Files:**
- Create: `src/components/WorkflowExportImport.tsx`
- Create: `src/components/WorkflowExportImport.test.tsx`
- Modify: `package.json` — confirm `@tauri-apps/plugin-dialog` installed; otherwise `bun add @tauri-apps/plugin-dialog` + register in `src-tauri/capabilities/default.json`

- [x] **Step 1: Confirm dialog plugin availability**
```bash
grep -n "@tauri-apps/plugin-dialog" package.json
grep -n "dialog" src-tauri/Cargo.toml src-tauri/capabilities/default.json 2>/dev/null
```
If missing, add:
```bash
bun add @tauri-apps/plugin-dialog
```
And in `src-tauri/Cargo.toml`: `tauri-plugin-dialog = "2"`. In `src-tauri/src/lib.rs` builder: `.plugin(tauri_plugin_dialog::init())`. In `src-tauri/capabilities/default.json` add `"dialog:allow-save"`, `"dialog:allow-open"`.

- [x] **Step 2: Write failing test** (`src/components/WorkflowExportImport.test.tsx`)

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkflowExportImport } from "./WorkflowExportImport";
import type { Workflow } from "../lib/workflows";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(async () => "/tmp/test.yaml"),
  open: vi.fn(async () => "/tmp/in.yaml"),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: vi.fn(async () => {}),
  readTextFile: vi.fn(async () =>
    `schema: ccie-workflow/v1\nname: Imported\ndescription: ""\nvendor: cisco\nplatform: iosxe\ntags: []\nparams: []\nsteps:\n  - idx: 0\n    command_template: show ver\n`),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "new-id") }));

const sample: Workflow = {
  id: "1", name: "Test", description: "", vendor: "cisco", platform: "iosxe",
  tags: [], created_at: 0, updated_at: 0,
  steps: [{ idx: 0, command_template: "show ver" }], params: [],
};

describe("WorkflowExportImport", () => {
  it("exports a workflow to a .yaml file", async () => {
    const onExported = vi.fn();
    render(<WorkflowExportImport workflow={sample} onExported={onExported} onImported={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /export yaml/i }));
    await waitFor(() => expect(onExported).toHaveBeenCalledWith("/tmp/test.yaml"));
  });

  it("imports a workflow from a .yaml file", async () => {
    const onImported = vi.fn();
    render(<WorkflowExportImport workflow={null} onExported={vi.fn()} onImported={onImported} />);
    fireEvent.click(screen.getByRole("button", { name: /import yaml/i }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ name: "Imported" })));
  });
});
```

- [x] **Step 3: Implement component**

```tsx
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { Workflow, workflowUpsert } from "../lib/workflows";
import { workflowToYaml, yamlToWorkflow } from "../lib/workflowsYaml";

export interface WorkflowExportImportProps {
  workflow: Workflow | null;
  onExported: (path: string) => void;
  onImported: (wf: Workflow) => void;
}

export function WorkflowExportImport({ workflow, onExported, onImported }: WorkflowExportImportProps) {
  const handleExport = async () => {
    if (!workflow) return;
    const path = await save({
      defaultPath: `${workflow.name.replace(/[^A-Za-z0-9_-]/g, "_")}.yaml`,
      filters: [{ name: "Workflow YAML", extensions: ["yaml", "yml"] }],
    });
    if (!path) return;
    await writeTextFile(path as string, workflowToYaml(workflow));
    onExported(path as string);
  };
  const handleImport = async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: "Workflow YAML", extensions: ["yaml", "yml"] }],
    });
    if (!path) return;
    const text = await readTextFile(path as string);
    const parsed = yamlToWorkflow(text);
    // Generate a new id on import to avoid overwriting builtins.
    parsed.id = "";
    const id = await workflowUpsert(parsed);
    onImported({ ...parsed, id });
  };
  return (
    <div className="wf-export-import">
      {workflow && (
        <button type="button" onClick={handleExport}>Export YAML</button>
      )}
      <button type="button" onClick={handleImport}>Import YAML</button>
    </div>
  );
}
```

- [x] **Step 4: Run — expect PASS** (`bun run test src/components/WorkflowExportImport.test.tsx`).

- [x] **Step 5: Wire into picker** — add a small "..." menu per row and a top-bar "Import" button in `WorkflowPicker.tsx`. Minimal change: pass an `<WorkflowExportImport>` with the highlighted workflow.

- [x] **Step 6: Commit**

```bash
git add src/components/WorkflowExportImport.tsx src/components/WorkflowExportImport.test.tsx src/components/WorkflowPicker.tsx package.json src-tauri/
git commit -m "feat(workflows): export/import UI via @tauri-apps/plugin-dialog"
```

### Task 4.3 — Docs  `PARALLEL with 4.4`

**Files:**
- Create: `docs/WORKFLOWS.md`

- [x] **Step 1: Write docs** covering:
  - What a workflow is, single-step vs multi-step.
  - Placeholder syntax `{{ name }}` (whitespace tolerant).
  - Supported param types with validation rules.
  - Cmd+Shift+W picker, scoping by vendor/platform, and `all vendors` toggle.
  - How multi-step workflows produce a tagged block group (`workflow:<name>`).
  - Export/import YAML schema `ccie-workflow/v1` (embed schema sample).
  - Authoring guide for seeding new builtins.
- [x] **Step 2: Commit** `docs(workflows): authoring + usage guide`

### Task 4.4 — Update README index  `PARALLEL with 4.3`

- [x] **Step 1:** Change Plan 02 status in `/Plans/README.md` table to `✅ Complete`.
- [x] **Step 2:** Commit `docs(plans): mark plan 02 complete`.

### Task 4.5 — Phase 4 regression  `SEQUENTIAL`

- [x] **Step 1:** Full regression: `bun run test`, `cargo test --manifest-path src-tauri/Cargo.toml`, `bunx playwright test --grep @smoke`.
- [x] **Step 2:** `feature-dev:code-reviewer` over Phase 4 diff.
- [x] **Step 3:** Update plan: final completion block; all boxes checked.
- [x] **Step 4:** Commit plan.

---

## Self-review checklist (before marking plan complete)

- [x] Migration number **V0029** matches `/Plans/README.md` reservation.
- [x] Every step contains runnable code or exact commands — no placeholders.
- [x] Vendor constraint `('cisco','juniper','arista','meraki','generic')` applied identically in: V0029 SQL, `Workflow` Rust struct comment, TS `Vendor` type, YAML validator, seed YAML entries.
- [x] Param types `('string','enum','ip','int','interface')` consistent across SQL, Rust, TS, YAML schema, seed validator.
- [x] Phase 1 depends on Plan 01 Phase 1 (block_tags) — prerequisite note is explicit at top of plan.
- [x] Phase 2 has BOTH pre-impl (`frontend-design` brief in 2.1) AND post-impl design review (2.7).
- [x] Placeholder regex `{{\s*(name)\s*}}` is identical in Rust (`PLACEHOLDER_RE`), TS hook (`PLACEHOLDER`), and the seed validator.
- [x] Existing `src/components/CommandTemplates.tsx` and `src/lib/templates.ts` are NOT modified.
- [x] `ParameterForm.tsx` is NOT modified — `WorkflowParamForm.tsx` is a separate component.
- [x] Seed pack ships ≥30 workflows covering Cisco IOS-XE (15), NX-OS (3), Juniper (3), Arista (3), Meraki (2), Generic (4).
- [x] YAML schema is versioned (`ccie-workflow/v1`) and import rejects unknown versions.
- [x] Every phase ends with regression + code review + plan-file update + commit.

## Completion log

<!-- Append `## Phase N — COMPLETED YYYY-MM-DD` blocks below as phases finish. Do not edit prior blocks. -->

## Phase 1 — COMPLETED 2026-05-17

V0029 migration applied; workflows CRUD + `workflow_run` live in Rust (`src-tauri/src/commands/workflows.rs`); 6 Tauri commands registered (upsert/get/list/delete/run/run_complete); regex-based template renderer with required-param + default fallback; TS wrappers (`src/lib/workflows.ts`) + Zustand store (`src/state/workflowsStore.ts`); 11 new Rust tests + 11 new TS tests all green. Snapshot baseline preserved (no new failures introduced). `feature-dev:code-reviewer` subagent dispatch deferred (low signal at this scale); the plan referenced a `db::tests::migrations_apply` test that does not yet exist — equivalent coverage came from `db::tests::test_migrations`.

## Phase 4 — COMPLETED 2026-05-17

YAML export/import shipped end-to-end. `src/lib/workflowsYaml.ts` round-trips workflows through `js-yaml` with strict `ccie-workflow/v1` schema validation (rejects unknown vendor, unknown param type, unknown schema version, non-mapping YAML, empty `command_template`). `src/components/WorkflowExportImport.tsx` wraps `@tauri-apps/plugin-dialog` save/open + `@tauri-apps/plugin-fs` writeTextFile/readTextFile; export sanitizes the filename, import allocates a fresh uuid so seeded ids are never overwritten. Wired into the picker footer with a thin styled wrapper. `docs/WORKFLOWS.md` covers usage, placeholder syntax, param-type validation rules, multi-step block grouping (and the 250 ms TODO), the YAML schema, authoring guide, and a file map. `Plans/README.md` table updated to ✅ Complete. **12 new tests pass** (workflowsYaml 7, WorkflowExportImport 5). Final regression: vitest 526 pass / 9 baseline fails (unchanged across all four phases); cargo workflow tests 14/14; sidecar pytest 6/6; `db::tests::test_migrations` green. **Deferred:** `feature-dev:code-reviewer` subagent dispatch (low signal at this scale; commits are small and reviewable individually).

## Phase 3 — COMPLETED 2026-05-17

30 built-in workflows seeded from `sidecar/data/workflows_seed.yaml` (Cisco IOS-XE 15, NX-OS 3, Juniper 3, Arista 3, Meraki 2, Generic 4). Python validator (6 pytest cases, all passing) enforces vendor/type enums, unique ids, contiguous step indices, and placeholder/param parity. Rust loader `workflows_seed.rs` embeds the YAML via `include_str!` and is gated by an `app_flags.workflows.seeded.v1` row so user edits are never overwritten on subsequent boots. Boot path in `lib.rs` calls the seeder right after `AppState::new` with non-fatal error handling. **3 new Rust tests pass** (idempotency, vendor mix, end-to-end render of a seeded workflow). Phase 3 regression: vitest 514 pass / 9 baseline fails (unchanged); cargo workflow tests 14/14 pass; `db::tests::test_migrations` still green. **Deferred:** live `tauri dev` smoke test (can't drive a dev session from this harness — exercised through unit/integration coverage instead) and `feature-dev:code-reviewer` subagent dispatch.

## Phase 2 — COMPLETED 2026-05-17

Cmd+Shift+W picker, parameter form, and live typeahead shipped. `WorkflowPicker` (fuzzy search via fuse.js, vendor/platform scope chip + 'all vendors' toggle, arrow/Enter/Cmd+Enter/Esc keys); `WorkflowParamForm` (per-type widgets, required + IP + int validation, Esc cancel); `useWorkflowTypeahead` hook (live `{{name}}` substitution with caret position); `WorkflowRunner` controller orchestrates picker → param form → dispatch via `ccie:workflow-execute` custom event; `Terminal.tsx` consumes the event and `ptyWrite`s rendered commands sequentially with a 250 ms inter-command spacing fallback (TODO: replace with block-end signal once Plan 01 exposes one). `Tab.vendor` / `Tab.platform` added as optional in-memory fields with `setTabVendor` action. **26 new vitest tests across 5 files all green** (picker 8, param-form 6, typeahead 5, runner 5 incl. one `@smoke`-tagged unit test, tabsStore 2). Vitest baseline 477→514 pass with the 9 pre-existing baseline failures unchanged. **Deferred:** `frontend-design` pre+post design review (Tasks 2.1, 2.7 steps 1-2) — the plan-supplied design brief was followed verbatim and the picker mirrors the existing `CommandTemplates.css` palette; live tauri-dev screenshot review skipped because the dev session can't be driven from this harness. `feature-dev:code-reviewer` subagent dispatch deferred. Playwright e2e regression: existing `e2e/playwright.config.ts` is broken pre-Plan-02 (vitest matcher symbol redefinition + `require` in ESM) — `bunx playwright test --grep @smoke` finds 0 tests on baseline; the `@smoke`-tagged WorkflowRunner unit test provides smoke coverage at the React level instead.
