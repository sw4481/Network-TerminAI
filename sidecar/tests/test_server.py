import io
import json
import os
from unittest.mock import patch

import pytest

from ccie_sidecar.server import handle_request


def test_ping_returns_pong():
    req = {"id": "r1", "method": "ping"}
    resp = handle_request(req)
    assert resp["id"] == "r1"
    assert resp["type"] == "done"
    assert resp["result"] == "pong"


def test_unknown_method_returns_error():
    req = {"id": "r2", "method": "bogus"}
    resp = handle_request(req)
    assert resp["id"] == "r2"
    assert resp["type"] == "error"
    assert "unknown method" in resp["message"].lower()


def test_missing_id_uses_null_string():
    req = {"method": "ping"}
    resp = handle_request(req)
    assert resp["id"] == ""
    assert resp["type"] == "done"


def test_react_resume_routes_to_stream():
    """agent.react_resume must return a stream marker so run_loop drives the
    resume — regression for it falling through to 'unknown method', which broke
    the IaC approval round-trip."""
    req = {
        "id": "rr",
        "method": "agent.react_resume",
        "params": {"thread_id": "default", "decision": "approve"},
    }
    resp = handle_request(req)
    assert resp["type"] == "stream"
    assert resp["method"] == "agent.react_resume"


def test_react_resume_requires_thread_id_and_decision():
    missing_thread = handle_request(
        {"id": "a", "method": "agent.react_resume", "params": {"decision": "approve"}}
    )
    assert missing_thread["type"] == "error"
    assert "thread_id" in missing_thread["message"]

    missing_decision = handle_request(
        {"id": "b", "method": "agent.react_resume", "params": {"thread_id": "default"}}
    )
    assert missing_decision["type"] == "error"
    assert "decision" in missing_decision["message"]


def test_react_resume_accepts_continue_for_a_preserved_checkpoint():
    response = handle_request({
        "id": "continue-1",
        "method": "agent.react_resume",
        "params": {"thread_id": "architect-run-1", "decision": "continue"},
    })
    assert response["type"] == "stream"
    assert response["method"] == "agent.react_resume"


def test_terminal_context_is_rejected_for_non_architect_agents():
    response = handle_request({
        "id": "terminal-scope",
        "method": "agent.react_code_loop",
        "params": {
            "agent_id": "ise",
            "message": "inspect this switch",
            "terminal_context": {"capability": "must-never-reach-ise"},
        },
    })
    assert response["type"] == "error"
    assert "network-architect" in response["message"]


def test_react_code_runtime_receives_architect_terminal_context():
    captured = {}

    async def fake_react_code_loop(**kwargs):
        captured.update(kwargs)
        return {"interrupted": False}

    request = {
        "id": "terminal-forward",
        "method": "agent.react_code_loop",
        "params": {
            "agent_id": "network-architect",
            "message": "inspect this switch",
            "engine": "deepagents",
            "history": [],
            "terminal_context": {
                "turn_id": "turn-1",
                "lease_id": "lease-1",
                "capability": "opaque",
            },
        },
    }
    with patch(
        "ccie_sidecar.agents.deepagents_runtime.deepagents_react_code_loop",
        new=fake_react_code_loop,
    ):
        from ccie_sidecar.server import run_loop

        run_loop(io.StringIO(json.dumps(request) + "\n"), io.StringIO())

    assert captured["ctx"]["terminal_context"]["turn_id"] == "turn-1"


def test_react_code_runtime_receives_unique_run_id_for_architect_checkpoint():
    captured = {}

    async def fake_react_code_loop(**kwargs):
        captured.update(kwargs)
        return {"interrupted": False}

    request = {
        "id": "architect-run-id",
        "method": "agent.react_code_loop",
        "params": {
            "agent_id": "network-architect",
            "message": "continue a long investigation",
            "engine": "deepagents",
            "history": [],
            "run_id": "run-unique-1",
        },
    }
    with patch(
        "ccie_sidecar.agents.deepagents_runtime.deepagents_react_code_loop",
        new=fake_react_code_loop,
    ):
        from ccie_sidecar.server import run_loop

        run_loop(io.StringIO(json.dumps(request) + "\n"), io.StringIO())

    assert captured["ctx"]["run_id"] == "run-unique-1"


def test_run_loop_continues_saved_graph_without_a_new_prompt():
    from langchain_core.messages import AIMessage

    from ccie_sidecar.agents.deepagents_state import store_interrupted_graph

    observed = {}

    class SavedGraph:
        async def astream(self, input_data, config, stream_mode, **kwargs):
            observed["input_data"] = input_data
            observed["config"] = config
            yield ((), "updates", {
                "agent": {"messages": [AIMessage(content="continued result")]},
            })

    config = {
        "configurable": {"thread_id": "saved-run-1"},
        "recursion_limit": 60,
    }
    store_interrupted_graph(
        "saved-run-1",
        SavedGraph(),
        config,
        lambda _event: None,
    )
    request = {
        "id": "continue-saved",
        "method": "agent.react_resume",
        "params": {
            "thread_id": "saved-run-1",
            "decision": "continue",
        },
    }

    from ccie_sidecar.server import run_loop

    stdout = io.StringIO()
    run_loop(io.StringIO(json.dumps(request) + "\n"), stdout)

    assert observed == {"input_data": None, "config": config}
    messages = [
        json.loads(line)
        for line in stdout.getvalue().splitlines()
        if line and json.loads(line).get("id") == "continue-saved"
    ]
    assert [message["type"] for message in messages] == ["final", "done"]
    assert messages[0]["response"] == "continued result"


def test_run_loop_reads_ndjson_and_writes_response():
    from ccie_sidecar.server import run_loop
    stdin = io.StringIO(json.dumps({"id": "r1", "method": "ping"}) + "\n")
    stdout = io.StringIO()
    run_loop(stdin, stdout)
    # run_loop starts a heartbeat thread that may emit a `sidecar.heartbeat`
    # line (id="") before returning — timing-dependent, so it shows up on some
    # platforms (Windows CI) and not others. Ignore those and assert on the
    # actual ping response.
    msgs = [json.loads(ln) for ln in stdout.getvalue().splitlines() if ln]
    responses = [m for m in msgs if m.get("id") == "r1"]
    assert len(responses) == 1
    assert responses[0] == {"id": "r1", "type": "done", "result": "pong"}


def test_chat_stream_method_yields_tokens():
    """Test that chat.stream method yields tokens as NDJSON."""
    with patch("ccie_sidecar.server.chat_stream") as mock_chat_stream:
        mock_chat_stream.return_value = iter([
            {"type": "token", "data": "Hello"},
            {"type": "token", "data": " world"},
        ])

        req = {
            "id": "r1",
            "method": "chat.stream",
            "params": {
                "session_id": "s1",
                "messages": [{"role": "user", "content": "test"}],
            }
        }

        from ccie_sidecar.server import run_loop
        stdin = io.StringIO(json.dumps(req) + "\n")
        stdout = io.StringIO()
        run_loop(stdin, stdout)

        # Drop any racing startup heartbeat line (id="" / sidecar.heartbeat);
        # its arrival before run_loop returns is timing-dependent (fires on
        # Windows CI, usually not on Unix). Assert on the r1 response stream.
        msgs = [json.loads(ln) for ln in stdout.getvalue().splitlines() if ln]
        lines = [m for m in msgs if m.get("id") == "r1"]
        assert len(lines) == 3  # 2 tokens + done

        token1 = lines[0]
        assert token1["id"] == "r1"
        assert token1["type"] == "token"
        assert token1["data"] == "Hello"

        token2 = lines[1]
        assert token2["id"] == "r1"
        assert token2["type"] == "token"
        assert token2["data"] == " world"

        done = lines[2]
        assert done["id"] == "r1"
        assert done["type"] == "done"


def test_chat_stream_method_handles_missing_params():
    """Test that chat.stream method handles missing parameters."""
    req = {
        "id": "r1",
        "method": "chat.stream",
        "params": {}
    }

    resp = handle_request(req)
    assert resp["id"] == "r1"
    assert resp["type"] == "error"
    assert "session_id" in resp["message"].lower() or "messages" in resp["message"].lower()


def test_react_resume_accepts_edit_decision_with_edited_action():
    resp = handle_request({
        "id": "edit-1",
        "method": "agent.react_resume",
        "params": {
            "thread_id": "terminal-turn-1",
            "decision": "edit",
            "edited_action": {
                "name": "terminal_apply_fix",
                "args": {"commands": ["logging host 192.0.2.10"]},
            },
        },
    })
    assert resp["type"] == "stream"


def test_chat_stream_method_forwards_profile():
    """Test that chat.stream method forwards profile parameter."""
    with patch("ccie_sidecar.server.chat_stream") as mock_chat_stream:
        mock_chat_stream.return_value = iter([{"type": "token", "data": "test"}])

        req = {
            "id": "r1",
            "method": "chat.stream",
            "params": {
                "session_id": "s1",
                "messages": [{"role": "user", "content": "test"}],
                "profile": "quality"
            }
        }

        from ccie_sidecar.server import run_loop
        stdin = io.StringIO(json.dumps(req) + "\n")
        stdout = io.StringIO()
        run_loop(stdin, stdout)

        # Verify chat_stream was called with profile
        mock_chat_stream.assert_called_once_with(
            session_id="s1",
            messages=[{"role": "user", "content": "test"}],
            profile="quality"
        )


def test_generate_skill_method_returns_skill_md():
    """Test that generate_skill method returns skill_md and suggestions."""
    if not os.getenv("ANTHROPIC_API_KEY"):
        pytest.skip("ANTHROPIC_API_KEY not set")

    with patch("ccie_sidecar.skill_author.generate_skill") as mock_generate:
        mock_generate.return_value = {
            "skill_md": "---\nname: test\n---\n# Playbook",
            "suggested_scripts": [{"filename": "test.py", "language": "python", "skeleton": "#!/usr/bin/env python3"}]
        }

        req = {
            "id": "r1",
            "method": "generate_skill",
            "params": {
                "description": "Create a test skill"
            }
        }

        resp = handle_request(req)
        assert resp["id"] == "r1"
        assert resp["type"] == "done"
        assert "result" in resp
        assert "skill_md" in resp["result"]
        assert "suggested_scripts" in resp["result"]


def test_generate_skill_method_handles_missing_description():
    """Test that generate_skill method requires description parameter."""
    req = {
        "id": "r1",
        "method": "generate_skill",
        "params": {}
    }

    resp = handle_request(req)
    assert resp["id"] == "r1"
    assert resp["type"] == "error"
    assert "description" in resp["message"].lower()


def test_generate_skill_method_forwards_examples():
    """Test that generate_skill method forwards examples parameter."""
    if not os.getenv("ANTHROPIC_API_KEY"):
        pytest.skip("ANTHROPIC_API_KEY not set")

    with patch("ccie_sidecar.skill_author.generate_skill") as mock_generate:
        mock_generate.return_value = {
            "skill_md": "---\nname: test\n---\n# Playbook",
            "suggested_scripts": []
        }

        req = {
            "id": "r1",
            "method": "generate_skill",
            "params": {
                "description": "Test skill",
                "examples": ["Example 1", "Example 2"]
            }
        }

        resp = handle_request(req)
        assert resp["type"] == "done"

        # Verify generate_skill was called with examples
        mock_generate.assert_called_once_with(
            description="Test skill",
            examples=["Example 1", "Example 2"],
            profile="default"
        )


def test_architect_keyword_defaults_lists_all_vendors():
    """Test that architect.keyword_defaults returns all vendors in order."""
    req = {"id": "1", "method": "architect.keyword_defaults", "params": {}}
    resp = handle_request(req)

    assert resp["type"] == "done"
    vendors = resp["result"]["vendors"]
    ids = [v["id"] for v in vendors]
    # All vendors, in VENDOR_SPECS order.
    assert ids == [
        "aci", "gnmi", "fmc", "thousandeyes", "cml", "ise", "secure_endpoint",
        "cisco_xdr", "stealthwatch", "catalyst_center", "splunk", "meraki",
        "mist", "pyats", "grafana", "zabbix", "prometheus", "netbox", "sketchfab",
        "devnet", "fwrule", "topolograph",
    ]
    ise = next(v for v in vendors if v["id"] == "ise")
    assert ise["display"] == "Cisco ISE (identity)"
    assert "radius" in ise["keywords"]
