"""
terminai-meraki: Full-coverage Meraki Dashboard API CLI for TerminAI.

This package provides:
- MerakiClient wrapper around the official meraki SDK
- Console script entry point (meraki-cli)
- Tool catalog for AI agent integration
- ReACT loop support with disambiguation and blast-radius gating
"""

__version__ = "0.1.0"

# Phase 1: Credentials resolver
from .credentials import resolve_api_key, AuthError

# Phase 1: MerakiClient stub
from .client import MerakiClient

# Phase 2: Blast-radius classifier
from .blast_radius import classify

# Phase 2: Tool catalog
from .catalog import ToolSpec, generate_catalog, method_name_to_action

__all__ = [
    "__version__",
    "resolve_api_key",
    "AuthError",
    "MerakiClient",
    "classify",
    "ToolSpec",
    "generate_catalog",
    "method_name_to_action",
]
