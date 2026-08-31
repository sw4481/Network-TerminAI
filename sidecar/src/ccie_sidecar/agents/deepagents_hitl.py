"""HITL (Human-in-the-Loop) approval for DeepAgents — Seam 3.

Implements blast radius → interrupt gating, tool_approval_request emission,
and graph resume logic via Command(resume=...).
"""
from __future__ import annotations

import re
from typing import Any, Callable


# Blast radius tiers (standardized across codebase)
BLAST_RADIUS_TIERS = ["low", "medium", "high", "destructive"]


def tier_for_tool(
    tool_name: str,
    tool_args: dict[str, Any],
    tool_metadata: dict[str, Any],
) -> str:
    """
    Determine blast radius tier for a tool call.

    Args:
        tool_name: Tool name (e.g., "execute_python_code", "meraki_networks_update")
        tool_args: Tool arguments from LLM
        tool_metadata: Tool metadata (includes blast_radius if available)

    Returns:
        Blast radius tier: "low" | "medium" | "high" | "destructive"
    """
    # Check tool metadata first (for Meraki tools)
    if "blast_radius" in tool_metadata:
        return tool_metadata["blast_radius"]

    # Special case: execute_python_code
    # Classify based on code content (Phase 4 heuristic)
    if tool_name == "execute_python_code":
        code = tool_args.get("code", "")
        return classify_code_blast_radius(code)

    # Planning tools are always low risk
    if tool_name in ("write_todos", "read_todos", "update_todo", "delete_todo"):
        return "low"

    # Default to medium for unknown tools
    return "medium"


def classify_code_blast_radius(code: str) -> str:
    """
    Classify Python code by blast radius using heuristics.

    Args:
        code: Python code string

    Returns:
        Blast radius tier: "low" | "medium" | "high" | "destructive"

    Heuristics:
    - Destructive: os.remove, shutil.rmtree, subprocess with shell=True, DELETE/DROP SQL
    - High: File writes, network requests with POST/PUT/DELETE, CREATE/ALTER/UPDATE SQL
    - Medium: File reads, GET requests, SELECT queries
    - Low: Pure computation, print statements, data analysis
    """
    code_lower = code.lower()

    # Destructive operations
    destructive_patterns = [
        r"\bos\.remove\b",
        r"\bos\.unlink\b",
        r"\bshutil\.rmtree\b",
        r"\bsubprocess\.(call|run|Popen).*shell\s*=\s*True",
        r"\b(DELETE|DROP)\s+",  # SQL delete/drop
        r"\bos\.system\b",
        r"\beval\s*\(",
        r"\bexec\s*\(",
    ]
    for pattern in destructive_patterns:
        if re.search(pattern, code, re.IGNORECASE):
            return "destructive"

    # High-risk operations
    high_patterns = [
        r"\bopen\s*\(.*['\"]w['\"]",  # File write
        r"\.write\s*\(",
        r"\.to_csv\s*\(",
        r"\.to_json\s*\(",
        r"\brequests\.(post|put|delete|patch)\b",
        r"\b(CREATE|ALTER|UPDATE|INSERT)\s+",  # SQL mutations
        r"\bcursor\.execute.*\b(UPDATE|INSERT|DELETE)",
    ]
    for pattern in high_patterns:
        if re.search(pattern, code, re.IGNORECASE):
            return "high"

    # Medium-risk operations
    medium_patterns = [
        r"\bopen\s*\(.*['\"]r['\"]",  # File read
        r"\.read\s*\(",
        r"\brequests\.get\b",
        r"\bSELECT\s+",  # SQL read
        r"\bimport\s+requests",
        r"\bimport\s+urllib",
    ]
    for pattern in medium_patterns:
        if re.search(pattern, code, re.IGNORECASE):
            return "medium"

    # Default: low risk (pure computation)
    return "low"


def is_tier_allowed(tier: str, default_allowed: str) -> bool:
    """
    Check if a tier is allowed given the default allowed level.

    Args:
        tier: Tool's blast radius tier
        default_allowed: Default allowed tier from agent config

    Returns:
        True if tier is allowed (at or below default_allowed)

    Examples:
        >>> is_tier_allowed("low", "medium")
        True
        >>> is_tier_allowed("high", "medium")
        False
        >>> is_tier_allowed("medium", "medium")
        True
    """
    try:
        tier_idx = BLAST_RADIUS_TIERS.index(tier)
        allowed_idx = BLAST_RADIUS_TIERS.index(default_allowed)
        return tier_idx <= allowed_idx
    except ValueError:
        # Unknown tier, default to not allowed
        return False


def should_interrupt(tier: str, default_allowed: str) -> bool:
    """
    Determine if tool execution should be interrupted for approval.

    Args:
        tier: Tool's blast radius tier
        default_allowed: Default allowed tier from agent config

    Returns:
        True if tool should be interrupted (requires approval)
    """
    return not is_tier_allowed(tier, default_allowed)


def build_approval_request(
    tool_name: str,
    tool_args: dict[str, Any],
    blast_radius: str,
) -> dict[str, Any]:
    """
    Build a tool_approval_request event for the frontend.

    Args:
        tool_name: Tool name
        tool_args: Tool arguments
        blast_radius: Blast radius tier

    Returns:
        Event dict for tool_approval_request
    """
    return {
        "type": "tool_approval_request",
        "tool_name": tool_name,
        "tool_args": tool_args,
        "blast_radius": blast_radius,
    }


async def resume_graph(
    graph: Any,
    thread_id: str,
    decision: str,
    on_event: Callable[[dict], None],
    edited_action: dict[str, Any] | None = None,
    stream_output: bool = False,
) -> dict[str, Any]:
    """
    Resume an interrupted LangGraph with approval decision.

    Args:
        graph: Compiled LangGraph/DeepAgents graph
        thread_id: Thread ID for checkpointer
        decision: "approve" | "deny" | "edit"
        edited_action: Exact reviewed tool name and arguments for an edit decision
        on_event: Event callback
        stream_output: Emit top-level model text chunks while resuming

    Emits events as graph resumes execution.
    """
    from langgraph.types import Command

    # Build resume command. interrupt_on uses HumanInTheLoopMiddleware, which
    # consumes interrupt(...)["decisions"] — a list of decision dicts, one per
    # action_request. We gate a single iac_apply, so one decision suffices.
    if decision == "approve":
        resume_value = {"decisions": [{"type": "approve"}]}
    elif decision == "edit":
        if not isinstance(edited_action, dict):
            raise ValueError("edit decision requires edited_action")
        resume_value = {
            "decisions": [{"type": "edit", "edited_action": edited_action}]
        }
    else:
        resume_value = {
            "decisions": [
                {"type": "reject", "message": "User denied the proposed action."}
            ]
        }

    # Resume the graph
    try:
        from ccie_sidecar.agents.deepagents_stream import run_and_stream

        # Resume by sending Command to the graph
        # LangGraph will continue from the interrupt point
        config = {"configurable": {"thread_id": thread_id}}

        return await run_and_stream(
            graph=graph,
            input_data=Command(resume=resume_value),
            config=config,
            on_event=on_event,
            stream_output=stream_output,
        )

    except Exception as e:
        on_event({
            "type": "error",
            "message": f"Resume error: {str(e)}",
        })
        raise


async def continue_graph(
    graph: Any,
    config: dict[str, Any],
    on_event: Callable[[dict], None],
    stream_output: bool = False,
) -> dict[str, Any]:
    """Advance a checkpointed DeepAgents graph without adding new input.

    Passing ``None`` is LangGraph's checkpoint continuation contract. It runs
    the next pending node instead of appending a user message or replaying the
    original request. A second segment boundary is preserved the same way.
    """
    from ccie_sidecar.agents.deepagents_stream import run_and_stream

    return await run_and_stream(
        graph=graph,
        input_data=None,
        config=config,
        on_event=on_event,
        stream_output=stream_output,
        continue_on_step_limit=True,
    )


def log_tool_call(
    tool_name: str,
    tool_args: dict[str, Any],
    approval_status: str,
    conversation_id: str | None = None,
    db_conn: Any = None,
) -> None:
    """
    Log tool call to audit database.

    Args:
        tool_name: Tool name
        tool_args: Tool arguments
        approval_status: "auto" | "approved" | "denied"
        conversation_id: Conversation ID (optional)
        db_conn: Database connection (optional)

    Note: Reuses existing approval logging infrastructure.
    """
    if db_conn is None:
        # No database configured, skip logging
        return

    try:
        # Log to tool_approvals table (matches legacy structure)
        import json
        import time

        cursor = db_conn.cursor()
        cursor.execute(
            """
            INSERT INTO tool_approvals (
                conversation_id,
                tool_name,
                tool_args,
                blast_radius,
                approval_status,
                timestamp
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                conversation_id or "unknown",
                tool_name,
                json.dumps(tool_args),
                tier_for_tool(tool_name, tool_args, {}),
                approval_status,
                int(time.time()),
            ),
        )
        db_conn.commit()
    except Exception as e:
        # Don't fail on logging errors
        print(f"Failed to log tool call: {e}")
