"""Actual PySNMP ASN.1 values and numeric indexes, no device or MIB downloads."""
from ipaddress import ip_address
from pathlib import Path
import importlib.metadata
import tomllib

import pytest
from pysnmp.proto import rfc1902

from ccie_sidecar.topology.snmp_mib import SnmpMib
from ccie_sidecar.topology.snmp_neighbors import SnmpTable, SnmpTableError


def decode(name, bindings):
    root = SnmpMib.ROOTS[name]
    cells = [(rfc1902.ObjectName(root + suffix), value) for suffix, value in bindings]
    return SnmpMib.decode(name, cells, "completed")


@pytest.mark.parametrize("name,suffix", [("ifName", ()), ("ifName", (0,)), ("ifName", (2**31,)),
    ("ifName", (1, 2)), ("lldpLocPortTable", (2, 0)), ("lldpRemTable", (9, 42, 0, 1)),
    ("lldpRemTable", (9, 42, 1)), ("lldpRemTable", (9, 2**32, 1, 1)),
    ("cdpCacheTable", (6, 1, 0)), ("cdpCacheTable", (6, 1, 1, 1))])
def test_malformed_full_indexes_are_not_coerced(name, suffix):
    with pytest.raises(SnmpTableError):
        decode(name, [(suffix, rfc1902.OctetString("name"))])


@pytest.mark.parametrize("suffix", [
    (3, 42, 7, 1, 1, 4, 192, 0, 2),
    (3, 42, 7, 1, 1, 4, 192, 0, 2, 256),
    (3, 42, 7, 1, 1, 3, 192, 0, 2),
    (3, 42, 7, 1, 2, 4, 192, 0, 2, 1),
    (3, 42, 7, 1, 1, 0),
    (3, 42, 7, 1, 0, 4, 192, 0, 2, 1),
    (2, 42, 7, 1, 1, 4, 192, 0, 2, 1),
])
def test_lldp_management_index_requires_exact_family_length_and_octets(suffix):
    with pytest.raises(SnmpTableError):
        decode("lldpRemManAddrTable", [(suffix, rfc1902.Integer32(2))])


def test_lldp_management_ipv6_and_non_ip_families():
    ipv6 = ip_address("2001:db8::10")
    table = decode("lldpRemManAddrTable", [
        ((3, 42, 7, 1, 2, 16, *ipv6.packed), rfc1902.Integer32(2)),
        ((3, 42, 7, 1, 6, 6, 0, 1, 2, 3, 4, 5), rfc1902.Integer32(2)),
    ])
    assert table.rows[0]["address"] == "2001:db8::10"
    assert table.rows[1]["address"] is None  # A MAC is not a management IP.
    assert table.rows[0]["index"] == (42, 7, 1, 2, 16, *ipv6.packed)


@pytest.mark.parametrize("column,value", [(3, rfc1902.OctetString("2")), (3, rfc1902.Integer32(4)),
    (4, rfc1902.Integer32(-1)), (5, rfc1902.OctetString("1.3.6.1"))])
def test_lldp_management_readable_value_must_match_declared_asn1_type(column, value):
    with pytest.raises(SnmpTableError):
        decode("lldpRemManAddrTable", [((column, 42, 7, 1, 1, 4, 192, 0, 2, 10), value)])


def test_lldp_join_requires_full_timemark_port_and_neighbor_index():
    remotes = SnmpTable("completed", [{"lldpRemTimeMark": t, "lldpRemLocalPortNum": p, "lldpRemIndex": i}
        for t, p, i in [(42, 7, 1), (43, 7, 1), (42, 8, 1), (42, 7, 2)]])
    management = decode("lldpRemManAddrTable", [((3, 42, 7, 1, 1, 4, 192, 0, 2, 10), rfc1902.Integer32(2))])
    tables = {"lldpRemTable": remotes, "lldpRemManAddrTable": management}
    SnmpMib.join_management(tables)
    assert remotes.rows[0]["management_addresses"] == ["192.0.2.10"]
    assert all(row["management_addresses"] == [] for row in remotes.rows[1:])


def test_cdp_official_management_columns_and_cisco_ipv6_family():
    ipv6 = ip_address("2001:db8::20")
    table = decode("cdpCacheTable", [
        ((19, 101, 1), rfc1902.Integer32(20)),
        ((20, 101, 1), rfc1902.OctetString(ipv6.packed)),
        ((21, 101, 1), rfc1902.Integer32(1)),
        ((22, 101, 1), rfc1902.OctetString(bytes([192, 0, 2, 20]))),
        # Actual columns 15..18 are NOT management addresses (SC2 constants differ).
        ((15, 101, 1), rfc1902.Integer32(1)),
        ((16, 101, 1), rfc1902.OctetString(bytes([192, 0, 2, 99]))),
    ])
    assert table.rows[0]["management_addresses"] == ["2001:db8::20", "192.0.2.20"]
    assert table.rows[0]["management_indexes"] == [(101, 1), (101, 1)]


@pytest.mark.parametrize("family,length,addresses", [(1, 16, None), (20, 4, None), (2, 16, [])])
def test_cdp_never_treats_inet_address_type_as_cisco_protocol(family, length, addresses):
    values = [((3, 101, 1), rfc1902.Integer32(family)), ((4, 101, 1), rfc1902.OctetString(b"\x01" * length))]
    if addresses is None:
        with pytest.raises(SnmpTableError):
            decode("cdpCacheTable", values)
    else:
        assert decode("cdpCacheTable", values).rows[0]["management_addresses"] == addresses


@pytest.mark.parametrize("value", [rfc1902.Integer32(5), rfc1902.OctetString(b"\xff"),
    rfc1902.OctetString("bad\nname"), rfc1902.OctetString("x" * 1025)])
def test_text_asn1_types_encoding_controls_and_size_fail_closed(value):
    with pytest.raises(SnmpTableError):
        decode("ifName", [((101,), value)])


def test_binary_lldp_ids_retain_opaque_evidence():
    table = decode("lldpRemTable", [((7, 42, 7, 1), rfc1902.OctetString(b"\x00\xff\x01"))])
    assert table.rows[0]["lldpRemPortId"] == "hex:00ff01"
    assert table.rows[0]["opaque_lldpRemPortId"] is True


def test_duplicate_asn1_cells_fail_closed():
    with pytest.raises(SnmpTableError, match="duplicate"):
        decode("ifName", [((101,), rfc1902.OctetString("Gi1"))] * 2)


def test_project_license_exact_installed_notice_and_unconditional_dependency():
    root = Path(__file__).resolve().parents[2]
    configuration = tomllib.loads((root / "pyproject.toml").read_text())
    assert "pysnmp==7.1.22" in configuration["project"]["dependencies"]
    notice = root / "licenses" / "PySNMP-LICENSE.txt"
    distribution = importlib.metadata.distribution("pysnmp")
    assert distribution.version == "7.1.22"
    installed_notice = next(distribution.locate_file(path) for path in distribution.files if str(path).endswith("licenses/LICENSE.rst"))
    assert notice.read_bytes() == installed_notice.read_bytes()
    included = configuration["tool"]["hatch"]["build"]["targets"]["wheel"]["force-include"]
    assert included["licenses/PySNMP-LICENSE.txt"] == "ccie_sidecar/licenses/PySNMP-LICENSE.txt"


def test_interface_columns_join_by_ifindex_not_walk_order():
    tables = {
        "ifName": decode("ifName", [((101,), rfc1902.OctetString("Gi1")), ((7,), rfc1902.OctetString("Gi7"))]),
        "ifDescr": decode("ifDescr", [((7,), rfc1902.OctetString("port7")), ((101,), rfc1902.OctetString("port1"))]),
        "ifAlias": decode("ifAlias", [((101,), rfc1902.OctetString("uplink"))]),
    }
    joined = {row["ifIndex"]: row for row in SnmpMib.interfaces(tables).rows}
    assert joined[101] == {"ifIndex": 101, "ifName": "Gi1", "ifDescr": "port1", "ifAlias": "uplink"}
    assert joined[7]["ifDescr"] == "port7"
