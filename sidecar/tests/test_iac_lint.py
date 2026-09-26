import shutil

import pytest

from ccie_sidecar import server as sidecar_server
from ccie_sidecar.agents import iac_lint

# These tests shell out to the real terraform / ansible-playbook binaries. Skip
# them when the tool isn't on PATH (e.g. CI runners without it); they still run
# locally where the tools are installed.
requires_terraform = pytest.mark.skipif(
    shutil.which("terraform") is None, reason="terraform not installed"
)
requires_ansible = pytest.mark.skipif(
    shutil.which("ansible-playbook") is None, reason="ansible-playbook not installed"
)


@requires_terraform
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


@requires_terraform
def test_terraform_valid_hcl_is_clean_via_fmt():
    good = 'locals {\n  x = 1\n}\n'
    result = iac_lint.lint_file(file_path="main.tf", content=good, language="hcl")
    # No syntax errors from fmt on well-formed HCL.
    assert [d for d in result["diagnostics"] if d["source"] == "terraform fmt"] == []


@requires_terraform
def test_terraform_validate_skipped_when_not_initialized(tmp_path):
    # A real path whose directory has no `.terraform/` → validate must be skipped
    # with a reason, NOT run (running it would emit a false provider error).
    f = tmp_path / "main.tf"
    f.write_text('locals {\n  x = 1\n}\n')
    result = iac_lint.lint_file(file_path=str(f), content=f.read_text(), language="hcl")
    validate = next(l for l in result["linters"] if l["name"] == "terraform validate")
    assert validate["ran"] is False
    assert validate["reason"] and "init" in validate["reason"].lower()


def test_ansible_lint_unavailable_is_honest(monkeypatch):
    # When neither ansible-lint nor ansible-playbook exist, the YAML path must
    # report unavailable — NOT silently return a clean result.
    monkeypatch.setattr(iac_lint.shutil, "which", lambda _name: None)
    play = "- hosts: all\n  tasks:\n    - ping:\n"
    result = iac_lint.lint_file(file_path="play.yml", content=play, language="yaml")
    # At least one ansible linter entry, all marked unavailable.
    ansible_entries = [l for l in result["linters"] if "ansible" in l["name"]]
    assert ansible_entries, result
    assert all(l["available"] is False for l in ansible_entries)


@pytest.mark.parametrize(
    ("stderr", "expected"),
    [
        (
            "ERROR! YAML parsing failed\n  debug: {{{\n             ^ here\n",
            "ERROR! YAML parsing failed",
        ),
        (
            "[ERROR]: YAML parsing failed\n(source not shown: file truncated)\n",
            "[ERROR]: YAML parsing failed",
        ),
        (
            "YAML parsing failed\n(source not shown: file truncated)\n^ here\n",
            "YAML parsing failed",
        ),
    ],
)
def test_ansible_syntax_check_selects_useful_error_across_versions(
    monkeypatch, stderr, expected
):
    monkeypatch.setattr(
        iac_lint.shutil,
        "which",
        lambda name: "/usr/bin/ansible-playbook" if name == "ansible-playbook" else None,
    )

    class FakeProc:
        stdout = ""
        returncode = 4

        def __init__(self, error_text):
            self.stderr = error_text

    monkeypatch.setattr(
        iac_lint.subprocess,
        "run",
        lambda *args, **kwargs: FakeProc(stderr),
    )

    diags, linter = iac_lint._ansible_syntax_check("- hosts: all\n")

    assert linter["ran"] is True
    assert diags[0]["message"] == expected


@requires_ansible
def test_ansible_syntax_fallback_runs_when_lint_absent(monkeypatch):
    # ansible-lint absent but ansible-playbook present → fallback runs.
    real_which = shutil.which

    def fake_which(name):
        if name == "ansible-lint":
            return None
        return real_which(name)

    monkeypatch.setattr(iac_lint.shutil, "which", fake_which)
    play = "- hosts: all\n  tasks:\n    - ansible.builtin.ping:\n"
    result = iac_lint.lint_file(file_path="play.yml", content=play, language="yaml")
    fallback = next(
        (l for l in result["linters"] if l["name"] == "ansible-playbook --syntax-check"),
        None,
    )
    assert fallback is not None and fallback["ran"] is True


@pytest.mark.skipif(
    shutil.which("ansible-playbook") is None,
    reason="ansible-playbook not installed",
)
def test_ansible_syntax_check_prefers_error_line():
    # A playbook with a malformed task triggers `ansible-playbook --syntax-check`
    # to emit an `ERROR!` line plus trailing unhelpful lines (caret pointers or
    # "(source not shown: file truncated)"). The diagnostic message should surface
    # the ERROR! line, not the trailing noise.
    broken = "- hosts: all\n  tasks:\n    - name: bad\n      debug: {{{\n"
    diags, linter = iac_lint._ansible_syntax_check(broken)
    assert linter["ran"] is True
    assert diags, "expected a syntax error diagnostic"
    msg = diags[0]["message"]
    # The message should start with [ERROR]: or contain "ERROR" meaningfully,
    # NOT be a caret pointer or truncation notice.
    assert "[ERROR]:" in msg or "ERROR" in msg.upper(), (
        f"message should contain the ERROR! line, got: {msg!r}"
    )
    assert "source not shown" not in msg.lower(), f"unhelpful truncation line: {msg!r}"
    assert msg.strip() != "^ here", f"unhelpful caret pointer: {msg!r}"


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


@requires_terraform
def test_terraform_fmt_message_has_no_ansi_codes():
    # `terraform fmt` colorizes stderr; the diagnostic message must be stripped
    # of ANSI escape codes so it renders cleanly in the Problems panel.
    bad = 'resource "aws_instance" "x" {\n  ami = \n}\n'
    result = iac_lint.lint_file(file_path="main.tf", content=bad, language="hcl")
    fmt_diags = [d for d in result["diagnostics"] if d["source"] == "terraform fmt"]
    assert fmt_diags, "expected a terraform fmt diagnostic"
    msg = fmt_diags[0]["message"]
    assert "\x1b" not in msg, f"message still contains ANSI escape: {msg!r}"
    # And the human-readable text should survive the stripping.
    assert "Invalid expression" in msg, msg


def test_gitlab_ci_yaml_routes_to_yamllint_not_ansible():
    # A .gitlab-ci.yml is YAML but NOT an Ansible playbook. It must be linted as
    # generic YAML (yamllint), never via ansible-lint/ansible-playbook, so it
    # never gets a false "empty playbook" error.
    if shutil.which("yamllint") is None:
        pytest.skip("yamllint not installed")
    content = "stages:\n  - plan\n  - apply\n"
    result = iac_lint.lint_file(
        file_path="/repo/.gitlab-ci.yml", content=content, language="yaml",
    )
    names = [l["name"] for l in result["linters"]]
    assert "yamllint" in names, result
    assert not any("ansible" in n for n in names), result


def test_github_workflow_yaml_routes_to_yamllint(monkeypatch):
    # A .github/workflows/*.yml must route to yamllint, not ansible — verified by
    # path even when language is "yaml".
    monkeypatch.setattr(
        iac_lint.shutil, "which",
        lambda name: "/usr/bin/yamllint" if name == "yamllint" else None,
    )

    class FakeProc:
        stdout = ""
        stderr = ""
        returncode = 0

    monkeypatch.setattr(iac_lint.subprocess, "run", lambda *a, **k: FakeProc())
    result = iac_lint.lint_file(
        file_path="/repo/.github/workflows/terraform.yml",
        content="on: push\n", language="yaml",
    )
    names = [l["name"] for l in result["linters"]]
    assert names == ["yamllint"], result
    assert not any("ansible" in n for n in names), result


def test_plain_yaml_still_routes_to_ansible():
    # A regular playbook .yml (not a CI file) must STILL go through the ansible
    # path — the CI routing must not hijack ordinary YAML.
    result = iac_lint.lint_file(
        file_path="/repo/site.yml", content="- hosts: all\n", language="yaml",
    )
    names = [l["name"] for l in result["linters"]]
    assert any("ansible" in n for n in names), result
    assert "yamllint" not in names, result
