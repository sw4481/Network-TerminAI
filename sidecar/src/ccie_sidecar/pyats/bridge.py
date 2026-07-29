"""Bridge module for pyATS integration.

Provides helpers to load PyatsClient and inject it into code execution sandboxes.
Mirrors the Meraki bridge pattern.
"""

import os
from typing import Any, Dict, Optional


def default_testbed_path() -> str:
    """Return the default testbed path (~/.ccie-terminal/pyats/testbed.yaml)."""
    return os.path.expanduser(os.path.join("~", ".ccie-terminal", "pyats", "testbed.yaml"))


def build_pyats_client(path: Optional[str] = None):
    """Return a PyatsClient bound to the testbed, or None if the file is missing.

    Args:
        path: Path to testbed.yaml (uses default if None)

    Returns:
        PyatsClient instance or None if testbed doesn't exist

    Example:
        >>> client = build_pyats_client()
        >>> if client:
        ...     env = client.call("list-devices")
        ...     print(env)
    """
    testbed_path = path or default_testbed_path()
    if not os.path.exists(testbed_path):
        return None

    try:
        from terminai_pyats import PyatsClient
        client = PyatsClient.from_testbed(testbed_path)

        # Point config snapshots at the GUI-managed dir
        snapshot_dir = os.path.join(os.path.dirname(testbed_path), "snapshots")
        # Store snapshot_dir for verbs to use (configure-with-diff, rollback)
        client._snapshot_dir = snapshot_dir

        return client
    except Exception:
        # If testbed is malformed or pyATS not available, return None
        return None


def ensure_pyats_in_sandbox(globals_dict: Dict[str, Any], testbed_path: Optional[str] = None) -> None:
    """Inject a `pyats` PyatsClient into a code-exec sandbox namespace if available.

    Args:
        globals_dict: The sandbox globals dict to inject into
        testbed_path: Optional testbed path override

    Example:
        >>> sandbox = {}
        >>> ensure_pyats_in_sandbox(sandbox)
        >>> if "pyats" in sandbox:
        ...     print(sandbox["pyats"].call("list-devices"))
    """
    client = build_pyats_client(testbed_path)
    if client is not None:
        globals_dict["pyats"] = client
