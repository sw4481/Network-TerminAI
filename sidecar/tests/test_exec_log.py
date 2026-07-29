"""Tests for the agent execution logger (exec_log)."""
import json

from ccie_sidecar import exec_log


def test_log_execution_writes_jsonl(tmp_path, monkeypatch):
    log = tmp_path / "logs" / "agent_exec.jsonl"
    monkeypatch.setattr(exec_log, "_log_path", lambda: log)
    monkeypatch.setenv("CCIE_EXEC_LOG_STDERR", "0")  # quiet for the test

    exec_log.log_execution(
        label="meraki",
        code="print(1)",
        result={"success": True, "output": "1\n", "error": ""},
        duration_ms=12,
    )
    entry = json.loads(log.read_text().strip())
    assert entry["label"] == "meraki"
    assert entry["success"] is True
    assert entry["duration_ms"] == 12
    assert entry["code"] == "print(1)"


def test_log_execution_captures_error(tmp_path, monkeypatch):
    log = tmp_path / "logs" / "agent_exec.jsonl"
    monkeypatch.setattr(exec_log, "_log_path", lambda: log)
    monkeypatch.setenv("CCIE_EXEC_LOG_STDERR", "0")

    exec_log.log_execution(
        label="ise",
        code="boom",
        result={"success": False, "output": "", "error": "NameError: boom"},
        duration_ms=3,
    )
    entry = json.loads(log.read_text().strip())
    assert entry["success"] is False
    assert "NameError" in entry["error"]


def test_disabled_writes_nothing(tmp_path, monkeypatch):
    log = tmp_path / "logs" / "agent_exec.jsonl"
    monkeypatch.setattr(exec_log, "_log_path", lambda: log)
    monkeypatch.setenv("CCIE_EXEC_LOG", "0")
    monkeypatch.setenv("CCIE_EXEC_LOG_STDERR", "0")

    exec_log.log_execution(label="x", code="y", result={"success": True}, duration_ms=1)
    assert not log.exists()


def test_output_is_clipped(tmp_path, monkeypatch):
    log = tmp_path / "logs" / "agent_exec.jsonl"
    monkeypatch.setattr(exec_log, "_log_path", lambda: log)
    monkeypatch.setenv("CCIE_EXEC_LOG_STDERR", "0")

    huge = "x" * 10000
    exec_log.log_execution(
        label="meraki", code="print(x)",
        result={"success": True, "output": huge, "error": ""}, duration_ms=1,
    )
    entry = json.loads(log.read_text().strip())
    assert len(entry["output"]) < len(huge)
    assert "clipped" in entry["output"]


def test_never_raises_on_bad_result(tmp_path, monkeypatch):
    log = tmp_path / "logs" / "agent_exec.jsonl"
    monkeypatch.setattr(exec_log, "_log_path", lambda: log)
    monkeypatch.setenv("CCIE_EXEC_LOG_STDERR", "0")
    # Non-serializable object in result must not raise (default=str handles it).
    exec_log.log_execution(
        label="x", code="y", result={"success": True, "output": object()}, duration_ms=1,
    )
    assert log.exists()
