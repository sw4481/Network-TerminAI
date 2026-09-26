"""Focused contracts for bounded DeepAgents code-execution output."""
from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from ccie_sidecar.agents.tool_output import (
    DEFAULT_MAX_RETAINED_BYTES,
    DEFAULT_MAX_RETURN_CHARS,
    ToolOutputHelper,
    ToolOutputPolicy,
    install_tool_output_policy,
)


def _installed(
    policy: ToolOutputPolicy | None = None,
) -> tuple[ToolOutputPolicy, object, dict]:
    sandbox: dict = {}
    selected = policy or ToolOutputPolicy()
    return selected, selected.install(sandbox), sandbox


@pytest.mark.parametrize("size", [47_999, DEFAULT_MAX_RETURN_CHARS])
def test_under_and_exact_return_budget_are_byte_for_byte_unchanged(size):
    policy, helper, _ = _installed()
    raw = "x" * size

    assert policy.format(raw, helper, kind="stdout") == raw
    assert helper.stats()["original_chars"] == size


def test_oversized_text_is_hard_bounded_and_middle_stays_queryable():
    policy, helper, _ = _installed()
    sentinel = "MIDDLE-SENTINEL-4A6B"
    raw = ("a" * 70_000) + sentinel + ("z" * 70_000)

    rendered = policy.format(raw, helper, kind="stdout")

    assert len(rendered) <= DEFAULT_MAX_RETURN_CHARS
    assert "Original: 140020 characters" in rendered
    assert "Format: text" in rendered
    assert "tool_output.grep" in rendered
    assert sentinel not in rendered
    assert sentinel in helper.grep(sentinel)
    assert "/large_tool_results/" not in rendered


@pytest.mark.parametrize("payload_format", ["json", "ndjson", "csv"])
def test_oversized_structured_results_have_deterministic_compact_sample(
    payload_format, monkeypatch
):
    # Explicit generic mode must win even while the optional feature is off.
    monkeypatch.setenv("CCIE_GCF_MODE", "off")
    rows = [
        {"name": f"switch-{index:05d}", "status": "online", "ports": index}
        for index in range(4_000)
    ]
    if payload_format == "json":
        raw = json.dumps(rows)
        expected_format = "Format: JSON"
    elif payload_format == "ndjson":
        raw = "\n".join(json.dumps(row) for row in rows)
        expected_format = "Format: NDJSON"
    else:
        raw = "name,status,ports\n" + "\n".join(
            f"{row['name']},{row['status']},{row['ports']}" for row in rows
        )
        expected_format = "Format: delimited table"

    policy, helper, _ = _installed()
    first = policy.format(raw, helper, kind="stdout")
    second = policy.format(raw, helper, kind="stdout")

    assert first == second
    assert len(first) <= DEFAULT_MAX_RETURN_CHARS
    assert expected_format in first
    assert "Records: 4000" in first
    assert "Columns: name, status, ports" in first
    assert "#table" in first


def test_unicode_and_malformed_json_are_bounded_without_raising():
    policy, helper, _ = _installed()
    unicode_raw = ("🛰️ réseau 東京\n" * 8_000) + "FIN"
    malformed = '{"devices": [' + ("not-json," * 15_000)

    unicode_rendered = policy.format(unicode_raw, helper, kind="stdout")
    malformed_rendered = policy.format(malformed, helper, kind="stdout")

    assert len(unicode_rendered) <= DEFAULT_MAX_RETURN_CHARS
    assert "🛰️" in unicode_rendered
    assert unicode_rendered.endswith(
        "never use Python open(), pathlib, or execute_python_code for that path."
    )
    assert len(malformed_rendered) <= DEFAULT_MAX_RETURN_CHARS
    assert "Format: text" in malformed_rendered


def test_raw_retention_clips_at_two_mib_and_reports_head_tail_strategy():
    policy, helper, _ = _installed()
    raw = ("H" * 1_500_000) + ("M" * 200_000) + ("T" * 1_500_000)

    policy.format(raw, helper, kind="stdout")
    stats = helper.stats()

    assert stats["original_bytes"] == len(raw)
    assert stats["retention_clipped"] is True
    assert stats["retention_strategy"] == "head_tail"
    assert stats["retained_bytes"] <= DEFAULT_MAX_RETAINED_BYTES
    assert helper.head(lines=1).startswith("H")
    assert helper.tail(lines=1).endswith("T")
    with pytest.raises(ValueError, match="not complete JSON"):
        helper.json()


def test_retention_clipping_skips_structured_reparse(monkeypatch):
    from ccie_sidecar.agents import tool_output

    policy, helper, _ = _installed()
    raw = "x" * (DEFAULT_MAX_RETAINED_BYTES + 100_000)

    def fail_if_reparsed(_text):
        pytest.fail("clipped payload was passed back into structured parsing")

    monkeypatch.setattr(tool_output, "_structured_preview", fail_if_reparsed)
    rendered = policy.format(raw, helper, kind="stdout")

    assert len(rendered) <= DEFAULT_MAX_RETURN_CHARS
    assert "raw retention clipped; structured analysis skipped" in rendered
    assert "unretained middle omitted" in rendered


def test_concurrent_same_sandbox_formats_use_immutable_per_call_snapshots():
    """Force the old capture/read interleaving and verify no A/B mixing."""
    policy = ToolOutputPolicy()
    a_prepared = threading.Event()
    release_a = threading.Event()

    class PausingHelper(ToolOutputHelper):
        def prepare_snapshot(self, text):
            snapshot = super().prepare_snapshot(text)
            if str(text).startswith("CALL-A-HEAD"):
                a_prepared.set()
                assert release_a.wait(timeout=5)
            return snapshot

    helper = PausingHelper(policy)
    a_raw = (
        "CALL-A-HEAD\n"
        + ("a" * (DEFAULT_MAX_RETAINED_BYTES + 100_000))
        + "\nCALL-A-TAIL"
    )
    b_raw = (
        "CALL-B-HEAD\n"
        + ("b" * (DEFAULT_MAX_RETAINED_BYTES + 200_000))
        + "\nCALL-B-TAIL"
    )

    with ThreadPoolExecutor(max_workers=2) as pool:
        a_future = pool.submit(policy.format, a_raw, helper, kind="stdout")
        assert a_prepared.wait(timeout=5)
        b_rendered = pool.submit(
            policy.format, b_raw, helper, kind="stdout"
        ).result(timeout=5)
        release_a.set()
        a_rendered = a_future.result(timeout=5)

    assert f"Original: {len(a_raw)} characters" in a_rendered
    assert "CALL-A-HEAD" in a_rendered
    assert "CALL-A-TAIL" in a_rendered
    assert "CALL-B-" not in a_rendered
    assert f"Original: {len(b_raw)} characters" in b_rendered
    assert "CALL-B-HEAD" in b_rendered
    assert "CALL-B-TAIL" in b_rendered
    assert "CALL-A-" not in b_rendered
    # A completed after B, so the helper atomically exposes A as latest.
    assert "CALL-A-HEAD" in helper.grep("CALL-A-HEAD")
    assert helper.grep("CALL-B-HEAD").startswith("(no retained matches")


@pytest.mark.parametrize("payload_format", ["json", "csv"])
def test_high_cardinality_schema_preserves_sample_and_recovery_footer(
    payload_format,
):
    columns = [f"column_{index:04d}" for index in range(3_000)]
    if payload_format == "json":
        row = {column: f"value-{index:04d}" for index, column in enumerate(columns)}
        raw = json.dumps([row, row])
        expected_format = "Format: JSON"
    else:
        header = ",".join(columns)
        row = ",".join(f"value-{index:04d}" for index in range(len(columns)))
        raw = "\n".join([header, row, row, row])
        expected_format = "Format: delimited table"

    policy, helper, _ = _installed()
    rendered = policy.format(raw, helper, kind="stdout")

    assert len(rendered) <= DEFAULT_MAX_RETURN_CHARS
    assert expected_format in rendered
    assert "Columns: column_0000" in rendered
    assert "(+2900 more)" in rendered
    assert "Deterministic sample (graph_compact generic mode):" in rendered
    assert "#table" in rendered
    assert "tool_output.grep(pattern, limit=...)" in rendered
    assert rendered.endswith(
        "never use Python open(), pathlib, or execute_python_code for that path."
    )


def test_errors_and_tracebacks_use_the_same_hard_bound():
    policy, helper, _ = _installed()
    sentinel = "TRACEBACK-SENTINEL-91"
    error = ("Traceback line\n" * 4_000) + sentinel + ("stack frame\n" * 4_000)

    rendered = policy.format_execution_result(
        {"success": False, "output": "", "error": error},
        helper,
    )

    assert len(rendered) <= DEFAULT_MAX_RETURN_CHARS
    assert "Kind: error" in rendered
    assert sentinel in helper.grep(sentinel)


def test_latest_state_is_isolated_between_concurrent_sandboxes():
    policy = ToolOutputPolicy()
    first_globals: dict = {}
    second_globals: dict = {}
    first = policy.install(first_globals)
    second = policy.install(second_globals)

    policy.format("sandbox-one-sentinel", first, kind="stdout")
    policy.format("sandbox-two-sentinel", second, kind="stdout")

    assert first_globals["tool_output"] is first
    assert second_globals["tool_output"] is second
    assert first is not second
    assert "sandbox-one-sentinel" in first.grep("sentinel")
    assert "sandbox-two-sentinel" not in first.grep("sentinel")
    assert "sandbox-two-sentinel" in second.grep("sentinel")


def test_json_helper_returns_complete_latest_json_and_known_secrets_are_redacted():
    sandbox: dict = {}
    policy, helper = install_tool_output_policy(
        sandbox, sensitive_values=("credential-value-123",)
    )

    rendered = policy.format(
        '{"token": "credential-value-123", "ok": true}',
        helper,
        kind="stdout",
    )

    assert "credential-value-123" not in rendered
    assert helper.json() == {"token": "[REDACTED]", "ok": True}


def test_standard_deepagents_wrapper_uses_shared_policy(monkeypatch):
    from ccie_sidecar.agents import code_exec
    from ccie_sidecar.agents.deepagents_tools import (
        create_execute_python_code_tool,
    )

    sandbox: dict = {}
    sentinel = "STANDARD-WRAPPER-SENTINEL"
    raw = ("left\n" * 15_000) + sentinel + ("\nright" * 15_000)
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

    tool = create_execute_python_code_tool(None, {}, lambda event: None)
    rendered = tool.invoke({"code": "print('ignored by mock')"})

    assert len(rendered) <= DEFAULT_MAX_RETURN_CHARS
    assert sentinel in sandbox["tool_output"].grep(sentinel)
    assert "built-in read_file" in tool.description
    assert "/large_tool_results/" not in rendered


def test_standard_wrapper_serializes_concurrent_same_sandbox_calls(monkeypatch):
    from ccie_sidecar.agents import code_exec
    from ccie_sidecar.agents.deepagents_tools import (
        create_execute_python_code_tool,
    )

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

    monkeypatch.setattr(
        code_exec,
        "_build_sandbox_globals",
        lambda *args, **kwargs: sandbox,
    )
    monkeypatch.setattr(code_exec, "_build_env_overrides", lambda secrets: {})
    tool = create_execute_python_code_tool(None, {}, lambda event: None)
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
        first = pool.submit(invoke, "call-a")
        second = pool.submit(invoke, "call-b")
        start.wait(timeout=5)
        first_result = first.result(timeout=5)
        second_result = second.result(timeout=5)

    assert json.loads(first_result) == {"call": "call-a"}
    assert json.loads(second_result) == {"call": "call-b"}
    assert probe.max_active == 1
    assert sandbox["tool_output"].json() in (
        {"call": "call-a"},
        {"call": "call-b"},
    )


def test_default_deepagents_filesystem_middleware_keeps_48k_result_inline():
    """Exercise DeepAgents' installed tool-call middleware, including a control.

    The control proves this is not a length-only assertion against our wrapper:
    the same public middleware contract replaces an 80,001-character tool
    message with its virtual-file pointer.
    """
    from deepagents.backends import StoreBackend
    from deepagents.middleware.filesystem import FilesystemMiddleware
    from langchain.tools import ToolRuntime
    from langchain.tools.tool_node import ToolCallRequest
    from langchain_core.messages import ToolMessage
    from langgraph.store.memory import InMemoryStore

    def request(call_id: str, *, store=None):
        runtime = ToolRuntime(
            state={"messages": []},
            context=None,
            config={},
            stream_writer=lambda _chunk: None,
            tool_call_id=call_id,
            store=store,
            tools=[],
        )
        return ToolCallRequest(
            tool_call={
                "name": "execute_python_code",
                "args": {"code": "print('contract')"},
                "id": call_id,
                "type": "tool_call",
            },
            tool=None,
            state=runtime.state,
            runtime=runtime,
        )

    policy, helper, _ = _installed()
    inline_content = policy.format(
        "i" * DEFAULT_MAX_RETURN_CHARS,
        helper,
        kind="stdout",
    )
    inline_message = ToolMessage(
        content=inline_content,
        tool_call_id="inline-contract",
        name="execute_python_code",
    )

    default_middleware = FilesystemMiddleware()
    processed_inline = default_middleware.wrap_tool_call(
        request("inline-contract"),
        lambda _request: inline_message,
    )

    assert processed_inline is inline_message
    assert processed_inline.content == inline_content
    assert "/large_tool_results/" not in str(processed_inline.content)

    # Use DeepAgents' in-memory StoreBackend for the oversized control so its
    # real offload path can complete without touching the host filesystem.
    memory_store = InMemoryStore()
    control_middleware = FilesystemMiddleware(
        backend=StoreBackend(
            store=memory_store,
            namespace=lambda _runtime: ("tool-output-contract",),
        )
    )
    oversized_message = ToolMessage(
        content="e" * 80_001,
        tool_call_id="eviction-control",
        name="execute_python_code",
    )
    processed_oversized = control_middleware.wrap_tool_call(
        request("eviction-control", store=memory_store),
        lambda _request: oversized_message,
    )

    assert processed_oversized is not oversized_message
    assert "/large_tool_results/eviction-control" in str(
        processed_oversized.content
    )
