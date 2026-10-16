"""Cisco Workflows discovery and Architect bindings; all calls stay synthetic."""
import json

import pytest


@pytest.fixture(autouse=True)
def isolated_bootstrap(monkeypatch, tmp_path, request):
    import os
    import socket
    import sqlite3
    import sys
    import requests

    for name in ("HOME", "USERPROFILE", "APPDATA"):
        monkeypatch.setenv(name, str(tmp_path))
    for name in ("CCIE_CONTEXT_GRAPH", "CCIE_AGENT_LESSONS"):
        monkeypatch.setenv(name, "0")
    for name in ("MERAKI_API_KEY", "MERAKI_DASHBOARD_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    registered = ("drawio", "proxmox", "blender", "nmap", "uml", "markmap", "wikipedia", "rfc", "devnet_api", "fwrule_helper", "cisco_workflows")
    previous = {name: sys.modules.get(name) for name in registered}
    def restore():
        for name, module in previous.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
    request.addfinalizer(restore)
    def blocked(*args, **kwargs):
        raise AssertionError("Unexpected database/network access in synthetic fixture")
    monkeypatch.setattr(sqlite3, "connect", blocked)
    monkeypatch.setattr(socket.socket, "connect", blocked)
    monkeypatch.setattr(socket, "create_connection", blocked)
    monkeypatch.setattr(requests.Session, "request", blocked)


CATALOG = [{"id": "cisco_workflows", "entries": [
    {"name": "listWorkflows", "description": "List Cisco Workflows", "endpoint": {"method": "POST", "path": "/v1.1/workflows"}},
    {"name": "createWorkflow", "description": "Create Cisco Workflows", "endpoint": {"method": "POST", "path": "/v1/workflows"}, "request_body": {"schema": {"properties": {"actions": {"type": "array", "items": {"properties": {"type": {"type": "string"}}}}}}}},
    {"name": "startWorkflow", "description": "Start Cisco Workflows instance", "endpoint": {"method": "POST", "path": "/v1/workflows/start"}},
    {"name": "importWorkflow", "description": "Import Cisco Workflows", "endpoint": {"method": "POST", "path": "/exchange/v1/workflows/import"}},
]}]


def test_catalog_search_record_calls_real_read_helper(monkeypatch):
    from ccie_sidecar.agents.code_exec import _build_sandbox_globals
    from ccie_sidecar.agents.deepagents_tools import create_catalog_search_tool
    from langchain_core.tools import StructuredTool
    import sys
    import types

    called = []
    def fake_install(globals_dict, emit=None):
        def cisco_workflows_api_call(method, path, body=None, query_params=None):
            if (method, path) != ("POST", "/v1.1/workflows"):
                raise ValueError("Read helper cannot send workflow mutations")
            called.append((method, path, body, query_params))
            return json.dumps({"status_code": 200, "data": [{"name": "one"}], "error": None})
        globals_dict["cisco_workflows_api_call"] = cisco_workflows_api_call
    fake_module = types.ModuleType("ccie_sidecar.cisco_workflows")
    fake_module.install_cisco_workflows = fake_install
    monkeypatch.setitem(sys.modules, "ccie_sidecar.cisco_workflows", fake_module)
    # Block unrelated helper construction so fixture never reads operator DB/network.
    g = _build_sandbox_globals("cisco_workflows", {}, catalogs=CATALOG)
    assert "cisco_workflows_apply" not in g
    assert not any("apply" in name for name in g if name.startswith("cisco_workflows"))
    assert "cisco_workflows_api_call" in g
    tool = StructuredTool.from_function(lambda code: code, name="execute_python_code", description="test")
    object.__setattr__(tool, "_ccie_catalog_index", g["api_catalog"])
    result = create_catalog_search_tool(tool).invoke({"query": "listWorkflows", "catalog_id": "cisco_workflows"})
    match = next(m for m in result["matches"] if (m.get("method"), m.get("path")) == ("POST", "/v1.1/workflows"))
    assert match["helper"] == "cisco_workflows_api_call" and "name" not in match
    data = json.loads(g[match["helper"]](match["method"], match["path"]))
    assert data["data"] == [{"name": "one"}]
    assert called == [("POST", "/v1.1/workflows", None, None)]
    g["api_catalog"].search("createWorkflow", catalog_id="cisco_workflows")
    with pytest.raises(ValueError, match="Read helper"):
        g["cisco_workflows_api_call"]("POST", "/v1/workflows", body={"name": "not-approved"})


def test_catalog_search_exposes_exact_authoring_schema_not_only_top_level_fields():
    from ccie_sidecar.agents.catalog_grounding import CatalogIndex
    from ccie_sidecar.agents.deepagents_tools import create_catalog_search_tool
    from langchain_core.tools import StructuredTool

    tool = StructuredTool.from_function(lambda code: code, name="execute_python_code", description="test")
    object.__setattr__(tool, "_ccie_catalog_index", CatalogIndex(CATALOG))
    search = create_catalog_search_tool(tool)
    result = search.invoke({"query": "createWorkflow", "catalog_id": "cisco_workflows"})
    match = next(m for m in result["matches"] if (m.get("method"), m.get("path")) == ("POST", "/v1/workflows"))
    assert match["helper"] == "cisco_workflows_api_call" and "name" not in match
    assert match["request_body"]["schema"]["properties"]["actions"]["items"]["properties"]["type"]["type"] == "string"
    assert match["path"] == "/v1/workflows"


def test_architect_routes_explicit_product_only():
    from ccie_sidecar.agents import architect_subagents as arch

    assert "cisco_workflows" in [s["id"] for s in arch.VENDOR_SPECS]
    assert arch.detect_vendor_ids("Cisco Workflows authoring", restrict_to=["cisco_workflows"]) == ["cisco_workflows"]
    assert arch.detect_vendor_ids("Meraki Workflows", restrict_to=["cisco_workflows"]) == ["cisco_workflows"]
    assert arch.detect_vendor_ids("local workflow", restrict_to=["cisco_workflows"]) == []
    assert arch.detect_vendor_ids("XDR automation workflows", restrict_to=["cisco_workflows"]) == []
    assert "cisco_workflows" in [v["id"] for v in arch.keyword_defaults_payload()["vendors"]]


def test_architect_config_requires_both_saved_values(monkeypatch):
    from ccie_sidecar.agents import architect_subagents as arch

    for cfg, expected in [
        (None, False), ({"api_key": "a", "org_id": ""}, False),
        ({"api_key": "  ", "org_id": "org"}, False),
        ({"api_key": "a", "org_id": "org"}, True),
    ]:
        monkeypatch.setattr("ccie_sidecar.meraki_config.get_meraki_config", lambda cfg=cfg: cfg)
        spec = next(s for s in arch.VENDOR_SPECS if s["id"] == "cisco_workflows")
        assert spec["configured"]() is expected


@pytest.mark.asyncio
@pytest.mark.parametrize("agent_id", ["cisco-workflows", "network-architect"])
async def test_real_runtime_compiles_approved_root_and_delegated_graph(monkeypatch, agent_id):
    from langchain_core.language_models.fake_chat_models import FakeListChatModel
    from langgraph.checkpoint.memory import MemorySaver
    from ccie_sidecar import agent
    from ccie_sidecar.agents import deepagents_runtime as runtime
    from ccie_sidecar.agents import deepagents_stream
    from ccie_sidecar.agents import architect_subagents as architect

    monkeypatch.setattr("ccie_sidecar.meraki_config.get_meraki_config", lambda: {"api_key": "synthetic", "org_id": "org-1"})
    if agent_id == "network-architect":
        monkeypatch.setattr(architect, "VENDOR_SPECS", [next(s for s in architect.VENDOR_SPECS if s["id"] == "cisco_workflows")])
    monkeypatch.setattr(agent, "get_saved_config", lambda: {"provider": "openai", "model": "synthetic"})
    monkeypatch.setattr(runtime, "build_chat_model", lambda config: FakeListChatModel(responses=["unused"]))
    monkeypatch.setattr(runtime, "_get_checkpointer", MemorySaver)
    factory = runtime.create_deep_agent
    captured = {}
    def build_real_graph(**kwargs):
        captured.update(kwargs)
        return factory(**kwargs)
    monkeypatch.setattr(runtime, "create_deep_agent", build_real_graph)
    async def synthetic_stream(graph, input_data, config, on_event, **kwargs):
        assert hasattr(graph, "astream")
        assert config["configurable"]["thread_id"] != "default"
        return {"interrupted": False, "final_emitted": True, "steps": 0}
    monkeypatch.setattr(deepagents_stream, "run_and_stream", synthetic_stream)

    result = await runtime.deepagents_react_code_loop(
        agent_def={"agent_id": agent_id, "attached_tools": [{"id": "cisco_workflows", "catalog": CATALOG[0]["entries"]}]},
        user_msg="Create Cisco Workflows", ctx={}, on_event=lambda event: None,
    )
    assert result["final_emitted"] is True
    assert captured["interrupt_on"] == {"cisco_workflows_apply": {"allowed_decisions": ["approve", "reject"]}}
    root_tools = {t.name: t for t in captured["tools"]}
    assert {"execute_python_code", "search_api_catalog", "cisco_workflows_apply"} <= root_tools.keys()
    assert "cisco_workflows" in root_tools["execute_python_code"]._ccie_catalog_index.catalog_ids
    if agent_id == "network-architect":
        specialist = next(s for s in captured["subagents"] if s["name"] == "cisco_workflows-specialist")
        assert specialist["interrupt_on"] == {"cisco_workflows_apply": {"allowed_decisions": ["approve", "reject"]}}
        assert "cisco_workflows_apply" in [t.name for t in specialist["tools"]]


@pytest.mark.asyncio
async def test_two_standalone_pauses_resume_only_their_own_workflow(monkeypatch):
    import requests
    from langchain.agents.middleware import AgentMiddleware
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import AIMessage, ToolMessage
    from langchain_core.outputs import ChatGeneration, ChatResult
    from ccie_sidecar import agent
    from ccie_sidecar.agents import deepagents_runtime as runtime
    from ccie_sidecar.agents.deepagents_hitl import resume_graph
    from ccie_sidecar.agents.deepagents_state import (
        has_interrupted_graph, retrieve_interrupted_graph, clear_interrupted_graph,
    )

    class TurnModel(BaseChatModel):
        workflow_name: str

        @property
        def _llm_type(self):
            return "synthetic-standalone-workflows"

        def bind_tools(self, tools, **kwargs):
            return self

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            results = [msg for msg in messages if isinstance(msg, ToolMessage)]
            if any(msg.name == "cisco_workflows_apply" for msg in results):
                answer = AIMessage(content=f"Finished {self.workflow_name}")
            elif any(msg.name == "search_api_catalog" for msg in results):
                answer = AIMessage(content="", tool_calls=[{"name": "cisco_workflows_apply", "id": "apply", "args": {
                    "method": "POST", "path": "/v1/workflows", "body": {"name": self.workflow_name},
                    "query_params": None, "rationale": f"Create {self.workflow_name}", "organization_id": "org-1",
                }}])
            else:
                answer = AIMessage(content="", tool_calls=[{"name": "search_api_catalog", "id": "search", "args": {
                    "query": "createWorkflow", "catalog_id": "cisco_workflows",
                }}])
            return ChatResult(generations=[ChatGeneration(message=answer)])

    monkeypatch.setattr("ccie_sidecar.meraki_config.get_meraki_config", lambda: {"api_key": "synthetic", "org_id": "org-1"})
    monkeypatch.setattr(agent, "get_saved_config", lambda: {"provider": "openai", "model": "synthetic"})
    names = iter(["workflow-A", "workflow-B"])
    monkeypatch.setattr(runtime, "build_chat_model", lambda config: TurnModel(workflow_name=next(names)))
    monkeypatch.setattr(runtime, "_rubric_middleware", lambda config: AgentMiddleware())
    calls = []

    class Response:
        status_code = 201
        def json(self):
            return {"id": "created"}

    def request(self, method, url, **kwargs):
        calls.append((method, url, kwargs.get("json")))
        return Response()

    monkeypatch.setattr(requests.Session, "request", request)
    agent_def = {"agent_id": "cisco-workflows", "attached_tools": [{"id": "cisco_workflows", "catalog": CATALOG[0]["entries"]}]}
    a_events, b_events = [], []
    a = await runtime.deepagents_react_code_loop(agent_def, "Create A", {}, a_events.append)
    b = await runtime.deepagents_react_code_loop(agent_def, "Create B", {}, b_events.append)
    a_id, b_id = a["thread_id"], b["thread_id"]
    try:
        assert a["interrupted"] and b["interrupted"]
        assert a_id != b_id and a_id != "default" and b_id != "default"
        assert has_interrupted_graph(a_id) and has_interrupted_graph(b_id)
        assert calls == []
        assert [e["classification"]["params"]["body"]["name"] for e in a_events if e["type"] == "iac_approval_request"] == ["workflow-A"]
        assert [e["classification"]["params"]["body"]["name"] for e in b_events if e["type"] == "iac_approval_request"] == ["workflow-B"]
        stored_b = retrieve_interrupted_graph(b_id)
        assert stored_b is not None
        rejected = await resume_graph(stored_b.graph, b_id, "deny", b_events.append, config=stored_b.config)
        assert rejected["interrupted"] is False and calls == []
        assert has_interrupted_graph(a_id)
        stored_a = retrieve_interrupted_graph(a_id)
        assert stored_a is not None
        approved = await resume_graph(stored_a.graph, a_id, "approve", a_events.append, config=stored_a.config)
        assert approved["interrupted"] is False
        assert calls == [("POST", "https://api.meraki.com/api/automate/organizations/org-1/v1/workflows", {"name": "workflow-A"})]
        assert not has_interrupted_graph(a_id) and not has_interrupted_graph(b_id)
    finally:
        clear_interrupted_graph(a_id)
        clear_interrupted_graph(b_id)
