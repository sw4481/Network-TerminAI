"""DeepAgents middleware: repair malformed tool-call arguments.

Some OpenAI-compatible providers (notably NVIDIA NIM / Nemotron and other
local models) occasionally emit tool-call ``arguments`` that are not strict
JSON — e.g. ``155503{"code": "..."}``. LangChain routes these into
``AIMessage.invalid_tool_calls`` and re-sends the raw string verbatim on the
next turn. The provider then fails to ``json.loads`` the request body and
rejects the whole conversation with::

    400 - {'message': 'Extra data: line 1 column N (char M)', ...}

That kills any multi-round flow (the malformed assistant turn poisons the
replayed history). This middleware runs before each model call and rewrites any
``invalid_tool_calls`` into well-formed ``tool_calls`` with a best-effort parse
of the embedded JSON object, keeping ``additional_kwargs`` consistent so the
OpenAI message serializer emits valid JSON regardless of which field it reads.
"""
from __future__ import annotations

import json
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage


def _repair_to_obj(raw: Any) -> dict[str, Any]:
    """Best-effort: turn a possibly-malformed args value into a dict.

    Strategy:
      1. Already a dict → return as-is.
      2. Valid JSON string → parse it.
      3. Otherwise extract the first balanced ``{...}`` span and parse that
         (handles leading/trailing garbage like ``155503{...}`` or ``{...}\n``).
      4. Give up → empty dict (safe: the tool sees no args rather than crashing
         the whole request).
    """
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:  # noqa: BLE001
        pass

    start = raw.find("{")
    if start != -1:
        depth = 0
        for i in range(start, len(raw)):
            ch = raw[i]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        parsed = json.loads(raw[start : i + 1])
                        return parsed if isinstance(parsed, dict) else {}
                    except Exception:  # noqa: BLE001
                        break
    return {}


def _sanitize_message(msg: AIMessage) -> bool:
    """Repair one AIMessage in place. Returns True if anything changed."""
    invalid = getattr(msg, "invalid_tool_calls", None) or []
    if not invalid:
        return False

    for itc in invalid:
        obj = _repair_to_obj(itc.get("args"))
        msg.tool_calls.append(
            {
                "name": itc.get("name") or "execute_python_code",
                "args": obj,
                "id": itc.get("id"),
                "type": "tool_call",
            }
        )
    msg.invalid_tool_calls = []

    # Keep the raw provider copy consistent — the OpenAI serializer falls back
    # to additional_kwargs.tool_calls when the typed attrs are empty.
    ak_tcs = msg.additional_kwargs.get("tool_calls")
    if ak_tcs:
        for tc in ak_tcs:
            fn = tc.get("function")
            if isinstance(fn, dict):
                fn["arguments"] = json.dumps(_repair_to_obj(fn.get("arguments")))
    return True


class ToolCallSanitizerMiddleware(AgentMiddleware):
    """Repairs malformed tool-call arguments before every model call."""

    name = "ToolCallSanitizer"

    def before_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:  # noqa: ANN401
        messages = state.get("messages") if isinstance(state, dict) else None
        if not messages:
            return None
        changed = [m for m in messages if isinstance(m, AIMessage) and _sanitize_message(m)]
        if not changed:
            return None
        # Messages are mutated in place; returning them via the add_messages
        # reducer (which replaces by id) makes the repair explicit/durable.
        return {"messages": changed}


# create_deep_agent always injects FilesystemMiddleware, whose ls/read_file/etc.
# operate on a VIRTUAL, empty filesystem by default. A model that tries to
# explore a real project gets empty results and loops ("Calling ls" forever).
# The IaC agent does its real work through execute_python_code (real subprocess)
# and iac_apply, so these virtual fs tools are pure footguns — strip them.
_BUILTIN_FS_TOOLS = frozenset(
    {"ls", "read_file", "write_file", "edit_file", "glob", "grep", "execute"}
)

# Unattended API checks have a deliberately tiny action surface. DeepAgents
# injects planning, delegation, and virtual-filesystem tools automatically;
# those tools cannot help a focused live-state lookup and give small models
# several tempting ways to spend their entire step budget without making an API
# call. Use an allow-list here so future DeepAgents built-ins do not silently
# expand the heartbeat tool surface.
_FOCUSED_API_TOOLS = frozenset(
    {"search_api_catalog", "execute_python_code"}
)


class HideBuiltinFsToolsMiddleware(AgentMiddleware):
    """Remove deepagents' built-in (virtual) filesystem tools from each model
    call so the model can't loop on an empty virtual FS. Keeps execute_python_code,
    iac_apply, write_todos, and any other real tools."""

    name = "HideBuiltinFsTools"

    def wrap_model_call(self, request, handler):  # noqa: ANN001
        tools = getattr(request, "tools", None)
        if tools:
            filtered = [t for t in tools if getattr(t, "name", None) not in _BUILTIN_FS_TOOLS]
            if len(filtered) != len(tools):
                request = request.override(tools=filtered)
        return handler(request)

    async def awrap_model_call(self, request, handler):  # noqa: ANN001
        tools = getattr(request, "tools", None)
        if tools:
            filtered = [t for t in tools if getattr(t, "name", None) not in _BUILTIN_FS_TOOLS]
            if len(filtered) != len(tools):
                request = request.override(tools=filtered)
        return await handler(request)


class FocusedApiToolsMiddleware(AgentMiddleware):
    """Expose only grounded catalog search and sandbox execution.

    This is used by unattended heartbeat runs, where planning, delegation, and
    virtual filesystem exploration are counterproductive. It filters only the
    model-visible tool list; the two retained tools keep their normal runtime
    implementations and catalog enforcement.
    """

    name = "FocusedApiTools"

    def wrap_model_call(self, request, handler):  # noqa: ANN001
        tools = getattr(request, "tools", None)
        if tools:
            filtered = [
                tool for tool in tools
                if getattr(tool, "name", None) in _FOCUSED_API_TOOLS
            ]
            if len(filtered) != len(tools):
                request = request.override(tools=filtered)
        return handler(request)

    async def awrap_model_call(self, request, handler):  # noqa: ANN001
        tools = getattr(request, "tools", None)
        if tools:
            filtered = [
                tool for tool in tools
                if getattr(tool, "name", None) in _FOCUSED_API_TOOLS
            ]
            if len(filtered) != len(tools):
                request = request.override(tools=filtered)
        return await handler(request)
