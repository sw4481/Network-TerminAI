"""Safety validators for pyATS verbs.

Provides validation functions to reject dangerous or invalid operations:
- validate_show_command: reject pipes, redirects, and non-read commands
- has_destructive_keywords: detect config payloads with destructive operations
"""

import re


def validate_show_command(command: str) -> bool:
    """Validate that a command is a safe show command.

    Rejects:
    - Pipes (|)
    - Redirects (>, >>)
    - Non-show commands (configure, interface, etc.)

    Args:
        command: Command string to validate

    Returns:
        True if command is safe, False otherwise

    Examples:
        >>> validate_show_command("show version")
        True
        >>> validate_show_command("show run | inc password")
        False
        >>> validate_show_command("configure terminal")
        False
    """
    command_lower = command.lower().strip()

    # Must start with "show"
    if not command_lower.startswith("show"):
        return False

    # Reject pipes
    if "|" in command:
        return False

    # Reject redirects
    if ">" in command:
        return False

    return True


# Destructive keywords that should force blast_radius to "destructive"
DESTRUCTIVE_KEYWORDS = [
    "reload",
    "erase",
    "format",
    "delete",
    "boot system",
    "write erase",
    "no shutdown",  # on critical interfaces
]


def has_destructive_keywords(config: str) -> bool:
    """Check if config contains destructive keywords.

    Args:
        config: Configuration payload (string or code)

    Returns:
        True if destructive keywords found, False otherwise

    Examples:
        >>> has_destructive_keywords("reload in 5")
        True
        >>> has_destructive_keywords("interface Gi0/0\\ndescription test")
        False
    """
    config_lower = config.lower()

    for keyword in DESTRUCTIVE_KEYWORDS:
        if keyword in config_lower:
            return True

    return False
