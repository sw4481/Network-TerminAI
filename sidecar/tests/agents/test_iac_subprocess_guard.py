"""Tests for the IaC subprocess guard (Phase 2 hole-fix).

The approval gate on iac_apply is meaningless if execute_python_code can run
`subprocess.run(['terraform','apply'])` directly. This guard blocks mutating
terraform/ansible commands inside the code-exec sandbox (redirecting the model
to the gated iac_apply tool) while allowing read-only commands.

These tests run real code through the real sandbox — the level at which the
bypass actually happened.
"""
from __future__ import annotations

from ccie_sidecar.agents.iac_subprocess_guard import is_mutating_iac_command
from ccie_sidecar.agents.code_exec import _build_sandbox_globals, _execute_code_with_timeout


# --- pure detection ---

def test_detects_mutating_terraform():
    assert is_mutating_iac_command(["terraform", "apply", "-auto-approve"])
    assert is_mutating_iac_command("terraform destroy")
    assert is_mutating_iac_command(["tofu", "apply"])
    assert is_mutating_iac_command("terraform import aws_x.y id")


def test_allows_readonly_terraform():
    assert not is_mutating_iac_command(["terraform", "plan"])
    assert not is_mutating_iac_command("terraform show")
    assert not is_mutating_iac_command(["terraform", "validate"])
    assert not is_mutating_iac_command("terraform version")
    assert not is_mutating_iac_command(["terraform", "init"])


def test_ansible_mutation_vs_check():
    assert is_mutating_iac_command(["ansible-playbook", "-i", "prod", "site.yml"])
    assert not is_mutating_iac_command(["ansible-playbook", "--check", "site.yml"])
    assert not is_mutating_iac_command(["ansible-playbook", "-C", "site.yml"])


def test_non_iac_commands_pass():
    assert not is_mutating_iac_command(["echo", "hi"])
    assert not is_mutating_iac_command(["ls", "-la"])
    assert not is_mutating_iac_command("git status")


# --- end-to-end through the real IaC sandbox ---

def _run(globals_dict, code):
    return _execute_code_with_timeout(
        code=code, globals_dict=globals_dict, env_overrides={}, timeout=15
    )


def _blob(result):
    return (result.get("error", "") or "") + (result.get("output", "") or "")


def test_sandbox_blocks_mutating_iac_every_path():
    g = _build_sandbox_globals("iac", {})
    cases = [
        "import subprocess\nsubprocess.run(['terraform','apply','-auto-approve'])",
        "import os\nos.system('terraform destroy -auto-approve')",
        "import subprocess\nsubprocess.Popen(['ansible-playbook','-i','prod','site.yml'])",
        "import subprocess as sp\nsp.run('terraform apply')",
        "import subprocess\nsubprocess.check_call(['terraform','apply'])",
    ]
    for code in cases:
        assert "BLOCKED" in _blob(_run(g, code)), f"not blocked: {code!r}"


def test_sandbox_allows_readonly_and_noniac():
    g = _build_sandbox_globals("iac", {})
    # read-only / dry-run / non-iac must NOT be blocked (they may FileNotFound
    # since terraform/ansible aren't installed in CI — that's fine, not blocked)
    allowed = [
        "import subprocess\ntry:\n subprocess.run(['terraform','plan'])\nexcept FileNotFoundError: pass",
        "import subprocess\ntry:\n subprocess.run(['ansible-playbook','--check','s.yml'])\nexcept FileNotFoundError: pass",
        "import subprocess\nr=subprocess.run(['echo','hi'],capture_output=True,text=True)\nprint(r.stdout)",
    ]
    for code in allowed:
        assert "BLOCKED" not in _blob(_run(g, code)), f"wrongly blocked: {code!r}"


def test_guard_scoped_to_iac_agents_only():
    # meraki/pyats sandboxes must be unguarded — `import os` gives the real module.
    for pkg in ("meraki", "pyats", None):
        g = _build_sandbox_globals(pkg, {})
        r = _run(g, "import os\nprint(type(os).__name__)")
        assert "module" in (r.get("output", "") or ""), f"{pkg} should be unguarded"
