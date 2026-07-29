"""Tests for pyATS sidecar bridge."""

import importlib.util
import os
import pytest
from ccie_sidecar.pyats.bridge import build_pyats_client, ensure_pyats_in_sandbox

# Loading a real testbed needs terminai_pyats (which wraps pyATS). pyATS has no
# Windows wheels and terminai_pyats (pyats_cli/) isn't installed on clean CI, so
# skip the tests that build a live client there; the missing-testbed cases still
# run everywhere.
requires_terminai_pyats = pytest.mark.skipif(
    importlib.util.find_spec("terminai_pyats") is None,
    reason="terminai_pyats (pyats_cli) not installed",
)


def test_build_pyats_client_returns_none_when_testbed_missing():
    """Should return None when testbed doesn't exist."""
    result = build_pyats_client("/nonexistent/testbed.yaml")
    assert result is None


@requires_terminai_pyats
def test_build_pyats_client_loads_valid_testbed(tmp_path):
    """Should load testbed and return client."""
    testbed_yaml = tmp_path / "testbed.yaml"
    env_file = tmp_path / ".env"

    testbed_yaml.write_text("""devices:
  TEST1:
    os: iosxe
    credentials:
      default:
        username: "%ENV{TEST1_USER}"
        password: "%ENV{TEST1_PASS}"
    connections:
      cli:
        protocol: ssh
        ip: "%ENV{TEST1_IP}"
""")

    env_file.write_text("""TEST1_IP=10.0.0.1
TEST1_USER=admin
TEST1_PASS=secret
""")

    client = build_pyats_client(str(testbed_yaml))
    assert client is not None
    assert client.testbed is not None
    assert "TEST1" in client.testbed.devices


@requires_terminai_pyats
def test_ensure_pyats_in_sandbox_injects_client(tmp_path):
    """Should inject pyats client into sandbox globals."""
    testbed_yaml = tmp_path / "testbed.yaml"
    env_file = tmp_path / ".env"

    testbed_yaml.write_text("""devices:
  TEST1:
    os: iosxe
    credentials:
      default:
        username: "%ENV{TEST1_USER}"
        password: "%ENV{TEST1_PASS}"
    connections:
      cli:
        protocol: ssh
        ip: "%ENV{TEST1_IP}"
""")

    env_file.write_text("""TEST1_IP=10.0.0.1
TEST1_USER=admin
TEST1_PASS=secret
""")

    globals_dict = {}
    ensure_pyats_in_sandbox(globals_dict, str(testbed_yaml))

    assert "pyats" in globals_dict
    assert globals_dict["pyats"].testbed is not None


def test_ensure_pyats_in_sandbox_handles_missing_testbed():
    """Should not inject when testbed is missing."""
    globals_dict = {}
    ensure_pyats_in_sandbox(globals_dict, "/nonexistent/testbed.yaml")

    assert "pyats" not in globals_dict
