"""Tests for the IaC interrupt -> approval-request -> store flow (Phase 2, T7).

When an interrupt_on graph pauses on iac_apply, run_and_stream must emit an
iac_approval_request event (with blast-radius classification) and store the
graph so agent.react_resume can continue it.
"""
from __future__ import annotations

from ccie_sidecar.agents.deepagents_stream import (
    _extract_action_requests,
    _handle_interrupt,
)
from ccie_sidecar.agents.deepagents_state import (
    has_interrupted_graph,
    clear_interrupted_graph,
)


class _FakeInterrupt:
    def __init__(self, value):
        self.value = value


def _iac_payload(working_dir="/infra/dev", command="terraform apply"):
    return (
        _FakeInterrupt(
            {
                "action_requests": [
                    {
                        "name": "iac_apply",
                        "args": {"working_dir": working_dir, "command": command},
                        "description": "gated apply",
                    }
                ]
            }
        ),
    )


def test_extracts_action_requests():
    reqs = _extract_action_requests(_iac_payload())
    assert len(reqs) == 1
    assert reqs[0]["name"] == "iac_apply"
    assert reqs[0]["args"]["command"] == "terraform apply"


def test_handle_interrupt_emits_and_stores():
    clear_interrupted_graph("thread-iac-1")
    events = []
    handled = _handle_interrupt(
        _iac_payload(),
        graph=object(),
        config={"configurable": {"thread_id": "thread-iac-1"}},
        thread_id="thread-iac-1",
        on_event=events.append,
    )
    assert handled is True
    ev = events[0]
    assert ev["type"] == "iac_approval_request"
    assert ev["thread_id"] == "thread-iac-1"
    assert ev["command"] == "terraform apply"
    assert ev["tool"] == "terraform"
    # classification present; with no terraform binary it fails safe to "high"
    assert ev["classification"]["tier"] in ("low", "medium", "high", "destructive")
    # graph stored for resume
    assert has_interrupted_graph("thread-iac-1") is True
    clear_interrupted_graph("thread-iac-1")


def test_handle_interrupt_ignores_non_iac():
    payload = (_FakeInterrupt({"action_requests": [{"name": "some_other_tool"}]}),)
    handled = _handle_interrupt(
        payload,
        graph=object(),
        config={"configurable": {"thread_id": "thread-x"}},
        thread_id="thread-x",
        on_event=lambda e: None,
    )
    assert handled is False
    assert has_interrupted_graph("thread-x") is False


def test_handle_terminal_fix_interrupt_previews_exact_batch_and_stores(monkeypatch):
    from ccie_sidecar.agents.terminal_agent_tools import register_terminal_context

    thread_id = "thread-terminal-fix"
    clear_interrupted_graph(thread_id)
    register_terminal_context(thread_id, {
        "base_url": "http://127.0.0.1:1/v1",
        "capability": "opaque",
        "lease_id": "lease-1",
        "target": {"backendPtyId": "pty-1"},
    })
    captured = {}

    def preview(self, summary, commands, verification_commands, rollback_commands):
        captured.update({
            "summary": summary,
            "commands": commands,
            "verification_commands": verification_commands,
            "rollback_commands": rollback_commands,
        })
        return {
            "lease_id": "lease-1",
            "digest": "digest-1",
            "target": {"backendPtyId": "pty-1"},
            "summary": summary,
            "commands": commands,
            "verification_commands": verification_commands,
            "rollback_commands": rollback_commands,
            "highest_tier": "T1",
            "per_command_tiers": [{"command": commands[0], "tier": "T1"}],
        }

    monkeypatch.setattr(
        "ccie_sidecar.agents.terminal_agent_tools.TerminalGatewayClient.preview_fix",
        preview,
    )
    payload = (_FakeInterrupt({"action_requests": [{
        "name": "terminal_apply_fix",
        "args": {
            "summary": "Fix source interface",
            "commands": ["ip radius source-interface Vlan10"],
            "verification_commands": ["show aaa servers"],
            "rollback_commands": ["no ip radius source-interface Vlan10"],
        },
    }]}),)
    events = []
    handled = _handle_interrupt(
        payload,
        graph=object(),
        config={"configurable": {"thread_id": thread_id}},
        thread_id=thread_id,
        on_event=events.append,
    )

    assert handled is True
    assert captured["commands"] == ["ip radius source-interface Vlan10"]
    assert events == [{
        "type": "terminal_fix_approval_request",
        "thread_id": thread_id,
        "preview": {
            "lease_id": "lease-1",
            "digest": "digest-1",
            "target": {"backendPtyId": "pty-1"},
            "summary": "Fix source interface",
            "commands": ["ip radius source-interface Vlan10"],
            "verification_commands": ["show aaa servers"],
            "rollback_commands": ["no ip radius source-interface Vlan10"],
            "highest_tier": "T1",
            "per_command_tiers": [{
                "command": "ip radius source-interface Vlan10",
                "tier": "T1",
            }],
        },
    }]
    assert has_interrupted_graph(thread_id) is True
    clear_interrupted_graph(thread_id)


def test_run_and_stream_routes_interrupt_to_approval_event():
    """End-to-end (no LLM): run_and_stream must detect a __interrupt__ chunk,
    emit an iac_approval_request, store the graph, and report interrupted.
    This is the integration the 'it compiles' checks missed."""
    import asyncio
    from ccie_sidecar.agents.deepagents_stream import run_and_stream

    class _FakeGraph:
        async def astream(self, input, config, *, stream_mode, **kwargs):
            yield (
                "updates",
                {
                    "__interrupt__": (
                        _FakeInterrupt(
                            {
                                "action_requests": [
                                    {
                                        "name": "iac_apply",
                                        "args": {
                                            "working_dir": "/infra/dev",
                                            "command": "terraform apply",
                                        },
                                    }
                                ]
                            }
                        ),
                    )
                },
            )

    clear_interrupted_graph("tt-e2e")
    events = []
    result = asyncio.run(
        run_and_stream(
            _FakeGraph(),
            {"messages": []},
            {"configurable": {"thread_id": "tt-e2e"}},
            events.append,
        )
    )
    assert result["interrupted"] is True
    types = [e.get("type") for e in events]
    assert "iac_approval_request" in types
    assert "error" not in types
    assert has_interrupted_graph("tt-e2e") is True
    clear_interrupted_graph("tt-e2e")


def test_ansible_command_classified_as_ansible():
    events = []
    _handle_interrupt(
        _iac_payload(command="ansible-playbook -i prod site.yml"),
        graph=object(),
        config={"configurable": {"thread_id": "thread-ans"}},
        thread_id="thread-ans",
        on_event=events.append,
    )
    assert events[0]["tool"] == "ansible"
    clear_interrupted_graph("thread-ans")
