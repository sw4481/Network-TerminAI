"""Tests for testbed loader with %ENV{} substitution."""

import os
import pytest
import stat
from pathlib import Path
from terminai_pyats.testbed import load_testbed_with_env
from terminai_pyats.errors import PyatsError


@pytest.fixture
def tmp_testbed_dir(tmp_path):
    """Create a temporary directory with testbed.yaml and .env files."""
    testbed_yaml = tmp_path / "testbed.yaml"
    env_file = tmp_path / ".env"

    testbed_yaml.write_text("""devices:
  CORE1:
    os: iosxe
    credentials:
      default:
        username: "%ENV{CORE1_USERNAME}"
        password: "%ENV{CORE1_PASSWORD}"
      enable:
        password: "%ENV{CORE1_ENABLE}"
    connections:
      cli:
        protocol: ssh
        ip: "%ENV{CORE1_IP}"
        port: "%ENV{CORE1_PORT}"
""")

    env_file.write_text("""CORE1_IP=10.0.0.1
CORE1_PORT=22
CORE1_USERNAME=admin
CORE1_PASSWORD=secret123
CORE1_ENABLE=enable123
""")

    return tmp_path


def test_load_testbed_with_env_substitutes_placeholders(tmp_testbed_dir):
    testbed_path = tmp_testbed_dir / "testbed.yaml"
    testbed = load_testbed_with_env(str(testbed_path))

    assert testbed is not None
    assert "CORE1" in testbed.devices
    device = testbed.devices["CORE1"]
    # Genie converts IP to IPv4Address object
    assert str(device.connections.cli.ip) == "10.0.0.1"
    assert device.credentials.default.username == "admin"
    assert device.credentials.default.password.plaintext == "secret123"


def test_load_testbed_with_env_loads_sibling_env(tmp_testbed_dir):
    testbed_path = tmp_testbed_dir / "testbed.yaml"
    testbed = load_testbed_with_env(str(testbed_path))

    device = testbed.devices["CORE1"]
    # Verify all placeholders were substituted
    assert device.connections.cli.port == 22
    assert device.credentials.enable.password.plaintext == "enable123"


def test_load_testbed_missing_file_raises_error(tmp_path):
    nonexistent = tmp_path / "nonexistent.yaml"
    with pytest.raises(PyatsError) as exc_info:
        load_testbed_with_env(str(nonexistent))
    assert "not found" in exc_info.value.message.lower()


def test_load_testbed_missing_env_file_raises_error(tmp_testbed_dir):
    # Remove .env file
    env_file = tmp_testbed_dir / ".env"
    env_file.unlink()

    testbed_path = tmp_testbed_dir / "testbed.yaml"
    with pytest.raises(PyatsError) as exc_info:
        load_testbed_with_env(str(testbed_path))
    assert ".env" in exc_info.value.message.lower()


def test_load_testbed_missing_env_var_raises_error(tmp_testbed_dir):
    # Create .env without CORE1_USERNAME
    env_file = tmp_testbed_dir / ".env"
    env_file.write_text("""CORE1_IP=10.0.0.1
CORE1_PORT=22
CORE1_PASSWORD=secret123
CORE1_ENABLE=enable123
""")

    testbed_path = tmp_testbed_dir / "testbed.yaml"
    with pytest.raises(PyatsError) as exc_info:
        load_testbed_with_env(str(testbed_path))
    assert "CORE1_USERNAME" in exc_info.value.message


def test_load_testbed_removes_rendered_yaml_when_genie_load_fails(tmp_testbed_dir, monkeypatch):
    import terminai_pyats.testbed as module
    rendered = []

    def failing_load(path):
        rendered.append(path)
        raise ValueError("invalid testbed")

    monkeypatch.setattr(module, "genie_load", failing_load)
    with pytest.raises(PyatsError):
        load_testbed_with_env(str(tmp_testbed_dir / "testbed.yaml"))
    assert rendered and not Path(rendered[0]).exists()


def test_load_testbed_handles_multiple_devices(tmp_path):
    testbed_yaml = tmp_path / "testbed.yaml"
    env_file = tmp_path / ".env"

    testbed_yaml.write_text("""devices:
  CORE1:
    os: iosxe
    credentials:
      default:
        username: "%ENV{CORE1_USER}"
        password: "%ENV{CORE1_PASS}"
    connections:
      cli:
        protocol: ssh
        ip: "%ENV{CORE1_IP}"
  CORE2:
    os: iosxe
    credentials:
      default:
        username: "%ENV{CORE2_USER}"
        password: "%ENV{CORE2_PASS}"
    connections:
      cli:
        protocol: ssh
        ip: "%ENV{CORE2_IP}"
""")

    env_file.write_text("""CORE1_IP=10.0.0.1
CORE1_USER=admin1
CORE1_PASS=pass1
CORE2_IP=10.0.0.2
CORE2_USER=admin2
CORE2_PASS=pass2
""")

    testbed = load_testbed_with_env(str(testbed_yaml))
    assert len(testbed.devices) == 2
    assert str(testbed.devices["CORE1"].connections.cli.ip) == "10.0.0.1"
    assert str(testbed.devices["CORE2"].connections.cli.ip) == "10.0.0.2"


def test_load_testbed_repairs_sibling_env_permissions(tmp_testbed_dir):
    env_file = tmp_testbed_dir / ".env"
    env_file.chmod(0o644)

    load_testbed_with_env(str(tmp_testbed_dir / "testbed.yaml"))

    assert stat.S_IMODE(env_file.stat().st_mode) == 0o600
