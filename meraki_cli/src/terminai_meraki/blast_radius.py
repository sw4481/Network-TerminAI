"""
Blast-radius classifier for Meraki Dashboard API endpoints.

Classifies each API operation by risk level (tier) for approval gating.
"""

from fnmatch import fnmatch
from typing import Tuple


# Per-endpoint override table for Cisco-specific knowledge
OVERRIDES = {
    # Read-only diagnostic tools should be "low" despite being POST
    ("POST", "/networks/*/devices/*/ping"): ("low", False),
    ("POST", "/devices/*/liveTools/ping"): ("low", False),
    ("POST", "/devices/*/liveTools/pingDevice"): ("low", False),
    ("POST", "/networks/*/devices/*/blinkLeds"): ("low", False),
    ("POST", "/devices/*/blinkLeds"): ("low", False),
    ("POST", "/networks/*/devices/*/cycleSwitchPort"): ("low", False),
    # Add more overrides as discovered
}


def classify(method: str, path: str) -> Tuple[str, bool]:
    """
    Classify API endpoint by blast radius.

    This classifier determines the risk level of each API operation for
    approval gating in Phase 5. The tier controls whether the agent can
    auto-execute the operation or must request user approval.

    Args:
        method: HTTP method (GET, POST, PUT, DELETE)
        path: API path template (e.g., "/networks/{id}/clients")

    Returns:
        (tier, destructive) where:
        - tier in ["low", "medium", "high", "destructive"]
        - destructive is True only for DELETE on orgs/networks (top-level resources)

    Classification rules (applied in order):
        1. Check OVERRIDES table first
        2. GET * -> "low"
        3. POST */action-batches -> "high" (computed per inner action in Phase 2)
        4. POST */claim, */bind, */release -> "high"
        5. PUT */*/settings, */*/policy, */*/firewall/* -> "high"
        6. PUT * (other) -> "medium"
        7. POST * (other) -> "medium"
        8. DELETE */organizations/*, */networks/* -> "destructive"
        9. DELETE * (sub-resources) -> "high"

    Examples:
        >>> classify("GET", "/organizations/{id}/networks")
        ('low', False)

        >>> classify("PUT", "/networks/{id}/ssids/0")
        ('medium', False)

        >>> classify("PUT", "/networks/{id}/wireless/settings")
        ('high', False)

        >>> classify("DELETE", "/organizations/{id}")
        ('destructive', True)

        >>> classify("DELETE", "/networks/{id}/ssids/0")
        ('high', False)
    """
    method_upper = method.upper()

    # 1. Check overrides first (exact match with wildcards)
    for (override_method, override_pattern), (tier, destructive) in OVERRIDES.items():
        if override_method == method_upper and fnmatch(path, override_pattern):
            return (tier, destructive)

    # 2. GET * -> "low" (all reads are safe)
    if method_upper == "GET":
        return ("low", False)

    # 3. POST */action-batches -> "high" (bulk operations)
    if method_upper == "POST":
        # Match both kebab-case and camelCase variants
        if any(pattern in path.lower() for pattern in ["action-batches", "actionbatches"]):
            return ("high", False)

    # 4. POST */claim, */bind, */release -> "high" (resource ownership changes)
    if method_upper == "POST":
        if any(fnmatch(path, f"*/{pattern}*") for pattern in ["claim", "bind", "release"]):
            return ("high", False)

    # 5. PUT */*/settings, */*/policy, */*/firewall/* -> "high" (critical config)
    if method_upper == "PUT":
        path_lower = path.lower()
        if any(fnmatch(path, pattern) for pattern in [
            "*/*/settings*",
            "*/*/firewall/*",
            "*/*/*/firewall/*",
        ]):
            return ("high", False)
        # Match policy patterns (case-insensitive for camelCase like groupPolicies)
        if "policy" in path_lower or "policies" in path_lower:
            return ("high", False)

    # 6. PUT * (other) -> "medium" (regular config changes)
    if method_upper == "PUT":
        return ("medium", False)

    # 7. POST * (other) -> "medium" (regular actions)
    if method_upper == "POST":
        return ("medium", False)

    # 8. DELETE */organizations/*, */networks/* -> "destructive" (top-level resources)
    if method_upper == "DELETE":
        if fnmatch(path, "*/organizations/*") or fnmatch(path, "*/networks/*"):
            # Check if this is a top-level resource delete (not a sub-resource)
            # Pattern: /organizations/{id} or /networks/{id}
            # Not: /organizations/{id}/admins/{adminId}
            path_parts = path.strip("/").split("/")
            if len(path_parts) == 2:  # Only org/net deletion, not sub-resources
                return ("destructive", True)

    # 9. DELETE * (sub-resources) -> "high"
    if method_upper == "DELETE":
        return ("high", False)

    # Default for unknown methods: treat conservatively
    return ("high", False)
