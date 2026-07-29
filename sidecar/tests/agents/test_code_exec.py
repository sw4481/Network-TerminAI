import pytest
from ccie_sidecar.agents.code_exec import (
    _build_sandbox_globals,
    _execute_code_with_timeout,
    code_exec_loop,
    MAX_RETRY_ATTEMPTS,
)
import time


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
