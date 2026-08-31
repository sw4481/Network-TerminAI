"""Streaming bridge (Seam 2) — LangGraph astream → CCIE Terminal NDJSON events.

Maps LangGraph event payloads to our exact React/CodeExec event contract.
Handles the hardest sub-problem: drawio diagram events emitted from inside
the execute_python_code tool must reach on_event via custom stream.
"""
from __future__ import annotations

import json
from typing import Any, AsyncIterator, Callable, Optional, Protocol

from langchain_core.messages import AIMessage, ToolMessage
from langgraph.errors import GraphRecursionError

from ccie_sidecar.agents.model_recovery import classify_model_exception


def _input_ai_markers(input_data: dict[str, Any]) -> tuple[set[int], set[str]]:
    """Identify assistant messages that existed before this graph run started.

    Some LangGraph/middleware update shapes surface an input history message as
    part of a node delta. Those messages are context, never a new final answer.
    Track both object identity and LangChain message id so cloned state is safe.
    """
    object_ids: set[int] = set()
    message_ids: set[str] = set()
    messages = input_data.get("messages", []) if isinstance(input_data, dict) else []
    for message in messages or []:
        if not isinstance(message, AIMessage):
            continue
        object_ids.add(id(message))
        message_id = getattr(message, "id", None)
        if isinstance(message_id, str) and message_id:
            message_ids.add(message_id)
    return object_ids, message_ids


def _is_input_ai_replay(
    message: AIMessage,
    object_ids: set[int],
    message_ids: set[str],
) -> bool:
    """Return True only for an assistant message supplied as input history."""
    if id(message) in object_ids:
        return True
    message_id = getattr(message, "id", None)
    return isinstance(message_id, str) and message_id in message_ids


def _stream_text_from_payload(payload: Any) -> str:
    """Extract a user-visible text delta from a LangGraph messages payload."""
    message = payload[0] if isinstance(payload, (tuple, list)) and payload else payload
    if not isinstance(message, AIMessage):
        return ""

    content = message.content
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""

    chunks: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") not in {"text", "text_delta"}:
            continue
        text = block.get("text")
        if isinstance(text, str):
            chunks.append(text)
    return "".join(chunks)


def _extract_action_requests(interrupt_payload: Any) -> list[dict]:
    """Pull ActionRequest dicts out of an interrupt_on (__interrupt__) payload.

    The payload is a tuple/list of langgraph Interrupt objects; each `.value`
    is the HumanInterrupt dict with an `action_requests` list. We normalize to
    a flat list of {name, args, description} dicts.
    """
    requests: list[dict] = []
    items = interrupt_payload
    if isinstance(items, (tuple, list)):
        candidates = items
    else:
        candidates = [items]
    for it in candidates:
        value = getattr(it, "value", it)
        if isinstance(value, dict):
            for ar in value.get("action_requests", []) or []:
                if isinstance(ar, dict):
                    requests.append(ar)
        elif isinstance(value, (list, tuple)):
            for v in value:
                if isinstance(v, dict) and v.get("action_requests"):
                    requests.extend(
                        ar for ar in v["action_requests"] if isinstance(ar, dict)
                    )
    return requests


def _handle_interrupt(interrupt_payload, graph, config, thread_id, on_event) -> bool:
    """Emit an approval-request event for a paused (interrupt_on) graph and store
    it for resume. Returns True if an approval event was emitted.

    For iac_apply, classifies the blast radius (fresh terraform plan, falling
    back to parsed output, failing safe to "high") so the modal can preview it.
    """
    from ccie_sidecar.agents.deepagents_state import store_interrupted_graph

    action_requests = _extract_action_requests(interrupt_payload)
    zabbix_req = next((r for r in action_requests if r.get("name") == "zabbix_apply"), None)
    if zabbix_req is not None:
        args = zabbix_req.get("args", {}) or {}
        from ccie_sidecar.zabbix import _risk_for_method, redact_params
        method = str(args.get("method", "")); params = args.get("params", {})
        store_interrupted_graph(thread_id, graph, config, on_event)
        on_event({"type": "iac_approval_request", "thread_id": thread_id, "command": method,
                  "working_dir": "Zabbix JSON-RPC", "tool": "zabbix", "classification": {"tier": _risk_for_method(method) or "high", "params": redact_params(params), "rationale": args.get("rationale", "")}})
        return True
    terminal_req = next(
        (r for r in action_requests if r.get("name") == "terminal_apply_fix"),
        None,
    )
    if terminal_req is not None:
        from ccie_sidecar.agents.terminal_agent_tools import (
            TerminalGatewayClient,
            terminal_context_for_thread,
        )

        terminal_context = terminal_context_for_thread(thread_id)
        if terminal_context is None:
            on_event({
                "type": "error",
                "message": "Terminal fix approval lost its capability-scoped context.",
            })
            return True
        args = terminal_req.get("args", {}) or {}
        client = TerminalGatewayClient(terminal_context, on_event)
        try:
            preview = client.preview_fix(
                args.get("summary", ""),
                list(args.get("commands") or []),
                list(args.get("verification_commands") or []),
                list(args.get("rollback_commands") or []),
            )
        except Exception as error:
            on_event({
                "type": "error",
                "message": f"Terminal fix preview failed: {error}",
            })
            return True
        store_interrupted_graph(thread_id, graph, config, on_event)
        on_event({
            "type": "terminal_fix_approval_request",
            "thread_id": thread_id,
            "preview": preview,
        })
        return True

    iac_req = next((r for r in action_requests if r.get("name") == "iac_apply"), None)
    if iac_req is None:
        # Not an IaC approval we handle here; let the generic path/exception
        # handling deal with it.
        return False

    args = iac_req.get("args", {}) or {}
    working_dir = args.get("working_dir", "")
    command = args.get("command", "")
    tool = "ansible" if command.strip().startswith("ansible") else "terraform"

    classification: dict
    try:
        from ccie_sidecar.agents.iac_blast_radius import classify_iac
        from ccie_sidecar.agents.iac_git import current_git_branch

        classification = classify_iac(
            tool=tool,
            working_dir=working_dir,
            git_branch=current_git_branch(working_dir),
        )
    except Exception as e:  # noqa: BLE001 — never let classification block the gate
        classification = {"tier": "high", "source": "fail-safe", "note": str(e)}

    # Persist the graph so agent.react_resume can continue it.
    store_interrupted_graph(thread_id, graph, config, on_event)

    on_event({
        "type": "iac_approval_request",
        "thread_id": thread_id,
        "command": command,
        "working_dir": working_dir,
        "tool": tool,
        "classification": classification,
    })
    return True


def _parse_grader_result(content: str) -> Optional[dict]:
    """Parse a RubricMiddleware GraderResponse ToolMessage into a status dict.

    The content looks like:
      Returning structured response: result='satisfied' explanation='...'
      criteria=[{'name': 'X', 'passed': True}, {'name': 'Y', 'passed': False, 'gap': '...'}]

    Returns {verdict, explanation, criteria:[{name,passed,gap}], passed, total}
    or None if it doesn't look like a grader response.
    """
    if not content or "result=" not in content:
        return None
    import re
    import ast

    verdict_m = re.search(r"result=['\"](\w+)['\"]", content)
    if not verdict_m:
        return None
    verdict = verdict_m.group(1)

    explanation = ""
    exp_m = re.search(r"explanation=['\"](.*?)['\"]\s+criteria=", content, re.DOTALL)
    if exp_m:
        explanation = exp_m.group(1)

    criteria: list[dict] = []
    crit_m = re.search(r"criteria=(\[.*\])\s*$", content.strip(), re.DOTALL)
    if crit_m:
        try:
            parsed = ast.literal_eval(crit_m.group(1))
            if isinstance(parsed, list):
                for c in parsed:
                    if isinstance(c, dict) and "name" in c:
                        criteria.append({
                            "name": c.get("name"),
                            "passed": bool(c.get("passed")),
                            "gap": c.get("gap", ""),
                        })
        except Exception:
            pass

    total = len(criteria)
    passed = sum(1 for c in criteria if c["passed"])
    return {
        "verdict": verdict,
        "explanation": explanation,
        "criteria": criteria,
        "passed": passed,
        "total": total,
    }


def _grader_from_args(args: dict) -> Optional[dict]:
    """Build the grader status dict from a GraderResponse tool_call's args.

    The RubricMiddleware grader is a response_format tool, so its verdict
    (result/explanation/criteria) arrives as the tool_call ARGS — not a
    ToolMessage. Normalize to the same shape as _parse_grader_result.
    """
    if not isinstance(args, dict) or "result" not in args:
        return None
    verdict = str(args.get("result") or "")
    if not verdict:
        return None
    raw_criteria = args.get("criteria") or []
    criteria: list[dict] = []
    if isinstance(raw_criteria, list):
        for c in raw_criteria:
            if isinstance(c, dict) and "name" in c:
                criteria.append({
                    "name": c.get("name"),
                    "passed": bool(c.get("passed")),
                    "gap": c.get("gap", ""),
                })
    total = len(criteria)
    passed = sum(1 for c in criteria if c["passed"])
    return {
        "verdict": verdict,
        "explanation": args.get("explanation", "") or "",
        "criteria": criteria,
        "passed": passed,
        "total": total,
    }


def _format_grader_status(g: dict) -> str:
    """Human-readable one-liner + per-criterion lines for a parsed grader result."""
    verdict = g["verdict"]
    head = {
        "satisfied": "✓ Grading passed",
        "needs_revision": "↻ Grading: needs revision",
        "failed": "✗ Grading failed",
    }.get(verdict, f"Grading: {verdict}")
    if g["total"]:
        head += f" ({g['passed']}/{g['total']} criteria)"
    lines = [head]
    for c in g["criteria"]:
        mark = "✓" if c["passed"] else "✗"
        line = f"  {mark} {c['name']}"
        if not c["passed"] and c.get("gap"):
            line += f" — {c['gap']}"
        lines.append(line)
    return "\n".join(lines)


def _describe_tool_calls(tool_calls: list) -> str:
    """Build a human-readable step label when the model gives no reasoning text.

    Small/local models often call a tool with empty preamble content, which
    renders as a blank step in the UI. For execute_python_code we surface a
    short summary of the code (first comment, else first statement) so the user
    sees what the step is doing; for other tools we name the tool.
    """
    labels: list[str] = []
    for tc in tool_calls:
        name = tc.get("name", "tool")
        args = tc.get("args", {}) or {}
        if name == "execute_python_code" and isinstance(args, dict):
            code = (args.get("code") or "").strip()
            summary = ""
            for line in code.splitlines():
                line = line.strip()
                if not line:
                    continue
                # Prefer an explanatory comment, else the first real statement.
                summary = line.lstrip("# ").strip() if line.startswith("#") else line
                break
            if summary:
                if len(summary) > 80:
                    summary = summary[:77] + "..."
                labels.append(f"Running code: {summary}")
            else:
                labels.append("Running code")
        elif name == "write_todos":
            labels.append("Planning next steps")
        elif name == "GraderResponse":
            # The grader verdict rides in this tool_call's args. Fold the full
            # status + metrics into the STEP TEXT so it always renders (the
            # separate tool_result event isn't shown in every agent view).
            g = _grader_from_args(args)
            if g is not None:
                labels.append(_format_grader_status(g))
            else:
                labels.append("Grading response against the task rubric")
        else:
            labels.append(f"Calling {name}")
    return "; ".join(labels) if labels else "Working..."


# Protocol for compiled LangGraph/DeepAgents graphs
class CompiledGraph(Protocol):
    """Protocol for LangGraph CompiledStateGraph."""
    async def astream(self, input: Any, config: dict, *, stream_mode: list[str]) -> AsyncIterator[Any]:
        ...


async def run_and_stream(
    graph: CompiledGraph,
    input_data: Any,
    config: dict[str, Any],
    on_event: Callable[[dict], None],
    return_on_interrupt: bool = False,
    stream_output: bool = False,
    continue_on_step_limit: bool = False,
) -> dict[str, Any]:
    """
    Run a DeepAgents graph and stream events to our NDJSON contract.

    Consumes astream with stream_mode=["updates", "messages", "custom"] and maps:
    - AIMessage with tool_calls → thought_start + tool_call events
    - ToolMessage → tool_result events
    - custom events → pass-through (diagram events from drawio)
    - Final AIMessage text → final event
    - write_todos calls → thought_start (planning surfaces with no new Rust event)

    Args:
        graph: Compiled LangGraph/DeepAgents graph
        input_data: Input dict (e.g., {"messages": [user_message]})
        config: LangGraph config dict (thread_id, checkpointer, etc.)
        on_event: Callback to emit events in our NDJSON format

    Args (additional):
        return_on_interrupt: If True, return when graph interrupts instead of waiting
        stream_output: Emit top-level LLM text deltas as token events
        continue_on_step_limit: Preserve the checkpoint and offer continuation
            when a long run reaches its per-segment recursion limit.

    Returns:
        Structured execution outcome. Existing ``interrupted`` and
        ``thread_id`` keys are preserved alongside ``final_emitted``, ``steps``,
        ``error_kind``, ``error_type``, ``recovery_attempts``, and
        ``fallback_mode``.

    Events emitted to on_event:
        - thought_start: {"type": "thought_start", "thought": str, "step": int}
        - tool_call: {"type": "tool_call", "name": str, "args": dict, "blast_radius": str}
        - tool_result: {"type": "tool_result", "success": bool, "result": str}
        - diagram: {"type": "diagram", "title": str, "format": str, "xml": str | None,
                    "source": str | None, "url": str}
        - token: {"type": "token", "text": str} (only when stream_output is true)
        - final: {"type": "final", "response": str}
        - error: {"type": "error", "message": str}
    """
    step = 0
    final_text_seen = False
    interrupted = False
    thread_id = config.get("configurable", {}).get("thread_id", "default")
    error_kind: str | None = None
    error_type: str | None = None
    recovery_attempts = 0
    fallback_mode: str | None = None
    continuation_available = False
    tool_call_names: dict[str, str] = {}
    input_ai_object_ids, input_ai_message_ids = _input_ai_markers(input_data)

    try:
        # Stream with all three modes:
        # - "updates": per-node state deltas (new messages appended)
        # - "messages": token-level streaming (optional, for live display)
        # - "custom": custom events from tools (drawio diagram events)
        async for event in graph.astream(
            input_data,
            config,
            stream_mode=["updates", "messages", "custom"],
            # subgraphs=True surfaces events from nested graphs — specifically the
            # per-vendor specialist subagents the architect reaches via task().
            # Without it, a delegated vendor (e.g. cisco_xdr) shows only the single
            # "Calling task" step and none of the specialist's execute_python_code
            # steps, unlike inline vendors. See guard below: a subagent's own
            # "final" AIMessage must NOT be emitted as THE final, or it suppresses
            # the orchestrator's real answer (final_text_seen).
            subgraphs=True,
        ):
            # With subgraphs=True, items are (namespace, mode, payload); namespace
            # is a tuple of parent node ids — empty () for the top-level graph.
            # Tolerate the 2-tuple shape too (defensive, e.g. if subgraphs is off).
            namespace: tuple = ()
            if isinstance(event, tuple) and len(event) == 3:
                namespace, mode, payload = event
            elif isinstance(event, tuple) and len(event) == 2:
                mode, payload = event
            else:
                continue
            is_top_level = len(namespace) == 0

            # Handle custom events (drawio diagrams from inside execute_python_code)
            if mode == "custom":
                # Custom events are emitted by get_stream_writer() inside tools
                # drawio helper calls: emit({"type": "diagram", ...})
                if isinstance(payload, dict) and payload.get("type") == "diagram":
                    on_event(payload)
                continue

            if mode == "updates":
                # State delta from a node execution
                # Payload is {"node_name": {"messages": [new_messages]}}
                # Guard: payload or node_output can be None for some nodes
                # (e.g. interrupts, nodes that return None) — skip those.
                if not isinstance(payload, dict):
                    continue

                # interrupt_on (HumanInTheLoopMiddleware) surfaces a pause as
                # an "__interrupt__" key in the updates payload. Emit an
                # approval-request event (with blast-radius classification for
                # iac_apply), store the graph for resume, and stop streaming.
                if "__interrupt__" in payload:
                    emitted = _handle_interrupt(
                        payload["__interrupt__"], graph, config, thread_id, on_event
                    )
                    if emitted:
                        interrupted = True
                        return {
                            "interrupted": True,
                            "thread_id": thread_id,
                            "final_emitted": final_text_seen,
                            "steps": step,
                            "error_kind": None,
                            "error_type": None,
                            "recovery_attempts": recovery_attempts,
                            "fallback_mode": fallback_mode,
                        }
                    continue

                for node_name, node_output in payload.items():
                    if not isinstance(node_output, dict):
                        continue
                    messages = node_output.get("messages", []) or []

                    for msg in messages:
                        # AIMessage with tool_calls → thought_start + tool_call.
                        # These fire for BOTH the top-level orchestrator and nested
                        # specialist subagents (namespace != ()), so a delegated
                        # vendor's steps now stream just like an inline vendor's.
                        if isinstance(msg, AIMessage) and msg.tool_calls:
                            step += 1

                            # Synthesize thought_start (required by ai.rs:271)
                            # Extract reasoning from content if present
                            thought = ""
                            if msg.content:
                                if isinstance(msg.content, str):
                                    thought = msg.content
                                elif isinstance(msg.content, list):
                                    text_blocks = [b for b in msg.content if isinstance(b, dict) and b.get("type") == "text"]
                                    if text_blocks:
                                        thought = text_blocks[0].get("text", "")

                            # Whitespace-only reasoning (common with small models that
                            # just call the tool with no preamble) reads as a blank step
                            # in the UI. Fall back to a description of the action.
                            if not thought.strip():
                                thought = _describe_tool_calls(msg.tool_calls)
                            else:
                                thought = thought.strip()

                            on_event({
                                "type": "thought_start",
                                "thought": thought,
                                "step": step,
                            })

                            # Emit tool_call for each tool
                            for tool_call in msg.tool_calls:
                                tool_name = tool_call.get("name", "unknown")
                                tool_args = tool_call.get("args", {})
                                tool_call_id = tool_call.get("id")
                                if tool_call_id:
                                    tool_call_names[str(tool_call_id)] = tool_name

                                # The RubricMiddleware grader is a response_format
                                # tool: its verdict (result/criteria) arrives as the
                                # tool_call ARGS, not a ToolMessage. Emit the parsed
                                # status + metrics directly instead of a bare call.
                                if tool_name == "GraderResponse":
                                    g = _grader_from_args(tool_args)
                                    if g is not None:
                                        on_event({
                                            "type": "tool_result",
                                            "name": tool_name,
                                            "success": g["verdict"] != "failed",
                                            "result": _format_grader_status(g),
                                            "grader": g,
                                        })
                                        continue

                                # Extract blast_radius from tool metadata if available
                                # Default to "medium" for safety
                                blast_radius = "medium"

                                # Special cases:
                                if tool_name == "execute_python_code":
                                    # Code execution is classified by content in Phase 4
                                    # For now, default to "medium"
                                    blast_radius = "medium"
                                elif tool_name == "write_todos":
                                    # Planning tool is always low risk
                                    blast_radius = "low"

                                on_event({
                                    "type": "tool_call",
                                    "name": tool_name,
                                    "args": tool_args,
                                    "blast_radius": blast_radius,
                                })

                        # ToolMessage → tool_result
                        elif isinstance(msg, ToolMessage):
                            # ToolMessage.content is the tool output
                            result = msg.content if isinstance(msg.content, str) else str(msg.content)

                            # Check if tool execution succeeded
                            # LangChain ToolMessage has a status field (optional)
                            success = not hasattr(msg, "status") or msg.status != "error"

                            # Special-case the RubricMiddleware grader: parse its
                            # structured verdict into a readable status + metrics
                            # instead of surfacing the raw "Returning structured
                            # response: result=..." blob.
                            tool_call_id = getattr(msg, "tool_call_id", "") or ""
                            tool_name = (
                                getattr(msg, "name", "")
                                or tool_call_names.get(str(tool_call_id))
                                or "unknown"
                            )
                            grader = None
                            if tool_name == "GraderResponse" or "Returning structured response" in result:
                                grader = _parse_grader_result(result)
                            if grader is not None:
                                on_event({
                                    "type": "tool_result",
                                    "name": tool_name,
                                    "success": grader["verdict"] != "failed",
                                    "result": _format_grader_status(grader),
                                    "grader": grader,  # structured metrics for the UI
                                })
                            else:
                                on_event({
                                    "type": "tool_result",
                                    "name": tool_name,
                                    "success": success,
                                    "result": result,
                                })

                        # AIMessage with text and no tool_calls → potential final.
                        # IMPORTANT: only the TOP-LEVEL graph's terminal message is
                        # the user-facing answer. A specialist subagent (namespace
                        # != ()) also emits a final AIMessage when it finishes its
                        # task() — emitting THAT as `final` would set final_text_seen
                        # and suppress the orchestrator's real answer. So stream
                        # subagent finals as a normal tool_result-style step but
                        # reserve the `final` event for the top-level graph.
                        elif isinstance(msg, AIMessage) and msg.content and not msg.tool_calls:
                            if _is_input_ai_replay(
                                msg, input_ai_object_ids, input_ai_message_ids
                            ):
                                continue
                            # Extract text from content
                            final_text = ""
                            if isinstance(msg.content, str):
                                final_text = msg.content
                            elif isinstance(msg.content, list):
                                text_blocks = [b for b in msg.content if isinstance(b, dict) and b.get("type") == "text"]
                                if text_blocks:
                                    final_text = text_blocks[0].get("text", "")

                            if final_text and is_top_level:
                                # Only emit final once (avoid double-firing)
                                if not final_text_seen:
                                    final_text_seen = True
                                    on_event({
                                        "type": "final",
                                        "response": final_text,
                                    })

            elif mode == "messages":
                # LangGraph emits (message_chunk, metadata) for this mode. Only
                # top-level model output belongs in the main chat transcript;
                # specialist subagent chunks stay represented by their normal
                # tool lifecycle events.
                if stream_output and is_top_level:
                    text = _stream_text_from_payload(payload)
                    if text:
                        on_event({"type": "token", "text": text})

    except GraphRecursionError as e:
        # LangGraph's recursion limit is a superstep budget, not proof of a
        # repeated action. Long, legitimate Architect runs can reach it while
        # still making progress. When the caller enabled continuation, retain
        # the compiled DeepAgents graph and its exact checkpoint so the next
        # invocation advances from the next pending node with no prompt replay.
        import sys
        import traceback
        print(f"[run_and_stream] GraphRecursionError:\n{traceback.format_exc()}", file=sys.stderr)

        if continue_on_step_limit:
            from ccie_sidecar.agents.deepagents_state import store_interrupted_graph

            store_interrupted_graph(thread_id, graph, config, on_event)
            continuation_available = True
            on_event({
                "type": "continuation_available",
                "thread_id": thread_id,
                "reason": "step_limit",
            })
            message = (
                "This run reached its safety step checkpoint while it was still "
                "working. Its exact DeepAgents progress was preserved. Select "
                "Continue from last step to resume without replaying completed work."
            )
        else:
            message = (
                "I got stuck repeating steps and stopped before finishing "
                "(hit the safety step limit). This usually means I kept "
                "inspecting or retrying instead of completing the task. No live "
                "result was returned. Retry the request; if it repeats, check "
                "the selected platform's API configuration and catalog match."
            )
        on_event({
            "type": "error",
            "message": message,
            "kind": "step_limit",
            "error_type": type(e).__name__,
        })
        error_kind = "step_limit"
        error_type = type(e).__name__

    except Exception as e:
        # Check if this is an interrupt exception
        if "interrupt" in str(e).lower() or return_on_interrupt:
            # Graph was interrupted, return control
            interrupted = True
        else:
            # Never emit a blank error — some exceptions (e.g. NotImplementedError)
            # have an empty str(), which surfaces as "DeepAgents runtime error: "
            # and looks like a silent hang. Always include the type, and log the
            # full traceback to stderr for diagnosis.
            import sys
            import traceback
            detail = str(e) or repr(e)
            tb = traceback.format_exc()
            print(f"[run_and_stream] EXCEPTION:\n{tb}", file=sys.stderr)
            error_kind = (
                getattr(e, "error_kind", None)
                or classify_model_exception(e)
            )
            error_type = getattr(e, "final_error_type", type(e).__name__)
            recovery_attempts = int(getattr(e, "recovery_attempts", 0) or 0)
            fallback_mode = getattr(e, "fallback_mode", None)
            on_event({
                "type": "error",
                "message": f"DeepAgents runtime error: {type(e).__name__}: {detail}",
                "kind": error_kind,
                "error_type": error_type,
                "recovery_attempts": recovery_attempts,
                "fallback_mode": fallback_mode,
                "initial_error_type": getattr(e, "first_error_type", None),
                "fallback_error_type": getattr(e, "fallback_error_type", None),
            })

    outcome = {
        "interrupted": interrupted,
        "thread_id": thread_id,
        "final_emitted": final_text_seen,
        "steps": step,
        "error_kind": error_kind,
        "error_type": error_type,
        "recovery_attempts": recovery_attempts,
        "fallback_mode": fallback_mode,
    }
    if continuation_available:
        outcome["continuation_available"] = True
    return outcome


async def run_and_stream_code_exec(
    graph: CompiledGraph,
    input_data: dict[str, Any],
    config: dict[str, Any],
    on_event: Callable[[dict], None],
) -> None:
    """
    Run a code-exec DeepAgents graph and stream CodeExecEvent-compatible events.

    Maps to the CodeExecEvent contract:
    - code_start: {"type": "code_start", "code": str}
    - code_executing: {"type": "code_executing"}
    - code_result: {"type": "code_result", "success": bool, "output": str}
    - code_error: {"type": "code_error", "error": str, "attempt": int}
    - diagram: {"type": "diagram", ...}
    - final: {"type": "final", "response": str}
    - error: {"type": "error", "message": str}

    Args:
        graph: Compiled LangGraph/DeepAgents graph
        input_data: Input dict (e.g., {"messages": [user_message]})
        config: LangGraph config dict
        on_event: Callback to emit events
    """
    attempt = 0
    final_text_seen = False
    input_ai_object_ids, input_ai_message_ids = _input_ai_markers(input_data)

    try:
        async for event in graph.astream(
            input_data,
            config,
            stream_mode=["updates", "messages", "custom"],
        ):
            if isinstance(event, tuple) and len(event) == 2:
                mode, payload = event

                # Custom events (diagrams)
                if mode == "custom":
                    if isinstance(payload, dict) and payload.get("type") == "diagram":
                        on_event(payload)
                    continue

                if mode == "updates":
                    if not isinstance(payload, dict):
                        continue
                    for node_name, node_output in payload.items():
                        if not isinstance(node_output, dict):
                            continue
                        messages = node_output.get("messages", []) or []

                        for msg in messages:
                            # AIMessage with execute_python_code tool call → code_start
                            if isinstance(msg, AIMessage) and msg.tool_calls:
                                for tool_call in msg.tool_calls:
                                    tc_name = tool_call.get("name")
                                    if tc_name == "execute_python_code":
                                        code = tool_call.get("args", {}).get("code", "")
                                        on_event({"type": "code_start", "code": code})
                                        on_event({"type": "code_executing"})
                                    elif tc_name == "GraderResponse":
                                        # The grader verdict rides in this tool_call's
                                        # ARGS (response_format tool). Fold the full
                                        # status + metrics into the STEP TEXT so it
                                        # always renders, and also emit a structured
                                        # code_result for richer UIs.
                                        g = _grader_from_args(tool_call.get("args", {}))
                                        thought = (
                                            _format_grader_status(g) if g is not None
                                            else "Grading response against the task rubric"
                                        )
                                        on_event({
                                            "type": "thought_start",
                                            "thought": thought,
                                            "step": attempt + 1,
                                        })
                                        if g is not None:
                                            on_event({
                                                "type": "code_result",
                                                "success": g["verdict"] != "failed",
                                                "output": _format_grader_status(g),
                                                "grader": g,
                                            })

                            # ToolMessage → code_result / code_error / grader status
                            elif isinstance(msg, ToolMessage):
                                result = msg.content if isinstance(msg.content, str) else str(msg.content)

                                # RubricMiddleware grader verdict → clean status + metrics
                                tool_name = getattr(msg, "name", "") or ""
                                grader = None
                                if tool_name == "GraderResponse" or "Returning structured response" in result:
                                    grader = _parse_grader_result(result)

                                if grader is not None:
                                    on_event({
                                        "type": "code_result",
                                        "success": grader["verdict"] != "failed",
                                        "output": _format_grader_status(grader),
                                        "grader": grader,  # structured metrics for the UI
                                    })
                                elif result.startswith("Error:"):
                                    attempt += 1
                                    on_event({
                                        "type": "code_error",
                                        "error": result,
                                        "attempt": attempt,
                                    })
                                else:
                                    on_event({
                                        "type": "code_result",
                                        "success": True,
                                        "output": result,
                                    })

                            # Final response
                            elif isinstance(msg, AIMessage) and msg.content and not msg.tool_calls:
                                if _is_input_ai_replay(
                                    msg, input_ai_object_ids, input_ai_message_ids
                                ):
                                    continue
                                final_text = ""
                                if isinstance(msg.content, str):
                                    final_text = msg.content
                                elif isinstance(msg.content, list):
                                    text_blocks = [b for b in msg.content if isinstance(b, dict) and b.get("type") == "text"]
                                    if text_blocks:
                                        final_text = text_blocks[0].get("text", "")

                                if final_text and not final_text_seen:
                                    final_text_seen = True
                                    on_event({
                                        "type": "final",
                                        "response": final_text,
                                    })

    except Exception as e:
        on_event({
            "type": "error",
            "message": f"Code execution error: {str(e)}",
        })
