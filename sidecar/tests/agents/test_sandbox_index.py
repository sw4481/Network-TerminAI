"""Tests for the sandbox API method-index / discovery-hint builder.

Regression: the code-exec sandbox only exposed ~3 example Meraki methods, so
weaker models guessed wrong (listed devices when asked for switch access
policies). The index restores discoverability without sending full schemas.
"""
from __future__ import annotations

import pytest

from ccie_sidecar.agents.sandbox_index import build_method_index, build_discovery_hint


def _meraki_sandbox(with_key: bool):
    from ccie_sidecar.agents.code_exec import _build_sandbox_globals

    secrets = {"meraki_api_key": "fake-key"} if with_key else {}
    return _build_sandbox_globals("meraki", secrets)


def test_meraki_uses_single_door_helper_not_sdk_index():
    """Meraki now reaches the API through the single meraki_api_call helper
    (like ISE/FMC), so there is NO SDK method index to inject."""
    g = _meraki_sandbox(with_key=True)
    assert "meraki_api_call" in g          # the single door is bound
    assert not hasattr(g.get("meraki"), "organizations")  # not the raw SDK
    # No SDK method index is emitted for the REST client.
    assert build_method_index("meraki", g) == ""


def test_meraki_index_empty_without_client():
    """No key → nothing to index."""
    g = _meraki_sandbox(with_key=False)
    assert build_method_index("meraki", g) == ""


def test_meraki_discovery_hint_points_at_api_call():
    """The discovery hint must steer to meraki_api_call, not the SDK."""
    hint = build_discovery_hint("meraki")
    assert "meraki_api_call" in hint
    assert "SDK" in hint  # explicitly tells the model NOT to use it
    assert "/organizations" in hint


def test_pyats_index_lists_verbs():
    pytest.importorskip("terminai_pyats")
    idx = build_method_index("pyats", {})
    assert "run-show-command" in idx
    assert "list-devices" in idx
    assert 'pyats.call(' in idx


def test_pyats_discovery_hint():
    hint = build_discovery_hint("pyats")
    assert "list-devices" in hint
    assert 'pyats.call(' in hint


def test_no_cli_package_yields_no_index_or_hint():
    """drawio-only / bare sandbox: no API surface to index, no hint."""
    assert build_method_index(None, {}) == ""
    assert build_method_index("drawio", {}) == ""
    assert build_discovery_hint(None) == ""
    assert build_discovery_hint("drawio") == ""


def test_no_cli_sandbox_still_has_drawio():
    """The index change must not affect the always-on drawio helper."""
    from ccie_sidecar.agents.code_exec import _build_sandbox_globals

    g = _build_sandbox_globals(None, {})
    assert "drawio" in g
