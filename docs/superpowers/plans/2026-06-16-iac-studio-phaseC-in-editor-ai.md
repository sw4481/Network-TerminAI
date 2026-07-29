# IaC Studio Phase C — In-editor AI Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated AI panel to IaC Studio that generates Terraform/Ansible from natural language, previews the result as a Monaco diff against the current buffer, and lets the user accept (write to buffer) or reject — with all mutation still gated by the existing `iac_apply` → `IaCApprovalModal` flow.

**Architecture:** A new direct sidecar RPC (`iac.generate_terraform_code` / `iac.generate_ansible_playbook`) wraps the existing `iac_codegen` functions using the Settings-page LLM. Rust passthrough commands (mirroring Phase B's `iac_lint_file`) expose them. A new `IacAiPanel` (right pane of `IacStudioTab`) drives generation; results render in a new `IacDiffPreview` overlay (Monaco `DiffEditor`). Accepting writes into the editor buffer via `setContent`; the existing ⌘S persists. A transient `ai` slice on `iacStudioStore` holds in-flight state.

**Tech Stack:** Python (sidecar RPC, pytest), Rust (Tauri commands), TypeScript/React (Zustand store, vitest, `@testing-library/react`), `@monaco-editor/react` (`DiffEditor`).

---

## Pre-flight (worktree setup)

This plan runs in an isolated worktree (per `superpowers:using-git-worktrees`). After the worktree is created off `main`, restore the two gitignored build artifacts so `cargo check` / `run.sh` work (documented gotcha from Phase A/B):

```bash
# from the new worktree root
ln -s "/Users/shaunwhi/CCIE Terminal/sidecar/.venv" sidecar/.venv
ln -s "/Users/shaunwhi/CCIE Terminal/sidecar/dist/python" sidecar/dist/python
```

Always run `./run.sh` FROM the worktree (it uses `$(pwd)`-relative paths).

---

## File Structure

**Create:**
- `sidecar/tests/test_iac_codegen_rpc.py` — pytest for the two new RPC branches.
- `src/components/iac/IacAiPanel.tsx` — AI side panel (prompt + Generate/Scaffold/Explain).
- `src/components/iac/IacAiPanel.test.tsx` — vitest for the panel.
- `src/components/iac/IacDiffPreview.tsx` — Monaco DiffEditor accept/reject overlay.
- `src/components/iac/IacDiffPreview.test.tsx` — vitest for the overlay.
- `src/components/iac/IacAiPanel.css` — panel + overlay styles.

**Modify:**
- `sidecar/src/ccie_sidecar/agents/iac_codegen_tools.py` — add public `build_default_codegen_llm()`.
- `sidecar/src/ccie_sidecar/server.py:586` — add two `elif method ==` branches after `iac.lint_file`.
- `src-tauri/src/commands/mod.rs:4271` — add `iac_generate_terraform` / `iac_generate_ansible` after `iac_lint_file`.
- `src-tauri/src/lib.rs:604` — register the two new commands.
- `src/lib/tauri.ts:1785` — add `CodegenResult` type + `iacGenerateTerraform` / `iacGenerateAnsible`.
- `src/state/iacStudioStore.ts` — add transient `ai` slice + setters.
- `src/state/iacStudioStore.test.ts` — add tests for the `ai` slice.
- `src/components/iac/IacStudioTab.tsx` — mount `IacAiPanel`; render `IacDiffPreview` overlay.

---

## Task 1: Public codegen-LLM builder

The RPC must inject a real `str -> str` LLM (the bare `generate_terraform_code(intent, context)` uses `_default_llm`, which raises). `iac_codegen_tools.py` already has the private `_make_default_llm()` that builds the Settings-page model. Expose it publicly so `server.py` (and tests, via monkeypatch) can use one seam.

**Files:**
- Modify: `sidecar/src/ccie_sidecar/agents/iac_codegen_tools.py`

- [ ] **Step 1: Add the public wrapper**

At the end of `sidecar/src/ccie_sidecar/agents/iac_codegen_tools.py`, after the existing factory functions, add:

```python
def build_default_codegen_llm() -> LlmFn:
    """Public seam for the codegen RPC: a `str -> str` callable backed by the
    Settings-page chat model (`get_saved_config()` + `build_chat_model()`).

    Separate from the tool factories so the RPC layer (server.py) can inject the
    same model the agent tools use, and tests can monkeypatch this one symbol to
    avoid any network call.
    """
    return _make_default_llm()
```

- [ ] **Step 2: Verify it imports**

Run: `cd sidecar && .venv/bin/python -c "from ccie_sidecar.agents.iac_codegen_tools import build_default_codegen_llm; print('ok')"`
Expected: prints `ok`

- [ ] **Step 3: Commit**

```bash
git add sidecar/src/ccie_sidecar/agents/iac_codegen_tools.py
git commit -m "feat(iac): public build_default_codegen_llm seam for codegen RPC"
```

---

## Task 2: Sidecar RPC branches (TDD)

Add `iac.generate_terraform_code` and `iac.generate_ansible_playbook` to `handle_request()`, mirroring `iac.lint_file`. Each validates params, builds the Settings-page LLM via `build_default_codegen_llm()`, calls the codegen function, and returns its dict verbatim. Codegen never raises, so a failed/missing LLM surfaces as `{"unavailable": true, ...}` — never a fake clean result.

**Files:**
- Create: `sidecar/tests/test_iac_codegen_rpc.py`
- Modify: `sidecar/src/ccie_sidecar/server.py` (after line 586, the end of the `iac.lint_file` branch)

- [ ] **Step 1: Write the failing tests**

Create `sidecar/tests/test_iac_codegen_rpc.py`:

```python
"""Tests for the iac.generate_terraform_code / iac.generate_ansible_playbook RPC
methods (IaC Studio Phase C).

The RPC builds the Settings-page LLM via
iac_codegen_tools.build_default_codegen_llm(). These tests monkeypatch that one
symbol so no network/model is ever touched: a canned-JSON stub for the happy
path, and a raising stub for the unavailable path. validate=False is forced by
the absence of the terraform/ansible binaries in CI (codegen skips validation
gracefully), so assertions never depend on a real binary.
"""
from __future__ import annotations

import json

import ccie_sidecar.agents.iac_codegen_tools as codegen_tools
from ccie_sidecar.server import handle_request


def _stub_llm(payload: dict):
    def _call(_prompt: str) -> str:
        return json.dumps(payload)
    return _call


def test_generate_terraform_requires_intent():
    resp = handle_request({
        "id": "g1",
        "method": "iac.generate_terraform_code",
        "params": {"working_dir": "/infra"},
    })
    assert resp["type"] == "error"
    assert "intent" in resp["message"]


def test_generate_terraform_happy_path(monkeypatch):
    payload = {
        "code": 'resource "aws_s3_bucket" "b" {}',
        "filename": "s3.tf",
        "explanation": "an s3 bucket",
        "estimated_apply_time_seconds": 5,
    }
    monkeypatch.setattr(
        codegen_tools, "build_default_codegen_llm", lambda: _stub_llm(payload)
    )
    resp = handle_request({
        "id": "g2",
        "method": "iac.generate_terraform_code",
        "params": {"intent": "make an s3 bucket", "working_dir": "/infra"},
    })
    assert resp["type"] == "done"
    result = resp["result"]
    assert result["tool"] == "terraform"
    assert result["unavailable"] is False
    assert "aws_s3_bucket" in result["code"]
    assert result["filename"] == "s3.tf"


def test_generate_terraform_unavailable_on_llm_failure(monkeypatch):
    def _boom():
        def _call(_p: str) -> str:
            raise RuntimeError("model down")
        return _call
    monkeypatch.setattr(codegen_tools, "build_default_codegen_llm", _boom)
    resp = handle_request({
        "id": "g3",
        "method": "iac.generate_terraform_code",
        "params": {"intent": "make an s3 bucket", "working_dir": "/infra"},
    })
    assert resp["type"] == "done"  # never an error — honest unavailable result
    assert resp["result"]["unavailable"] is True
    assert resp["result"]["code"] == ""


def test_generate_ansible_happy_path(monkeypatch):
    payload = {
        "playbook": "- hosts: all\n  tasks: []\n",
        "filename": "play.yml",
        "explanation": "a noop play",
        "target_host_count": 1,
    }
    monkeypatch.setattr(
        codegen_tools, "build_default_codegen_llm", lambda: _stub_llm(payload)
    )
    resp = handle_request({
        "id": "g4",
        "method": "iac.generate_ansible_playbook",
        "params": {"intent": "noop play", "working_dir": "/infra"},
    })
    assert resp["type"] == "done"
    assert resp["result"]["tool"] == "ansible"
    assert resp["result"]["unavailable"] is False
    assert "hosts: all" in resp["result"]["code"]


def test_generate_ansible_requires_intent():
    resp = handle_request({
        "id": "g5",
        "method": "iac.generate_ansible_playbook",
        "params": {"working_dir": "/infra"},
    })
    assert resp["type"] == "error"
    assert "intent" in resp["message"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sidecar && .venv/bin/python -m pytest tests/test_iac_codegen_rpc.py -v`
Expected: FAIL — all tests error/fail because the RPC methods are unhandled (handle_request returns an "unknown method" error).

- [ ] **Step 3: Add the RPC branches**

In `sidecar/src/ccie_sidecar/server.py`, immediately after line 586 (the end of the `elif method == "iac.lint_file":` block, before the `if method == "pcap.run_capture":` line at 588), insert:

```python
    elif method == "iac.generate_terraform_code":
        # IaC Studio Phase C — NL → Terraform HCL using the Settings-page LLM.
        # codegen never raises; a failed/missing model returns
        # {"unavailable": True, "code": ""} (honest, never a fake clean result).
        intent = params.get("intent")
        working_dir = params.get("working_dir", "")
        if not isinstance(intent, str) or not intent.strip():
            return {
                "id": req_id,
                "type": "error",
                "message": "iac.generate_terraform_code requires an 'intent' string",
            }
        try:
            from ccie_sidecar.agents import iac_codegen, iac_codegen_tools

            llm = iac_codegen_tools.build_default_codegen_llm()
            context = {
                "project_path": working_dir,
                "git_branch": params.get("git_branch", ""),
                "existing_resources": params.get("existing_code", ""),
            }
            result = iac_codegen.generate_terraform_code(intent, context, llm=llm)
            return {"id": req_id, "type": "done", "result": result}
        except Exception as e:  # pragma: no cover — codegen already guards
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "iac.generate_ansible_playbook":
        # IaC Studio Phase C — NL → Ansible YAML using the Settings-page LLM.
        intent = params.get("intent")
        working_dir = params.get("working_dir", "")
        if not isinstance(intent, str) or not intent.strip():
            return {
                "id": req_id,
                "type": "error",
                "message": "iac.generate_ansible_playbook requires an 'intent' string",
            }
        try:
            from ccie_sidecar.agents import iac_codegen, iac_codegen_tools

            llm = iac_codegen_tools.build_default_codegen_llm()
            context = {
                "project_path": working_dir,
                "git_branch": params.get("git_branch", ""),
                "roles_path": working_dir,
            }
            result = iac_codegen.generate_ansible_playbook(intent, context, llm=llm)
            return {"id": req_id, "type": "done", "result": result}
        except Exception as e:  # pragma: no cover — codegen already guards
            return {"id": req_id, "type": "error", "message": str(e)}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd sidecar && .venv/bin/python -m pytest tests/test_iac_codegen_rpc.py -v`
Expected: PASS — all 5 tests pass.

- [ ] **Step 5: Run the full sidecar IaC suite for regressions**

Run: `cd sidecar && .venv/bin/python -m pytest tests/test_iac_codegen.py tests/test_iac_lint.py tests/test_iac_classify_rpc.py tests/test_iac_codegen_rpc.py -q`
Expected: PASS — no regressions.

- [ ] **Step 6: Commit**

```bash
git add sidecar/src/ccie_sidecar/server.py sidecar/tests/test_iac_codegen_rpc.py
git commit -m "feat(iac): iac.generate_terraform_code / iac.generate_ansible_playbook RPC"
```

---

## Task 3: Rust passthrough commands

Mirror `iac_lint_file` exactly — thin AgentBridge passthroughs that forward params and return the result `serde_json::Value` verbatim.

**Files:**
- Modify: `src-tauri/src/commands/mod.rs` (after line 4271, the end of `iac_lint_file`)
- Modify: `src-tauri/src/lib.rs` (after line 604)

- [ ] **Step 1: Add the two commands**

In `src-tauri/src/commands/mod.rs`, immediately after line 4271 (the closing `}` of `iac_lint_file`), insert:

```rust
/// IaC Studio Phase C — generate Terraform HCL from natural language via the
/// sidecar's `iac.generate_terraform_code` RPC (Settings-page LLM). Returns the
/// codegen dict verbatim; `unavailable: true` is a valid (honest) result, not
/// an error.
#[tauri::command]
pub async fn iac_generate_terraform(
    state: State<'_, AppState>,
    intent: String,
    working_dir: String,
    git_branch: Option<String>,
    existing_code: Option<String>,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({
        "intent": intent,
        "working_dir": working_dir,
        "git_branch": git_branch.unwrap_or_default(),
        "existing_code": existing_code.unwrap_or_default(),
    });
    let resp = state
        .agent
        .call("iac.generate_terraform_code", params)
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(result),
        crate::agent_bridge::AgentResponse::Error { message } => Err(message),
        _ => Err("unexpected response type".to_string()),
    }
}

/// IaC Studio Phase C — generate an Ansible playbook from natural language via
/// the sidecar's `iac.generate_ansible_playbook` RPC (Settings-page LLM).
#[tauri::command]
pub async fn iac_generate_ansible(
    state: State<'_, AppState>,
    intent: String,
    working_dir: String,
    git_branch: Option<String>,
    existing_code: Option<String>,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({
        "intent": intent,
        "working_dir": working_dir,
        "git_branch": git_branch.unwrap_or_default(),
        "existing_code": existing_code.unwrap_or_default(),
    });
    let resp = state
        .agent
        .call("iac.generate_ansible_playbook", params)
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(result),
        crate::agent_bridge::AgentResponse::Error { message } => Err(message),
        _ => Err("unexpected response type".to_string()),
    }
}
```

- [ ] **Step 2: Register the commands**

In `src-tauri/src/lib.rs`, after line 604 (`commands::iac_lint_file,`), add:

```rust
            commands::iac_generate_terraform,
            commands::iac_generate_ansible,
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: PASS — `Finished` with no errors (warnings about unused are acceptable only if pre-existing).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(iac): iac_generate_terraform / iac_generate_ansible Tauri commands"
```

---

## Task 4: tauri.ts bindings

Add the `CodegenResult` type and the two non-streaming wrappers, mirroring `iacLintFile`.

**Files:**
- Modify: `src/lib/tauri.ts` (after line 1785, the `iacLintFile` export)

- [ ] **Step 1: Add the type and wrappers**

In `src/lib/tauri.ts`, immediately after line 1785 (the `iacLintFile` arrow function), insert:

```typescript
/** Result of an IaC Studio codegen RPC (mirrors sidecar iac_codegen schema). */
export type CodegenResult = {
  tool: "terraform" | "ansible";
  code: string;
  filename: string;
  explanation: string;
  estimated_apply_time_seconds: number;
  validation: { valid: boolean | null; skipped: boolean; error: string | null };
  /** True when the LLM was unavailable or returned no usable code. */
  unavailable: boolean;
};

/** Generate Terraform HCL from NL intent via the Settings-page LLM. */
export const iacGenerateTerraform = (
  intent: string,
  workingDir: string,
  gitBranch?: string,
  existingCode?: string,
) =>
  invoke<CodegenResult>("iac_generate_terraform", {
    intent,
    workingDir,
    gitBranch: gitBranch ?? "",
    existingCode: existingCode ?? "",
  });

/** Generate an Ansible playbook from NL intent via the Settings-page LLM. */
export const iacGenerateAnsible = (
  intent: string,
  workingDir: string,
  gitBranch?: string,
  existingCode?: string,
) =>
  invoke<CodegenResult>("iac_generate_ansible", {
    intent,
    workingDir,
    gitBranch: gitBranch ?? "",
    existingCode: existingCode ?? "",
  });
```

- [ ] **Step 2: Verify it typechecks**

Run: `npx tsc --noEmit`
Expected: PASS — no new type errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/tauri.ts
git commit -m "feat(iac): tauri.ts CodegenResult type + iacGenerate{Terraform,Ansible}"
```

---

## Task 5: Store `ai` slice (TDD)

Add a transient per-tab `ai` slice holding in-flight generation state and the pending proposal. No persistence, no migration.

**Files:**
- Modify: `src/state/iacStudioStore.ts`
- Modify: `src/state/iacStudioStore.test.ts`

- [ ] **Step 1: Write the failing tests**

Open `src/state/iacStudioStore.test.ts` and add this block inside the top-level `describe` (after the existing tests):

```typescript
describe("ai slice", () => {
  it("defaults to not-generating with no proposal", () => {
    const store = useIacStudioStore.getState();
    store.ensure("ai-tab", "/root");
    const s = useIacStudioStore.getState().tabs["ai-tab"];
    expect(s.ai).toEqual({ generating: false, proposal: null, error: null });
  });

  it("setAiGenerating flips the flag and clears prior error", () => {
    const store = useIacStudioStore.getState();
    store.ensure("ai-tab2", "/root");
    store.setAiError("ai-tab2", "boom");
    store.setAiGenerating("ai-tab2", true);
    const s = useIacStudioStore.getState().tabs["ai-tab2"];
    expect(s.ai.generating).toBe(true);
    expect(s.ai.error).toBeNull();
  });

  it("setAiProposal stores the proposal and stops generating", () => {
    const store = useIacStudioStore.getState();
    store.ensure("ai-tab3", "/root");
    store.setAiGenerating("ai-tab3", true);
    store.setAiProposal("ai-tab3", {
      code: "resource {}",
      filename: "x.tf",
      explanation: "x",
      validation: { valid: true, skipped: false, error: null },
    });
    const s = useIacStudioStore.getState().tabs["ai-tab3"];
    expect(s.ai.generating).toBe(false);
    expect(s.ai.proposal?.filename).toBe("x.tf");
  });

  it("clearAiProposal resets the proposal", () => {
    const store = useIacStudioStore.getState();
    store.ensure("ai-tab4", "/root");
    store.setAiProposal("ai-tab4", {
      code: "c",
      filename: "f",
      explanation: "e",
      validation: { valid: null, skipped: true, error: null },
    });
    store.clearAiProposal("ai-tab4");
    expect(useIacStudioStore.getState().tabs["ai-tab4"].ai.proposal).toBeNull();
  });

  it("setAiError records the message and stops generating", () => {
    const store = useIacStudioStore.getState();
    store.ensure("ai-tab5", "/root");
    store.setAiGenerating("ai-tab5", true);
    store.setAiError("ai-tab5", "rpc failed");
    const s = useIacStudioStore.getState().tabs["ai-tab5"];
    expect(s.ai.error).toBe("rpc failed");
    expect(s.ai.generating).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/state/iacStudioStore.test.ts`
Expected: FAIL — `s.ai` is undefined; setters don't exist.

- [ ] **Step 3: Add the `ai` slice to state, the type, and freshIacStudioState**

In `src/state/iacStudioStore.ts`:

(a) Add a proposal type above `IacStudioTabState` (after the imports, before line 4):

```typescript
export interface AiProposal {
  code: string;
  filename: string;
  explanation: string;
  validation: { valid: boolean | null; skipped: boolean; error: string | null };
}

export interface AiSlice {
  generating: boolean;
  proposal: AiProposal | null;
  error: string | null;
}
```

(b) Add `ai: AiSlice;` to the `IacStudioTabState` interface (after `linters: LinterStatus[];`):

```typescript
  linters: LinterStatus[];
  ai: AiSlice;
```

(c) In `freshIacStudioState`, add the default (after `linters: [],`):

```typescript
    linters: [],
    ai: { generating: false, proposal: null, error: null },
```

- [ ] **Step 4: Add the setters to the store interface**

In the `IacStudioStore` interface (after `setDiagnostics`), add:

```typescript
  setAiGenerating: (tabId: string, generating: boolean) => void;
  setAiProposal: (tabId: string, proposal: AiProposal) => void;
  clearAiProposal: (tabId: string) => void;
  setAiError: (tabId: string, error: string) => void;
```

- [ ] **Step 5: Implement the setters**

In the `create<IacStudioStore>(...)` body, after the `setDiagnostics` implementation (after line 136's closing `},`), add:

```typescript
  setAiGenerating: (tabId, generating) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return {
        tabs: {
          ...s.tabs,
          [tabId]: { ...cur, ai: { ...cur.ai, generating, error: generating ? null : cur.ai.error } },
        },
      };
    }),

  setAiProposal: (tabId, proposal) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return {
        tabs: {
          ...s.tabs,
          [tabId]: { ...cur, ai: { generating: false, proposal, error: null } },
        },
      };
    }),

  clearAiProposal: (tabId) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return {
        tabs: { ...s.tabs, [tabId]: { ...cur, ai: { ...cur.ai, proposal: null } } },
      };
    }),

  setAiError: (tabId, error) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return {
        tabs: {
          ...s.tabs,
          [tabId]: { ...cur, ai: { ...cur.ai, generating: false, error } },
        },
      };
    }),
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/state/iacStudioStore.test.ts`
Expected: PASS — all existing + 5 new tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/state/iacStudioStore.ts src/state/iacStudioStore.test.ts
git commit -m "feat(iac): transient ai slice + setters on iacStudioStore"
```

---

## Task 6: IacDiffPreview overlay (TDD)

A modal overlay showing the current buffer (original, read-only) vs the proposed code (modified, read-only) in a Monaco `DiffEditor`, with Accept/Reject and an honest validation note. Accept/Reject are plain callbacks — the parent owns buffer writes, keeping this component pure and testable.

**Files:**
- Create: `src/components/iac/IacDiffPreview.tsx`
- Create: `src/components/iac/IacDiffPreview.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `src/components/iac/IacDiffPreview.test.tsx`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IacDiffPreview } from "./IacDiffPreview";

// Monaco DiffEditor lazy-loads monaco (never resolves under jsdom); stub it to
// a sentinel that exposes the original/modified props for assertions.
vi.mock("@monaco-editor/react", () => ({
  DiffEditor: (props: { original: string; modified: string }) => (
    <div
      data-testid="diff-editor"
      data-original={props.original}
      data-modified={props.modified}
    />
  ),
}));

const proposal = {
  code: 'resource "aws_s3_bucket" "b" {}',
  filename: "s3.tf",
  explanation: "an s3 bucket",
  validation: { valid: true, skipped: false, error: null },
};

describe("IacDiffPreview", () => {
  it("renders the diff with current buffer as original and proposal as modified", () => {
    render(
      <IacDiffPreview
        original="# old"
        proposal={proposal}
        language="hcl"
        onAccept={() => {}}
        onReject={() => {}}
      />,
    );
    const diff = screen.getByTestId("diff-editor");
    expect(diff.getAttribute("data-original")).toBe("# old");
    expect(diff.getAttribute("data-modified")).toBe(proposal.code);
  });

  it("shows the explanation and filename", () => {
    render(
      <IacDiffPreview original="" proposal={proposal} language="hcl" onAccept={() => {}} onReject={() => {}} />,
    );
    expect(screen.getByText(/an s3 bucket/)).toBeInTheDocument();
    expect(screen.getByText(/s3\.tf/)).toBeInTheDocument();
  });

  it("calls onAccept when Accept is clicked", () => {
    const onAccept = vi.fn();
    render(
      <IacDiffPreview original="" proposal={proposal} language="hcl" onAccept={onAccept} onReject={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("iac-diff-accept"));
    expect(onAccept).toHaveBeenCalledOnce();
  });

  it("calls onReject when Reject is clicked", () => {
    const onReject = vi.fn();
    render(
      <IacDiffPreview original="" proposal={proposal} language="hcl" onAccept={() => {}} onReject={onReject} />,
    );
    fireEvent.click(screen.getByTestId("iac-diff-reject"));
    expect(onReject).toHaveBeenCalledOnce();
  });

  it("shows an honest 'not validated' note when validation was skipped", () => {
    render(
      <IacDiffPreview
        original=""
        proposal={{ ...proposal, validation: { valid: null, skipped: true, error: null } }}
        language="hcl"
        onAccept={() => {}}
        onReject={() => {}}
      />,
    );
    expect(screen.getByText(/syntax not validated/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/iac/IacDiffPreview.test.tsx`
Expected: FAIL — module `./IacDiffPreview` does not exist.

- [ ] **Step 3: Implement the component**

Create `src/components/iac/IacDiffPreview.tsx`:

```typescript
import { DiffEditor } from "@monaco-editor/react";
import type { AiProposal } from "../../state/iacStudioStore";
import "./IacAiPanel.css";

export function IacDiffPreview({
  original,
  proposal,
  language,
  onAccept,
  onReject,
}: {
  original: string;
  proposal: AiProposal;
  language: string;
  onAccept: () => void;
  onReject: () => void;
}) {
  const v = proposal.validation;
  // Honest validation note: never imply the code is valid when the linter was
  // skipped (binary absent). Mirrors the Phase B linter-honesty rule.
  const note =
    v.skipped || v.valid === null
      ? `syntax not validated${v.error ? ` (${v.error})` : " (terraform/ansible not available)"}`
      : v.valid
        ? "syntax validated ✓"
        : `syntax check failed: ${v.error ?? "unknown error"}`;

  return (
    <div className="iac-diff-overlay" data-testid="iac-diff-overlay" role="dialog" aria-modal="true">
      <div className="iac-diff-modal">
        <div className="iac-diff-header">
          <span className="iac-diff-title">AI Diff Preview — {proposal.filename}</span>
          <span className="iac-diff-validation">{note}</span>
        </div>
        {proposal.explanation && <p className="iac-diff-explanation">{proposal.explanation}</p>}
        <div className="iac-diff-body">
          <DiffEditor
            original={original}
            modified={proposal.code}
            language={language}
            options={{ readOnly: true, originalEditable: false, renderSideBySide: true }}
            theme="vs-dark"
          />
        </div>
        <div className="iac-diff-actions">
          <button onClick={onReject} data-testid="iac-diff-reject" className="iac-diff-reject">
            Reject
          </button>
          <button onClick={onAccept} data-testid="iac-diff-accept" className="iac-diff-accept">
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/iac/IacDiffPreview.test.tsx`
Expected: PASS — all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/iac/IacDiffPreview.tsx src/components/iac/IacDiffPreview.test.tsx
git commit -m "feat(iac): IacDiffPreview Monaco diff overlay with accept/reject"
```

---

## Task 7: IacAiPanel (TDD)

The right-pane AI panel: a prompt textarea, Generate/Scaffold buttons (call the codegen RPC, store the proposal), and an Explain button (reuses `dispatchAskAi`). Tool selection derives from the active file's extension/language. Honest loading/unavailable/error states. The panel is a controlled component driven by props + store setters so it stays testable without Tauri.

**Files:**
- Create: `src/components/iac/IacAiPanel.tsx`
- Create: `src/components/iac/IacAiPanel.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `src/components/iac/IacAiPanel.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const iacGenerateTerraform = vi.fn();
const iacGenerateAnsible = vi.fn();
vi.mock("../../lib/tauri", () => ({
  iacGenerateTerraform: (...a: unknown[]) => iacGenerateTerraform(...a),
  iacGenerateAnsible: (...a: unknown[]) => iacGenerateAnsible(...a),
}));

const dispatchAskAi = vi.fn();
vi.mock("../editor/askAi", () => ({
  dispatchAskAi: (...a: unknown[]) => dispatchAskAi(...a),
}));

import { IacAiPanel } from "./IacAiPanel";

const baseProps = {
  tabId: "t1",
  rootPath: "/infra",
  filePath: "/infra/main.tf",
  language: "hcl",
  content: "# current",
  generating: false,
  error: null as string | null,
  onProposal: vi.fn(),
  onGenerating: vi.fn(),
  onError: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("IacAiPanel", () => {
  it("calls iacGenerateTerraform for a .tf file and forwards the proposal", async () => {
    iacGenerateTerraform.mockResolvedValue({
      tool: "terraform",
      code: 'resource "x" "y" {}',
      filename: "x.tf",
      explanation: "e",
      estimated_apply_time_seconds: 1,
      validation: { valid: true, skipped: false, error: null },
      unavailable: false,
    });
    const onProposal = vi.fn();
    render(<IacAiPanel {...baseProps} onProposal={onProposal} />);
    fireEvent.change(screen.getByTestId("iac-ai-prompt"), { target: { value: "make x" } });
    fireEvent.click(screen.getByTestId("iac-ai-generate"));
    await waitFor(() => expect(onProposal).toHaveBeenCalledOnce());
    expect(iacGenerateTerraform).toHaveBeenCalledWith("make x", "/infra", undefined, "# current");
    expect(onProposal).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'resource "x" "y" {}', filename: "x.tf" }),
    );
  });

  it("calls iacGenerateAnsible for a .yml file", async () => {
    iacGenerateAnsible.mockResolvedValue({
      tool: "ansible",
      code: "- hosts: all",
      filename: "p.yml",
      explanation: "e",
      estimated_apply_time_seconds: 0,
      validation: { valid: null, skipped: true, error: null },
      unavailable: false,
    });
    render(<IacAiPanel {...baseProps} filePath="/infra/play.yml" language="yaml" />);
    fireEvent.change(screen.getByTestId("iac-ai-prompt"), { target: { value: "noop" } });
    fireEvent.click(screen.getByTestId("iac-ai-generate"));
    await waitFor(() => expect(iacGenerateAnsible).toHaveBeenCalledOnce());
  });

  it("reports unavailable results as an error, not a proposal", async () => {
    iacGenerateTerraform.mockResolvedValue({
      tool: "terraform",
      code: "",
      filename: "",
      explanation: "",
      estimated_apply_time_seconds: 0,
      validation: { valid: null, skipped: true, error: null },
      unavailable: true,
    });
    const onProposal = vi.fn();
    const onError = vi.fn();
    render(<IacAiPanel {...baseProps} onProposal={onProposal} onError={onError} />);
    fireEvent.change(screen.getByTestId("iac-ai-prompt"), { target: { value: "make x" } });
    fireEvent.click(screen.getByTestId("iac-ai-generate"));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onProposal).not.toHaveBeenCalled();
  });

  it("surfaces a rejected RPC promise as an error", async () => {
    iacGenerateTerraform.mockRejectedValue(new Error("sidecar down"));
    const onError = vi.fn();
    render(<IacAiPanel {...baseProps} onError={onError} />);
    fireEvent.change(screen.getByTestId("iac-ai-prompt"), { target: { value: "make x" } });
    fireEvent.click(screen.getByTestId("iac-ai-generate"));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining("sidecar down")));
  });

  it("Explain dispatches an Ask-AI event and does not call codegen", () => {
    render(<IacAiPanel {...baseProps} />);
    fireEvent.click(screen.getByTestId("iac-ai-explain"));
    expect(dispatchAskAi).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: "t1", action: "explain", filePath: "/infra/main.tf" }),
    );
    expect(iacGenerateTerraform).not.toHaveBeenCalled();
  });

  it("disables Generate when there is no open file", () => {
    render(<IacAiPanel {...baseProps} filePath={null} />);
    expect(screen.getByTestId("iac-ai-generate")).toBeDisabled();
  });

  it("disables Generate while generating", () => {
    render(<IacAiPanel {...baseProps} generating />);
    expect(screen.getByTestId("iac-ai-generate")).toBeDisabled();
  });

  it("shows the error message when error prop is set", () => {
    render(<IacAiPanel {...baseProps} error="boom" />);
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/iac/IacAiPanel.test.tsx`
Expected: FAIL — module `./IacAiPanel` does not exist.

- [ ] **Step 3: Implement the component**

Create `src/components/iac/IacAiPanel.tsx`:

```typescript
import { useState } from "react";
import { iacGenerateAnsible, iacGenerateTerraform, type CodegenResult } from "../../lib/tauri";
import { dispatchAskAi } from "../editor/askAi";
import type { AiProposal } from "../../state/iacStudioStore";
import "./IacAiPanel.css";

/** Pick the codegen tool from the active file. Extension wins; language is a
 * fallback. Returns null when the file isn't a recognized IaC file. */
function detectTool(filePath: string | null, language: string): "terraform" | "ansible" | null {
  const path = (filePath ?? "").toLowerCase();
  if (path.endsWith(".tf") || path.endsWith(".hcl")) return "terraform";
  if (path.endsWith(".yml") || path.endsWith(".yaml")) return "ansible";
  if (language === "hcl" || language === "terraform") return "terraform";
  if (language === "yaml" || language === "ansible") return "ansible";
  return null;
}

export function IacAiPanel({
  tabId,
  rootPath,
  filePath,
  language,
  content,
  generating,
  error,
  onProposal,
  onGenerating,
  onError,
}: {
  tabId: string;
  rootPath: string | null;
  filePath: string | null;
  language: string;
  content: string;
  generating: boolean;
  error: string | null;
  onProposal: (p: AiProposal) => void;
  onGenerating: (g: boolean) => void;
  onError: (msg: string) => void;
}) {
  const [intent, setIntent] = useState("");
  const tool = detectTool(filePath, language);
  const canGenerate = !!filePath && !!tool && !!intent.trim() && !generating;

  async function runGenerate(extraIntent?: string) {
    const effectiveIntent = (extraIntent ?? intent).trim();
    if (!tool || !effectiveIntent) return;
    onGenerating(true);
    try {
      const gen = tool === "terraform" ? iacGenerateTerraform : iacGenerateAnsible;
      const result: CodegenResult = await gen(
        effectiveIntent,
        rootPath ?? ".",
        undefined,
        content,
      );
      if (result.unavailable || !result.code.trim()) {
        onError(
          "Generation unavailable — the AI model returned no usable code. " +
            "Check the LLM provider in Settings.",
        );
        return;
      }
      onProposal({
        code: result.code,
        filename: result.filename,
        explanation: result.explanation,
        validation: result.validation,
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  function runExplain() {
    dispatchAskAi({
      tabId,
      action: "explain",
      selection: content,
      language,
      filePath,
    });
  }

  return (
    <div className="iac-ai-panel" data-testid="iac-ai-panel">
      <div className="iac-ai-header">AI</div>
      <textarea
        className="iac-ai-prompt"
        data-testid="iac-ai-prompt"
        placeholder={
          tool
            ? `Describe the ${tool} change to generate…`
            : "Open a .tf or .yml file to generate code"
        }
        value={intent}
        onChange={(e) => setIntent(e.target.value)}
        rows={4}
      />
      <div className="iac-ai-actions">
        <button
          data-testid="iac-ai-generate"
          onClick={() => runGenerate()}
          disabled={!canGenerate}
          title="Generate code into a diff preview"
        >
          {generating ? "Generating…" : "Generate"}
        </button>
        <button
          data-testid="iac-ai-scaffold"
          onClick={() => runGenerate(`Scaffold a starter ${tool ?? "IaC"} resource: ${intent}`)}
          disabled={!canGenerate}
          title="Scaffold a starter resource"
        >
          Scaffold
        </button>
        <button
          data-testid="iac-ai-explain"
          onClick={runExplain}
          disabled={!filePath}
          title="Explain the current file (opens in the agent panel)"
        >
          Explain
        </button>
      </div>
      {error && (
        <div className="iac-ai-error" data-testid="iac-ai-error">
          {error}
        </div>
      )}
      <p className="iac-ai-hint">
        Accepting a diff only edits the buffer. Applying changes still requires
        approval.
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/iac/IacAiPanel.test.tsx`
Expected: PASS — all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/iac/IacAiPanel.tsx src/components/iac/IacAiPanel.test.tsx
git commit -m "feat(iac): IacAiPanel — generate/scaffold/explain side panel"
```

---

## Task 8: Wire panel + overlay into IacStudioTab

Mount `IacAiPanel` as the right pane and render `IacDiffPreview` as an overlay when a proposal exists. Accept writes the proposal into the buffer via `setContent` (marks dirty) and clears the proposal; Reject just clears it.

**Files:**
- Modify: `src/components/iac/IacStudioTab.tsx`
- Modify: `src/components/iac/IacStudioTab.test.tsx`

- [ ] **Step 1: Write the failing test**

In `src/components/iac/IacStudioTab.test.tsx`, add the AI-panel mock alongside the existing mocks (after the `MonacoEditor` mock block, around line 44):

```typescript
vi.mock("./IacAiPanel", () => ({
  IacAiPanel: () => <div data-testid="iac-ai-panel" />,
}));
```

Then add a test inside the existing `describe` block:

```typescript
it("renders the AI panel as the right pane", () => {
  render(<IacStudioTab tab={makeTab()} />);
  expect(screen.getByTestId("iac-ai-panel")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/iac/IacStudioTab.test.tsx`
Expected: FAIL — no element with testid `iac-ai-panel` (panel not mounted yet).

- [ ] **Step 3: Wire the panel and overlay**

In `src/components/iac/IacStudioTab.tsx`:

(a) Add imports (after line 10, the `IacProblemsPanel` import):

```typescript
import { IacAiPanel } from "./IacAiPanel";
import { IacDiffPreview } from "./IacDiffPreview";
```

(b) Add the new store setters to the existing selector block (after line 29, `setStudioDiagnostics`):

```typescript
  const setAiGenerating = useIacStudioStore((s) => s.setAiGenerating);
  const setAiProposal = useIacStudioStore((s) => s.setAiProposal);
  const clearAiProposal = useIacStudioStore((s) => s.clearAiProposal);
  const setAiError = useIacStudioStore((s) => s.setAiError);
```

(c) Add an accept handler near the other `useCallback`s (after `onJumpTo`, around line 113):

```typescript
  const onAcceptProposal = useCallback(() => {
    const proposal = state.ai.proposal;
    if (!proposal) return;
    setContent(tab.id, proposal.code); // marks dirty; user ⌘S to persist
    clearAiProposal(tab.id);
  }, [state.ai.proposal, tab.id, setContent, clearAiProposal]);
```

(d) Add the AI panel as the right pane inside `.iac-studio-main`, immediately after the `.iac-studio-content` closing `</div>` (after line 171, before the closing `</div>` of `.iac-studio-main` at 172):

```typescript
          <IacAiPanel
            tabId={tab.id}
            rootPath={state.root_path}
            filePath={state.file_path}
            language={state.language}
            content={state.content}
            generating={state.ai.generating}
            error={state.ai.error}
            onProposal={(p) => setAiProposal(tab.id, p)}
            onGenerating={(g) => setAiGenerating(tab.id, g)}
            onError={(msg) => setAiError(tab.id, msg)}
          />
```

(e) Render the diff overlay just before the final closing `</div>` of the component (after the `.iac-studio-status` block, around line 187):

```typescript
      {state.ai.proposal && (
        <IacDiffPreview
          original={state.content}
          proposal={state.ai.proposal}
          language={state.language}
          onAccept={onAcceptProposal}
          onReject={() => clearAiProposal(tab.id)}
        />
      )}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/iac/IacStudioTab.test.tsx`
Expected: PASS — including the new "renders the AI panel" test.

- [ ] **Step 5: Commit**

```bash
git add src/components/iac/IacStudioTab.tsx src/components/iac/IacStudioTab.test.tsx
git commit -m "feat(iac): wire IacAiPanel + IacDiffPreview into IacStudioTab"
```

---

## Task 9: Styles

Add CSS for the panel and overlay, matching the existing `IacStudioTab.css` dark theme.

**Files:**
- Create: `src/components/iac/IacAiPanel.css`

- [ ] **Step 1: Create the stylesheet**

Create `src/components/iac/IacAiPanel.css`:

```css
.iac-ai-panel {
  display: flex;
  flex-direction: column;
  width: 280px;
  min-width: 220px;
  border-left: 1px solid var(--border, #2a2a2a);
  background: var(--panel-bg, #1e1e1e);
  padding: 8px;
  gap: 8px;
  overflow-y: auto;
}
.iac-ai-header {
  font-weight: 600;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted, #9aa0a6);
}
.iac-ai-prompt {
  resize: vertical;
  font-family: inherit;
  font-size: 13px;
  padding: 6px;
  background: var(--input-bg, #252526);
  color: var(--text, #e8e8e8);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 4px;
}
.iac-ai-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.iac-ai-actions button {
  flex: 1 1 auto;
  padding: 6px 8px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 4px;
  background: var(--button-bg, #2d2d2d);
  color: var(--text, #e8e8e8);
}
.iac-ai-actions button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.iac-ai-error {
  color: var(--error, #f48771);
  font-size: 12px;
  white-space: pre-wrap;
}
.iac-ai-hint {
  font-size: 11px;
  color: var(--text-muted, #9aa0a6);
  margin: 0;
}

/* Diff overlay */
.iac-diff-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.iac-diff-modal {
  display: flex;
  flex-direction: column;
  width: 80vw;
  height: 75vh;
  background: var(--panel-bg, #1e1e1e);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 6px;
  overflow: hidden;
}
.iac-diff-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border, #2a2a2a);
}
.iac-diff-title {
  font-weight: 600;
}
.iac-diff-validation {
  font-size: 12px;
  color: var(--text-muted, #9aa0a6);
}
.iac-diff-explanation {
  margin: 0;
  padding: 6px 12px;
  font-size: 13px;
  color: var(--text-muted, #cfcfcf);
}
.iac-diff-body {
  flex: 1;
  min-height: 0;
}
.iac-diff-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--border, #2a2a2a);
}
.iac-diff-actions button {
  padding: 6px 16px;
  border-radius: 4px;
  cursor: pointer;
  border: 1px solid var(--border, #2a2a2a);
}
.iac-diff-accept {
  background: var(--accent, #0e639c);
  color: #fff;
}
.iac-diff-reject {
  background: var(--button-bg, #2d2d2d);
  color: var(--text, #e8e8e8);
}
```

- [ ] **Step 2: Verify the build still typechecks/bundles**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/iac/IacAiPanel.css
git commit -m "style(iac): IaC Studio AI panel + diff overlay styles"
```

---

## Task 10: Full regression + manual E2E verification

- [ ] **Step 1: Run the full frontend suite**

Run: `npx vitest run`
Expected: PASS — all suites green (previous baseline was 1198/1198; expect that plus the new tests).

- [ ] **Step 2: Run the full sidecar suite**

Run: `cd sidecar && .venv/bin/python -m pytest -q`
Expected: PASS — except the one pre-existing `test_react_loop.py` collection error documented on `main` (NOT a regression — confirm it's the same one).

- [ ] **Step 3: Rust check**

Run: `cd src-tauri && cargo check`
Expected: PASS.

- [ ] **Step 4: Manual E2E (per verify-before-claiming-done — do NOT claim done without this)**

Restore worktree symlinks (see Pre-flight), then:

```bash
./run.sh
```

Then in the app:
1. Open IaC Studio (⌘⇧E). Confirm the AI panel appears as the right pane.
2. Open a `.tf` file from the tree.
3. Type an intent (e.g. "create an aws_s3_bucket named logs") → click **Generate**.
4. Confirm the Monaco diff overlay appears (current buffer left, proposed right) with the explanation + a validation note.
5. Click **Accept** → confirm the editor buffer updates and the dirty dot (●) appears.
6. ⌘S → confirm the file on disk changed (`cat` the file outside the app).
7. Re-generate and click **Reject** → confirm the buffer is unchanged.
8. Verify honesty: with `terraform` off PATH (or an uninitialized dir), the overlay shows "syntax not validated", never a fake "valid".
9. Confirm the panel hint reminds that Accept only edits the buffer (apply still needs approval). Confirm there is NO apply button in the panel.

- [ ] **Step 5: Update the project memory**

Update `project_iac_studio.md`: mark Phase C complete (or code-complete pending merge), note the new RPC methods, files, and that no migration was used. Add a one-line pointer in `MEMORY.md` if a new memory file is created.

---

## Self-Review Notes

- **Spec coverage:** AI side panel (Task 7), generate-into-file/scaffold via codegen RPC (Tasks 2–4, 7), diff against buffer accept/reject (Tasks 6, 8), Settings-page LLM (Task 1 + RPC), apply routes through `iac_apply`/no bypass (panel has no apply button — Task 7 hint + Task 8 wiring; Accept only edits buffer), honesty on `unavailable`/skipped validation (Tasks 6, 7), Explain reuses ⌘L path (Task 7). ✅ All spec sections mapped.
- **Type consistency:** `AiProposal` (store) is the single proposal type used by `IacDiffPreview` and `IacAiPanel.onProposal`; `CodegenResult` (tauri.ts) is mapped into `AiProposal` inside the panel. `validation` shape `{valid, skipped, error}` is identical across Python, `CodegenResult`, and `AiProposal`. Setter names (`setAiGenerating`/`setAiProposal`/`clearAiProposal`/`setAiError`) are consistent across store, store tests, and tab wiring.
- **No migration:** transient `ai` slice only; next free migration remains V0051.
```
