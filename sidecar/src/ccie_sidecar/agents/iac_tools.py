"""Gated IaC agent tools (Phase 2).

`iac_apply` lets an agent run a mutating terraform/ansible operation. It is
ALWAYS routed through human approval: the deepagents runtime registers it in
`interrupt_on`, so the graph pauses and the frontend shows an IaCApprovalModal
with the computed blast radius before the apply runs.

Why "always gate" rather than dynamic tiering: deepagents `interrupt_on` keys on
the tool NAME, not a per-call tier. So the tool is tagged high/destructive and
always pauses; the modal surfaces the actual blast radius (low..destructive) for
the human's decision. Classification still runs (for the modal + audit), it just
doesn't decide *whether* to gate — gating is unconditional for applies.
"""
from __future__ import annotations

import os
import subprocess
from typing import Any, Callable, Optional

from langchain_core.tools import StructuredTool

# Terraform subcommands that change real infrastructure.
_TF_MUTATING = {"apply", "destroy", "import", "taint", "untaint"}

# (exit_code, stdout, stderr)
ApplyResult = tuple[int, str, str]
ApplyRunner = Callable[[list[str], str, int], ApplyResult]


def _default_apply_runner(cmd: list[str], cwd: str, timeout: int) -> ApplyResult:
    """Run an apply command, returning (exit_code, stdout, stderr).

    stdin is DEVNULL: an interactive prompt (terraform's "Enter a value:") would
    otherwise block forever waiting on stdin the sidecar never provides — which
    is exactly how a bare `terraform apply` hung and held the state lock. With no
    stdin, terraform fails fast instead of hanging. `_make_noninteractive` also
    suppresses the prompt up front; DEVNULL is the belt-and-suspenders backstop.
    """
    proc = subprocess.run(
        cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout,
        stdin=subprocess.DEVNULL,
    )
    return (proc.returncode, proc.stdout, proc.stderr)


def _make_noninteractive(toks: list[str]) -> list[str]:
    """Make a mutating IaC command run without prompting for input.

    Human approval already happened at the modal, so the CLI's own confirmation
    prompt is both redundant and fatal (it hangs the headless subprocess). For
    terraform we inject `-input=false` (never prompt for variables) and, for a
    bare apply/destroy, `-auto-approve`. We do NOT add `-auto-approve` when a
    saved plan file is given (terraform rejects the combination) — a saved plan
    already implies approval and never prompts.
    """
    if not toks:
        return toks
    head = os.path.basename(toks[0]).lower()
    if head not in ("terraform", "tf"):
        # ansible-playbook does not prompt for confirmation by default.
        return toks

    rest = toks[1:]
    sub = next((t for t in rest if not t.startswith("-")), "")
    out = list(toks)

    if "-input=false" not in out:
        out.append("-input=false")

    if sub in ("apply", "destroy"):
        # A positional arg after apply (not a flag) is a saved plan file → no
        # -auto-approve (terraform errors on the combo and won't prompt anyway).
        positionals = [t for t in rest if not t.startswith("-") and t != sub]
        has_saved_plan = sub == "apply" and len(positionals) > 0
        if not has_saved_plan and "-auto-approve" not in out:
            out.append("-auto-approve")
    return out


def _classify_command(command: str) -> tuple[Optional[str], Optional[str]]:
    """Return (tool, subcommand) for a mutating IaC command, else (None, None).

    tool is "terraform" | "ansible". Mirrors the Rust detector's mutating rules.
    """
    parts = command.strip().split()
    if not parts:
        return (None, None)
    head = parts[0]
    if head in ("terraform", "tf"):
        sub = parts[1] if len(parts) > 1 else ""
        return ("terraform", sub)
    if head == "ansible-playbook":
        return ("ansible", "playbook")  # playbooks are always mutating
    return (None, None)


def _is_mutating(tool: Optional[str], subcommand: Optional[str]) -> bool:
    if tool == "terraform":
        return subcommand in _TF_MUTATING
    if tool == "ansible":
        return True
    return False


def _apply_summary(tool: str, exit_code: int, stdout: str, stderr: str) -> str:
    """Build a concise, human-readable result for the agent's final answer."""
    if exit_code == 0:
        # Pull the terraform "Apply complete!" line if present, else last lines.
        for line in stdout.splitlines():
            if "Apply complete!" in line or "PLAY RECAP" in line:
                return f"✅ {tool} succeeded — {line.strip()}"
        tail = stdout.strip().splitlines()[-1:] or ["(no output)"]
        return f"✅ {tool} succeeded — {tail[0]}"
    detail = stderr.strip() or stdout.strip() or "(no error output)"
    # Keep it short for the chat surface.
    detail = detail.splitlines()[-1] if detail.splitlines() else detail
    return f"❌ {tool} failed (exit {exit_code}) — {detail}"


def build_iac_apply_tool(
    apply_runner: Optional[ApplyRunner] = None,
    timeout: int = 600,
) -> StructuredTool:
    """Build the gated iac_apply StructuredTool.

    Args:
        apply_runner: injectable runner (for tests); defaults to subprocess.
        timeout: apply timeout in seconds.
    """
    runner = apply_runner or _default_apply_runner

    def iac_apply(working_dir: str, command: str) -> str:
        """Run a mutating terraform/ansible command. REQUIRES human approval
        (the runtime pauses for an approval modal before this executes).

        Args:
            working_dir: project directory to run in.
            command: the full IaC command, e.g. "terraform apply" or
                "ansible-playbook -i prod site.yml".
        """
        tool, subcommand = _classify_command(command)
        if not _is_mutating(tool, subcommand):
            return (
                f"Refused: '{command}' is not a mutating IaC apply. Use a read "
                "operation (terraform plan / show) via execute_python_code instead."
            )
        try:
            argv = _make_noninteractive(command.split())
            exit_code, stdout, stderr = runner(argv, working_dir, timeout)
        except FileNotFoundError:
            return f"❌ {tool} not found on PATH in {working_dir}."
        except subprocess.TimeoutExpired:
            return f"❌ {tool} apply timed out after {timeout}s."
        return _apply_summary(tool or "iac", exit_code, stdout, stderr)

    tool = StructuredTool.from_function(
        func=iac_apply,
        name="iac_apply",
        description=(
            "Apply a mutating Infrastructure-as-Code change (terraform apply/"
            "destroy, ansible-playbook). This operation REQUIRES human approval — "
            "calling it pauses execution for an approval gate that shows the blast "
            "radius. Use ONLY for changes the user explicitly asked you to make. "
            "For read-only inspection (terraform plan/show, listing) use "
            "execute_python_code instead."
        ),
    )
    # Tagged so HITL/gating treats it as approval-required. interrupt_on keys on
    # the tool name, so this is belt-and-suspenders; the modal shows real risk.
    tool.metadata = {"blast_radius": "destructive"}
    return tool
