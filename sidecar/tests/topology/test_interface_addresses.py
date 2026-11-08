"""Synthetic CLI/schema tests; not device or physical-attachment acceptance."""
from copy import deepcopy
from pathlib import Path

import pytest

from ccie_sidecar import server
from ccie_sidecar.parsers.dispatcher import parse_show
from ccie_sidecar.topology.interface_addresses import InterfaceAddressEvidence
from ccie_sidecar.topology.neighbors import normalize_neighbor_capture

RAW = """GigabitEthernet0/0/0 is up, line protocol is up
  Internet address is 172.19.197.90/28
GigabitEthernet0/0/1 is up, line protocol is up
  Internet address is 192.0.2.1/30
Loopback0 is up, line protocol is up
  Internet address is 198.51.100.1/32
GigabitEthernet0/0/2 is up, line protocol is up
  Internet address is 172.19.197.94/28
  VPN Routing/Forwarding "blue"
"""


def evidence():
    return InterfaceAddressEvidence(parse_show("cisco", "iosxe", "show ip interface", RAW))


def record(peer="192.0.2.2", **changes):
    routing = {"established": True, "scope_supported": True, "peer_address": peer,
               "vrf": "default", "address_family": "ipv4 unicast", **changes}
    return {"protocol": "bgp", "local_port": "", "neighbor_name": peer,
            "neighbor_mgmt_ip": None, "routing": routing}


def test_installed_genie_raw_schema_and_unique_subnet_enrichment():
    addresses = evidence()
    row = record()
    addresses.associate(row)
    assert row["routing"]["interface_association"] == {
        "interface": "GigabitEthernet0/0/1", "local_address": "192.0.2.1",
        "prefix_length": 30, "source_command": "show ip interface",
        "relationship": "same_subnet_unverified",
    }
    assert row["local_port"] == "" and row["neighbor_mgmt_ip"] is None


@pytest.mark.parametrize("changes", [
    {"established": False}, {"scope_supported": False}, {"vrf": "blue"},
    {"vrf": None}, {"address_family": "ipv6 unicast"},
])
def test_idle_unsupported_or_unknown_scope_does_not_associate(changes):
    row = record(**changes)
    evidence().associate(row)
    assert "interface_association" not in row["routing"]


@pytest.mark.parametrize("peer", ["203.0.113.2", "198.51.100.1", "192.0.2.1", "192.0.2.0", "192.0.2.3", "127.0.0.1", "224.0.0.1", None, "not-an-IP"])
def test_multihop_loopback_local_network_broadcast_and_opaque_peers_stay_unknown(peer):
    row = record(peer)
    evidence().associate(row)
    assert "interface_association" not in row["routing"]


@pytest.mark.parametrize("other_prefix", ["192.0.2.1/30", "192.0.2.5/29"])
def test_duplicate_or_overlapping_owners_stay_unknown(other_prefix):
    envelope = parse_show("cisco", "iosxe", "show ip interface", RAW)
    ip, prefix = other_prefix.split("/")
    envelope["data"]["GigabitEthernet9"] = {"enabled": True, "oper_status": "up", "ipv4": {other_prefix: {"ip": ip, "prefix_length": prefix}}}
    row = record()
    InterfaceAddressEvidence(envelope).associate(row)
    assert "interface_association" not in row["routing"]


@pytest.mark.parametrize("name", ["Lo0", "lo 0", "Loopback0", "Tu0", "Tu 1", "Tunnel1", "Nu0", "Null0"])
def test_loopback_tunnel_and_null_abbreviations_never_own_association(name):
    envelope = {"parser": "genie", "data": {name: {"enabled": True, "oper_status": "up", "ipv4": {"192.0.2.1/30": {"ip": "192.0.2.1", "prefix_length": "30"}}}}}
    row = record()
    InterfaceAddressEvidence(envelope).associate(row)
    assert "interface_association" not in row["routing"]


def test_reported_conflicting_interface_not_replaced():
    row = record()
    row["local_port"] = "GigabitEthernet9"
    evidence().associate(row)
    assert row["local_port"] == "GigabitEthernet9"
    assert "interface_association" not in row["routing"]


def test_raw_ospf_multiple_peers_share_subnet_without_collapsing_or_changing_l2():
    raw = (Path(__file__).parents[1] / "fixtures/show_ip_ospf_neighbor_iosxe.txt").read_text()
    capture = normalize_neighbor_capture("ospf", parse_show("cisco", "iosxe", "show ip ospf neighbor", raw), raw)
    addresses = evidence()
    before = deepcopy(capture)
    for row in capture["records"]:
        addresses.associate(row)
    shared = [row for row in capture["records"] if row["local_port"] == "GigabitEthernet0/0/0"]
    assert len(shared) == 2
    assert all(row["routing"]["interface_association"]["interface"] == "GigabitEthernet0/0/0" for row in shared)
    assert len(capture["records"]) == len(before["records"])
    assert [row["neighbor_name"] for row in capture["records"]] == [row["neighbor_name"] for row in before["records"]]
    l2 = {"protocol": "cdp", "local_port": "Gi1", "neighbor_name": "peer"}
    addresses.associate(l2)
    assert l2 == {"protocol": "cdp", "local_port": "Gi1", "neighbor_name": "peer"}


def test_rpc_enriches_real_routing_and_ignores_missing_invalid_address_output():
    raw = (Path(__file__).parents[1] / "fixtures/show_ip_ospf_neighbor_iosxe.txt").read_text()
    params = {"protocol": "ospf", "vendor": "cisco", "platform": "iosxe", "command": "show ip ospf neighbor", "raw": raw, "include_status": True}
    request = {"id": "synthetic", "method": "topology.neighbors", "params": params}
    base = server.handle_request(request)
    assert base["type"] == "done"
    for extra in (None, "arbitrary unparseable text"):
        params["interfaces_raw"] = extra
        assert server.handle_request(request) == base
    params["interfaces_raw"] = RAW
    enriched = server.handle_request(request)
    assert enriched["type"] == "done", enriched
    assert enriched["result"]["records"][0]["routing"]["interface_association"]["relationship"] == "same_subnet_unverified"
    params["interfaces_raw"] = True
    assert server.handle_request(request)["type"] == "error"


@pytest.mark.parametrize("envelope", [
    {"parser": "textfsm", "data": {}}, {"parser": "genie", "data": {}},
    {"parser": "genie", "data": {"Gi1": {"enabled": True, "oper_status": "up", "ipv4": {"bad": {"ip": "192.0.2.1", "prefix_length": True}}}}},
])
def test_malformed_address_evidence_fails_closed(envelope):
    with pytest.raises(ValueError):
        InterfaceAddressEvidence(envelope)
