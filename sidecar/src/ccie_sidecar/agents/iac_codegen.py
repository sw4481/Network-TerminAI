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
import re
import shutil
import subprocess
import tempfile
from typing import Any, Callable, Optional

LlmFn = Callable[[str], str]

# Strips ANSI color escape sequences (terraform colorizes its stderr). Without
# this, validator error strings reach the diff preview as raw `\x1b[31m…` noise.
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def _clean_error(text: str) -> str:
    """Strip ANSI escapes and trim whitespace from a validator error string."""
    return _ANSI_RE.sub("", text or "").strip()


def _default_llm(prompt: str) -> str:
    """Placeholder. The runtime builds a real chat model and injects it; the
    RPC/tool layer never relies on this."""
    raise NotImplementedError("iac_codegen requires an injected llm callable")


def _normalize_newlines(code: str) -> str:
    """Repair escaped newlines a model sometimes double-encodes inside JSON.

    Some models return JSON whose ``code`` value contains the literal two-char
    sequence ``\\n`` instead of a real newline, so after ``json.loads`` the
    whole file collapses onto one physical line (invalid YAML/HCL). Only repair
    when the string has escaped newlines but NO real ones — that unambiguously
    signals the mis-encoding and can't corrupt genuinely multi-line code that
    happens to also contain a literal ``\\n`` in a string. Also collapses
    escaped CRLF/CR. Never raises.
    """
    if not isinstance(code, str) or not code:
        return code
    if "\n" in code:
        return code  # already has real newlines — leave untouched
    if "\\n" not in code and "\\r" not in code:
        return code  # nothing to repair (e.g. a genuine one-liner)
    return code.replace("\\r\\n", "\n").replace("\\r", "\n").replace("\\n", "\n")


def _loads_lenient(raw: str) -> dict:
    """Parse a JSON object from an LLM response that may be wrapped in a
    ```json fence or surrounded by prose. Tries strict parse first, then strips
    a markdown fence, then extracts the outermost {...} span. Raises ValueError
    if nothing parses — callers already treat that as 'unavailable'.
    """
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("empty LLM response")
    # 1) strict
    try:
        return json.loads(raw)
    except Exception:
        pass
    # 2) strip a wrapping ```json ... ``` fence, then retry
    fenced = re.match(r"^\s*```[a-zA-Z0-9_-]*\s*\n(.*?)\n\s*```\s*$", raw.strip(), re.DOTALL)
    if fenced:
        try:
            return json.loads(fenced.group(1))
        except Exception:
            pass
    # 3) extract the outermost {...} span and parse that
    start = raw.find("{")
    end = raw.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(raw[start : end + 1])
        except Exception:
            pass
    raise ValueError("no parseable JSON object in LLM response")


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
        f"- Naming pattern: {conventions.get('naming_pattern', 'snake_case')}\n"
        f"- Existing .tf files: {', '.join(conventions.get('existing_files', [])) or 'none'}\n\n"
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
        parsed = _loads_lenient(raw)
        code = parsed["code"]
        if not isinstance(code, str) or not code.strip():
            raise ValueError("empty code")
        code = _normalize_newlines(code)
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
                retry_parsed = _loads_lenient(call(retry_prompt))
                retry_code = retry_parsed["code"]
                if not isinstance(retry_code, str) or not retry_code.strip():
                    raise ValueError("empty code on retry")
                retry_code = _normalize_newlines(retry_code)
                # Commit the retry results atomically only after full success.
                parsed = retry_parsed
                code = retry_code
                validation = validate_terraform_syntax(code)
            except Exception:
                pass  # Keep the original parsed/code/validation on retry failure.

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


def validate_terraform_syntax(code: str) -> dict[str, Any]:
    """Validate HCL with `terraform fmt` (parses HCL, needs no providers/init).

    Skips gracefully when the terraform binary is absent. `terraform fmt -` reads
    stdin and exits non-zero / writes to stderr on malformed HCL. This validates
    HCL *syntax* only (via fmt's parser), not Terraform semantics — code that
    passes may still fail at apply with provider/semantic errors. Never raises.
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
            "error": None if ok else _clean_error(proc.stderr or proc.stdout),
        }
    except Exception as e:  # subprocess timeout / OSError — treat as skip
        return {"valid": None, "skipped": True, "error": str(e)}


def _build_ansible_prompt(intent: str, context: dict, roles: list[str]) -> str:
    existing = str(context.get("existing_code", "") or "").strip()

    # When the user has a playbook open, EDIT it: return the full updated file
    # with the requested change merged in, preserving their existing plays,
    # tasks, comments, and structure. Otherwise generate a fresh playbook.
    if existing:
        base = (
            "You are editing an EXISTING Ansible playbook. Add the requested "
            "change to it and return the COMPLETE updated playbook — keep all "
            "existing plays, tasks, vars, and comments; only add/modify what the "
            "request needs.\n\n"
            f"Request: {intent}\n\n"
            "EXISTING PLAYBOOK (edit this):\n"
            "```yaml\n"
            f"{existing}\n"
            "```\n\n"
        )
    else:
        base = (
            "Generate an Ansible playbook (YAML) for the following requirement.\n\n"
            f"Intent: {intent}\n\n"
            "Context:\n"
            f"- Target hosts: {context.get('target_hosts', [])}\n"
            f"- Available roles: {', '.join(roles) or 'none'}\n"
            f"- Inventory: {context.get('inventory_path', 'unknown')}\n\n"
        )

    return (
        base
        + "Rules:\n"
        "- For raw device CLI configuration (e.g. 'router eigrp 12', "
        "'network ...', 'passive-interface default'), use the "
        "cisco.ios.ios_config module with a `lines:` list (and `parents:` for "
        "sub-mode commands). Do NOT invent modules like ios_eigrp — they do not "
        "exist. Prefer ios_config for anything that is plain IOS CLI.\n"
        "- Keep it idempotent, use clear task names, and valid YAML.\n\n"
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
        parsed = _loads_lenient(call(prompt))
        code = parsed["playbook"]
        if not isinstance(code, str) or not code.strip():
            raise ValueError("empty playbook")
        code = _normalize_newlines(code)
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
                retry_parsed = _loads_lenient(call(retry_prompt))
                retry_code = retry_parsed["playbook"]
                if not isinstance(retry_code, str) or not retry_code.strip():
                    raise ValueError("empty playbook on retry")
                retry_code = _normalize_newlines(retry_code)
                # Commit retry results atomically only after full success.
                parsed = retry_parsed
                code = retry_code
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
    """Validate a playbook with `ansible-playbook --syntax-check`.

    Writes the YAML to a temp file (the CLI needs a path) and runs the check,
    which parses without connecting to any host. A minimal inline inventory
    (`localhost,`) is supplied so host-group references don't cause false syntax
    failures. Skips when the binary is absent. Never raises.
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
                ["ansible-playbook", "-i", "localhost,", "--syntax-check", fh.name],
                capture_output=True,
                text=True,
                timeout=30,
            )
        ok = proc.returncode == 0
        return {
            "valid": ok,
            "skipped": False,
            "error": None if ok else _clean_error(proc.stderr or proc.stdout),
        }
    except Exception as e:
        return {"valid": None, "skipped": True, "error": str(e)}


# --- CI/CD pipeline generation --------------------------------------------
# A pipeline file (.gitlab-ci.yml / .github/workflows/*.yml) is generic YAML —
# NOT Terraform HCL and NOT an Ansible playbook. Validating it with
# `terraform fmt` or `ansible-playbook --syntax-check` produces false failures,
# so pipelines get their own generator that validates as plain YAML.

_PIPELINE_TARGETS = {
    ("github", "terraform"): ".github/workflows/terraform.yml",
    ("github", "ansible"): ".github/workflows/ansible.yml",
    ("gitlab", "terraform"): ".gitlab-ci.yml",
    ("gitlab", "ansible"): ".gitlab-ci.yml",
}


def _build_pipeline_prompt(platform: str, tool: str, flow: str, auth: str) -> str:
    platform_name = "GitHub Actions" if platform == "github" else "GitLab CI"
    target = ".github/workflows/" if platform == "github" else ".gitlab-ci.yml"
    return (
        f"Generate a {platform_name} CI/CD pipeline ({target}) for a {tool} "
        f'project implementing "{flow}".'
        + (f" Auth/environment: {auth}." if auth.strip() else "")
        + "\n\nThe pipeline must be valid YAML for the target platform. Use real "
        "newlines, not escaped ones.\n\n"
        'Respond ONLY as JSON: {"code": "<yaml>", "filename": "<name>.yml", '
        '"explanation": "<one sentence>", "estimated_apply_time_seconds": <int>}'
    )


_FENCE_RE = re.compile(r"^\s*```[a-zA-Z0-9_-]*\s*\n(.*?)\n\s*```\s*$", re.DOTALL)


def _strip_code_fence(code: str) -> str:
    """Remove a surrounding ```lang ... ``` markdown fence some models add.

    Only strips when the WHOLE string is one fenced block, so legitimate
    backticks inside the YAML are never touched. Never raises.
    """
    if not isinstance(code, str):
        return code
    m = _FENCE_RE.match(code.strip())
    return m.group(1) if m else code


def _normalize_real_newlines(code: str) -> str:
    """Convert real CRLF/CR line endings to LF. Distinct from
    _normalize_newlines, which repairs *escaped* (``\\n``) endings. Never raises."""
    if not isinstance(code, str) or not code:
        return code
    return code.replace("\r\n", "\n").replace("\r", "\n")


def _ensure_trailing_newline(code: str) -> str:
    """Guarantee a single trailing newline (POSIX text-file convention).

    Many models omit it; without it CI tools / yamllint complain. Cheap to fix
    at generation time so every written pipeline file is clean."""
    if not isinstance(code, str) or not code:
        return code
    return code if code.endswith("\n") else code + "\n"


def validate_pipeline_yaml(code: str) -> dict[str, Any]:
    """Validate CI pipeline output by PARSING it as YAML (the only real measure
    of validity for a pipeline file).

    A pipeline file (`.gitlab-ci.yml`, `.github/workflows/*.yml`) is generic
    YAML, NOT Terraform HCL or an Ansible playbook — so we never run
    `terraform fmt`/`ansible-playbook`. We also do NOT use yamllint here: that
    is a STYLE linter (line length, document-start, trailing newline) and would
    falsely fail perfectly valid pipelines. Validity == "does it parse". Style
    hints still surface in the editor's Phase B Problems panel once the file is
    open. Never raises.
    """
    try:
        import yaml  # PyYAML — always present in the sidecar venv
    except Exception as e:  # pragma: no cover — yaml is a hard dep
        return {"valid": None, "skipped": True, "error": f"yaml unavailable: {e}"}
    try:
        yaml.safe_load(code)
        return {"valid": True, "skipped": False, "error": None}
    except yaml.YAMLError as e:
        # Surface a concise, ANSI-free parse error (mark/problem if available).
        msg = getattr(e, "problem", None) or str(e).splitlines()[0]
        mark = getattr(e, "problem_mark", None)
        if mark is not None:
            msg = f"line {mark.line + 1}, column {mark.column + 1}: {msg}"
        return {"valid": False, "skipped": False, "error": _clean_error(str(msg))}


def generate_pipeline(
    intent: str,
    context: dict,
    llm: Optional[LlmFn] = None,
    validate: bool = True,
) -> dict[str, Any]:
    """Generate a CI/CD pipeline YAML from natural-language intent. Never raises.

    `context` carries `platform` ("github"|"gitlab"), `tool`
    ("terraform"|"ansible"), `flow` (human label), and `auth` (free text). The
    output is validated as YAML, never as HCL/playbook. Returns the same shape
    as generate_terraform_code with tool="pipeline".
    """
    call = llm or _default_llm
    platform = str(context.get("platform", "github")).lower()
    tool = str(context.get("tool", "terraform")).lower()
    flow = str(context.get("flow", "plan on PR, apply on merge"))
    auth = str(context.get("auth", ""))
    # Compose the prompt from structured fields; `intent` (if provided) augments.
    prompt = _build_pipeline_prompt(platform, tool, flow, auth)
    if intent and intent.strip():
        prompt += f"\n\nAdditional detail: {intent.strip()}"
    try:
        parsed = _loads_lenient(call(prompt))
        code = parsed["code"]
        if not isinstance(code, str) or not code.strip():
            raise ValueError("empty pipeline")
        # Clean up common LLM quirks so output is bulletproof across models:
        # repair escaped newlines, strip a wrapping markdown fence, normalize
        # real CRLF/CR to LF, ensure a trailing newline.
        code = _ensure_trailing_newline(
            _normalize_real_newlines(_strip_code_fence(_normalize_newlines(code)))
        )
    except Exception:
        result = _unavailable("pipeline")
        return result

    validation = {"valid": None, "skipped": True, "error": None}
    if validate:
        validation = validate_pipeline_yaml(code)

    default_name = _PIPELINE_TARGETS.get((platform, tool), "pipeline.yml")
    default_name = default_name.rsplit("/", 1)[-1]
    return {
        "tool": "pipeline",
        "code": code,
        "filename": parsed.get("filename", default_name),
        "explanation": parsed.get("explanation", ""),
        "estimated_apply_time_seconds": parsed.get("estimated_apply_time_seconds", 0),
        "validation": validation,
        "unavailable": False,
    }
