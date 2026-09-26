"""
Credentials resolver for Meraki CLI.

Resolves API keys from multiple sources with priority:
1. Explicit token (passed directly)
2. Vault entry (if running in TerminAI sidecar)
3. Environment variable
4. Error with helpful hint
"""

import os
from typing import Optional


class AuthError(Exception):
    """Authentication error with helpful hint."""
    pass


def resolve_api_key(
    vault_entry: Optional[str] = None,
    env_var: str = "MERAKI_API_KEY",
    explicit_token: Optional[str] = None
) -> str:
    """
    Resolve Meraki API key from various sources.

    Priority:
    1. explicit_token (if provided)
    2. Vault entry (if sidecar context available)
    3. Environment variable
    4. Raise AuthError with helpful hint

    Args:
        vault_entry: Name of vault entry to retrieve (requires sidecar context)
        env_var: Environment variable name to check (default: MERAKI_API_KEY)
        explicit_token: API key passed directly by caller (highest priority)

    Returns:
        str: Resolved API key

    Raises:
        AuthError: If no valid source is available
    """
    # Priority 1: Explicit token
    if explicit_token:
        return explicit_token

    # Priority 2: Vault entry (if running in sidecar)
    if vault_entry and _is_sidecar_context():
        resolved_key = _resolve_from_vault(vault_entry)
        if resolved_key:
            return resolved_key

    # Priority 3: Environment variable
    resolved_key = os.getenv(env_var)
    if resolved_key:
        return resolved_key

    # Priority 4: Raise error with helpful hint
    hint = (
        f"Set {env_var} env var or use --api-key flag. "
        "For TerminAI integration, configure vault entry."
    )
    raise AuthError(hint)


def _is_sidecar_context() -> bool:
    """
    Detect if running within TerminAI sidecar context.

    Returns:
        bool: True if CCIE_SIDECAR_CONTEXT env var is set
    """
    return os.getenv("CCIE_SIDECAR_CONTEXT") is not None


def _resolve_from_vault(vault_entry: str) -> Optional[str]:
    """
    Resolve API key from TerminAI Vault.

    Looks for a secret named 'api_key' inside the specified vault envelope.
    The envelope name is passed as vault_entry (e.g., 'meraki_api_key' or 'Meraki').

    Args:
        vault_entry: Name of vault envelope containing the API key

    Returns:
        Optional[str]: API key from vault, or None if not available
    """
    try:
        # Import here to avoid dependency on Tauri bindings outside sidecar
        import json
        import subprocess

        # Use the invoke command to call the Tauri vault API
        # We need to get the envelope ID first, then get the secret

        # For now, use environment variable as workaround until full vault bridge is ready
        # The sidecar should set VAULT_SECRET_{envelope_name}_api_key when tool executes
        env_key = f"VAULT_SECRET_{vault_entry}_api_key"
        resolved_key = os.getenv(env_key)
        if resolved_key:
            return resolved_key

        # Also try the envelope name in uppercase
        env_key_upper = f"VAULT_SECRET_{vault_entry.upper()}_api_key"
        resolved_key = os.getenv(env_key_upper)
        if resolved_key:
            return resolved_key

    except Exception as e:
        # Silently fail and let caller try environment variable
        pass

    return None
