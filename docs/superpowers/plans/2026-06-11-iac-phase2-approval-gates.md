# IaC Integration Phase 2: Blast Radius & Approval Gates

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify the blast radius of mutating IaC operations and gate **agent-initiated** terraform/ansible applies behind an approval modal with a blast-radius preview, before they execute. Record every decision in the audit log.

**Tech Stack:** Rust (regex, serde_json, std::process for `terraform plan -json`), Python (deepagents HITL middleware), TypeScript/React (approval modal reusing BlastRadius patterns), SQLite (reuse `guardrail_decisions`; extend `iac_executions.blast_radius`).

---

## Scope Decisions (read before implementing)

These decisions were made deliberately during planning and constrain the design. **Do not "fix" them back to the spec without revisiting them.**

1. **Gate point = agent-initiated IaC only.** The terminal has a hard *scope-guard invariant*: local PTY writes (`pty.rs`, `pty_runner.rs`) are NEVER intercepted by guardrails — a user typing `terraform apply` in the shell is theirs to run. This is enforced by `tests/pty_guardrail_bypass_test.rs`. Therefore Phase 2 does **NOT** intercept commands typed in the terminal. Instead it gates IaC operations the **agent** proposes — the actual risky actor, and the path we just hardened (deepagents HITL). The spec's "Detector intercepts typed command → modal" flow is explicitly out of scope.
   - **Implication:** Phase 1's post-execution `iac_process_block` (terminal path) is unchanged. Phase 2 adds a *pre-execution* gate only on a new agent IaC tool.

2. **Blast-radius input = fresh `terraform plan -json`, fall back to parsed output.** To score risk we need planned-change counts. Prefer running `terraform plan -json` (read-only) in the project dir for exact counts; if terraform/creds are unavailable, fall back to classifying from the most recent parsed plan output (Phase 1 parser). Both paths feed the same `classify_*` functions.

3. **Reuse, don't rebuild.** The audit table `guardrail_decisions`, the `blast_radius` column on `iac_executions`, the `BlastRadiusHost`/store modal-mounting pattern, `TypedConfirmModal`, and the deepagents HITL primitives (`tier_for_tool`, `is_tier_allowed`, `should_interrupt`) already exist. Phase 2 composes these rather than introducing parallel machinery.

4. **Classifier lives in PYTHON (single source of truth); Rust calls it.** (Decided after the Task-5 research spike, 2026-06-12.) The sidecar→Rust reverse-RPC the original plan assumed for "reuse the Rust classifier" is **dead code** — `mcp_tools.py::_reverse_call` is never called, and `bridge.rs`'s reader thread (lines ~315-345) treats every sidecar stdout line as a *response to a pending Rust-initiated request* matched by id; there is no dispatcher for sidecar-initiated requests. The bridge is effectively one-directional (Rust→Python). However the sidecar CAN run subprocesses (`skills.py:342` already uses `subprocess.run`; the "no subprocess" rule is only for the `exec()` code-exec sandbox and user API-hooks). Therefore:
   - Blast-radius thresholds + `terraform plan -json` execution live in **Python** (`iac_tools.py`), where the agent — the only Phase-2 consumer — needs them.
   - The Rust Tauri command `iac_classify_blast_radius` (for any future terminal-side UI) calls the sidecar over the existing Rust→Python RPC (`iac.classify_blast_radius`), so there is still exactly **one** implementation of the thresholds.
   - Rust keeps the Phase-1 terraform parser (`parser.rs`) for enriched command blocks — unrelated to classification.
   - **Superseded:** original Tasks 1-2 (Rust `BlastRadius` enum + `blast_radius.rs`) and Task 3 (Rust `plan_runner.rs`) are NOT built in Rust. See "Revised Task List (post-research)" below.

---

## File Structure

### New Rust Files
- `src-tauri/src/iac/blast_radius.rs` — Risk classification (terraform + ansible)
- `src-tauri/src/iac/plan_runner.rs` — Run `terraform plan -json`, capture output (read-only)

### New Python Files
- `sidecar/src/ccie_sidecar/agents/iac_tools.py` — Agent tool: `iac_apply` (gated)

### New Frontend Files
- `src/components/IaCApprovalModal.tsx` — Approval gate with blast-radius preview
- `src/components/IaCApprovalModal.css`

### Modified Files
- `src-tauri/src/iac/mod.rs` — export blast_radius, plan_runner
- `src-tauri/src/iac/types.rs` — add `BlastRadius` enum
- `src-tauri/src/commands/mod.rs` — Tauri commands: `iac_classify_blast_radius`, `iac_run_plan`
- `src-tauri/src/lib.rs` — register commands
- `sidecar/.../agents/deepagents_hitl.py` — map IaC blast radius → interrupt tier
- `sidecar/.../agents/deepagents_runtime.py` — attach `iac_apply` tool + interrupt_on config
- `src/components/AgentPanel.tsx` — render IaCApprovalModal on IaC approval interrupt
- `bundled-agents/meraki/AGENT.md` / a new iac agent — document the gated tool

---

## Revised Task List (post-research, 2026-06-12)

The Task-5 spike changed the architecture (classifier in Python, not Rust). The
authoritative execution order is now:

- **T1 — Python blast-radius classifier** (`iac/blast_radius.py` in sidecar): thresholds + production detection + `terraform plan -json` runner + a thin terraform/ansible plan parser for counts. TDD.
- **T2 — `iac_apply` agent tool** (`agents/iac_tools.py`): classifies before applying, tags `metadata["blast_radius"]`, runs the apply post-approval, parses result. TDD where possible.
- **T3 — HITL gating test**: assert `tier_for_tool`/`should_interrupt` gate the tagged tool. (Mapping already works — `tier_for_tool` reads `metadata["blast_radius"]` first.)
- **T4 — Runtime wiring**: attach `iac_apply` + `interrupt_on={"iac_apply": True}` + checkpointer in an IaC-capable agent path.
- **T5 — `iac.classify_blast_radius` sidecar RPC method** + Rust `iac_classify_blast_radius` Tauri command that calls it (single-source reuse for future UI).
- **T6 — IaCApprovalModal** (TS, TDD): blast preview, typed-confirm for critical.
- **T7 — Wire modal into agent approval/interrupt flow** + audit to `guardrail_decisions`.
- **T8 — Config (`iac.approval_threshold`) + E2E + full test suites.**

The original Rust-centric tasks below are kept for reference but Tasks 1-3 are
**superseded** by Python equivalents per scope decision #4.

---

## Task 1: BlastRadius Type

**Files:**
- Modify: `src-tauri/src/iac/types.rs`
- Modify: `src-tauri/src/iac/mod.rs`

- [ ] **Step 1: Add the BlastRadius enum**

```rust
// src-tauri/src/iac/types.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlastRadius {
    Low,
    Medium,
    High,
    Critical,
}

impl BlastRadius {
    /// Map to the standardized agent HITL tier vocabulary
    /// ("low" | "medium" | "high" | "destructive").
    pub fn as_tier(self) -> &'static str {
        match self {
            BlastRadius::Low => "low",
            BlastRadius::Medium => "medium",
            BlastRadius::High => "high",
            BlastRadius::Critical => "destructive",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            BlastRadius::Low => "low",
            BlastRadius::Medium => "medium",
            BlastRadius::High => "high",
            BlastRadius::Critical => "critical",
        }
    }
}
```

- [ ] **Step 2: Export from mod.rs**

```rust
pub use types::{/* existing */, BlastRadius};
```

- [ ] **Step 3: Verify compilation** — `cd src-tauri && cargo build`

- [ ] **Step 4: Commit**

```
feat(iac): add BlastRadius enum with tier mapping

Maps low/medium/high/critical to the standardized agent HITL tier
vocabulary (critical -> destructive) so IaC risk reuses the existing
approval gating instead of a parallel scale.
```

---

## Task 2: Blast Radius Classifier (TDD)

**Files:**
- Create: `src-tauri/src/iac/blast_radius.rs`

Note: the design spec (§2) provides reference `classify_terraform_plan` / `classify_ansible_playbook` / `detect_production_environment` logic. Implement that, adapted to our `IaCMetadata`/`ResourceEvent` types where possible (the parser already extracts create/update/destroy events — prefer counting those over re-parsing raw text).

- [ ] **Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_destroy_in_production_is_critical() {
        let r = classify_terraform(2, 0, 1, &PathBuf::from("/infra/prod"), "main");
        assert_eq!(r, BlastRadius::Critical);
    }

    #[test]
    fn test_large_change_is_critical() {
        let r = classify_terraform(60, 0, 0, &PathBuf::from("/infra/dev"), "feature/x");
        assert_eq!(r, BlastRadius::Critical);
    }

    #[test]
    fn test_over_20_is_high() {
        let r = classify_terraform(25, 0, 0, &PathBuf::from("/infra/dev"), "feature/x");
        assert_eq!(r, BlastRadius::High);
    }

    #[test]
    fn test_small_dev_change_is_low() {
        let r = classify_terraform(2, 1, 0, &PathBuf::from("/infra/dev"), "feature/x");
        assert_eq!(r, BlastRadius::Low);
    }

    #[test]
    fn test_production_bumps_to_medium() {
        let r = classify_terraform(1, 0, 0, &PathBuf::from("/infra/prod"), "feature/x");
        assert_eq!(r, BlastRadius::Medium);
    }

    #[test]
    fn test_main_branch_counts_as_production() {
        assert!(detect_production_environment(&PathBuf::from("/infra/whatever"), "main"));
        assert!(detect_production_environment(&PathBuf::from("/infra/production-east"), "feature/x"));
        assert!(!detect_production_environment(&PathBuf::from("/infra/dev"), "feature/x"));
    }

    #[test]
    fn test_ansible_destructive_tag_in_prod_is_critical() {
        // classify_ansible(is_production=true, has_destructive_tag=true) -> Critical
        assert_eq!(classify_ansible(true, true), BlastRadius::Critical);
        assert_eq!(classify_ansible(false, true), BlastRadius::High);
        assert_eq!(classify_ansible(true, false), BlastRadius::High);
        assert_eq!(classify_ansible(false, false), BlastRadius::Medium);
    }
}
```

- [ ] **Step 2: Run tests, confirm they fail** — `cargo test blast_radius::tests`

- [ ] **Step 3: Implement** the public API:
  - `pub fn classify_terraform(create: u32, update: u32, destroy: u32, working_dir: &Path, git_branch: &str) -> BlastRadius`
  - `pub fn classify_ansible(is_production: bool, has_destructive_tag: bool) -> BlastRadius`
  - `pub fn detect_production_environment(working_dir: &Path, git_branch: &str) -> bool`
  - A convenience `pub fn classify_from_metadata(meta: &IaCMetadata, tool: IaCTool, working_dir: &Path, git_branch: &str) -> BlastRadius` that counts create/update/destroy from `meta.resource_events` and delegates.

  Thresholds (from spec §2): destroy+prod → Critical; total>50 or destroy>10 → Critical; total>20 or (destroy>0 && prod) → High; total>5 or prod → Medium; else Low.

- [ ] **Step 4: Run tests, confirm pass**

- [ ] **Step 5: Commit**

```
feat(iac): blast radius classifier for terraform and ansible

Scores low/medium/high/critical from resource create/update/destroy
counts plus production detection (dir name, main/master branch,
.terraform/environment). Ansible scored from production + destructive
tag. Tests: 8 passing.
```

---

## Task 3: Terraform Plan Runner (TDD where possible)

**Files:**
- Create: `src-tauri/src/iac/plan_runner.rs`

- [ ] **Step 1: Implement `run_terraform_plan_json`**

```rust
/// Run `terraform plan -json` in `working_dir` (read-only) and return raw
/// stdout. Returns Err if terraform is missing or the plan fails — callers
/// fall back to parsing prior output.
pub fn run_terraform_plan_json(working_dir: &Path) -> Result<String> {
    let output = std::process::Command::new("terraform")
        .arg("plan")
        .arg("-json")
        .arg("-no-color")
        .current_dir(working_dir)
        .output()
        .context("terraform not found or failed to spawn")?;
    // terraform plan exits 0 (no changes) or 2 (changes present) on success;
    // 1 is error. Accept 0 and 2.
    let code = output.status.code().unwrap_or(-1);
    if code != 0 && code != 2 {
        bail!("terraform plan failed (exit {code}): {}",
              String::from_utf8_lossy(&output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
```

- [ ] **Step 2: Test with a fixture** — unit-test the exit-code handling by factoring the status/stdout decision into a pure helper `fn interpret_plan_result(code: i32, stdout: &[u8], stderr: &[u8]) -> Result<String>` and testing that (codes 0/2 ok, 1 err). The actual process spawn is covered by the Task 8 manual test.

- [ ] **Step 3: Commit**

```
feat(iac): terraform plan -json runner (read-only)

Spawns `terraform plan -json -no-color` to obtain exact planned-change
counts for blast-radius scoring. Treats exit 0/2 as success (2 = changes
present), 1 as error so callers can fall back to parsed output.
Pure interpret_plan_result helper unit-tested.
```

---

## Task 4: Tauri Commands — classify + plan

**Files:**
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add `iac_run_plan`** — `(working_dir) -> Result<String>` wrapping `run_terraform_plan_json`.

- [ ] **Step 2: Add `iac_classify_blast_radius`** — given `{ tool, working_dir, git_branch, plan_output? }`:
  1. If `plan_output` absent, try `run_terraform_plan_json(working_dir)`.
  2. Parse it with the Phase 1 parser into `IaCMetadata`.
  3. Call `classify_from_metadata`.
  4. Return `{ blast_radius: String, resources_changed, resources_to_destroy, planned_changes: Vec<ResourceEvent> }` so the modal can render the preview.
  5. On any failure to get plan data, return `blast_radius: "high"` (fail-safe: unknown risk gates) with an explanatory `note`.

- [ ] **Step 3: Register both in `lib.rs` invoke_handler.**

- [ ] **Step 4: Verify compilation + commit**

```
feat(iac): tauri commands for blast-radius classification

iac_run_plan runs terraform plan -json; iac_classify_blast_radius
returns blast radius + planned-change preview, preferring a fresh plan
and falling back to provided parsed output. Unknown risk fails safe to
"high" so it always gates.
```

---

## Task 5: Agent IaC Tool with HITL Gating (Python)

**Files:**
- Create: `sidecar/src/ccie_sidecar/agents/iac_tools.py`
- Modify: `sidecar/.../agents/deepagents_hitl.py`
- Modify: `sidecar/.../agents/deepagents_runtime.py`

- [ ] **Step 1: Create the `iac_apply` LangChain tool**

A `StructuredTool` taking `{ working_dir, command }` (e.g. "terraform apply"). It:
  1. Calls back into Rust (via the existing sidecar→Rust RPC or a subprocess) to classify blast radius BEFORE running.
  2. Tags the tool's `metadata = {"blast_radius": <tier>}` so HITL gating sees it.
  3. On execution (post-approval) runs the apply and parses output via Phase 1 parser.

  Note: confirm the sidecar→Rust callback mechanism; if none exists, run classification in-process by shelling `terraform plan -json` from Python and reusing a thin port of the threshold logic, OR expose classification over the existing RPC. Prefer reusing the Rust classifier via RPC to keep one source of truth — verify during research.

- [ ] **Step 2: Map IaC tier in `deepagents_hitl.py`**

`tier_for_tool` already reads `tool_metadata["blast_radius"]` first (line ~33), so a tool tagged with the blast radius is automatically gated. Add a unit test asserting an `iac_apply` tool tagged `"destructive"` returns `"destructive"` and `should_interrupt` is true under a `low` default-allowed.

- [ ] **Step 3: Attach tool + interrupt config in the runtime**

In a new IaC-capable agent path (or extend react_code), pass `iac_apply` in tools and set `interrupt_on={"iac_apply": True}` for `create_deep_agent` so a high/critical apply pauses for approval (mirrors `human-in-the-loop` doc; requires the checkpointer).

- [ ] **Step 4: Tests** — pytest for `tier_for_tool`/`should_interrupt` on the IaC tool; mock the classifier. Run `pytest tests/agents/` green.

- [ ] **Step 5: Commit**

```
feat(iac): gated iac_apply agent tool with blast-radius HITL

Agent tool classifies blast radius before applying and tags itself so
the existing deepagents HITL interrupt gates high/critical applies.
interrupt_on wires the pause. Tests: tier/interrupt for iac_apply.
```

---

## Task 6: Approval Modal UI (TDD)

**Files:**
- Create: `src/components/IaCApprovalModal.tsx`, `.css`
- Create: `src/components/IaCApprovalModal.test.tsx`

Reuse the visual language of `BlastRadius/*` and `TypedConfirmModal`. Props per spec §3 (`command`, `workingDir`, `gitBranch`, `blastRadius`, `plannedChanges {toCreate,toUpdate,toDestroy}`, `onApprove`, `onCancel`, `onShowPlan`).

- [ ] **Step 1: Write failing component tests** — renders blast-radius badge (color by tier), shows git-branch warning when branch is main/master, lists planned changes grouped/colored, calls `onApprove`/`onCancel`. For `critical`, require a typed-confirm (reuse `TypedConfirmModal` pattern) before Proceed enables.

- [ ] **Step 2: Implement the component + CSS.**

- [ ] **Step 3: Run tests green** — `npx vitest run src/components/IaCApprovalModal.test.tsx`

- [ ] **Step 4: Commit**

```
feat(iac): IaCApprovalModal with blast-radius preview

Pre-apply approval modal: color-coded blast badge, working dir + git
branch (warns on main/master), collapsible planned-change list, typed
confirm for critical. Tests passing.
```

---

## Task 7: Wire Modal into the Agent Approval Flow

**Files:**
- Modify: `src/components/AgentPanel.tsx`
- Possibly: a small store mirroring `BlastRadiusHost` resolution pattern

- [ ] **Step 1:** When the agent emits an interrupt for `iac_apply`, mount `IaCApprovalModal` with the classification payload, await the user's decision, and resume the agent (approve → continue; cancel → reject the tool call). Follow the existing tool-approval/interrupt handling already present for agent tool calls; reuse the resolve-via-store pattern from `BlastRadiusHost`.

- [ ] **Step 2:** Record the decision in `guardrail_decisions` (reuse the audit path) with tool=`iac_apply`, blast_radius, approved/denied, and the command.

- [ ] **Step 3: Commit**

```
feat(iac): mount IaCApprovalModal on agent iac_apply interrupt

Agent high/critical applies pause; modal shows the blast-radius preview;
approve resumes, cancel rejects. Decision audited in guardrail_decisions.
```

---

## Task 8: End-to-End Verification + Config

**Files:**
- Modify: settings/config to honor `iac.approval_threshold` (spec §config) — minimum tier that triggers a modal (default `high`); `iac.always_approve=false`.

- [ ] **Step 1:** Add `iac.approval_threshold` + `iac.always_approve` to the IaC config surface; gating uses it (only interrupt at/above threshold). Default: gate `high` and `critical`.

- [ ] **Step 2: Manual E2E** (real terraform fixture project):
  - Agent proposes `terraform apply` on a dev project with a small change → classified low/medium → may auto-proceed (below threshold) → applies, enriched block appears.
  - Agent proposes `terraform apply` that destroys a resource on a `main`-branch/prod-named project → classified critical → modal appears, typed-confirm required → approve → applies; cancel → no apply, audit row recorded.
  - terraform absent → classification fails safe to `high` → modal still appears.

- [ ] **Step 3:** Run full suites: `cargo test` (Rust), `pytest tests/agents/`, `npx vitest run` (IaC + agent panel). All green.

- [ ] **Step 4: Commit**

```
feat(iac): approval threshold config + Phase 2 E2E verification

iac.approval_threshold gates at/above a configurable tier (default high).
Verified agent-initiated apply gating end-to-end incl. fail-safe and
critical typed-confirm. All suites green.
```

---

## Self-Review Checklist

- [ ] **Scope honored:** No interception of user-typed terminal commands; `tests/pty_guardrail_bypass_test.rs` still passes (no new `crate::guardrails`/IaC-gating import in `pty.rs`/`pty_runner.rs`).
- [ ] **Single source of truth:** Blast-radius thresholds live in `blast_radius.rs`; the agent tool reuses it (via RPC) rather than duplicating.
- [ ] **Fail-safe:** Missing terraform/creds → `high` (gates), never silently auto-approves.
- [ ] **Reuse:** `guardrail_decisions` audit, `BlastRadius/*` UI patterns, deepagents HITL primitives — no parallel machinery.
- [ ] **Type parity:** Rust `BlastRadius` ↔ TS tier strings ↔ Python tier vocabulary all agree (critical ↔ destructive).
- [ ] **Migrations:** If any schema change is needed (e.g. storing approval outcome on `iac_executions`), it's a new migration `V0050+` with a regression test (lesson from Phase 1's missing-column bug).

---

## Success Criteria

1. **Agent proposes a risky terraform apply** → blast radius computed from a fresh `terraform plan -json` (or parsed fallback) → IaCApprovalModal shows the preview → user approves/cancels → decision audited.
2. **Below-threshold changes** proceed without a modal (configurable).
3. **Critical operations** (prod destroy) require typed confirmation.
4. **User-typed terminal IaC commands are unaffected** (scope-guard invariant intact).
5. **All tests pass**; classification thresholds covered by unit tests.

---

## Deferred to Later Phases (NOT in Phase 2)

- State browser drawer (⌘⇧T) and drift detection → **Phase 3**.
- Natural-language IaC generation (ReACT `iac_agent.py`) → **Phase 4**.
- Pre-execution gating of commands typed directly into the terminal → revisit only if the scope-guard invariant is intentionally changed.
