"""Tests for pyATS injection into code_exec sandbox."""

from unittest.mock import patch
import pytest
from ccie_sidecar.agents.code_exec import _build_sandbox_globals


def test_pyats_package_injects_client():
    """When cli_package is 'pyats', should inject client into sandbox."""
    sentinel = object()
    with patch("ccie_sidecar.pyats.bridge.build_pyats_client", return_value=sentinel):
        g = _build_sandbox_globals("pyats", {})
    assert g["pyats"] is sentinel


def test_non_pyats_package_does_not_inject():
    """Non-pyats packages should not inject pyats client."""
    g = _build_sandbox_globals("meraki", {})
    assert "pyats" not in g


def test_pyats_missing_client_fails_clearly():
    with patch("ccie_sidecar.pyats.bridge.build_pyats_client", return_value=None):
        with pytest.raises(RuntimeError, match="PyATS client unavailable"):
            _build_sandbox_globals("pyats", {})
