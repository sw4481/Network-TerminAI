"""
Approval and blast-radius gating for ReACT tool execution.

This module provides:
1. Blast-radius tier comparison and gating logic
2. Approval request handling (pause/resume)
3. Audit logging for all tool calls
4. Session-based approval tracking

Phase 5: Safety gates and audit trail
"""

import json
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Optional


@dataclass
class ApprovalResult:
    """Result of an approval request."""
    granted: bool
    mode: str  # "auto" | "approved" | "approved_session" | "denied"


def is_tier_allowed(
    tier: str,
    default_allowed: str
) -> bool:
    """
    Check if tier is within default allowed blast radius.

    Ordering: low < medium < high < destructive

    Args:
        tier: Tool's blast radius tier
        default_allowed: Maximum tier allowed by default (from agent config)

    Returns:
        True if tier is at or below default_allowed threshold

    Examples:
        >>> is_tier_allowed("low", "medium")
        True
        >>> is_tier_allowed("high", "medium")
        False
        >>> is_tier_allowed("destructive", "high")
        False
    """
    tiers = ["low", "medium", "high", "destructive"]

    # Handle invalid tier values gracefully
    tier_idx = tiers.index(tier) if tier in tiers else 999
    allowed_idx = tiers.index(default_allowed) if default_allowed in tiers else -1

    return tier_idx <= allowed_idx


async def request_approval(
    tool_spec: Dict[str, Any],
    args: Dict[str, Any],
    tier: str,
    conversation_id: str,
    on_event: Callable
) -> ApprovalResult:
    """
    Request user approval for tool execution.

    Emits tool_approval_request event and pauses until response.

    Args:
        tool_spec: Tool specification from catalog
        args: Tool arguments
        tier: Blast radius tier
        conversation_id: Current conversation ID
        on_event: Event emission callback

    Returns:
        ApprovalResult indicating whether approval was granted

    Note:
        In the real implementation, this would pause and wait for react_resume.
        For now, it returns pending (handled by react_resume in the loop).
    """
    pending_id = str(uuid.uuid4())

    # Build human-readable description
    tool_name = tool_spec.get('name', 'unknown')
    description = tool_spec.get('description', 'No description')
    endpoint = tool_spec.get('endpoint', {})

    # Emit approval request event
    on_event({
        'type': 'tool_approval_request',
        'pending_id': pending_id,
        'tool_name': tool_name,
        'description': description,
        'endpoint': endpoint,
        'args': args,
        'blast_radius': tier
    })

    # In real implementation, this would pause and wait for react_resume
    # For now, return pending (will be handled by react_resume)
    return ApprovalResult(granted=False, mode='pending')


def log_tool_call(
    conversation_id: Optional[str],
    agent_id: str,
    tool_name: str,
    method: str,
    path: str,
    args: Dict[str, Any],
    blast_radius: str,
    approval_status: str,
    result: Dict[str, Any],
    duration_ms: int,
    db_conn
) -> None:
    """
    Log tool call to audit table.

    Records: what tool, what params, approval status, result summary.

    Args:
        conversation_id: Conversation identifier (may be None for standalone calls)
        agent_id: Agent identifier
        tool_name: Full tool name (e.g., "meraki.organizations.list")
        method: HTTP method (GET, POST, PUT, DELETE)
        path: API path template
        args: Tool arguments as dict
        blast_radius: Tier (low/medium/high/destructive)
        approval_status: auto|approved|approved_session|denied
        result: Tool result envelope
        duration_ms: Execution duration in milliseconds
        db_conn: Database connection
    """
    # Extract result info
    response_status = None
    response_summary = None
    error_code = None

    if result.get('ok'):
        response_status = 200
        data = result.get('data', [])
        if isinstance(data, list):
            response_summary = f"{len(data)} items"
        elif isinstance(data, dict):
            # Redact sensitive fields before logging
            redacted = _redact_sensitive_fields(data)
            response_summary = json.dumps(redacted)[:1024]  # First 1KB
        else:
            response_summary = str(data)[:1024]
    else:
        error = result.get('error', {})
        error_code = error.get('code', 'unknown')
        response_summary = error.get('message', '')[:1024]

    # Insert into audit table
    cursor = db_conn.cursor()
    cursor.execute("""
        INSERT INTO meraki_tool_calls (
            conversation_id, agent_id, tool_name, method, path,
            args_json, blast_radius, approval_status,
            response_status, response_summary, error_code,
            duration_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        conversation_id,
        agent_id,
        tool_name,
        method,
        path,
        json.dumps(args),
        blast_radius,
        approval_status,
        response_status,
        response_summary,
        error_code,
        duration_ms,
        int(time.time() * 1000)
    ))
    db_conn.commit()


def get_session_approvals(
    conversation_id: str,
    db_conn
) -> Dict[str, str]:
    """
    Get tools approved for this session with "approved_session" mode.

    Returns: {tool_name: approval_status}

    Args:
        conversation_id: Conversation identifier
        db_conn: Database connection

    Returns:
        Dictionary mapping tool names to their approval status
    """
    cursor = db_conn.cursor()
    cursor.execute("""
        SELECT tool_name, approval_status
        FROM meraki_tool_calls
        WHERE conversation_id = ?
        AND approval_status = 'approved_session'
        ORDER BY created_at DESC
    """, (conversation_id,))

    approvals = {}
    for row in cursor.fetchall():
        approvals[row[0]] = row[1]

    return approvals


def _redact_sensitive_fields(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Redact sensitive fields from data before logging.

    Redacts: api_key, secret, password, token, authorization

    Args:
        data: Dictionary to redact

    Returns:
        Copy of data with sensitive fields redacted
    """
    sensitive_keys = {
        'api_key', 'apiKey', 'api-key',
        'secret', 'secret_key', 'secretKey',
        'password', 'passwd', 'pwd',
        'token', 'access_token', 'accessToken',
        'authorization', 'auth'
    }

    redacted = {}
    for key, value in data.items():
        if key.lower() in {k.lower() for k in sensitive_keys}:
            redacted[key] = "[REDACTED]"
        elif isinstance(value, dict):
            redacted[key] = _redact_sensitive_fields(value)
        elif isinstance(value, list):
            redacted[key] = [
                _redact_sensitive_fields(item) if isinstance(item, dict) else item
                for item in value
            ]
        else:
            redacted[key] = value

    return redacted
