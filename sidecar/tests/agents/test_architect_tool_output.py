"""Network Architect must use the same bounded output seam as specialists."""
from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from ccie_sidecar.agents.tool_output import DEFAULT_MAX_RETURN_CHARS


def test_architect_direct_wrapper_uses_shared_tool_output_policy(monkeypatch):
    from ccie_sidecar.agents import architect_subagents as architect
    from ccie_sidecar.agents import code_exec

    sandbox: dict = {}
    sentinel = "ARCHITECT-WRAPPER-SENTINEL"
    raw = ("architect-head\n" * 8_000) + sentinel + ("\narchitect-tail" * 8_000)

    # An empty vendor catalog keeps this test focused on the duplicated direct
    # wrapper instead of loading any configured integrations or credentials.
    monkeypatch.setattr(architect, "VENDOR_SPECS", [])
    monkeypatch.setattr(
        code_exec,
        "_build_sandbox_globals",
        lambda *args, **kwargs: sandbox,
    )
    monkeypatch.setattr(code_exec, "_build_env_overrides", lambda secrets: {})
    monkeypatch.setattr(
        code_exec,
        "_execute_code_with_timeout",
        lambda **kwargs: {"success": True, "output": raw, "error": ""},
    )

    tool, configured = architect.build_architect_direct_tool()
    rendered = tool.invoke({"code": "print('ignored by mock')"})

    assert configured == []
    assert len(rendered) <= DEFAULT_MAX_RETURN_CHARS
    assert sentinel in sandbox["tool_output"].grep(sentinel)
    assert "built-in read_file" in tool.description
    assert "/large_tool_results/" not in rendered


def test_architect_direct_wrapper_serializes_concurrent_calls(monkeypatch):
    from ccie_sidecar.agents import architect_subagents as architect
    from ccie_sidecar.agents import code_exec

    sandbox: dict = {}

    class Probe:
        def __init__(self):
            self.lock = threading.Lock()
            self.active = 0
            self.max_active = 0

        def enter(self):
            with self.lock:
                self.active += 1
                self.max_active = max(self.max_active, self.active)

        def exit(self):
            with self.lock:
                self.active -= 1

    probe = Probe()
    sandbox.update({"probe": probe, "time": time, "json": json})

    monkeypatch.setattr(architect, "VENDOR_SPECS", [])
    monkeypatch.setattr(
        code_exec,
        "_build_sandbox_globals",
        lambda *args, **kwargs: sandbox,
    )
    monkeypatch.setattr(code_exec, "_build_env_overrides", lambda secrets: {})
    tool, _ = architect.build_architect_direct_tool()
    start = threading.Barrier(3)

    def invoke(call):
        start.wait(timeout=5)
        code = (
            "probe.enter()\n"
            "try:\n"
            f"    current_call = {call!r}\n"
            "    time.sleep(0.04)\n"
            "    print(json.dumps({'call': current_call}))\n"
            "finally:\n"
            "    probe.exit()\n"
        )
        return tool.invoke({"code": code})

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(invoke, "architect-a")
        second = pool.submit(invoke, "architect-b")
        start.wait(timeout=5)
        first_result = first.result(timeout=5)
        second_result = second.result(timeout=5)

    assert json.loads(first_result) == {"call": "architect-a"}
    assert json.loads(second_result) == {"call": "architect-b"}
    assert probe.max_active == 1
    assert sandbox["tool_output"].json() in (
        {"call": "architect-a"},
        {"call": "architect-b"},
    )


@pytest.mark.asyncio
async def test_general_research_runtime_ignores_unused_missing_meraki_envelope(monkeypatch, tmp_path, request):
    import os
    import socket
    import sqlite3
    import sys

    # Isolate the native process environment before importing any runtime code.
    for key in list(os.environ):
        monkeypatch.delenv(key)
    for key in ("HOME", "USERPROFILE", "APPDATA"):
        monkeypatch.setenv(key, str(tmp_path))
    for key in ("CCIE_CONTEXT_GRAPH", "CCIE_AGENT_LESSONS"):
        monkeypatch.setenv(key, "0")

    missing = object()
    helpers = (
        "drawio", "proxmox", "blender", "nmap", "uml", "markmap", "wikipedia", "rfc",
        "devnet_api", "fwrule_helper", "zabbix_api", "sketchfab_api",
    )
    previous_helpers = {name: sys.modules.get(name, missing) for name in helpers}

    def restore_helpers():
        for name, previous in previous_helpers.items():
            if previous is missing:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous

    request.addfinalizer(restore_helpers)
    accesses = []

    def forbidden(*args, **kwargs):
        accesses.append("network access")
        raise AssertionError("Synthetic research must not open a connection")

    def absent_database(path, *args, **kwargs):
        from pathlib import Path
        if not Path(path).is_relative_to(tmp_path):
            accesses.append("non-synthetic database access")
            raise AssertionError("Research must not read an operator database")
        # Some optional readers try opening absent config DBs; never actually open one.
        raise sqlite3.OperationalError("Synthetic config database is absent")

    monkeypatch.setattr(sqlite3, "connect", absent_database)
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)

    import requests
    monkeypatch.setattr(requests.Session, "request", forbidden)
    from langchain_core.language_models.fake_chat_models import FakeListChatModel
    from ccie_sidecar import agent
    from ccie_sidecar.agents import deepagents_runtime as runtime
    from ccie_sidecar.agents import deepagents_stream

    monkeypatch.setattr(agent, "get_saved_config", lambda: {"provider": "openai", "model": "synthetic"})
    monkeypatch.setattr(runtime, "build_chat_model", lambda config: FakeListChatModel(responses=["unused"]))
    # Keep the real graph constructor and bootstrap; capture its tool arguments.
    real_factory = runtime.create_deep_agent
    graph_args = {}

    def capture_factory(**kwargs):
        graph_args.update(kwargs)
        return real_factory(**kwargs)

    monkeypatch.setattr(runtime, "create_deep_agent", capture_factory)

    async def synthetic_stream(graph, input_data, config, on_event, **kwargs):
        assert "Minecraft" in input_data["messages"][-1].content
        assert hasattr(graph, "astream")
        execute = next(tool for tool in graph_args["tools"] if tool.name == "execute_python_code")
        index = execute._ccie_catalog_index
        assert index is None or "meraki" not in index.catalog_ids
        assert not any(sub["name"] == "meraki-specialist" for sub in graph_args["subagents"])
        result = execute.invoke({"code": "print('Minecraft: compare building and survival mechanics')"})
        on_event({"type": "final", "response": result})
        return {"interrupted": False, "final_emitted": True, "steps": 1}

    monkeypatch.setattr(deepagents_stream, "run_and_stream", synthetic_stream)
    events = []
    agent_def = {
        "agent_id": "network-architect",  # Kanban General's production mapping.
        "system_prompt": "Research the user's game question.",
        "attached_tools": [{
            "id": "meraki", "vault_entry": "meraki_api_key", "vault_secrets": None,
            "catalog": [{
                "name": "meraki_api_call", "method": "GET", "path": "/organizations",
                "kanbanOwner": {"agentId": "meraki", "vaultEntry": "meraki_api_key"},
            }],
        }],
    }
    from ccie_sidecar.agents.catalog_grounding import resolve_agent_catalogs
    assert [catalog["id"] for catalog in resolve_agent_catalogs(agent_def)] == ["meraki"]
    outcome = await runtime.deepagents_react_code_loop(
        agent_def=agent_def,
        user_msg="Research a Minecraft game", ctx={"history": []}, on_event=events.append,
    )
    assert outcome["final_emitted"] is True
    assert outcome.get("error_kind") is None
    assert any(event["type"] == "final" and "Minecraft" in event["response"] for event in events)
    assert not any(event["type"] == "error" for event in events)
    assert accesses == []
