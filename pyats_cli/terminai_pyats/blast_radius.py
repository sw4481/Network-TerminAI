"""Blast-radius classifier for pyATS verbs.

Computes the actual blast radius for a verb call based on:
- Verb's catalog tier (low/medium/high/computed)
- Argument content (e.g., config payloads with destructive keywords)

Used by ToolApprovalModal to gate high/destructive operations.
"""

from typing import Any, Dict

from .catalog import get_verb_spec
from .safety import has_destructive_keywords


def compute_blast_radius(verb: str, args: Dict[str, Any]) -> str:
    """Compute blast radius for a verb call.

    Args:
        verb: Verb name (e.g., "configure", "run-pyats-code")
        args: Verb arguments

    Returns:
        Blast radius: "low", "medium", "high", or "destructive"

    Examples:
        >>> compute_blast_radius("list-devices", {})
        'low'
        >>> compute_blast_radius("configure", {"config": "reload"})
        'destructive'
        >>> compute_blast_radius("run-pyats-code", {"code": "dev.parse('show version')"})
        'low'
    """
    # Lookup verb in catalog
    spec = get_verb_spec(verb)

    # If verb not found, default to low (defensive)
    if spec is None:
        return "low"

    catalog_tier = spec.blast_radius

    # If catalog tier is not "computed", check for destructive escalation
    if catalog_tier != "computed":
        # High-tier verbs can escalate to destructive
        if catalog_tier == "high":
            config = args.get("config", "")
            if has_destructive_keywords(config):
                return "destructive"

        return catalog_tier

    # Special handling for "computed" tier (run-pyats-code)
    if verb == "run-pyats-code":
        code = args.get("code", "")

        # Check for destructive keywords
        if has_destructive_keywords(code):
            return "destructive"

        # Check for configuration operations
        if ".configure(" in code or ".configure_lines(" in code:
            # Configuration detected - check if it's destructive
            if has_destructive_keywords(code):
                return "destructive"
            return "high"

        # Default to low for read-only code
        return "low"

    # Fallback to low
    return "low"
