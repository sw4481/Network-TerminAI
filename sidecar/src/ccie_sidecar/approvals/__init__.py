"""
Blast-radius approval gating for ReACT agent tools.

This module implements approval logic for high-risk tool calls based on
blast radius tiers (low, medium, high, critical).
"""

from .approval_logic import (
    is_tier_allowed,
    request_approval,
    get_session_approvals,
    ApprovalResult,
)
from .audit import log_tool_call

__all__ = [
    "is_tier_allowed",
    "request_approval",
    "get_session_approvals",
    "ApprovalResult",
    "log_tool_call",
]
