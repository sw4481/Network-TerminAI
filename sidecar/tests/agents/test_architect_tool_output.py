"""Network Architect must use the same bounded output seam as specialists."""
from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

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
