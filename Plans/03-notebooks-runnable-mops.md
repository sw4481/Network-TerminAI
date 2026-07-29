# 03 — Notebooks: Runnable MOPs (Method-Of-Procedure)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the existing block-only notebook prototype (`src/components/BlockNotebook.tsx`, `src-tauri/src/commands/notebooks.rs`, `src/lib/notebook.ts`) into a **runnable MOP engine**. A notebook is an ordered typed cell graph (markdown / command / approval / assertion / parameter) persisted as markdown with YAML frontmatter and mirrored in SQLite. The Rust runtime executes cells sequentially against the active tab's PTY, gates on `approval` cells, evaluates `assertion` cells by piping the produced block's output through the Plan 00 `parse_show` sidecar and running a JSONPath (`jsonpath-plus`) predicate, and records a full audit trail in `notebook_runs` / `notebook_cell_runs`. A failed run can be resumed from the failed cell.

**Why this matters:** Every serious network change is a MOP. Today CCIEs paste MOPs from Word/Confluence and run each line manually; there's no structured hand-off between "prepare", "execute", "validate". This plan turns `.mop.md` into a first-class executable artefact and yields a resumable audit record for every change window.

**Architecture:**

- **Parser (Rust, `src-tauri/src/notebooks/parser.rs`):** markdown-with-YAML-frontmatter → `Notebook { frontmatter, cells: Vec<NotebookCell> }`. Fenced code blocks with info strings `command`, `assertion`, `approval`, `parameter` become typed cells. Plain prose becomes `markdown` cells. Round-trippable.
- **Storage:** `notebooks` + `notebook_cells` tables (authoritative typed cell graph) + `notebook_runs` + `notebook_cell_runs` (audit trail). The raw markdown body is also stored in `notebooks.body_markdown` so round-trip export is byte-stable.
- **Runtime engine (Rust, `src-tauri/src/notebooks/runner.rs`):** a `NotebookRunner` state machine driven by a `tokio::sync::mpsc` control channel (`Pause | Resume | Cancel | Approve`). For `command` cells it issues `PtyHandle::write` (via the existing `pty_write` surface, tagging output with `block_id` just like an interactive block), awaits the emitted `PtyEvent::CommandComplete`, persists the resulting `command_blocks` row, and records `notebook_cell_runs.block_id`. For `assertion` cells the runner captures the produced block's output and calls `commands::parsers::parse_show` (Plan 00) — if the parser path returns data, the assertion's JSONPath selector + comparator are evaluated in-process via a Rust JSONPath crate (we use `jsonpath_lib` in Rust — verify via context7 before pinning); on the frontend we additionally render a preview using `jsonpath-plus`. For `approval` cells it transitions to `paused` and blocks until the control channel delivers `Approve` or `Cancel`. For `parameter` cells (only at the top of a notebook) the runner reads `params_json` supplied at run start and substitutes `{{var}}` into subsequent command cells.
- **Frontend:** `src/components/notebooks/NotebookPanel.tsx` — cell list with per-cell status chip (pending / running / passed / failed / skipped / awaiting-approval), toolbar with Run / Run-from-here / Stop / Resume-from-failure. Rich markdown rendering for `markdown` cells via `react-markdown` (already present — verify; otherwise `marked`). Approval cells render as a modal-like inline card with a "Continue" button. Assertion cells render a pass/fail chip + the JSONPath expression + actual-value diff.
- **Library UI:** replace the existing `BlockNotebook` modal with a `NotebookLibrary` modal that lists stored runnable notebooks, plus import-from-file / import-from-URL / export / share.
- **Seeds:** 10 canonical MOPs shipped as `sidecar/../notebooks/seeds/*.mop.md` and imported on first run.

**Tech Stack:** Rust (rusqlite, serde_yaml, pulldown-cmark, jsonpath_lib), Tauri 2, React 19, `jsonpath-plus` (already a dep — see `package.json`, used today in `src/components/api/jsonFilter.ts`), `react-markdown` (verify present), Zustand 5. Plan 00 `parsers::parse_show` is a **hard dependency** for assertion evaluation; Plan 01 `command_blocks` / `block_tags` give us pin-and-tag on blocks produced by a run.

**Prerequisites:**
- Plan 00 Phase 2 complete (`parse_show` Tauri command available for assertion evaluation).
- Plan 01 Phase 1 complete (blocks have the richer schema so runner-produced blocks can be tagged `notebook-run:<id>`).

**Downstream consumers:**
- Plan 06 (Pre/Post Change Verification) — assertion cells are the baseline primitive.
- Plan 07 (Multi-Device Fan-Out) — a fan-out run is just a notebook executed in parallel across N targets.
- Plan 15 (AI Troubleshooting Tree) — generated playbooks serialize to the same cell graph.

**Migration reservation:** V0030 (per `/Plans/README.md`).

**Prototype to extend (do not rewrite):**
- `src/components/BlockNotebook.tsx` — save/load modal for block-only notebooks. Keep it working during Phase 1-3 and retire it in Phase 4 when `NotebookLibrary` supersedes it.
- `src-tauri/src/commands/notebooks.rs` — `notebooks_save`/`list`/`get`/`delete` against `block_notebooks` (V0021). These commands STAY: they serve the legacy "snapshot of blocks" model. The new runnable-notebook surface lives alongside under `notebooks_runnable_*` names.
- `src/lib/notebook.ts` — keep `BlockNotebook` / `exportBlocksToNotebook` / `parseNotebookFile` (used by the legacy modal). Add new types (`RunnableNotebook`, `NotebookCell`, etc.) in a sibling file `src/lib/runnableNotebook.ts` to avoid name collisions.

---

## Phase 1 — Schema, parser, and round-trip

### Task 1.1 — Migration V0030  `SEQUENTIAL`

**Files:**
- Create: `src-tauri/migrations/V0030__runnable_notebooks.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Runnable notebooks (MOPs). Distinct from V0021 `block_notebooks`
-- (block_notebooks is a "snapshot of executed blocks"; these are executable recipes.)
CREATE TABLE IF NOT EXISTS notebooks (
  id TEXT PRIMARY KEY,                       -- uuidv4
  title TEXT NOT NULL,
  description TEXT,
  vendor TEXT,                               -- 'cisco' | 'juniper' | 'arista' | NULL (multi)
  platform TEXT,                             -- 'iosxe' | 'nxos' | 'junos' | NULL
  frontmatter_json TEXT NOT NULL DEFAULT '{}',
  body_markdown TEXT NOT NULL,               -- verbatim markdown for byte-stable export
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_notebooks_vendor ON notebooks(vendor);

CREATE TABLE IF NOT EXISTS notebook_cells (
  notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  cell_type TEXT NOT NULL CHECK (cell_type IN ('markdown','command','approval','assertion','parameter')),
  content TEXT NOT NULL,                     -- raw cell body (markdown / command / JSONPath expr / etc.)
  metadata_json TEXT NOT NULL DEFAULT '{}',  -- per-cell-type config (see parser)
  PRIMARY KEY (notebook_id, idx)
);

CREATE TABLE IF NOT EXISTS notebook_runs (
  id TEXT PRIMARY KEY,                       -- uuidv4
  notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  tab_id TEXT NOT NULL,                      -- which PTY tab owns this run
  status TEXT NOT NULL CHECK (status IN ('running','paused','completed','failed','cancelled')),
  params_json TEXT NOT NULL DEFAULT '{}',    -- user-supplied {{var}} values
  started_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_notebook_runs_notebook ON notebook_runs(notebook_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_notebook_runs_status  ON notebook_runs(status);

CREATE TABLE IF NOT EXISTS notebook_cell_runs (
  run_id TEXT NOT NULL REFERENCES notebook_runs(id) ON DELETE CASCADE,
  cell_idx INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','passed','failed','skipped','awaiting_approval')),
  block_id TEXT,                             -- FK to command_blocks when cell_type='command' or 'assertion'
  error TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  PRIMARY KEY (run_id, cell_idx)
);
CREATE INDEX IF NOT EXISTS idx_notebook_cell_runs_status ON notebook_cell_runs(run_id, status);
```

- [ ] **Step 2: Apply + verify**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib -- db::tests::migrations_apply
```

If no such test exists, add a minimal one in `src-tauri/src/db.rs` that opens an in-memory DB, runs all refinery migrations, and asserts `PRAGMA table_info(notebook_cells)` returns 5 columns.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/migrations/V0030__runnable_notebooks.sql
git commit -m "feat(db): V0030 runnable notebooks + cell graph + run audit tables"
```

### Task 1.2 — Rust notebook parser (markdown → typed cell graph)  `SEQUENTIAL` (depends on 1.1)

**Files:**
- Create: `src-tauri/src/notebooks/mod.rs`
- Create: `src-tauri/src/notebooks/parser.rs`
- Create: `src-tauri/src/notebooks/model.rs`
- Create: `src-tauri/src/notebooks/tests/fixtures/bgp_peer_bringup.mop.md`
- Modify: `src-tauri/src/lib.rs` — `pub mod notebooks;`
- Modify: `src-tauri/Cargo.toml` — add `serde_yaml = "0.9"`, `pulldown-cmark = "0.11"` (verify latest via context7)

- [ ] **Step 1: Verify crate versions**

```bash
# from this plan's agent:
# mcp__plugin_context7_context7__query-docs for "pulldown-cmark latest 0.x version Rust 1.80"
# and "serde_yaml replacement 2026 (serde_yml fork)"
```
If `serde_yaml` is deprecated, use `serde_yml = "0.0.12"` — confirm before coding.

- [ ] **Step 2: Write the fixture**

`src-tauri/src/notebooks/tests/fixtures/bgp_peer_bringup.mop.md`:

~~~markdown
---
title: BGP Peer Bringup
description: Bring up a new IBGP peer, verify session, verify prefix exchange.
vendor: cisco
platform: iosxe
parameters:
  - name: peer_ip
    prompt: Neighbor IP
    default: 10.0.0.2
  - name: peer_asn
    prompt: Neighbor ASN
    default: "65001"
---

# BGP Peer Bringup

## Step 1 — Pre-check

```command
show ip bgp summary
```

## Step 2 — Configure peer

```approval
Review config below, then click Continue to apply.
```

```command
configure terminal
router bgp 65001
 neighbor {{peer_ip}} remote-as {{peer_asn}}
 neighbor {{peer_ip}} activate
end
```

## Step 3 — Validate

```assertion
{"command": "show ip bgp summary", "jsonpath": "$.vrf.default.neighbor['{{peer_ip}}'].session_state", "op": "equals", "expected": "Established"}
```
~~~

- [ ] **Step 3: Write the model types**

`src-tauri/src/notebooks/model.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum NotebookCell {
    Markdown { content: String },
    Command { content: String, #[serde(default)] metadata: CommandMeta },
    Approval { content: String },
    Assertion { spec: AssertionSpec },
    Parameter { params: Vec<ParameterSpec> },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct CommandMeta {
    #[serde(default)]
    pub timeout_s: Option<u32>,
    #[serde(default)]
    pub expect_exit: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AssertionSpec {
    pub command: String,
    pub jsonpath: String,
    pub op: AssertionOp,
    pub expected: serde_json::Value,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssertionOp { Equals, NotEquals, Contains, GreaterThan, LessThan, Exists }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParameterSpec {
    pub name: String,
    pub prompt: String,
    #[serde(default)]
    pub default: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Frontmatter {
    pub title: String,
    #[serde(default)] pub description: Option<String>,
    #[serde(default)] pub vendor: Option<String>,
    #[serde(default)] pub platform: Option<String>,
    #[serde(default)] pub parameters: Vec<ParameterSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Notebook {
    pub frontmatter: Frontmatter,
    pub cells: Vec<NotebookCell>,
    pub body_markdown: String,
}
```

- [ ] **Step 4: Write failing parser round-trip test**

`src-tauri/src/notebooks/parser.rs` (test section — write this first, fail fast):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("tests/fixtures/bgp_peer_bringup.mop.md");

    #[test]
    fn parses_bgp_fixture_into_cells() {
        let nb = parse_markdown(FIXTURE).expect("parse");
        assert_eq!(nb.frontmatter.title, "BGP Peer Bringup");
        assert_eq!(nb.frontmatter.vendor.as_deref(), Some("cisco"));
        assert_eq!(nb.frontmatter.parameters.len(), 2);

        // Expected cell sequence: Parameter (synthetic from frontmatter), Markdown (h1+h2 prose),
        // Command (show ip bgp summary), Markdown (step 2 header), Approval, Command (configure terminal block),
        // Markdown (step 3 header), Assertion.
        use NotebookCell::*;
        assert!(matches!(nb.cells[0], Parameter { .. }));
        assert!(matches!(nb.cells.iter().find(|c| matches!(c, Command { content, .. } if content.contains("show ip bgp summary"))), Some(_)));
        assert!(matches!(nb.cells.iter().find(|c| matches!(c, Approval { .. })), Some(_)));
        let assertion = nb.cells.iter().find_map(|c| match c { Assertion { spec } => Some(spec), _ => None }).expect("assertion cell");
        assert_eq!(assertion.command, "show ip bgp summary");
        assert_eq!(assertion.op, AssertionOp::Equals);
    }

    #[test]
    fn round_trip_preserves_body_markdown_bytes() {
        let nb = parse_markdown(FIXTURE).unwrap();
        assert_eq!(nb.body_markdown, FIXTURE);
        let rendered = render_markdown(&nb);
        // Rendering from cells alone is a lossy projection; body_markdown is the source of truth.
        // But rendered must still parse back to an equivalent cell graph.
        let reparsed = parse_markdown(&rendered).unwrap();
        assert_eq!(reparsed.cells, nb.cells);
    }

    #[test]
    fn rejects_unknown_fence_lang() {
        let bad = "---\ntitle: x\n---\n```wat\nboom\n```\n";
        let err = parse_markdown(bad).unwrap_err();
        assert!(err.to_string().contains("unknown cell type"));
    }
}
```

- [ ] **Step 5: Run — expect FAIL**

```bash
cargo test --manifest-path src-tauri/Cargo.toml notebooks::parser
```

- [ ] **Step 6: Implement `parse_markdown` + `render_markdown`**

`src-tauri/src/notebooks/parser.rs`:

```rust
use anyhow::{anyhow, bail, Context, Result};
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};

use super::model::*;

/// Split raw text into (yaml_frontmatter, body_markdown). Frontmatter is delimited
/// by `---` fences at the top of the document; body is everything after.
fn split_frontmatter(src: &str) -> Result<(&str, &str)> {
    let src = src.trim_start_matches('\u{feff}');
    if !src.starts_with("---") {
        return Ok(("", src));
    }
    let after = &src[3..];
    let end = after.find("\n---").ok_or_else(|| anyhow!("unterminated frontmatter"))?;
    let yaml = &after[..end];
    let rest = &after[end + 4..];
    let rest = rest.strip_prefix('\n').unwrap_or(rest);
    Ok((yaml, rest))
}

pub fn parse_markdown(src: &str) -> Result<Notebook> {
    let (yaml, body) = split_frontmatter(src)?;
    let frontmatter: Frontmatter = if yaml.trim().is_empty() {
        Frontmatter { title: "Untitled".into(), description: None, vendor: None, platform: None, parameters: vec![] }
    } else {
        serde_yaml::from_str(yaml).context("invalid YAML frontmatter")?
    };

    let mut cells: Vec<NotebookCell> = Vec::new();
    if !frontmatter.parameters.is_empty() {
        cells.push(NotebookCell::Parameter { params: frontmatter.parameters.clone() });
    }

    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_YAML_STYLE_METADATA_BLOCKS);
    let parser = Parser::new_ext(body, opts);

    let mut prose_buf = String::new();
    let mut in_code: Option<String> = None;
    let mut code_buf = String::new();

    let flush_prose = |prose_buf: &mut String, cells: &mut Vec<NotebookCell>| {
        let trimmed = prose_buf.trim();
        if !trimmed.is_empty() {
            cells.push(NotebookCell::Markdown { content: prose_buf.clone() });
        }
        prose_buf.clear();
    };

    for ev in parser {
        match ev {
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(lang))) => {
                flush_prose(&mut prose_buf, &mut cells);
                in_code = Some(lang.to_string());
                code_buf.clear();
            }
            Event::Text(t) if in_code.is_some() => code_buf.push_str(&t),
            Event::End(TagEnd::CodeBlock) => {
                let lang = in_code.take().unwrap_or_default();
                let body = std::mem::take(&mut code_buf);
                let cell = classify_fence(&lang, body)?;
                cells.push(cell);
            }
            Event::Text(t) => prose_buf.push_str(&t),
            Event::SoftBreak | Event::HardBreak => prose_buf.push('\n'),
            Event::Start(Tag::Heading { level, .. }) => {
                prose_buf.push_str(&"#".repeat(level as usize));
                prose_buf.push(' ');
            }
            Event::End(TagEnd::Heading(_)) => prose_buf.push_str("\n\n"),
            Event::End(TagEnd::Paragraph) => prose_buf.push_str("\n\n"),
            _ => {}
        }
    }
    flush_prose(&mut prose_buf, &mut cells);

    Ok(Notebook { frontmatter, cells, body_markdown: src.to_string() })
}

fn classify_fence(lang: &str, body: String) -> Result<NotebookCell> {
    match lang.trim() {
        "command" => Ok(NotebookCell::Command { content: body.trim_end().to_string(), metadata: CommandMeta::default() }),
        "approval" => Ok(NotebookCell::Approval { content: body.trim_end().to_string() }),
        "assertion" => {
            let spec: AssertionSpec = serde_json::from_str(body.trim())
                .context("assertion cell must be JSON with {command, jsonpath, op, expected}")?;
            Ok(NotebookCell::Assertion { spec })
        }
        // Unknown or non-MOP language fences (e.g. ```bash, ```python) render as markdown code blocks.
        "" => Ok(NotebookCell::Markdown { content: format!("```\n{body}```\n") }),
        other if is_known_prose_lang(other) => Ok(NotebookCell::Markdown { content: format!("```{other}\n{body}```\n") }),
        other => bail!("unknown cell type: ```{other}"),
    }
}

fn is_known_prose_lang(s: &str) -> bool {
    matches!(s, "bash" | "sh" | "json" | "yaml" | "text" | "rust" | "python" | "md")
}

/// Re-render a Notebook's cell graph back to markdown. Used when the user edits cells in the UI
/// (rather than the raw markdown body); NOT used for exporting a notebook that was imported
/// from a file — for those we return `notebook.body_markdown` verbatim.
pub fn render_markdown(nb: &Notebook) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&serde_yaml::to_string(&nb.frontmatter).unwrap_or_default());
    out.push_str("---\n\n");
    for cell in &nb.cells {
        match cell {
            NotebookCell::Parameter { .. } => { /* synthesised from frontmatter; don't re-emit */ }
            NotebookCell::Markdown { content } => { out.push_str(content); if !content.ends_with('\n') { out.push('\n'); } out.push('\n'); }
            NotebookCell::Command { content, .. } => { out.push_str("```command\n"); out.push_str(content); out.push_str("\n```\n\n"); }
            NotebookCell::Approval { content } => { out.push_str("```approval\n"); out.push_str(content); out.push_str("\n```\n\n"); }
            NotebookCell::Assertion { spec } => {
                out.push_str("```assertion\n");
                out.push_str(&serde_json::to_string(spec).unwrap_or_default());
                out.push_str("\n```\n\n");
            }
        }
    }
    out
}
```

- [ ] **Step 7: Run — expect PASS**

```bash
cargo test --manifest-path src-tauri/Cargo.toml notebooks::parser
```

If `round_trip_preserves_body_markdown_bytes` fails on the second assertion (re-render → re-parse equivalence) and the diff is only whitespace, relax the assertion to compare `reparsed.cells == nb.cells` — do NOT silently delete the test; document the known-lossy direction.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/notebooks/ src-tauri/Cargo.toml
git commit -m "feat(notebooks): markdown parser with typed cell graph + round-trip tests"
```

### Task 1.3 — CRUD Tauri commands for runnable notebooks  `PARALLEL with 1.4`

**Files:**
- Create: `src-tauri/src/commands/notebooks_runnable.rs`
- Modify: `src-tauri/src/commands/mod.rs` — `pub mod notebooks_runnable;`
- Modify: `src-tauri/src/lib.rs` — register new commands in `tauri::generate_handler!`
- Create: `src-tauri/tests/notebooks_runnable_crud_test.rs`

- [ ] **Step 1: Write failing CRUD test**

```rust
// src-tauri/tests/notebooks_runnable_crud_test.rs
// (Use the existing test-harness helpers in src-tauri/tests/common/ — read that dir first; do not invent new harness plumbing.)

#[tokio::test]
async fn roundtrip_import_export_notebook() {
    let app = test_app().await;
    let md = include_str!("fixtures/bgp_peer_bringup.mop.md");
    let id: String = invoke(&app, "notebook_import_markdown", serde_json::json!({ "markdown": md })).await.unwrap();
    let got: serde_json::Value = invoke(&app, "notebook_get_runnable", serde_json::json!({ "id": id })).await.unwrap();
    assert_eq!(got["frontmatter"]["title"], "BGP Peer Bringup");
    let cells = got["cells"].as_array().unwrap();
    assert!(cells.iter().any(|c| c["type"] == "assertion"));
    let exported: String = invoke(&app, "notebook_export_markdown", serde_json::json!({ "id": id })).await.unwrap();
    assert_eq!(exported, md); // body_markdown is byte-stable
}
```

- [ ] **Step 2: Implement commands**

```rust
// src-tauri/src/commands/notebooks_runnable.rs
use serde::{Deserialize, Serialize};
use tauri::State;
use crate::notebooks::{parser, model::*};
use super::AppState;

#[derive(Serialize)]
pub struct RunnableNotebookDto {
    pub id: String,
    pub frontmatter: Frontmatter,
    pub cells: Vec<NotebookCell>,
    pub body_markdown: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[tauri::command]
pub async fn notebook_import_markdown(
    state: State<'_, AppState>,
    markdown: String,
) -> Result<String, String> {
    let nb = parser::parse_markdown(&markdown).map_err(|e| e.to_string())?;
    let id = format!("nb-{}", uuid::Uuid::new_v4());
    let now = now_unix();
    let conn = state.db.lock();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO notebooks (id, title, description, vendor, platform, frontmatter_json, body_markdown, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        rusqlite::params![
            id, nb.frontmatter.title, nb.frontmatter.description,
            nb.frontmatter.vendor, nb.frontmatter.platform,
            serde_json::to_string(&nb.frontmatter).map_err(|e| e.to_string())?,
            nb.body_markdown, now,
        ],
    ).map_err(|e| e.to_string())?;
    for (idx, cell) in nb.cells.iter().enumerate() {
        let (cell_type, content, meta) = encode_cell(cell);
        tx.execute(
            "INSERT INTO notebook_cells (notebook_id, idx, cell_type, content, metadata_json) VALUES (?1,?2,?3,?4,?5)",
            rusqlite::params![id, idx as i64, cell_type, content, meta],
        ).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub async fn notebook_list_runnable(state: State<'_, AppState>) -> Result<Vec<RunnableNotebookSummaryDto>, String> { /* ... */ }

#[tauri::command]
pub async fn notebook_get_runnable(state: State<'_, AppState>, id: String) -> Result<RunnableNotebookDto, String> { /* ... */ }

#[tauri::command]
pub async fn notebook_delete_runnable(state: State<'_, AppState>, id: String) -> Result<(), String> { /* ... */ }

#[tauri::command]
pub async fn notebook_export_markdown(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let conn = state.db.lock();
    let md: String = conn.query_row(
        "SELECT body_markdown FROM notebooks WHERE id = ?1",
        rusqlite::params![id],
        |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    Ok(md)
}

fn encode_cell(c: &NotebookCell) -> (&'static str, String, String) {
    match c {
        NotebookCell::Markdown { content } => ("markdown", content.clone(), "{}".into()),
        NotebookCell::Command { content, metadata } => ("command", content.clone(), serde_json::to_string(metadata).unwrap_or("{}".into())),
        NotebookCell::Approval { content } => ("approval", content.clone(), "{}".into()),
        NotebookCell::Assertion { spec } => ("assertion", String::new(), serde_json::to_string(spec).unwrap_or("{}".into())),
        NotebookCell::Parameter { params } => ("parameter", String::new(), serde_json::to_string(&serde_json::json!({ "params": params })).unwrap_or("{}".into())),
    }
}

fn now_unix() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

#[derive(Serialize)]
pub struct RunnableNotebookSummaryDto { /* id, title, description, vendor, platform, cell_count, updated_at */ }
```

Implement the `list` / `get` / `delete` bodies following the same style as `src-tauri/src/commands/notebooks.rs` (read it for parameter naming conventions — `limit`, `notebook_id`, etc.).

- [ ] **Step 3: Register** in `src-tauri/src/lib.rs` generate_handler: `commands::notebooks_runnable::notebook_import_markdown`, `_list_runnable`, `_get_runnable`, `_delete_runnable`, `_export_markdown`.

- [ ] **Step 4: Run — expect PASS**

```bash
cargo test --manifest-path src-tauri/Cargo.toml notebooks_runnable_crud
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/
git commit -m "feat(notebooks): CRUD Tauri commands for runnable notebooks"
```

### Task 1.4 — TS types + frontend import/export helpers  `PARALLEL with 1.3`

**Files:**
- Create: `src/lib/runnableNotebook.ts`
- Create: `src/lib/runnableNotebook.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/lib/runnableNotebook.test.ts
import { describe, it, expect, vi } from "vitest";
import { importRunnableNotebookMarkdown, exportRunnableNotebookMarkdown } from "./runnableNotebook";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

describe("runnableNotebook", () => {
  it("round-trips a sample MOP", async () => {
    mocks.invoke.mockImplementationOnce(async () => "nb-123");
    mocks.invoke.mockImplementationOnce(async () => "---\ntitle: t\n---\n");
    const id = await importRunnableNotebookMarkdown("---\ntitle: t\n---\n");
    expect(id).toBe("nb-123");
    const md = await exportRunnableNotebookMarkdown(id);
    expect(md).toContain("title: t");
  });
});
```

- [ ] **Step 2: Implement `src/lib/runnableNotebook.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";

export type AssertionOp = "equals" | "not_equals" | "contains" | "greater_than" | "less_than" | "exists";

export type NotebookCell =
  | { type: "markdown"; content: string }
  | { type: "command"; content: string; metadata?: { timeout_s?: number; expect_exit?: number } }
  | { type: "approval"; content: string }
  | { type: "assertion"; spec: { command: string; jsonpath: string; op: AssertionOp; expected: unknown } }
  | { type: "parameter"; params: Array<{ name: string; prompt: string; default?: string }> };

export interface RunnableNotebookDto {
  id: string;
  frontmatter: {
    title: string;
    description?: string;
    vendor?: string;
    platform?: string;
    parameters?: Array<{ name: string; prompt: string; default?: string }>;
  };
  cells: NotebookCell[];
  body_markdown: string;
  created_at: number;
  updated_at: number;
}

export async function importRunnableNotebookMarkdown(markdown: string): Promise<string> {
  return invoke<string>("notebook_import_markdown", { markdown });
}
export async function exportRunnableNotebookMarkdown(id: string): Promise<string> {
  return invoke<string>("notebook_export_markdown", { id });
}
export async function listRunnableNotebooks() { return invoke<RunnableNotebookDto[]>("notebook_list_runnable"); }
export async function getRunnableNotebook(id: string) { return invoke<RunnableNotebookDto>("notebook_get_runnable", { id }); }
export async function deleteRunnableNotebook(id: string) { return invoke<void>("notebook_delete_runnable", { id }); }
```

- [ ] **Step 3: Run — expect PASS** (`bun run test src/lib/runnableNotebook.test.ts`)
- [ ] **Step 4: Commit**

```bash
git add src/lib/runnableNotebook.ts src/lib/runnableNotebook.test.ts
git commit -m "feat(notebooks): frontend types + invoke wrappers for runnable notebooks"
```

### Task 1.5 — Phase 1 regression  `SEQUENTIAL`

- [ ] **Step 1:** `bun run test` — all green.
- [ ] **Step 2:** `cargo test --manifest-path src-tauri/Cargo.toml` — all green.
- [ ] **Step 3:** `bunx playwright test --grep @smoke` — all green.
- [ ] **Step 4: Code review** — dispatch `feature-dev:code-reviewer` subagent over Phase 1 diff. Prompt: "Review Phase 1 of Plan 03 (`/Plans/03-notebooks-runnable-mops.md`). Focus: parser correctness for edge cases (nested fences, CRLF line endings, empty frontmatter), round-trip fidelity, migration FK integrity, command registration. Report must-fix vs. nits."
- [ ] **Step 5: Update plan file** — check all Phase 1 boxes and append at the bottom:

```markdown
## Phase 1 — COMPLETED YYYY-MM-DD
V0030 migration + Rust parser + CRUD commands + TS wrappers. Round-trip of bgp_peer_bringup.mop.md verified byte-stable.
```

- [ ] **Step 6: Commit**

```bash
git add Plans/03-notebooks-runnable-mops.md
git commit -m "docs(plans): mark Plan 03 Phase 1 complete"
```

---

## Phase 2 — Runtime engine (Rust)

Executes cells sequentially against a tab's PTY, gates on approvals, evaluates assertions via Plan 00 `parse_show`, records full audit trail, supports pause/resume/cancel/resume-from-failure.

### Task 2.1 — Runner state machine + control channel  `SEQUENTIAL`

**Files:**
- Create: `src-tauri/src/notebooks/runner.rs`
- Create: `src-tauri/src/notebooks/substitution.rs`
- Create: `src-tauri/src/notebooks/runner_tests.rs`

- [ ] **Step 1: Define the public surface**

```rust
// src-tauri/src/notebooks/runner.rs
use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};

use super::model::*;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus { Running, Paused, Completed, Failed, Cancelled }

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CellStatus { Pending, Running, Passed, Failed, Skipped, AwaitingApproval }

#[derive(Debug)]
pub enum ControlMsg { Approve, Cancel, Pause, Resume }

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RunEvent {
    CellStarted { cell_idx: usize },
    CellFinished { cell_idx: usize, status: CellStatus, block_id: Option<String>, error: Option<String> },
    AwaitingApproval { cell_idx: usize, prompt: String },
    RunFinished { status: RunStatus },
}

pub struct NotebookRunner {
    pub run_id: String,
    pub notebook_id: String,
    pub tab_id: String,
    pub notebook: Notebook,
    pub params: serde_json::Map<String, serde_json::Value>,
    pub start_at_idx: usize, // 0 for fresh run, >0 for resume-from-failure
    pub ctrl_rx: mpsc::Receiver<ControlMsg>,
    pub event_tx: mpsc::Sender<RunEvent>,
}

impl NotebookRunner {
    pub async fn run(mut self, ctx: RunnerContext) -> Result<RunStatus> {
        // Iterates self.notebook.cells from self.start_at_idx,
        // calls the appropriate executor per cell type,
        // updates notebook_cell_runs, emits RunEvents,
        // returns final RunStatus.
        todo!("implement in subsequent steps")
    }
}

pub struct RunnerContext {
    pub db: std::sync::Arc<parking_lot::Mutex<rusqlite::Connection>>,
    pub pty: std::sync::Arc<dyn PtyExecutor + Send + Sync>,       // injectable for tests
    pub parser: std::sync::Arc<dyn AssertionEvaluator + Send + Sync>, // injectable
}

#[async_trait::async_trait]
pub trait PtyExecutor {
    /// Write `command` to the tab's PTY, tagging subsequent output with `block_id`.
    /// Returns when the shell emits CommandComplete, producing the full captured output
    /// and exit code.
    async fn run_command(&self, tab_id: &str, command: &str, block_id: &str) -> Result<PtyRunResult>;
}

#[derive(Debug, Clone)]
pub struct PtyRunResult { pub output: String, pub exit_code: Option<i32>, pub duration_ms: u64 }

#[async_trait::async_trait]
pub trait AssertionEvaluator {
    /// Evaluate an assertion: run its `command` (via PtyExecutor), parse via parse_show, apply JSONPath,
    /// return Ok(Passed | Failed { actual }) or Err on infrastructure failure.
    async fn evaluate(&self, tab_id: &str, spec: &AssertionSpec, params: &serde_json::Map<String, serde_json::Value>) -> Result<AssertionOutcome>;
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum AssertionOutcome {
    Passed { actual: serde_json::Value },
    Failed { actual: serde_json::Value, expected: serde_json::Value, reason: String },
}
```

- [ ] **Step 2: Substitution helper**

```rust
// src-tauri/src/notebooks/substitution.rs
use regex::Regex;
use std::sync::OnceLock;

static VAR_RE: OnceLock<Regex> = OnceLock::new();
fn var_re() -> &'static Regex { VAR_RE.get_or_init(|| Regex::new(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}").unwrap()) }

pub fn substitute(input: &str, params: &serde_json::Map<String, serde_json::Value>) -> String {
    var_re().replace_all(input, |caps: &regex::Captures| {
        let name = &caps[1];
        match params.get(name) {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(v) => v.to_string(),
            None => caps.get(0).unwrap().as_str().to_string(), // leave unresolved as-is
        }
    }).into_string()
}
```

- [ ] **Step 3: Write failing unit tests for substitution** (table-driven: `{{foo}}`, `{{ foo }}`, unknown var, integer value, empty input).
- [ ] **Step 4: Make them pass.**
- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/notebooks/
git commit -m "feat(notebooks): runner state machine scaffold + param substitution"
```

### Task 2.2 — PTY executor implementation  `SEQUENTIAL` (depends on 2.1)

**Files:**
- Modify: `src-tauri/src/notebooks/runner.rs` — add `TabPtyExecutor` concrete type
- Modify: `src-tauri/src/pty.rs` — **ONLY IF NEEDED** — inspect first; `PtyEvent::CommandStart { cmd, block_id: Option<String> }` and `PtyEvent::CommandComplete` already exist. We need a way for the runner to (a) write a command with a known `block_id`, (b) `.await` its `CommandComplete`. If no helper like `run_command_sync(block_id, cmd) -> Result<PtyRunResult>` exists, add ONE to `PtyHandle` — do NOT invent new emit channels.

- [ ] **Step 1: Read `src-tauri/src/pty.rs` end-to-end and map the event flow** from `PtyEvent::CommandStart` through `CommandComplete`. Document the finding in a top-of-file comment before implementing.

- [ ] **Step 2: Add `PtyHandle::run_and_await`** (sync-style helper that writes a command with a pre-assigned block_id and returns when that block's `CommandComplete` is observed). Keep the existing async streaming API untouched; this is a convenience wrapper used by the notebook runner.

```rust
// Sketch — adapt to the actual event plumbing in pty.rs
impl PtyHandle {
    pub async fn run_and_await(&self, block_id: &str, command: &str, timeout: std::time::Duration) -> Result<PtyRunResult> {
        // 1. subscribe to a one-shot receiver keyed by block_id
        // 2. pty_write(command + "\n") with block_id tagged
        // 3. tokio::time::timeout(timeout, rx).await
        todo!()
    }
}
```

If the existing event-bus design does NOT support per-block_id subscribers, add a `HashMap<block_id, oneshot::Sender<PtyRunResult>>` in the `PtyHandle` inner state and fire-and-remove on CommandComplete. Ship this change in a **separate commit** so it can be reviewed independently of the notebook runner.

- [ ] **Step 3: Implement `TabPtyExecutor`** that wraps `Arc<PtyHandleRegistry>` (look for the existing registry mapping `tab_id -> PtyHandle`; it's held in `AppState` — read `commands/mod.rs` for exact field name before coding).

```rust
pub struct TabPtyExecutor { pub registry: std::sync::Arc<PtyHandleRegistry> }

#[async_trait::async_trait]
impl PtyExecutor for TabPtyExecutor {
    async fn run_command(&self, tab_id: &str, command: &str, block_id: &str) -> Result<PtyRunResult> {
        let handle = self.registry.get(tab_id).ok_or_else(|| anyhow::anyhow!("no PTY for tab {tab_id}"))?;
        handle.run_and_await(block_id, command, std::time::Duration::from_secs(120)).await
    }
}
```

- [ ] **Step 4: Write an integration test** that spawns a real PTY, runs `echo hello`, and asserts the returned output contains "hello". Gate behind `#[cfg(unix)]` if Windows CI lacks a PTY.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/notebooks/runner.rs src-tauri/src/pty.rs
git commit -m "feat(notebooks): pty executor + run_and_await helper"
```

### Task 2.3 — Assertion evaluator (parse_show + JSONPath)  `SEQUENTIAL` (depends on 2.2; depends on Plan 00 Phase 2)

**Files:**
- Modify: `src-tauri/src/notebooks/runner.rs` — add `DefaultAssertionEvaluator`
- Modify: `src-tauri/Cargo.toml` — add `jsonpath_lib = "0.3"` (verify via context7 that it is still maintained in 2026; if not, pick one of `jsonpath-rust` or `serde_json_path`. **Do NOT guess — confirm first.**)

- [ ] **Step 1: Verify JSONPath crate choice** via `mcp__plugin_context7_context7__query-docs` querying each candidate crate name. Pick the one with the most recent release + compatible license (MIT/Apache). Pin the chosen version.

- [ ] **Step 2: Write failing assertion tests** (table-driven):
  - Equals-happy: parse returns `{"version": "17.09.04"}`, jsonpath `$.version`, op Equals, expected `"17.09.04"` → Passed.
  - Equals-fail: same but expected `"16.x"` → Failed with actual.
  - Contains on array: parse returns `{"neighbors": ["10.0.0.1","10.0.0.2"]}`, jsonpath `$.neighbors`, op Contains, expected `"10.0.0.1"` → Passed.
  - Exists on absent path: Failed.
  - parse_show returns NoParserError: evaluator returns `Err(...)` (not Failed — infrastructure issue).

- [ ] **Step 3: Implement**

```rust
pub struct DefaultAssertionEvaluator {
    pub pty: std::sync::Arc<dyn PtyExecutor + Send + Sync>,
    pub db: std::sync::Arc<parking_lot::Mutex<rusqlite::Connection>>,
    pub parse_fn: std::sync::Arc<dyn Fn(&str, &str, &str, &str) -> anyhow::Result<serde_json::Value> + Send + Sync>,
    pub vendor: String,
    pub platform: String,
}

#[async_trait::async_trait]
impl AssertionEvaluator for DefaultAssertionEvaluator {
    async fn evaluate(&self, tab_id: &str, spec: &AssertionSpec, params: &serde_json::Map<String, serde_json::Value>) -> anyhow::Result<AssertionOutcome> {
        use crate::notebooks::substitution::substitute;
        let cmd = substitute(&spec.command, params);
        let jp  = substitute(&spec.jsonpath, params);
        let expected = spec.expected.clone();

        let block_id = format!("assert-{}", uuid::Uuid::new_v4());
        let result = self.pty.run_command(tab_id, &cmd, &block_id).await?;
        let parsed = (self.parse_fn)(&self.vendor, &self.platform, &cmd, &result.output)?;

        let mut selector = jsonpath_lib::selector(&parsed);
        let matches = selector(&jp).map_err(|e| anyhow::anyhow!("JSONPath error: {e}"))?;
        let actual: serde_json::Value = match matches.as_slice() {
            [] => serde_json::Value::Null,
            [single] => (*single).clone(),
            many => serde_json::Value::Array(many.iter().map(|v| (*v).clone()).collect()),
        };

        let passed = match spec.op {
            AssertionOp::Equals      => actual == expected,
            AssertionOp::NotEquals   => actual != expected,
            AssertionOp::Contains    => contains(&actual, &expected),
            AssertionOp::GreaterThan => num_cmp(&actual, &expected, |a, b| a > b),
            AssertionOp::LessThan    => num_cmp(&actual, &expected, |a, b| a < b),
            AssertionOp::Exists      => !actual.is_null(),
        };

        Ok(if passed {
            AssertionOutcome::Passed { actual }
        } else {
            AssertionOutcome::Failed { actual, expected, reason: format!("{:?} assertion not satisfied", spec.op) }
        })
    }
}

fn contains(actual: &serde_json::Value, expected: &serde_json::Value) -> bool { /* array/string containment */ unimplemented!() }
fn num_cmp(a: &serde_json::Value, b: &serde_json::Value, cmp: impl Fn(f64, f64) -> bool) -> bool { /* coerce to f64 */ unimplemented!() }
```

- [ ] **Step 4: Wire `parse_fn`** to invoke the Plan 00 `parsers::bridge::ParserBridge::parse` directly (in-process) — **not** via a Tauri invoke round-trip. Keep the abstraction pluggable so tests can inject a mock parser.

- [ ] **Step 5: Run — expect PASS** (`cargo test --manifest-path src-tauri/Cargo.toml notebooks::runner`)

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/notebooks/ src-tauri/Cargo.toml
git commit -m "feat(notebooks): assertion evaluator via parse_show + JSONPath"
```

### Task 2.4 — Runner main loop: sequential execution + approvals + resume  `SEQUENTIAL` (depends on 2.3)

**Files:**
- Modify: `src-tauri/src/notebooks/runner.rs` — flesh out `NotebookRunner::run`
- Create: `src-tauri/src/notebooks/runner_tests.rs` — full-flow tests with mock executor

- [ ] **Step 1: Write failing integration test with mock executor**

```rust
#[tokio::test]
async fn runs_full_notebook_happy_path() {
    let nb = parse_markdown(FIXTURE).unwrap();
    let ctx = test_ctx_with_mock_pty_and_parser();
    let (ctrl_tx, ctrl_rx) = mpsc::channel(8);
    let (ev_tx, mut ev_rx) = mpsc::channel(64);
    let runner = NotebookRunner {
        run_id: "run-1".into(), notebook_id: "nb-1".into(), tab_id: "tab-1".into(),
        notebook: nb, params: sample_params(), start_at_idx: 0, ctrl_rx, event_tx: ev_tx,
    };
    let run_handle = tokio::spawn(runner.run(ctx));
    // Consume events, approve when AwaitingApproval is seen.
    while let Some(ev) = ev_rx.recv().await {
        if let RunEvent::AwaitingApproval { .. } = ev { ctrl_tx.send(ControlMsg::Approve).await.unwrap(); }
        if matches!(ev, RunEvent::RunFinished { .. }) { break; }
    }
    assert_eq!(run_handle.await.unwrap().unwrap(), RunStatus::Completed);
}

#[tokio::test]
async fn failed_assertion_pauses_run_and_can_resume_from_failure() { /* ... */ }

#[tokio::test]
async fn cancel_mid_run_sets_cancelled_status() { /* ... */ }
```

- [ ] **Step 2: Implement the loop** — pseudocode:

```
for (idx, cell) in cells[start_at_idx..]:
    persist notebook_cell_runs row status=running
    emit CellStarted
    match cell:
        Markdown        -> persist status=skipped (no-op), emit CellFinished(Passed with note)
        Parameter       -> validate all required params present; if missing: fail run
        Command         -> pty.run_command; persist block; status=passed/failed by exit_code policy
        Assertion       -> evaluator.evaluate; status=passed/failed
        Approval        -> set status=awaiting_approval, update run.status=paused,
                           emit AwaitingApproval, select! on ctrl_rx:
                               Approve -> status=passed, continue
                               Cancel  -> status=skipped, break with Cancelled
    if failed: update run.status=failed, break
    if control received Pause: update run.status=paused, persist, break
final: emit RunFinished(status), update run.ended_at
```

- [ ] **Step 3: Resume-from-failure** — the `start_at_idx` parameter is the mechanism. A separate `notebook_run_resume(run_id)` command (Task 2.5) reads the last-failed cell_idx, constructs a fresh runner with `start_at_idx = failed_idx`, and re-runs. The existing run row is **mutated** (status back to `running`) — we do NOT create a new run_id. Document this choice in the runner module header.

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/notebooks/
git commit -m "feat(notebooks): runner main loop with approvals, failures, resume"
```

### Task 2.5 — Tauri commands for run control  `SEQUENTIAL` (depends on 2.4)

**Files:**
- Modify: `src-tauri/src/commands/notebooks_runnable.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add a run registry to AppState**

```rust
// In AppState (commands/mod.rs) — add:
//   pub notebook_runs: Arc<Mutex<HashMap<String, tokio::sync::mpsc::Sender<ControlMsg>>>>,
```

- [ ] **Step 2: Commands**

```rust
#[tauri::command] pub async fn notebook_run_start(state: State<'_, AppState>, notebook_id: String, tab_id: String, params: serde_json::Value, on_event: tauri::ipc::Channel<RunEvent>) -> Result<String, String>;
#[tauri::command] pub async fn notebook_run_approve(state: State<'_, AppState>, run_id: String) -> Result<(), String>;
#[tauri::command] pub async fn notebook_run_cancel(state: State<'_, AppState>, run_id: String) -> Result<(), String>;
#[tauri::command] pub async fn notebook_run_pause(state: State<'_, AppState>, run_id: String) -> Result<(), String>;
#[tauri::command] pub async fn notebook_run_resume(state: State<'_, AppState>, run_id: String) -> Result<(), String>; // resumes paused or failed runs; computes start_at_idx internally
#[tauri::command] pub async fn notebook_run_status(state: State<'_, AppState>, run_id: String) -> Result<RunStatusDto, String>;
```

`RunStatusDto` includes: run status, per-cell statuses (list), current cell_idx, params_json.

- [ ] **Step 3: Register in `lib.rs` invoke_handler.**

- [ ] **Step 4: Write end-to-end Rust test** that starts a run, approves when prompted, confirms status=completed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/
git commit -m "feat(notebooks): Tauri commands for run start/approve/cancel/pause/resume"
```

### Task 2.6 — Phase 2 regression  `SEQUENTIAL`

- [ ] **Step 1:** Full test suite: `bun run test`, `cargo test --manifest-path src-tauri/Cargo.toml`, `bunx playwright test --grep @smoke`.
- [ ] **Step 2: Code review subagent** — prompt emphasising: race conditions in control channel, DB transaction scoping across async awaits (rusqlite isn't Send — confirm `parking_lot::Mutex` is held only inside sync blocks), pty event bus back-pressure, assertion evaluator error-vs-failure distinction.
- [ ] **Step 3: Update plan file** — check Phase 2 boxes + append completion block.
- [ ] **Step 4: Commit.**

---

## Phase 3 — UI: NotebookPanel + per-cell controls (pre-impl + post-impl design review)

### Task 3.1 — Pre-impl design brief  `SEQUENTIAL`

- [ ] **Step 1: Dispatch `frontend-design` skill** with brief:

  > "Design a right-side `NotebookPanel` that lives next to the tab's block list. Requirements:
  > - Ordered cell list, each row type-distinguished: markdown (rendered), command (monospace + status chip), approval (amber card with Continue button), assertion (pass/fail chip + jsonpath expr + actual value diff), parameter (collapsed summary chip at top).
  > - Toolbar: Run | Run from here | Stop | Resume from failure | ▾ more (export / duplicate / open raw .md).
  > - Per-cell status chips: pending (grey), running (pulsing blue), passed (green check), failed (red X), skipped (faded), awaiting-approval (amber).
  > - Footer shows current run summary: `3/7 passed · 1 failed · paused at step 4`.
  > - macOS-native feel; existing palette in `src/App.css`; existing primitives: `CommandBlock.css`, `BlockActions.tsx`. Do NOT introduce a new component library.
  > Deliver: ASCII wireframe + component tree + the Tailwind/CSS class names for each region."

- [ ] **Step 2:** Save the returned spec to `docs/design/notebook-panel.md` and commit.

### Task 3.2 — Install any new deps + verify react-markdown  `PARALLEL with 3.3`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Check**

```bash
grep '"react-markdown"' package.json || echo "NEEDED"
```

If needed: `bun add react-markdown remark-gfm`. Otherwise skip.

- [ ] **Step 2: Commit** `chore: add react-markdown for notebook markdown cell rendering` (if needed).

### Task 3.3 — `NotebookPanel` + cell-row components  `PARALLEL with 3.2`

**Files:**
- Create: `src/components/notebooks/NotebookPanel.tsx` + `.css`
- Create: `src/components/notebooks/cells/MarkdownCell.tsx`
- Create: `src/components/notebooks/cells/CommandCell.tsx`
- Create: `src/components/notebooks/cells/ApprovalCell.tsx`
- Create: `src/components/notebooks/cells/AssertionCell.tsx`
- Create: `src/components/notebooks/cells/ParameterCell.tsx`
- Create: `src/components/notebooks/CellStatusChip.tsx`
- Create: `src/components/notebooks/NotebookToolbar.tsx`
- Create: `src/state/notebookRunsStore.ts`
- Tests: `.test.tsx` sibling for each component

- [ ] **Step 1: Zustand store**

```ts
// src/state/notebookRunsStore.ts
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { Channel } from "@tauri-apps/api/core";

export type CellStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "awaiting_approval";
export type RunStatus = "running" | "paused" | "completed" | "failed" | "cancelled";

interface RunState {
  runId: string;
  notebookId: string;
  status: RunStatus;
  cellStatuses: Record<number, CellStatus>;
  cellErrors: Record<number, string | undefined>;
  currentCellIdx: number | null;
}

interface NotebookRunsStore {
  runs: Record<string, RunState>;
  start: (notebookId: string, tabId: string, params: Record<string, unknown>) => Promise<string>;
  approve: (runId: string) => Promise<void>;
  cancel: (runId: string) => Promise<void>;
  pause: (runId: string) => Promise<void>;
  resume: (runId: string) => Promise<void>;
}

export const useNotebookRuns = create<NotebookRunsStore>((set, get) => ({
  runs: {},
  async start(notebookId, tabId, params) {
    const channel = new Channel<any>();
    channel.onmessage = (ev) => {
      // update cellStatuses / status from RunEvent payloads
    };
    const runId = await invoke<string>("notebook_run_start", { notebookId, tabId, params, onEvent: channel });
    // seed run state
    return runId;
  },
  approve: (runId) => invoke("notebook_run_approve", { runId }),
  cancel:  (runId) => invoke("notebook_run_cancel",  { runId }),
  pause:   (runId) => invoke("notebook_run_pause",   { runId }),
  resume:  (runId) => invoke("notebook_run_resume",  { runId }),
}));
```

- [ ] **Step 2: Write failing tests** for each cell component (render given props; click Continue on ApprovalCell triggers callback; AssertionCell shows diff when failed).

- [ ] **Step 3: Implement components** following the design spec from 3.1. Every cell row renders the status chip + type-specific body. `AssertionCell` pretty-prints the JSONPath + actual using `jsonpath-plus` on the already-parsed data (client-side display only; the authoritative evaluation happened in Rust).

- [ ] **Step 4: Implement `NotebookToolbar`** with Run / Run-from-here / Stop / Resume buttons wired to the Zustand store. "Run from here" takes a `startAtIdx`, calls a new `notebook_run_start_at` command (add to Rust if not yet present — reuses `start_at_idx`).

- [ ] **Step 5: Implement `NotebookPanel`** — composes toolbar, cell list, footer summary. Must handle the parameter cell specially: if the notebook has a Parameter cell and the user clicks Run before filling it in, show a modal form (reuse `src/components/ParameterForm.tsx`).

- [ ] **Step 6: Commit each component separately** — one commit per file group.

### Task 3.4 — Wire NotebookPanel into the app shell  `SEQUENTIAL` (depends on 3.3)

**Files:**
- Modify: `src/App.tsx` (or wherever the block list mounts) — add a right-side collapsible panel toggleable via ⌘⇧N

- [ ] **Step 1: Read the current layout component** to understand how PaneContainer arranges children.
- [ ] **Step 2: Add NotebookPanel as an optional sibling.**
- [ ] **Step 3: Hotkey binding** (reuse `react-hotkeys-hook` from Plan 01 if it's in place; otherwise use existing hotkey scaffolding).
- [ ] **Step 4: Commit.**

### Task 3.5 — Playwright E2E: run a seeded notebook happy path  `PARALLEL with 3.6`

**Files:**
- Create: `e2e/notebook-run.spec.ts`
- Create: `e2e/fixtures/trivial.mop.md` (one command cell: `echo hello`, one assertion cell asserting output contains "hello")

- [ ] **Step 1: Test steps**
  1. Launch app, open a tab with a local bash PTY.
  2. Open NotebookLibrary, import trivial.mop.md, open it.
  3. Click Run. Assert cell 1 reaches "passed" within 5s, cell 2 also "passed" within 5s, footer shows "2/2 passed".

- [ ] **Step 2: Gate assertion-cell parser dependency** — for a bash PTY the Plan 00 parser returns `NoParserError`. Add a test-mode shortcut in the assertion evaluator: if `vendor == "generic"` and parser errors, fall back to treating the raw output as `{"stdout": "<output>"}` so assertions can still run (`$.stdout`). Mark this with a `// TODO(plan 05)` once the real parser vendor matrix is in.

- [ ] **Step 3: Tag** `@smoke` on the happy-path test.
- [ ] **Step 4: Commit.**

### Task 3.6 — Post-impl design review  `PARALLEL with 3.5`

- [ ] **Step 1: Launch** `bun run tauri dev`, seed one notebook, take screenshots of: empty state, mid-run with one cell running, paused at approval, one failure + resume menu.
- [ ] **Step 2: Dispatch `frontend-design` skill** with screenshots + the 3.1 spec. Apply must-fix feedback; file nits as follow-up issues.
- [ ] **Step 3: Commit any polish fixes.**

### Task 3.7 — Phase 3 regression  `SEQUENTIAL`

- [ ] Full test suite (bun + cargo + playwright).
- [ ] `feature-dev:code-reviewer` subagent.
- [ ] Update plan file (check Phase 3 boxes + completion block).
- [ ] Commit plan.

---

## Phase 4 — Library: list, import (file/URL), export, share, retire legacy modal

### Task 4.1 — `NotebookLibrary` modal  `SEQUENTIAL`

**Files:**
- Create: `src/components/notebooks/NotebookLibrary.tsx` + `.css`
- Create: `src/components/notebooks/NotebookLibrary.test.tsx`
- Modify: caller currently opening `BlockNotebook` modal — route to `NotebookLibrary` for runnable notebooks; leave a smaller "Block Snapshot" affordance for the legacy modal behind a menu item.

- [ ] **Step 1: Dispatch `frontend-design`** for the library modal spec (list view with vendor/platform filter chips, "Import from file", "Import from URL", per-row Open/Run/Delete/Export actions). Save to `docs/design/notebook-library.md`.

- [ ] **Step 2: Write failing test** — render with 3 mocked notebooks → rows visible; click Import from file → file picker opens; filter by `vendor=cisco` hides non-cisco rows.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Commit.**

### Task 4.2 — Import from URL  `PARALLEL with 4.3`

**Files:**
- Modify: `src-tauri/src/commands/notebooks_runnable.rs` — add `notebook_import_url(url: String)`

- [ ] **Step 1: Implement** using `reqwest` (already a dep? verify `Cargo.toml`; if not add it). Fetch the URL, enforce max body 2 MiB, pass into `notebook_import_markdown` internally.
- [ ] **Step 2: Test** with a local mock HTTP server (`wiremock` crate).
- [ ] **Step 3: Commit.**

### Task 4.3 — Export + share  `PARALLEL with 4.2`

**Files:**
- Modify: `src/lib/runnableNotebook.ts` — add `downloadRunnableNotebook(id: string)` that fetches markdown and triggers a file download (pattern from `src/lib/notebook.ts::downloadNotebook`).
- Modify: `src/components/notebooks/NotebookLibrary.tsx` — wire Export button.

- [ ] **Step 1: Implement + test.**
- [ ] **Step 2: Share via the Plan 01 share infrastructure** — once V0028 `block_shares` is live, add a `notebook_shares` sibling (reuse Plan 01 patterns; add a migration column IF NEEDED but prefer keeping share infra general — coordinate with Plan 01 in a code-review round before writing a new migration).
- [ ] **Step 3: Commit.**

### Task 4.4 — Retire legacy `BlockNotebook` modal  `SEQUENTIAL`

**Files:**
- Modify: `src/components/BlockNotebook.tsx` — keep the file; add a top-of-file deprecation banner comment pointing at `NotebookLibrary`. Export `LegacyBlockSnapshotModal = BlockNotebook` for a single release.
- Modify: any caller now routing to `NotebookLibrary`.

- [ ] **Step 1: Confirm every entrypoint to the old modal is accounted for** (`grep -rn "BlockNotebook" src/ --include="*.tsx"`).
- [ ] **Step 2: Commit.**

### Task 4.5 — Phase 4 regression  `SEQUENTIAL`

- [ ] Full test suite. Code review. UI review. Update plan. Commit.

---

## Phase 5 — Seed 10 canonical MOPs + polish + docs

### Task 5.1 — Seed notebooks  `PARALLEL` (10 files can be authored in parallel)

**Files (all under `notebooks/seeds/`):**
- `bgp_peer_bringup.mop.md` (already authored as Phase 1 fixture — promote it)
- `ospf_neighbor_add.mop.md`
- `isis_neighbor_add.mop.md`
- `interface_mtu_change_validation.mop.md`
- `vlan_trunk_add.mop.md`
- `hsrp_failover_test.mop.md`
- `bfd_single_hop_enable.mop.md`
- `acl_apply_with_rollback.mop.md`
- `ntp_server_change.mop.md`
- `snmpv3_user_add.mop.md`

Each MUST include:
- YAML frontmatter (title, description, vendor=cisco, platform, parameters)
- At least one approval cell
- At least one assertion cell using a JSONPath against a Genie-parsed command

- [ ] **Step 1: For each MOP**, confirm the `show` command + Genie parser path actually exists. Use `mcp__plugin_context7_context7__query-docs` against `genieparser` OR run `cd sidecar && python -c "from genie.libs.parser.utils import get_parser; ..."` to list known parsers. DO NOT author an assertion against a non-existent parser path.
- [ ] **Step 2: Author the 10 files.** Keep them short (≤ 40 lines each) — they're examples, not production runbooks.
- [ ] **Step 3: Add a Rust integration test** that imports all 10 files and asserts `parse_markdown` succeeds on each.
- [ ] **Step 4: Seed loader** — create `src-tauri/src/notebooks/seeds.rs` with a function that on first app boot (detect via a flag row in `notebooks` — e.g. `id='seed-marker'`) imports each seed and marks as loaded. Do NOT re-import on subsequent boots.
- [ ] **Step 5: Commit each batch** (physical files + loader separately).

### Task 5.2 — User docs  `PARALLEL with 5.3`

**Files:**
- Create: `docs/NOTEBOOKS.md`

Sections: "What is a runnable notebook", "Cell types reference", "Writing an assertion", "Parameters and substitution", "Resume-from-failure semantics", "Seed MOPs index", "Authoring workflow (edit `.mop.md` externally + Import from file)".

- [ ] **Step 1: Write.** Include one worked example end-to-end.
- [ ] **Step 2: Commit.**

### Task 5.3 — Polish pass  `PARALLEL with 5.2`

- [ ] **Step 1: Empty states** — NotebookPanel with no notebook open should show the seed gallery inline.
- [ ] **Step 2: Error surfaces** — assertion eval returning `Err` (infrastructure) must render differently from `Failed` (predicate); both have copy-to-clipboard for the actual value.
- [ ] **Step 3: Keyboard** — ⌘⏎ to Run, ⌘. to Stop, ⌘⇧⏎ to Resume-from-failure.
- [ ] **Step 4: Accessibility** — every status chip has an `aria-label`; approval card is focusable.
- [ ] **Step 5: Commit each polish area separately.**

### Task 5.4 — Phase 5 regression & close out  `SEQUENTIAL`

- [ ] Full test suite.
- [ ] `feature-dev:code-reviewer` over the full Plan 03 diff (not just Phase 5).
- [ ] Post-impl UI review via `frontend-design` with final screenshots.
- [ ] Update `/Plans/README.md` status row for Plan 03 to ✅ Complete.
- [ ] Update this plan file: check all remaining boxes, append final completion block.
- [ ] Commit.

---

## Self-review checklist (before marking plan complete)

- [ ] Migration number V0030 matches `/Plans/README.md` reservation (lines 69-72 of the README).
- [ ] Every step has concrete code or commands — no `// TODO` placeholders in final committed code (the one intentional `TODO(plan 05)` in the assertion fallback is documented).
- [ ] Type names consistent: `Notebook`, `NotebookCell`, `AssertionSpec`, `AssertionOp`, `RunStatus`, `CellStatus`, `RunEvent`, `ControlMsg`, `PtyExecutor`, `AssertionEvaluator`, `NotebookRunner`, `RunnerContext`, `TabPtyExecutor`, `DefaultAssertionEvaluator`, `RunnableNotebookDto` across all phases.
- [ ] Command names consistent: `notebook_import_markdown`, `notebook_list_runnable`, `notebook_get_runnable`, `notebook_delete_runnable`, `notebook_export_markdown`, `notebook_import_url`, `notebook_run_start`, `notebook_run_approve`, `notebook_run_cancel`, `notebook_run_pause`, `notebook_run_resume`, `notebook_run_status`.
- [ ] Parser handles: unknown fence lang (error), empty frontmatter (synthesize default), CRLF (normalize on parse? — document decision), nested fences inside markdown cells (preserve verbatim).
- [ ] Runner correctly distinguishes **infrastructure error** (eval returns `Err`) from **predicate failure** (returns `Ok(Failed)`) — the former fails the run with a different UI surface.
- [ ] Parallel vs sequential labels are correct: sub-tasks that touch the same file / depend on a prior symbol are SEQUENTIAL. Independent component or fixture files are PARALLEL.
- [ ] Every phase ends with regression + code review + plan-file update + commit.
- [ ] UI phases (3 and 4) include BOTH pre-impl design (`frontend-design` brief) and post-impl design review.
- [ ] Assertion cells use `jsonpath-plus` (already in `package.json`) on the frontend for display; Rust uses its own JSONPath crate (chosen per Task 2.3 Step 1).
- [ ] Legacy `BlockNotebook` modal and `commands/notebooks.rs` (V0021 `block_notebooks`) remain functional through Phase 3; explicitly retired in Phase 4.4 without deleting the file (deprecation banner only).
- [ ] Plan 00 Phase 2 AND Plan 01 Phase 1 are declared hard prerequisites; if either is not complete, this plan is blocked.
- [ ] `notebook.body_markdown` guarantees byte-stable export for imported notebooks; cells-to-markdown re-render is marked as a lossy projection used only when the user edits cells in-UI (documented in `render_markdown`'s docstring).

## Completion log

## Phase 1 — COMPLETED 2026-05-17

V0030 migration + Rust parser (markdown ↔ typed cell graph) + CRUD Tauri
commands + TS wrappers. Round-trip of `bgp_peer_bringup.mop.md` verified
byte-stable. Tests: 9 parser, 7 substitution, 4 CRUD integration, 7 TS.

## Phase 2 — COMPLETED 2026-05-17

Sequential `NotebookRunner` with control channel, approvals, assertion
evaluation (`parse_show` + JSONPath), resume-from-failure. Tauri commands
for run start/approve/cancel/pause/resume/status. `RunRegistry` tracks live
runs in `AppState`. `AppStatePtyExecutor` wires runner to live PTY via
`block_end_waiters`. Tests: 12 runner unit + 3 fixture-based integration.

## Phase 3 — COMPLETED 2026-05-17

`NotebookPanel` UI with cell-row components (Markdown/Command/Approval/
Assertion/Parameter), `CellStatusChip`, `NotebookToolbar`, parameter form,
footer summary. `notebookRunsStore` (Zustand) consumes Tauri Channel
RunEvents and updates per-cell status, approval prompts, and run state.
Tests: 27 component tests covering rendering and run lifecycle.

## Phase 4 — COMPLETED 2026-05-17

`notebook_import_url` Tauri command (http/https only, 2 MiB body cap) +
`NotebookLibrary` modal with vendor filter chips, Import-from-file,
Import-URL, per-row Open / Export / Delete. Legacy `BlockNotebook` modal
gets a deprecation banner. Tests: 9 library component tests + 4 wiremock
import_url tests.

## Phase 5 — COMPLETED 2026-05-17

10 canonical seed MOPs in `src-tauri/notebooks/seeds/` covering BGP, OSPF,
IS-IS, MTU, VLAN trunk, HSRP, BFD, ACL, NTP, SNMPv3. First-run idempotent
seed loader gated by `app_flags.notebooks.runnable.seeded.v1`. User docs
in `docs/NOTEBOOKS.md`. Tests: 2 seed-parsing + 4 seed-loader idempotency.
