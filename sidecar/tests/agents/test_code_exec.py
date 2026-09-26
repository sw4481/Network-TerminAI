import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

import ccie_sidecar.agents.code_exec as code_exec_module
from ccie_sidecar import exec_log
from ccie_sidecar.agents.code_exec import (
    _build_sandbox_globals,
    _execute_code_with_timeout,
    code_exec_loop,
    MAX_RETRY_ATTEMPTS,
)


def test_sandbox_has_standard_library():
    """Sandbox should include json, datetime, collections"""
    globals_dict = _build_sandbox_globals("meraki", {"meraki_api_key": "test_key"})

    import json, datetime, collections
    assert globals_dict["json"] is json
    assert globals_dict["datetime"] is datetime
    assert globals_dict["collections"] is collections


def test_sandbox_without_cli_package():
    """Sandbox should work with None cli_package (basic sandbox only)"""
    globals_dict = _build_sandbox_globals(None, {})

    import json, datetime, collections
    assert globals_dict["json"] is json
    assert globals_dict["datetime"] is datetime
    assert globals_dict["collections"] is collections
    # Should NOT have meraki
    assert "meraki" not in globals_dict


def test_sandbox_has_pandas():
    """Sandbox should include pandas as pd"""
    pytest.importorskip("pandas")
    globals_dict = _build_sandbox_globals("meraki", {"meraki_api_key": "test_key"})

    import pandas
    assert globals_dict["pd"] is pandas


def test_sandbox_has_cli_package():
    """Sandbox should include initialized CLI package"""
    pytest.importorskip("meraki_cli")
    globals_dict = _build_sandbox_globals("meraki", {"meraki_api_key": "test_key_123"})

    # meraki_cli should be available (we'll check it's a module)
    assert "meraki" in globals_dict
    # Can't test actual initialization without real API, but verify it's present


def test_execute_code_success():
    """Code that prints and returns should succeed"""
    code = "print('hello world')"
    result = _execute_code_with_timeout(code, {}, timeout=5)

    assert result["success"] is True
    assert "hello world" in result["output"]
    assert result["error"] == ""


def test_execute_code_with_variables():
    """Code can use variables from sandbox globals"""
    code = """
x = 1 + 2
print(f'Result: {x}')
"""
    result = _execute_code_with_timeout(code, {}, timeout=5)

    assert result["success"] is True
    assert "Result: 3" in result["output"]


def test_execute_code_error():
    """Code that raises exception should fail gracefully"""
    code = "x = 1 / 0"
    result = _execute_code_with_timeout(code, {}, timeout=5)

    assert result["success"] is False
    assert "ZeroDivisionError" in result["error"]
    assert result["output"] == ""


def test_execute_code_name_error():
    """Code referencing undefined variable should fail"""
    code = "print(undefined_variable)"
    result = _execute_code_with_timeout(code, {}, timeout=5)

    assert result["success"] is False
    assert "NameError" in result["error"]


def test_execute_code_timeout():
    """Code that runs too long should timeout"""
    code = "import time; time.sleep(10)"
    result = _execute_code_with_timeout(code, {}, timeout=1)

    assert result["success"] is False
    assert "timed out" in result["error"].lower() or "timeout" in result["error"].lower()


def test_execute_code_infinite_loop():
    """Infinite loop should timeout"""
    code = "while True: pass"
    result = _execute_code_with_timeout(code, {}, timeout=1)

    assert result["success"] is False


def test_process_wide_coordinator_serializes_distinct_sandboxes(monkeypatch):
    """Different tool instances cannot overlap process-global stdout or env."""
    env_key = "TERMINAI_TEST_COORDINATOR_OWNER"
    monkeypatch.setenv(env_key, "baseline")
    baseline_stdout = sys.stdout
    start = threading.Barrier(3)

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
    code = (
        "probe.enter()\n"
        "try:\n"
        f"    print(name + ':' + os.environ['{env_key}'])\n"
        "    time.sleep(0.05)\n"
        "finally:\n"
        "    probe.exit()\n"
    )

    def run(name):
        start.wait(timeout=5)
        return _execute_code_with_timeout(
            code,
            {"probe": probe, "name": name, "os": os, "time": time},
            timeout=0.5,
            env_overrides={env_key: name},
            label=f"coordinator-{name}",
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(run, "sandbox-a")
        second = pool.submit(run, "sandbox-b")
        start.wait(timeout=5)
        first_result = first.result(timeout=5)
        second_result = second.result(timeout=5)

    assert first_result["success"] is True
    assert second_result["success"] is True
    assert first_result["output"].splitlines() == ["sandbox-a:sandbox-a"]
    assert second_result["output"].splitlines() == ["sandbox-b:sandbox-b"]
    assert probe.max_active == 1
    assert os.environ[env_key] == "baseline"
    assert sys.stdout is baseline_stdout


def test_normal_coordinator_queue_does_not_consume_successor_timeout(monkeypatch):
    """A normal owner's queue delay is outside the successor watchdog budget."""
    env_key = "TERMINAI_TEST_TIMEOUT_OWNER"
    monkeypatch.setenv(env_key, "baseline")
    first_started = threading.Event()
    second_started = threading.Event()

    first_code = (
        "first_started.set()\n"
        f"print('first:' + os.environ['{env_key}'])\n"
        "time.sleep(0.15)\n"
    )
    second_code = (
        "second_started.set()\n"
        f"print('second:' + os.environ['{env_key}'])\n"
    )

    with ThreadPoolExecutor(max_workers=2) as pool:
        first_future = pool.submit(
            _execute_code_with_timeout,
            first_code,
            {
                "first_started": first_started,
                "os": os,
                "time": time,
            },
            0.5,
            {env_key: "first"},
            "normal-owner",
        )
        assert first_started.wait(timeout=2)

        second_submitted = time.monotonic()
        second_future = pool.submit(
            _execute_code_with_timeout,
            second_code,
            {"second_started": second_started, "os": os},
            0.03,
            {env_key: "second"},
            "timeout-successor",
        )

        # This is an ordinary queue, not quarantine. The second execution has
        # not entered, and its own 30ms watchdog has not started.
        time.sleep(0.05)
        assert second_started.is_set() is False
        assert second_future.done() is False

        first_result = first_future.result(timeout=2)
        second_result = second_future.result(timeout=2)
        elapsed = time.monotonic() - second_submitted

    assert first_result["success"] is True
    assert second_result["success"] is True
    assert second_result["output"].splitlines() == ["second:second"]
    assert elapsed >= 0.10
    assert os.environ[env_key] == "baseline"


def test_worker_infinite_loop_timeout_restores_state_and_recovers(monkeypatch, tmp_path):
    """A timed-out Python loop is stopped before the executor admits its successor."""
    env_key = "TERMINAI_TEST_TIMEOUT_RECOVERY"
    monkeypatch.setenv(env_key, "baseline")
    monkeypatch.setenv("CCIE_EXEC_LOG_STDERR", "0")
    monkeypatch.setattr(exec_log, "_log_path", lambda: tmp_path / "agent_exec.jsonl")
    incident_path = tmp_path / "sandbox_incidents.jsonl"
    monkeypatch.setattr(
        exec_log,
        "_sandbox_incident_log_path",
        lambda: incident_path,
    )
    baseline_stdout = sys.stdout
    owner_started = threading.Event()

    owner_code = (
        "owner_started.set()\n"
        f"print('owner:' + os.environ['{env_key}'])\n"
        "while True:\n"
        "    pass\n"
    )

    with ThreadPoolExecutor(max_workers=1) as pool:
        owner_result = pool.submit(
            _execute_code_with_timeout,
            owner_code,
            {
                "owner_started": owner_started,
                "os": os,
            },
            0.08,
            {env_key: "owner"},
            "heartbeat-meraki",
        ).result(timeout=2)

    assert owner_started.is_set()
    assert owner_result["success"] is False
    assert "timed out" in owner_result["error"].lower()

    # Recovery is immediate: the previous worker has already restored the
    # process-global stdout/environment seam before this call is admitted.
    with ThreadPoolExecutor(max_workers=1) as pool:
        recovery_result = pool.submit(
            _execute_code_with_timeout,
            f"print('recovered:' + os.environ['{env_key}'])",
            {"os": os},
            1,
            {env_key: "recovered"},
            "heartbeat-recovery",
        ).result(timeout=2)

    assert recovery_result["success"] is True
    assert recovery_result["output"].splitlines() == ["recovered:recovered"]
    assert os.environ[env_key] == "baseline"
    assert sys.stdout is baseline_stdout

    incidents = [
        json.loads(line)
        for line in incident_path.read_text(encoding="utf-8").splitlines()
    ]
    timeout_incident = incidents[-1]
    assert timeout_incident["event"] == "sandbox_execution_timeout"
    assert timeout_incident["label"] == "heartbeat-meraki"
    assert timeout_incident["timeout_seconds"] == 0.08
    assert timeout_incident["recovery_action"] == "cooperative_cancel"
    assert timeout_incident["worker_stopped"] is True
    assert timeout_incident["executor_quarantined"] is False
    assert timeout_incident["code_sha256"] == hashlib.sha256(
        owner_code.encode("utf-8")
    ).hexdigest()
    assert timeout_incident["code_chars"] == len(owner_code)
    assert timeout_incident["code_lines"] == len(owner_code.splitlines())
    assert owner_code not in incident_path.read_text(encoding="utf-8")


def test_uninterruptible_worker_schedules_recycle_then_can_release(
    monkeypatch,
    tmp_path,
):
    """Native waits use the bounded recycle fallback instead of permanent quarantine."""
    env_key = "TERMINAI_TEST_NATIVE_WAIT"
    monkeypatch.setenv(env_key, "baseline")
    monkeypatch.setenv("CCIE_EXEC_LOG_STDERR", "0")
    monkeypatch.setattr(exec_log, "_log_path", lambda: tmp_path / "agent_exec.jsonl")
    monkeypatch.setattr(
        exec_log,
        "_sandbox_incident_log_path",
        lambda: tmp_path / "sandbox_incidents.jsonl",
    )
    monkeypatch.setattr(code_exec_module, "_cancel_grace_seconds", lambda: 0.02)
    scheduled: list[tuple[object, str, str | None]] = []
    monkeypatch.setattr(
        code_exec_module,
        "_schedule_sidecar_recycle",
        lambda owner, incident_id, label: scheduled.append(
            (owner, incident_id, label)
        ),
    )

    release_owner = threading.Event()
    owner_started = threading.Event()
    owner_code = (
        "owner_started.set()\n"
        "release_owner.wait()\n"
    )

    with ThreadPoolExecutor(max_workers=1) as pool:
        owner_result = pool.submit(
            _execute_code_with_timeout,
            owner_code,
            {
                "owner_started": owner_started,
                "release_owner": release_owner,
            },
            0.05,
            {env_key: "owner"},
            "native-wait",
        ).result(timeout=2)

    assert owner_started.is_set()
    assert owner_result["success"] is False
    assert "timed out" in owner_result["error"].lower()
    assert len(scheduled) == 1
    assert scheduled[0][2] == "native-wait"

    # Let this synthetic native wait finish so it cannot poison the test
    # process. Production leaves it alone and the scheduled recycle exits.
    release_owner.set()
    deadline = time.monotonic() + 2
    while True:
        with ThreadPoolExecutor(max_workers=1) as pool:
            recovered = pool.submit(
                _execute_code_with_timeout,
                "print('recovered')",
                {},
                0.5,
                None,
                "native-wait-recovery",
            ).result(timeout=2)
        if recovered["success"]:
            break
        assert "temporarily unavailable" in recovered["error"].lower()
        assert time.monotonic() < deadline
        time.sleep(0.01)

    incident = json.loads(
        (tmp_path / "sandbox_incidents.jsonl")
        .read_text(encoding="utf-8")
        .splitlines()[-1]
    )
    assert incident["recovery_action"] == "sidecar_recycle_scheduled"
    assert incident["worker_stopped"] is False
    assert incident["executor_quarantined"] is True
    assert incident["recycle_delay_seconds"] > 0
    assert os.environ[env_key] == "baseline"


def test_uninterruptible_worker_recycles_sidecar_process(tmp_path):
    """The production fallback exits with the reserved recycle status."""
    sidecar_src = Path(__file__).resolve().parents[2] / "src"
    log_dir = tmp_path / "logs"
    script = """
import threading
import time
from ccie_sidecar.agents.code_exec import _execute_code_with_timeout

release = threading.Event()

def run_tool():
    _execute_code_with_timeout(
        "release.wait()",
        {"release": release},
        timeout=0.05,
        label="subprocess-native-wait",
    )

threading.Thread(target=run_tool, daemon=True).start()
time.sleep(3)
raise SystemExit(99)
"""
    env = os.environ.copy()
    env["PYTHONPATH"] = (
        str(sidecar_src)
        + os.pathsep
        + env.get("PYTHONPATH", "")
    )
    env["CCIE_LOG_DIR"] = str(log_dir)
    env["CCIE_EXEC_LOG_STDERR"] = "0"
    env["CCIE_SANDBOX_CANCEL_GRACE_SECONDS"] = "0.02"
    env["CCIE_SANDBOX_RECYCLE_DELAY_SECONDS"] = "0.05"

    completed = subprocess.run(
        [sys.executable, "-c", script],
        env=env,
        capture_output=True,
        text=True,
        timeout=4,
        check=False,
    )

    assert completed.returncode == code_exec_module._SIDECAR_RECYCLE_EXIT_CODE
    incidents = [
        json.loads(line)
        for line in (log_dir / "sandbox_incidents.jsonl")
        .read_text(encoding="utf-8")
        .splitlines()
    ]
    assert [entry["event"] for entry in incidents] == [
        "sandbox_execution_timeout",
        "sandbox_sidecar_recycle",
    ]
    assert incidents[-1]["reason"] == "worker_still_running"


# ---------------------------------------------------------------------------
# Integration tests for code_exec_loop
# These require LLM mocking and are documented here for future implementation.
# ---------------------------------------------------------------------------

def test_code_exec_loop_is_importable():
    """Verify code_exec_loop is importable and has correct signature."""
    import inspect

    sig = inspect.signature(code_exec_loop)
    params = list(sig.parameters.keys())
    assert params == ["agent_def", "user_msg", "ctx", "on_event"]
    assert inspect.iscoroutinefunction(code_exec_loop)


def test_max_retry_attempts_constant():
    """MAX_RETRY_ATTEMPTS should be 3."""
    assert MAX_RETRY_ATTEMPTS == 3


# @pytest.mark.asyncio
# async def test_code_exec_loop_success():
#     """Integration test: simple query should execute and return result.
#
#     Requires LLM mocking. To run manually:
#     1. Mock call_llm to return a tool_use response with code
#     2. Verify events: code_start → code_executing → code_result → final
#
#     Example:
#         events = []
#
#         def capture_event(event):
#             events.append(event)
#
#         agent_def = {
#             "agent_id": "test_meraki",
#             "system_prompt": "You are a test agent.",
#             "attached_tools": [{
#                 "id": "meraki",
#                 "catalog": "tools-minimal.json",
#                 "vault_entry": "Test",
#                 "vault_secrets": {"meraki_api_key": "test_key"}
#             }]
#         }
#
#         await code_exec_loop(agent_def, "print hello", {}, capture_event)
#
#         assert any(e["type"] == "code_start" for e in events)
#         assert any(e["type"] == "final" for e in events)
#     """
#     pass


# @pytest.mark.asyncio
# async def test_code_exec_loop_retry_on_error():
#     """Integration test: code errors should trigger retry with LLM.
#
#     Requires LLM mocking. To run manually:
#     1. Mock call_llm to return code that fails on first attempt
#     2. Mock second call_llm to return fixed code
#     3. Verify events: code_start → code_error → code_start → code_result → final
#
#     Example:
#         events = []
#         agent_def = { ... }
#
#         await code_exec_loop(agent_def, "query devices", {}, lambda e: events.append(e))
#
#         error_events = [e for e in events if e["type"] == "code_error"]
#         assert len(error_events) >= 1
#         assert error_events[0]["attempt"] == 1
#         assert any(e["type"] == "final" for e in events)
#     """
#     pass


# @pytest.mark.asyncio
# async def test_code_exec_loop_max_retries_exceeded():
#     """Integration test: max retries should emit error event.
#
#     Requires LLM mocking. To run manually:
#     1. Mock call_llm to always return code that fails
#     2. Verify error event after MAX_RETRY_ATTEMPTS
#
#     Example:
#         events = []
#         agent_def = { ... }
#
#         await code_exec_loop(agent_def, "bad query", {}, lambda e: events.append(e))
#
#         error_events = [e for e in events if e["type"] == "error"]
#         assert any("failed after 3 attempts" in e["message"] for e in error_events)
#     """
#     pass


# @pytest.mark.asyncio
# async def test_code_exec_loop_no_tools_attached():
#     """Integration test: missing tools should emit error immediately.
#
#     Example:
#         events = []
#         agent_def = {"system_prompt": "test", "attached_tools": []}
#
#         await code_exec_loop(agent_def, "query", {}, lambda e: events.append(e))
#
#         assert events[0]["type"] == "error"
#         assert "No tools attached" in events[0]["message"]
#     """
#     pass
