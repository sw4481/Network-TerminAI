# IaC Integration Phase 3: State Browser & Drift Detection — Design

**Date:** 2026-06-12
**Status:** Approved (design)
**Phase:** 3 of 4 (IaC integration rollout)
**Predecessors:** Phase 1 (command interception + parsing, V0047), Phase 2 (blast-radius classifier + gated `iac_apply`, deployed to main 2026-06-12)

---

## Goal

Give the network engineer two read-first capabilities for Terraform projects:

1. **State Browser** — a ⌘⇧S drawer to explore the resources in a project's
   `terraform.tfstate` (searchable tree, per-resource detail), without leaving
   the terminal.
2. **Drift Detection** — an explicit, on-demand check that runs
   `terraform plan -detailed-exitcode -json` (read-only), detects resources that
   changed outside Terraform, explains them with AI, and offers **non-destructive**
   remediation (generate import command, mark as exception). Any *mutating* fix
   routes back through the existing Phase 2 gated `iac_apply` agent path.

Both are bundled in one phase because drift detection naturally reuses the
state-loading path the browser introduces.

---

> **Implementation note (2026-06-14):** the state-drawer shortcut shipped as
> **⌘⇧S** (not the ⌘⇧T this doc originally specified). ⌘⇧T was already bound to
> Plan 15's "Open Troubleshoot Tab"; ⌘⇧S ("S" for State) is collision-free. All
> ⌘⇧T references below have been updated to ⌘⇧S to match what shipped.

## Scope Decisions (read before implementing)

These constrain the design. **Do not "fix" them back to the spec without revisiting.**

1. **No terminal interception (scope-guard invariant).** Local PTY writes
   (`pty.rs`, `pty_runner.rs`) are NEVER intercepted by IaC logic — enforced by
   `tests/pty_guardrail_bypass_test.rs`. Phase 3 attaches intelligence to two
   **explicit** entry points only: the ⌘⇧S drawer and a "Check Drift" button.
   There is **no** background drift polling (decided in the original brainstorm)
   and **no** auto-trigger on command completion.

2. **Deterministic logic lives in Rust; AI is the one Python piece.** Phase 2 put
   the blast-radius classifier in Python because the *agent* was its only
   consumer. Phase 3's consumer is the **frontend** (a UI drawer + button calling
   Tauri), so state-load/cache/query and the terraform-plan drift runner live in
   **Rust** (`src-tauri/src/iac/`). The only Python piece is the AI drift
   *explanation*, reached over the **existing Rust→Python RPC** direction
   (`iac.analyze_drift`) — the same one-directional bridge Phase 2's
   `iac.classify_blast_radius` would use. The sidecar→Rust reverse-RPC remains
   dead code; nothing in Phase 3 relies on it.

3. **Non-destructive remediation only.** The drift modal offers AI analysis plus
   **safe** actions: "Generate Import Command" (copies a `terraform import …`
   command to the clipboard) and "Mark as Exception" (a local ignore list). It
   does **not** execute revert/apply. Any mutating fix the user wants flows
   through the already-gated `iac_apply` agent tool, so Phase 3 introduces no new
   mutation path and does not duplicate the Phase 2 approval gate.

4. **Reporting over guessing for failures.** Phase 2 fails *safe* (missing
   terraform → classify "high" so it still gates). Phase 3 has no gate to fall
   back on, so on inability (terraform absent, plan error exit 1, sidecar down)
   it **reports the failure** rather than fabricating a "clean" or "drifted"
   result. No `drift_checks` row is written claiming clean when the check could
   not run.

---

## Architecture Overview

```
⌘⇧S ──► StateDrawer.tsx ──invoke──► iac_load_state / iac_query_state
                                        └─► state_manager.rs (read .tfstate, cache, query)

"Check Drift" ──► iac_check_drift ──► drift_checker.rs
                                        ├─ run_drift_plan()  (terraform plan -detailed-exitcode -json, read-only)
                                        ├─ parse_drift()     (pure)
                                        ├─ RPC iac.analyze_drift ──► Python sidecar (AI explanation, best-effort)
                                        └─ persist drift_checks row
                                     ──► DriftDetailModal.tsx (analysis + diff + safe actions)
```

### Layer responsibilities

- **Rust core (`src-tauri/src/iac/`):** deterministic state load/cache/query +
  the read-only drift plan runner and parser.
- **Python sidecar:** ONLY `iac.analyze_drift` — turns drifted resources + plan
  output into per-resource prose. Optional; failure degrades gracefully.
- **Frontend:** `StateDrawer.tsx`, `DriftDetailModal.tsx`, ⌘⇧S binding, menu
  item, `App.tsx` mount.

---

## Data Model & Migrations

Next free migration is **V0050** (V0047–V0049 used). One migration file adds three
tables. Each gets a migration-applies regression test (lesson from Phase 1's
missing-column bug).

```sql
-- V0050__iac_state_and_drift.sql

-- Cache parsed terraform state for fast drawer loads
CREATE TABLE terraform_state_cache (
  id             TEXT PRIMARY KEY,
  project_path   TEXT NOT NULL UNIQUE,
  state_json     TEXT NOT NULL,        -- raw .tfstate contents
  serial         INTEGER NOT NULL,     -- tfstate serial
  resource_count INTEGER NOT NULL,
  last_updated   INTEGER NOT NULL      -- mtime of the .tfstate when cached
);

-- Record each manual drift check
CREATE TABLE drift_checks (
  id                 TEXT PRIMARY KEY,
  project_path       TEXT NOT NULL,
  checked_at         INTEGER NOT NULL,
  has_drift          INTEGER NOT NULL,
  drifted_count      INTEGER NOT NULL DEFAULT 0,
  drift_summary_json TEXT,             -- DriftedResource[] + AI analysis
  created_at         INTEGER NOT NULL
);

CREATE INDEX idx_drift_checks_project ON drift_checks(project_path, checked_at DESC);

-- Local "ignore this drift" exceptions (backs Mark as Exception)
CREATE TABLE drift_exceptions (
  id               TEXT PRIMARY KEY,
  project_path     TEXT NOT NULL,
  resource_address TEXT NOT NULL,      -- e.g. aws_security_group.alb_https
  created_at       INTEGER NOT NULL,
  UNIQUE(project_path, resource_address)
);
```

**Cache strategy:** compare the `.tfstate` file mtime against
`terraform_state_cache.last_updated`. Changed → re-read and re-cache. This is
deterministic and avoids a time-based expiry (which the unavailable `Date.now()`
in some contexts makes awkward).

`iac_executions.blast_radius` already exists (V0047) — unchanged.

---

## Component Design

### Rust — `src-tauri/src/iac/state_manager.rs`

```rust
pub struct TerraformState {
    pub serial: u64,
    pub resources: Vec<StateResource>,
    pub outputs: serde_json::Value,
}

pub struct StateResource {
    pub resource_type: String,
    pub resource_name: String,
    pub address: String,                 // e.g. aws_security_group.alb_https
    pub resource_id: Option<String>,
    pub attributes: serde_json::Value,
}

/// Cache-aware load: returns cached state when the .tfstate mtime is unchanged,
/// else re-reads and updates the cache. Tries `terraform.tfstate` then
/// `.terraform/terraform.tfstate`.
pub fn load_terraform_state(project_path: &Path, db: &Db) -> Result<TerraformState>;

/// Filter resources by type / name / id substring. Pure; unit-tested.
pub fn query_state_resources(state: &TerraformState, q: Option<&str>) -> Vec<StateResource>;
```

### Rust — `src-tauri/src/iac/drift_checker.rs`

```rust
pub struct DriftedResource {
    pub resource_type: String,
    pub resource_name: String,
    pub address: String,
    pub detected_changes: String,        // diff text for this resource
}

pub struct DriftResult {
    pub has_drift: bool,
    pub drifted: Vec<DriftedResource>,
}

/// Run `terraform plan -detailed-exitcode -json -no-color` (read-only).
/// Exit 0 = clean, 2 = drift present, 1 = error (Err so caller reports it).
pub fn run_drift_plan(project_path: &Path) -> Result<PlanOutcome>;

/// Pure: parse drifted resources from plan JSON. Unit-tested.
pub fn parse_drift(plan_json: &str) -> Vec<DriftedResource>;

/// Pure: 0 -> clean, 2 -> drift, else Err. Unit-tested (mirrors Phase 2's
/// interpret_plan_result helper).
pub fn interpret_exit_code(code: i32) -> Result<bool>;
```

### Tauri commands (`commands/mod.rs`, registered in `lib.rs`)

- `iac_load_state(project_path) -> TerraformState`
- `iac_query_state(project_path, query) -> Vec<StateResource>`
- `iac_check_drift(project_path) -> DriftCheckResult` — runs the plan, parses
  drift, calls `iac.analyze_drift` RPC (best-effort), persists a `drift_checks`
  row, returns drift + analysis. On terraform absence / plan error, returns a
  structured failure (no row written).
- `iac_add_drift_exception(project_path, resource_address)`
- `iac_list_drift_exceptions(project_path) -> Vec<String>`

### Python — `iac.analyze_drift` RPC method

Registered in the sidecar RPC dispatch alongside `iac.classify_blast_radius`.
Input: drifted resources + plan output (+ optional recent git log/executions for
context). Output: per-resource `{explanation, likely_cause, recommendation,
impact}`. **Graceful:** any error/timeout → Rust returns the drift result without
analysis; the modal shows "AI analysis unavailable."

### Frontend

- **`StateDrawer.tsx`** — ⌘⇧S, slides from right (mirrors ⌘⇧D / ⌘⇧G). Search
  bar, resource tree grouped by type (collapsible), per-resource detail panel
  (Copy ID, deep-link where applicable, drift badge). Header "Check Drift"
  button. Empty-state when no `.tfstate`.
- **`DriftDetailModal.tsx`** — per-resource AI analysis + diff view. Actions:
  **Generate Import Command** (clipboard), **Mark as Exception**. Mutating fixes
  link to the agent's gated `iac_apply` — no destructive action here. Suppressed
  (excepted) resources render in a collapsed "Suppressed (N)" section.
- **Menu wiring (explicit task — Plan 11 lesson):** register ⌘⇧S, add the menu
  item, mount `StateDrawer` in `App.tsx`. A UI surface that isn't reachable is a
  known past failure mode.

---

## Error Handling & Edge Cases

| Situation | Behavior |
|-----------|----------|
| No `.tfstate` (not a TF project / never applied) | Drawer empty-state: "No Terraform state found in this directory." Not an error. |
| terraform absent / plan error (exit 1) | Drift check returns a structured failure with stderr; **no** `drift_checks` row claiming clean. |
| Sidecar down / `analyze_drift` fails/times out | Drift modal still renders raw diffs; analysis section shows "AI analysis unavailable." |
| Large state files | Query/filter in Rust before serializing to the frontend; cache avoids re-parse on every open. |
| Drifted resource on ignore list | Rendered collapsed/dimmed under "Suppressed (N)", not hidden. |
| Stale cache | mtime check vs `last_updated`; changed → re-read + re-cache. |

---

## Testing Strategy

**Rust unit:**
- `parse_drift` against fixture plan JSON (drift present / clean / malformed).
- `interpret_exit_code` (0 clean, 2 drift, 1 → Err).
- `query_state_resources` filtering (by type / name / id).
- State parse against a fixture `terraform.tfstate`.
- Cache mtime-staleness logic.

**Rust integration (`--ignored`, requires terraform):**
- Apply a fixture project → modify a resource out-of-band → `iac_check_drift`
  detects exit-2 drift. Mirrors Phase 1's gated integration tests.

**Migration regression:** V0050 applies; all three tables + the index exist.

**Python:** `analyze_drift` RPC with a mocked LLM — valid analysis path and
graceful-failure path.

**Frontend (vitest):** StateDrawer renders tree / search / empty-state;
DriftDetailModal renders analysis, the "AI unavailable" fallback, Generate Import
Command (clipboard), and Mark as Exception (suppression).

**Scope guard:** assert `pty.rs` / `pty_runner.rs` gain no new IaC/guardrail
imports — Phase 3 adds zero terminal interception (keeps
`tests/pty_guardrail_bypass_test.rs` honest).

**E2E manual:** ⌘⇧S opens the drawer on a real TF project; search filters; Check
Drift on a manually-modified resource detects it; Mark as Exception suppresses it.

---

## Success Criteria

1. ⌘⇧S opens a state drawer listing the project's resources, searchable by
   type/name/id, with a per-resource detail panel.
2. "Check Drift" runs a read-only `terraform plan -detailed-exitcode` and
   correctly distinguishes clean / drifted / error.
3. Drifted resources show an AI explanation (when the sidecar is available) and
   a working "Generate Import Command" + "Mark as Exception".
4. Inability to run a check is reported, never silently recorded as clean.
5. No mutation path is introduced; user-typed terminal IaC commands are
   unaffected (scope-guard invariant intact).
6. All test suites green; new tables covered by a migration regression test.

---

## Deferred to Phase 4 (NOT in Phase 3)

- Natural-language IaC generation (ReACT `iac_agent.py`, `generate_terraform_code`,
  `generate_ansible_playbook`).
- One-click revert/import *execution* (mutating) — Phase 3 only generates the
  command; execution stays with the gated agent path.
- Remote state backends (S3 / Terraform Cloud), background drift polling, cost
  estimation — out of the whole IaC rollout's v1.1 scope per the original spec.
