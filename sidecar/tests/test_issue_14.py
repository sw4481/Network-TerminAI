import pytest

from ccie_sidecar.parsers import textfsm_adapter
from ccie_sidecar.parsers.errors import TextFSMUnsupportedError


def test_empty_output_for_known_template_is_empty_result():
    result = textfsm_adapter.parse("cisco", "iosxe", "show ip bgp summary", "% BGP not active\n")
    assert result["parser"] == "textfsm"
    assert result["command"] == "show ip bgp summary"
    assert result["data"] == []


def test_unknown_command_still_errors():
    with pytest.raises(TextFSMUnsupportedError):
        textfsm_adapter.parse("cisco", "iosxe", "show no such command", "x")
