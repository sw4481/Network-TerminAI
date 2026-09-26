import json
import threading

import pytest

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


def test_diagnostics_fail_before_visible_investigation_plan():
    client = TerminalGatewayClient(context(), lambda _event: None, transport=lambda *_: {})
    with pytest.raises(ValueError, match="investigation plan"):
        client.run_diagnostic("step-1", "show aaa servers", "Inspect AAA state")


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
