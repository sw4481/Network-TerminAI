"""Plan 13 Phase 1 Task 1.2 — neighbor normalizer tests.

Fixtures are unmodified `_output.txt` captures from the upstream
genieparser test corpus (real CSR1000V / 3750E / Nexus boxes). Source URLs
are recorded next to each ``read_text`` call so a reviewer can confirm
provenance without diffing the binary fixture itself.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from ccie_sidecar.parsers import genie_adapter
from ccie_sidecar.parsers.dispatcher import parse_show
from ccie_sidecar.topology.neighbors import (
    NeighborRecord,
    _vendor_from_platform,
    normalize_neighbors,
)

FIX = Path(__file__).parent.parent / "fixtures"

# These fixtures are Genie's own CDP/LLDP corpus and only parse via Genie. The
# Windows build omits genie/pyats (no Windows wheels), so skip there; the
# vendor-heuristic / to_dict / unknown-parser tests below run everywhere.
requires_genie = pytest.mark.skipif(
    genie_adapter._GENIE_IMPORT_ERROR is not None,
    reason="genie/pyats not installed (e.g. Windows build)",
)


# Source: https://github.com/CiscoTestAutomation/genieparser/blob/main/src/genie/libs/parser/iosxe/tests/ShowCdpNeighborsDetail/cli/equal/device_output_1_output.txt
@requires_genie
def test_normalize_cdp_iosxe():
    raw = (FIX / "show_cdp_neighbors_detail_iosxe.txt").read_text()
    parsed = parse_show("cisco", "iosxe", "show cdp neighbors detail", raw)
    records = normalize_neighbors("cdp", parsed)
    assert len(records) > 0, f"expected neighbors, got {records!r}"
    assert all(r["protocol"] == "cdp" for r in records)
    assert all(r["local_port"] and r["neighbor_name"] and r["neighbor_port"] for r in records)
    # Fixture has 3 entries; two N9K-9000v + one IOSv. Sanity-check the
    # vendor heuristic flagged each.
    vendors = {r["neighbor_vendor"] for r in records}
    assert "cisco" in vendors
    # Capabilities should be tokenized + lowercased.
    for r in records:
        assert all(c == c.lower() for c in r["capabilities"])
    # FQDN cleanup: ``R5.cisco.com`` → ``R5``.
    names = {r["neighbor_name"] for r in records}
    assert "R5" in names, f"expected R5 in {names}"


# Source: https://github.com/CiscoTestAutomation/genieparser/blob/main/src/genie/libs/parser/iosxe/tests/ShowLldpNeighborsDetail/cli/equal/golden_output_output.txt
@requires_genie
def test_normalize_lldp_iosxe():
    raw = (FIX / "show_lldp_neighbors_detail_iosxe.txt").read_text()
    parsed = parse_show("cisco", "iosxe", "show lldp neighbors detail", raw)
    records = normalize_neighbors("lldp", parsed)
    assert len(records) > 0
    assert all(r["protocol"] == "lldp" for r in records)
    # All four entries point at the same R5 chassis with management IP.
    assert all(r["neighbor_name"] == "R5" for r in records)
    assert all(r["neighbor_mgmt_ip"] == "10.9.1.1" for r in records)
    # LLDP capabilities arrive as a Genie dict; we should expand the keys.
    assert all("router" in r["capabilities"] for r in records)


# Source: https://github.com/CiscoTestAutomation/genieparser/blob/main/src/genie/libs/parser/nxos/tests/ShowLldpNeighborsDetail/cli/equal/golden_output1_output.txt
@requires_genie
def test_normalize_lldp_nxos():
    raw = (FIX / "show_lldp_neighbors_detail_nxos.txt").read_text()
    parsed = parse_show("cisco", "nxos", "show lldp neighbors detail", raw)
    records = normalize_neighbors("lldp", parsed)
    assert len(records) > 0
    assert all(r["protocol"] == "lldp" for r in records)
    # NX-OS uses 'management_address_v4' — confirm we picked it up and that
    # the literal string "not advertised" was filtered out for v6.
    mgmts = {r["neighbor_mgmt_ip"] for r in records}
    assert "10.1.3.1" in mgmts
    assert "10.2.3.2" in mgmts
    assert None not in mgmts  # both rows have IPv4 management
    # Local ports come from the NX-OS interfaces map (Eth1/1, Eth1/2).
    local_ports = {r["local_port"] for r in records}
    assert local_ports == {"Ethernet1/1", "Ethernet1/2"}


def test_to_dict_round_trip():
    """NeighborRecord.to_dict yields exactly the keys the protocol expects."""
    rec = NeighborRecord(
        protocol="cdp",
        local_port="Gi0/0",
        neighbor_name="R1",
        neighbor_port="Gi0/1",
        neighbor_mgmt_ip="10.0.0.1",
        neighbor_platform="N9K-9000v",
        neighbor_vendor="cisco",
        capabilities=["router", "switch"],
    )
    d = rec.to_dict()
    assert set(d.keys()) == {
        "protocol",
        "local_port",
        "neighbor_name",
        "neighbor_port",
        "neighbor_mgmt_ip",
        "neighbor_platform",
        "neighbor_vendor",
        "capabilities",
    }
    assert d["capabilities"] == ["router", "switch"]


def test_unknown_parser_returns_empty():
    assert normalize_neighbors("cdp", {"parser": "magic", "data": {}}) == []
    assert normalize_neighbors("cdp", {}) == []


def test_vendor_heuristic():
    assert _vendor_from_platform("N9K-9000v") == "cisco"
    assert _vendor_from_platform("cisco WS-C2960S-48TS-S") == "cisco"
    assert _vendor_from_platform("CSR1000V") == "cisco"
    assert _vendor_from_platform("Arista DCS-7050") == "arista"
    assert _vendor_from_platform("Juniper MX480") == "juniper"
    assert _vendor_from_platform(None) is None
    # Empty-platform Genie LLDP rows must not blow up.
    assert _vendor_from_platform("") is None


def test_vendor_heuristic_juniper_padded_token_match():
    """Juniper model-token markers should match standalone model strings.

    Before the padded-match refactor the markers were prefixed with a
    leading space (" mx") and compared against the un-padded ``lo``, which
    silently dropped standalone strings like ``"MX480"`` to "unknown".
    """
    # Standalone model: previously returned "unknown" because " mx" wasn't
    # found in "mx480"; now the padded check (" mx" in " mx480 ") matches.
    assert _vendor_from_platform("MX480") == "juniper"
    # Regression: vendor-prefixed string must still classify as juniper.
    assert _vendor_from_platform("Juniper MX480") == "juniper"
    # Cisco markers are checked first, so a string containing "cisco"
    # alongside an "MX" token should still resolve to cisco.
    assert _vendor_from_platform("Cisco MX Management") == "cisco"
