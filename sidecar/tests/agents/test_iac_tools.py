"""Tests for the gated iac_apply agent tool (Phase 2, Task 2).

The tool classifies blast radius (for the approval modal), then on execution
runs the apply and returns a parsed result. Subprocess/classifier are injected
so tests need no real terraform.
"""
from __future__ import annotations

from ccie_sidecar.agents.iac_tools import (
    build_iac_apply_tool,
    _apply_summary,
    _make_noninteractive,
)


def test_tool_metadata_tagged_for_gating():
    tool = build_iac_apply_tool()
    # Always gated: tagged so HITL/interrupt treats it as approval-required.
    assert tool.metadata.get("blast_radius") in ("high", "destructive")
    assert tool.name == "iac_apply"


def test_apply_summary_terraform_success():
    out = "\n".join([
        "aws_s3_bucket.a: Creating...",
        "aws_s3_bucket.a: Creation complete after 1s [id=a]",
        "Apply complete! Resources: 1 added, 0 changed, 0 destroyed.",
    ])
    summary = _apply_summary("terraform", 0, out, "")
    assert "1 added" in summary or "complete" in summary.lower()
    assert "✅" in summary or "succeeded" in summary.lower()


def test_apply_summary_failure_surfaces_stderr():
    summary = _apply_summary("terraform", 1, "", "Error: bucket already exists")
    assert "bucket already exists" in summary
    assert "fail" in summary.lower() or "❌" in summary


def test_tool_runs_apply_via_injected_runner():
    calls = {}

    def fake_runner(cmd, cwd, timeout):
        calls["cmd"] = cmd
        calls["cwd"] = cwd
        return (0, "Apply complete! Resources: 2 added, 0 changed, 0 destroyed.", "")

    tool = build_iac_apply_tool(apply_runner=fake_runner)
    result = tool.func(working_dir="/infra/dev", command="terraform apply")

    assert calls["cwd"] == "/infra/dev"
    assert "terraform" in calls["cmd"][0]
    assert "apply" in calls["cmd"]
    assert "2 added" in result


def test_tool_rejects_non_mutating_command():
    # iac_apply is for mutating ops; a plan/get should be refused (use read path).
    tool = build_iac_apply_tool(apply_runner=lambda *a, **k: (0, "", ""))
    result = tool.func(working_dir="/infra/dev", command="terraform plan")
    assert "not a mutating" in result.lower() or "refus" in result.lower()


# --- non-interactive execution (regression: bare `terraform apply` hung on the
# interactive "Enter a value:" prompt and held the state lock) ----------------

def test_bare_apply_made_noninteractive():
    # Human already approved at the modal, so suppress terraform's own prompt.
    assert _make_noninteractive(["terraform", "apply"]) == [
        "terraform", "apply", "-input=false", "-auto-approve",
    ]


def test_destroy_made_noninteractive():
    assert _make_noninteractive(["terraform", "destroy"]) == [
        "terraform", "destroy", "-input=false", "-auto-approve",
    ]


def test_saved_plan_does_not_get_auto_approve():
    # terraform rejects `apply -auto-approve <plan>`; a saved plan never prompts.
    out = _make_noninteractive(["terraform", "apply", "tfplan"])
    assert "-auto-approve" not in out
    assert "-input=false" in out
    assert "tfplan" in out


def test_noninteractive_is_idempotent():
    out = _make_noninteractive(["terraform", "apply", "-auto-approve", "-input=false"])
    assert out.count("-auto-approve") == 1
    assert out.count("-input=false") == 1


def test_ansible_playbook_left_untouched():
    # ansible-playbook doesn't prompt for confirmation; don't add terraform flags.
    cmd = ["ansible-playbook", "-i", "prod", "site.yml"]
    assert _make_noninteractive(cmd) == cmd


def test_tool_injects_noninteractive_flags_into_runner():
    # End-to-end through the tool: the command handed to the runner must be the
    # non-interactive form, never the bare prompting one.
    calls = {}

    def fake_runner(cmd, cwd, timeout):
        calls["cmd"] = cmd
        return (0, "Apply complete! Resources: 1 added, 0 changed, 0 destroyed.", "")

    tool = build_iac_apply_tool(apply_runner=fake_runner)
    tool.func(working_dir="/infra/dev", command="terraform apply")
    assert "-auto-approve" in calls["cmd"]
    assert "-input=false" in calls["cmd"]


def test_default_runner_closes_stdin():
    # The real runner must pass stdin=DEVNULL so a prompt can't hang forever.
    import inspect
    from ccie_sidecar.agents import iac_tools
    src = inspect.getsource(iac_tools._default_apply_runner)
    assert "stdin=subprocess.DEVNULL" in src
