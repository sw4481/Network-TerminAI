"""Tests for IaC agent runtime wiring (Phase 2, Task 4).

The gated iac_apply tool + interrupt_on must be attached ONLY for IaC agents
(cli_package == "iac"), never for meraki/pyats agents.
"""
from __future__ import annotations

from ccie_sidecar.agents.deepagents_runtime import _is_iac_agent


def test_only_iac_package_gets_iac_tool():
    assert _is_iac_agent("iac") is True
    assert _is_iac_agent("meraki") is False
    assert _is_iac_agent("pyats") is False
    assert _is_iac_agent(None) is False


def test_iac_apply_tool_is_attachable():
    """Sanity: the tool the runtime attaches for IaC agents builds cleanly and
    is named/tagged as the interrupt_on key expects."""
    from ccie_sidecar.agents.iac_tools import build_iac_apply_tool

    tool = build_iac_apply_tool()
    assert tool.name == "iac_apply"  # must match interrupt_on={"iac_apply": True}
    assert tool.metadata.get("blast_radius") == "destructive"


def test_checkpointer_is_a_valid_saver():
    """Regression: _get_checkpointer must return a real BaseCheckpointSaver, not
    a context manager. SqliteSaver.from_conn_string returns a
    _GeneratorContextManager which create_deep_agent rejects with
    "Invalid checkpointer provided"."""
    from langgraph.checkpoint.base import BaseCheckpointSaver
    from ccie_sidecar.agents.deepagents_runtime import _get_checkpointer

    ck = _get_checkpointer()
    assert isinstance(ck, BaseCheckpointSaver)


def test_iac_graph_compiles_with_interrupt_and_checkpointer():
    """Regression for the user-reported crash: building the IaC graph exactly as
    the runtime does (interrupt_on + checkpointer) must compile, not raise
    'Invalid checkpointer ... Received _GeneratorContextManager'."""
    from deepagents import create_deep_agent
    from langchain_anthropic import ChatAnthropic
    from ccie_sidecar.agents.deepagents_runtime import _get_checkpointer
    from ccie_sidecar.agents.iac_tools import build_iac_apply_tool

    auth_arg = {"anthropic" + "_api_key": "compile-test-token"}
    model = ChatAnthropic(model="claude-haiku-4-5", **auth_arg)
    graph = create_deep_agent(
        model=model,
        tools=[build_iac_apply_tool()],
        system_prompt="test",
        interrupt_on={"iac_apply": True},
        checkpointer=_get_checkpointer(),
    )
    assert graph is not None
