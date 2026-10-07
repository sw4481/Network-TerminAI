"""Global agent-step setting at the saved-config and execution boundaries."""
import io
import json
import sqlite3
from unittest.mock import patch

import pytest

from ccie_sidecar import agent
from ccie_sidecar.agents import deepagents_runtime, react, react_code
from ccie_sidecar.agents.deepagents_hitl import resume_graph


@pytest.mark.parametrize("saved,expected", [(None, 60), (1, 1), (500, 500), (37, 37),
    (0, 60), (501, 60), (True, 60), (False, 60), (2.5, 60), ("7", 60), ([], 60)])
def test_step_budget_accepts_only_configured_integer_in_range(saved, expected):
    """Malformed settings must not become graph limits or unbounded runs."""
    config = {} if saved is None else {"max_agent_steps": saved}
    assert agent.AgentStepBudget(config).limit(60) == expected


@pytest.mark.parametrize("new_schema,stored,expected", [
    (False, None, None), (True, None, None), (True, 1, 1),
    (True, 500, 500), (True, 0, None), (True, 501, None),
    (True, "not-an-integer", None), (True, 2.5, None),
])
def test_saved_config_reads_optional_budget_from_actual_sqlite(
    tmp_path, monkeypatch, new_schema, stored, expected,
):
    """Pre-migration databases still load the existing provider settings."""
    monkeypatch.setattr(agent.Path, "home", lambda: tmp_path)
    db_dir = tmp_path / "Library" / "Application Support" / "ccie-terminal"
    db_dir.mkdir(parents=True)
    with sqlite3.connect(db_dir / "sessions.db") as conn:
        extra = ", max_agent_steps INTEGER" if new_schema else ""
        conn.execute("CREATE TABLE ai_config (id INTEGER, provider TEXT, model TEXT, api_key TEXT, base_url TEXT" + extra + ")")
        if new_schema:
            conn.execute("INSERT INTO ai_config VALUES (1, ?, ?, ?, ?, ?)",
                         ("openai", "example-model", "synthetic-key", None, stored))
        else:
            conn.execute("INSERT INTO ai_config VALUES (1, ?, ?, ?, ?)",
                         ("openai", "example-model", "synthetic-key", None))
    saved = agent.get_saved_config()
    assert saved is not None
    assert saved["provider"] == "openai"
    assert saved["model"] == "example-model"
    assert saved["api_key"] == "synthetic-key"
    assert saved["base_url"] is None
    assert saved.get("max_agent_steps") == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("saved,expected", [(None, 12), (2, 2), (500, 500)])
async def test_legacy_react_stops_at_saved_iteration_budget(saved, expected):
    """The legacy Meraki loop must not ask the LLM for one extra step."""
    config = {"provider": "anthropic", "model": "test", "api_key": "synthetic-key"}
    if saved is not None:
        config["max_agent_steps"] = saved
    events = []
    with patch.object(agent, "get_saved_config", return_value=config), \
         patch.object(react, "_initialize_meraki_client"), \
         patch.object(react, "_call_llm_with_tools", return_value={"stop_reason": "tool_use", "content": []}) as llm:
        await react.react_loop({"attached_tools": [{"catalog": json.dumps([])}]},
                               "question", {}, events.append)
    assert llm.call_count == expected
    assert [event["step"] for event in events if event["type"] == "thought_start"] == list(range(1, expected + 1))
    assert events[-1]["type"] == "error"
    assert f"Maximum steps ({expected})" in events[-1]["message"]


@pytest.mark.asyncio
@pytest.mark.parametrize("saved,expected", [(None, 16), (2, 2), (500, 500)])
async def test_legacy_react_code_stops_at_saved_iteration_budget(saved, expected):
    """The hybrid loop shares the global setting without changing its default."""
    config = {"provider": "anthropic", "model": "test", "api_key": "synthetic-key"}
    if saved is not None:
        config["max_agent_steps"] = saved
    events = []
    with patch.object(agent, "get_saved_config", return_value=config), \
         patch.object(react_code, "_call_llm_with_tools", return_value={"stop_reason": "tool_use", "content": []}) as llm, \
         patch.object(react_code, "_build_sandbox_globals", return_value={}), \
         patch.object(react_code, "_build_env_overrides", return_value={}), \
         patch("ccie_sidecar.agents.catalog_grounding.resolve_agent_catalogs", return_value={}), \
         patch("ccie_sidecar.agents.catalog_grounding.install_catalog_grounding", return_value=None):
        await react_code.react_code_loop({"tool_id": None, "system_prompt": "test"},
                                         "question", {}, events.append)
    assert llm.call_count == expected
    assert events[-1]["type"] == "error"
    assert f"Maximum steps ({expected})" in events[-1]["message"]


@pytest.mark.asyncio
@pytest.mark.parametrize("loop", [
    "deepagents_code_exec_loop",
    "deepagents_react_loop",
    "deepagents_react_code_loop",
])
@pytest.mark.parametrize("saved,expected", [(None, 60), (7, 7), (500, 500), (True, 60)])
async def test_all_deepagents_runs_apply_global_budget_before_provider_override(
    loop, saved, expected,
):
    """Each graph entrypoint forwards the limit even when model overrides disagree."""
    config = {"provider": "anthropic", "model": "base"}
    if saved is not None:
        config["max_agent_steps"] = saved
    observed = {}
    async def capture(**kwargs):
        observed["config"] = kwargs["config"]
        return {"interrupted": False}
    agent_def = {"id": "sample", "name": "sample", "system_prompt": "test",
                 "attached_tools": [{"id": "sample", "catalog": []}],
                 "model_override": {"provider": "openai", "model": "other", "max_agent_steps": 499}}
    with patch.object(agent, "get_saved_config", return_value=config), \
         patch.object(deepagents_runtime, "build_chat_model", return_value=object()), \
         patch.object(deepagents_runtime, "create_deep_agent", return_value=object()), \
         patch.object(deepagents_runtime, "_rubric_middleware", return_value=object()), \
         patch.object(deepagents_runtime, "create_execute_python_code_tool", return_value=object()), \
         patch("ccie_sidecar.agents.deepagents_tools.create_catalog_search_tool", return_value=None), \
         patch("ccie_sidecar.agents.deepagents_tools.convert_meraki_catalog_to_langchain_tools", return_value=[]), \
         patch("ccie_sidecar.agents.catalog_grounding.resolve_agent_catalogs", return_value={}), \
         patch("ccie_sidecar.agents.deepagents_stream.run_and_stream", side_effect=capture), \
         patch.object(deepagents_runtime, "run_and_stream_code_exec", side_effect=capture):
        await getattr(deepagents_runtime, loop)(agent_def, "question", {}, lambda _event: None)
    assert observed["config"]["recursion_limit"] == expected
    if saved is not None and type(saved) is int:
        assert observed["config"]["metadata"]["max_agent_steps"] == expected
    else:
        assert "metadata" not in observed["config"]


@pytest.mark.asyncio
@pytest.mark.parametrize("configured", [True, False])
async def test_approval_resume_uses_original_config_only_when_budget_was_configured(configured):
    """Approval resumes inherit the original cap; unset resumes retain LangGraph defaults."""
    captured = {}
    async def fake_run_and_stream(**kwargs):
        captured.update(kwargs)
        return {"interrupted": False}
    original = {"configurable": {"thread_id": "approved-turn"}, "recursion_limit": 7}
    if configured:
        original["metadata"] = {"max_agent_steps": 7}
    with patch("ccie_sidecar.agents.deepagents_stream.run_and_stream", side_effect=fake_run_and_stream):
        await resume_graph(graph=object(), thread_id="approved-turn", decision="approve",
                           on_event=lambda _event: None, config=original)
    assert captured["config"]["configurable"] == {"thread_id": "approved-turn"}
    assert captured["config"].get("recursion_limit") == (7 if configured else None)


@pytest.mark.asyncio
@pytest.mark.parametrize("decision", ["approve", "deny", "edit"])
@pytest.mark.parametrize("configured", [True, False])
async def test_repeated_approval_resume_preserves_configured_budget(decision, configured):
    """Each interruption's resume config becomes the next approval's original config."""
    configs = []

    async def interrupt_again(**kwargs):
        configs.append(kwargs["config"])
        return {"interrupted": len(configs) == 1}

    original = agent.AgentStepBudget({"max_agent_steps": 7 if configured else None}).graph_config(
        "repeated-approval", 60
    )
    edited_action = {"name": "iac_apply", "args": {}} if decision == "edit" else None
    with patch("ccie_sidecar.agents.deepagents_stream.run_and_stream", side_effect=interrupt_again):
        for current_config in (original, None):
            await resume_graph(
                graph=object(), thread_id="repeated-approval", decision=decision,
                edited_action=edited_action, on_event=lambda _event: None,
                config=current_config if current_config is not None else configs[0],
            )
    assert configs[0] == configs[1]
    assert configs[1]["configurable"] == {"thread_id": "repeated-approval"}
    assert configs[1].get("recursion_limit") == (7 if configured else None)
    assert configs[1].get("metadata") == ({"max_agent_steps": 7} if configured else None)


@pytest.mark.parametrize("configured", [True, False])
def test_resume_rpc_dispatch_preserves_original_configured_budget(configured):
    """A pending approval must carry its saved cap through the real NDJSON dispatcher."""
    from langchain_core.messages import AIMessage
    from langgraph.types import Command
    from ccie_sidecar.agents.deepagents_state import store_interrupted_graph
    from ccie_sidecar.server import run_loop

    thread_id = f"budget-approval-{configured}"
    original = agent.AgentStepBudget({"max_agent_steps": 7 if configured else None}).graph_config(
        thread_id, 60
    )
    observed = {}

    class PausedGraph:
        async def astream(self, input_data, config, stream_mode, **kwargs):
            observed["input_data"] = input_data
            observed["config"] = config
            yield ((), "updates", {"agent": {"messages": [AIMessage(content="approved result")]}})

    store_interrupted_graph(thread_id, PausedGraph(), original, lambda _event: None)
    request = {"id": thread_id, "method": "agent.react_resume",
               "params": {"thread_id": thread_id, "decision": "approve"}}
    stdout = io.StringIO()
    run_loop(io.StringIO(json.dumps(request) + "\n"), stdout)

    assert isinstance(observed["input_data"], Command)
    assert observed["input_data"].resume == {"decisions": [{"type": "approve"}]}
    assert observed["config"]["configurable"] == {"thread_id": thread_id}
    assert observed["config"].get("recursion_limit") == (7 if configured else None)
    messages = [json.loads(line) for line in stdout.getvalue().splitlines()]
    own_messages = [message for message in messages if message.get("id") == thread_id]
    assert [message["type"] for message in own_messages] == ["final", "done"]
    assert own_messages[0]["response"] == "approved result"
