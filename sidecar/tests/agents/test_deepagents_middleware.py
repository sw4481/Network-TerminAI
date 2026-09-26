"""Tests for ToolCallSanitizerMiddleware — the NVIDIA/Nemotron 400 guard.

Regression: providers occasionally emit tool-call arguments that are not strict
JSON (e.g. ``155503{"code": "..."}``). LangChain stores them in
``invalid_tool_calls`` and re-sends the raw string, which the OpenAI-compatible
endpoint rejects with ``400 Extra data: line 1 column N (char M)``, killing the
whole multi-round run.
"""
from __future__ import annotations

import json

from langchain_core.messages import AIMessage, HumanMessage
from langchain_openai.chat_models.base import _convert_message_to_dict

from ccie_sidecar.agents.deepagents_middleware import (
    FocusedApiToolsMiddleware,
    ToolCallSanitizerMiddleware,
    HideBuiltinFsToolsMiddleware,
    _repair_to_obj,
)
from langchain_core.messages import ToolMessage
from langchain_core.tools import StructuredTool


def _tool(name: str) -> StructuredTool:
    return StructuredTool.from_function(func=lambda x="": "ok", name=name, description="d")


class _FakeModelRequest:
    """Minimal stand-in for langchain's ModelRequest (tools + override)."""

    def __init__(self, tools):
        self.tools = tools

    def override(self, **overrides):
        if "tools" in overrides:
            self.tools = overrides["tools"]
        return self


def test_hide_builtin_fs_tools_strips_virtual_fs_tools():
    """The IaC agent must not see deepagents' built-in (virtual) fs tools — they
    cause the 'Calling ls' loop on an empty virtual filesystem."""
    req = _FakeModelRequest([
        _tool("ls"), _tool("read_file"), _tool("write_file"), _tool("edit_file"),
        _tool("glob"), _tool("grep"), _tool("execute"),
        _tool("execute_python_code"), _tool("iac_apply"), _tool("write_todos"),
    ])
    captured = {}

    def handler(r):
        captured["names"] = [t.name for t in r.tools]
        return "result"

    HideBuiltinFsToolsMiddleware().wrap_model_call(req, handler)
    assert captured["names"] == ["execute_python_code", "iac_apply", "write_todos"]


def test_hide_builtin_fs_tools_noop_when_none_present():
    req = _FakeModelRequest([_tool("execute_python_code"), _tool("iac_apply")])
    captured = {}

    def handler(r):
        captured["names"] = [t.name for t in r.tools]
        return "result"

    HideBuiltinFsToolsMiddleware().wrap_model_call(req, handler)
    assert captured["names"] == ["execute_python_code", "iac_apply"]


def test_focused_api_tools_exposes_only_catalog_search_and_code_execution():
    req = _FakeModelRequest([
        _tool("ls"), _tool("read_file"), _tool("write_todos"), _tool("task"),
        _tool("execute"), _tool("search_api_catalog"),
        _tool("execute_python_code"),
    ])
    captured = {}

    def handler(r):
        captured["names"] = [t.name for t in r.tools]
        return "result"

    FocusedApiToolsMiddleware().wrap_model_call(req, handler)
    assert captured["names"] == ["search_api_catalog", "execute_python_code"]


def _malformed_ai_message() -> AIMessage:
    """Build an AIMessage exactly as LangChain stores a malformed tool call."""
    return AIMessage(
        content="",
        additional_kwargs={
            "tool_calls": [
                {
                    "id": "call_bad1",
                    "type": "function",
                    "function": {
                        "name": "execute_python_code",
                        # leading integer makes this invalid JSON
                        "arguments": '155503{"code": "print(1)"}',
                    },
                }
            ]
        },
    )


def test_repair_to_obj_extracts_embedded_json():
    assert _repair_to_obj('155503{"code": "print(1)"}') == {"code": "print(1)"}
    assert _repair_to_obj('{"code": "x"}\n\n') == {"code": "x"}
    assert _repair_to_obj('{"code": "x"}') == {"code": "x"}
    assert _repair_to_obj({"code": "x"}) == {"code": "x"}


def test_repair_to_obj_gives_up_safely():
    # No salvageable object → empty dict, never raises.
    assert _repair_to_obj("not json at all") == {}
    assert _repair_to_obj(None) == {}
    assert _repair_to_obj("12345") == {}


def test_malformed_message_serializes_to_invalid_json_without_fix():
    """Guard the assumption: an unrepaired message produces non-JSON arguments."""
    msg = _malformed_ai_message()
    # LangChain parks the bad string in invalid_tool_calls at construction.
    assert msg.invalid_tool_calls
    assert not msg.tool_calls

    wire = _convert_message_to_dict(msg)
    raw_args = wire["tool_calls"][0]["function"]["arguments"]
    # This is exactly what the server chokes on.
    try:
        json.loads(raw_args)
        parsed_ok = True
    except json.JSONDecodeError:
        parsed_ok = False
    assert parsed_ok is False


def test_middleware_repairs_to_valid_wire_json():
    msg = _malformed_ai_message()
    state = {"messages": [HumanMessage(content="hi"), msg]}

    result = ToolCallSanitizerMiddleware().before_model(state, runtime=None)

    # The repaired message is returned for the state reducer.
    assert result is not None
    assert msg in result["messages"]

    # invalid_tool_calls drained into well-formed tool_calls
    assert not msg.invalid_tool_calls
    assert msg.tool_calls
    assert msg.tool_calls[0]["args"] == {"code": "print(1)"}

    # And the on-the-wire arguments now parse as JSON.
    wire = _convert_message_to_dict(msg)
    raw_args = wire["tool_calls"][0]["function"]["arguments"]
    assert json.loads(raw_args) == {"code": "print(1)"}


def test_middleware_noop_when_no_messages():
    assert ToolCallSanitizerMiddleware().before_model({"messages": []}, None) is None
    assert ToolCallSanitizerMiddleware().before_model({}, None) is None


def test_middleware_noop_when_already_valid():
    good = AIMessage(
        content="",
        tool_calls=[
            {"name": "execute_python_code", "args": {"code": "1"}, "id": "ok", "type": "tool_call"}
        ],
    )
    # Nothing to repair → no state update.
    assert ToolCallSanitizerMiddleware().before_model({"messages": [good]}, None) is None
