"""IaC Studio Phase B — file linting.

Turns a single file's (path, content, language) into structured diagnostics by
running the real CLI linters. Honest by construction: every linter reports
whether it ran and, if not, why — an empty diagnostics list is never a faked
"clean". Mirrors the binary-detection + never-raise pattern in iac_codegen.py.
"""
from __future__ import annotations

import json
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
# Strips ANSI color escape sequences (terraform colorizes its stderr).
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
# ansible-lint emits `path:line:col: [rule] message` lines on stdout.
_ALINT_RE = re.compile(r"^[^:]*:(\d+):(?:(\d+):)?\s*(.*)$")
# Ansible's syntax-error prefix changed across releases. Current versions emit
# `[ERROR]:`, while older Linux packages commonly emit `ERROR!` (and a few
# releases used `ERROR:`). Recognize every supported form before considering
# the trailing source excerpt/caret lines.
_ANSIBLE_ERROR_RE = re.compile(r"^\s*(?:\[ERROR\]\s*:|ERROR[!:])", re.IGNORECASE)
# yamllint -f parsable emits `path:line:col: [severity] message (rule)`.
_YAMLLINT_RE = re.compile(r"^[^:]*:(\d+):(\d+):\s*\[(\w+)\]\s*(.*)$")


def _is_ci_pipeline(file_path: str) -> bool:
    """True for CI/CD pipeline YAML that is NOT an Ansible playbook.

    These are generic YAML (GitLab CI, GitHub Actions workflows); linting them
    as Ansible playbooks produces false "empty playbook"/role errors. Matched by
    path so a `.gitlab-ci.yml` or `.github/workflows/*.yml` routes to yamllint.
    """
    p = file_path.replace("\\", "/").lower()
    name = p.rsplit("/", 1)[-1]
    return (
        name == ".gitlab-ci.yml"
        or name == ".gitlab-ci.yaml"
        or "/.github/workflows/" in p
    )


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
    text = _ANSI_RE.sub("", text)
    line_m = _FMT_LINE_RE.search(text)
    err_m = _FMT_ERROR_RE.search(text)
    diag = {
        "line": int(line_m.group(1)) if line_m else 1,
        "column": 1,
        "severity": "error",
        "message": (err_m.group(1) if err_m else "HCL parse error").strip(),
        "source": "terraform fmt",
    }
    return [diag], _linter("terraform fmt", ran=True, available=True)


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
    lines = [
        _ANSI_RE.sub("", line).strip()
        for line in (proc.stderr or proc.stdout).splitlines()
        if line.strip()
    ]
    error_line = next((line for line in lines if _ANSIBLE_ERROR_RE.match(line)), None)
    if error_line is not None:
        message = error_line
    else:
        # Unknown Ansible versions may omit a stable error prefix. Do not show
        # the trailing caret or truncation notice as the diagnostic; choose the
        # last useful human-readable line instead.
        useful_lines = [
            line
            for line in lines
            if not line.startswith("^")
            and "source not shown" not in line.lower()
        ]
        message = useful_lines[-1] if useful_lines else "syntax-check failed"
    return [{
        "line": 1, "column": 1, "severity": "error",
        "message": message.strip(),
        "source": name,
    }], _linter(name, ran=True, available=True)


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


def _yamllint(content: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Generic YAML lint via `yamllint -f parsable` (stdin). For CI pipeline
    files, which are YAML but not Ansible playbooks. Skips when absent."""
    if shutil.which("yamllint") is None:
        return [], _linter("yamllint", ran=False, available=False,
                           reason="yamllint not on PATH")
    try:
        # `relaxed` ruleset: surfaces genuine YAML problems but silences purely
        # cosmetic opinions (line-length, document-start, trailing-newline) that
        # are normal in CI pipeline files — those should never read as errors.
        proc = subprocess.run(
            ["yamllint", "-d", "relaxed", "-f", "parsable", "-"],
            input=content, capture_output=True, text=True, timeout=30,
        )
    except Exception as e:  # timeout / OSError
        return [], _linter("yamllint", ran=False, available=True, reason=str(e))
    diags: list[dict[str, Any]] = []
    for line in proc.stdout.splitlines():
        m = _YAMLLINT_RE.match(line.strip())
        if not m:
            continue
        sev = m.group(3).lower()
        diags.append({
            "line": int(m.group(1)),
            "column": int(m.group(2)),
            "severity": "error" if sev == "error" else "warning",
            "message": m.group(4).strip() or "yamllint finding",
            "source": "yamllint",
        })
    return diags, _linter("yamllint", ran=True, available=True)


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
    elif _is_ci_pipeline(file_path):
        # CI/CD pipeline YAML (GitLab CI, GitHub Actions) — generic YAML, NOT an
        # Ansible playbook. Lint as plain YAML to avoid false playbook errors.
        y_diags, y_linter = _yamllint(content)
        diagnostics.extend(y_diags)
        linters.append(y_linter)
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

    return {"diagnostics": diagnostics, "linters": linters}
