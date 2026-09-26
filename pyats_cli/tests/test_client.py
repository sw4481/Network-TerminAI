"""Tests for PyatsClient."""

import pytest
from pathlib import Path
from unittest.mock import Mock, patch
from terminai_pyats.client import PyatsClient
from terminai_pyats.errors import PyatsError


@pytest.fixture
def mock_testbed_path(tmp_path):
    """Create a minimal testbed.yaml + .env for testing."""
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

    return str(testbed_yaml)


def test_from_testbed_loads_testbed(mock_testbed_path):
    client = PyatsClient.from_testbed(mock_testbed_path)

    assert client is not None
    assert client.testbed is not None
    assert "TEST1" in client.testbed.devices


def test_from_testbed_raises_for_missing_file(tmp_path):
    nonexistent = tmp_path / "nonexistent.yaml"
    with pytest.raises(PyatsError):
        PyatsClient.from_testbed(str(nonexistent))


def test_call_dispatches_to_verb_module(mock_testbed_path):
    client = PyatsClient.from_testbed(mock_testbed_path)

    with patch("terminai_pyats.verbs.list_devices.list_devices") as mock_verb:
        mock_verb.return_value = {"ok": True, "data": [], "meta": {}}
        result = client.call("list-devices")

        assert result["ok"] is True
        mock_verb.assert_called_once_with(client.testbed)


def test_call_passes_kwargs_to_verb(mock_testbed_path):
    client = PyatsClient.from_testbed(mock_testbed_path)

    with patch("terminai_pyats.verbs.search_devices.search_devices") as mock_verb:
        mock_verb.return_value = {"ok": True, "data": [], "meta": {}}
        result = client.call("search-devices", query="TEST")

        mock_verb.assert_called_once_with(client.testbed, query="TEST")


def test_call_raises_for_unknown_verb(mock_testbed_path):
    client = PyatsClient.from_testbed(mock_testbed_path)

    with pytest.raises(PyatsError) as exc_info:
        client.call("unknown-verb")

    assert "unknown verb" in exc_info.value.message.lower()


def test_call_wraps_exceptions_as_error_envelope(mock_testbed_path):
    client = PyatsClient.from_testbed(mock_testbed_path)

    with patch("terminai_pyats.verbs.list_devices.list_devices") as mock_verb:
        mock_verb.side_effect = Exception("Something broke")
        result = client.call("list-devices")

        assert result["ok"] is False
        assert "Something broke" in result["error"]["message"]


def test_disconnect_all_disconnects_devices(mock_testbed_path):
    client = PyatsClient.from_testbed(mock_testbed_path)

    # Mock the device connection
    device = Mock()
    device.is_connected.return_value = True
    client.testbed.devices = {"TEST1": device}

    client.disconnect_all()

    device.disconnect.assert_called_once()


def test_disconnect_all_handles_already_disconnected(mock_testbed_path):
    client = PyatsClient.from_testbed(mock_testbed_path)

    device = Mock()
    device.is_connected.return_value = False
    client.testbed.devices = {"TEST1": device}

    # Should not raise
    client.disconnect_all()
    device.disconnect.assert_not_called()


def test_kebab_to_snake_conversion():
    """Test internal kebab-case to snake_case conversion."""
    from terminai_pyats.client import _kebab_to_snake

    assert _kebab_to_snake("list-devices") == "list_devices"
    assert _kebab_to_snake("run-show-command") == "run_show_command"
    assert _kebab_to_snake("get-neighbors") == "get_neighbors"
