import asyncio
import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from langchain_core.messages import AIMessage
from langchain_core.tools import ToolException
from langgraph.graph import START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode

from ccie_sidecar.agents.terminal_agent_tools import (
    TerminalGatewayClient,
    build_terminal_tools,
    terminal_routing_contract,
)


def context():
    return {
        "base_url": "http://127.0.0.1:43123/v1",
        "capability": "opaque-secret-capability",
        "lease_id": "lease-public-1",
        "agent_id": "network-architect",
        "turn_id": "turn-1",
        "target": {
            "backendPtyId": "pty-1",
            "displayName": "Access switch",
            "vendor": "cisco",
            "platform": "iosxe",
        },
    }


def tool_executor(emit, transport):
    graph = StateGraph(MessagesState)
    graph.add_node("tools", ToolNode(build_terminal_tools(context(), emit, transport=transport)))
    graph.add_edge(START, "tools")
    return graph.compile()


def observe_diagnostic_entries(monkeypatch, plan_entered, expected):
    entered = threading.Event()
    entry_lock = threading.Lock()
    count = 0
    original = TerminalGatewayClient.run_diagnostic

    def observed(self, *args, **kwargs):
        nonlocal count
        assert plan_entered.wait(5)
        with entry_lock:
            count += 1
            if count == expected:
                entered.set()
        return original(self, *args, **kwargs)

    monkeypatch.setattr(TerminalGatewayClient, "run_diagnostic", observed)
    return entered


def test_diagnostics_fail_before_visible_investigation_plan():
    client = TerminalGatewayClient(context(), lambda _event: None, transport=lambda *_: {})
    with pytest.raises(ToolException, match="investigation plan"):
        client.run_diagnostic("step-1", "show aaa servers", "Inspect AAA state")


def test_tool_node_queues_parallel_diagnostics_until_gateway_plan_is_visible(monkeypatch):
    plan_entered = threading.Event()
    release_plan = threading.Event()
    all_diagnostics_entered = observe_diagnostic_entries(monkeypatch, plan_entered, 3)
    calls = []
    events = []

    def transport(path, payload):
        calls.append(path)
        if path == "/plan/begin":
            plan_entered.set()
            assert release_plan.wait(10)
        if path == "/diagnostic":
            return {"command": payload["command"], "output": "complete", "timed_out": False}
        return {"ok": True}

    node = tool_executor(events.append, transport)
    turn = {"messages": [AIMessage(content="", tool_calls=[{
        "name": "terminal_begin_investigation",
        "args": {"objective": "Inspect AAA", "hypotheses": [], "steps": ["Inspect"],
                 "success_criteria": ["Find cause"]},
        "id": "plan-1",
    }, *[{
        "name": "terminal_run_diagnostic",
        "args": {"plan_step_id": "step-1", "command": f"show aaa status {index}",
                 "purpose": "Inspect AAA state"},
        "id": f"diagnostic-{index}",
    } for index in range(3)]])]}

    with ThreadPoolExecutor(max_workers=1) as pool:
        turn_future = pool.submit(asyncio.run, node.ainvoke(turn))
        try:
            assert plan_entered.wait(5)
            assert all_diagnostics_entered.wait(5)
            assert calls == ["/plan/begin"]
            assert events == []
        finally:
            release_plan.set()
        results = turn_future.result(timeout=10)["messages"][1:]

    assert len(results) == 4
    assert [result.tool_call_id for result in results] == [
        "plan-1", "diagnostic-0", "diagnostic-1", "diagnostic-2",
    ]
    assert all(result.status == "success" for result in results)
    assert all("complete" in result.content for result in results[1:])
    assert calls == ["/plan/begin", "/diagnostic", "/diagnostic", "/diagnostic"]
    assert [event["type"] for event in events] == [
        "terminal_investigation_plan",
        "terminal_command_start", "terminal_command_result",
        "terminal_command_start", "terminal_command_result",
        "terminal_command_start", "terminal_command_result",
    ]


def test_tool_node_reports_early_diagnostic_error_then_allows_retry_after_plan():
    calls = []
    events = []

    def transport(path, payload):
        calls.append(path)
        return {"output": "ready", "timed_out": False} if path == "/diagnostic" else {"ok": True}

    node = tool_executor(events.append, transport)
    diagnostic = {"messages": [AIMessage(content="", tool_calls=[{
        "name": "terminal_run_diagnostic",
        "args": {"plan_step_id": "step-1", "command": "show aaa servers",
                 "purpose": "Inspect AAA state"},
        "id": "diagnostic-early",
    }])]}
    early = asyncio.run(node.ainvoke(diagnostic))["messages"][-1]
    assert early.status == "error"
    assert early.tool_call_id == "diagnostic-early"
    assert "investigation plan first" in early.content
    assert calls == []
    assert events == []

    plan = {"messages": [AIMessage(content="", tool_calls=[{
        "name": "terminal_begin_investigation",
        "args": {"objective": "Inspect AAA", "hypotheses": [], "steps": ["Inspect"],
                 "success_criteria": ["Find cause"]},
        "id": "plan-retry",
    }])]}
    assert node.invoke(plan)["messages"][-1].status == "success"
    retry = asyncio.run(node.ainvoke(diagnostic))["messages"][-1]
    assert retry.status == "success"
    assert "ready" in retry.content
    assert calls == ["/plan/begin", "/diagnostic"]
    assert [event["type"] for event in events] == [
        "terminal_investigation_plan", "terminal_command_start", "terminal_command_result",
    ]


def test_failed_gateway_plan_never_unblocks_diagnostics_or_emits_a_plan(monkeypatch):
    plan_entered = threading.Event()
    release_plan = threading.Event()
    diagnostic_entered = observe_diagnostic_entries(monkeypatch, plan_entered, 1)
    calls = []
    events = []

    def transport(path, _payload):
        calls.append(path)
        if path == "/plan/begin":
            plan_entered.set()
            assert release_plan.wait(10)
            raise ValueError("terminal gateway rejected plan")
        pytest.fail(f"unexpected gateway request: {path}")

    node = tool_executor(events.append, transport)
    plan = {"messages": [AIMessage(content="", tool_calls=[{
        "name": "terminal_begin_investigation",
        "args": {"objective": "Inspect AAA", "hypotheses": [], "steps": ["Inspect"],
                 "success_criteria": ["Find cause"]},
        "id": "plan-failed",
    }])]}
    diagnostic = {"messages": [AIMessage(content="", tool_calls=[{
        "name": "terminal_run_diagnostic",
        "args": {"plan_step_id": "step-1", "command": "show aaa servers",
                 "purpose": "Inspect AAA state"},
        "id": "diagnostic-after-failed-plan",
    }])]}

    with ThreadPoolExecutor(max_workers=2) as pool:
        plan_future = pool.submit(asyncio.run, node.ainvoke(plan))
        try:
            assert plan_entered.wait(5)
            diagnostic_future = pool.submit(asyncio.run, node.ainvoke(diagnostic))
            assert diagnostic_entered.wait(5)
            assert calls == ["/plan/begin"]
            assert events == []
        finally:
            release_plan.set()
        with pytest.raises(ValueError, match="terminal gateway rejected plan"):
            plan_future.result(timeout=10)
        rejected = diagnostic_future.result(timeout=10)["messages"][-1]

    assert rejected.status == "error"
    assert "investigation plan first" in rejected.content
    assert calls == ["/plan/begin"]
    assert events == []


def test_tool_node_still_propagates_unrelated_gateway_errors():
    def transport(path, _payload):
        if path == "/diagnostic":
            raise ValueError("terminal gateway unavailable")
        return {"ok": True}

    node = tool_executor(lambda _event: None, transport)
    assert node.invoke({"messages": [AIMessage(content="", tool_calls=[{
        "name": "terminal_begin_investigation",
        "args": {"objective": "Inspect AAA", "hypotheses": [], "steps": ["Inspect"],
                 "success_criteria": ["Find cause"]},
        "id": "plan-ok",
    }])]} )["messages"][-1].status == "success"
    with pytest.raises(ValueError, match="terminal gateway unavailable"):
        node.invoke({"messages": [AIMessage(content="", tool_calls=[{
            "name": "terminal_run_diagnostic",
            "args": {"plan_step_id": "step-1", "command": "show aaa servers",
                     "purpose": "Inspect AAA state"},
            "id": "diagnostic-gateway-failed",
        }])]})


def test_plan_and_many_distinct_diagnostics_emit_structured_events():
    calls = []
    events = []

    def transport(path, payload):
        calls.append((path, payload))
        if path == "/diagnostic":
            return {"command": payload["command"], "output": "ISE-1 UP", "timed_out": False}
        return {"ok": True}

    client = TerminalGatewayClient(context(), events.append, transport=transport)
    client.begin_investigation(
        "Find why RADIUS is down",
        ["reachability", "AAA configuration"],
        ["Inspect state"],
        ["Tie the conclusion to command evidence"],
    )
    for index in range(26):
        result = client.run_diagnostic(
            "step-1",
            f"show radius statistics | include probe-{index}",
            "Collect distinct evidence",
        )
        assert "ISE-1 UP" in result

    assert calls[0][0] == "/plan/begin"
    assert sum(path == "/diagnostic" for path, _ in calls) == 26
    assert events[0]["type"] == "terminal_investigation_plan"
    assert sum(event["type"] == "terminal_command_start" for event in events) == 26
    assert sum(event["type"] == "terminal_command_result" for event in events) == 26


def test_parallel_tool_calls_are_serialized_for_the_single_attached_pty():
    first_entered = threading.Event()
    release_first = threading.Event()
    second_entered = threading.Event()
    active = 0
    max_active = 0
    active_lock = threading.Lock()
    events = []

    def transport(path, payload):
        nonlocal active, max_active
        if path != "/diagnostic":
            return {"ok": True}
        with active_lock:
            active += 1
            max_active = max(max_active, active)
        try:
            if payload["command"] == "show radius server":
                first_entered.set()
                assert release_first.wait(2)
            else:
                second_entered.set()
            return {
                "command": payload["command"],
                "output": "complete",
                "timed_out": False,
            }
        finally:
            with active_lock:
                active -= 1

    client = TerminalGatewayClient(context(), events.append, transport=transport)
    client.begin_investigation("Diagnose RADIUS", [], ["Inspect state"], ["Find cause"])
    first = threading.Thread(
        target=client.run_diagnostic,
        args=("step-1", "show radius server", "Inspect server state"),
    )
    second = threading.Thread(
        target=client.run_diagnostic,
        args=("step-2", "show running-config | section radius", "Inspect config"),
    )

    first.start()
    assert first_entered.wait(1)
    second.start()
    second_was_blocked = not second_entered.wait(0.15)
    release_first.set()
    first.join(2)
    second.join(2)

    assert second_was_blocked
    assert not first.is_alive()
    assert not second.is_alive()
    assert second_entered.is_set()
    assert max_active == 1
    assert [event["type"] for event in events[1:]] == [
        "terminal_command_start",
        "terminal_command_result",
        "terminal_command_start",
        "terminal_command_result",
    ]


def test_device_cli_rejection_is_returned_as_evidence_and_allows_a_retry():
    events = []
    diagnostic_calls = 0

    def transport(path, payload):
        nonlocal diagnostic_calls
        if path != "/diagnostic":
            return {"ok": True}
        diagnostic_calls += 1
        if diagnostic_calls == 1:
            raise ValueError(
                "terminal command was rejected by the device: "
                "show a access-session interface gi1/0/2 detail\r\n"
                "% Invalid input detected at '^' marker.\r\nAccess-1#"
            )
        return {
            "command": payload["command"],
            "output": "Authorized sessions: 1",
            "timed_out": False,
        }

    client = TerminalGatewayClient(context(), events.append, transport=transport)
    client.begin_investigation("Inspect access session", [], ["Inspect port"], ["Find cause"])

    rejected = json.loads(client.run_diagnostic(
        "step-1",
        "show a access-session interface gi1/0/2 detail",
        "Inspect the access session",
    ))
    corrected = json.loads(client.run_diagnostic(
        "step-1",
        "show access-session interface gi1/0/2 details",
        "Retry with valid IOS XE syntax",
    ))

    assert rejected["device_error"] is True
    assert "% Invalid input detected" in rejected["output"]
    assert corrected["output"] == "Authorized sessions: 1"
    assert diagnostic_calls == 2
    assert [event["success"] for event in events if event["type"] == "terminal_command_result"] == [
        False,
        True,
    ]


def test_terminal_tools_are_exactly_scoped_and_fix_is_always_interruptible():
    tools = build_terminal_tools(context(), lambda _event: None, transport=lambda *_: {})
    assert [tool.name for tool in tools] == [
        "terminal_read_context",
        "terminal_begin_investigation",
        "terminal_update_investigation",
        "terminal_run_diagnostic",
        "terminal_apply_fix",
    ]
    apply_tool = next(tool for tool in tools if tool.name == "terminal_apply_fix")
    assert apply_tool.metadata["blast_radius"] == "destructive"


def test_attached_terminal_overrides_radius_keyword_routing_only_for_this_turn():
    attached = terminal_routing_contract("why is radius down on this switch?", context())
    assert "attached terminal" in attached.lower()
    assert "ISE API" in attached
    assert "do not" in attached.lower()
    assert terminal_routing_contract("why is radius down?", None) == ""


def test_tool_results_are_json_and_never_include_the_capability():
    client = TerminalGatewayClient(
        context(),
        lambda _event: None,
        transport=lambda path, _payload: {"target": "switch", "output": "ok", "path": path},
    )
    value = json.loads(client.read_context())
    assert value["output"] == "ok"
    assert "opaque-secret-capability" not in json.dumps(value)


def test_runtime_exposes_terminal_tools_only_to_attached_network_architect():
    from ccie_sidecar.agents.deepagents_runtime import _terminal_tools_for_turn

    tools, prompt = _terminal_tools_for_turn("ise", {"terminal_context": context()}, lambda _: None)
    assert tools == []
    assert prompt == ""

    tools, prompt = _terminal_tools_for_turn(
        "network-architect", {"terminal_context": context()}, lambda _: None
    )
    assert [tool.name for tool in tools][-1] == "terminal_apply_fix"
    assert "attached terminal" in prompt.lower()

    tools, prompt = _terminal_tools_for_turn("network-architect", {}, lambda _: None)
    assert tools == []
    assert prompt == ""
