"""Tests for Stealthwatch injection into the code_exec sandbox.

Regression guard: the stealthwatch agent runs in react-code, whose sandbox is
built by _build_sandbox_globals. Without a `stealthwatch` branch the agent's
prompted `stealthwatch_api_call(...)` doesn't exist and every call fails. This
seam is shared by react_code, code_exec, and the deepagents code-exec tool, so
covering it here covers all loops and both engines.
"""

import json
from unittest.mock import patch

from ccie_sidecar.agents.code_exec import _build_sandbox_globals


def test_stealthwatch_package_injects_api_call():
    """cli_package='stealthwatch' binds the stealthwatch_api_call helper."""
    # No config -> client constructed but unconfigured; the function must exist.
    with patch("ccie_sidecar.stealthwatch_config.get_stealthwatch_config", return_value=None):
        g = _build_sandbox_globals("stealthwatch", {})
    assert callable(g.get("stealthwatch_api_call"))
    assert "stealthwatch" in g


def test_non_stealthwatch_package_does_not_inject():
    """Other agents must not get a stray stealthwatch_api_call."""
    g = _build_sandbox_globals("meraki", {})
    assert "stealthwatch_api_call" not in g


def test_stealthwatch_api_call_returns_structured_json_when_unconfigured():
    """Unconfigured calls return a parseable envelope, not an exception."""
    with patch("ccie_sidecar.stealthwatch_config.get_stealthwatch_config", return_value=None):
        g = _build_sandbox_globals("stealthwatch", {})
    result = g["stealthwatch_api_call"]("GET", "/sw-reporting/v1/tenants")
    parsed = json.loads(result)
    assert set(parsed) == {"status_code", "data", "error", "blast_radius"}
    assert parsed["blast_radius"] == "low"
    assert "not configured" in parsed["error"].lower()
