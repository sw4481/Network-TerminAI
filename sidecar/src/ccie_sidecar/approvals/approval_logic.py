"""
Approval logic for blast-radius gating.

Implements tier checking, approval requests, and session-level approvals.
"""

from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Set
import asyncio


@dataclass
class ApprovalResult:
    """Result of an approval request."""
    granted: bool
    mode: str  # 'auto', 'once', 'session', 'denied'


# Tier hierarchy: low < medium < high < critical
TIER_HIERARCHY = {
    'low': 0,
    'medium': 1,
    'high': 2,
    'critical': 3,
}


def is_tier_allowed(tool_tier: str, default_allowed: str) -> bool:
    """
    Check if a tool's blast radius tier is auto-allowed.

    Args:
        tool_tier: Tool's blast_radius tier (low, medium, high, critical)
        default_allowed: Agent's default_blast_radius_allowed tier

    Returns:
        True if tool can execute without approval, False if approval required

    Example:
        default_allowed='low' → only 'low' tier tools auto-approved
        default_allowed='medium' → 'low' and 'medium' tier tools auto-approved
    """
    tool_level = TIER_HIERARCHY.get(tool_tier, 999)  # Unknown tiers require approval
    allowed_level = TIER_HIERARCHY.get(default_allowed, -1)

    return tool_level <= allowed_level


async def request_approval(
    tool_spec: dict,
    args: dict,
    tier: str,
    conversation_id: str,
    on_event: Callable[[dict], None],
    timeout: int = 300,
) -> ApprovalResult:
    """
    Request user approval for a high-risk tool call.

    Emits a 'tool_approval_request' event and waits for response.

    Args:
        tool_spec: Full tool specification dict from catalog
        args: Tool arguments from LLM
        tier: Blast radius tier
        conversation_id: Current conversation ID
        on_event: Event callback to emit request
        timeout: Seconds to wait for response (default 300)

    Returns:
        ApprovalResult with granted status and mode
    """
    # Create approval request event
    request_event = {
        'type': 'tool_approval_request',
        'conversation_id': conversation_id,
        'tool_name': tool_spec['name'],
        'description': tool_spec.get('description', ''),
        'args': args,
        'blast_radius': tier,
        'endpoint': tool_spec.get('endpoint', {}),
    }

    # Emit event to frontend
    on_event(request_event)

    # In a real implementation, this would wait for a response from the frontend
    # via a callback mechanism or event queue. For now, we'll simulate a deny
    # since we don't have the wiring complete yet.

    # TODO: Wire up actual approval response from frontend
    # For Phase 5 testing, we'll default to deny to verify the gating logic works
    await asyncio.sleep(0.1)  # Simulate brief wait

    return ApprovalResult(granted=False, mode='denied')


def get_session_approvals(conversation_id: str, db_conn: Any) -> Set[str]:
    """
    Retrieve session-level approvals for a conversation.

    Session approvals are tool names that the user has approved for
    the entire session (not just once).

    Args:
        conversation_id: Conversation ID
        db_conn: Database connection

    Returns:
        Set of tool names approved for this session
    """
    # TODO: Query database for session approvals
    # For now, return empty set
    return set()
