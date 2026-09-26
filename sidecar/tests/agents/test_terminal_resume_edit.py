import asyncio

from ccie_sidecar.agents import deepagents_hitl


def test_resume_graph_sends_exact_edited_action(monkeypatch):
    captured = {}

    async def fake_run_and_stream(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(
        "ccie_sidecar.agents.deepagents_stream.run_and_stream",
        fake_run_and_stream,
    )
    edited = {
        "name": "terminal_apply_fix",
        "args": {
            "summary": "Correct source interface",
            "commands": ["ip radius source-interface Vlan20"],
            "verification_commands": ["show aaa servers"],
            "rollback_commands": ["no ip radius source-interface Vlan20"],
        },
    }
    asyncio.run(deepagents_hitl.resume_graph(
        graph=object(),
        thread_id="terminal-turn-1",
        decision="edit",
        edited_action=edited,
        on_event=lambda _event: None,
    ))

    command = captured["input_data"]
    assert command.resume == {
        "decisions": [{"type": "edit", "edited_action": edited}]
    }
