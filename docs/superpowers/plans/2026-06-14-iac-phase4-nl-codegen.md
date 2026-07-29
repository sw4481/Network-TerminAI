# IaC Phase 4 — Natural-Language Code Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the IaC ReACT agent generate validated Terraform HCL and Ansible YAML from natural-language intent, present it in the chat panel, write it to disk, and route any apply through the existing approval gate.

**Architecture:** Phase 4 is almost entirely additive sidecar work. The IaC agent already runs through `deepagents_react_code_loop` (cli_package `"iac"`) with two tools: `execute_python_code` (real subprocess) and the gated `iac_apply` (HITL-interrupted). This plan adds two more tools to that same agent — `generate_terraform_code` and `generate_ansible_playbook` — plus syntax-validation and project-convention helpers. The agent calls a generate tool, shows the returned code in chat (rendered as a fenced code block by the existing `ReactMarkdown`), writes it to a `.tf`/`.yml` file via its existing `execute_python_code` tool, and then calls `iac_apply` — which already pauses the graph and surfaces `IaCApprovalModal` with the computed blast radius. **No new modal, menu item, Tauri command, frontend component, or database migration is required.**

**Tech Stack:** Python sidecar (`deepagents` / LangGraph / LangChain `StructuredTool`), LangChain `BaseChatModel` via `build_chat_model(config)`, `pytest`. Validation shells out to `terraform fmt` and `ansible-playbook --syntax-check` when those binaries are on `PATH`, degrading gracefully when absent.

**Key design decisions (confirmed with stakeholder):**
1. **Review/apply UI:** reuse the chat panel + existing `IaCApprovalModal`. No dedicated review modal. (Per `feedback_gui_wiring_required`, the GUI-wiring rule only applies to *new* UI surfaces — this plan adds none.)
2. **Validation:** run `terraform fmt` / `ansible-playbook --syntax-check` if the binary is present; skip gracefully (`valid: None, skipped: true`) if not. One LLM retry with error feedback when validation fails.

**Patterns this plan mirrors (already in the codebase — read before starting):**
- Injectable-LLM-callable, never-raises analyzer: `sidecar/src/ccie_sidecar/agents/iac_drift_analysis.py`
- Tool factory with injectable runner: `build_iac_apply_tool()` in `sidecar/src/ccie_sidecar/agents/iac_tools.py:120`
- IaC-scoped tool attachment: `deepagents_react_code_loop` at `sidecar/src/ccie_sidecar/agents/deepagents_runtime.py:428-438`
- Blast-radius helpers reused for context: `sidecar/src/ccie_sidecar/agents/iac_blast_radius.py` (`detect_production_environment`, `run_terraform_plan_json`)
- Chat-model factory: `build_chat_model(config)` in `sidecar/src/ccie_sidecar/providers/langchain_factory.py:32`
- Test template (injected fake LLM): `sidecar/tests/test_iac_drift_analysis.py`

---

## File Structure

**New files:**
- `sidecar/src/ccie_sidecar/agents/iac_codegen.py` — pure functions: `generate_terraform_code`, `generate_ansible_playbook`, `validate_terraform_syntax`, `validate_ansible_syntax`, `analyze_project_conventions`, `list_available_roles`. Injectable `llm: Callable[[str], str]`. Never raises; returns structured dicts. (Mirrors `iac_drift_analysis.py`.)
- `sidecar/src/ccie_sidecar/agents/iac_codegen_tools.py` — `build_terraform_codegen_tool()` and `build_ansible_codegen_tool()` factories returning LangChain `StructuredTool`s. (Mirrors `iac_tools.py`.)
- `sidecar/tests/test_iac_codegen.py` — unit tests for the pure functions (injected fake LLM, no network).
- `sidecar/tests/agents/test_iac_codegen_tools.py` — tool-factory tests.
- `sidecar/tests/agents/test_iac_codegen_wiring.py` — runtime-wiring test (codegen tools attach to the IaC agent only).

**Modified files:**
- `sidecar/src/ccie_sidecar/agents/deepagents_runtime.py` — attach the two codegen tools and append codegen system-prompt guidance inside the `_is_iac_agent` branch (two call sites: `deepagents_react_code_loop` ~line 428 and `deepagents_react_loop` ~line 415 if it also gates IaC; verify in Task 5).
- `docs/features/iac-integration.md` — replace the "Phase 2 Features (Planned)" / add a "Phase 4" section documenting NL codegen.

**Deliberately NOT touched:** Rust (`src-tauri`), database migrations, `src/` frontend, Tauri menu. The agent reaches files through its existing `execute_python_code` tool, so no `iac_generate_code` Tauri command is needed.

---

## Task 1: Terraform code-generation pure function

**Files:**
- Create: `sidecar/src/ccie_sidecar/agents/iac_codegen.py`
- Test: `sidecar/tests/test_iac_codegen.py`

- [ ] **Step 1: Write the failing test**

Create `sidecar/tests/test_iac_codegen.py`:

```python
"""IaC Phase 4 — NL→code generation pure functions (injected LLM, no network)."""
import json

from ccie_sidecar.agents.iac_codegen import generate_terraform_code


def test_generate_terraform_returns_code_and_metadata():
    def fake_llm(prompt: str) -> str:
        assert "add HTTPS rule" in prompt  # intent is threaded into the prompt
        return json.dumps({
            "code": 'resource "aws_security_group_rule" "https" {\n  type = "ingress"\n}\n',
            "filename": "office-https.tf",
            "explanation": "Adds an HTTPS ingress rule.",
            "estimated_apply_time_seconds": 5,
        })

    result = generate_terraform_code(
        intent="add HTTPS rule from office to ALB",
        context={"project_path": "/infra/prod", "git_branch": "feature/https"},
        llm=fake_llm,
        validate=False,
    )

    assert result["tool"] == "terraform"
    assert 'resource "aws_security_group_rule"' in result["code"]
    assert result["filename"] == "office-https.tf"
    assert result["explanation"]
    assert result["unavailable"] is False


def test_generate_terraform_degrades_on_bad_llm_json():
    def bad_llm(prompt: str) -> str:
        return "not json at all"

    result = generate_terraform_code(
        intent="anything",
        context={"project_path": "/tmp"},
        llm=bad_llm,
        validate=False,
    )

    assert result["unavailable"] is True
    assert result["code"] == ""
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && .venv/bin/pytest tests/test_iac_codegen.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'ccie_sidecar.agents.iac_codegen'`

- [ ] **Step 3: Write minimal implementation**

Create `sidecar/src/ccie_sidecar/agents/iac_codegen.py`:

```python
"""IaC Phase 4 — natural-language → Terraform/Ansible code generation.

Pure, stateless, never-raises helpers. The LLM is injected as a
`Callable[[str], str]` (mirrors iac_drift_analysis.analyze_drift) so tests run
without a network and the runtime supplies a real chat model. Any failure —
bad JSON, missing key, LLM exception — degrades to {"code": "", ...,
"unavailable": True}; code generation must never crash the agent turn.
"""
from __future__ import annotations

import json
import os
from typing import Any, Callable, Optional

LlmFn = Callable[[str], str]


def _default_llm(prompt: str) -> str:
    """Placeholder. The runtime builds a real chat model and injects it; the
    RPC/tool layer never relies on this."""
    raise NotImplementedError("iac_codegen requires an injected llm callable")


def _build_terraform_prompt(intent: str, context: dict, conventions: dict) -> str:
    return (
        "Generate Terraform (HCL) for the following requirement.\n\n"
        f"Intent: {intent}\n\n"
        "Context:\n"
        f"- Project: {context.get('project_path', 'unknown')}\n"
        f"- Git branch: {context.get('git_branch', 'unknown')}\n"
        f"- Existing resources: "
        f"{json.dumps(context.get('existing_resources', []), indent=2)}\n\n"
        "Project conventions:\n"
        f"- Provider versions: {conventions.get('provider_versions', 'unknown')}\n"
        f"- Naming pattern: {conventions.get('naming_pattern', 'snake_case')}\n\n"
        "Generate valid HCL that follows the project's naming/style conventions, "
        "references existing resources where appropriate, uses variables for "
        "configurable values, and includes brief comments.\n\n"
        'Respond ONLY as JSON: {"code": "<hcl>", "filename": "<name>.tf", '
        '"explanation": "<one sentence>", "estimated_apply_time_seconds": <int>}'
    )


def generate_terraform_code(
    intent: str,
    context: dict,
    llm: Optional[LlmFn] = None,
    validate: bool = True,
) -> dict[str, Any]:
    """Generate Terraform HCL from natural-language intent. Never raises.

    Returns:
        {"tool": "terraform", "code": str, "filename": str, "explanation": str,
         "estimated_apply_time_seconds": int, "validation": dict,
         "unavailable": bool}
    """
    call = llm or _default_llm
    conventions = analyze_project_conventions(context.get("project_path", ""))
    prompt = _build_terraform_prompt(intent, context, conventions)
    try:
        raw = call(prompt)
        parsed = json.loads(raw)
        code = parsed["code"]
        if not isinstance(code, str) or not code.strip():
            raise ValueError("empty code")
    except Exception:
        return _unavailable("terraform")

    validation = {"valid": None, "skipped": True, "error": None}
    if validate:
        validation = validate_terraform_syntax(code)
        if validation.get("valid") is False:
            # One retry with the validator error fed back to the model.
            retry_prompt = (
                prompt
                + f"\n\nThe previous attempt failed validation: "
                f"{validation.get('error')}\nFix it and respond as JSON again."
            )
            try:
                parsed = json.loads(call(retry_prompt))
                code = parsed["code"]
                validation = validate_terraform_syntax(code)
            except Exception:
                pass

    return {
        "tool": "terraform",
        "code": code,
        "filename": parsed.get("filename", "generated.tf"),
        "explanation": parsed.get("explanation", ""),
        "estimated_apply_time_seconds": parsed.get("estimated_apply_time_seconds", 0),
        "validation": validation,
        "unavailable": False,
    }


def _unavailable(tool: str) -> dict[str, Any]:
    return {
        "tool": tool,
        "code": "",
        "filename": "",
        "explanation": "",
        "estimated_apply_time_seconds": 0,
        "validation": {"valid": None, "skipped": True, "error": None},
        "unavailable": True,
    }


def analyze_project_conventions(project_path: str) -> dict[str, Any]:
    """Best-effort scan of existing .tf files to learn style. Never raises."""
    conventions = {"provider_versions": "unknown", "naming_pattern": "snake_case"}
    try:
        if project_path and os.path.isdir(project_path):
            tf_files = [f for f in os.listdir(project_path) if f.endswith(".tf")]
            conventions["existing_files"] = tf_files
    except OSError:
        pass
    return conventions
```

> NOTE: `validate_terraform_syntax` is referenced here but implemented in Task 3. This task's tests pass `validate=False`, so the symbol is not exercised yet. Add the stub now so the module imports cleanly:

```python
def validate_terraform_syntax(code: str) -> dict[str, Any]:
    """Implemented in Task 3."""
    return {"valid": None, "skipped": True, "error": None}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sidecar && .venv/bin/pytest tests/test_iac_codegen.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/ccie_sidecar/agents/iac_codegen.py sidecar/tests/test_iac_codegen.py
git commit -m "feat(iac): NL->Terraform code generation pure function (Phase 4)"
```

---

## Task 2: Ansible playbook-generation pure function

**Files:**
- Modify: `sidecar/src/ccie_sidecar/agents/iac_codegen.py`
- Test: `sidecar/tests/test_iac_codegen.py:append`

- [ ] **Step 1: Write the failing test**

Append to `sidecar/tests/test_iac_codegen.py`:

```python
from ccie_sidecar.agents.iac_codegen import generate_ansible_playbook


def test_generate_ansible_returns_playbook():
    def fake_llm(prompt: str) -> str:
        assert "deploy nginx" in prompt
        return json.dumps({
            "playbook": "---\n- name: deploy nginx\n  hosts: web\n  tasks: []\n",
            "filename": "deploy-nginx.yml",
            "explanation": "Deploys nginx to web hosts.",
            "target_host_count": 3,
        })

    result = generate_ansible_playbook(
        intent="deploy nginx to web servers on port 8080",
        context={"inventory_path": "/infra/hosts.ini", "target_hosts": ["web"]},
        llm=fake_llm,
        validate=False,
    )

    assert result["tool"] == "ansible"
    assert "deploy nginx" in result["code"]
    assert result["filename"] == "deploy-nginx.yml"
    assert result["unavailable"] is False


def test_generate_ansible_degrades_on_bad_json():
    result = generate_ansible_playbook(
        intent="x", context={}, llm=lambda p: "{bad", validate=False
    )
    assert result["unavailable"] is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && .venv/bin/pytest tests/test_iac_codegen.py -k ansible -v`
Expected: FAIL with `ImportError: cannot import name 'generate_ansible_playbook'`

- [ ] **Step 3: Write minimal implementation**

Append to `sidecar/src/ccie_sidecar/agents/iac_codegen.py`:

```python
def _build_ansible_prompt(intent: str, context: dict, roles: list[str]) -> str:
    return (
        "Generate an Ansible playbook (YAML) for the following requirement.\n\n"
        f"Intent: {intent}\n\n"
        "Context:\n"
        f"- Target hosts: {context.get('target_hosts', [])}\n"
        f"- Available roles: {', '.join(roles) or 'none'}\n"
        f"- Inventory: {context.get('inventory_path', 'unknown')}\n\n"
        "Generate a valid YAML playbook that is idempotent, reuses existing roles "
        "where applicable, uses clear task names, and uses variables for "
        "configurable values.\n\n"
        'Respond ONLY as JSON: {"playbook": "<yaml>", "filename": "<name>.yml", '
        '"explanation": "<one sentence>", "target_host_count": <int>}'
    )


def generate_ansible_playbook(
    intent: str,
    context: dict,
    llm: Optional[LlmFn] = None,
    validate: bool = True,
) -> dict[str, Any]:
    """Generate an Ansible playbook from natural-language intent. Never raises."""
    call = llm or _default_llm
    roles = list_available_roles(context.get("roles_path", ""))
    prompt = _build_ansible_prompt(intent, context, roles)
    try:
        parsed = json.loads(call(prompt))
        code = parsed["playbook"]
        if not isinstance(code, str) or not code.strip():
            raise ValueError("empty playbook")
    except Exception:
        return _unavailable("ansible")

    validation = {"valid": None, "skipped": True, "error": None}
    if validate:
        validation = validate_ansible_syntax(code)
        if validation.get("valid") is False:
            retry_prompt = (
                prompt
                + f"\n\nThe previous attempt failed --syntax-check: "
                f"{validation.get('error')}\nFix it and respond as JSON again."
            )
            try:
                parsed = json.loads(call(retry_prompt))
                code = parsed["playbook"]
                validation = validate_ansible_syntax(code)
            except Exception:
                pass

    return {
        "tool": "ansible",
        "code": code,
        "filename": parsed.get("filename", "generated.yml"),
        "explanation": parsed.get("explanation", ""),
        "estimated_apply_time_seconds": 0,
        "validation": validation,
        "unavailable": False,
    }


def list_available_roles(roles_path: str) -> list[str]:
    """List role directory names under <roles_path>/roles. Never raises."""
    try:
        roles_dir = os.path.join(roles_path or "", "roles")
        if os.path.isdir(roles_dir):
            return sorted(
                d for d in os.listdir(roles_dir)
                if os.path.isdir(os.path.join(roles_dir, d))
            )
    except OSError:
        pass
    return []


def validate_ansible_syntax(code: str) -> dict[str, Any]:
    """Implemented in Task 3."""
    return {"valid": None, "skipped": True, "error": None}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sidecar && .venv/bin/pytest tests/test_iac_codegen.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/ccie_sidecar/agents/iac_codegen.py sidecar/tests/test_iac_codegen.py
git commit -m "feat(iac): NL->Ansible playbook generation pure function (Phase 4)"
```

---

## Task 3: Syntax validation (binary-present, else skip)

**Files:**
- Modify: `sidecar/src/ccie_sidecar/agents/iac_codegen.py` (replace the two `validate_*` stubs)
- Test: `sidecar/tests/test_iac_codegen.py:append`

- [ ] **Step 1: Write the failing test**

Append to `sidecar/tests/test_iac_codegen.py`:

```python
import shutil

from ccie_sidecar.agents.iac_codegen import (
    validate_terraform_syntax,
    validate_ansible_syntax,
)


def test_validate_terraform_skips_when_binary_absent(monkeypatch):
    monkeypatch.setattr(shutil, "which", lambda name: None)
    result = validate_terraform_syntax('resource "x" "y" {}')
    assert result["skipped"] is True
    assert result["valid"] is None


def test_validate_terraform_runs_fmt_when_present(monkeypatch):
    monkeypatch.setattr(shutil, "which", lambda name: "/usr/bin/terraform")

    class FakeProc:
        returncode = 0
        stdout = ""
        stderr = ""

    monkeypatch.setattr(
        "ccie_sidecar.agents.iac_codegen.subprocess.run",
        lambda *a, **k: FakeProc(),
    )
    result = validate_terraform_syntax('resource "aws_s3_bucket" "b" {}')
    assert result["skipped"] is False
    assert result["valid"] is True


def test_validate_terraform_reports_invalid(monkeypatch):
    monkeypatch.setattr(shutil, "which", lambda name: "/usr/bin/terraform")

    class FakeProc:
        returncode = 1
        stdout = ""
        stderr = "Error: Invalid block definition"

    monkeypatch.setattr(
        "ccie_sidecar.agents.iac_codegen.subprocess.run",
        lambda *a, **k: FakeProc(),
    )
    result = validate_terraform_syntax("resource broken {")
    assert result["valid"] is False
    assert "Invalid block" in result["error"]


def test_validate_ansible_skips_when_binary_absent(monkeypatch):
    monkeypatch.setattr(shutil, "which", lambda name: None)
    result = validate_ansible_syntax("---\n- hosts: all\n")
    assert result["skipped"] is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && .venv/bin/pytest tests/test_iac_codegen.py -k validate -v`
Expected: FAIL — the stubs always return `skipped: True`, so `test_validate_terraform_runs_fmt_when_present` and `test_validate_terraform_reports_invalid` fail.

- [ ] **Step 3: Write implementation**

In `sidecar/src/ccie_sidecar/agents/iac_codegen.py`, add `import shutil`, `import subprocess`, and `import tempfile` to the imports, then REPLACE both `validate_terraform_syntax` and `validate_ansible_syntax` stubs with:

```python
def validate_terraform_syntax(code: str) -> dict[str, Any]:
    """Validate HCL with `terraform fmt` (parses HCL, needs no providers/init).

    Skips gracefully when the terraform binary is absent. `terraform fmt -` reads
    stdin and exits non-zero / writes to stderr on malformed HCL. Never raises.
    """
    if shutil.which("terraform") is None:
        return {"valid": None, "skipped": True, "error": None}
    try:
        proc = subprocess.run(
            ["terraform", "fmt", "-"],
            input=code,
            capture_output=True,
            text=True,
            timeout=30,
        )
        ok = proc.returncode == 0
        return {
            "valid": ok,
            "skipped": False,
            "error": None if ok else (proc.stderr or proc.stdout).strip(),
        }
    except Exception as e:  # subprocess timeout / OSError — treat as skip
        return {"valid": None, "skipped": True, "error": str(e)}


def validate_ansible_syntax(code: str) -> dict[str, Any]:
    """Validate a playbook with `ansible-playbook --syntax-check`.

    Writes the YAML to a temp file (the CLI needs a path) and runs the check,
    which parses without connecting to any host. Skips when the binary is
    absent. Never raises.
    """
    if shutil.which("ansible-playbook") is None:
        return {"valid": None, "skipped": True, "error": None}
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".yml", delete=True
        ) as fh:
            fh.write(code)
            fh.flush()
            proc = subprocess.run(
                ["ansible-playbook", "--syntax-check", fh.name],
                capture_output=True,
                text=True,
                timeout=30,
            )
        ok = proc.returncode == 0
        return {
            "valid": ok,
            "skipped": False,
            "error": None if ok else (proc.stderr or proc.stdout).strip(),
        }
    except Exception as e:
        return {"valid": None, "skipped": True, "error": str(e)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sidecar && .venv/bin/pytest tests/test_iac_codegen.py -v`
Expected: PASS (8 passed)

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/ccie_sidecar/agents/iac_codegen.py sidecar/tests/test_iac_codegen.py
git commit -m "feat(iac): graceful terraform/ansible syntax validation (Phase 4)"
```

---

## Task 4: Codegen tool factories (LangChain StructuredTools)

**Files:**
- Create: `sidecar/src/ccie_sidecar/agents/iac_codegen_tools.py`
- Test: `sidecar/tests/agents/test_iac_codegen_tools.py`

- [ ] **Step 1: Write the failing test**

Create `sidecar/tests/agents/test_iac_codegen_tools.py`:

```python
"""IaC Phase 4 — codegen StructuredTool factories."""
import json

from ccie_sidecar.agents.iac_codegen_tools import (
    build_terraform_codegen_tool,
    build_ansible_codegen_tool,
)


def test_terraform_tool_has_expected_name_and_calls_generator():
    def fake_llm(prompt: str) -> str:
        return json.dumps({"code": 'resource "x" "y" {}', "filename": "x.tf",
                           "explanation": "ok"})

    tool = build_terraform_codegen_tool(llm=fake_llm)
    assert tool.name == "generate_terraform_code"

    out = tool.func(intent="make an s3 bucket", working_dir="/infra")
    payload = json.loads(out)
    assert payload["tool"] == "terraform"
    assert 'resource "x" "y"' in payload["code"]


def test_ansible_tool_has_expected_name():
    def fake_llm(prompt: str) -> str:
        return json.dumps({"playbook": "---\n- hosts: all\n", "filename": "p.yml",
                           "explanation": "ok"})

    tool = build_ansible_codegen_tool(llm=fake_llm)
    assert tool.name == "generate_ansible_playbook"
    out = tool.func(intent="install nginx", working_dir="/infra")
    assert json.loads(out)["tool"] == "ansible"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && .venv/bin/pytest tests/agents/test_iac_codegen_tools.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'ccie_sidecar.agents.iac_codegen_tools'`

- [ ] **Step 3: Write the implementation**

Create `sidecar/src/ccie_sidecar/agents/iac_codegen_tools.py`:

```python
"""IaC Phase 4 — codegen tools the IaC agent calls.

Each factory returns a LangChain StructuredTool whose `func` is synchronous
(matches build_iac_apply_tool). The tool returns a JSON string so the agent can
quote the code back to the user and decide whether to write it to a file (via
execute_python_code) and then call iac_apply. The LLM is injectable for tests;
the default builds the configured chat model and exposes a `str -> str` callable.
"""
from __future__ import annotations

import json
from typing import Any, Callable, Optional

from langchain_core.tools import StructuredTool

from ccie_sidecar.agents.iac_codegen import (
    generate_ansible_playbook,
    generate_terraform_code,
)

LlmFn = Callable[[str], str]


def _default_llm() -> LlmFn:
    """Build a `str -> str` callable backed by the configured chat model.

    Imported lazily so tests that inject a fake llm never touch provider config.
    """
    from ccie_sidecar.agent import get_saved_config
    from ccie_sidecar.providers.langchain_factory import build_chat_model
    from langchain_core.messages import HumanMessage

    model = build_chat_model(get_saved_config() or {})

    def _call(prompt: str) -> str:
        resp = model.invoke([HumanMessage(content=prompt)])
        content = resp.content
        if isinstance(content, list):  # some providers return content blocks
            content = "".join(
                b.get("text", "") if isinstance(b, dict) else str(b)
                for b in content
            )
        return content

    return _call


def build_terraform_codegen_tool(llm: Optional[LlmFn] = None) -> StructuredTool:
    """Build the `generate_terraform_code` tool."""
    def generate(intent: str, working_dir: str = "", git_branch: str = "") -> str:
        call = llm or _default_llm()
        result = generate_terraform_code(
            intent=intent,
            context={"project_path": working_dir, "git_branch": git_branch},
            llm=call,
        )
        return json.dumps(result)

    return StructuredTool.from_function(
        func=generate,
        name="generate_terraform_code",
        description=(
            "Generate Terraform HCL from a natural-language intent. Returns JSON "
            "with the generated code, a suggested filename, an explanation, and "
            "syntax-validation status. Does NOT apply anything — after generating, "
            "show the code to the user, write it to a .tf file with "
            "execute_python_code, then call iac_apply to apply (which requires "
            "human approval)."
        ),
    )


def build_ansible_codegen_tool(llm: Optional[LlmFn] = None) -> StructuredTool:
    """Build the `generate_ansible_playbook` tool."""
    def generate(intent: str, working_dir: str = "", inventory_path: str = "") -> str:
        call = llm or _default_llm()
        result = generate_ansible_playbook(
            intent=intent,
            context={"roles_path": working_dir, "inventory_path": inventory_path},
            llm=call,
        )
        return json.dumps(result)

    return StructuredTool.from_function(
        func=generate,
        name="generate_ansible_playbook",
        description=(
            "Generate an Ansible playbook (YAML) from a natural-language intent. "
            "Returns JSON with the playbook, a suggested filename, an explanation, "
            "and --syntax-check status. Does NOT run anything — show the playbook, "
            "write it to a .yml file with execute_python_code, then call iac_apply "
            "to run it (which requires human approval)."
        ),
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sidecar && .venv/bin/pytest tests/agents/test_iac_codegen_tools.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/ccie_sidecar/agents/iac_codegen_tools.py sidecar/tests/agents/test_iac_codegen_tools.py
git commit -m "feat(iac): codegen StructuredTool factories (Phase 4)"
```

---

## Task 5: Wire codegen tools into the IaC agent runtime

**Files:**
- Modify: `sidecar/src/ccie_sidecar/agents/deepagents_runtime.py`
- Test: `sidecar/tests/agents/test_iac_codegen_wiring.py`

**Pre-step — confirm the call sites.** Run:

```bash
cd sidecar && grep -n "_is_iac_agent(cli_package)" src/ccie_sidecar/agents/deepagents_runtime.py
```

Expected: at least one hit at ~line 428 inside `deepagents_react_code_loop`. The IaC agent runs via the `react_code_loop` (code-exec) path, so that is the required edit site. If `deepagents_react_loop` (~line 415, the no-code-exec path) also has an `_is_iac_agent` branch, apply the same two-line addition there too; if it does not gate IaC, leave it alone.

- [ ] **Step 1: Write the failing test**

Create `sidecar/tests/agents/test_iac_codegen_wiring.py`:

```python
"""IaC Phase 4 — codegen tools attach to the IaC agent (and only it)."""
from ccie_sidecar.agents.deepagents_runtime import _iac_extra_tools


def test_iac_agent_gets_codegen_tools():
    tools = _iac_extra_tools()
    names = {t.name for t in tools}
    assert "iac_apply" in names
    assert "generate_terraform_code" in names
    assert "generate_ansible_playbook" in names
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && .venv/bin/pytest tests/agents/test_iac_codegen_wiring.py -v`
Expected: FAIL with `ImportError: cannot import name '_iac_extra_tools'`

- [ ] **Step 3: Extract a helper and call it at the wiring site**

In `sidecar/src/ccie_sidecar/agents/deepagents_runtime.py`, add this helper near `_is_iac_agent` (after line 107):

```python
def _iac_extra_tools() -> list:
    """The extra tools an IaC agent gets beyond execute_python_code:
    the gated iac_apply plus the Phase 4 NL codegen tools. Factored out so the
    wiring is testable without constructing a full graph."""
    from ccie_sidecar.agents.iac_tools import build_iac_apply_tool
    from ccie_sidecar.agents.iac_codegen_tools import (
        build_ansible_codegen_tool,
        build_terraform_codegen_tool,
    )
    return [
        build_iac_apply_tool(),
        build_terraform_codegen_tool(),
        build_ansible_codegen_tool(),
    ]
```

Then REPLACE the body of the `if _is_iac_agent(cli_package):` branch in `deepagents_react_code_loop` (currently lines 428-438) so it uses the helper:

```python
        if _is_iac_agent(cli_package):
            from ccie_sidecar.agents.deepagents_middleware import HideBuiltinFsToolsMiddleware
            # iac_apply (gated) + Phase 4 NL codegen tools.
            tools.extend(_iac_extra_tools())
            # Only iac_apply pauses the graph; codegen tools return code and never
            # mutate infrastructure, so they are NOT in interrupt_on.
            graph_kwargs["interrupt_on"] = {"iac_apply": True}
            graph_kwargs["checkpointer"] = _get_checkpointer()
            extra_middleware.append(HideBuiltinFsToolsMiddleware())
```

> The `build_iac_apply_tool` import that previously lived in this branch is now inside `_iac_extra_tools`; remove the old `from ...iac_tools import build_iac_apply_tool` line from the branch to avoid a dead import.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sidecar && .venv/bin/pytest tests/agents/test_iac_codegen_wiring.py -v`
Expected: PASS (1 passed)

- [ ] **Step 5: Run the existing IaC runtime/interrupt tests to confirm no regression**

Run: `cd sidecar && .venv/bin/pytest tests/agents/test_iac_runtime_wiring.py tests/agents/test_iac_interrupt_flow.py tests/agents/test_iac_tools.py -v`
Expected: PASS (all previously-passing tests still green — interrupt_on still gates only `iac_apply`).

- [ ] **Step 6: Commit**

```bash
git add sidecar/src/ccie_sidecar/agents/deepagents_runtime.py sidecar/tests/agents/test_iac_codegen_wiring.py
git commit -m "feat(iac): attach NL codegen tools to the IaC agent (Phase 4)"
```

---

## Task 6: Append codegen workflow guidance to the IaC system prompt

**Files:**
- Modify: `sidecar/src/ccie_sidecar/agents/deepagents_runtime.py`
- Test: `sidecar/tests/agents/test_iac_codegen_wiring.py:append`

**Why:** The IaC agent's `system_prompt` comes from `agent_def` (user/seed-defined) and may not mention codegen. Appending guidance in the runtime — only when `_is_iac_agent` — guarantees the NL→generate→write→apply workflow is described regardless of how the agent was configured. This mirrors how the IaC branch already injects IaC-only behavior (tools, middleware).

- [ ] **Step 1: Write the failing test**

Append to `sidecar/tests/agents/test_iac_codegen_wiring.py`:

```python
from ccie_sidecar.agents.deepagents_runtime import (
    IAC_CODEGEN_GUIDANCE,
    _iac_system_prompt,
)


def test_iac_guidance_appended_to_user_prompt():
    combined = _iac_system_prompt("You are a helpful IaC agent.")
    assert "You are a helpful IaC agent." in combined
    assert IAC_CODEGEN_GUIDANCE.strip() in combined


def test_iac_guidance_mentions_generate_then_apply_order():
    assert "generate_terraform_code" in IAC_CODEGEN_GUIDANCE
    assert "iac_apply" in IAC_CODEGEN_GUIDANCE
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && .venv/bin/pytest tests/agents/test_iac_codegen_wiring.py -k guidance -v`
Expected: FAIL with `ImportError: cannot import name 'IAC_CODEGEN_GUIDANCE'`

- [ ] **Step 3: Add the constant + helper and apply it at the graph-build site**

In `sidecar/src/ccie_sidecar/agents/deepagents_runtime.py`, add near the top (module level, after imports):

```python
IAC_CODEGEN_GUIDANCE = """
## Infrastructure-as-Code code generation

When the user asks you to create or change infrastructure in natural language:
1. Call `generate_terraform_code` (or `generate_ansible_playbook`) with a clear
   `intent` and the current `working_dir`. It returns JSON with the code,
   a suggested filename, an explanation, and syntax-validation status.
2. Show the generated code to the user in a fenced code block and summarise what
   it does and its likely blast radius. If `validation.valid` is false, say so.
3. Only if the user wants to apply it: write the code to the suggested filename
   inside the working directory using `execute_python_code`, then call
   `iac_apply` with that working_dir and the matching command (e.g.
   `terraform apply` or `ansible-playbook <file>`). `iac_apply` ALWAYS pauses for
   human approval — never try to bypass it via execute_python_code.
Never run `terraform apply`/`destroy` or `ansible-playbook` through
execute_python_code; that path is blocked. Apply only via `iac_apply`.
"""


def _iac_system_prompt(base_prompt: str) -> str:
    """Append IaC codegen workflow guidance to the agent's own system prompt."""
    return f"{base_prompt}\n{IAC_CODEGEN_GUIDANCE}"
```

Then, in `deepagents_react_code_loop`, change the `create_deep_agent(... system_prompt=...)` call (line 448) so the IaC branch uses the augmented prompt. The cleanest edit: compute the prompt once before the `create_deep_agent` call:

```python
        base_prompt = agent_def.get("system_prompt", "")
        system_prompt = (
            _iac_system_prompt(base_prompt)
            if _is_iac_agent(cli_package)
            else base_prompt
        )
        graph = create_deep_agent(
            model=chat_model,
            tools=tools,
            system_prompt=system_prompt,
            store=InMemoryStore(),
            middleware=[ToolCallSanitizerMiddleware(), _rubric_middleware(config), *extra_middleware],
            **graph_kwargs,
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sidecar && .venv/bin/pytest tests/agents/test_iac_codegen_wiring.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/ccie_sidecar/agents/deepagents_runtime.py sidecar/tests/agents/test_iac_codegen_wiring.py
git commit -m "feat(iac): inject codegen workflow guidance into IaC system prompt (Phase 4)"
```

---

## Task 7: Full sidecar test sweep + documentation

**Files:**
- Modify: `docs/features/iac-integration.md`

- [ ] **Step 1: Run the full IaC sidecar test suite**

Run: `cd sidecar && .venv/bin/pytest tests/ -k "iac" -v`
Expected: PASS — all IaC tests (drift, tools, blast radius, interrupt flow, codegen, codegen tools, codegen wiring) green.

- [ ] **Step 2: Run the entire sidecar suite to confirm no cross-module regression**

Run: `cd sidecar && .venv/bin/pytest -q`
Expected: PASS (no new failures vs. baseline).

- [ ] **Step 3: Update the feature doc**

In `docs/features/iac-integration.md`, replace the `## Phase 2 Features (Planned)` section's last bullet and add a new section before `## Troubleshooting`:

```markdown
## Phase 4: Natural-Language Code Generation

The IaC agent (cli_package `iac`) can generate Terraform HCL and Ansible YAML
from natural-language intent, then apply it through the existing approval gate.

### Workflow

1. In the Agent panel, ask: *"add an HTTPS ingress rule from the office network to the prod ALB"*.
2. The agent calls `generate_terraform_code` and shows the HCL in a fenced code block with an explanation and blast-radius summary.
3. If you approve the direction, the agent writes the code to a `.tf` file in the working directory and calls `iac_apply`.
4. `iac_apply` pauses the graph and surfaces the **IaCApprovalModal** (same as Phase 2) with the computed blast radius. Approve to apply; cancel to abort.

### Tools

| Tool | Module | Purpose |
|------|--------|---------|
| `generate_terraform_code` | `agents/iac_codegen.py` | NL → HCL, with `terraform fmt` validation |
| `generate_ansible_playbook` | `agents/iac_codegen.py` | NL → YAML, with `--syntax-check` validation |
| `iac_apply` | `agents/iac_tools.py` | Gated apply (Phase 2; unchanged) |

### Validation

Generated code is validated when the relevant binary is on `PATH`
(`terraform fmt` for HCL, `ansible-playbook --syntax-check` for YAML). When the
binary is absent, validation is skipped (`validation.skipped = true`) and the
code is returned unvalidated — the agent surfaces this to the user. On a
validation failure the agent retries generation once with the error fed back to
the model.

### Notes

- No remote state backends, background drift polling, or cost estimation — out of
  scope per the v1 design.
- Generated code is not persisted to a database table; it lives in the chat
  transcript and the file the agent writes. Applies are recorded in
  `iac_executions` exactly as for any other IaC command.
```

- [ ] **Step 4: Commit**

```bash
git add docs/features/iac-integration.md
git commit -m "docs(iac): document Phase 4 natural-language code generation"
```

---

## Self-Review (completed during planning)

**Spec coverage** (against design §"Phase 4: ReACT Agent Integration"):
- ✅ `generate_terraform_code` / `generate_ansible_playbook` — Tasks 1, 2
- ✅ Syntax validation + retry-with-error-feedback — Tasks 1–3
- ✅ Project-convention loading (`analyze_project_conventions`, `list_available_roles`) — Tasks 1, 2
- ✅ Tools registered with the agent — Tasks 4, 5
- ✅ Generated-code approval flow — reuses `iac_apply` + `IaCApprovalModal` (Tasks 5, 6; no new code)
- ✅ Success criterion "user chats → agent generates valid code → Apply → approval modal → executes" — covered by the system-prompt workflow (Task 6) + existing gate
- ✅ Unit tests per tool + integration wiring tests — Tasks 1–6
- ⚠️ Design also lists `query_terraform_state` / `query_ansible_inventory` as agent tools. The Rust `iac_load_state`/`iac_query_state` commands already exist (Phase 3) and the agent can read state/inventory files directly via `execute_python_code`. Adding dedicated query *tools* is **intentionally deferred** — not required for the NL-codegen success criterion, and `gather_iac_context` auto-loading is a nice-to-have the agent can replicate by reading files. Flagged here so it's a conscious omission, not a gap.

**Placeholder scan:** No TBD/TODO/"handle edge cases" left. The Task 1 `validate_terraform_syntax` stub is explicitly replaced in Task 3 (called out inline).

**Type consistency:** `generate_terraform_code`/`generate_ansible_playbook` return the same dict shape (`tool`, `code`, `filename`, `explanation`, `estimated_apply_time_seconds`, `validation`, `unavailable`); `validate_*` return `{valid, skipped, error}` consistently; tool factories return `StructuredTool` with `.name`/`.func` used in tests exactly as `build_iac_apply_tool` exposes them. `_iac_extra_tools` and `_iac_system_prompt` names match between implementation and tests.

**No-new-surface confirmation:** No Tauri command, menu item, keyboard shortcut, React component, Zustand store, or migration is added — so the `feedback_gui_wiring_required` rule (which governs *new* UI surfaces) does not trigger. Generated code renders via the AgentPanel's existing `ReactMarkdown` fenced-code support; approval reuses the mounted `IaCApprovalModal`.
