"""IaC Phase 4 — codegen tools attach to the IaC agent (and only it)."""
from ccie_sidecar.agents.deepagents_runtime import (
    _iac_extra_tools,
    IAC_CODEGEN_GUIDANCE,
    _iac_system_prompt,
)


def test_iac_agent_gets_codegen_tools():
    tools = _iac_extra_tools()
    names = {t.name for t in tools}
    assert "iac_apply" in names
    assert "generate_terraform_code" in names
    assert "generate_ansible_playbook" in names


def test_iac_codegen_tools_construct_and_are_callable():
    """The wired codegen tools construct without ImportError and expose a callable
    .func. We do NOT execute the default-LLM path (no credentials in tests); we
    only assert construction + callable surface, guarding against import cycles in
    the shared runtime module."""
    tools = _iac_extra_tools()
    by_name = {t.name: t for t in tools}
    assert callable(by_name["generate_terraform_code"].func)
    assert callable(by_name["generate_ansible_playbook"].func)
    assert callable(by_name["iac_apply"].func)


def test_iac_guidance_appended_to_user_prompt():
    combined = _iac_system_prompt("You are a helpful IaC agent.")
    assert "You are a helpful IaC agent." in combined
    assert IAC_CODEGEN_GUIDANCE.strip() in combined


def test_iac_guidance_mentions_generate_then_apply_order():
    assert "generate_terraform_code" in IAC_CODEGEN_GUIDANCE
    assert "iac_apply" in IAC_CODEGEN_GUIDANCE
