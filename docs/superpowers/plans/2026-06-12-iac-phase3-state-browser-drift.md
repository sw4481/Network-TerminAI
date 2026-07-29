# IaC Phase 3: State Browser & Drift Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a ⌘⇧S Terraform state-browser drawer and an on-demand drift check (read-only `terraform plan`, AI explanation, non-destructive remediation) to CCIE Terminal.

**Architecture:** Deterministic state load/cache/query and the read-only drift-plan runner live in **Rust** (`src-tauri/src/iac/`), exposed as Tauri commands — the frontend is the consumer. The single Python piece is AI drift *explanation*, reached over the existing **Rust→Python RPC** (`iac.analyze_drift`), and it degrades gracefully if the sidecar is down. No terminal interception (scope-guard invariant intact); no mutation path (mutating fixes route through Phase 2's gated `iac_apply`).

**Tech Stack:** Rust (rusqlite, serde_json, `std::process` for `terraform plan`, refinery migrations), Python (sidecar JSON-RPC + LLM client), TypeScript/React (zustand store, Tauri `invoke`/`listen`, vitest).

**Design spec:** `docs/superpowers/specs/2026-06-12-iac-phase3-state-browser-drift-design.md`

---

## Scope Decisions (read before implementing)

1. **No terminal interception.** Do NOT touch `pty.rs` / `pty_runner.rs` or add any IaC/guardrail import there. Phase 3 attaches to two explicit entry points only: the ⌘⇧S drawer and a "Check Drift" button. `tests/pty_guardrail_bypass_test.rs` must still pass.
2. **Rust owns deterministic logic; Python owns only AI.** State load/cache/query + drift-plan runner are Rust. `iac.analyze_drift` is the one sidecar RPC, called best-effort from Rust.
3. **Non-destructive remediation only.** The drift modal generates an import command (clipboard) and marks exceptions (local ignore list). It never executes revert/apply.
4. **Report, don't guess, on failure.** terraform absent / plan exit 1 / sidecar down → report inability. Never write a `drift_checks` row claiming "clean" when the check could not run.

---

## File Structure

### New Rust files
- `src-tauri/src/iac/state_manager.rs` — load/cache/query `terraform.tfstate`
- `src-tauri/src/iac/drift_checker.rs` — read-only drift plan runner + pure parser
- `src-tauri/migrations/V0050__iac_state_and_drift.sql` — 3 tables
- `src-tauri/tests/migration_v0050_test.rs` — migration regression test

### Modified Rust files
- `src-tauri/src/iac/mod.rs` — declare + export new modules
- `src-tauri/src/commands/mod.rs` — Tauri commands (load_state, query_state, check_drift, drift exceptions)
- `src-tauri/src/lib.rs` — register commands + menu item + menu event

### New Python files / changes
- `sidecar/src/ccie_sidecar/agents/iac_drift_analysis.py` — AI drift explanation
- `sidecar/src/ccie_sidecar/server.py` — add `iac.analyze_drift` RPC method
- `sidecar/tests/test_iac_drift_analysis.py` — RPC + graceful-failure tests

### New frontend files
- `src/lib/iacState.ts` — Tauri `invoke` wrappers + types
- `src/state/iacStateStore.ts` — zustand store for the drawer
- `src/components/StateDrawer.tsx` + `.css` + `.test.tsx`
- `src/components/DriftDetailModal.tsx` + `.css` + `.test.tsx`

### Modified frontend files
- `src/App.tsx` — mount `StateDrawer`, listen for `menu:iac_state_open`
- `src/components/Terminal.tsx` — ⌘⇧S opens the state drawer

---

## Task 1: Migration V0050 — state cache + drift tables

**Files:**
- Create: `src-tauri/migrations/V0050__iac_state_and_drift.sql`
- Create: `src-tauri/tests/migration_v0050_test.rs`

- [ ] **Step 1: Write the migration SQL**

```sql
-- src-tauri/migrations/V0050__iac_state_and_drift.sql
-- IaC Phase 3 — state browser cache + manual drift checks + drift exceptions.

CREATE TABLE terraform_state_cache (
  id             TEXT PRIMARY KEY,
  project_path   TEXT NOT NULL UNIQUE,
  state_json     TEXT NOT NULL,
  serial         INTEGER NOT NULL,
  resource_count INTEGER NOT NULL,
  last_updated   INTEGER NOT NULL
);

CREATE TABLE drift_checks (
  id                 TEXT PRIMARY KEY,
  project_path       TEXT NOT NULL,
  checked_at         INTEGER NOT NULL,
  has_drift          INTEGER NOT NULL,
  drifted_count      INTEGER NOT NULL DEFAULT 0,
  drift_summary_json TEXT,
  created_at         INTEGER NOT NULL
);

CREATE INDEX idx_drift_checks_project ON drift_checks(project_path, checked_at DESC);

CREATE TABLE drift_exceptions (
  id               TEXT PRIMARY KEY,
  project_path     TEXT NOT NULL,
  resource_address TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  UNIQUE(project_path, resource_address)
);
```

- [ ] **Step 2: Write the migration regression test**

```rust
// src-tauri/tests/migration_v0050_test.rs
//! V0050 — terraform_state_cache + drift_checks + drift_exceptions.
//! Verifies the migration applies cleanly and creates all three tables,
//! the project/checked_at index, and the drift_exceptions uniqueness constraint.

use ccie_terminal_lib::db;
use rusqlite::{params, Connection};
use tempfile::TempDir;

fn open_test_db() -> (TempDir, Connection) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("t.db");
    let conn = db::open_and_migrate(&path).unwrap();
    (dir, conn)
}

#[test]
fn migration_creates_phase3_tables() {
    let (_dir, conn) = open_test_db();
    let names: Vec<String> = conn
        .prepare(
            "SELECT name FROM sqlite_master WHERE type='table'
             AND name IN ('terraform_state_cache','drift_checks','drift_exceptions')",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(names.contains(&"terraform_state_cache".to_string()));
    assert!(names.contains(&"drift_checks".to_string()));
    assert!(names.contains(&"drift_exceptions".to_string()));
}

#[test]
fn drift_exceptions_unique_per_resource() {
    let (_dir, conn) = open_test_db();
    conn.execute(
        "INSERT INTO drift_exceptions (id, project_path, resource_address, created_at)
         VALUES ('e1', '/infra', 'aws_security_group.alb', 1)",
        [],
    )
    .unwrap();
    let dup = conn.execute(
        "INSERT INTO drift_exceptions (id, project_path, resource_address, created_at)
         VALUES ('e2', '/infra', 'aws_security_group.alb', 2)",
        [],
    );
    assert!(dup.is_err(), "duplicate (project_path, resource_address) must be rejected");
    // A different resource in the same project is allowed.
    conn.execute(
        "INSERT INTO drift_exceptions (id, project_path, resource_address, created_at)
         VALUES ('e3', '/infra', 'aws_security_group.web', 3)",
        params![],
    )
    .unwrap();
}
```

- [ ] **Step 3: Run the test, confirm it passes**

Run: `cd src-tauri && cargo test --test migration_v0050_test`
Expected: PASS (refinery auto-discovers `migrations/` via `embed_migrations!`; no registration needed).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/migrations/V0050__iac_state_and_drift.sql src-tauri/tests/migration_v0050_test.rs
git commit -m "feat(iac): V0050 state cache + drift checks + exceptions tables"
```

---

## Task 2: Drift parser + exit-code interpreter (Rust, pure, TDD)

**Files:**
- Create: `src-tauri/src/iac/drift_checker.rs`
- Modify: `src-tauri/src/iac/mod.rs`

- [ ] **Step 1: Declare the module**

In `src-tauri/src/iac/mod.rs`, add exactly this line after `pub mod parser;` (the `state_manager` module is declared later, in Task 3, when its file exists — adding it now would break the build):

```rust
pub mod drift_checker;
```

- [ ] **Step 2: Write failing tests**

```rust
// at the bottom of src-tauri/src/iac/drift_checker.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpret_exit_code_clean_drift_error() {
        assert_eq!(interpret_exit_code(0).unwrap(), false); // no drift
        assert_eq!(interpret_exit_code(2).unwrap(), true);  // drift present
        assert!(interpret_exit_code(1).is_err());           // plan error
    }

    #[test]
    fn parse_drift_extracts_resource_drift_events() {
        // terraform plan -json emits one JSON object per line; resource_drift
        // events carry the address + the change actions.
        let plan = r#"
{"type":"resource_drift","change":{"resource":{"addr":"aws_security_group.alb","resource_type":"aws_security_group","resource_name":"alb"},"action":"update"}}
{"type":"planned_change","change":{"resource":{"addr":"aws_instance.web","resource_type":"aws_instance","resource_name":"web"},"action":"update"}}
"#;
        let drifted = parse_drift(plan);
        // Only resource_drift counts as drift (planned_change is intended change).
        assert_eq!(drifted.len(), 1);
        assert_eq!(drifted[0].address, "aws_security_group.alb");
        assert_eq!(drifted[0].resource_type, "aws_security_group");
        assert_eq!(drifted[0].resource_name, "alb");
    }

    #[test]
    fn parse_drift_empty_on_clean_or_malformed() {
        assert!(parse_drift("").is_empty());
        assert!(parse_drift("not json\n{also not}").is_empty());
    }
}
```

- [ ] **Step 3: Run tests, confirm they fail**

Run: `cd src-tauri && cargo test iac::drift_checker`
Expected: FAIL — `interpret_exit_code`/`parse_drift` not found.

- [ ] **Step 4: Implement**

```rust
// src-tauri/src/iac/drift_checker.rs
//! IaC Phase 3 — read-only drift detection.
//!
//! Runs `terraform plan -detailed-exitcode -json -no-color` (never mutates) and
//! parses `resource_drift` events (changes terraform found OUTSIDE its state —
//! i.e. real drift, as opposed to `planned_change` which is the user's intended
//! change). Exit codes: 0 = no changes, 2 = changes present, 1 = error.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DriftedResource {
    pub resource_type: String,
    pub resource_name: String,
    pub address: String,
    pub detected_changes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftResult {
    pub has_drift: bool,
    pub drifted: Vec<DriftedResource>,
}

/// Map a `terraform plan -detailed-exitcode` status into has-drift / error.
/// 0 -> false (clean), 2 -> true (drift), anything else -> Err.
pub fn interpret_exit_code(code: i32) -> Result<bool> {
    match code {
        0 => Ok(false),
        2 => Ok(true),
        other => bail!("terraform plan failed (exit {other})"),
    }
}

/// Pure: extract drifted resources from `terraform plan -json` stdout.
/// Counts only `resource_drift` events. Malformed lines are skipped.
pub fn parse_drift(plan_json: &str) -> Vec<DriftedResource> {
    let mut out = Vec::new();
    for line in plan_json.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let obj: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if obj.get("type").and_then(|t| t.as_str()) != Some("resource_drift") {
            continue;
        }
        let res = obj
            .get("change")
            .and_then(|c| c.get("resource"))
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let address = res.get("addr").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let resource_type = res
            .get("resource_type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let resource_name = res
            .get("resource_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let action = obj
            .get("change")
            .and_then(|c| c.get("action"))
            .and_then(|v| v.as_str())
            .unwrap_or("update")
            .to_string();
        if address.is_empty() {
            continue;
        }
        out.push(DriftedResource {
            resource_type,
            resource_name,
            address,
            detected_changes: format!("drifted ({action})"),
        });
    }
    out
}

/// Run `terraform plan -detailed-exitcode -json -no-color` (read-only) and
/// return the parsed drift. Err on missing terraform or a plan error (exit 1)
/// so the caller can REPORT inability rather than record a false "clean".
pub fn run_drift_plan(project_path: &Path) -> Result<DriftResult> {
    let output = Command::new("terraform")
        .arg("plan")
        .arg("-detailed-exitcode")
        .arg("-json")
        .arg("-no-color")
        .arg("-input=false")
        .current_dir(project_path)
        .output()?;
    let code = output.status.code().unwrap_or(-1);
    let has_drift = interpret_exit_code(code).map_err(|e| {
        anyhow::anyhow!("{e}: {}", String::from_utf8_lossy(&output.stderr).trim())
    })?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let drifted = if has_drift { parse_drift(&stdout) } else { Vec::new() };
    Ok(DriftResult {
        has_drift: has_drift && !drifted.is_empty(),
        drifted,
    })
}
```

- [ ] **Step 5: Run tests, confirm they pass**

Run: `cd src-tauri && cargo test iac::drift_checker`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/iac/drift_checker.rs src-tauri/src/iac/mod.rs
git commit -m "feat(iac): read-only terraform drift plan runner + pure parser"
```

---

## Task 3: State parser + query (Rust, pure, TDD)

**Files:**
- Create: `src-tauri/src/iac/state_manager.rs`
- Modify: `src-tauri/src/iac/mod.rs`

- [ ] **Step 1: Declare the module**

In `src-tauri/src/iac/mod.rs`, add:

```rust
pub mod state_manager;
```

- [ ] **Step 2: Write failing tests**

```rust
// at the bottom of src-tauri/src/iac/state_manager.rs
#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"
{
  "version": 4,
  "serial": 7,
  "outputs": {"alb_dns": {"value": "x.example.com"}},
  "resources": [
    {"type":"aws_security_group","name":"alb","instances":[
      {"attributes":{"id":"sg-abc123"}}]},
    {"type":"aws_instance","name":"web","instances":[
      {"attributes":{"id":"i-0web"}}]}
  ]
}
"#;

    #[test]
    fn parse_state_reads_serial_and_resources() {
        let state = parse_terraform_state(FIXTURE).unwrap();
        assert_eq!(state.serial, 7);
        assert_eq!(state.resources.len(), 2);
        let sg = state.resources.iter().find(|r| r.resource_type == "aws_security_group").unwrap();
        assert_eq!(sg.address, "aws_security_group.alb");
        assert_eq!(sg.resource_id.as_deref(), Some("sg-abc123"));
    }

    #[test]
    fn query_filters_by_type_name_or_id() {
        let state = parse_terraform_state(FIXTURE).unwrap();
        assert_eq!(query_state_resources(&state, None).len(), 2);
        assert_eq!(query_state_resources(&state, Some("security")).len(), 1);
        assert_eq!(query_state_resources(&state, Some("web")).len(), 1);
        assert_eq!(query_state_resources(&state, Some("i-0web")).len(), 1);
        assert_eq!(query_state_resources(&state, Some("nomatch")).len(), 0);
    }
}
```

- [ ] **Step 3: Run tests, confirm they fail**

Run: `cd src-tauri && cargo test iac::state_manager`
Expected: FAIL — functions not found.

- [ ] **Step 4: Implement**

```rust
// src-tauri/src/iac/state_manager.rs
//! IaC Phase 3 — terraform.tfstate parsing + querying for the state browser.
//! Pure parse/query here; DB caching lives in the Tauri command (Task 5).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateResource {
    pub resource_type: String,
    pub resource_name: String,
    pub address: String,
    pub resource_id: Option<String>,
    pub attributes: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerraformState {
    pub serial: u64,
    pub resources: Vec<StateResource>,
    pub outputs: serde_json::Value,
}

/// Parse the contents of a terraform.tfstate (state format v4). Flattens each
/// resource's first instance into a StateResource with a `type.name` address.
pub fn parse_terraform_state(raw: &str) -> Result<TerraformState> {
    let root: serde_json::Value =
        serde_json::from_str(raw).context("parse terraform.tfstate JSON")?;
    let serial = root.get("serial").and_then(|v| v.as_u64()).unwrap_or(0);
    let outputs = root.get("outputs").cloned().unwrap_or(serde_json::Value::Null);

    let mut resources = Vec::new();
    if let Some(arr) = root.get("resources").and_then(|v| v.as_array()) {
        for r in arr {
            let rtype = r.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let rname = r.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let attributes = r
                .get("instances")
                .and_then(|i| i.as_array())
                .and_then(|i| i.first())
                .and_then(|inst| inst.get("attributes"))
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let resource_id = attributes
                .get("id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            resources.push(StateResource {
                address: format!("{rtype}.{rname}"),
                resource_type: rtype,
                resource_name: rname,
                resource_id,
                attributes,
            });
        }
    }
    Ok(TerraformState { serial, resources, outputs })
}

/// Filter resources by a case-insensitive substring over type / name / id.
/// `None` returns all.
pub fn query_state_resources<'a>(
    state: &'a TerraformState,
    query: Option<&str>,
) -> Vec<&'a StateResource> {
    let q = match query {
        Some(q) if !q.trim().is_empty() => q.to_lowercase(),
        _ => return state.resources.iter().collect(),
    };
    state
        .resources
        .iter()
        .filter(|r| {
            r.resource_type.to_lowercase().contains(&q)
                || r.resource_name.to_lowercase().contains(&q)
                || r.resource_id
                    .as_deref()
                    .map(|id| id.to_lowercase().contains(&q))
                    .unwrap_or(false)
        })
        .collect()
}
```

- [ ] **Step 5: Run tests, confirm they pass**

Run: `cd src-tauri && cargo test iac::state_manager`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/iac/state_manager.rs src-tauri/src/iac/mod.rs
git commit -m "feat(iac): terraform state parser + resource query"
```

---

## Task 4: AI drift analysis (Python sidecar, TDD)

**Files:**
- Create: `sidecar/src/ccie_sidecar/agents/iac_drift_analysis.py`
- Create: `sidecar/tests/test_iac_drift_analysis.py`

- [ ] **Step 1: Write failing tests**

```python
# sidecar/tests/test_iac_drift_analysis.py
"""IaC Phase 3 — AI drift explanation. The analyzer must return per-resource
prose when the LLM responds, and degrade gracefully (empty analyses, never
raise) when the LLM call fails."""
from ccie_sidecar.agents.iac_drift_analysis import analyze_drift


def test_analyze_drift_returns_per_resource_analysis():
    drifted = [
        {"address": "aws_security_group.alb", "resource_type": "aws_security_group",
         "resource_name": "alb", "detected_changes": "drifted (update)"},
    ]

    def fake_llm(prompt: str) -> str:
        return (
            '{"analyses": [{"resource": "aws_security_group.alb",'
            '"explanation": "Ingress rule added manually.",'
            '"cause": "manual change", "recommendation": "import",'
            '"impact": "security exposure"}]}'
        )

    result = analyze_drift(drifted, plan_output="", llm=fake_llm)
    assert len(result["analyses"]) == 1
    assert result["analyses"][0]["resource"] == "aws_security_group.alb"
    assert result["analyses"][0]["recommendation"] == "import"


def test_analyze_drift_degrades_gracefully_on_llm_error():
    drifted = [{"address": "aws_instance.web", "resource_type": "aws_instance",
                "resource_name": "web", "detected_changes": "drifted (update)"}]

    def boom(prompt: str) -> str:
        raise RuntimeError("LLM unavailable")

    result = analyze_drift(drifted, plan_output="", llm=boom)
    assert result["analyses"] == []
    assert result.get("unavailable") is True
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `cd sidecar && python -m pytest tests/test_iac_drift_analysis.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```python
# sidecar/src/ccie_sidecar/agents/iac_drift_analysis.py
"""IaC Phase 3 — AI drift explanation.

Turns the Rust-detected drifted resources + raw plan output into per-resource
prose. This is the ONLY Python piece of Phase 3; everything else is Rust. It is
called best-effort over the Rust->Python RPC `iac.analyze_drift`. ANY failure
returns an empty, `unavailable`-flagged result so the frontend still renders the
raw diff — drift visibility must never depend on the LLM being up.
"""
from __future__ import annotations

import json
from typing import Any, Callable, Optional

# An injectable text-in/text-out LLM call (real one wired by the RPC handler).
LlmFn = Callable[[str], str]


def _build_prompt(drifted: list[dict], plan_output: str) -> str:
    return (
        "Analyze the following Terraform drift (resources changed outside "
        "Terraform). For each, explain what changed, the likely cause, a "
        "recommended action (import|revert|exception), and the impact.\n\n"
        f"Drifted resources:\n{json.dumps(drifted, indent=2)}\n\n"
        f"Plan output (truncated):\n{plan_output[:4000]}\n\n"
        'Respond as JSON: {"analyses": [{"resource": "...", "explanation": "...", '
        '"cause": "...", "recommendation": "import|revert|exception", "impact": "..."}]}'
    )


def analyze_drift(
    drifted: list[dict],
    plan_output: str,
    llm: Optional[LlmFn] = None,
) -> dict[str, Any]:
    """Return {"analyses": [...]} or, on any failure, {"analyses": [],
    "unavailable": True}. Never raises."""
    if not drifted:
        return {"analyses": []}
    call = llm or _default_llm
    try:
        raw = call(_build_prompt(drifted, plan_output))
        parsed = json.loads(raw)
        analyses = parsed.get("analyses")
        if not isinstance(analyses, list):
            return {"analyses": [], "unavailable": True}
        return {"analyses": analyses}
    except Exception:  # noqa: BLE001 — drift must render without AI
        return {"analyses": [], "unavailable": True}


def _default_llm(prompt: str) -> str:
    """Real LLM call, wired lazily so tests never hit the network."""
    from ccie_sidecar.llm_client import generate  # type: ignore

    return generate(prompt=prompt, response_format="json")
```

Note: `_default_llm` imports the project's existing LLM helper lazily. If the
import path differs, adjust `from ccie_sidecar.llm_client import generate` to the
real generation helper used elsewhere in the sidecar — the tests inject `llm` and
never exercise `_default_llm`, so this only matters at runtime.

- [ ] **Step 4: Run tests, confirm they pass**

Run: `cd sidecar && python -m pytest tests/test_iac_drift_analysis.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/ccie_sidecar/agents/iac_drift_analysis.py sidecar/tests/test_iac_drift_analysis.py
git commit -m "feat(iac): AI drift explanation (graceful-degrade) for Phase 3"
```

---

## Task 5: `iac.analyze_drift` RPC method (Python sidecar)

**Files:**
- Modify: `sidecar/src/ccie_sidecar/server.py`
- Modify: `sidecar/tests/test_iac_drift_analysis.py` (add an RPC-level test)

- [ ] **Step 1: Write a failing RPC test**

Append to `sidecar/tests/test_iac_drift_analysis.py`:

```python
def test_rpc_iac_analyze_drift_dispatches(monkeypatch):
    import ccie_sidecar.server as server

    # Stub the analyzer so the test asserts wiring, not LLM behavior.
    monkeypatch.setattr(
        "ccie_sidecar.agents.iac_drift_analysis.analyze_drift",
        lambda drifted, plan_output, **kw: {"analyses": [{"resource": "r"}]},
    )
    resp = server.handle_request({
        "id": "1",
        "method": "iac.analyze_drift",
        "params": {"drifted": [{"address": "r"}], "plan_output": ""},
    })
    assert resp["type"] == "done"
    assert resp["result"]["analyses"][0]["resource"] == "r"


def test_rpc_iac_analyze_drift_requires_list():
    import ccie_sidecar.server as server
    resp = server.handle_request({
        "id": "2",
        "method": "iac.analyze_drift",
        "params": {"drifted": "not-a-list"},
    })
    assert resp["type"] == "error"
```

Note: confirm the dispatcher's function name. The existing handler in
`server.py` is reached via the same path that handles `iac.classify_blast_radius`
(around line 517). If the entry point is not named `handle_request`, change both
test calls to the actual dispatch function (grep `def .*request` in `server.py`).

- [ ] **Step 2: Run the test, confirm it fails**

Run: `cd sidecar && python -m pytest tests/test_iac_drift_analysis.py::test_rpc_iac_analyze_drift_dispatches -v`
Expected: FAIL — method falls through / returns method-not-found.

- [ ] **Step 3: Add the RPC branch**

In `server.py`, immediately AFTER the `elif method == "iac.classify_blast_radius":`
block (ends ~line 543), add:

```python
    elif method == "iac.analyze_drift":
        # IaC Phase 3 — best-effort AI explanation of detected drift. Rust has
        # already detected the drift; this only adds prose. Never fatal: the
        # analyzer itself degrades to {"analyses": [], "unavailable": True}.
        drifted = params.get("drifted")
        if not isinstance(drifted, list):
            return {
                "id": req_id,
                "type": "error",
                "message": "iac.analyze_drift requires a 'drifted' list",
            }
        plan_output = params.get("plan_output", "") or ""
        try:
            from ccie_sidecar.agents.iac_drift_analysis import analyze_drift

            result = analyze_drift(drifted, plan_output=plan_output)
            return {"id": req_id, "type": "done", "result": result}
        except Exception as e:  # pragma: no cover — analyzer already guards
            return {"id": req_id, "type": "error", "message": str(e)}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `cd sidecar && python -m pytest tests/test_iac_drift_analysis.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/ccie_sidecar/server.py sidecar/tests/test_iac_drift_analysis.py
git commit -m "feat(iac): iac.analyze_drift sidecar RPC method"
```

---

## Task 6: Tauri commands — load/query state, exceptions

**Files:**
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the state + exception commands**

Append near the other IaC commands in `src-tauri/src/commands/mod.rs` (after
`iac_classify_blast_radius`, before `pub mod blocks;`):

```rust
/// IaC Phase 3 — load a project's terraform state, using the V0050 cache when
/// the .tfstate mtime is unchanged. Tries `terraform.tfstate` then
/// `.terraform/terraform.tfstate`. Returns None when no state file exists
/// (not an error — the drawer shows an empty state).
#[tauri::command]
pub fn iac_load_state(
    state: State<'_, AppState>,
    project_path: String,
) -> Result<Option<crate::iac::state_manager::TerraformState>, String> {
    use rusqlite::params;
    use std::time::{SystemTime, UNIX_EPOCH};

    let base = std::path::PathBuf::from(&project_path);
    let candidates = [
        base.join("terraform.tfstate"),
        base.join(".terraform").join("terraform.tfstate"),
    ];
    let state_file = match candidates.iter().find(|p| p.exists()) {
        Some(p) => p.clone(),
        None => return Ok(None),
    };

    let mtime = std::fs::metadata(&state_file)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let db = state.db.lock();

    // Serve from cache if mtime matches.
    let cached: Option<String> = db
        .query_row(
            "SELECT state_json FROM terraform_state_cache
             WHERE project_path = ?1 AND last_updated = ?2",
            params![&project_path, mtime],
            |row| row.get(0),
        )
        .ok();
    if let Some(json) = cached {
        let parsed = crate::iac::state_manager::parse_terraform_state(&json)
            .map_err(|e| e.to_string())?;
        return Ok(Some(parsed));
    }

    // Cache miss / stale — read fresh, parse, upsert.
    let raw = std::fs::read_to_string(&state_file).map_err(|e| e.to_string())?;
    let parsed =
        crate::iac::state_manager::parse_terraform_state(&raw).map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO terraform_state_cache
           (id, project_path, state_json, serial, resource_count, last_updated)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(project_path) DO UPDATE SET
           state_json = excluded.state_json,
           serial = excluded.serial,
           resource_count = excluded.resource_count,
           last_updated = excluded.last_updated,
           id = excluded.id",
        params![
            uuid::Uuid::new_v4().to_string(),
            &project_path,
            &raw,
            parsed.serial as i64,
            parsed.resources.len() as i64,
            mtime
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(Some(parsed))
}

/// IaC Phase 3 — filtered resource query for the state drawer search box.
#[tauri::command]
pub fn iac_query_state(
    state: State<'_, AppState>,
    project_path: String,
    query: Option<String>,
) -> Result<Vec<crate::iac::state_manager::StateResource>, String> {
    let loaded = iac_load_state(state, project_path)?;
    let st = match loaded {
        Some(s) => s,
        None => return Ok(Vec::new()),
    };
    let filtered =
        crate::iac::state_manager::query_state_resources(&st, query.as_deref());
    Ok(filtered.into_iter().cloned().collect())
}

/// IaC Phase 3 — add a drift exception (local ignore list).
#[tauri::command]
pub fn iac_add_drift_exception(
    state: State<'_, AppState>,
    project_path: String,
    resource_address: String,
) -> Result<(), String> {
    use rusqlite::params;
    let db = state.db.lock();
    db.execute(
        "INSERT OR IGNORE INTO drift_exceptions
           (id, project_path, resource_address, created_at)
         VALUES (?1, ?2, ?3, strftime('%s','now'))",
        params![uuid::Uuid::new_v4().to_string(), project_path, resource_address],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// IaC Phase 3 — list drift-exception resource addresses for a project.
#[tauri::command]
pub fn iac_list_drift_exceptions(
    state: State<'_, AppState>,
    project_path: String,
) -> Result<Vec<String>, String> {
    use rusqlite::params;
    let db = state.db.lock();
    let mut stmt = db
        .prepare("SELECT resource_address FROM drift_exceptions WHERE project_path = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project_path], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}
```

Note: confirm `uuid` is already a dependency (Phase 1/2 commands use
`Uuid::new_v4()` — `insert_iac_execution` does). If `uuid` isn't imported here,
the other IaC commands' generated IDs come from `database.rs`; in that case
generate the id the same way the nearest command does.

- [ ] **Step 2: Register the commands**

In `src-tauri/src/lib.rs`, in the `invoke_handler![...]` list (near
`commands::iac_classify_blast_radius` at line ~601), add:

```rust
            commands::iac_load_state,
            commands::iac_query_state,
            commands::iac_add_drift_exception,
            commands::iac_list_drift_exceptions,
```

- [ ] **Step 3: Verify compilation**

Run: `cd src-tauri && cargo build`
Expected: builds clean.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(iac): tauri commands for state load/query + drift exceptions"
```

---

## Task 7: Tauri command — `iac_check_drift` (orchestrates plan + AI + persist)

**Files:**
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the command**

Append in `src-tauri/src/commands/mod.rs` after the Task 6 commands:

```rust
/// IaC Phase 3 — run an on-demand, read-only drift check.
///
/// 1. `terraform plan -detailed-exitcode -json` (read-only) via drift_checker.
/// 2. Best-effort AI explanation over the `iac.analyze_drift` sidecar RPC; a
///    failure here NEVER fails the check (analysis is omitted).
/// 3. Persist a drift_checks row ONLY when the check actually ran. On terraform
///    absence / plan error we return Err and write nothing (report, not guess).
#[tauri::command]
pub async fn iac_check_drift(
    state: State<'_, AppState>,
    project_path: String,
) -> Result<serde_json::Value, String> {
    use rusqlite::params;

    let path = std::path::PathBuf::from(&project_path);
    let drift = crate::iac::drift_checker::run_drift_plan(&path)
        .map_err(|e| e.to_string())?;

    // Best-effort AI analysis (only when there's drift to explain).
    let mut analysis = serde_json::json!({"analyses": []});
    if drift.has_drift {
        let rpc_params = serde_json::json!({
            "drifted": drift.drifted,
            "plan_output": "",
        });
        if let Ok(resp) = state.agent.call("iac.analyze_drift", rpc_params).await {
            if let crate::agent_bridge::AgentResponse::Done { result } = resp {
                analysis = result;
            }
        }
    }

    let summary = serde_json::json!({
        "drifted": drift.drifted,
        "analysis": analysis,
    });

    // Persist (the check ran successfully, so record it).
    {
        let db = state.db.lock();
        db.execute(
            "INSERT INTO drift_checks
               (id, project_path, checked_at, has_drift, drifted_count,
                drift_summary_json, created_at)
             VALUES (?1, ?2, strftime('%s','now'), ?3, ?4, ?5, strftime('%s','now'))",
            params![
                uuid::Uuid::new_v4().to_string(),
                &project_path,
                drift.has_drift as i32,
                drift.drifted.len() as i64,
                summary.to_string(),
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(serde_json::json!({
        "hasDrift": drift.has_drift,
        "drifted": drift.drifted,
        "analysis": analysis,
    }))
}
```

- [ ] **Step 2: Register the command**

In `src-tauri/src/lib.rs` `invoke_handler![...]`, add:

```rust
            commands::iac_check_drift,
```

- [ ] **Step 3: Verify compilation**

Run: `cd src-tauri && cargo build`
Expected: builds clean.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(iac): iac_check_drift command (plan + AI + persist, report-on-failure)"
```

---

## Task 8: Frontend API wrappers + types

**Files:**
- Create: `src/lib/iacState.ts`

- [ ] **Step 1: Implement the wrappers**

```typescript
// src/lib/iacState.ts
import { invoke } from "@tauri-apps/api/core";

export interface StateResource {
  resourceType: string;
  resourceName: string;
  address: string;
  resourceId?: string | null;
  attributes: unknown;
}

export interface TerraformState {
  serial: number;
  resources: StateResource[];
  outputs: unknown;
}

export interface DriftedResource {
  resourceType: string;
  resourceName: string;
  address: string;
  detectedChanges: string;
}

export interface DriftAnalysisEntry {
  resource: string;
  explanation: string;
  cause: string;
  recommendation: "import" | "revert" | "exception";
  impact: string;
}

export interface DriftCheckResult {
  hasDrift: boolean;
  drifted: DriftedResource[];
  analysis: { analyses: DriftAnalysisEntry[]; unavailable?: boolean };
}

export const iacLoadState = (projectPath: string) =>
  invoke<TerraformState | null>("iac_load_state", { projectPath });

export const iacQueryState = (projectPath: string, query?: string) =>
  invoke<StateResource[]>("iac_query_state", { projectPath, query: query ?? null });

export const iacCheckDrift = (projectPath: string) =>
  invoke<DriftCheckResult>("iac_check_drift", { projectPath });

export const iacAddDriftException = (projectPath: string, resourceAddress: string) =>
  invoke<void>("iac_add_drift_exception", { projectPath, resourceAddress });

export const iacListDriftExceptions = (projectPath: string) =>
  invoke<string[]>("iac_list_drift_exceptions", { projectPath });

/** Build the terraform import command the modal copies to the clipboard. */
export const buildImportCommand = (address: string, resourceId: string): string =>
  `terraform import ${address} ${resourceId}`;
```

- [ ] **Step 2: Add a tiny unit test for the pure helper**

Create `src/lib/iacState.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildImportCommand } from "./iacState";

describe("buildImportCommand", () => {
  it("formats a terraform import command", () => {
    expect(buildImportCommand("aws_security_group.alb", "sg-abc123")).toBe(
      "terraform import aws_security_group.alb sg-abc123",
    );
  });
});
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run src/lib/iacState.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/iacState.ts src/lib/iacState.test.ts
git commit -m "feat(iac): frontend API wrappers + types for state browser/drift"
```

---

## Task 9: State drawer store (zustand)

**Files:**
- Create: `src/state/iacStateStore.ts`

- [ ] **Step 1: Implement the store**

```typescript
// src/state/iacStateStore.ts
import { create } from "zustand";
import * as api from "../lib/iacState";
import type { StateResource, DriftCheckResult } from "../lib/iacState";

interface IacStateStore {
  open: boolean;
  projectPath: string | null;
  resources: StateResource[];
  query: string;
  loading: boolean;
  error: string | null;

  drift: DriftCheckResult | null;
  exceptions: string[];
  driftLoading: boolean;

  openDrawer: (projectPath: string) => Promise<void>;
  closeDrawer: () => void;
  setQuery: (q: string) => Promise<void>;
  checkDrift: () => Promise<void>;
  addException: (address: string) => Promise<void>;
}

export const useIacStateStore = create<IacStateStore>((set, get) => ({
  open: false,
  projectPath: null,
  resources: [],
  query: "",
  loading: false,
  error: null,
  drift: null,
  exceptions: [],
  driftLoading: false,

  openDrawer: async (projectPath) => {
    set({ open: true, projectPath, loading: true, error: null });
    try {
      const [resources, exceptions] = await Promise.all([
        api.iacQueryState(projectPath),
        api.iacListDriftExceptions(projectPath),
      ]);
      set({ resources, exceptions, loading: false });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  closeDrawer: () => set({ open: false }),

  setQuery: async (q) => {
    set({ query: q });
    const path = get().projectPath;
    if (!path) return;
    try {
      const resources = await api.iacQueryState(path, q);
      set({ resources });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  checkDrift: async () => {
    const path = get().projectPath;
    if (!path) return;
    set({ driftLoading: true, error: null });
    try {
      const drift = await api.iacCheckDrift(path);
      set({ drift, driftLoading: false });
    } catch (e) {
      // Report inability — never silently treat as clean.
      set({ driftLoading: false, error: String(e) });
    }
  },

  addException: async (address) => {
    const path = get().projectPath;
    if (!path) return;
    await api.iacAddDriftException(path, address);
    set((s) => ({ exceptions: [...s.exceptions, address] }));
  },
}));
```

- [ ] **Step 2: Verify it compiles (typecheck)**

Run: `npx tsc --noEmit`
Expected: no new errors from this file.

- [ ] **Step 3: Commit**

```bash
git add src/state/iacStateStore.ts
git commit -m "feat(iac): zustand store for state browser + drift"
```

---

## Task 10: StateDrawer component (TDD)

**Files:**
- Create: `src/components/StateDrawer.tsx`, `.css`, `.test.tsx`

- [ ] **Step 1: Write failing component tests**

```typescript
// src/components/StateDrawer.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { StateDrawer } from "./StateDrawer";
import { useIacStateStore } from "../state/iacStateStore";

beforeEach(() => {
  useIacStateStore.setState({
    open: true,
    projectPath: "/infra/dev",
    resources: [
      { resourceType: "aws_security_group", resourceName: "alb",
        address: "aws_security_group.alb", resourceId: "sg-abc", attributes: {} },
    ],
    query: "",
    loading: false,
    error: null,
    drift: null,
    exceptions: [],
    driftLoading: false,
  });
});

describe("StateDrawer", () => {
  it("lists resources grouped by type", () => {
    render(<StateDrawer />);
    expect(screen.getByText("aws_security_group.alb")).toBeTruthy();
  });

  it("shows an empty state when there are no resources", () => {
    useIacStateStore.setState({ resources: [] });
    render(<StateDrawer />);
    expect(screen.getByText(/No Terraform state found/i)).toBeTruthy();
  });

  it("renders nothing when closed", () => {
    useIacStateStore.setState({ open: false });
    const { container } = render(<StateDrawer />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `npx vitest run src/components/StateDrawer.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement the component**

```tsx
// src/components/StateDrawer.tsx
import { useMemo } from "react";
import { useIacStateStore } from "../state/iacStateStore";
import { DriftDetailModal } from "./DriftDetailModal";
import type { StateResource } from "../lib/iacState";
import "./StateDrawer.css";

function groupByType(resources: StateResource[]): Record<string, StateResource[]> {
  const groups: Record<string, StateResource[]> = {};
  for (const r of resources) {
    (groups[r.resourceType] ||= []).push(r);
  }
  return groups;
}

export function StateDrawer() {
  const {
    open, resources, query, loading, error, driftLoading,
    closeDrawer, setQuery, checkDrift, drift,
  } = useIacStateStore();

  const groups = useMemo(() => groupByType(resources), [resources]);

  if (!open) return null;

  return (
    <div className="iac-state-drawer" role="dialog" aria-label="Terraform State">
      <header className="iac-state-drawer__header">
        <span className="iac-state-drawer__title">Terraform State</span>
        <button onClick={() => checkDrift()} disabled={driftLoading}>
          {driftLoading ? "Checking…" : "Check Drift"}
        </button>
        <button aria-label="Close" onClick={closeDrawer}>×</button>
      </header>

      <input
        className="iac-state-drawer__search"
        placeholder="Search resources…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {error && <div className="iac-state-drawer__error">{error}</div>}

      {loading ? (
        <div className="iac-state-drawer__loading">Loading…</div>
      ) : resources.length === 0 ? (
        <div className="iac-state-drawer__empty">
          No Terraform state found in this directory.
        </div>
      ) : (
        <div className="iac-state-drawer__tree">
          {Object.entries(groups).map(([type, items]) => (
            <section key={type}>
              <h4>{type} ({items.length})</h4>
              <ul>
                {items.map((r) => (
                  <li key={r.address} title={r.resourceId ?? ""}>
                    <code>{r.address}</code>
                    {r.resourceId && <span className="iac-state-drawer__id">{r.resourceId}</span>}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {drift && drift.hasDrift && <DriftDetailModal />}
    </div>
  );
}
```

- [ ] **Step 4: Add minimal CSS**

```css
/* src/components/StateDrawer.css */
.iac-state-drawer {
  position: fixed; top: 0; right: 0; bottom: 0; width: 420px;
  background: var(--panel-bg, #1e1e2e); color: var(--panel-fg, #e0e0e0);
  border-left: 1px solid var(--border, #333); z-index: 1000;
  display: flex; flex-direction: column; overflow: hidden;
}
.iac-state-drawer__header { display: flex; align-items: center; gap: 8px; padding: 10px; border-bottom: 1px solid var(--border, #333); }
.iac-state-drawer__title { flex: 1; font-weight: 600; }
.iac-state-drawer__search { margin: 8px 10px; padding: 6px 8px; }
.iac-state-drawer__tree { overflow-y: auto; padding: 0 10px; }
.iac-state-drawer__tree code { font-family: monospace; }
.iac-state-drawer__id { color: #888; margin-left: 8px; font-size: 0.85em; }
.iac-state-drawer__empty, .iac-state-drawer__loading { padding: 24px; color: #888; }
.iac-state-drawer__error { padding: 10px; color: #f38ba8; }
```

- [ ] **Step 5: Run tests, confirm they pass**

Run: `npx vitest run src/components/StateDrawer.test.tsx`
Expected: PASS. (Requires Task 11's `DriftDetailModal` to exist for the import to resolve — implement Task 11 first if running standalone, or stub the import. Recommended order: do Task 11 then Task 10. See note below.)

> **Ordering note:** `StateDrawer` imports `DriftDetailModal`. Implement **Task 11 before Task 10** so the import resolves, OR temporarily comment the `DriftDetailModal` usage and wire it in Task 11. The subagent executing this plan should do Task 11 first.

- [ ] **Step 6: Commit**

```bash
git add src/components/StateDrawer.tsx src/components/StateDrawer.css src/components/StateDrawer.test.tsx
git commit -m "feat(iac): StateDrawer component (searchable resource tree + empty state)"
```

---

## Task 11: DriftDetailModal component (TDD)

**Files:**
- Create: `src/components/DriftDetailModal.tsx`, `.css`, `.test.tsx`

- [ ] **Step 1: Write failing component tests**

```typescript
// src/components/DriftDetailModal.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DriftDetailModal } from "./DriftDetailModal";
import { useIacStateStore } from "../state/iacStateStore";

const writeText = vi.fn();
beforeEach(() => {
  writeText.mockReset();
  Object.assign(navigator, { clipboard: { writeText } });
  useIacStateStore.setState({
    projectPath: "/infra/dev",
    exceptions: [],
    drift: {
      hasDrift: true,
      drifted: [
        { resourceType: "aws_security_group", resourceName: "alb",
          address: "aws_security_group.alb", detectedChanges: "drifted (update)" },
      ],
      analysis: {
        analyses: [
          { resource: "aws_security_group.alb", explanation: "Manual ingress rule.",
            cause: "manual change", recommendation: "import", impact: "exposure" },
        ],
      },
    },
  });
});

describe("DriftDetailModal", () => {
  it("renders per-resource AI analysis", () => {
    render(<DriftDetailModal />);
    expect(screen.getByText(/Manual ingress rule/)).toBeTruthy();
  });

  it("shows an AI-unavailable fallback", () => {
    useIacStateStore.setState({
      drift: {
        hasDrift: true,
        drifted: [
          { resourceType: "aws_instance", resourceName: "web",
            address: "aws_instance.web", detectedChanges: "drifted (update)" },
        ],
        analysis: { analyses: [], unavailable: true },
      },
    });
    render(<DriftDetailModal />);
    expect(screen.getByText(/AI analysis unavailable/i)).toBeTruthy();
  });

  it("copies an import command to the clipboard", () => {
    render(<DriftDetailModal />);
    fireEvent.click(screen.getByText(/Generate Import Command/i));
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("terraform import aws_security_group.alb"),
    );
  });
});
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `npx vitest run src/components/DriftDetailModal.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement the component**

```tsx
// src/components/DriftDetailModal.tsx
import { useIacStateStore } from "../state/iacStateStore";
import { buildImportCommand } from "../lib/iacState";
import type { DriftAnalysisEntry } from "../lib/iacState";
import "./DriftDetailModal.css";

export function DriftDetailModal() {
  const { drift, exceptions, addException } = useIacStateStore();
  if (!drift || !drift.hasDrift) return null;

  const analysisFor = (address: string): DriftAnalysisEntry | undefined =>
    drift.analysis.analyses.find((a) => a.resource === address);

  const visible = drift.drifted.filter((d) => !exceptions.includes(d.address));
  const suppressed = drift.drifted.filter((d) => exceptions.includes(d.address));

  return (
    <div className="iac-drift-modal" role="dialog" aria-label="Drift Analysis">
      <h3>Drift Analysis — {visible.length} resource(s) changed outside Terraform</h3>

      {drift.analysis.unavailable && (
        <p className="iac-drift-modal__unavailable">AI analysis unavailable.</p>
      )}

      {visible.map((d) => {
        const a = analysisFor(d.address);
        // The id needed for `terraform import` isn't in the drift event; the
        // engineer copies the command skeleton and fills the id from state.
        const importCmd = buildImportCommand(d.address, "<RESOURCE_ID>");
        return (
          <section key={d.address} className="iac-drift-modal__resource">
            <code>{d.address}</code>
            {a ? (
              <div className="iac-drift-modal__analysis">
                <p>{a.explanation}</p>
                <p><strong>Cause:</strong> {a.cause}</p>
                <p><strong>Impact:</strong> {a.impact}</p>
                <p><strong>Recommended:</strong> {a.recommendation}</p>
              </div>
            ) : (
              <p className="iac-drift-modal__nodetail">{d.detectedChanges}</p>
            )}
            <div className="iac-drift-modal__actions">
              <button onClick={() => navigator.clipboard.writeText(importCmd)}>
                Generate Import Command
              </button>
              <button onClick={() => addException(d.address)}>Mark as Exception</button>
            </div>
          </section>
        );
      })}

      {suppressed.length > 0 && (
        <details className="iac-drift-modal__suppressed">
          <summary>Suppressed ({suppressed.length})</summary>
          {suppressed.map((d) => <code key={d.address}>{d.address}</code>)}
        </details>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Add minimal CSS**

```css
/* src/components/DriftDetailModal.css */
.iac-drift-modal { padding: 12px; border-top: 1px solid var(--border, #333); overflow-y: auto; }
.iac-drift-modal__resource { margin: 12px 0; padding: 8px; border: 1px solid var(--border, #333); border-radius: 6px; }
.iac-drift-modal__analysis { background: rgba(80,120,255,0.08); padding: 8px; border-radius: 4px; }
.iac-drift-modal__actions { display: flex; gap: 8px; margin-top: 8px; }
.iac-drift-modal__unavailable, .iac-drift-modal__nodetail { color: #888; }
.iac-drift-modal__suppressed { margin-top: 12px; color: #888; }
```

- [ ] **Step 5: Run tests, confirm they pass**

Run: `npx vitest run src/components/DriftDetailModal.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/components/DriftDetailModal.tsx src/components/DriftDetailModal.css src/components/DriftDetailModal.test.tsx
git commit -m "feat(iac): DriftDetailModal with AI analysis + safe remediation"
```

---

## Task 12: Wire ⌘⇧S + menu + mount (the reachability task)

> **Plan 11 lesson:** a UI surface that isn't reachable ships dead. This task makes the drawer reachable three ways: keyboard, menu, and App mount.

**Files:**
- Modify: `src-tauri/src/lib.rs` (menu item + event)
- Modify: `src/App.tsx` (mount + menu listener)
- Modify: `src/components/Terminal.tsx` (⌘⇧S)

- [ ] **Step 1: Add the menu item (Rust)**

In `src-tauri/src/lib.rs`, near the other IaC/operate menu items (the `view_menu`
group already holds IaC actions — follow the nearest existing submenu). Add a
`MenuItem`:

```rust
            let iac_state_open = MenuItem::with_id(app, "iac_state_open", "Open Terraform State", true, Some("CmdOrCtrl+Shift+S"))?;
```

Add `&iac_state_open` to the items of the most appropriate existing submenu
(e.g. the `view_menu` or `operate_menu` `Submenu::with_items(...)` array —
match where Phase 1/2 IaC actions live; if none, add to `view_menu`).

- [ ] **Step 2: Emit the menu event (Rust)**

In the `app.on_menu_event(...)` `match event.id().as_ref() { ... }` block (around
line 889), add an arm alongside the other IaC arms:

```rust
                    "iac_state_open" => { window.emit("menu:iac_state_open", ()).ok(); }
```

- [ ] **Step 3: Verify Rust compiles**

Run: `cd src-tauri && cargo build`
Expected: builds clean.

- [ ] **Step 4: Mount the drawer + listen for the menu event (App.tsx)**

In `src/App.tsx`:
- Add the import near the other component imports (line ~30):

```tsx
import { StateDrawer } from "./components/StateDrawer";
```

- In the menu-listener `useEffect` (the block starting "Listen for menu events",
  line ~226), add alongside the other `unlistens.push(listen('menu:...'))` calls:

```tsx
    unlistens.push(listen('menu:iac_state_open', async () => {
      // Open the state drawer for the active terminal's cwd.
      const cwd = useTabsStore.getState().activeCwd?.() ?? ".";
      useIacStateStore.getState().openDrawer(cwd);
    }));
```

(Use the existing way the app resolves the active terminal's working directory —
match how another command reads cwd, e.g. how `iac_process_block` callers or the
change-window panel get `cwd`. If there's no helper, pass the active tab's `cwd`
from the tabs store.)

- Add the imports for the store at the top:

```tsx
import { useIacStateStore } from "./state/iacStateStore";
```

- Mount the drawer near the other drawers (next to `<DriftSidebar />`, line ~1090):

```tsx
      <StateDrawer />
```

- [ ] **Step 5: Add the ⌘⇧S handler (Terminal.tsx)**

In `src/components/Terminal.tsx`, mirror the existing ⌘⇧K handler (line ~330).
Add a new `useEffect` (or extend the existing capture-phase handler) so ⌘⇧S opens
the state drawer for this terminal's cwd:

```tsx
  // ⌘⇧S — open the Terraform state browser for this terminal's cwd.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const terminalContainer = wrapRef.current;
      if (!terminalContainer || !terminalContainer.contains(target)) return;
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        // `cwd` is the prop/handle this Terminal already tracks for its session.
        useIacStateStore.getState().openDrawer(cwd ?? ".");
        if (handle?.term) handle.term.blur();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);
```

Add the store import to `Terminal.tsx`:

```tsx
import { useIacStateStore } from "../state/iacStateStore";
```

Note: use whatever variable `Terminal.tsx` already has for the session's working
directory (grep for `cwd` in the file). If the terminal doesn't track cwd, fall
back to `"."` — the Rust command resolves the path; the menu path (Step 4) is the
robust route.

- [ ] **Step 6: Typecheck + run frontend tests**

Run: `npx tsc --noEmit && npx vitest run src/components/StateDrawer.test.tsx src/components/DriftDetailModal.test.tsx`
Expected: typecheck clean; component tests pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/lib.rs src/App.tsx src/components/Terminal.tsx
git commit -m "feat(iac): wire ⌘⇧S + menu + App mount for the state drawer"
```

---

## Task 13: Scope-guard regression + Rust integration test

**Files:**
- Create: `src-tauri/tests/iac_phase3_scope_guard_test.rs`
- Modify: `src-tauri/src/iac/integration_tests.rs` (add an `#[ignore]` drift e2e)

- [ ] **Step 1: Scope-guard test (no terminal interception)**

```rust
// src-tauri/tests/iac_phase3_scope_guard_test.rs
//! Phase 3 must not intercept user-typed terminal commands. Assert pty.rs /
//! pty_runner.rs gained no IaC/guardrail/drift imports.

use std::fs;

#[test]
fn pty_layer_has_no_iac_or_drift_imports() {
    for f in ["src/pty.rs", "src/pty_runner.rs"] {
        let src = fs::read_to_string(f).unwrap_or_default();
        assert!(
            !src.contains("iac::") && !src.to_lowercase().contains("drift_checker")
                && !src.contains("crate::guardrails"),
            "{f} must not import IaC/drift/guardrail logic (scope-guard invariant)",
        );
    }
}
```

- [ ] **Step 2: Run it**

Run: `cd src-tauri && cargo test --test iac_phase3_scope_guard_test`
Expected: PASS. (If paths differ, adjust to the real pty file locations.)

- [ ] **Step 3: Add an ignored drift e2e (needs terraform)**

In `src-tauri/src/iac/integration_tests.rs`, add:

```rust
#[test]
#[ignore] // requires terraform on PATH; run with `cargo test -- --ignored`
fn drift_check_detects_out_of_band_change() {
    use crate::iac::drift_checker::run_drift_plan;
    use std::process::Command;
    use tempfile::TempDir;

    let dir = TempDir::new().unwrap();
    // Minimal local-only terraform that we can drift by editing a file.
    std::fs::write(
        dir.path().join("main.tf"),
        r#"
resource "local_file" "x" {
  content  = "v1"
  filename = "${path.module}/out.txt"
}
"#,
    ).unwrap();

    let run = |args: &[&str]| {
        Command::new("terraform").args(args).current_dir(dir.path())
            .output().unwrap()
    };
    assert!(run(&["init", "-input=false"]).status.success());
    assert!(run(&["apply", "-auto-approve", "-input=false"]).status.success());

    // Drift it: change the managed file out-of-band.
    std::fs::write(dir.path().join("out.txt"), "TAMPERED").unwrap();

    let result = run_drift_plan(dir.path()).unwrap();
    assert!(result.has_drift, "expected drift after out-of-band edit");
}
```

- [ ] **Step 4: Run the ignored test if terraform is available**

Run: `cd src-tauri && cargo test --test '*' drift_check_detects -- --ignored` (or `cargo test drift_check_detects -- --ignored`)
Expected: PASS when terraform is installed; otherwise skip (document in commit).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/tests/iac_phase3_scope_guard_test.rs src-tauri/src/iac/integration_tests.rs
git commit -m "test(iac): Phase 3 scope-guard + ignored drift e2e"
```

---

## Task 14: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Rust**

Run: `cd src-tauri && cargo test`
Expected: all pass (incl. V0050 migration, drift_checker, state_manager, scope-guard; `tests/pty_guardrail_bypass_test.rs` still green).

- [ ] **Step 2: Python**

Run: `cd sidecar && python -m pytest tests/test_iac_drift_analysis.py tests/agents/ -v`
Expected: all pass.

- [ ] **Step 3: Frontend**

Run: `npx vitest run src/lib/iacState.test.ts src/components/StateDrawer.test.tsx src/components/DriftDetailModal.test.tsx && npx tsc --noEmit`
Expected: all pass; typecheck clean.

- [ ] **Step 4: Manual E2E (real terraform project)**
  - Open a Terraform project dir in a terminal tab → ⌘⇧S → drawer lists resources; search filters.
  - Open the menu item "Open Terraform State" → same drawer opens.
  - Click "Check Drift" on a project with an out-of-band change → drift modal shows the resource + AI analysis (or "AI analysis unavailable" if sidecar down).
  - Click "Generate Import Command" → clipboard holds `terraform import …`.
  - Click "Mark as Exception" → resource moves to "Suppressed".
  - terraform absent → "Check Drift" reports an error (no false "clean").
  - Non-Terraform dir → ⌘⇧S → empty-state message.

- [ ] **Step 5: Final commit (if any manual-fix tweaks were needed)**

```bash
git add -A
git commit -m "test(iac): Phase 3 full-suite verification + manual E2E fixes"
```

---

## Self-Review Checklist

- [ ] **Spec coverage:** State browser (Tasks 3,6,9,10,12) ✓; drift detection (Tasks 2,4,5,7) ✓; non-destructive remediation (Task 11) ✓; AI analysis over RPC (Tasks 4,5,7) ✓; V0050 tables (Task 1) ✓; report-not-guess on failure (Tasks 2,7,9) ✓; ⌘⇧S + menu + mount (Task 12) ✓; scope guard (Task 13) ✓.
- [ ] **No interception:** Tasks touch zero PTY code; Task 13 asserts it.
- [ ] **Single source of truth:** Drift thresholds aren't duplicated — drift is binary (exit code), classification reuse isn't needed; AI lives only in `iac_drift_analysis.py`.
- [ ] **Type parity:** Rust `serde(rename_all="camelCase")` ↔ TS interfaces (`resourceType`, `resourceId`, `hasDrift`, `detectedChanges`) agree across `state_manager.rs`/`drift_checker.rs`/`iacState.ts`.
- [ ] **Migration:** V0050 + regression test (Task 1).
- [ ] **Fail-safe semantics:** No gate in Phase 3, so failures REPORT (Err / error string), never fabricate clean — Tasks 2/7/9.

---

## Success Criteria

1. ⌘⇧S (and the menu item) open a searchable state drawer listing project resources.
2. "Check Drift" runs a read-only `terraform plan -detailed-exitcode` and distinguishes clean / drifted / error.
3. Drifted resources show AI analysis (or graceful "unavailable"), Generate Import Command, and Mark as Exception.
4. Inability to run a check is reported, never recorded as clean.
5. No mutation path; user-typed terminal IaC commands unaffected (scope-guard intact).
6. All suites green; new tables covered by a migration regression test.
