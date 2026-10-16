"""Synthetic Cisco Workflows approval graph and mutation boundary regressions."""
from __future__ import annotations

import json
import sys
import types
from typing import Any

import pytest
from deepagents import create_deep_agent, SubAgent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from ccie_sidecar.agents.catalog_grounding import CatalogIndex, CatalogGroundingError


CATALOG = [{"id": "cisco_workflows", "entries": [
    {"name": "createWorkflow", "endpoint": {"method": "POST", "path": "/v1/workflows"}},
    {"name": "importWorkflow", "endpoint": {"method": "POST", "path": "/exchange/v1/workflows/import"}},
    {"name": "listWorkflows", "endpoint": {"method": "POST", "path": "/v1.1/workflows"}},
    {"name": "listWorkflowsV12", "endpoint": {"method": "POST", "path": "/v1.2/workflows"}},
    {"name": "batchGetRules", "endpoint": {"method": "POST", "path": "/v1/rules/batch_get"}},
    {"name": "batchGetVariableTypes", "endpoint": {"method": "POST", "path": "/v1/variable_types/batch_get"}},
    {"name": "startWorkflow", "endpoint": {"method": "POST", "path": "/v1/workflows/start"}},
]}]
ACTION = {"method": "POST", "path": "/v1/workflows", "body": {"name": "网絡 ⚙️", "actions": [{"type": "call"}]}, "query_params": {"mode": "test"}, "rationale": "Build and review", "organization_id": "synthetic-org"}


@pytest.fixture
def transport(monkeypatch):
    calls = []
    class FakeClient:
        def __init__(self, config):
            assert config == {"api_key": "synthetic", "org_id": "synthetic-org"}
        def apply(self, method, path, body=None, query_params=None):
            calls.append((method, path, body, query_params))
            return {"status_code": 201, "data": {"id": "created"}, "error": None}
    from ccie_sidecar.cisco_workflows import _POST_READS, _risk
    module = types.ModuleType("ccie_sidecar.cisco_workflows")
    module._POST_READS = _POST_READS
    module._risk = _risk
    module.CiscoWorkflowsClient = FakeClient
    monkeypatch.setitem(sys.modules, module.__name__, module)
    monkeypatch.setattr("ccie_sidecar.meraki_config.get_meraki_config", lambda: {"api_key": "synthetic", "org_id": "synthetic-org"})
    return calls


def _tool():
    from ccie_sidecar.agents.cisco_workflows_tools import build_cisco_workflows_apply_tool

    index = CatalogIndex(CATALOG)
    tool = build_cisco_workflows_apply_tool(index)
    assert tool.name == "cisco_workflows_apply"
    assert tool.metadata["requires_approval"] is True
    assert "timeout" in tool.description.lower() and "read" in tool.description.lower()
    return tool, index


def test_mutation_rejects_changed_target_before_network(transport, monkeypatch):
    configured = {"api_key": "synthetic", "org_id": "synthetic-org"}
    monkeypatch.setattr("ccie_sidecar.meraki_config.get_meraki_config", lambda: configured)
    tool, index = _tool()
    index.search("createWorkflow", catalog_id="cisco_workflows")
    assert tool.metadata["target_org_id"] == "synthetic-org"
    with pytest.raises(ValueError, match="target organization changed"):
        tool.invoke({**ACTION, "organization_id": "different-org"})
    with pytest.raises(ValueError):
        tool.invoke({key: value for key, value in ACTION.items() if key != "organization_id"})
    assert transport == []
    configured = {"api_key": "synthetic", "org_id": "different-org"}
    with pytest.raises(ValueError, match="target organization changed"):
        tool.invoke(ACTION)
    assert transport == []


def test_mutation_requires_discovered_exact_record_and_valid_config(transport, monkeypatch):
    tool, index = _tool()
    with pytest.raises(CatalogGroundingError):
        tool.invoke(ACTION)
    assert transport == []
    results = index.search("createWorkflow", catalog_id="cisco_workflows")
    assert any(m["method"] == ACTION["method"] and m["path"] == ACTION["path"] for m in results["matches"])
    response = json.loads(tool.invoke(ACTION))
    assert response["data"] == {"id": "created"}
    assert transport == [(ACTION["method"], ACTION["path"], ACTION["body"], ACTION["query_params"])]
    for changed in ({**ACTION, "method": "GET"}, {**ACTION, "path": "/v1.1/workflows/other"}, {**ACTION, "method": "POST", "path": "/v1.1/workflows"}, {**ACTION, "path": "/v1.2/workflows"}, {**ACTION, "path": "/v1/rules/batch_get"}, {**ACTION, "path": "/v1/variable_types/batch_get"}):
        with pytest.raises((ValueError, CatalogGroundingError)):
            tool.invoke(changed)
    assert len(transport) == 1
    for name, path in (("batchGetRules", "/v1/rules/batch_get"), ("batchGetVariableTypes", "/v1/variable_types/batch_get")):
        index.search(name, catalog_id="cisco_workflows")
        with pytest.raises(ValueError, match="read"):
            tool.invoke({**ACTION, "path": path})
    assert len(transport) == 1
    monkeypatch.setattr("ccie_sidecar.meraki_config.get_meraki_config", lambda: {"api_key": "synthetic", "org_id": " "})
    with pytest.raises(ValueError):
        tool.invoke(ACTION)
    assert len(transport) == 1
    monkeypatch.setattr("ccie_sidecar.meraki_config.get_meraki_config", lambda: {"api_key": "synthetic", "org_id": "synthetic-org"})
    with pytest.raises(ValueError):
        tool.invoke({**ACTION, "rationale": " "})
    assert len(transport) == 1
    import_match = index.search("importWorkflow", catalog_id="cisco_workflows")["matches"][0]
    assert import_match["path"] == "/exchange/v1/workflows/import"
    tool.invoke({**ACTION, "path": import_match["path"], "body": {"workflow": {"name": "imported"}}})
    assert transport[-1][1] == "/exchange/v1/workflows/import"


class _ApproveModel(BaseChatModel):
    delegated: bool = False
    turns: int = 0

    @property
    def _llm_type(self):
        return "synthetic-workflow-approval"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.turns += 1
        if self.delegated and self.turns == 1:
            response = AIMessage(content="", tool_calls=[{"name": "task", "args": {"description": "Create Cisco Workflows", "subagent_type": "cisco_workflows-specialist"}, "id": "delegate"}])
        elif any(isinstance(msg, ToolMessage) for msg in messages):
            response = AIMessage(content="Finished")
        else:
            response = AIMessage(content="", tool_calls=[{"name": "cisco_workflows_apply", "args": ACTION, "id": "apply"}])
        return ChatResult(generations=[ChatGeneration(message=response)])


@pytest.mark.parametrize("decision,expected_calls", [("approve", 1), ("reject", 0)])
def test_real_graph_interrupts_before_network_and_resumes_once(transport, decision, expected_calls):
    tool, index = _tool()
    index.search("createWorkflow", catalog_id="cisco_workflows")
    graph = create_deep_agent(model=_ApproveModel(), tools=[tool], interrupt_on={"cisco_workflows_apply": {"allowed_decisions": ["approve", "reject"]}}, checkpointer=MemorySaver())
    config = {"configurable": {"thread_id": f"workflow-{decision}"}}
    paused = graph.invoke({"messages": [HumanMessage(content="Create the workflow")]}, config)
    assert transport == []
    state = graph.get_state(config)
    assert state.tasks and state.tasks[0].interrupts
    requests = state.tasks[0].interrupts[0].value["action_requests"]
    assert requests[0]["name"] == "cisco_workflows_apply"
    assert requests[0]["args"] == ACTION
    assert state.tasks[0].interrupts[0].value["review_configs"][0] == {"action_name": "cisco_workflows_apply", "allowed_decisions": ["approve", "reject"]}
    resumed = graph.invoke(Command(resume={"decisions": [{"type": decision, **({"message": "denied"} if decision == "reject" else {})}]}), config)
    assert len(transport) == expected_calls
    assert not graph.get_state(config).tasks
    assert any(isinstance(m, ToolMessage) for m in resumed["messages"])


def test_delegated_specialist_has_own_interrupt_before_network(transport):
    tool, index = _tool()
    index.search("createWorkflow", catalog_id="cisco_workflows")
    subagent = SubAgent(name="cisco_workflows-specialist", description="Cisco Workflows", system_prompt="You are the Cisco Workflows specialist.", tools=[tool], interrupt_on={"cisco_workflows_apply": {"allowed_decisions": ["approve", "reject"]}})
    graph = create_deep_agent(model=_ApproveModel(delegated=True), tools=[], subagents=[subagent], checkpointer=MemorySaver())
    config = {"configurable": {"thread_id": "delegated-workflow"}}
    graph.invoke({"messages": [HumanMessage(content="Create Cisco Workflows")], "rubric": "do it"}, config)
    assert transport == []
    pending = graph.get_state(config, subgraphs=True)
    assert pending.tasks
    assert pending.tasks[0].interrupts
    assert pending.tasks[0].interrupts[0].value["action_requests"][0]["name"] == "cisco_workflows_apply"
    graph.invoke(Command(resume={"decisions": [{"type": "approve"}]}), config)
    assert len(transport) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("decision, expected_calls", [("approve", 1), ("deny", 0)])
async def test_stream_emits_approval_event_and_stores_resume_graph(transport, decision, expected_calls):
    from ccie_sidecar.agents.deepagents_stream import run_and_stream
    from ccie_sidecar.agents.deepagents_hitl import resume_graph
    from ccie_sidecar.agents.deepagents_state import has_interrupted_graph, retrieve_interrupted_graph, clear_interrupted_graph

    tool, index = _tool()
    index.search("createWorkflow", catalog_id="cisco_workflows")
    graph = create_deep_agent(model=_ApproveModel(), tools=[tool], interrupt_on={"cisco_workflows_apply": {"allowed_decisions": ["approve", "reject"]}}, checkpointer=MemorySaver())
    thread_id = "workflow-event-synthetic"
    clear_interrupted_graph(thread_id)
    events = []
    try:
        result = await run_and_stream(
            graph=graph, input_data={"messages": [HumanMessage(content="Create Cisco Workflows")]},
            config={"configurable": {"thread_id": thread_id}}, on_event=events.append,
        )
        assert result["interrupted"] is True
        assert transport == []
        assert has_interrupted_graph(thread_id)
        event = next(e for e in events if e["type"] == "iac_approval_request")
        assert event["thread_id"] == thread_id
        assert event["tool"] == "cisco_workflows_apply"
        assert event["classification"]["params"] == ACTION
        assert event["command"] == "POST /v1/workflows"
        assert event["classification"]["tier"] == "high"
        assert event["classification"]["rationale"] == ACTION["rationale"]
        assert event["classification"]["body"] == ACTION["body"]
        assert event["classification"]["query_params"] == ACTION["query_params"]
        assert event["classification"]["target_org_id"] == "synthetic-org"
        assert len([e for e in events if e["type"] == "iac_approval_request"]) == 1
        stored = retrieve_interrupted_graph(thread_id)
        assert stored and stored.graph is graph and stored.thread_id == thread_id
        resumed = await resume_graph(stored.graph, thread_id, decision, events.append, config=stored.config)
        assert resumed["interrupted"] is False
        assert transport == ([(ACTION["method"], ACTION["path"], ACTION["body"], ACTION["query_params"])] if expected_calls else [])
        assert any(e["type"] == "final" for e in events)
        assert len([e for e in events if e["type"] == "iac_approval_request"]) == 1
        assert not has_interrupted_graph(thread_id)
    finally:
        clear_interrupted_graph(thread_id)


@pytest.mark.asyncio
async def test_delegated_stream_uses_root_thread_for_approval_and_resume(transport):
    from ccie_sidecar.agents.deepagents_stream import run_and_stream
    from ccie_sidecar.agents.deepagents_hitl import resume_graph
    from ccie_sidecar.agents.deepagents_state import retrieve_interrupted_graph, clear_interrupted_graph

    tool, index = _tool()
    index.search("createWorkflow", catalog_id="cisco_workflows")
    specialist = SubAgent(name="cisco_workflows-specialist", description="Workflows", system_prompt="Build a workflow", tools=[tool], interrupt_on={"cisco_workflows_apply": {"allowed_decisions": ["approve", "reject"]}})
    graph = create_deep_agent(model=_ApproveModel(delegated=True), tools=[], subagents=[specialist], checkpointer=MemorySaver())
    thread_id = "delegated-workflow-stream"
    events = []
    clear_interrupted_graph(thread_id)
    try:
        paused = await run_and_stream(graph, {"messages": [HumanMessage(content="Build a Cisco Workflow")]}, {"configurable": {"thread_id": thread_id}}, events.append)
        assert paused["interrupted"] is True
        assert transport == []
        approval = [e for e in events if e["type"] == "iac_approval_request"]
        assert len(approval) == 1 and approval[0]["thread_id"] == thread_id
        stored = retrieve_interrupted_graph(thread_id)
        assert stored and stored.graph is graph
        result = await resume_graph(graph, thread_id, "approve", events.append, config=stored.config)
        assert result["interrupted"] is False
        assert len(transport) == 1
        assert len([e for e in events if e["type"] == "iac_approval_request"]) == 1
    finally:
        clear_interrupted_graph(thread_id)


@pytest.mark.asyncio
async def test_approval_is_bound_to_original_organization(transport, monkeypatch):
    from ccie_sidecar.agents.deepagents_stream import run_and_stream
    from ccie_sidecar.agents.deepagents_hitl import resume_graph
    from ccie_sidecar.agents.deepagents_state import retrieve_interrupted_graph, clear_interrupted_graph

    configured = {"api_key": "synthetic", "org_id": "synthetic-org"}
    monkeypatch.setattr("ccie_sidecar.meraki_config.get_meraki_config", lambda: configured)
    tool, index = _tool()
    index.search("createWorkflow", catalog_id="cisco_workflows")
    graph = create_deep_agent(model=_ApproveModel(), tools=[tool], interrupt_on={"cisco_workflows_apply": {"allowed_decisions": ["approve", "reject"]}}, checkpointer=MemorySaver())
    thread_id = "workflows-org-binding"
    events = []
    clear_interrupted_graph(thread_id)
    try:
        paused = await run_and_stream(graph, {"messages": [HumanMessage(content="Build workflow")]}, {"configurable": {"thread_id": thread_id}}, events.append)
        assert paused["interrupted"] is True and transport == []
        approval = [event for event in events if event["type"] == "iac_approval_request"]
        assert len(approval) == 1 and approval[0]["classification"]["target_org_id"] == "synthetic-org"
        configured = {"api_key": "synthetic", "org_id": "different-org"}
        stored = retrieve_interrupted_graph(thread_id)
        assert stored
        resumed = await resume_graph(graph, thread_id, "approve", events.append, config=stored.config)
        assert resumed["interrupted"] is False
        assert transport == []
        assert resumed["error_kind"] is not None
        assert any(e["type"] == "error" and "target organization changed" in e["message"] for e in events)
    finally:
        clear_interrupted_graph(thread_id)


class _ParallelApproveModel(_ApproveModel):
    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        if any(isinstance(msg, ToolMessage) for msg in messages):
            return ChatResult(generations=[ChatGeneration(message=AIMessage(content="Finished"))])
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="", tool_calls=[
            {"name": "cisco_workflows_apply", "args": ACTION, "id": "apply-1"},
            {"name": "cisco_workflows_apply", "args": {**ACTION, "path": "/v1/workflows/start"}, "id": "apply-2"},
        ]))])


@pytest.mark.asyncio
async def test_parallel_workflow_mutations_fail_closed_without_review(transport):
    from ccie_sidecar.agents.deepagents_stream import run_and_stream
    from ccie_sidecar.agents.deepagents_state import has_interrupted_graph, clear_interrupted_graph

    tool, index = _tool()
    index.search("createWorkflow", catalog_id="cisco_workflows")
    graph = create_deep_agent(model=_ParallelApproveModel(), tools=[tool], interrupt_on={"cisco_workflows_apply": {"allowed_decisions": ["approve", "reject"]}}, checkpointer=MemorySaver())
    thread_id = "parallel-workflow-stream"
    events = []
    clear_interrupted_graph(thread_id)
    try:
        result = await run_and_stream(graph, {"messages": [HumanMessage(content="Build two workflows")]}, {"configurable": {"thread_id": thread_id}}, events.append)
        assert result["interrupted"] is True
        assert not has_interrupted_graph(thread_id)
        assert transport == []
        assert not any(e["type"] == "iac_approval_request" for e in events)
        assert any(e["type"] == "error" and "multiple" in e["message"].lower() for e in events)
    finally:
        clear_interrupted_graph(thread_id)


@pytest.mark.asyncio
async def test_workflow_edit_decision_cannot_change_reviewed_payload(transport):
    from ccie_sidecar.agents.deepagents_stream import run_and_stream
    from ccie_sidecar.agents.deepagents_hitl import resume_graph
    from ccie_sidecar.agents.deepagents_state import retrieve_interrupted_graph, clear_interrupted_graph

    tool, index = _tool()
    index.search("createWorkflow", catalog_id="cisco_workflows")
    graph = create_deep_agent(model=_ApproveModel(), tools=[tool], interrupt_on={"cisco_workflows_apply": {"allowed_decisions": ["approve", "reject"]}}, checkpointer=MemorySaver())
    thread_id = "workflow-edit-rejected"
    events = []
    clear_interrupted_graph(thread_id)
    try:
        result = await run_and_stream(graph, {"messages": [HumanMessage(content="Build workflow")]}, {"configurable": {"thread_id": thread_id}}, events.append)
        assert result["interrupted"] is True
        stored = retrieve_interrupted_graph(thread_id)
        assert stored
        result = await resume_graph(graph, thread_id, "edit", events.append, edited_action={"name": "cisco_workflows_apply", "args": {**ACTION, "path": "/v1/workflows/start"}}, config=stored.config)
        assert transport == []
        assert result["error_kind"] is not None
        assert any(e["type"] == "error" for e in events)
    finally:
        clear_interrupted_graph(thread_id)


@pytest.mark.parametrize("missing", ["method", "path", "organization_id"])
def test_stream_rejects_incomplete_approval_without_caching(missing):
    from ccie_sidecar.agents.deepagents_stream import _handle_interrupt
    from ccie_sidecar.agents.deepagents_state import has_interrupted_graph, clear_interrupted_graph

    args = {**ACTION, missing: " "}
    thread_id = f"incomplete-workflow-{missing}"
    events = []
    clear_interrupted_graph(thread_id)
    try:
        handled = _handle_interrupt(
            [{"action_requests": [{"name": "cisco_workflows_apply", "args": args}]}],
            object(), {"configurable": {"thread_id": thread_id}}, thread_id, events.append,
        )
        assert handled is True
        assert len(events) == 1 and events[0]["type"] == "error"
        assert not has_interrupted_graph(thread_id)
    finally:
        clear_interrupted_graph(thread_id)


def test_stream_classifies_delete_as_destructive_without_execution():
    from ccie_sidecar.agents.deepagents_stream import _handle_interrupt
    from ccie_sidecar.agents.deepagents_state import has_interrupted_graph, clear_interrupted_graph

    thread_id = "workflow-delete-preview"
    events = []
    args = {**ACTION, "method": "DELETE", "path": "/v1/workflows/wf-1"}
    clear_interrupted_graph(thread_id)
    try:
        assert _handle_interrupt(
            [{"action_requests": [{"name": "cisco_workflows_apply", "args": args}]}],
            object(), {"configurable": {"thread_id": thread_id}}, thread_id, events.append,
        )
        assert len(events) == 1 and events[0]["classification"]["tier"] == "destructive"
        assert events[0]["classification"]["params"] == args
        assert has_interrupted_graph(thread_id)
    finally:
        clear_interrupted_graph(thread_id)


class _JourneyModel(_ApproveModel):
    """Scripted model: every operation comes from the actual OAS catalog result."""

    steps: tuple[str, ...] = (
        "getAllSchemaQueryParams", "read_schemas", "workflowCreateRequest", "create",
        "addActionRequest", "add_action", "importFromJSONReq", "import",
        "workflowInputParams", "read_inputs", "startWorkflowRequest", "start",
        "getWFInstanceById", "read_instance", "final",
    )

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        step = self.steps[self.turns]
        self.turns += 1
        if step == "final":
            assert "COMPLETED" in messages[-1].content
            response = AIMessage(content="Workflow completed; action results inspected")
        elif step.startswith("read_"):
            record = json.loads(messages[-1].content)["matches"][0]
            run_id = ""
            if step == "read_instance":
                started = [json.loads(m.content).get("data") for m in messages
                           if isinstance(m, ToolMessage) and m.name == "cisco_workflows_apply"
                           and "instance_id" in m.content]
                assert started and isinstance(started[-1], list)
                run_id = started[-1][0]["instance_id"]
            path = record["path"].replace("{wf_instance_id}", run_id)
            params = {"base_type": "workflow", "schema_type": "action"} if step == "read_schemas" else ({"workflow_id": "wf-1"} if step == "read_inputs" else {"detailed": True})
            code = f"print(cisco_workflows_api_call({record['method']!r}, {path!r}, query_params={params!r}))"
            response = AIMessage(content="", tool_calls=[{"name": "execute_python_code", "args": {"code": code}, "id": f"step-{self.turns}"}])
        elif step in {"create", "add_action", "import", "start"}:
            record = json.loads(messages[-1].content)["matches"][0]
            required_field = {"create": "variables", "add_action": "action", "import": "workflow", "start": "input_variables"}[step]
            assert required_field in record["request_body"]["schema"]["properties"]
            bodies = {
                "create": {"name": "Audit 网络 ⚙️", "properties": {"enabled": {"type": "boolean"}}, "variables": [{"name": "target"}], "description": "Audit devices"},
                "add_action": {"action": {"type": "synthetic-action", "properties": {"device": "target"}}, "previous_action": {}},
                "import": {"workflow": {"name": "Imported subworkflow", "actions": [{"type": "synthetic-action"}]}, "subworkflows": []},
                "start": {"input_variables": [{"name": "target", "value": "device-1"}]},
            }
            params = {"workflow_id": "wf-1"} if step == "start" else None
            path = record["path"].replace("{workflow_id}", "wf-1")
            response = AIMessage(content="", tool_calls=[{"name": "cisco_workflows_apply", "args": {"method": record["method"], "path": path, "body": bodies[step], "query_params": params, "rationale": f"Reviewed {step} for Audit workflow", "organization_id": "org-1"}, "id": f"step-{self.turns}"}])
        else:
            response = AIMessage(content="", tool_calls=[{"name": "search_api_catalog", "args": {"query": step, "catalog_id": "cisco_workflows", "limit": 1}, "id": f"step-{self.turns}"}])
        return ChatResult(generations=[ChatGeneration(message=response)])


def test_real_catalog_graph_builds_actions_imports_runs_and_inspects(monkeypatch, tmp_path, request):
    """Complete synthetic flow: no mutation may reach HTTP before each approval."""
    import os
    import socket
    import sqlite3
    import requests
    from pathlib import Path
    from ccie_sidecar.agents.deepagents_tools import create_execute_python_code_tool, create_catalog_search_tool
    from ccie_sidecar.agents.cisco_workflows_tools import build_cisco_workflows_apply_tool

    for key in ("HOME", "USERPROFILE", "APPDATA"):
        monkeypatch.setenv(key, str(tmp_path))
    for key in ("CCIE_CONTEXT_GRAPH", "CCIE_AGENT_LESSONS"):
        monkeypatch.setenv(key, "0")
    for key in ("MERAKI_API_KEY", "MERAKI_DASHBOARD_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    helpers = ("drawio", "proxmox", "blender", "nmap", "uml", "markmap", "wikipedia", "rfc", "devnet_api", "fwrule_helper", "cisco_workflows")
    previous = {name: sys.modules.get(name) for name in helpers}
    def restore():
        for name, module in previous.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
    request.addfinalizer(restore)
    def blocked(*args, **kwargs):
        raise AssertionError("Unexpected operator database or network access")
    monkeypatch.setattr(sqlite3, "connect", blocked)
    monkeypatch.setattr(socket.socket, "connect", blocked)
    monkeypatch.setattr(socket, "create_connection", blocked)
    monkeypatch.setattr("ccie_sidecar.meraki_config.get_meraki_config", lambda: {"api_key": "synthetic", "org_id": "org-1"})
    calls = []
    class Response:
        status_code = 200
        def __init__(self, data):
            self._data = data
        def json(self):
            return self._data
    def request_http(self, method, url, **kwargs):
        assert url.startswith("https://api.meraki.com/api/automate/organizations/org-1/")
        assert kwargs["headers"]["Authorization"] == "Bearer synthetic"
        path = url.removeprefix("https://api.meraki.com/api/automate/organizations/org-1")
        calls.append((method, path, kwargs.get("json"), kwargs.get("params")))
        data = {
            ("GET", "/v1/schemas"): {"schemas": [{"id": "synthetic-action", "inputs": ["device"]}]},
            ("POST", "/v1/workflows"): {"id": "wf-1"},
            ("POST", "/v1/workflows/wf-1/actions"): {"id": "action-1", "type": "synthetic-action"},
            ("POST", "/exchange/v1/workflows/import"): {"id": "imported-1"},
            ("GET", "/v1/workflows/start_config"): {"input_variables": [{"name": "target", "required": True}]},
            ("POST", "/v1/workflows/start"): [{"instance_id": "run-1"}],
            ("GET", "/v1/instances/run-1"): {"state": "COMPLETED", "action_results": [{"id": "action-1", "state": "COMPLETED"}]},
        }
        assert (method, path) in data
        return Response(data[method, path])
    monkeypatch.setattr(requests.Session, "request", request_http)

    entries = json.loads((Path(__file__).resolve().parents[3] / "bundled-agents" / "cisco-workflows" / "tools.json").read_text())
    catalogs = [{"id": "cisco_workflows", "entries": entries}]
    read = create_execute_python_code_tool("cisco_workflows", {}, lambda event: None, catalogs=catalogs)
    search = create_catalog_search_tool(read)
    apply = build_cisco_workflows_apply_tool(read._ccie_catalog_index)
    graph = create_deep_agent(model=_JourneyModel(), tools=[search, read, apply], interrupt_on={"cisco_workflows_apply": {"allowed_decisions": ["approve", "reject"]}}, checkpointer=MemorySaver())
    config = {"configurable": {"thread_id": "complete-workflow-journey"}}
    paused = graph.invoke({"messages": [HumanMessage(content="Build and run a complete Cisco Workflow")], "rubric": "verify actions"}, config)
    assert [(method, path) for method, path, _, _ in calls] == [("GET", "/v1/schemas")]
    for expected, before in [
        ("/v1/workflows", 1),
        ("/v1/workflows/wf-1/actions", 2),
        ("/exchange/v1/workflows/import", 3),
        ("/v1/workflows/start", 5),
    ]:
        pending = graph.get_state(config)
        assert pending.tasks and pending.tasks[0].interrupts
        action = pending.tasks[0].interrupts[0].value["action_requests"][0]
        assert action["name"] == "cisco_workflows_apply" and action["args"]["path"] == expected
        assert len(calls) == before  # no mutation before operator approval
        paused = graph.invoke(Command(resume={"decisions": [{"type": "approve"}]}), config)
        assert ("POST", expected) in [(method, path) for method, path, _, _ in calls]
    assert [(method, path) for method, path, _, _ in calls] == [
        ("GET", "/v1/schemas"), ("POST", "/v1/workflows"),
        ("POST", "/v1/workflows/wf-1/actions"),
        ("POST", "/exchange/v1/workflows/import"),
        ("GET", "/v1/workflows/start_config"),
        ("POST", "/v1/workflows/start"),
        ("GET", "/v1/instances/run-1"),
    ]
    assert calls[1][2]["properties"] and calls[1][2]["variables"]
    assert calls[2][2]["action"]["properties"]
    assert calls[3][2]["workflow"]["actions"]
    assert calls[5][3] == {"workflow_id": "wf-1"}
    assert paused["messages"][-1].content == "Workflow completed; action results inspected"
    assert not graph.get_state(config).tasks
