"""IaC Phase 4 — NL→code generation pure functions (injected LLM, no network)."""
import json

from ccie_sidecar.agents.iac_codegen import (
    generate_terraform_code,
    generate_ansible_playbook,
    generate_pipeline,
    validate_pipeline_yaml,
    _clean_error,
)
from ccie_sidecar.agents import iac_codegen


def _pipeline_llm(code: str):
    """Stub LLM returning a fixed pipeline `code` payload."""
    def _call(_prompt: str) -> str:
        return json.dumps({
            "code": code, "filename": "pipeline.yml",
            "explanation": "", "estimated_apply_time_seconds": 1,
        })
    return _call


def _gen(code: str, validate: bool = True):
    return generate_pipeline(
        "", {"platform": "gitlab", "tool": "terraform"},
        llm=_pipeline_llm(code), validate=validate,
    )


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


def test_generate_terraform_retry_uses_retry_response_metadata(monkeypatch):
    """Regression test: retry path must atomically commit code + metadata from
    the RETRY response, not mix first-attempt metadata with retry code."""
    calls = {"n": 0}

    def fake_llm(prompt: str) -> str:
        calls["n"] += 1
        if calls["n"] == 1:
            return json.dumps({
                "code": "bad hcl {",
                "filename": "first.tf",
                "explanation": "first attempt",
                "estimated_apply_time_seconds": 10,
            })
        return json.dumps({
            "code": 'resource "x" "y" {}',
            "filename": "retry.tf",
            "explanation": "retry attempt",
            "estimated_apply_time_seconds": 20,
        })

    validations = [
        {"valid": False, "skipped": False, "error": "syntax error"},
        {"valid": True, "skipped": False, "error": None},
    ]

    def fake_validate(code: str):
        return validations.pop(0)

    monkeypatch.setattr(
        "ccie_sidecar.agents.iac_codegen.validate_terraform_syntax", fake_validate
    )

    result = generate_terraform_code(
        intent="make x",
        context={"project_path": "/tmp"},
        llm=fake_llm,
        validate=True,
    )

    assert result["filename"] == "retry.tf"
    assert result["explanation"] == "retry attempt"
    assert result["estimated_apply_time_seconds"] == 20
    assert 'resource "x" "y"' in result["code"]
    assert result["validation"]["valid"] is True
    assert result["unavailable"] is False


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


def test_loads_lenient_handles_fences_and_prose():
    """The lenient parser recovers JSON from fenced / prose-wrapped output."""
    obj = {"playbook": "---\n- hosts: all\n", "filename": "x.yml"}
    fenced = "```json\n" + json.dumps(obj) + "\n```"
    prosed = "Sure! Here you go:\n" + json.dumps(obj) + "\nHope that helps."
    assert iac_codegen._loads_lenient(json.dumps(obj))["filename"] == "x.yml"
    assert iac_codegen._loads_lenient(fenced)["filename"] == "x.yml"
    assert iac_codegen._loads_lenient(prosed)["filename"] == "x.yml"


def test_generate_ansible_recovers_from_fenced_json():
    """A model that wraps its JSON in a ```json fence still yields a playbook."""
    payload = json.dumps({
        "playbook": "---\n- hosts: all\n  tasks: []\n",
        "filename": "eigrp.yml",
        "explanation": "adds eigrp",
        "target_host_count": 1,
    })
    result = generate_ansible_playbook(
        intent="add eigrp",
        context={},
        llm=lambda p: "```json\n" + payload + "\n```",
        validate=False,
    )
    assert result["unavailable"] is False
    assert result["filename"] == "eigrp.yml"


def test_ansible_prompt_includes_existing_code_and_edit_instruction():
    """When existing_code is present the prompt asks the model to EDIT it and
    steers CLI config toward ios_config (not invented modules)."""
    existing = "---\n- name: Gather IOS device facts\n  hosts: all\n"
    prompt = iac_codegen._build_ansible_prompt(
        "add router eigrp 12", {"existing_code": existing}, []
    )
    assert "EXISTING PLAYBOOK" in prompt
    assert "Gather IOS device facts" in prompt  # the actual file content
    assert "COMPLETE updated playbook" in prompt
    assert "ios_config" in prompt
    assert "ios_eigrp" in prompt  # the "do NOT invent" guard names it


def test_generate_ansible_retry_uses_retry_response_metadata(monkeypatch):
    """Verify Ansible retry path atomically commits code + metadata from retry."""
    calls = {"n": 0}

    def fake_llm(prompt: str) -> str:
        calls["n"] += 1
        if calls["n"] == 1:
            return json.dumps({
                "playbook": "bad yaml {",
                "filename": "first.yml",
                "explanation": "first attempt",
                "target_host_count": 5,
            })
        return json.dumps({
            "playbook": "---\n- hosts: all\n",
            "filename": "retry.yml",
            "explanation": "retry attempt",
            "target_host_count": 10,
        })

    validations = [
        {"valid": False, "skipped": False, "error": "syntax error"},
        {"valid": True, "skipped": False, "error": None},
    ]

    monkeypatch.setattr(
        "ccie_sidecar.agents.iac_codegen.validate_ansible_syntax",
        lambda code: validations.pop(0),
    )

    result = generate_ansible_playbook(
        intent="deploy app", context={}, llm=fake_llm, validate=True
    )

    assert result["filename"] == "retry.yml"
    assert result["explanation"] == "retry attempt"
    assert "- hosts: all" in result["code"]
    assert result["validation"]["valid"] is True
    assert result["unavailable"] is False


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


def test_validate_ansible_runs_check_when_present(monkeypatch):
    monkeypatch.setattr(shutil, "which", lambda name: "/usr/bin/ansible-playbook")

    class FakeProc:
        returncode = 0
        stdout = ""
        stderr = ""

    monkeypatch.setattr(
        "ccie_sidecar.agents.iac_codegen.subprocess.run",
        lambda *a, **k: FakeProc(),
    )
    result = validate_ansible_syntax("---\n- hosts: all\n  tasks: []\n")
    assert result["skipped"] is False
    assert result["valid"] is True


def test_validate_ansible_reports_invalid(monkeypatch):
    monkeypatch.setattr(shutil, "which", lambda name: "/usr/bin/ansible-playbook")

    class FakeProc:
        returncode = 1
        stdout = ""
        stderr = "ERROR! Syntax Error while loading YAML"

    monkeypatch.setattr(
        "ccie_sidecar.agents.iac_codegen.subprocess.run",
        lambda *a, **k: FakeProc(),
    )
    result = validate_ansible_syntax("---\n- bad: {\n")
    assert result["valid"] is False
    assert "Syntax Error" in result["error"]


def test_terraform_repairs_literal_escaped_newlines():
    # Some models double-encode newlines: after json.loads the `code` value is a
    # single physical line full of literal "\n". The generator must repair it so
    # the written file is valid multi-line HCL, not one broken line.
    def fake_llm(prompt: str) -> str:
        return json.dumps({
            "code": 'resource "aws_instance" "web" {\\n  ami = "ami-123"\\n}\\n',
            "filename": "web.tf",
            "explanation": "an instance",
            "estimated_apply_time_seconds": 5,
        })

    result = generate_terraform_code(
        intent="make an instance", context={"project_path": "/tmp"},
        llm=fake_llm, validate=False,
    )
    assert "\\n" not in result["code"]          # no literal escape sequences left
    assert result["code"].count("\n") >= 2      # real newlines present
    assert result["code"].startswith('resource "aws_instance" "web" {')


def test_ansible_repairs_literal_escaped_newlines():
    def fake_llm(prompt: str) -> str:
        return json.dumps({
            "playbook": "---\\n- hosts: all\\n  tasks: []\\n",
            "filename": "play.yml",
            "explanation": "a playbook",
            "target_host_count": 1,
        })

    result = generate_ansible_playbook(
        intent="ping hosts", context={"roles_path": "/tmp"},
        llm=fake_llm, validate=False,
    )
    assert "\\n" not in result["code"]
    assert result["code"].count("\n") >= 2
    assert result["code"].startswith("---\n- hosts: all")


def test_normal_multiline_code_is_left_untouched():
    # Genuine multi-line code that ALSO contains a literal "\n" inside a string
    # must NOT be mangled — the repair only fires when there are no real newlines.
    original = 'resource "x" "y" {\n  s = "line1\\nline2"\n}\n'

    def fake_llm(prompt: str) -> str:
        return json.dumps({
            "code": original, "filename": "x.tf",
            "explanation": "", "estimated_apply_time_seconds": 1,
        })

    result = generate_terraform_code(
        intent="x", context={"project_path": "/tmp"}, llm=fake_llm, validate=False,
    )
    assert result["code"] == original  # untouched: real newlines already present


def test_clean_error_strips_ansi_escapes():
    raw = "\x1b[31m\x1b[1mError:\x1b[0m bad \x1b[0msyntax\x1b[0m"
    assert _clean_error(raw) == "Error: bad syntax"


def test_pipeline_generates_yaml_with_pipeline_tool():
    def fake_llm(prompt: str) -> str:
        # Prompt must steer the model toward the right platform.
        assert "GitLab CI" in prompt
        return json.dumps({
            "code": "stages:\n  - plan\n  - apply\n",
            "filename": ".gitlab-ci.yml",
            "explanation": "GitLab pipeline",
            "estimated_apply_time_seconds": 5,
        })

    result = generate_pipeline(
        intent="",
        context={"platform": "gitlab", "tool": "terraform",
                 "flow": "plan-on-PR + apply-on-merge", "auth": "AWS via OIDC"},
        llm=fake_llm, validate=False,
    )
    assert result["tool"] == "pipeline"
    assert result["code"].startswith("stages:")
    assert result["filename"] == ".gitlab-ci.yml"
    assert result["unavailable"] is False


def test_pipeline_folds_auth_and_flow_into_prompt():
    seen = {}

    def fake_llm(prompt: str) -> str:
        seen["prompt"] = prompt
        return json.dumps({"code": "on: push\n", "filename": "terraform.yml",
                           "explanation": "", "estimated_apply_time_seconds": 1})

    generate_pipeline(
        intent="add a lint stage",
        context={"platform": "github", "tool": "terraform",
                 "flow": "plan-on-PR only", "auth": "AWS via OIDC"},
        llm=fake_llm, validate=False,
    )
    assert "GitHub Actions" in seen["prompt"]
    assert "plan-on-PR only" in seen["prompt"]
    assert "AWS via OIDC" in seen["prompt"]
    assert "add a lint stage" in seen["prompt"]  # intent augments the prompt


def test_pipeline_repairs_literal_escaped_newlines():
    def fake_llm(prompt: str) -> str:
        return json.dumps({
            "code": "stages:\\n  - plan\\n  - apply\\n",
            "filename": ".gitlab-ci.yml", "explanation": "",
            "estimated_apply_time_seconds": 1,
        })

    result = generate_pipeline(
        intent="", context={"platform": "gitlab", "tool": "terraform"},
        llm=fake_llm, validate=False,
    )
    assert "\\n" not in result["code"]
    assert result["code"].count("\n") >= 2


def test_pipeline_degrades_on_bad_llm_json():
    result = generate_pipeline(
        intent="", context={"platform": "github", "tool": "terraform"},
        llm=lambda p: "not json", validate=False,
    )
    assert result["unavailable"] is True
    assert result["tool"] == "pipeline"
    assert result["code"] == ""


def test_pipeline_validation_uses_yaml_not_terraform(monkeypatch):
    # The pipeline validator must call validate_pipeline_yaml, NEVER
    # terraform fmt / ansible-playbook — a CI YAML file is neither.
    calls = []
    monkeypatch.setattr(iac_codegen, "validate_pipeline_yaml",
                        lambda code: calls.append("yaml") or {"valid": True, "skipped": False, "error": None})
    monkeypatch.setattr(iac_codegen, "validate_terraform_syntax",
                        lambda code: calls.append("tf") or {"valid": False, "skipped": False, "error": "should not run"})
    monkeypatch.setattr(iac_codegen, "validate_ansible_syntax",
                        lambda code: calls.append("ansible") or {"valid": False, "skipped": False, "error": "should not run"})

    def fake_llm(prompt: str) -> str:
        return json.dumps({"code": "stages:\n  - plan\n", "filename": ".gitlab-ci.yml",
                           "explanation": "", "estimated_apply_time_seconds": 1})

    result = generate_pipeline(
        intent="", context={"platform": "gitlab", "tool": "terraform"},
        llm=fake_llm, validate=True,
    )
    assert calls == ["yaml"]                 # only the YAML validator ran
    assert result["validation"]["valid"] is True


# --- Bulletproof-across-LLMs pipeline cases (distilled from a stress harness) ---
# Validity for a CI pipeline file means "does it PARSE as YAML", never yamllint
# style (line length, missing ---, trailing newline). These lock that in.

def test_validate_pipeline_yaml_accepts_valid_style_imperfect_yaml():
    # Long lines, no `---`, no trailing newline are all VALID YAML.
    code = 'stages:\n  - plan\nscript:\n  - ' + ("a" * 200) + '\nx: 1'
    v = validate_pipeline_yaml(code)
    assert v["valid"] is True and v["skipped"] is False and v["error"] is None


def test_validate_pipeline_yaml_flags_genuinely_broken_yaml():
    v = validate_pipeline_yaml("stages:\n\t- plan\n")  # tab indentation is illegal
    assert v["valid"] is False
    assert v["error"] and "\x1b" not in v["error"]  # concise, ANSI-free


def test_pipeline_no_trailing_newline_is_valid_and_gets_one():
    r = _gen("stages:\n  - plan\n  - apply")  # model omitted trailing newline
    assert r["validation"]["valid"] is True
    assert r["code"].endswith("\n")


def test_pipeline_long_lines_are_valid():
    r = _gen('script:\n  - ' + ("x" * 300) + '\n')
    assert r["validation"]["valid"] is True


def test_pipeline_no_document_start_is_valid():
    r = _gen('name: CI\non:\n  push:\n    branches: [main]\n')
    assert r["validation"]["valid"] is True


def test_pipeline_strips_markdown_code_fence():
    r = _gen("```yaml\nstages:\n  - plan\n```")
    assert "```" not in r["code"]
    assert r["code"].startswith("stages:")
    assert r["validation"]["valid"] is True


def test_pipeline_strips_fence_without_language_tag():
    r = _gen("```\nstages:\n  - plan\n```")
    assert "```" not in r["code"]
    assert r["validation"]["valid"] is True


def test_pipeline_normalizes_real_crlf_endings():
    r = _gen("stages:\r\n  - plan\r\n  - apply\r\n")
    assert "\r" not in r["code"]
    assert r["validation"]["valid"] is True


def test_pipeline_preserves_backticks_inside_yaml():
    # A genuine backtick inside the YAML must NOT be mistaken for a code fence.
    r = _gen("script:\n  - echo `date`\n")
    assert "`date`" in r["code"]
    assert r["validation"]["valid"] is True


def test_pipeline_flags_broken_yaml_invalid():
    r = _gen("a: b: c: d\n")  # invalid mapping
    assert r["validation"]["valid"] is False
