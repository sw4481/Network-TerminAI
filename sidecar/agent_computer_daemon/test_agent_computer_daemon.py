from __future__ import annotations

import json
from agent_computer_daemon import AgentComputerDaemon


def test_health_requires_bearer_token():
    daemon = AgentComputerDaemon(token="secret")

    status, body = daemon.handle("GET", "/health", headers={}, body=b"")

    assert status == 401
    assert body == {"ok": False, "error": "unauthorized"}


def test_health_returns_minimal_identity_when_authorized():
    daemon = AgentComputerDaemon(token="secret", hostname="agent-lxc")

    status, body = daemon.handle(
        "GET",
        "/health",
        headers={"Authorization": "Bearer secret"},
        body=b"",
    )

    assert status == 200
    assert body["ok"] is True
    assert body["hostname"] == "agent-lxc"


def test_exec_runs_command_with_timeout_and_returns_output():
    daemon = AgentComputerDaemon(token="secret")
    payload = json.dumps({"command": "printf hello", "timeout": 5}).encode()

    status, body = daemon.handle(
        "POST",
        "/exec",
        headers={"Authorization": "Bearer secret"},
        body=payload,
    )

    assert status == 200
    assert body == {"ok": True, "returncode": 0, "stdout": "hello", "stderr": ""}


def test_file_write_then_read_is_rooted(tmp_path):
    daemon = AgentComputerDaemon(token="secret", root=tmp_path)
    headers = {"Authorization": "Bearer secret"}

    status, body = daemon.handle(
        "POST",
        "/files/write",
        headers=headers,
        body=json.dumps({"path": "notes/a.txt", "content": "hi"}).encode(),
    )
    assert (status, body) == (200, {"ok": True})

    status, body = daemon.handle(
        "POST",
        "/files/read",
        headers=headers,
        body=json.dumps({"path": "notes/a.txt"}).encode(),
    )
    assert status == 200
    assert body == {"ok": True, "content": "hi"}


def test_file_access_rejects_path_escape(tmp_path):
    daemon = AgentComputerDaemon(token="secret", root=tmp_path)

    status, body = daemon.handle(
        "POST",
        "/files/read",
        headers={"Authorization": "Bearer secret"},
        body=json.dumps({"path": "../secret"}).encode(),
    )

    assert status == 400
    assert body["ok"] is False
    assert "outside root" in body["error"]
