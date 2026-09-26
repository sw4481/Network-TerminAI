"""Regression tests: react_code_loop must bind the sandbox to the agent's
actual tool_id, not a hardcoded 'meraki'.

This is the bug where the pyATS agent (execution-mode: react-code) ended up
calling Meraki tools because react_code_loop hardcoded
_build_sandbox_globals("meraki", ...).
"""

import asyncio
from unittest.mock import patch

from ccie_sidecar.agents.react_code import react_code_loop


def _run(agent_def):
    """Drive react_code_loop with a stubbed LLM that immediately ends the turn,
    capturing the cli_package passed to the sandbox builder."""
    captured = {}

    def fake_build_sandbox(cli_package, secrets, emit=None):
        captured["cli_package"] = cli_package
        captured["emit"] = emit
        return {"__builtins__": __builtins__}

    # LLM stub: end immediately so the loop doesn't need a real provider call.
    def fake_llm(*args, **kwargs):
        return {"stop_reason": "end_turn", "content": [{"type": "text", "text": "done"}]}

    events = []

    with patch("ccie_sidecar.agents.react_code._build_sandbox_globals", side_effect=fake_build_sandbox), \
         patch("ccie_sidecar.agents.react_code._build_env_overrides", return_value={}), \
         patch("ccie_sidecar.agents.react_code._call_llm_with_tools", side_effect=fake_llm), \
         patch("ccie_sidecar.agent.get_saved_config", return_value={
             "provider": "anthropic", "model": "claude-sonnet-4-6", "api_key": "test-key",
         }):
        asyncio.run(react_code_loop(
            agent_def=agent_def,
            user_msg="show the time on my devices",
            ctx={},
            on_event=events.append,
        ))

    return captured, events


def test_pyats_agent_binds_pyats_sandbox():
    captured, events = _run({
        "agent_id": "pyats",
        "system_prompt": "pyATS expert",
        "tool_id": "pyats",
        "vault_secrets": {},
    })
    assert captured["cli_package"] == "pyats"
    # The sandbox must receive the loop's on_event so the drawio helper can
    # stream diagram events.
    assert captured["emit"] is not None


def test_meraki_agent_binds_meraki_sandbox():
    captured, events = _run({
        "agent_id": "meraki",
        "system_prompt": "Meraki expert",
        "tool_id": "meraki",
        "vault_secrets": {},
    })
    assert captured["cli_package"] == "meraki"


def _run_capture_tools(agent_def, sandbox_globals):
    """Drive react_code_loop with a sandbox stub that returns `sandbox_globals`,
    capturing the `tools` passed to the LLM so we can inspect the rendered
    execute_python_code description."""
    captured = {}

    def fake_build_sandbox(cli_package, secrets, emit=None):
        return dict(sandbox_globals)

    def fake_llm(*args, **kwargs):
        captured["tools"] = kwargs.get("tools")
        return {"stop_reason": "end_turn", "content": [{"type": "text", "text": "done"}]}

    with patch("ccie_sidecar.agents.react_code._build_sandbox_globals", side_effect=fake_build_sandbox), \
         patch("ccie_sidecar.agents.react_code._build_env_overrides", return_value={}), \
         patch("ccie_sidecar.agents.react_code._call_llm_with_tools", side_effect=fake_llm), \
         patch("ccie_sidecar.agent.get_saved_config", return_value={
             "provider": "anthropic", "model": "claude-sonnet-4-6", "api_key": "test-key",
         }):
        asyncio.run(react_code_loop(
            agent_def=agent_def,
            user_msg="draw my topology",
            ctx={},
            on_event=[].append,
        ))

    for tool in captured["tools"]:
        if tool.get("name") == "execute_python_code":
            return tool["description"]
        function = tool.get("function", {})
        if function.get("name") == "execute_python_code":
            return function["description"]
    raise AssertionError("execute_python_code tool was not provided")


def test_meraki_prompt_uses_single_door_api_call():
    """The tool description must steer the model to the single meraki_api_call
    helper (like ISE/FMC) and the correct linkLayer path — NOT the raw SDK or a
    hand-built /topology endpoint."""
    desc = _run_capture_tools(
        {"agent_id": "meraki", "system_prompt": "Meraki expert",
         "tool_id": "meraki", "vault_secrets": {"meraki_api_key": "x"}},
        {"__builtins__": __builtins__, "meraki_api_call": lambda *a, **k: "{}"},
    )
    assert "meraki_api_call" in desc
    assert "topology/linkLayer" in desc
    # Must not steer to the raw SDK object.
    assert "meraki.DashboardAPI" not in desc
    assert "meraki.organizations" not in desc


def test_missing_tool_id_binds_plain_sandbox():
    """No tool_id => None (plain Python sandbox), not a Meraki default."""
    captured, events = _run({
        "agent_id": "generic",
        "system_prompt": "Generic agent",
        "vault_secrets": {},
    })
    assert captured["cli_package"] is None
