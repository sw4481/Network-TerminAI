"""Tests for verb implementations (Phase 1: 6 read verbs)."""

import pytest
from unittest.mock import MagicMock, Mock
from terminai_pyats.verbs.list_devices import list_devices
from terminai_pyats.verbs.search_devices import search_devices
from terminai_pyats.verbs.run_show_command import run_show_command
from terminai_pyats.verbs.learn import learn
from terminai_pyats.verbs.device_health import device_health
from terminai_pyats.verbs.get_neighbors import get_neighbors


@pytest.fixture
def mock_testbed():
    """Create a mock Genie testbed with two devices."""
    testbed = Mock()

    # Create mock devices
    device1 = Mock()
    device1.name = "CORE1"
    device1.os = "iosxe"
    device1.type = "router"
    device1.is_connected.return_value = False

    device2 = Mock()
    device2.name = "EDGE2"
    device2.os = "nxos"
    device2.type = "switch"
    device2.is_connected.return_value = False

    testbed.devices = {
        "CORE1": device1,
        "EDGE2": device2,
    }

    return testbed


def test_list_devices_returns_all_devices(mock_testbed):
    result = list_devices(mock_testbed)

    assert result["ok"] is True
    assert len(result["data"]) == 2
    assert result["meta"]["count"] == 2
    assert any(d["name"] == "CORE1" for d in result["data"])
    assert any(d["name"] == "EDGE2" for d in result["data"])


def test_search_devices_filters_by_pattern(mock_testbed):
    result = search_devices(mock_testbed, query="CORE")

    assert result["ok"] is True
    assert len(result["data"]) == 1
    assert result["data"][0]["name"] == "CORE1"
    assert result["meta"]["query"] == "CORE"


def test_search_devices_is_case_insensitive(mock_testbed):
    result = search_devices(mock_testbed, query="core")

    assert result["ok"] is True
    assert len(result["data"]) == 1
    assert result["data"][0]["name"] == "CORE1"


def test_search_devices_returns_empty_for_no_match(mock_testbed):
    result = search_devices(mock_testbed, query="NONEXISTENT")

    assert result["ok"] is True
    assert len(result["data"]) == 0
    assert result["meta"]["count"] == 0


def test_run_show_command_returns_error_for_unknown_device(mock_testbed):
    result = run_show_command(mock_testbed, device="UNKNOWN", command="show version")

    assert result["ok"] is False
    assert result["error"]["code"] == "device_not_found"
    assert "UNKNOWN" in result["error"]["message"]


def test_run_show_command_parses_with_genie(mock_testbed):
    device = mock_testbed.devices["CORE1"]
    device.parse.return_value = {"version": "16.9.1"}

    result = run_show_command(mock_testbed, device="CORE1", command="show version")

    assert result["ok"] is True
    assert result["data"]["format"] == "genie"
    assert result["data"]["parsed"]["version"] == "16.9.1"
    device.connect.assert_called_once()


def test_run_show_command_falls_back_to_raw(mock_testbed):
    device = mock_testbed.devices["CORE1"]
    device.parse.side_effect = Exception("No parser")
    device.execute.return_value = "Raw output"

    result = run_show_command(mock_testbed, device="CORE1", command="show version")

    assert result["ok"] is True
    assert result["data"]["format"] == "raw"
    assert result["data"]["output"] == "Raw output"


def test_learn_returns_error_for_unknown_device(mock_testbed):
    result = learn(mock_testbed, device="UNKNOWN", feature="ospf")

    assert result["ok"] is False
    assert result["error"]["code"] == "device_not_found"


def test_learn_returns_structured_state(mock_testbed):
    device = mock_testbed.devices["CORE1"]
    mock_learned = Mock()
    mock_learned.info = {"vrf": {"default": {"router_id": "1.1.1.1"}}}
    device.learn.return_value = mock_learned

    result = learn(mock_testbed, device="CORE1", feature="ospf")

    assert result["ok"] is True
    assert result["data"]["feature"] == "ospf"
    assert result["data"]["device"] == "CORE1"
    assert "router_id" in str(result["data"]["state"])
    device.learn.assert_called_once_with("ospf")


def test_device_health_returns_error_for_unknown_device(mock_testbed):
    result = device_health(mock_testbed, device="UNKNOWN")

    assert result["ok"] is False
    assert result["error"]["code"] == "device_not_found"


def test_device_health_gathers_platform_and_interfaces(mock_testbed):
    device = mock_testbed.devices["CORE1"]
    device.parse.side_effect = [
        {"version": {"version": "16.9.1", "uptime": "3 days"}},
        {"interface": {
            "Gi0/0": {"status": "up"},
            "Gi0/1": {"status": "down"},
        }}
    ]

    result = device_health(mock_testbed, device="CORE1")

    assert result["ok"] is True
    assert result["data"]["health"]["platform"]["version"] == "16.9.1"
    assert result["data"]["health"]["interfaces"]["up"] == 1
    assert result["data"]["health"]["interfaces"]["down"] == 1


def test_get_neighbors_returns_error_for_unknown_device(mock_testbed):
    result = get_neighbors(mock_testbed, device="UNKNOWN")

    assert result["ok"] is False
    assert result["error"]["code"] == "device_not_found"


def test_get_neighbors_returns_cdp_and_lldp(mock_testbed):
    device = mock_testbed.devices["CORE1"]
    device.parse.side_effect = [
        {"cdp": {"neighbors": {"CORE2": {}}}},
        {"lldp": {"neighbors": {"EDGE1": {}}}}
    ]

    result = get_neighbors(mock_testbed, device="CORE1")

    assert result["ok"] is True
    assert "cdp" in result["data"]["neighbors"]
    assert "lldp" in result["data"]["neighbors"]
    assert result["meta"]["device"] == "CORE1"


def test_get_neighbors_handles_missing_protocols(mock_testbed):
    device = mock_testbed.devices["CORE1"]
    device.parse.side_effect = [
        Exception("CDP not available"),
        {"lldp": {"neighbors": {}}}
    ]

    result = get_neighbors(mock_testbed, device="CORE1")

    assert result["ok"] is True
    assert "error" in result["data"]["neighbors"]["cdp"]
    assert "lldp" in result["data"]["neighbors"]
