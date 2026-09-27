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


def test_default_llm_builds_model_once(monkeypatch):
    """The default LLM path builds the chat model lazily and reuses it."""
    build_calls = {"n": 0}

    class FakeModel:
        def invoke(self, messages):
            class R:
                content = '{"code": "resource \\"x\\" \\"y\\" {}", "filename": "x.tf", "explanation": "ok"}'
            return R()

    def fake_build(config):
        build_calls["n"] += 1
        return FakeModel()

    monkeypatch.setattr(
        "ccie_sidecar.providers.langchain_factory.build_chat_model", fake_build
    )
    monkeypatch.setattr(
        "ccie_sidecar.agent.get_saved_config", lambda: {}
    )

    tool = build_terraform_codegen_tool()  # no llm injected -> default path
    assert build_calls["n"] == 0  # not built at factory time

    tool.func(intent="a", working_dir="/infra")
    tool.func(intent="b", working_dir="/infra")
    assert build_calls["n"] == 1  # built once, reused on second call
