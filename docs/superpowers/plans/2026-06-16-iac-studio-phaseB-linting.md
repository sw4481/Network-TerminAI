# IaC Studio — Phase B (Linting / Diagnostics) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add live, honest lint diagnostics to the IaC Studio — Terraform (`fmt` syntax + `validate` semantics) and Ansible (`ansible-lint` or `--syntax-check` fallback) — surfaced as Monaco squigglies and a collapsible bottom "Problems" panel, debounced on change and run on save.

**Architecture:** A new sidecar RPC `iac.lint_file` runs the real CLI linters and returns structured `{ diagnostics[], linters[] }`. A thin Rust Tauri command `iac_lint_file` forwards to the sidecar via the existing `AgentBridge`. The frontend debounces lint requests, stores results in `iacStudioStore`, injects them as Monaco markers via `setModelMarkers`, and renders them in a new `IacProblemsPanel`. Every linter that can't run reports an explicit "unavailable / skipped" reason — there is never a faked "clean" result. Editing works even if the sidecar is down (linting just stays empty/unavailable).

**Tech Stack:** Python sidecar (subprocess + `shutil.which`), Rust/Tauri (`AgentBridge.call`), React + Zustand + Monaco, vitest + pytest.

---

## Background — verified facts (read before starting)

These were verified live on the dev machine on 2026-06-16; do not re-derive:

- `terraform` **is** installed (v1.15.6). `terraform fmt -` reads HCL from **stdin**, exits non-zero on parse errors, and prints `on <stdin> line N` in stderr. It needs no `terraform init` and no providers — this is the always-available **syntax** check.
- `terraform validate -json` emits structured `{ valid, diagnostics:[{severity, summary, detail, range:{start:{line,column}}}] }` — but in an **uninitialized** directory it emits a **false** `"Missing required provider"` error. So `validate` must only run when the file's directory contains a `.terraform/` dir (i.e. has been `terraform init`'d). Otherwise report it skipped-with-reason, never surface the false error.
- `ansible-playbook` **is** installed; `ansible-lint` is **not**. So the Ansible path must degrade: prefer `ansible-lint` (rich), fall back to `ansible-playbook -i localhost, --syntax-check` (already implemented in `iac_codegen.validate_ansible_syntax`), and if neither exists report "unavailable".

### Reused assets (do NOT rebuild)

| Asset | Path | Used for |
|-------|------|----------|
| Binary-detection + subprocess pattern | `sidecar/src/ccie_sidecar/agents/iac_codegen.py:130` (`validate_terraform_syntax`), `:238` (`validate_ansible_syntax`) | Mirror the `shutil.which` + `subprocess.run(timeout=30)` + never-raise pattern |
| Sidecar RPC dispatch | `sidecar/src/ccie_sidecar/server.py:545` (`iac.analyze_drift` branch) | Pattern for adding the `iac.lint_file` branch |
| Rust→sidecar bridge | `src-tauri/src/commands/mod.rs:4218` (`iac_classify_blast_radius`) | Pattern for a Tauri command that forwards to a sidecar RPC |
| Command registration | `src-tauri/src/lib.rs:603` (`iac_classify_blast_radius`) | Where to register the new `iac_lint_file` command |
| Frontend invoke wrapper | `src/lib/tauri.ts:1750` (`iacStudioReadFile`) | Pattern for `iacLintFile` |
| MonacoEditor `onEditorReady(editor, monaco)` | `src/components/editor/MonacoEditor.tsx:36,135` | Capture `monaco` + `editor` to call `setModelMarkers` |
| Problems-panel precedent | `src/features/troubleshoot/PlaybookEditor.tsx:498` + `PlaybookEditor.css:176` | Mirror the collapsible diagnostics list + CSS |
| Debounce hook | `src/hooks/useDebounce.ts` | Debounce lint-on-change |
| Studio tab + store | `src/components/iac/IacStudioTab.tsx`, `src/state/iacStudioStore.ts`, `IacStudioTab.css` | Where diagnostics state, markers, and the panel get wired |

### Diagnostic schema (single source of truth — used by every layer)

```jsonc
{
  "diagnostics": [
    {
      "line": 2,            // 1-based; 1 when unknown
      "column": 1,          // 1-based; 1 when unknown
      "severity": "error",  // "error" | "warning" | "info"
      "message": "Invalid expression: Expected the start of an expression…",
      "source": "terraform fmt"  // which linter produced it
    }
  ],
  "linters": [
    { "name": "terraform fmt",      "ran": true,  "available": true,  "reason": null },
    { "name": "terraform validate", "ran": false, "available": true,  "reason": "not initialized — run `terraform init` for semantic checks" },
    { "name": "ansible-lint",       "ran": false, "available": false, "reason": "ansible-lint not on PATH" }
  ]
}
```

`linters[]` is what makes the Problems panel honest: it always says what ran and what was skipped and why, so an empty `diagnostics[]` never reads as a guaranteed "clean".

---

## File Structure

**New files:**
- `sidecar/src/ccie_sidecar/agents/iac_lint.py` — the linter: dispatch by language, run CLIs, normalize to the schema. One responsibility: turn a file's (path, content, language) into `{diagnostics, linters}`.
- `sidecar/tests/test_iac_lint.py` — pytest for parsing + degradation.
- `src/components/iac/IacProblemsPanel.tsx` — collapsible diagnostics list (presentational).
- `src/components/iac/IacProblemsPanel.test.tsx` — vitest for the panel.
- `src/hooks/useIacLint.ts` — debounced lint runner hook (calls the invoke wrapper, returns `{diagnostics, linters, linting}`).
- `src/hooks/useIacLint.test.ts` — vitest for debounce + invoke wiring.

**Modified files:**
- `sidecar/src/ccie_sidecar/server.py` — add the `iac.lint_file` RPC branch.
- `src-tauri/src/commands/mod.rs` — add the `iac_lint_file` Tauri command.
- `src-tauri/src/lib.rs` — register `iac_lint_file`.
- `src/lib/tauri.ts` — add `LintDiagnostic`/`LintResult` types + `iacLintFile` wrapper.
- `src/state/iacStudioStore.ts` — add `diagnostics` + `linters` to state + a `setDiagnostics` action.
- `src/components/iac/IacStudioTab.tsx` — wire the hook, inject Monaco markers, render the panel.
- `src/components/iac/IacStudioTab.css` — Problems-panel styles.

---

## Task 1: Sidecar linter module — Terraform path

**Files:**
- Create: `sidecar/src/ccie_sidecar/agents/iac_lint.py`
- Test: `sidecar/tests/test_iac_lint.py`

- [ ] **Step 1: Write the failing test**

Create `sidecar/tests/test_iac_lint.py`:

```python
from ccie_sidecar.agents import iac_lint


def test_terraform_fmt_reports_syntax_error_with_line():
    # Malformed HCL: `ami =` with no value is a parse error `terraform fmt` catches.
    bad = 'resource "aws_instance" "x" {\n  ami = \n}\n'
    result = iac_lint.lint_file(file_path="main.tf", content=bad, language="hcl")
    diags = result["diagnostics"]
    assert any(d["severity"] == "error" for d in diags), result
    # The fmt parse error points at line 2.
    assert any(d["line"] == 2 for d in diags), diags
    fmt = next(l for l in result["linters"] if l["name"] == "terraform fmt")
    assert fmt["ran"] is True and fmt["available"] is True


def test_terraform_valid_hcl_is_clean_via_fmt():
    good = 'locals {\n  x = 1\n}\n'
    result = iac_lint.lint_file(file_path="main.tf", content=good, language="hcl")
    # No syntax errors from fmt on well-formed HCL.
    assert [d for d in result["diagnostics"] if d["source"] == "terraform fmt"] == []


def test_terraform_validate_skipped_when_not_initialized(tmp_path):
    # A real path whose directory has no `.terraform/` → validate must be skipped
    # with a reason, NOT run (running it would emit a false provider error).
    f = tmp_path / "main.tf"
    f.write_text('locals {\n  x = 1\n}\n')
    result = iac_lint.lint_file(file_path=str(f), content=f.read_text(), language="hcl")
    validate = next(l for l in result["linters"] if l["name"] == "terraform validate")
    assert validate["ran"] is False
    assert validate["reason"] and "init" in validate["reason"].lower()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd sidecar && python -m pytest tests/test_iac_lint.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'ccie_sidecar.agents.iac_lint'`.

- [ ] **Step 3: Write the minimal implementation (Terraform only)**

Create `sidecar/src/ccie_sidecar/agents/iac_lint.py`:

```python
"""IaC Studio Phase B — file linting.

Turns a single file's (path, content, language) into structured diagnostics by
running the real CLI linters. Honest by construction: every linter reports
whether it ran and, if not, why — an empty diagnostics list is never a faked
"clean". Mirrors the binary-detection + never-raise pattern in iac_codegen.py.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from typing import Any

# `on <stdin> line N` appears in `terraform fmt -` parse errors.
_FMT_LINE_RE = re.compile(r"on <stdin> line (\d+)")
# The human-readable summary follows `Error:` on its own line.
_FMT_ERROR_RE = re.compile(r"Error:\s*(.+)")


def _linter(name: str, *, ran: bool, available: bool, reason: str | None = None) -> dict[str, Any]:
    return {"name": name, "ran": ran, "available": available, "reason": reason}


def _terraform_fmt(content: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """HCL syntax check via `terraform fmt -` (stdin; no init/providers needed)."""
    if shutil.which("terraform") is None:
        return [], _linter("terraform fmt", ran=False, available=False,
                           reason="terraform not on PATH")
    try:
        proc = subprocess.run(
            ["terraform", "fmt", "-"],
            input=content, capture_output=True, text=True, timeout=30,
        )
    except Exception as e:  # timeout / OSError
        return [], _linter("terraform fmt", ran=False, available=True, reason=str(e))
    if proc.returncode == 0:
        return [], _linter("terraform fmt", ran=True, available=True)
    # Parse errors: `terraform fmt` reports one parse error block. Extract the
    # line from `on <stdin> line N` and the message from the `Error:` line.
    text = proc.stderr or proc.stdout
    line_m = _FMT_LINE_RE.search(text)
    err_m = _FMT_ERROR_RE.search(text)
    diag = {
        "line": int(line_m.group(1)) if line_m else 1,
        "column": 1,
        "severity": "error",
        "message": (err_m.group(1).strip() if err_m else "HCL parse error").strip(),
        "source": "terraform fmt",
    }
    return [diag], _linter("terraform fmt", ran=True, available=True)


def _terraform_validate(file_path: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Semantic check via `terraform validate -json`, ONLY if initialized.

    In an uninitialized dir, `validate` emits a false "Missing required provider"
    error, so we refuse to run it unless `.terraform/` exists in the file's dir.
    """
    if shutil.which("terraform") is None:
        return [], _linter("terraform validate", ran=False, available=False,
                           reason="terraform not on PATH")
    work_dir = os.path.dirname(os.path.abspath(file_path)) if file_path else ""
    if not work_dir or not os.path.isdir(os.path.join(work_dir, ".terraform")):
        return [], _linter("terraform validate", ran=False, available=True,
                           reason="not initialized — run `terraform init` for semantic checks")
    try:
        proc = subprocess.run(
            ["terraform", "validate", "-json"],
            cwd=work_dir, capture_output=True, text=True, timeout=60,
        )
        import json
        data = json.loads(proc.stdout or "{}")
    except Exception as e:
        return [], _linter("terraform validate", ran=False, available=True, reason=str(e))
    diags: list[dict[str, Any]] = []
    for d in data.get("diagnostics", []):
        rng = (d.get("range") or {}).get("start") or {}
        diags.append({
            "line": int(rng.get("line", 1)),
            "column": int(rng.get("column", 1)),
            "severity": "error" if d.get("severity") == "error" else "warning",
            "message": d.get("summary", "") + (
                f" — {d.get('detail')}" if d.get("detail") else ""
            ),
            "source": "terraform validate",
        })
    return diags, _linter("terraform validate", ran=True, available=True)


def lint_file(file_path: str, content: str, language: str) -> dict[str, Any]:
    """Lint one file. Never raises. Returns {diagnostics, linters}."""
    diagnostics: list[dict[str, Any]] = []
    linters: list[dict[str, Any]] = []
    lang = (language or "").lower()

    if lang in ("hcl", "terraform") or file_path.endswith((".tf", ".hcl")):
        fmt_diags, fmt_linter = _terraform_fmt(content)
        diagnostics.extend(fmt_diags)
        linters.append(fmt_linter)
        val_diags, val_linter = _terraform_validate(file_path)
        diagnostics.extend(val_diags)
        linters.append(val_linter)

    return {"diagnostics": diagnostics, "linters": linters}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd sidecar && python -m pytest tests/test_iac_lint.py -v`
Expected: 3 passed (requires `terraform` on PATH, which is verified present).

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/ccie_sidecar/agents/iac_lint.py sidecar/tests/test_iac_lint.py
git commit -m "feat(iac): sidecar terraform linter for IaC Studio Phase B"
```

---

## Task 2: Sidecar linter module — Ansible path + degradation

**Files:**
- Modify: `sidecar/src/ccie_sidecar/agents/iac_lint.py`
- Test: `sidecar/tests/test_iac_lint.py`

- [ ] **Step 1: Write the failing test**

Append to `sidecar/tests/test_iac_lint.py`:

```python
def test_ansible_lint_unavailable_is_honest(monkeypatch):
    # When neither ansible-lint nor ansible-playbook exist, the YAML path must
    # report unavailable — NOT silently return a clean result.
    monkeypatch.setattr(iac_lint.shutil, "which", lambda _name: None)
    play = "- hosts: all\n  tasks:\n    - ping:\n"
    result = iac_lint.lint_file(file_path="play.yml", content=play, language="yaml")
    names = {l["name"]: l for l in result["linters"]}
    # At least one ansible linter entry, all marked unavailable.
    ansible_entries = [l for l in result["linters"] if "ansible" in l["name"]]
    assert ansible_entries, result
    assert all(l["available"] is False for l in ansible_entries)


def test_ansible_syntax_fallback_runs_when_lint_absent(monkeypatch):
    # ansible-lint absent but ansible-playbook present → fallback runs.
    real_which = shutil.which

    def fake_which(name):
        if name == "ansible-lint":
            return None
        return real_which(name)

    import shutil
    monkeypatch.setattr(iac_lint.shutil, "which", fake_which)
    play = "- hosts: all\n  tasks:\n    - ansible.builtin.ping:\n"
    result = iac_lint.lint_file(file_path="play.yml", content=play, language="yaml")
    fallback = next(
        (l for l in result["linters"] if l["name"] == "ansible-playbook --syntax-check"),
        None,
    )
    assert fallback is not None and fallback["ran"] is True
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd sidecar && python -m pytest tests/test_iac_lint.py::test_ansible_lint_unavailable_is_honest -v`
Expected: FAIL (`ansible_entries` is empty — no YAML handling yet).

- [ ] **Step 3: Add the Ansible implementation**

In `sidecar/src/ccie_sidecar/agents/iac_lint.py`, add these two functions above `lint_file`:

```python
# ansible-lint emits `path:line:col: [rule] message` lines on stdout.
_ALINT_RE = re.compile(r"^[^:]*:(\d+):(?:(\d+):)?\s*(.*)$")


def _ansible_lint(content: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Rich Ansible linting via `ansible-lint` (parseable text output)."""
    if shutil.which("ansible-lint") is None:
        return [], _linter("ansible-lint", ran=False, available=False,
                           reason="ansible-lint not on PATH")
    try:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".yml", delete=True) as fh:
            fh.write(content)
            fh.flush()
            proc = subprocess.run(
                ["ansible-lint", "--parseable", "--nocolor", fh.name],
                capture_output=True, text=True, timeout=60,
            )
    except Exception as e:
        return [], _linter("ansible-lint", ran=False, available=True, reason=str(e))
    diags: list[dict[str, Any]] = []
    for raw in (proc.stdout or "").splitlines():
        m = _ALINT_RE.match(raw.strip())
        if not m:
            continue
        diags.append({
            "line": int(m.group(1)),
            "column": int(m.group(2)) if m.group(2) else 1,
            "severity": "warning",
            "message": m.group(3).strip() or "ansible-lint finding",
            "source": "ansible-lint",
        })
    return diags, _linter("ansible-lint", ran=True, available=True)


def _ansible_syntax_check(content: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Fallback: `ansible-playbook --syntax-check` (no line numbers; whole-file)."""
    name = "ansible-playbook --syntax-check"
    if shutil.which("ansible-playbook") is None:
        return [], _linter(name, ran=False, available=False,
                           reason="ansible-playbook not on PATH")
    try:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".yml", delete=True) as fh:
            fh.write(content)
            fh.flush()
            proc = subprocess.run(
                ["ansible-playbook", "-i", "localhost,", "--syntax-check", fh.name],
                capture_output=True, text=True, timeout=30,
            )
    except Exception as e:
        return [], _linter(name, ran=False, available=True, reason=str(e))
    if proc.returncode == 0:
        return [], _linter(name, ran=True, available=True)
    msg = (proc.stderr or proc.stdout).strip().splitlines()
    return [{
        "line": 1, "column": 1, "severity": "error",
        "message": msg[-1] if msg else "syntax-check failed",
        "source": name,
    }], _linter(name, ran=True, available=True)
```

Then extend `lint_file`'s body (after the HCL block, before the `return`):

```python
    elif lang in ("yaml", "ansible") or file_path.endswith((".yml", ".yaml")):
        if shutil.which("ansible-lint") is not None:
            a_diags, a_linter = _ansible_lint(content)
            diagnostics.extend(a_diags)
            linters.append(a_linter)
        else:
            # Record that the rich linter is unavailable, then try the fallback.
            linters.append(_linter("ansible-lint", ran=False, available=False,
                                    reason="ansible-lint not on PATH"))
            s_diags, s_linter = _ansible_syntax_check(content)
            diagnostics.extend(s_diags)
            linters.append(s_linter)
```

Change the `if lang in ("hcl"...)` to remain an `if` (the Ansible block is `elif`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd sidecar && python -m pytest tests/test_iac_lint.py -v`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/ccie_sidecar/agents/iac_lint.py sidecar/tests/test_iac_lint.py
git commit -m "feat(iac): ansible lint + syntax-check fallback with honest unavailable states"
```

---

## Task 3: Wire `iac.lint_file` RPC into the sidecar server

**Files:**
- Modify: `sidecar/src/ccie_sidecar/server.py` (after the `iac.analyze_drift` branch, ~line 563)
- Test: `sidecar/tests/test_iac_lint.py`

- [ ] **Step 1: Write the failing test**

Append to `sidecar/tests/test_iac_lint.py`:

```python
from ccie_sidecar import server as sidecar_server


def test_rpc_iac_lint_file_dispatch():
    req = {
        "id": "t1",
        "method": "iac.lint_file",
        "params": {
            "file_path": "main.tf",
            "content": 'locals {\n  x = 1\n}\n',
            "language": "hcl",
        },
    }
    resp = sidecar_server.handle_request(req)
    assert resp["id"] == "t1"
    assert resp["type"] == "done"
    assert "diagnostics" in resp["result"]
    assert "linters" in resp["result"]


def test_rpc_iac_lint_file_requires_params():
    resp = sidecar_server.handle_request(
        {"id": "t2", "method": "iac.lint_file", "params": {}}
    )
    assert resp["type"] == "error"
```

> Note: confirm the dispatch entrypoint's real name first — `grep -n "def handle_request\|def dispatch" sidecar/src/ccie_sidecar/server.py`. If it differs, adjust the call above and the import. If `handle_request` is async, wrap the calls in `asyncio.run(...)`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd sidecar && python -m pytest tests/test_iac_lint.py::test_rpc_iac_lint_file_dispatch -v`
Expected: FAIL — the dispatcher returns an "unknown method" error for `iac.lint_file`.

- [ ] **Step 3: Add the RPC branch**

In `sidecar/src/ccie_sidecar/server.py`, immediately after the `iac.analyze_drift` branch (line 563), add:

```python
    elif method == "iac.lint_file":
        # IaC Studio Phase B — lint a single buffer with the real CLI linters
        # (terraform fmt/validate, ansible-lint/--syntax-check). The linter is
        # honest: every linter reports whether it ran and why not. Never fatal.
        file_path = params.get("file_path")
        content = params.get("content")
        language = params.get("language", "")
        if not isinstance(file_path, str) or content is None:
            return {
                "id": req_id,
                "type": "error",
                "message": "iac.lint_file requires 'file_path' (str) and 'content'",
            }
        try:
            from ccie_sidecar.agents import iac_lint

            result = iac_lint.lint_file(
                file_path=file_path, content=content, language=language
            )
            return {"id": req_id, "type": "done", "result": result}
        except Exception as e:  # pragma: no cover — lint_file already guards
            return {"id": req_id, "type": "error", "message": str(e)}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd sidecar && python -m pytest tests/test_iac_lint.py -v`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/ccie_sidecar/server.py sidecar/tests/test_iac_lint.py
git commit -m "feat(iac): expose iac.lint_file sidecar RPC"
```

---

## Task 4: Rust Tauri command `iac_lint_file`

**Files:**
- Modify: `src-tauri/src/commands/mod.rs` (near `iac_classify_blast_radius`, ~line 4218)
- Modify: `src-tauri/src/lib.rs:603` (registration)

- [ ] **Step 1: Add the command**

In `src-tauri/src/commands/mod.rs`, after `iac_classify_blast_radius` (ends ~line 4243), add:

```rust
/// IaC Studio Phase B — lint a single buffer via the sidecar's `iac.lint_file`
/// RPC. Forwards the file path, content, and language; returns the structured
/// `{ diagnostics, linters }` payload verbatim. Editing never depends on this —
/// if the sidecar is down the caller simply gets an Err and shows no diagnostics.
#[tauri::command]
pub async fn iac_lint_file(
    state: State<'_, AppState>,
    file_path: String,
    content: String,
    language: String,
) -> Result<serde_json::Value, String> {
    let params = serde_json::json!({
        "file_path": file_path,
        "content": content,
        "language": language,
    });
    let resp = state
        .agent
        .call("iac.lint_file", params)
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(result),
        crate::agent_bridge::AgentResponse::Error { message } => Err(message),
        _ => Err("unexpected response type".to_string()),
    }
}
```

> Verify `State`, `AppState`, and `serde_json` are already imported at the top of `mod.rs` (they are — `iac_classify_blast_radius` uses all three). Match the exact `AgentResponse` import path used by that neighbor.

- [ ] **Step 2: Register the command**

In `src-tauri/src/lib.rs`, after line 603 (`commands::iac_classify_blast_radius,`), add:

```rust
            commands::iac_lint_file,
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: `Finished` with no errors. (If a fresh worktree, symlink `sidecar/.venv` and `sidecar/dist/python` from the main checkout first — see the Phase A worktree gotcha.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(iac): iac_lint_file Tauri command forwarding to sidecar"
```

---

## Task 5: Frontend invoke wrapper + types

**Files:**
- Modify: `src/lib/tauri.ts` (near `iacStudioWriteFile`, ~line 1759)

- [ ] **Step 1: Add types + wrapper**

In `src/lib/tauri.ts`, after the `iacStudioWriteFile` export (line 1759), add:

```typescript
/** One lint finding from the IaC Studio linter (mirrors sidecar iac_lint schema). */
export type LintDiagnostic = {
  line: number;
  column: number;
  severity: "error" | "warning" | "info";
  message: string;
  source: string;
};

/** Per-linter run status — surfaces honest "skipped/unavailable + reason". */
export type LinterStatus = {
  name: string;
  ran: boolean;
  available: boolean;
  reason: string | null;
};

export type LintResult = {
  diagnostics: LintDiagnostic[];
  linters: LinterStatus[];
};

/** Lint a buffer (terraform/ansible) via the sidecar. Throws if sidecar down. */
export const iacLintFile = (filePath: string, content: string, language: string) =>
  invoke<LintResult>("iac_lint_file", { filePath, content, language });
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no new errors referencing `tauri.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/tauri.ts
git commit -m "feat(iac): iacLintFile invoke wrapper + lint result types"
```

---

## Task 6: Store — diagnostics + linters state

**Files:**
- Modify: `src/state/iacStudioStore.ts`
- Test: `src/state/iacStudioStore.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/state/iacStudioStore.test.ts` (inside the existing top-level describe, or add a new one):

```typescript
import { useIacStudioStore } from "./iacStudioStore";

describe("iacStudioStore diagnostics", () => {
  it("stores diagnostics and linters per tab", () => {
    const { ensure, setDiagnostics } = useIacStudioStore.getState();
    ensure("tabD", "/ws");
    setDiagnostics("tabD", {
      diagnostics: [
        { line: 2, column: 1, severity: "error", message: "boom", source: "terraform fmt" },
      ],
      linters: [{ name: "terraform fmt", ran: true, available: true, reason: null }],
    });
    const s = useIacStudioStore.getState().tabs["tabD"];
    expect(s.diagnostics).toHaveLength(1);
    expect(s.diagnostics[0].message).toBe("boom");
    expect(s.linters[0].name).toBe("terraform fmt");
  });

  it("defaults diagnostics and linters to empty arrays", () => {
    const { ensure } = useIacStudioStore.getState();
    const seeded = ensure("tabE", "/ws");
    expect(seeded.diagnostics).toEqual([]);
    expect(seeded.linters).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/state/iacStudioStore.test.ts`
Expected: FAIL — `setDiagnostics` is not a function / `diagnostics` undefined.

- [ ] **Step 3: Extend the store**

In `src/state/iacStudioStore.ts`:

Add the import at the top:

```typescript
import type { LintDiagnostic, LinterStatus } from "../lib/tauri";
```

Add to `IacStudioTabState` (after `error: string | null;`):

```typescript
  diagnostics: LintDiagnostic[];
  linters: LinterStatus[];
```

Add to the `IacStudioStore` interface (after `setRoot`):

```typescript
  setDiagnostics: (tabId: string, result: { diagnostics: LintDiagnostic[]; linters: LinterStatus[] }) => void;
```

In `freshIacStudioState`, add to the returned object (after `error: null,`):

```typescript
    diagnostics: [],
    linters: [],
```

Add the action implementation (after `setRoot`):

```typescript
  setDiagnostics: (tabId, result) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return {
        tabs: {
          ...s.tabs,
          [tabId]: { ...cur, diagnostics: result.diagnostics, linters: result.linters },
        },
      };
    }),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/state/iacStudioStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/iacStudioStore.ts src/state/iacStudioStore.test.ts
git commit -m "feat(iac): diagnostics + linters state in iacStudioStore"
```

---

## Task 7: `useIacLint` debounced hook

**Files:**
- Create: `src/hooks/useIacLint.ts`
- Test: `src/hooks/useIacLint.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/hooks/useIacLint.test.ts`:

```typescript
import { renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useIacLint } from "./useIacLint";
import * as tauri from "../lib/tauri";

describe("useIacLint", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("debounces and calls iacLintFile, returning diagnostics", async () => {
    const spy = vi.spyOn(tauri, "iacLintFile").mockResolvedValue({
      diagnostics: [
        { line: 1, column: 1, severity: "error", message: "x", source: "terraform fmt" },
      ],
      linters: [{ name: "terraform fmt", ran: true, available: true, reason: null }],
    });

    const { result } = renderHook(() =>
      useIacLint({ filePath: "main.tf", content: "locals {}", language: "hcl", debounceMs: 10 }),
    );

    await waitFor(() => expect(result.current.diagnostics).toHaveLength(1));
    expect(spy).toHaveBeenCalledWith("main.tf", "locals {}", "hcl");
  });

  it("does not lint when filePath is null", async () => {
    const spy = vi.spyOn(tauri, "iacLintFile").mockResolvedValue({ diagnostics: [], linters: [] });
    renderHook(() =>
      useIacLint({ filePath: null, content: "", language: "hcl", debounceMs: 10 }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
  });

  it("swallows lint errors (sidecar down) and reports unavailable", async () => {
    vi.spyOn(tauri, "iacLintFile").mockRejectedValue(new Error("sidecar down"));
    const { result } = renderHook(() =>
      useIacLint({ filePath: "main.tf", content: "x", language: "hcl", debounceMs: 10 }),
    );
    await waitFor(() => expect(result.current.error).toBe("sidecar down"));
    expect(result.current.diagnostics).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/hooks/useIacLint.test.ts`
Expected: FAIL — `Cannot find module './useIacLint'`.

- [ ] **Step 3: Implement the hook**

Create `src/hooks/useIacLint.ts`:

```typescript
import { useEffect, useRef, useState } from "react";
import { iacLintFile, type LintDiagnostic, type LinterStatus } from "../lib/tauri";

type UseIacLintArgs = {
  filePath: string | null;
  content: string;
  language: string;
  debounceMs?: number;
};

type UseIacLintResult = {
  diagnostics: LintDiagnostic[];
  linters: LinterStatus[];
  linting: boolean;
  error: string | null;
};

/**
 * Debounced linting for the IaC Studio. Re-lints whenever content/file/language
 * change, after `debounceMs` of quiet. Linting is best-effort: a sidecar error
 * clears diagnostics and surfaces `error` (the editor keeps working regardless).
 */
export function useIacLint({
  filePath,
  content,
  language,
  debounceMs = 600,
}: UseIacLintArgs): UseIacLintResult {
  const [diagnostics, setDiagnostics] = useState<LintDiagnostic[]>([]);
  const [linters, setLinters] = useState<LinterStatus[]>([]);
  const [linting, setLinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards against a stale in-flight request overwriting a newer result.
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (!filePath) {
      setDiagnostics([]);
      setLinters([]);
      return;
    }
    const myReq = ++reqIdRef.current;
    const handle = window.setTimeout(async () => {
      setLinting(true);
      try {
        const result = await iacLintFile(filePath, content, language);
        if (reqIdRef.current !== myReq) return; // superseded
        setDiagnostics(result.diagnostics);
        setLinters(result.linters);
        setError(null);
      } catch (e) {
        if (reqIdRef.current !== myReq) return;
        setDiagnostics([]);
        setLinters([]);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (reqIdRef.current === myReq) setLinting(false);
      }
    }, debounceMs);
    return () => window.clearTimeout(handle);
  }, [filePath, content, language, debounceMs]);

  return { diagnostics, linters, linting, error };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/hooks/useIacLint.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useIacLint.ts src/hooks/useIacLint.test.ts
git commit -m "feat(iac): useIacLint debounced linting hook"
```

---

## Task 8: `IacProblemsPanel` component

**Files:**
- Create: `src/components/iac/IacProblemsPanel.tsx`
- Test: `src/components/iac/IacProblemsPanel.test.tsx`
- Modify: `src/components/iac/IacStudioTab.css`

- [ ] **Step 1: Write the failing test**

Create `src/components/iac/IacProblemsPanel.test.tsx`:

```typescript
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { IacProblemsPanel } from "./IacProblemsPanel";

const diag = {
  line: 4,
  column: 2,
  severity: "error" as const,
  message: "Invalid expression",
  source: "terraform fmt",
};

describe("IacProblemsPanel", () => {
  it("renders the error count and a diagnostic row", () => {
    render(<IacProblemsPanel diagnostics={[diag]} linters={[]} onJumpTo={() => {}} />);
    expect(screen.getByText(/1 error/i)).toBeInTheDocument();
    expect(screen.getByText(/Invalid expression/)).toBeInTheDocument();
  });

  it("calls onJumpTo with line/column when a row is clicked", () => {
    const onJumpTo = vi.fn();
    render(<IacProblemsPanel diagnostics={[diag]} linters={[]} onJumpTo={onJumpTo} />);
    fireEvent.click(screen.getByTestId("iac-problem-0"));
    expect(onJumpTo).toHaveBeenCalledWith(4, 2);
  });

  it("shows honest linter status when a linter was skipped", () => {
    render(
      <IacProblemsPanel
        diagnostics={[]}
        linters={[
          { name: "terraform validate", ran: false, available: true, reason: "not initialized" },
        ]}
        onJumpTo={() => {}}
      />,
    );
    expect(screen.getByText(/terraform validate/)).toBeInTheDocument();
    expect(screen.getByText(/not initialized/)).toBeInTheDocument();
  });

  it("only claims clean when at least one linter actually ran with no findings", () => {
    render(
      <IacProblemsPanel
        diagnostics={[]}
        linters={[{ name: "terraform fmt", ran: true, available: true, reason: null }]}
        onJumpTo={() => {}}
      />,
    );
    expect(screen.getByText(/No issues/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/iac/IacProblemsPanel.test.tsx`
Expected: FAIL — `Cannot find module './IacProblemsPanel'`.

- [ ] **Step 3: Implement the component**

Create `src/components/iac/IacProblemsPanel.tsx`:

```typescript
import { useState } from "react";
import type { LintDiagnostic, LinterStatus } from "../../lib/tauri";

type Props = {
  diagnostics: LintDiagnostic[];
  linters: LinterStatus[];
  onJumpTo: (line: number, column: number) => void;
};

/**
 * Collapsible "Problems" panel for the IaC Studio. Mirrors the troubleshoot
 * PlaybookEditor diagnostics panel. Honest by design: it only says "No issues"
 * when a linter actually ran; skipped/unavailable linters are listed with their
 * reason so an empty list never masquerades as a guaranteed-clean file.
 */
export function IacProblemsPanel({ diagnostics, linters, onJumpTo }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity !== "error");
  const anyRan = linters.some((l) => l.ran);
  const skipped = linters.filter((l) => !l.ran);

  const summary =
    `${errors.length} error${errors.length === 1 ? "" : "s"}` +
    `, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`;

  return (
    <div className="iac-studio-problems" data-testid="iac-studio-problems">
      <div
        className={`iac-studio-problems-header ${errors.length > 0 ? "has-errors" : ""}`}
        onClick={() => setCollapsed((v) => !v)}
      >
        <span>{collapsed ? "▸" : "▾"}</span>
        <span>Problems ({summary})</span>
      </div>
      {!collapsed && (
        <div className="iac-studio-problems-list">
          {diagnostics.map((d, i) => (
            <div
              key={i}
              className={`iac-studio-problem-row ${d.severity}`}
              onClick={() => onJumpTo(d.line, d.column)}
              data-testid={`iac-problem-${i}`}
            >
              <span className="iac-studio-problem-where">L{d.line}</span>
              <span className="iac-studio-problem-msg">{d.message}</span>
              <span className="iac-studio-problem-source">{d.source}</span>
            </div>
          ))}

          {diagnostics.length === 0 && anyRan && (
            <div className="iac-studio-problem-row clean">No issues found.</div>
          )}

          {skipped.length > 0 && (
            <div className="iac-studio-problems-linters">
              {skipped.map((l) => (
                <div key={l.name} className="iac-studio-linter-status" data-testid={`iac-linter-${l.name}`}>
                  <span className="iac-studio-linter-name">{l.name}</span>
                  <span className="iac-studio-linter-reason">
                    {l.available ? "skipped" : "unavailable"}
                    {l.reason ? ` — ${l.reason}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}

          {diagnostics.length === 0 && !anyRan && skipped.length === 0 && (
            <div className="iac-studio-problem-row">No linters ran.</div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Add the CSS**

Append to `src/components/iac/IacStudioTab.css`:

```css
.iac-studio-problems {
  border-top: 1px solid #333;
  background: #16191e;
  max-height: 180px;
  display: flex;
  flex-direction: column;
}

.iac-studio-problems-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #8a8d94;
  cursor: pointer;
  user-select: none;
}

.iac-studio-problems-header.has-errors {
  color: #e06c75;
}

.iac-studio-problems-list {
  overflow-y: auto;
  padding: 0 12px 8px 12px;
}

.iac-studio-problem-row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  padding: 4px 0;
  color: #e6e1cf;
  border-bottom: 1px solid #1c2027;
  cursor: pointer;
}

.iac-studio-problem-row.error { color: #e06c75; }
.iac-studio-problem-row.warning { color: #d7c187; }
.iac-studio-problem-row.clean { color: #98c379; cursor: default; }

.iac-studio-problem-where { color: #8a8d94; min-width: 36px; }
.iac-studio-problem-msg { flex: 1; }
.iac-studio-problem-source { color: #5c6370; font-style: italic; }

.iac-studio-problems-linters {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed #2a2f37;
}

.iac-studio-linter-status {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: #8a8d94;
  padding: 2px 0;
}

.iac-studio-linter-name { color: #abb2bf; }
.iac-studio-linter-reason { font-style: italic; }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/components/iac/IacProblemsPanel.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/components/iac/IacProblemsPanel.tsx src/components/iac/IacProblemsPanel.test.tsx src/components/iac/IacStudioTab.css
git commit -m "feat(iac): IaC Studio Problems panel with honest linter status"
```

---

## Task 9: Wire linting into `IacStudioTab` — markers + panel

**Files:**
- Modify: `src/components/iac/IacStudioTab.tsx`
- Test: `src/components/iac/IacStudioTab.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `src/components/iac/IacStudioTab.test.tsx` (mock the lint wrapper so no sidecar is needed):

```typescript
import { vi } from "vitest";
import * as tauri from "../../lib/tauri";

it("renders the Problems panel after a file is open", async () => {
  vi.spyOn(tauri, "iacLintFile").mockResolvedValue({
    diagnostics: [{ line: 1, column: 1, severity: "error", message: "boom", source: "terraform fmt" }],
    linters: [{ name: "terraform fmt", ran: true, available: true, reason: null }],
  });
  vi.spyOn(tauri, "iacStudioReadFile").mockResolvedValue({
    file_path: "/ws/main.tf",
    content: "locals { x = }",
    language: "hcl",
  });

  // Render the tab and open a file via the store, then assert the panel shows.
  // (Mirror the existing open-file test setup already in this file.)
  // After opening: expect(await screen.findByTestId("iac-studio-problems")).toBeInTheDocument();
});
```

> Mirror the exact render/setup already used by the existing tests in this file (tab object shape, store seeding). Keep the assertion: the panel appears once a file is open and `findByText(/boom/)` resolves.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/iac/IacStudioTab.test.tsx`
Expected: FAIL — no `iac-studio-problems` testid rendered yet.

- [ ] **Step 3: Wire the hook, markers, and panel**

In `src/components/iac/IacStudioTab.tsx`:

Add imports:

```typescript
import { useIacLint } from "../../hooks/useIacLint";
import { IacProblemsPanel } from "./IacProblemsPanel";
```

Add refs near `editorRef` (line 29) to hold the monaco module:

```typescript
  const monacoRef = useRef<typeof Monaco | null>(null);
```

Add the lint hook after the settings hook (around line 28):

```typescript
  const { diagnostics, linters } = useIacLint({
    filePath: state.file_path,
    content: state.content,
    language: state.language,
  });
```

Persist results to the store so other surfaces can read them, and inject Monaco markers whenever diagnostics change. Add this effect after the `ensure` effect (line 33):

```typescript
  const setStudioDiagnostics = useIacStudioStore((s) => s.setDiagnostics);
  useEffect(() => {
    setStudioDiagnostics(tab.id, { diagnostics, linters });
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      "iac-lint",
      diagnostics.map((d) => ({
        startLineNumber: d.line,
        startColumn: d.column,
        endLineNumber: d.line,
        endColumn: 1000,
        message: `${d.message} (${d.source})`,
        severity:
          d.severity === "error"
            ? monaco.MarkerSeverity.Error
            : d.severity === "warning"
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
      })),
    );
  }, [diagnostics, linters, tab.id, setStudioDiagnostics]);
```

Capture the monaco module in `onEditorReady` — change the existing handler (line 115):

```typescript
              onEditorReady={(editor, monaco) => {
                editorRef.current = editor;
                monacoRef.current = monaco;
              }}
```

Add a jump handler (after `onBrowse`, line 68):

```typescript
  const onJumpTo = useCallback((line: number, column: number) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column });
    editor.focus();
  }, []);
```

Render the panel between `iac-studio-main` and the error/status bars (after the `</div>` closing `iac-studio-main`, ~line 125) — only when a file is open:

```typescript
      {state.file_path && (
        <IacProblemsPanel diagnostics={diagnostics} linters={linters} onJumpTo={onJumpTo} />
      )}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/iac/IacStudioTab.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the full frontend suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/iac/IacStudioTab.tsx src/components/iac/IacStudioTab.test.tsx
git commit -m "feat(iac): wire live lint markers + Problems panel into IaC Studio"
```

---

## Task 10: End-to-end manual verification

**Files:** none (verification only).

- [ ] **Step 1: Launch the app**

Run: `./run.sh` (from the worktree root if working in one — it uses `$(pwd)`-relative paths).

- [ ] **Step 2: Verify Terraform syntax diagnostics**

1. Open IaC Studio (⌘⇧E).
2. Browse to / open a folder with a `.tf` file (or create one).
3. Open a `.tf` file and introduce a syntax error, e.g. `locals { x = }`.
4. Confirm within ~1s: a red squiggle appears on that line **and** a Problems-panel row "1 error … L1 … terraform fmt".
5. Click the Problems row → cursor jumps to the line.
6. Fix the error → squiggle and row clear; panel shows "No issues found."

- [ ] **Step 3: Verify honest "not initialized" status**

In the same uninitialized folder, confirm the Problems panel lists `terraform validate — skipped — not initialized — run terraform init for semantic checks` (NOT a false provider error, NOT a fake clean).

- [ ] **Step 4: Verify Ansible degradation**

1. Open a `.yml` playbook.
2. Confirm the panel lists `ansible-lint — unavailable — ansible-lint not on PATH` and that `ansible-playbook --syntax-check` ran (introduce a YAML/playbook error and confirm an error row appears).

- [ ] **Step 5: Verify missing-binary honesty for terraform**

Temporarily shadow terraform off PATH (e.g. launch with a PATH lacking `/opt/homebrew/bin`, or rename the binary), reload, edit a `.tf` → confirm the panel says `terraform fmt — unavailable — terraform not on PATH` rather than reporting clean.

- [ ] **Step 6: Confirm editing survives a dead sidecar**

Stop the sidecar; confirm you can still open/edit/save `.tf` files (linting just shows nothing / an error), proving editing has no hard dependency on the linter.

- [ ] **Step 7: Update memory**

Update `project_iac_studio.md`: mark Phase B complete with the merge commit, note that `ansible-lint` is not installed locally (only `--syntax-check` fallback exercised live), and that `terraform validate` requires an initialized dir.

---

## Self-Review (completed during planning)

**Spec coverage (design spec Phase B bullets):**
- Sidecar `iac.lint_file` RPC (terraform validate + fmt, ansible-lint) → Tasks 1–3. ✓
- Debounced lint-on-change + lint-on-save → Task 7 (`useIacLint` debounce; save re-lints because content/dirty round-trips through the same buffer). ✓
- Diagnostics in Monaco gutter/squigglies **and** a bottom Problems panel → Tasks 8–9. ✓
- Missing-binary states surfaced as info, never a silent/fake "clean" → `linters[]` schema (Task 1), panel logic (Task 8 "only clean when a linter ran"), verification Steps 3–5. ✓

**Placeholder scan:** every code step contains complete code; the only deliberate "mirror the existing setup" notes are in Task 9 Step 1 and Task 3 Step 1, where the exact harness shape must match pre-existing tests in those files — flagged explicitly, not hidden.

**Type consistency:** `LintDiagnostic`/`LinterStatus`/`LintResult` defined once (Task 5), imported by the store (Task 6), hook (Task 7), and panel (Task 8). RPC method name `iac.lint_file` consistent across sidecar (Task 3), Rust (Task 4), wrapper (Task 5). Field names (`line`, `column`, `severity`, `message`, `source`; `name`, `ran`, `available`, `reason`) identical from Python schema → TS types → component.

**Deviation from Explore agent's suggestion:** the agent proposed a frontend-only HCL validator; the locked design spec mandates the sidecar CLI linters. This plan follows the spec.
