"""Synthetic Task 2 runtime integration; no configured services or saved data."""
from __future__ import annotations

import importlib
import json
import socket
import sqlite3
from pathlib import Path
from uuid import UUID

import pytest

from ccie_sidecar.agents.copilot_canvas import CanvasContext

REQUEST = {"workspace_id": "synthetic-canvas", "run_id": "synthetic-run"}


@pytest.fixture(autouse=True)
def isolated_helpers(monkeypatch, tmp_path):
    """Keep real factories but replace only installed source/network boundaries."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("CCIE_CONTEXT_GRAPH", "0")
    monkeypatch.setenv("CCIE_AGENT_LESSONS", "0")

    def forbidden(*args, **kwargs):
        raise AssertionError("runtime test attempted network or database access")

    monkeypatch.setattr(sqlite3, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)
    import requests
    monkeypatch.setattr(requests.Session, "request", forbidden)
    modules = {
        "agents.drawio_helper": "drawio", "proxmox_api.helper": "proxmox",
        "agents.blender_helper": "blender", "nmap_api.helper": "nmap",
        "agents.uml_helper": "uml", "agents.markmap_helper": "markmap",
        "agents.wikipedia_helper": "wikipedia", "agents.rfc_helper": "rfc",
        "devnet": "devnet", "fwrule": "fwrule",
        "meraki": "meraki", "zabbix": "zabbix",
    }
    for module, name in modules.items():
        imported = importlib.import_module(f"ccie_sidecar.{module}")
        monkeypatch.setattr(imported, f"install_{name}", lambda *args, **kwargs: None)
    from ccie_sidecar.agents import code_exec, architect_subagents as architect
    monkeypatch.setattr(code_exec, "_build_env_overrides", lambda secrets: {})
    monkeypatch.setattr(architect, "VENDOR_SPECS", [])
    monkeypatch.setattr(architect, "load_keyword_overrides", lambda: {})


def text_card(evidence_id):
    ref = {"evidence_id": evidence_id, "path": "/data/0/name"}
    return {"type": "text", "title": "Switch", "source_refs": [ref], "metadata": {"body": ref}}


def test_opt_in_factory_captures_actual_result_and_presents_before_return(monkeypatch):
    from ccie_sidecar import meraki
    from ccie_sidecar.agents.deepagents_tools import create_execute_python_code_tool
    calls, events = [], []
    raw = json.dumps({"data": [{"name": "synthetic-switch", "slot": 0}]})

    def helper(*args, **kwargs):
        calls.append((args, kwargs))
        return raw

    monkeypatch.setattr(meraki, "install_meraki", lambda g, **kw: g.update(meraki_api_call=helper))
    ordinary = create_execute_python_code_tool("meraki", {}, events.append)
    assert ordinary.invoke({"code": "print('canvas' in globals())"}) == "False\n"
    assert events == []
    canvas = CanvasContext(REQUEST, events.append, ())
    tool = create_execute_python_code_tool("meraki", {}, events.append, canvas=canvas)
    result = tool.invoke({"code": (
        "value = meraki_api_call('GET', '/devices', query_params={'count': 1})\n"
        "assert value is expected_result\n"
        "assert not hasattr(canvas, 'capture')\n"
        "source = next(s for s in canvas.sources() if s['source']['helper'] == 'meraki_api_call')\n"
        "ref = {'evidence_id': source['evidence_id'], 'path': '/data/0/name'}\n"
        "canvas.present({'type':'text', 'title':'Switch', 'source_refs':[ref], 'metadata':{'body':ref}})\n"
        "print(value)"
    ).replace("assert value is expected_result", f"assert value == {raw!r}")})
    assert json.loads(result) == json.loads(raw)
    assert calls == [(("GET", "/devices"), {"query_params": {"count": 1}})]
    card = events[0]
    assert card["kind"] == "card"
    assert (card["workspace_id"], card["run_id"]) == (REQUEST["workspace_id"], REQUEST["run_id"])
    snapshot = card["payload"]["snapshots"][0]
    assert snapshot["origin"] == "observed"
    assert UUID(snapshot["call_id"]).version == 4
    assert snapshot["data"] == json.loads(raw)


def test_facade_does_not_expose_context_through_bound_public_methods():
    from ccie_sidecar.agents.deepagents_tools import create_execute_python_code_tool
    events = []
    canvas = CanvasContext(REQUEST, events.append, ())
    tool = create_execute_python_code_tool(None, {}, events.append, canvas=canvas)
    result = tool.invoke({"code": (
        "assert set(vars(canvas)) == {'publish', 'present', 'derive', 'sources'}\n"
        "try:\n"
        "    canvas.present.__self__.capture({'helper':'invented'}, {'invented':True}, call_id='invented')\n"
        "except AttributeError:\n"
        "    print('blocked')\n"
        "for method in (canvas.publish, canvas.present, canvas.derive, canvas.sources):\n"
        "    assert not hasattr(method, '__self__')\n"
    )})
    assert result == "blocked\n"
    assert not any(s["source"]["helper"] == "invented" for s in canvas.snapshots.values())
    assert events == []


@pytest.mark.parametrize("vendor,arguments", [("meraki", ("GET", "/devices")), ("zabbix", ("host.get", {"limit": 1}))])
def test_inline_and_delegated_helpers_share_context_without_changing_calls(monkeypatch, vendor, arguments):
    from ccie_sidecar.agents import architect_subagents as architect
    module = importlib.import_module(f"ccie_sidecar.{vendor}")
    raw, calls, events = {"data": [{"name": "synthetic-switch"}]}, [], []

    def helper(*args, **kwargs):
        calls.append((args, kwargs))
        return raw

    monkeypatch.setattr(module, f"install_{vendor}", lambda g, **kw: g.update({f"{vendor}_api_call": helper, "expected": raw}))
    monkeypatch.setattr(architect, "VENDOR_SPECS", [{"id": vendor, "configured": lambda: True, "display": vendor, "when": "synthetic"}])
    canvas = CanvasContext(REQUEST, events.append, ())
    direct, ids = architect.build_architect_direct_tool(catalogs=[], canvas=canvas)
    delegated = architect.build_vendor_subagents(catalogs=[], canvas=canvas)[0]["tools"][-1]
    code = (
        f"result = {vendor}_api_call(*{arguments!r})\n"
        "assert result is expected\n"
        "source = next(s for s in canvas.sources() if s['origin'] == 'observed')\n"
        "ref = {'evidence_id':source['evidence_id'], 'path':'/data/0/name'}\n"
        "canvas.present({'type':'text','title':'Observed','source_refs':[ref],'metadata':{'body':ref}})\n"
        "print('ok')"
    )
    assert direct.invoke({"code": code}) == "ok\n"
    assert delegated.invoke({"code": code}) == "ok\n"
    assert ids == [vendor]
    assert calls == [(arguments, {}), (arguments, {})]
    cards = [e for e in events if e["kind"] == "card"]
    assert len(cards) == 2
    assert {e["workspace_id"] for e in cards} == {REQUEST["workspace_id"]}
    assert {e["run_id"] for e in cards} == {REQUEST["run_id"]}
    assert len({e["payload"]["snapshots"][0]["call_id"] for e in cards}) == 2
    # JSON-looking stdout is never upgraded to observed evidence.
    outputs = [s for s in canvas.snapshots.values() if s["origin"] == "execution_output"]
    assert len(outputs) == 2
    assert all(s["data"] == "ok\n" for s in outputs)


@pytest.mark.parametrize("delegated", [False, True])
def test_installed_ise_credentials_are_redacted_from_free_text_before_canvas_retention(monkeypatch, delegated):
    from ccie_sidecar import ise, ise_config
    from ccie_sidecar.agents import architect_subagents as architect
    credential = "synthetic-ise-value-927461"
    config = {"host": "synthetic.invalid", "username": "synthetic-admin", "password": credential}
    raw = {"data": {"name": "synthetic-switch"}, "error": f"Upstream echoed {credential}; retry later"}
    calls = []
    monkeypatch.setattr(ise_config, "get_ise_config", lambda: config)

    def call(client, *args, **kwargs):
        assert client._config is config
        calls.append((args, kwargs))
        return raw

    monkeypatch.setattr(ise.IseClient, "call", call)
    monkeypatch.setattr(architect, "VENDOR_SPECS", [{"id": "ise", "configured": lambda: True, "display": "ISE", "when": "synthetic"}])
    events = []
    canvas = CanvasContext(REQUEST, events.append, ())
    if delegated:
        tool = architect.build_vendor_subagents(catalogs=[], canvas=canvas)[0]["tools"][-1]
    else:
        tool, _ = architect.build_architect_direct_tool(catalogs=[], canvas=canvas)
    result = tool.invoke({"code": (
        "value = ise_api_call('GET', '/ers/config/networkdevice')\n"
        "source = next(s for s in canvas.sources() if s['source']['helper']=='ise_api_call')\n"
        "ref = {'evidence_id':source['evidence_id'], 'path':'/error'}\n"
        "canvas.present({'type':'text', 'title':'Source error', 'source_refs':[ref], 'metadata':{'body':ref}})\n"
        "print(value)"
    )})
    # Preserve the successful helper's existing return, not arbitrary-error hiding.
    assert json.loads(result) == raw
    assert len(calls) == 1
    assert credential not in json.dumps(canvas.snapshots)
    assert credential not in json.dumps(events)
    snapshot = next(s for s in canvas.snapshots.values() if s["origin"] == "observed")
    assert snapshot["data"] == {"data": {"name": "synthetic-switch"}, "error": "Upstream echoed [REDACTED]; retry later"}
    assert events[0]["payload"]["snapshots"][0]["data"] == snapshot["data"]


@pytest.mark.parametrize("delegated", [False, True])
def test_workflows_registers_returned_client_credentials_without_exposing_apply(monkeypatch, delegated):
    from ccie_sidecar import cisco_workflows, meraki_config
    from ccie_sidecar.agents import architect_subagents as architect
    credential = "synthetic-workflows-value-76123"
    config = {"api_key": credential, "org_id": "synthetic-org"}
    raw = {"error": f"Upstream echoed {credential}"}
    calls = []
    monkeypatch.setattr(meraki_config, "get_meraki_config", lambda: config)

    def call(client, *args, **kwargs):
        assert client._config is config
        calls.append((args, kwargs))
        return raw

    monkeypatch.setattr(cisco_workflows.CiscoWorkflowsClient, "call", call)
    monkeypatch.setattr(architect, "VENDOR_SPECS", [{"id": "cisco_workflows", "configured": lambda: True, "display": "Workflows", "when": "synthetic"}])
    events = []
    canvas = CanvasContext(REQUEST, events.append, ("synthetic-constructor-value",))
    if delegated:
        specialist = architect.build_vendor_subagents(catalogs=[], canvas=canvas)[0]
        tool = next(t for t in specialist["tools"] if t.name == "execute_python_code")
    else:
        tool, _ = architect.build_architect_direct_tool(catalogs=[], canvas=canvas)
    result = tool.invoke({"code": (
        "assert 'cisco_workflows' not in globals()\n"
        "assert 'cisco_workflows_apply' not in globals()\n"
        "value = cisco_workflows_api_call('GET', '/v1.1/workflows')\n"
        "source = next(s for s in canvas.sources() if s['source']['helper']=='cisco_workflows_api_call')\n"
        "ref = {'evidence_id':source['evidence_id'], 'path':'/error'}\n"
        "canvas.present({'type':'text', 'title':'synthetic-constructor-value', 'source_refs':[ref], 'metadata':{'body':ref}})\n"
        "print(value)"
    )})
    assert json.loads(result) == raw
    assert len(calls) == 1
    assert credential not in json.dumps(canvas.snapshots)
    assert credential not in json.dumps(events)
    assert "synthetic-constructor-value" not in json.dumps(events)
    assert events[0]["payload"]["card"]["title"] == "[REDACTED]"
    assert events[0]["payload"]["snapshots"][0]["data"] == {"error": "Upstream echoed [REDACTED]"}


def test_capture_failure_preserves_helper_identity_and_exception_once(monkeypatch):
    from ccie_sidecar import meraki
    from ccie_sidecar.agents.code_exec import _build_sandbox_globals
    raw, calls = {"actual": []}, []
    error = ValueError("synthetic helper failure")

    def helper(*args, **kwargs):
        calls.append((args, kwargs))
        if kwargs.get("fail"):
            raise error
        return raw

    monkeypatch.setattr(meraki, "install_meraki", lambda g, **kw: g.update(meraki_api_call=helper))
    canvas = CanvasContext(REQUEST, lambda e: None, ())
    monkeypatch.setattr(canvas, "capture", lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("capture broken")))
    sandbox = _build_sandbox_globals("meraki", {}, canvas=canvas)
    assert sandbox["meraki_api_call"]("GET", "/devices") is raw
    with pytest.raises(ValueError) as caught:
        sandbox["meraki_api_call"]("GET", "/devices", fail=True)
    assert caught.value is error
    assert calls == [(("GET", "/devices"), {}), (("GET", "/devices"), {"fail": True})]


def test_topolograph_captures_original_result_before_existing_summary(monkeypatch):
    from ccie_sidecar import topolograph
    from ccie_sidecar.agents import architect_subagents as architect
    calls, events = [], []
    raw = {"nodes": [{"id": "switch-1"}], "edges": [], "accepted": True}

    class Client:
        def __init__(self, config, token):
            assert token == "synthetic-private-token"

        def call_tool(self, operation, arguments):
            calls.append((operation, arguments))
            return raw

    monkeypatch.setattr(topolograph, "TopolographClient", Client)
    binding = architect.TopolographAgentBinding("https://synthetic.invalid", False, "synthetic-private-token")
    canvas = CanvasContext(REQUEST, events.append, (binding.token,))
    ordinary = architect.build_topolograph_specialist(binding, catalogs=[])["tools"][-1]
    specialist = architect.build_vendor_subagents(topolograph_binding=binding, catalogs=[], canvas=canvas)[0]
    tool = specialist["tools"][-1]
    args = {"operation": "get_graph", "arguments": {"graph_id": "synthetic"}}
    assert tool.invoke(args) == ordinary.invoke(args)
    assert calls == [("get_graph", {"graph_id": "synthetic"})] * 2
    snapshot = next(iter(canvas.snapshots.values()))
    assert snapshot["data"] == raw
    assert snapshot["source"]["helper"] == "topolograph_mcp_call"
    assert snapshot["origin"] == "observed"
    assert binding.token not in json.dumps(canvas.snapshots)


def test_delegated_canvas_guidance_prefers_available_python_facade(monkeypatch):
    from ccie_sidecar.agents import architect_subagents as architect
    monkeypatch.setattr(architect, "VENDOR_SPECS", [{"id": "meraki", "configured": lambda: True,
                                                  "display": "Meraki", "when": "synthetic"}])
    canvas = CanvasContext(REQUEST, lambda event: None, ())
    specialist = architect.build_vendor_subagents(catalogs=[], canvas=canvas)[0]
    assert [tool.name for tool in specialist["tools"]] == ["execute_python_code"]
    description = specialist["tools"][0].description
    assert description.index("canvas.publish(") < description.index("canvas_publish"), "delegate guidance must prefer its available Python facade"
    assert "If native canvas_publish is available in your tool list" in description


@pytest.mark.asyncio
@pytest.mark.parametrize("enabled", [False, True])
async def test_runtime_uses_existing_factories_and_callback_progressively(monkeypatch, enabled):
    from langchain_core.language_models.fake_chat_models import FakeListChatModel
    from ccie_sidecar import agent, meraki
    from ccie_sidecar.agents import architect_subagents as architect, deepagents_runtime as runtime, deepagents_stream
    monkeypatch.setattr(agent, "get_saved_config", lambda: {"provider": "openai", "model": "synthetic"})
    monkeypatch.setattr(runtime, "build_chat_model", lambda config: FakeListChatModel(responses=["unused"]))
    monkeypatch.setattr("ccie_sidecar.agents.catalog_grounding.resolve_agent_catalogs", lambda definition: [])
    monkeypatch.setattr(architect, "VENDOR_SPECS", [{"id": "meraki", "configured": lambda: True, "display": "Meraki", "when": "synthetic"}])
    monkeypatch.setattr(meraki, "install_meraki", lambda g, **kw: g.update(meraki_api_call=lambda *a, **kw: {"data": [{"name": "synthetic-switch"}]}))
    factory_args = {}
    real_factory = runtime.create_deep_agent

    def factory(**kwargs):
        factory_args.update(kwargs)
        return real_factory(**kwargs)

    monkeypatch.setattr(runtime, "create_deep_agent", factory)
    events = []

    async def stream(graph, input_data, config, on_event, **kwargs):
        assert config["configurable"]["thread_id"] == "original-thread"
        execute = next(t for t in factory_args["tools"] if t.name == "execute_python_code")
        delegated = factory_args["subagents"][0]["tools"][-1]
        if enabled:
            code = (
                "value = meraki_api_call('GET','/devices')\n"
                "canvas.publish({'type':'text','title':'Switch','metadata':{'body':value['data'][0]['name']}})"
            )
            assert execute.invoke({"code": code}) == "(no output)"
            assert delegated.invoke({"code": code}) == "(no output)"
            assert len([e for e in events if e["type"] == "canvas"]) == 2
        else:
            assert execute.invoke({"code": "print('canvas' in globals())"}) == "False\n"
            assert delegated.invoke({"code": "print('canvas' in globals())"}) == "False\n"
        on_event({"type": "final", "response": "normal chat answer"})
        return {"interrupted": False, "final_emitted": True, "steps": 1}

    monkeypatch.setattr(deepagents_stream, "run_and_stream", stream)
    outcome = await runtime.deepagents_react_code_loop(
        {"agent_id": "network-architect", "system_prompt": "Existing Architect"},
        "Explain switch issues", {"run_id": "original-thread", **({"canvas": REQUEST} if enabled else {})}, events.append,
    )
    assert outcome["final_emitted"] is True
    assert events[-1]["type"] == "final"
    assert ("Recommendation — not executed" in factory_args["system_prompt"]) is enabled
    # Delivery only: the synthetic model does not demonstrate model compliance.
    principles = (
        "publish useful display-ready cards with the preloaded Python",
        "If native canvas_publish is available in your tool list",
        "Supply actual JSON values, not evidence IDs, pointers",
        "agent-authored summaries — not independently verified evidence",
        "configuration is not proof of a health alert",
        "bar/line charts for numeric",
        "topology graphs for relationships",
        "never repeat source operations",
    )
    for delivered in (
        factory_args["system_prompt"],
        next(t for t in factory_args["tools"] if t.name == "execute_python_code").description,
        factory_args["subagents"][0]["tools"][-1].description,
    ):
        assert all((principle in delivered) is enabled for principle in principles)
    if not enabled:
        assert not any(e["type"] == "canvas" for e in events)


@pytest.mark.parametrize("engine", ["deepagents", "legacy"])
def test_server_forwards_optional_request_without_changing_existing_context(monkeypatch, engine):
    import io
    from ccie_sidecar import agents, server
    from ccie_sidecar.agents import deepagents_runtime
    captured = {}

    async def loop(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(deepagents_runtime, "deepagents_react_code_loop", loop)
    monkeypatch.setattr(agents, "react_code_loop", loop)
    request = {"id": "synthetic-rpc", "method": "agent.react_code_loop", "params": {
        "agent_id": "network-architect", "message": "Explain", "engine": engine,
        "history": [], "canvas": REQUEST, "run_id": "original-thread",
    }}
    server.run_loop(io.StringIO(json.dumps(request) + "\n"), io.StringIO())
    assert captured["ctx"]["canvas"] == REQUEST
    assert captured["ctx"]["history"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize("decision,changed_target,expected_mutations", [("approve", False, 1), ("deny", False, 0), ("approve", True, 0)])
async def test_real_approval_resume_retains_context_and_changes_only_callback(monkeypatch, decision, changed_target, expected_mutations):
    from langchain.agents.middleware import AgentMiddleware
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import AIMessage, ToolMessage
    from langchain_core.outputs import ChatGeneration, ChatResult
    from ccie_sidecar import agent, meraki, cisco_workflows
    from ccie_sidecar.agents import architect_subagents as architect, deepagents_runtime as runtime
    from ccie_sidecar.agents.deepagents_hitl import resume_graph
    from ccie_sidecar.agents.deepagents_state import retrieve_interrupted_graph, clear_interrupted_graph, has_interrupted_graph
    catalog = [{"id": "cisco_workflows", "entries": [{"name": "createWorkflow", "endpoint": {"method": "POST", "path": "/v1/workflows"}}]}]
    action = {"method": "POST", "path": "/v1/workflows", "body": {"name": "synthetic"}, "rationale": "explicit test approval", "organization_id": "original-org"}
    before_code = (
        "meraki_api_call('GET','/devices')\n"
        "source = next(s for s in canvas.sources() if s['origin']=='observed')\n"
        "saved_ref = {'evidence_id':source['evidence_id'],'path':'/data/0/name'}\n"
        "canvas.present({'type':'text','title':'Before','source_refs':[saved_ref],'metadata':{'body':saved_ref}})"
    )
    after_code = "canvas.present({'type':'text','title':'After','source_refs':[saved_ref],'metadata':{'body':saved_ref}})"

    class Model(BaseChatModel):
        @property
        def _llm_type(self):
            return "synthetic-canvas-approval"

        def bind_tools(self, tools, **kwargs):
            return self

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            results = [m for m in messages if isinstance(m, ToolMessage)]
            executions = sum(m.name == "execute_python_code" for m in results)
            if executions == 0:
                name, args = "execute_python_code", {"code": before_code}
            elif not any(m.name == "search_api_catalog" for m in results):
                name, args = "search_api_catalog", {"query": "createWorkflow", "catalog_id": "cisco_workflows"}
            elif not any(m.name == "cisco_workflows_apply" for m in results):
                name, args = "cisco_workflows_apply", action
            elif executions == 1:
                name, args = "execute_python_code", {"code": after_code}
            else:
                return ChatResult(generations=[ChatGeneration(message=AIMessage(content="Normal chat answer"))])
            return ChatResult(generations=[ChatGeneration(message=AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": f"synthetic-{len(results)}"}]))])

    configured = {"api_key": "synthetic-api-key", "org_id": "original-org"}
    monkeypatch.setattr("ccie_sidecar.meraki_config.get_meraki_config", lambda: configured)
    monkeypatch.setattr(agent, "get_saved_config", lambda: {"provider": "openai", "model": "synthetic"})
    monkeypatch.setattr(runtime, "build_chat_model", lambda config: Model())
    monkeypatch.setattr(runtime, "_rubric_middleware", lambda config: AgentMiddleware())
    monkeypatch.setattr("ccie_sidecar.agents.catalog_grounding.resolve_agent_catalogs", lambda definition: catalog)
    monkeypatch.setattr(cisco_workflows, "install_cisco_workflows", lambda *a, **kw: None)
    monkeypatch.setattr(architect, "VENDOR_SPECS", [{"id": v, "configured": lambda: True, "display": v, "when": "synthetic"} for v in ("meraki", "cisco_workflows")])
    source_calls, mutations = [], []

    def source(*args):
        source_calls.append(args)
        return {"data": [{"name": "switch-original"}]}

    class Client:
        def __init__(self, config):
            pass

        def apply(self, *args, **kwargs):
            mutations.append((args, kwargs))
            return {"status_code": 201, "data": {"id": "synthetic-created"}, "error": None}

    monkeypatch.setattr(meraki, "install_meraki", lambda g, **kw: g.update(meraki_api_call=source))
    monkeypatch.setattr(cisco_workflows, "CiscoWorkflowsClient", Client)
    original, resumed = [], []
    thread_id = f"canvas-{decision}-{changed_target}"
    clear_interrupted_graph(thread_id)
    try:
        paused = await runtime.deepagents_react_code_loop(
            {"agent_id": "network-architect"}, "Explicit synthetic change", {"canvas": REQUEST, "run_id": thread_id}, original.append,
        )
        assert paused["interrupted"] is True
        assert source_calls == [("GET", "/devices")]
        assert mutations == []
        approval = next(e for e in original if e["type"] == "iac_approval_request")
        assert approval["classification"]["params"] == action
        assert approval["classification"]["target_org_id"] == "original-org"
        before = next(e for e in original if e["type"] == "canvas")
        state = retrieve_interrupted_graph(thread_id)
        assert state is not None
        if changed_target:
            configured = {**configured, "org_id": "different-org"}
        old_length = len(original)
        outcome = await resume_graph(state.graph, thread_id, decision, resumed.append, config=state.config)
        if changed_target:
            assert outcome["final_emitted"] is False
            assert any(e["type"] == "error" and "target organization changed" in e["message"] for e in resumed)
            assert mutations == [] and source_calls == [("GET", "/devices")]
            assert len(original) == old_length
            return
        assert outcome["final_emitted"] is True
        assert len(original) == old_length, "resumed Canvas must not leak to the initial RPC callback"
        after = next(e for e in resumed if e["type"] == "canvas")
        assert after["seq"] > before["seq"]
        assert after["workspace_id"] == before["workspace_id"] == REQUEST["workspace_id"]
        assert after["run_id"] == before["run_id"] == REQUEST["run_id"]
        assert after["payload"]["snapshots"] == before["payload"]["snapshots"]
        assert source_calls == [("GET", "/devices")]
        assert len(mutations) == expected_mutations
        assert not has_interrupted_graph(thread_id)
    finally:
        clear_interrupted_graph(thread_id)


@pytest.mark.asyncio
async def test_cancel_stops_canvas_delivery_without_replaying_source(monkeypatch):
    import asyncio
    from ccie_sidecar.agents.code_exec import _CanvasTurn
    from ccie_sidecar.agents.deepagents_tools import create_execute_python_code_tool
    from ccie_sidecar.agents.deepagents_stream import run_and_stream
    from ccie_sidecar.agents.deepagents_state import has_interrupted_graph
    from ccie_sidecar import meraki
    calls, events = [], []

    def helper(*args):
        calls.append(args)
        return {"data": [{"name": "switch-1"}]}

    monkeypatch.setattr(meraki, "install_meraki", lambda g, **kw: g.update(meraki_api_call=helper))
    turn = _CanvasTurn(REQUEST, events.append, ())
    tool = create_execute_python_code_tool("meraki", {}, events.append, canvas=turn.context)
    started, blocker = asyncio.Event(), asyncio.Event()

    class Graph:
        _ccie_canvas_turn = turn

        async def astream(self, input_data, config, **kwargs):
            tool.invoke({"code": "meraki_api_call('GET','/devices')"})
            started.set()
            await blocker.wait()
            yield ((), "updates", {})

    task = asyncio.create_task(run_and_stream(Graph(), {"messages": []}, {"configurable": {"thread_id": "cancelled-canvas"}}, events.append))
    await asyncio.wait_for(started.wait(), timeout=2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    snapshots = turn.context.snapshots
    observed = next(s for s in snapshots.values() if s["origin"] == "observed")
    assert calls == [("GET", "/devices")]
    assert not has_interrupted_graph("cancelled-canvas")
    # A late renderer/capture callback cannot leak into a cancelled request.
    assert turn.context.present(text_card(observed["evidence_id"]))["kind"] == "warning"
    assert events == []
    assert turn.context.snapshots == snapshots


@pytest.mark.asyncio
@pytest.mark.parametrize("enabled", [False, True])
async def test_legacy_react_code_uses_same_optional_canvas_seam(monkeypatch, enabled):
    from ccie_sidecar import agent
    react = importlib.import_module("ccie_sidecar.agents.react_code")
    monkeypatch.setattr(agent, "get_saved_config", lambda: {"provider": "openai", "model": "synthetic", "api_key": "synthetic-api-key"})
    monkeypatch.setattr("ccie_sidecar.agents.catalog_grounding.resolve_agent_catalogs", lambda definition: [])
    responses = iter([
        {"stop_reason": "tool_use", "content": [{"type": "tool_use", "id": "synthetic-exec", "name": "execute_python_code", "input": {"code": "print(json.dumps({'invented': True}))\nprint('canvas' in globals())"}}]},
        {"stop_reason": "end_turn", "content": [{"type": "text", "text": "normal answer"}]},
    ])
    prompts = []

    def model(**kwargs):
        prompts.append(kwargs["system_prompt"])
        return next(responses)

    monkeypatch.setattr(react, "_call_llm_with_tools", model)
    events = []
    await react.react_code_loop({"agent_id": "network-architect"}, "Explain", {"canvas": REQUEST} if enabled else {}, events.append)
    assert events[-1] == {"type": "final", "response": "normal answer"}
    result = next(e["result"] for e in events if e["type"] == "tool_result")
    assert result.endswith("True\n" if enabled else "False\n")
    assert ("Recommendation — not executed" in prompts[0]) is enabled


@pytest.mark.parametrize("memory_enabled", [False, True])
def test_catalog_remains_outermost_and_memory_flags_keep_existing_semantics(monkeypatch, memory_enabled):
    from ccie_sidecar import meraki
    from ccie_sidecar.agents import code_exec, graph_helper, compact_helper, graph_autocapture
    from ccie_sidecar.agents.catalog_grounding import CatalogGroundingError
    monkeypatch.setenv("CCIE_CONTEXT_GRAPH", "1" if memory_enabled else "0")
    monkeypatch.setattr(graph_helper, "install_graph", lambda *a, **kw: None)
    monkeypatch.setattr(compact_helper, "install_compact", lambda *a, **kw: None)
    memory_calls, source_calls = [], []
    monkeypatch.setattr(graph_autocapture, "capture", lambda *args: memory_calls.append(args))

    def helper(*args, **kwargs):
        source_calls.append((args, kwargs))
        return '{"status_code":200,"data":[]}'

    monkeypatch.setattr(meraki, "install_meraki", lambda g, **kw: g.update(meraki_api_call=helper))
    canvas = CanvasContext(REQUEST, lambda e: None, ())
    sandbox = code_exec._build_sandbox_globals("meraki", {}, canvas=canvas, catalogs=[{"id": "meraki", "entries": [
        {"name": "listDevices", "endpoint": {"method": "GET", "path": "/devices"}},
    ]}])
    with pytest.raises(CatalogGroundingError):
        sandbox["meraki_api_call"]("GET", "/devices")
    assert source_calls == [] and memory_calls == [] and canvas.snapshots == {}
    sandbox["api_catalog"].search("listDevices", catalog_id="meraki")
    for _ in range(2):
        assert sandbox["meraki_api_call"]("GET", "/devices") == '{"status_code":200,"data":[]}'
    assert len(source_calls) == (1 if memory_enabled else 2)
    assert len(memory_calls) == (2 if memory_enabled else 0)
    assert len(canvas.snapshots) == len(source_calls)
    assert "graph" not in sandbox and "lessons" not in sandbox


def test_stdout_stays_execution_output_and_source_summary_is_bounded():
    from ccie_sidecar.agents.deepagents_tools import create_execute_python_code_tool
    from ccie_sidecar.agents.tool_output import DEFAULT_MAX_RETURN_CHARS
    canvas = CanvasContext(REQUEST, lambda e: None, ())
    tool = create_execute_python_code_tool(None, {}, lambda e: None, canvas=canvas)
    raw = '{"model_authored":true}\n'
    assert tool.invoke({"code": f"print({raw.strip()!r})"}) == raw
    snapshot = next(iter(canvas.snapshots.values()))
    assert snapshot["data"] == raw and snapshot["origin"] == "execution_output"
    for _ in range(500):
        canvas.capture({"helper": "synthetic_source"}, {}, call_id=str(UUID(int=1)))
    assert tool.invoke({"code": f"assert len(json.dumps(canvas.sources()).encode('utf-8')) <= {DEFAULT_MAX_RETURN_CHARS}"}) == "(no output)"
    assert len(canvas.snapshots) == 502
    from ccie_sidecar.agents.deepagents_tools import create_canvas_tools
    sources, _ = create_canvas_tools(canvas)
    summary = sources.invoke({})
    assert len(json.dumps(summary).encode("utf-8")) <= DEFAULT_MAX_RETURN_CHARS
    assert len(summary) < len(canvas.snapshots)
    summary[0]["source"]["helper"] = "invented"
    assert all(s["source"]["helper"] != "invented" for s in canvas.snapshots.values())


@pytest.mark.parametrize("vendor", [
    "meraki", "stealthwatch", "ise", "secure_endpoint", "cisco_workflows",
    "cisco_xdr", "mist", "cml", "catalyst_center", "aci", "fmc", "thousandeyes",
    "splunk", "grafana", "zabbix", "prometheus", "netbox", "sketchfab", "devnet",
])
def test_each_installed_api_helper_is_captured_without_rewriting_arguments(monkeypatch, vendor):
    from ccie_sidecar.agents.code_exec import _build_sandbox_globals
    module = importlib.import_module(f"ccie_sidecar.{vendor}")
    raw, calls = {"data": [0, False, None]}, []

    def helper(*args, **kwargs):
        calls.append((args, kwargs))
        return raw

    monkeypatch.setattr(module, f"install_{vendor}", lambda g, **kw: g.update({f"{vendor}_api_call": helper}))
    canvas = CanvasContext(REQUEST, lambda e: None, ())
    sandbox = _build_sandbox_globals(vendor, {}, canvas=canvas)
    args, kwargs = ("synthetic-operation", {"target": "switch-1"}), {"synthetic_option": False}
    assert sandbox[f"{vendor}_api_call"](*args, **kwargs) is raw
    assert calls == [(args, kwargs)]
    snapshot = next(s for s in canvas.snapshots.values() if s["source"]["helper"] == f"{vendor}_api_call")
    assert snapshot["data"] == raw and snapshot["origin"] == "observed"


def test_oversized_helper_string_is_not_parsed_or_promoted_to_complete_data(monkeypatch):
    from ccie_sidecar import meraki
    from ccie_sidecar.agents.code_exec import _build_sandbox_globals
    from ccie_sidecar.agents.tool_output import DEFAULT_MAX_RETAINED_BYTES
    raw = json.dumps({"data": "x" * DEFAULT_MAX_RETAINED_BYTES})
    monkeypatch.setattr(meraki, "install_meraki", lambda g, **kw: g.update(meraki_api_call=lambda *a: raw))
    events, oversized_parses = [], []
    canvas = CanvasContext(REQUEST, events.append, ())
    sandbox = _build_sandbox_globals("meraki", {}, canvas=canvas)
    real_loads = json.loads

    def bounded_loads(value, *args, **kwargs):
        if len(value.encode("utf-8")) > DEFAULT_MAX_RETAINED_BYTES:
            oversized_parses.append(True)
        return real_loads(value, *args, **kwargs)

    monkeypatch.setattr(json, "loads", bounded_loads)
    assert sandbox["meraki_api_call"]("GET", "/devices") is raw
    assert oversized_parses == []
    assert canvas.snapshots == {}
    assert events[-1]["kind"] == "warning"
    assert events[-1]["payload"]["snapshot"]["complete"] is False


@pytest.mark.asyncio
async def test_step_checkpoint_retains_canvas_without_replaying_source(monkeypatch):
    from langchain_core.messages import AIMessage
    from langgraph.errors import GraphRecursionError
    from ccie_sidecar import meraki
    from ccie_sidecar.agents.code_exec import _CanvasTurn
    from ccie_sidecar.agents.deepagents_tools import create_execute_python_code_tool
    from ccie_sidecar.agents.deepagents_stream import run_and_stream
    from ccie_sidecar.agents.deepagents_hitl import continue_graph
    from ccie_sidecar.agents.deepagents_state import retrieve_interrupted_graph, clear_interrupted_graph
    calls, initial, resumed = [], [], []

    def source(*args):
        calls.append(args)
        return {"data": [{"name": "original-switch"}]}

    monkeypatch.setattr(meraki, "install_meraki", lambda g, **kw: g.update(meraki_api_call=source))
    turn = _CanvasTurn(REQUEST, initial.append, ())
    tool = create_execute_python_code_tool("meraki", {}, initial.append, canvas=turn.context)

    class Graph:
        _ccie_canvas_turn = turn

        async def astream(self, input_data, config, **kwargs):
            if input_data is not None:
                assert tool.invoke({"code": (
                    "meraki_api_call('GET','/devices')\n"
                    "source = next(s for s in canvas.sources() if s['origin']=='observed')\n"
                    "ref = {'evidence_id':source['evidence_id'],'path':'/data/0/name'}\n"
                    "canvas.present({'type':'text','title':'Before','source_refs':[ref],'metadata':{'body':ref}})"
                )}) == "(no output)"
                raise GraphRecursionError("synthetic checkpoint")
            assert tool.invoke({"code": "canvas.present({'type':'text','title':'After','source_refs':[ref],'metadata':{'body':ref}})"}) == "(no output)"
            yield ((), "updates", {"agent": {"messages": [AIMessage(content="Normal answer")]}})

    thread_id = "synthetic-canvas-checkpoint"
    clear_interrupted_graph(thread_id)
    try:
        paused = await run_and_stream(Graph(), {"messages": []}, {"configurable": {"thread_id": thread_id}, "recursion_limit": 60}, initial.append, continue_on_step_limit=True)
        assert paused["continuation_available"] is True
        state = retrieve_interrupted_graph(thread_id)
        assert state is not None
        initial_length = len(initial)
        outcome = await continue_graph(state.graph, state.config, resumed.append)
        assert outcome["final_emitted"] is True
        assert len(initial) == initial_length
        assert calls == [("GET", "/devices")]
        before = next(e for e in initial if e["type"] == "canvas")
        after = next(e for e in resumed if e["type"] == "canvas")
        assert after["seq"] == before["seq"] + 1
        assert after["payload"]["snapshots"] == before["payload"]["snapshots"]
    finally:
        clear_interrupted_graph(thread_id)


def test_native_canvas_ref_extra_key_sanitized_replay():
    """Replay observed structure; synthetic_extra is NOT the unknown native key."""
    from ccie_sidecar.agents.deepagents_tools import create_canvas_tools
    events = []
    canvas = CanvasContext(REQUEST, events.append, ())
    evidence_id = canvas.capture({"helper": "synthetic_inventory"}, {"health": "degraded"}, call_id="synthetic-call")
    ref = {"evidence_id": evidence_id, "path": ""}
    malformed_ref = {**ref, "synthetic_extra": "explicitly synthetic"}
    spec = {"type": "assessment", "title": "Sanitized replay", "source_refs": [malformed_ref], "metadata": {"narrative": "Synthetic observed health is degraded; interface unassessed.", "supporting_refs": [ref], "contradictory_refs": [], "unknowns": ["Interface unassessed."], "remediation_considerations": []}}
    present = create_canvas_tools(canvas)[1]
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        present.args_schema.model_validate(spec)
    result = json.loads(present.invoke(spec))
    assert result["kind"] == "warning" and "exactly evidence_id and path" in result["limitation"]
    assert canvas.present(spec) == {"kind": "warning", "limitation": "invalid evidence reference"}
    assert not any(event["kind"] == "card" for event in events)
    canvas.finish_presentation()
    assert "no validated cards" in events[-1]["payload"]["limitation"]


def test_native_canvas_table_cell_missing_ref_keys_sanitized_replay():
    """Replay observed cell shape without claiming the unknown native key/value."""
    from ccie_sidecar.agents.deepagents_tools import create_canvas_tools
    events = []
    canvas = CanvasContext(REQUEST, events.append, ())
    evidence_id = canvas.capture({"helper": "synthetic_inventory"}, {"health": "degraded"}, call_id="synthetic-call")
    ref = {"evidence_id": evidence_id, "path": ""}
    cell = {"synthetic_unknown_key": "explicitly synthetic"}
    spec = {"type": "table", "title": "Sanitized nested replay", "source_refs": [ref], "metadata": {"columns": [{"key": "synthetic_column", "label": "Synthetic health"}], "rows": [{"cells": {"synthetic_column": cell}}]}}
    present = create_canvas_tools(canvas)[1]
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        present.args_schema.model_validate(spec)
    result = json.loads(present.invoke(spec))
    assert result["kind"] == "warning" and "exactly evidence_id and path" in result["limitation"]
    assert canvas.present(spec) == {"kind": "warning", "limitation": "invalid evidence reference"}
    assert not any(event["kind"] == "card" for event in events)


def test_native_canvas_all_seven_fixture_shapes_use_closed_plain_json_contracts():
    from pydantic import ValidationError
    from ccie_sidecar.agents.deepagents_tools import create_canvas_tools
    fixture = json.loads((Path(__file__).resolve().parents[3] / "tests/fixtures/copilot_canvas/v1.json").read_text())
    events = []
    canvas = CanvasContext(fixture["request"], events.append, ())
    ids = {item["evidence_id"]: canvas.capture(item["source"], item["data"], call_id=item["call_id"]) for item in fixture["snapshots"]}
    present = create_canvas_tools(canvas)[1]
    schema = present.tool_call_schema.model_json_schema()
    assert set(schema["properties"]) == {"type", "title", "source_refs", "metadata"}
    variants = schema["properties"]["metadata"]["anyOf"]
    assert len(variants) == 7
    for record in schema["$defs"].values():
        assert record["type"] == "object" and record["additionalProperties"] is False
        assert set(record["required"]) == set(record["properties"])

    def corrupt_refs(value):
        if isinstance(value, dict):
            if set(value) == {"evidence_id", "path"}:
                return {**value, "synthetic_extra": "not permitted"}
            return {key: corrupt_refs(item) for key, item in value.items()}
        return [corrupt_refs(item) for item in value] if isinstance(value, list) else value

    for original in fixture["cards"]:
        spec = json.loads(json.dumps(original).replace("evidence-a", ids["evidence-a"]).replace("evidence-b", ids["evidence-b"]))
        validated = present.args_schema.model_validate(spec)
        assert validated.model_dump() == spec and type(validated.metadata) is dict
        for metadata in ({**spec["metadata"], "synthetic_extra": "not permitted"}, corrupt_refs(spec["metadata"])):
            with pytest.raises(ValidationError):
                present.args_schema.model_validate({**spec, "metadata": metadata})
        assert present.invoke(spec)["status"] == "presented"
        assert events[-1]["payload"]["card"]["metadata"] == spec["metadata"]
    assert len(events) == 7 and all(event["kind"] == "card" for event in events)


def test_native_canvas_schema_errors_are_safe_presentation_warnings(capsys):
    from ccie_sidecar.agents.deepagents_tools import create_canvas_tools
    events = []
    canvas = CanvasContext(REQUEST, events.append, ("private-marker",))
    evidence_id = canvas.capture({"helper": "inventory"}, {"health": "degraded"}, call_id="synthetic-call")
    ref = {"evidence_id": evidence_id, "path": "/health"}
    present = create_canvas_tools(canvas)[1]
    spec = {"type": "text", "title": "private-title", "source_refs": [ref], "metadata": {"body": ref}}
    bad_specs = [
        {**spec, "source_refs": [{**ref, "private-key-marker": "private-marker"}]},
        {**spec, "type": "table", "metadata": {"columns": [{"key": "private-column-marker", "label": "Health"}], "rows": [{"cells": {"private-column-marker": {"private-key-marker": "private-marker"}}}]}},
        {**spec, "type": "key_value", "metadata": {"fields": [{"label": "Health", "ref": {"private-key-marker": "private-marker"}}]}},
        {**spec, "metadata": {"body": "private-marker"}},
    ]
    for index, bad in enumerate(bad_specs):
        response = present.invoke({"type": "tool_call", "name": "canvas_present", "id": f"synthetic-{index}", "args": bad})
        assert response.status == "error"
        warning = json.loads(response.content)
        assert warning["kind"] == "warning"
        assert all(text in warning["limitation"] for text in ("exactly evidence_id and path", "declared metadata shape", "native canvas_sources", "never repeat source"))
        assert events[-1]["kind"] == "warning" and events[-1]["payload"]["limitation"] == warning["limitation"]
        assert all(private not in response.content for private in ("private-marker", "private-title", "private-key-marker", "private-column-marker", evidence_id, "/health"))
    assert len(events) == len(bad_specs) and not any(event["kind"] == "card" for event in events)
    assert present.invoke(spec)["status"] == "presented"
    captured = capsys.readouterr()
    assert captured.out == "" and captured.err == ""
    assert all(private not in json.dumps(events) for private in ("private-marker", "private-key-marker", "private-column-marker"))


def test_native_canvas_table_cells_model_schema_requires_exact_evidence_refs():
    from ccie_sidecar.agents.deepagents_tools import create_canvas_tools
    present = create_canvas_tools(CanvasContext(REQUEST, lambda event: None, ()))[1]
    schema = present.tool_call_schema.model_json_schema()

    def resolve(node):
        while "$ref" in node:
            pointer = node["$ref"]
            assert pointer.startswith("#/")
            node = schema
            for key in pointer[2:].split("/"):
                node = node[key.replace("~1", "/").replace("~0", "~")]
        return node

    metadata = resolve(schema["properties"]["metadata"])
    candidates = [resolve(item) for item in metadata.get("anyOf", metadata.get("oneOf", [metadata]))]
    table = next((item for item in candidates if set(item.get("required", [])) == {"columns", "rows"}), None)
    assert table is not None, {"missing_table_cell_reference_contract": metadata}
    row = resolve(resolve(table["properties"]["rows"])["items"])
    cells = resolve(row["properties"]["cells"])
    assert isinstance(cells.get("additionalProperties"), dict), cells
    ref_schema = resolve(cells["additionalProperties"])
    assert (set(ref_schema.get("required", [])), ref_schema.get("additionalProperties")) == ({"evidence_id", "path"}, False), ref_schema
    assert set(ref_schema["properties"]) == {"evidence_id", "path"}
    assert all(ref_schema["properties"][key]["type"] == "string" for key in ("evidence_id", "path"))


def test_native_canvas_source_ref_model_schema_requires_exact_reference_keys():
    from ccie_sidecar.agents.deepagents_tools import create_canvas_tools
    present = create_canvas_tools(CanvasContext(REQUEST, lambda event: None, ()))[1]
    schema = present.tool_call_schema.model_json_schema()
    ref_schema = schema["properties"]["source_refs"]["items"]
    if "$ref" in ref_schema:
        pointer = ref_schema["$ref"]
        assert pointer.startswith("#/")
        ref_schema = schema
        for key in pointer[2:].split("/"):
            ref_schema = ref_schema[key.replace("~1", "/").replace("~0", "~")]
    assert (set(ref_schema.get("required", [])), ref_schema.get("additionalProperties")) == ({"evidence_id", "path"}, False), ref_schema
    assert set(ref_schema["properties"]) == {"evidence_id", "path"}
    assert all(ref_schema["properties"][key]["type"] == "string" for key in ("evidence_id", "path"))


def test_native_canvas_rejects_copied_cells_and_non_card_types():
    from ccie_sidecar.agents.deepagents_tools import create_canvas_tools
    events = []
    canvas = CanvasContext(REQUEST, events.append, ())
    evidence_id = canvas.capture({"helper": "inventory"}, {"health": "degraded", "bad_identifiers": [None, False, {"untrusted-value-name": "not an identifier"}, []]}, call_id="actual-source")
    ref = {"evidence_id": evidence_id, "path": "/health"}
    _, present = create_canvas_tools(canvas)
    spec = {"type": "text", "title": "Health", "source_refs": [ref], "metadata": {"body": ref}}
    for metadata in ({"body": "invented"}, {"body": ref, "onClick": "arbitrary()"}):
        result = json.loads(present.invoke({**spec, "metadata": metadata}))
        assert result["kind"] == "warning"
    assert json.loads(present.invoke({**spec, "type": "html"}))["kind"] == "warning"
    column_error = present.invoke({**spec, "type": "table", "metadata": {
        "columns": [{"key": "untrusted-column-name", "label": "Health"}],
        "rows": [{"cells": {}}],
    }})
    assert column_error["limitation"] == "invalid card metadata for table: expected exactly the declared table column keys"
    assert "untrusted-column-name" not in column_error["limitation"]
    for field in ("device", "interface"):
        for index in range(4):
            finding = {"device": ref, "interface": ref, "symptom": "Health degraded", "severity": "warning", "cause_assessment": "undetermined", "supporting_refs": [ref], "contradictory_refs": [], "unknowns": [], "remediation_considerations": []}
            finding[field] = {"evidence_id": evidence_id, "path": f"/bad_identifiers/{index}"}
            scalar_error = present.invoke({**spec, "type": "findings", "metadata": {"findings": [finding]}})
            assert scalar_error["kind"] == "warning"
            assert f"findings.{field}" in scalar_error["limitation"]
            assert "inspect a narrower retained reference" in scalar_error["limitation"]
            assert "untrusted-value-name" not in scalar_error["limitation"]
    assert not any(e["kind"] == "card" for e in events)
    result = present.invoke(spec)
    assert result["status"] == "presented" and result["card_id"]
    assert events[-1]["payload"]["card"]["metadata"] == {"body": ref}
    event_count = len(events)
    canvas.finish_presentation()
    assert len(events) == event_count, "only a successfully delivered card suppresses the completion warning"


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["native", "wrong_import", "invalid_ref", "invalid_metadata", "invalid_source_shape", "invalid_cell_shape", "invalid_scalar_port", "invalid_scalar_device", "no_presentation", "unavailable", "ordinary"])
async def test_legacy_native_canvas_compatibility_curates_real_evidence_before_final(monkeypatch, mode):
    """Retain reference-tool recovery coverage; production exposes publishing instead."""
    from langchain.agents.middleware import AgentMiddleware
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import AIMessage, ToolMessage
    from langchain_core.outputs import ChatGeneration, ChatResult
    from ccie_sidecar import agent, meraki
    from ccie_sidecar.agents import architect_subagents as architect, deepagents_runtime as runtime

    from ccie_sidecar.agents import deepagents_tools
    legacy_factory = deepagents_tools.create_canvas_tools
    monkeypatch.setattr(deepagents_tools, "create_canvas_tools", lambda canvas, **kwargs: legacy_factory(canvas))
    enabled = mode != "ordinary"
    scalar_modes = {"invalid_scalar_port", "invalid_scalar_device"}
    shape_modes = {"invalid_source_shape", "invalid_cell_shape"}
    calls, events, observed_results = [], [], []
    presentation_schema = {}

    def helper(*args, **kwargs):
        calls.append((args, kwargs))
        row = {"name": "synthetic-switch", "health": "degraded", "password": "do-not-retain"}
        if mode == "invalid_scalar_port":
            row["port_identifier"] = "Gi1"
        return {"data": [row]}

    def pointer_to(value, target, path=""):
        if value == target:
            return path
        items = value.items() if isinstance(value, dict) else enumerate(value) if isinstance(value, list) else ()
        for key, item in items:
            found = pointer_to(item, target, path + "/" + str(key).replace("~", "~0").replace("/", "~1"))
            if found is not None:
                return found
        return None

    class Model(BaseChatModel):
        @property
        def _llm_type(self):
            return "synthetic-native-canvas"

        def bind_tools(self, tools, **kwargs):
            names = {tool.name for tool in tools}
            if not enabled:
                assert not ({"canvas_sources", "canvas_present"} & names)
            for tool in tools:
                if tool.name == "canvas_present":
                    presentation_schema.update(tool.tool_call_schema.model_json_schema())
            return self

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            results = [m for m in messages if isinstance(m, ToolMessage)]
            observed_results[:] = results
            executions = [m for m in results if m.name == "execute_python_code"]
            sources = [m for m in results if m.name == "canvas_sources"]
            presentations = [m for m in results if m.name == "canvas_present"]
            if not executions:
                code = "meraki_api_call('GET', '/devices')" if mode in scalar_modes | shape_modes else "print(meraki_api_call('GET', '/devices'))"
                name, args = "execute_python_code", {"code": code}
            elif mode == "wrong_import" and len(executions) == 1:
                name, args = "execute_python_code", {"code": "import canvas, json\nprint(canvas.sources())"}
            elif not enabled or mode == "no_presentation" or presentations and mode not in {"invalid_ref", "invalid_metadata", *scalar_modes, *shape_modes} or len(presentations) == 2:
                return ChatResult(generations=[ChatGeneration(message=AIMessage(content="Switch health is degraded; recommendation not executed."))])
            elif not sources:
                name, args = "canvas_sources", {}
            elif sources[-1].status == "error":
                return ChatResult(generations=[ChatGeneration(message=AIMessage(content="Switch health is degraded; recommendation not executed."))])
            elif mode in shape_modes:
                source = next(item for item in json.loads(sources[0].content) if item["origin"] == "observed")
                if len(sources) == 1:
                    name, args = "canvas_sources", {"evidence_id": source["evidence_id"], "path": ""}
                else:
                    payload = json.loads(json.loads(sources[1].content)["preview"])
                    ref = {"evidence_id": source["evidence_id"], "path": pointer_to(payload, "degraded")}
                    if presentations:
                        warning = json.loads(presentations[-1].content)
                        if not all(text in warning["limitation"] for text in ("exactly evidence_id and path", "declared metadata shape", "native canvas_sources", "never repeat source")):
                            return ChatResult(generations=[ChatGeneration(message=AIMessage(content="Presentation recovery details unavailable."))])
                        assert presentations[-1].status == "error"
                    source_ref = {**ref, "synthetic_extra": "private-marker"} if mode == "invalid_source_shape" and not presentations else ref
                    cell = {"synthetic_unknown_key": "private-marker"} if mode == "invalid_cell_shape" and not presentations else ref
                    name, args = "canvas_present", {"type": "table", "title": "Switch health", "source_refs": [source_ref], "metadata": {"columns": [{"key": "health", "label": "Observed health"}], "rows": [{"cells": {"health": cell}}]}}
            elif mode in scalar_modes:
                summary = json.loads(sources[0].content)
                source = next(item for item in summary if item["origin"] == "observed")
                evidence_id = source["evidence_id"]
                if len(sources) == 1:
                    name, args = "canvas_sources", {"evidence_id": evidence_id, "path": ""}
                else:
                    detail = json.loads(sources[1].content)
                    payload = json.loads(detail["preview"])
                    device_ref = {"evidence_id": evidence_id, "path": pointer_to(payload, "synthetic-switch")}
                    supporting_ref = {"evidence_id": evidence_id, "path": pointer_to(payload, "degraded")}
                    port_path = pointer_to(payload, "Gi1")
                    if presentations and len(sources) == 2:
                        limitation = json.loads(presentations[-1].content)["limitation"]
                        if not all(text in limitation for text in ("findings.interface", "inspect", "assessment")):
                            return ChatResult(generations=[ChatGeneration(message=AIMessage(content="Switch health is degraded; recommendation not executed."))])
                        name, args = "canvas_sources", device_ref
                    else:
                        if presentations:
                            assert json.loads(sources[-1].content)["preview"] == '"synthetic-switch"'
                        if presentations and port_path is None:
                            kind = "assessment"
                            metadata = {"narrative": "The observed switch health is degraded; the interface was not assessed.", "supporting_refs": [supporting_ref], "contradictory_refs": [], "unknowns": ["Interface not assessed; no port identifier was returned."], "remediation_considerations": ["Review the switch-wide condition before proposing changes."]}
                        else:
                            kind = "findings"
                            interface_ref = {"evidence_id": evidence_id, "path": port_path if presentations else ""}
                            metadata = {"findings": [{"device": device_ref, "interface": interface_ref, "symptom": "Observed health is degraded", "severity": "warning", "cause_assessment": "undetermined", "supporting_refs": [supporting_ref], "contradictory_refs": [], "unknowns": ["Cause not assessed."], "remediation_considerations": ["Review source evidence before changes."]}]}
                        name, args = "canvas_present", {"type": kind, "title": "Switch health", "source_refs": [device_ref, supporting_ref], "metadata": metadata}
            else:
                summary = json.loads(sources[-1].content)
                source = next(item for item in summary if item["origin"] == "observed")
                ref = {"evidence_id": source["evidence_id"], "path": "/data/0/health"}
                if mode == "invalid_ref" and not presentations:
                    ref = {"evidence_id": "foreign-run-evidence", "path": "/data/0/health"}
                field = {"label": "Health", "ref": ref}
                if mode == "invalid_metadata":
                    if not presentations:
                        field = {"label": "Health", "untrusted-field-name": ref}
                    else:
                        limitation = json.loads(presentations[-1].content)["limitation"]
                        if "declared metadata shape" not in limitation:
                            return ChatResult(generations=[ChatGeneration(message=AIMessage(content="Metadata recovery details unavailable."))])
                        def resolve(node):
                            return presentation_schema["$defs"][node["$ref"].split("/")[-1]] if "$ref" in node else node
                        variants = presentation_schema["properties"]["metadata"]["anyOf"]
                        key_value = next(resolve(item) for item in variants if "fields" in resolve(item).get("properties", {}))
                        field_schema = resolve(key_value["properties"]["fields"]["items"])
                        field = {key: field[key] for key in field_schema["required"]}
                name, args = "canvas_present", {
                    "type": "key_value", "title": "Switch health", "source_refs": [ref],
                    "metadata": {"fields": [field]},
                }
            return ChatResult(generations=[ChatGeneration(message=AIMessage(content="", tool_calls=[{
                "name": name, "args": args, "id": f"native-canvas-{len(results)}",
            }]))])

    monkeypatch.setattr(agent, "get_saved_config", lambda: {"provider": "openai", "model": "synthetic"})
    monkeypatch.setattr(runtime, "build_chat_model", lambda config: Model())
    monkeypatch.setattr(runtime, "_rubric_middleware", lambda config: AgentMiddleware())
    monkeypatch.setattr("ccie_sidecar.agents.catalog_grounding.resolve_agent_catalogs", lambda definition: [])
    monkeypatch.setattr(architect, "VENDOR_SPECS", [{"id": "meraki", "configured": lambda: True, "display": "Meraki", "when": "synthetic"}])
    monkeypatch.setattr(meraki, "install_meraki", lambda g, **kw: g.update(meraki_api_call=helper))
    if mode == "unavailable":
        monkeypatch.setattr(CanvasContext, "present", lambda self, spec: {"kind": "warning", "limitation": "Synthetic presentation unavailable"})
    outcome = await runtime.deepagents_react_code_loop(
        {"agent_id": "network-architect"}, "Investigate switch health",
        {"run_id": f"native-canvas-{mode}", **({"canvas": REQUEST} if enabled else {})}, events.append,
    )
    assert outcome["final_emitted"] is True
    assert outcome.get("error_kind") is None
    assert calls == [(("GET", "/devices"), {})], "presentation must never replay a vendor operation"
    assert events[-1]["type"] == "final"
    cards = [e for e in events if e["type"] == "canvas" and e["kind"] == "card"]
    if mode in {"native", "wrong_import", "invalid_ref", "invalid_metadata", *scalar_modes, *shape_modes}:
        assert len(cards) == 1, "a completed Canvas turn must actually deliver its curated card"
        card = cards[0]
        assert (card["workspace_id"], card["run_id"]) == (REQUEST["workspace_id"], REQUEST["run_id"])
        assert events.index(card) < len(events) - 1
        expected_kind = "table" if mode in shape_modes else "findings" if mode == "invalid_scalar_port" else "assessment" if mode == "invalid_scalar_device" else "key_value"
        assert card["payload"]["card"]["type"] == expected_kind
        assert len(card["payload"]["snapshots"]) == 1
        snapshot = card["payload"]["snapshots"][0]
        assert snapshot["origin"] == "observed"
        row = {"name": "synthetic-switch", "health": "degraded", "password": "[REDACTED]"}
        if mode == "invalid_scalar_port":
            row["port_identifier"] = "Gi1"
        assert snapshot["data"]["data"][0] == row
        if mode == "invalid_scalar_device":
            metadata = card["payload"]["card"]["metadata"]
            assert "interface was not assessed" in metadata["narrative"]
            assert metadata["unknowns"] and "interface" not in metadata
        if mode in scalar_modes:
            warnings = [e for e in events if e["type"] == "canvas" and e["kind"] == "warning"]
            assert len(warnings) == 1
            assert all(text in warnings[0]["payload"]["limitation"] for text in ("findings.interface", "inspect", "assessment"))
        if mode in shape_modes:
            cell = card["payload"]["card"]["metadata"]["rows"][0]["cells"]["health"]
            value = snapshot["data"]
            for segment in cell["path"].split("/")[1:]:
                value = value[int(segment)] if isinstance(value, list) else value[segment.replace("~1", "/").replace("~0", "~")]
            assert cell["evidence_id"] == snapshot["evidence_id"] and value == "degraded"
            warnings = [e for e in events if e["type"] == "canvas" and e["kind"] == "warning"]
            assert len(warnings) == 1
            assert "exactly evidence_id and path" in warnings[0]["payload"]["limitation"]
            assert "private-marker" not in json.dumps(warnings)
            rejected = [m for m in observed_results if m.name == "canvas_present" and m.status == "error"]
            assert len(rejected) == 1
            assert "private-marker" not in rejected[0].content
            assert "synthetic_extra" not in rejected[0].content
            assert "synthetic_unknown_key" not in rejected[0].content
        assert "do-not-retain" not in json.dumps(card)
        assert "presentation unavailable" not in events[-1]["response"].lower()
    elif enabled:
        assert cards == []
        assert any(e["type"] == "canvas" and e["kind"] == "warning" and "no validated cards" in e["payload"]["limitation"] for e in events)
        assert events[-1]["response"] == "Switch health is degraded; recommendation not executed."
    else:
        assert not any(e["type"] == "canvas" for e in events)
        assert "Canvas presentation unavailable" not in events[-1]["response"]
    if mode == "wrong_import":
        assert any("ModuleNotFoundError" in m.content for m in observed_results if m.name == "execute_python_code")
    if mode in {"invalid_ref", "invalid_metadata"}:
        rejected = [e for e in events if e["type"] == "canvas" and e["kind"] == "warning"]
        assert len(rejected) == 1
        limitation = rejected[0]["payload"]["limitation"]
        if mode == "invalid_ref":
            assert "missing, foreign or incomplete evidence" in limitation
        else:
            assert "declared metadata shape" in limitation
            assert "untrusted-field-name" not in limitation


@pytest.mark.asyncio
async def test_legacy_native_inspection_discovers_card_refs_without_stdout(monkeypatch):
    """Explicit reference-factory compatibility, not production tool exposure."""
    from langchain.agents.middleware import AgentMiddleware
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import AIMessage, ToolMessage
    from langchain_core.outputs import ChatGeneration, ChatResult
    from ccie_sidecar import agent, meraki
    from ccie_sidecar.agents import architect_subagents as architect, deepagents_runtime as runtime
    from ccie_sidecar.agents import deepagents_tools
    legacy_factory = deepagents_tools.create_canvas_tools
    monkeypatch.setattr(deepagents_tools, "create_canvas_tools", lambda canvas, **kwargs: legacy_factory(canvas))
    calls, events = [], []
    payloads = {
        "/inventory": {"devices": [{"name": "synthetic-switch", "state": "online"}]},
        "/link-health": {"metrics": {"link/state~now": "degraded", "password": "never-expose"}},
    }

    def helper(method, path):
        calls.append((method, path))
        return payloads[path]

    def find_degraded(value, path=""):
        if value == "degraded":
            return path
        items = value.items() if isinstance(value, dict) else enumerate(value) if isinstance(value, list) else ()
        for key, item in items:
            pointer = path + "/" + str(key).replace("~", "~0").replace("/", "~1")
            found = find_degraded(item, pointer)
            if found is not None:
                return found
        return None

    class Model(BaseChatModel):
        @property
        def _llm_type(self):
            return "synthetic-inspection-canvas"

        def bind_tools(self, tools, **kwargs):
            return self

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            results = [m for m in messages if isinstance(m, ToolMessage)]
            inspections = [m for m in results if m.name == "canvas_sources"]
            if not results:
                name, args = "execute_python_code", {"code": "meraki_api_call('GET', '/inventory')\nmeraki_api_call('GET', '/link-health')"}
            elif not inspections:
                assert next(m for m in results if m.name == "execute_python_code").content == "(no output)"
                name, args = "canvas_sources", {}
            elif len(inspections) <= 2:
                summaries = json.loads(inspections[0].content)
                observed = [s for s in summaries if s["origin"] == "observed"]
                assert len(observed) == 2 and len({s["source"]["helper"] for s in observed}) == 1
                name, args = "canvas_sources", {"evidence_id": observed[len(inspections) - 1]["evidence_id"], "path": ""}
            elif not any(m.name == "canvas_present" for m in results):
                for inspection in inspections[1:]:
                    detail = json.loads(inspection.content)
                    if not isinstance(detail, dict) or "preview" not in detail:
                        continue
                    path = find_degraded(json.loads(detail["preview"]))
                    if path is not None:
                        ref = {**detail["ref"], "path": path}
                        name, args = "canvas_present", {"type": "key_value", "title": "Degraded link", "source_refs": [ref], "metadata": {"fields": [{"label": "State", "ref": ref}]}}
                        break
                else:
                    return ChatResult(generations=[ChatGeneration(message=AIMessage(content="No inspectable presentation evidence."))])
            else:
                return ChatResult(generations=[ChatGeneration(message=AIMessage(content="Link state is degraded."))])
            return ChatResult(generations=[ChatGeneration(message=AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": f"inspection-{len(results)}"}]))])

    monkeypatch.setattr(agent, "get_saved_config", lambda: {"provider": "openai", "model": "synthetic"})
    monkeypatch.setattr(runtime, "build_chat_model", lambda config: Model())
    monkeypatch.setattr(runtime, "_rubric_middleware", lambda config: AgentMiddleware())
    monkeypatch.setattr("ccie_sidecar.agents.catalog_grounding.resolve_agent_catalogs", lambda definition: [])
    monkeypatch.setattr(architect, "VENDOR_SPECS", [{"id": "meraki", "configured": lambda: True, "display": "Meraki", "when": "synthetic"}])
    monkeypatch.setattr(meraki, "install_meraki", lambda g, **kw: g.update(meraki_api_call=helper))
    outcome = await runtime.deepagents_react_code_loop(
        {"agent_id": "network-architect"}, "Show the degraded link state", {"run_id": "inspection-turn", "canvas": REQUEST}, events.append,
    )
    assert outcome["final_emitted"] is True
    cards = [e for e in events if e["type"] == "canvas" and e["kind"] == "card"]
    assert len(cards) == 1, "same-helper captures need model-visible inspection, not guessed evidence paths"
    snapshot = cards[0]["payload"]["snapshots"][0]
    ref = cards[0]["payload"]["card"]["metadata"]["fields"][0]["ref"]
    assert snapshot["data"] == {"metrics": {"link/state~now": "degraded", "password": "[REDACTED]"}}
    assert ref == {"evidence_id": snapshot["evidence_id"], "path": "/metrics/link~1state~0now"}
    assert calls == [("GET", "/inventory"), ("GET", "/link-health")]
    assert events[-1] == {"type": "final", "response": "Link state is degraded."}
    assert "never-expose" not in json.dumps(events)


def test_native_canvas_inspection_is_bounded_read_only_and_pointer_validated():
    from ccie_sidecar.agents.deepagents_tools import create_canvas_tools
    from ccie_sidecar.agents.tool_output import DEFAULT_MAX_RETURN_CHARS
    canvas = CanvasContext(REQUEST, lambda event: None, ("synthetic-private-value",))
    evidence_id = canvas.capture({"helper": "inventory"}, {
        "huge": "\\\"☃" * 100_000, "a/b~c": {"value": 0, "password": "hidden", "error": "synthetic-private-value"},
    }, call_id="actual-source")
    sources, _ = create_canvas_tools(canvas)
    before = canvas.snapshots
    preview = sources.invoke({"evidence_id": evidence_id, "path": ""})
    assert isinstance(preview, dict) and preview["truncated"] is True
    assert preview["type"] == "dict"
    assert len(json.dumps(preview).encode("utf-8")) <= DEFAULT_MAX_RETURN_CHARS
    detail = sources.invoke({"evidence_id": evidence_id, "path": "/a~1b~0c"})
    assert detail["truncated"] is False
    assert json.loads(detail["preview"]) == {"value": 0, "password": "[REDACTED]", "error": "[REDACTED]"}
    detail["ref"]["path"] = "/invented"
    assert canvas.snapshots == before
    for identity, path in (("foreign-evidence", ""), (evidence_id, "/missing"), (evidence_id, "/__proto__"), (evidence_id, "/a~2b")):
        failure = sources.invoke({"evidence_id": identity, "path": path})
        assert failure["kind"] == "warning"
        assert "preview" not in failure
    zero = sources.invoke({"evidence_id": evidence_id, "path": "/a~1b~0c/value"})
    assert zero["preview"] == "0" and zero["truncated"] is False


def test_interleaved_factories_remain_owned_by_original_workspace(monkeypatch):
    from ccie_sidecar import meraki
    from ccie_sidecar.agents.deepagents_tools import create_execute_python_code_tool
    monkeypatch.setattr(meraki, "install_meraki", lambda g, **kw: g.update(meraki_api_call=lambda *a: {"data": [{"name": "switch-1"}]}))
    a_events, b_events = [], []
    a = CanvasContext(REQUEST, a_events.append, ())
    b = CanvasContext({"workspace_id": "different-workspace", "run_id": "different-run"}, b_events.append, ())
    a_tool = create_execute_python_code_tool("meraki", {}, a_events.append, canvas=a)
    b_tool = create_execute_python_code_tool("meraki", {}, b_events.append, canvas=b)
    for tool in (a_tool, b_tool, a_tool, b_tool):
        assert tool.invoke({"code": (
            "meraki_api_call('GET','/devices')\n"
            "source = next(s for s in canvas.sources() if s['origin']=='observed')\n"
            "ref = {'evidence_id':source['evidence_id'],'path':'/data/0/name'}\n"
            "canvas.present({'type':'text','title':'Owned','source_refs':[ref],'metadata':{'body':ref}})"
        )}) == "(no output)"
    assert {e["workspace_id"] for e in a_events} == {REQUEST["workspace_id"]}
    assert {e["workspace_id"] for e in b_events} == {"different-workspace"}
    assert set(a.snapshots).isdisjoint(b.snapshots)
