"""genie_compat: the stand-in for the compiled Genie core used on Windows.

The schema and table tests run everywhere. The end-to-end tests run only where
pyATS is absent (Windows), since elsewhere the real Genie core is used.
"""
import sys

import pytest

from ccie_sidecar.parsers import genie_adapter
from ccie_sidecar.parsers.dispatcher import parse_show
from ccie_sidecar.parsers.genie_compat.exceptions import (
    SchemaEmptyParserError,
    SchemaMissingKeyError,
    SchemaTypeError,
    SchemaUnsupportedKeyError,
)
from ccie_sidecar.parsers.genie_compat.metaparser import MetaParser
from ccie_sidecar.parsers.genie_compat.parsergen import oper_fill_tabular
from ccie_sidecar.parsers.genie_compat.schemaengine import Any, ListOf, Optional, Or, Schema

IP_INT_BRIEF = (
    "Interface              IP-Address      OK? Method Status                Protocol\n"
    "Vlan1                  unassigned      YES NVRAM  administratively down down\n"
    "Vlan10                 10.10.10.2      YES NVRAM  up                    up\n"
    "GigabitEthernet1/0/1   unassigned      YES unset  up                    up\n"
)

BGP_SUMMARY = (
    "BGP router identifier 10.0.0.1, local AS number 65001\n"
    "BGP table version is 5, main routing table version 5\n"
    "4 network entries using 992 bytes of memory\n"
    "\n"
    "Neighbor        V           AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd\n"
    "10.0.0.2        4        65002      12      14        5    0    0 00:08:12        2\n"
)

INTERFACE_SCHEMA = {
    "interface": {
        Any(): {
            "status": str,
            Optional("mtu"): int,
            Optional("vlans"): ListOf(str),
            Optional("speed"): Or(int, str),
        },
    },
}


def test_schema_accepts_matching_data():
    data = {"interface": {"Gi1": {"status": "up", "mtu": 1500, "vlans": ["1"], "speed": "auto"}}}
    assert Schema(INTERFACE_SCHEMA).validate(data) == data


def test_schema_rejects_missing_required_key():
    with pytest.raises(SchemaMissingKeyError):
        Schema(INTERFACE_SCHEMA).validate({"interface": {"Gi1": {"mtu": 1500}}})


def test_schema_rejects_wrong_type():
    with pytest.raises(SchemaTypeError):
        Schema(INTERFACE_SCHEMA).validate({"interface": {"Gi1": {"status": "up", "mtu": "big"}}})


def test_schema_rejects_unexpected_key():
    with pytest.raises(SchemaUnsupportedKeyError):
        Schema(INTERFACE_SCHEMA).validate({"interface": {}, "extra": 1})


def test_metaparser_raises_on_empty_output():
    class Empty(MetaParser):
        schema = INTERFACE_SCHEMA

        def cli(self, output=None):
            return {}

    with pytest.raises(SchemaEmptyParserError):
        Empty().parse(output="")


def test_oper_fill_tabular_reads_columns_by_header_position():
    entries = oper_fill_tabular(
        device_output=IP_INT_BRIEF,
        header_fields=["Interface", "IP-Address", r"OK\?", "Method", "Status", "Protocol"],
        label_fields=["Interface", "ip_address", "interface_is_ok", "method", "status", "protocol"],
        index=[0],
    ).entries
    assert list(entries) == ["Vlan1", "Vlan10", "GigabitEthernet1/0/1"]
    assert entries["Vlan1"]["status"] == "administratively down"
    assert entries["Vlan10"] == {
        "Interface": "Vlan10",
        "ip_address": "10.10.10.2",
        "interface_is_ok": "YES",
        "method": "NVRAM",
        "status": "up",
        "protocol": "up",
    }


requires_compat = pytest.mark.skipif(
    sys.platform != "win32" or genie_adapter._compat is None,
    reason="the Genie stand-in core is only used where pyATS is absent (Windows)",
)


@requires_compat
def test_windows_genie_parses_show_ip_interface_brief():
    result = parse_show("cisco", "iosxe", "show ip interface brief", IP_INT_BRIEF)
    assert result["parser"] == "genie"
    vlan10 = result["data"]["interface"]["Vlan10"]
    assert vlan10["ip_address"] == "10.10.10.2"
    assert vlan10["protocol"] == "up"


@requires_compat
def test_windows_genie_parses_show_ip_bgp_summary():
    result = parse_show("cisco", "iosxe", "show ip bgp summary", BGP_SUMMARY)
    assert result["parser"] == "genie"
    neighbor = result["data"]["vrf"]["default"]["neighbor"]["10.0.0.2"]
    assert neighbor["address_family"][""]["as"] == 65002


@requires_compat
def test_windows_genie_returns_empty_result_when_bgp_is_not_running():
    result = parse_show("cisco", "iosxe", "show ip bgp summary", "% BGP not active\n")
    assert result == {"parser": "genie", "command": "show ip bgp summary", "data": {}}


@requires_compat
def test_windows_genie_unknown_command_falls_back_to_textfsm_or_errors():
    from ccie_sidecar.parsers.errors import GenieUnsupportedError

    with pytest.raises(GenieUnsupportedError):
        genie_adapter.parse("cisco", "iosxe", "show no such command here", "x")
