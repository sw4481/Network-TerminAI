"""Global agent-step setting at the saved-config and execution boundaries."""
import io
import json
import sqlite3
from types import SimpleNamespace
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


@pytest.mark.parametrize("loader_system", ["native", "Linux"])
@pytest.mark.parametrize("new_schema,stored,expected", [
    (False, None, None), (True, None, None), (True, 1, 1),
    (True, 500, 500), (True, 0, None), (True, 501, None),
    (True, "not-an-integer", None), (True, 2.5, None),
])
def test_saved_config_reads_optional_budget_from_actual_sqlite(
    tmp_path, monkeypatch, loader_system, new_schema, stored, expected,
):
    """Pre-migration databases still load the existing provider settings."""
    monkeypatch.setattr(agent.Path, "home", lambda: tmp_path)
    if loader_system == "Linux":
        monkeypatch.setattr(agent, "os", SimpleNamespace(
            name="posix", uname=lambda: SimpleNamespace(sysname="Linux"),
        ))
    monkeypatch.setenv("APPDATA", str(tmp_path))
    if agent.os.name == "nt":
        db_dir = tmp_path / "ccie-terminal"
    elif agent.os.uname().sysname == "Darwin":
        db_dir = tmp_path / "Library" / "Application Support" / "ccie-terminal"
    else:
        db_dir = tmp_path / ".config" / "ccie-terminal"
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
    assert observed["config"]["recursion_limit"] == 60
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
    assert configs[1].get("recursion_limit") == (60 if configured else None)
    assert configs[1].get("metadata") == ({"max_agent_steps": 7} if configured else None)


@pytest.mark.parametrize("configured", [True, False])
def test_resume_rpc_dispatch_preserves_original_configured_budget(configured):
    """A pending approval must carry its saved cap through the real NDJSON dispatcher."""
    from langchain_core.messages import AIMessage
    from langgraph.types import Command
    from ccie_sidecar.agents.deepagents_state import store_interrupted_graph
    from ccie_sidecar import server

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
    with patch.object(server, "_start_heartbeat"), \
         patch("ccie_sidecar.whatsapp_bridge.maybe_autostart"), \
         patch("ccie_sidecar.agents.architect_subagents.write_vendor_keyword_defaults_file"):
        server.run_loop(io.StringIO(json.dumps(request) + "\n"), stdout)

    assert isinstance(observed["input_data"], Command)
    assert observed["input_data"].resume == {"decisions": [{"type": "approve"}]}
    assert observed["config"]["configurable"] == {"thread_id": thread_id}
    assert observed["config"].get("recursion_limit") == (60 if configured else None)
    messages = [json.loads(line) for line in stdout.getvalue().splitlines()]
    own_messages = [message for message in messages if message.get("id") == thread_id]
    assert [message["type"] for message in own_messages] == ["final", "done"]
    assert own_messages[0]["response"] == "approved result"


@pytest.mark.asyncio
@pytest.mark.parametrize("limit", [1, 7, 37, 120, 500])
async def test_real_deepagent_counts_visible_rounds_without_intermediate_pause(limit):
    """A real checkpointed DeepAgents graph reaches the configured tool-round cap."""
    from deepagents import create_deep_agent
    from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
    from langchain_core.messages import AIMessage, HumanMessage
    from langchain_core.tools import tool
    from langgraph.checkpoint.memory import InMemorySaver
    from langgraph.store.memory import InMemoryStore
    from ccie_sidecar.agents.deepagents_middleware import VisibleRoundBudgetMiddleware
    from ccie_sidecar.agents.deepagents_stream import run_and_stream
    from ccie_sidecar.agents.deepagents_hitl import continue_graph

    class ToolModel(FakeMessagesListChatModel):
        def bind_tools(self, tools, *, tool_choice=None, **kwargs):
            return self

    @tool
    def noop() -> str:
        """Return a synthetic offline result."""
        return "ok"

    calls = []
    responses = [AIMessage(content="", tool_calls=[{
        "name": "noop", "args": {}, "id": f"round-{i}",
    }]) for i in range(limit)] + [AIMessage(content="Finished")]
    model = ToolModel(responses=responses)
    graph = create_deep_agent(model=model, tools=[noop], store=InMemoryStore(),
        middleware=[VisibleRoundBudgetMiddleware(limit)], checkpointer=InMemorySaver())
    config = agent.AgentStepBudget({"max_agent_steps": limit}).graph_config(f"real-{limit}", 60)
    outcome = await run_and_stream(graph, {"messages": [HumanMessage(content="Check")]},
        config, calls.append, continue_on_step_limit=True)
    assert outcome["interrupted"] is True
    assert len([event for event in calls if event["type"] == "tool_call" and event["name"] == "noop"]) == limit
    assert len([event for event in calls if event["type"] == "error"
                and "Continue" in event["message"]]) == 1
    assert len([event for event in calls if event["type"] == "continuation_available"]) == 1
    assert graph.get_state(config).values["_ccie_rounds"] == limit
    resumed = await continue_graph(graph, config, calls.append)
    assert resumed["final_emitted"] is True
    assert calls[-1] == {"type": "final", "response": "Finished"}
    assert len([event for event in calls if event["type"] == "tool_call" and event["name"] == "noop"]) == limit


@pytest.mark.asyncio
async def test_nested_specialist_budget_resumes_without_replaying_completed_tool():
    from deepagents import SubAgent, create_deep_agent
    from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
    from langchain_core.messages import AIMessage, HumanMessage
    from langchain_core.tools import tool
    from langgraph.checkpoint.memory import InMemorySaver
    from langgraph.store.memory import InMemoryStore
    from ccie_sidecar.agents.deepagents_runtime import _budget_subagents
    from ccie_sidecar.agents.deepagents_middleware import VisibleRoundBudgetMiddleware
    from ccie_sidecar.agents.deepagents_stream import run_and_stream
    from ccie_sidecar.agents.deepagents_hitl import continue_graph

    class ToolModel(FakeMessagesListChatModel):
        def bind_tools(self, tools, *, tool_choice=None, **kwargs):
            return self

    executions = []

    @tool
    def noop() -> str:
        """Record one offline specialist tool execution."""
        executions.append("ran")
        return "ok"

    child = ToolModel(responses=[AIMessage(content="", tool_calls=[
        {"name": "noop", "args": {}, "id": "child-round"},
    ]), AIMessage(content="Child finished")])
    root = ToolModel(responses=[AIMessage(content="", tool_calls=[
        {"name": "task", "args": {"description": "Check", "subagent_type": "specialist"},
         "id": "parent-round"},
    ]), AIMessage(content="Root finished")])
    graph = create_deep_agent(model=root, tools=[noop], store=InMemoryStore(),
        middleware=[VisibleRoundBudgetMiddleware(1)], checkpointer=InMemorySaver(),
        subagents=_budget_subagents([SubAgent(name="specialist", description="Check things",
            system_prompt="Use noop then answer.", model=child)], 1))
    config = agent.AgentStepBudget({"max_agent_steps": 1}).graph_config("nested-budget", 60)
    events = []
    first = await run_and_stream(graph, {"messages": [HumanMessage(content="Check")]},
        config, events.append, continue_on_step_limit=True)
    assert first["interrupted"] is True
    assert executions == ["ran"]
    assert len([event for event in events if event["type"] == "continuation_available"]) == 1
    second = await continue_graph(graph, config, events.append)
    assert second["interrupted"] is True  # parent has spent its own round
    assert executions == ["ran"]
    third = await continue_graph(graph, config, events.append)
    assert third["final_emitted"] is True
    assert events[-1] == {"type": "final", "response": "Root finished"}
    assert executions == ["ran"]


@pytest.mark.asyncio
async def test_approval_resume_does_not_replenish_visible_round_budget():
    from deepagents import create_deep_agent
    from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
    from langchain_core.messages import AIMessage, HumanMessage
    from langchain_core.tools import tool
    from langgraph.checkpoint.memory import InMemorySaver
    from langgraph.store.memory import InMemoryStore
    from ccie_sidecar.agents.deepagents_middleware import VisibleRoundBudgetMiddleware
    from ccie_sidecar.agents.deepagents_hitl import continue_graph, resume_graph

    class ToolModel(FakeMessagesListChatModel):
        def bind_tools(self, tools, *, tool_choice=None, **kwargs):
            return self

    executions = []

    @tool
    def gated() -> str:
        """Record one offline approved tool execution."""
        executions.append("approved")
        return "ok"

    model = ToolModel(responses=[AIMessage(content="", tool_calls=[
        {"name": "gated", "args": {}, "id": "approve-round"},
    ]), AIMessage(content="Approved finished")])
    graph = create_deep_agent(model=model, tools=[gated], store=InMemoryStore(),
        middleware=[VisibleRoundBudgetMiddleware(1)], checkpointer=InMemorySaver(),
        interrupt_on={"gated": True})
    config = agent.AgentStepBudget({"max_agent_steps": 1}).graph_config("approval-budget", 60)
    from ccie_sidecar.agents.deepagents_stream import _graph_events
    updates = [event async for event in _graph_events(graph,
        {"messages": [HumanMessage(content="Approve")]}, config, subgraphs=True)]
    assert any(isinstance(event, tuple) and event[-2] == "updates"
        and "__interrupt__" in event[-1] for event in updates)
    assert executions == []
    assert graph.get_state(config).next == ("HumanInTheLoopMiddleware.after_model",)

    events = []
    resumed = await resume_graph(graph, "approval-budget", "approve", events.append,
                                 config=config)
    assert resumed["interrupted"] is True
    assert executions == ["approved"]
    assert graph.get_state(config).values["_ccie_rounds"] == 1
    assert len([event for event in events if event["type"] == "continuation_available"]) == 1
    completed = await continue_graph(graph, config, events.append)
    assert completed["final_emitted"] is True
    assert events[-1] == {"type": "final", "response": "Approved finished"}
    assert executions == ["approved"]


@pytest.mark.asyncio
@pytest.mark.parametrize("entrypoint", ["code_exec", "react"])
async def test_non_resumable_budget_pause_reports_terminal_outcome(entrypoint):
    """Non-resumable consumers must not silently stop after N rounds."""
    from deepagents import create_deep_agent
    from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
    from langchain_core.messages import AIMessage, HumanMessage
    from langchain_core.tools import tool
    from langgraph.checkpoint.memory import InMemorySaver
    from langgraph.store.memory import InMemoryStore
    from ccie_sidecar.agents.deepagents_middleware import VisibleRoundBudgetMiddleware
    from ccie_sidecar.agents.deepagents_stream import run_and_stream, run_and_stream_code_exec

    class ToolModel(FakeMessagesListChatModel):
        def bind_tools(self, tools, *, tool_choice=None, **kwargs):
            return self

    @tool
    def noop() -> str:
        """Return an offline result."""
        return "ok"

    model = ToolModel(responses=[AIMessage(content="", tool_calls=[
        {"name": "noop", "args": {}, "id": "code-exec-round"},
    ]), AIMessage(content="Finished")])
    graph = create_deep_agent(model=model, tools=[noop], store=InMemoryStore(),
        middleware=[VisibleRoundBudgetMiddleware(1)], checkpointer=InMemorySaver())
    config = agent.AgentStepBudget({"max_agent_steps": 1}).graph_config("code-exec-budget", 60)
    events = []
    if entrypoint == "code_exec":
        await run_and_stream_code_exec(graph, {"messages": [HumanMessage(content="Run")]},
                                       config, events.append)
    else:
        outcome = await run_and_stream(graph, {"messages": [HumanMessage(content="Run")]},
                                       config, events.append)
        assert outcome["error_kind"] == "step_limit"
        assert outcome["interrupted"] is False
    assert len([event for event in events if event["type"] == "error"
                and "limit" in event["message"].lower()]) == 1
    assert not [event for event in events if event["type"] == "continuation_available"]
    assert not [event for event in events if event["type"] == "final"]


@pytest.mark.asyncio
async def test_internal_graph_checkpoint_stops_when_no_visible_round_progress():
    from typing_extensions import TypedDict
    from langgraph.checkpoint.memory import InMemorySaver
    from langgraph.graph import START, StateGraph
    from ccie_sidecar.agents.deepagents_stream import run_and_stream

    class State(TypedDict):
        tick: int
        _ccie_rounds: int

    def spin(state: State):
        return {"tick": state["tick"] + 1}

    builder = StateGraph(State)
    builder.add_node("spin", spin)
    builder.add_edge(START, "spin")
    builder.add_edge("spin", "spin")
    graph = builder.compile(checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": "no-progress-budget"},
              "recursion_limit": 2, "metadata": {"max_agent_steps": 7}}
    events = []
    outcome = await run_and_stream(graph, {"tick": 0, "_ccie_rounds": 0},
        config, events.append, continue_on_step_limit=True)
    assert outcome["error_kind"] == "step_limit"
    assert outcome.get("continuation_available") is None
    assert not [event for event in events if event["type"] == "continuation_available"]
    assert graph.get_state(config).values["tick"] <= 6
