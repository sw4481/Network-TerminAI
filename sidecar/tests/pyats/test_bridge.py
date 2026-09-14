"""Tests for pyATS sidecar bridge."""

import builtins
import importlib.util
import os
import sys
from pathlib import Path
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


def test_build_pyats_client_loads_tracked_wrapper_from_repo_root(monkeypatch, tmp_path):
    """Development sidecars should resolve the tracked wrapper when uninstalled."""
    repo_root = Path(__file__).resolve().parents[3]
    monkeypatch.setenv("CCIE_REPO_ROOT", str(repo_root))
    monkeypatch.delitem(sys.modules, "terminai_pyats", raising=False)
    real_import = builtins.__import__
    missing_once = True

    def import_without_installed_wrapper(name, *args, **kwargs):
        nonlocal missing_once
        if name == "terminai_pyats" and missing_once:
            missing_once = False
            raise ModuleNotFoundError("No module named 'terminai_pyats'", name="terminai_pyats")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", import_without_installed_wrapper)

    testbed_yaml = tmp_path / "testbed.yaml"
    testbed_yaml.write_text("""testbed:
  name: testbed
devices:
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
        port: "%ENV{TEST1_PORT}"
""")
    (tmp_path / ".env").write_text(
        "TEST1_USER=admin\nTEST1_PASS=secret\nTEST1_IP=192.0.2.1\nTEST1_PORT=22\n"
    )

    client = build_pyats_client(str(testbed_yaml))

    assert client is not None
    assert Path(sys.modules["terminai_pyats"].__file__).resolve().is_relative_to(
        repo_root / "pyats_cli"
    )


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
