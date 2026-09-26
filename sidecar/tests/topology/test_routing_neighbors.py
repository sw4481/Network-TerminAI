"""Plan 13 Phase 5 Task 5.2 — routing-protocol neighbor normalizer tests.

Fixture sources (real outputs from upstream Genie test corpus):
- show_ip_bgp_summary_iosxe.txt:
  https://github.com/CiscoTestAutomation/genieparser/blob/main/src/genie/libs/parser/iosxe/tests/ShowBgpSummary/cli/equal/golden_output_show_bgp_summary_4_output.txt
- show_ip_ospf_neighbor_iosxe.txt:
  https://github.com/CiscoTestAutomation/genieparser/blob/main/src/genie/libs/parser/iosxe/tests/ShowIpOspfNeighbor/cli/equal/golden_output_2_output.txt
- show_isis_neighbors_iosxe.txt:
  https://github.com/CiscoTestAutomation/genieparser/blob/main/src/genie/libs/parser/iosxe/tests/ShowIsisNeighbors/cli/equal/golden_output_output.txt
"""

from __future__ import annotations

from pathlib import Path

import pytest

from ccie_sidecar.parsers.dispatcher import parse_show
from ccie_sidecar.parsers.errors import NoParserError
from ccie_sidecar.topology.neighbors import normalize_neighbors

FIX = Path(__file__).parent.parent / "fixtures"


def _parsed(command: str, fixture: str, platform: str = "iosxe") -> dict:
    """Try the dispatcher; skip if Genie can't handle this exact command on
    this platform (lab-host environment may lack a specific parser package).
    Real production uses the bundled pyATS so this is a defensive shim only.
    """
    raw = (FIX / fixture).read_text()
    try:
        return parse_show("cisco", platform, command, raw)
    except NoParserError as exc:
        pytest.skip(f"genie has no parser for {command!r} on {platform!r}: {exc}")


def test_normalize_bgp_iosxe():
    parsed = _parsed("show ip bgp summary", "show_ip_bgp_summary_iosxe.txt")
    records = normalize_neighbors("bgp", parsed)
    assert len(records) > 0
    for r in records:
        assert r["protocol"] == "bgp"
        # BGP has no local/neighbor port — placeholders are filled by Rust ingest.
        assert r["local_port"] == ""
        assert r["neighbor_port"] == ""
        # Peer IP must populate both name and mgmt_ip.
        assert r["neighbor_name"]
        assert r["neighbor_mgmt_ip"]


def test_normalize_ospf_iosxe():
    parsed = _parsed("show ip ospf neighbor", "show_ip_ospf_neighbor_iosxe.txt")
    records = normalize_neighbors("ospf", parsed)
    assert len(records) > 0
    for r in records:
        assert r["protocol"] == "ospf"
        # OSPF surfaces local interface but not neighbor port.
        assert r["local_port"]
        assert r["neighbor_port"] == ""
        assert r["neighbor_name"]
        # Address present in upstream fixture; should be carried as mgmt_ip.
        assert r["neighbor_mgmt_ip"]


def test_normalize_isis_iosxe():
    parsed = _parsed("show isis neighbors", "show_isis_neighbors_iosxe.txt")
    records = normalize_neighbors("isis", parsed)
    assert len(records) > 0
    for r in records:
        assert r["protocol"] == "isis"
        assert r["local_port"]
        assert r["neighbor_port"] == ""
        assert r["neighbor_name"]


def test_normalize_routing_protocols_round_trip_to_dict():
    """Sanity: NeighborRecord -> dict preserves new-field shape."""
    parsed = _parsed("show ip bgp summary", "show_ip_bgp_summary_iosxe.txt")
    records = normalize_neighbors("bgp", parsed)
    if not records:
        pytest.skip("no BGP neighbors in fixture (lab-host parser variance)")
    keys = set(records[0].keys())
    assert {
        "protocol",
        "local_port",
        "neighbor_name",
        "neighbor_port",
        "neighbor_mgmt_ip",
        "neighbor_platform",
        "neighbor_vendor",
        "capabilities",
    } <= keys
