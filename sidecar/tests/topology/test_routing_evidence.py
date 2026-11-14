"""Opt-in routing observations preserve scope/state without claiming physical ports."""
from pathlib import Path

import pytest

from ccie_sidecar.parsers.dispatcher import parse_show
from ccie_sidecar.topology.neighbors import normalize_neighbor_capture, normalize_neighbors

FIX = Path(__file__).parent.parent / "fixtures"
LEGACY_KEYS = {
    "protocol", "local_port", "neighbor_name", "neighbor_port",
    "neighbor_mgmt_ip", "neighbor_platform", "neighbor_vendor", "capabilities",
}
ROUTING_KEYS = {
    "state", "established", "peer_address", "vrf", "address_family",
    "instance", "level", "scope_supported",
}


def test_bgp_raw_ipv6_idle_is_an_observation_not_an_established_or_management_peer():
    raw = (FIX / "show_ip_bgp_summary_iosxe.txt").read_text()
    envelope = parse_show("cisco", "iosxe", "show ip bgp summary", raw)
    legacy = normalize_neighbors("bgp", envelope)
    records = normalize_neighbors("bgp", envelope, include_evidence=True)
    assert len(records) == 1
    record = records[0]
    assert set(legacy[0]) == LEGACY_KEYS
    assert legacy[0]["neighbor_mgmt_ip"] == "1000:192:168:0:1::1"
    assert set(record) == LEGACY_KEYS | {"routing"}
    assert record["neighbor_mgmt_ip"] is None
    assert record["local_port"] == record["neighbor_port"] == ""
    assert record["routing"] == {
        "state": "Idle", "established": False,
        "peer_address": "1000:192:168:0:1::1", "vrf": "default",
        "address_family": "ipv6 unicast", "instance": None, "level": None,
        "scope_supported": False,
    }
    assert normalize_neighbor_capture("bgp", envelope, raw) == {
        "status": "completed", "records": records,
    }


def test_ospf_raw_shared_interface_preserves_router_id_and_peer_address_separately():
    raw = (FIX / "show_ip_ospf_neighbor_iosxe.txt").read_text()
    envelope = parse_show("cisco", "iosxe", "show ip ospf neighbor", raw)
    legacy = normalize_neighbors("ospf", envelope)
    records = normalize_neighbors("ospf", envelope, include_evidence=True)
    assert len(records) == 5
    shared = [r for r in records if r["local_port"] == "GigabitEthernet0/0/0"]
    assert [r["neighbor_name"] for r in shared] == ["172.18.197.242", "172.19.197.251"]
    assert shared[0]["routing"] == {
        "state": "FULL/BDR", "established": True,
        "peer_address": "172.19.197.93", "vrf": "default",
        "address_family": "ipv4 unicast", "instance": None, "level": None,
        "scope_supported": True,
    }
    assert shared[1]["routing"]["peer_address"] == "172.19.197.91"
    assert all(r["neighbor_mgmt_ip"] is None and r["neighbor_port"] == "" for r in records)
    assert all(set(r) == LEGACY_KEYS for r in legacy)
    assert legacy[0]["neighbor_mgmt_ip"] == "172.19.197.93"


def test_isis_raw_keeps_levels_and_init_state_without_management_or_remote_ports():
    raw = (FIX / "show_isis_neighbors_iosxe.txt").read_text()
    envelope = parse_show("cisco", "iosxe", "show isis neighbors", raw)
    legacy = normalize_neighbors("isis", envelope)
    records = normalize_neighbors("isis", envelope, include_evidence=True)
    assert len(legacy) == 2
    assert len(records) == 4
    assert records[0]["routing"] == {
        "state": "INIT", "established": False,
        "peer_address": "10.12.115.2", "vrf": "default",
        "address_family": "ipv4 unicast", "instance": "null", "level": "L1",
        "scope_supported": True,
    }
    assert [r["routing"]["level"] for r in records] == ["L1", "L2", "L1", "L2"]
    assert [r["routing"]["established"] for r in records] == [False, False, True, True]
    assert [r["local_port"] for r in records] == [
        "GigabitEthernet2.415", "GigabitEthernet2.415",
        "GigabitEthernet3.415", "GigabitEthernet3.415",
    ]
    assert all(r["neighbor_mgmt_ip"] is None and r["neighbor_port"] == "" for r in records)
    assert all(set(r) == LEGACY_KEYS for r in legacy)
    assert normalize_neighbor_capture("isis", envelope, raw)["records"] == records


@pytest.mark.parametrize("protocol,envelope", [
    ("cdp", {"parser": "genie", "data": {"index": {1: {
        "device_id": "router.example.test", "local_interface": "Gi1", "port_id": "Gi2",
    }}}}),
    ("lldp", {"parser": "genie", "data": {"interfaces": {"Gi1": {"port_id": {
        "Gi2": {"neighbors": {"chassis": {"system_name": "router.example.test"}}},
    }}}}}),
    ("lldp", {"parser": "genie", "data": {"interfaces": {"Gi1": {"port_id": {
        "Gi2": {"neighbors": {"router.example.test": {}}},
    }}}}}),
    ("cdp", {"parser": "textfsm", "data": [{
        "LOCAL_INTERFACE": "Gi1", "NEIGHBOR_NAME": "router.example.test",
        "NEIGHBOR_INTERFACE": "Gi2",
    }]}),
])
def test_l2_evidence_keeps_full_advertised_name_without_changing_legacy(protocol, envelope):
    legacy = normalize_neighbors(protocol, envelope)
    records = normalize_neighbors(protocol, envelope, include_evidence=True)
    assert legacy[0]["neighbor_name"] == "router"
    assert records[0]["neighbor_name"] == "router.example.test"
    assert set(legacy[0]) == set(records[0]) == LEGACY_KEYS
    assert normalize_neighbor_capture(protocol, envelope, "synthetic")["records"] == records


@pytest.mark.parametrize("session,state,established", [
    ({"session_state": "Established"}, "Established", True),
    ({"session_state": "Idle", "state_pfxrcd": "12"}, "Idle", False),
    ({"session_state": "0"}, "0", False),
    ({"state_pfxrcd": "Established"}, "Established", True),
    ({"state_pfxrcd": "0"}, "0", True),
    ({"state_pfxrcd": 0}, "0", True),
    ({"state_pfxrcd": "23"}, "23", True),
    ({"state_pfxrcd": "Active"}, "Active", False),
    ({"state_pfxrcd": "Idle (Admin)"}, "Idle (Admin)", False),
    ({"state_pfxrcd": True}, "unknown", False),
    ({"state_pfxrcd": -1}, "-1", False),
    ({"state_pfxrcd": "-1"}, "-1", False),
    ({"state_pfxrcd": "1.5"}, "1.5", False),
    ({"state_pfxrcd": {}}, "unknown", False),
    ({}, "unknown", False),
])
def test_bgp_synthetic_genie_state_fields_are_not_arbitrary_truthiness(session, state, established):
    # Numeric cases are synthetic parsed envelopes, not additional raw CLI captures.
    envelope = {"parser": "genie", "data": {"vrf": {"default": {"neighbor": {
        "10.0.0.2": {"address_family": {"ipv4 unicast": session}},
    }}}}}
    record = normalize_neighbors("bgp", envelope, include_evidence=True)[0]
    assert set(record["routing"]) == ROUTING_KEYS
    assert record["routing"]["state"] == state
    assert record["routing"]["established"] is established
    assert record["routing"]["scope_supported"] is True


def test_bgp_synthetic_multiple_address_families_and_vrfs_are_not_collapsed():
    envelope = {"parser": "genie", "data": {"vrf": {
        "default": {"neighbor": {"10.0.0.2": {"address_family": {
            "ipv4 unicast": {"state_pfxrcd": "0"},
            "ipv6 unicast": {"state_pfxrcd": "Idle"},
        }}}},
        "blue": {"neighbor": {"10.0.0.2": {"address_family": {
            "ipv4 unicast": {"session_state": "Established"},
        }}}},
    }}}
    legacy = normalize_neighbors("bgp", envelope)
    assert len(legacy) == 2 and legacy[0] == legacy[1]
    records = normalize_neighbors("bgp", envelope, include_evidence=True)
    assert [(r["routing"]["vrf"], r["routing"]["address_family"],
             r["routing"]["scope_supported"]) for r in records] == [
        ("default", "ipv4 unicast", True),
        ("default", "ipv6 unicast", False),
        ("blue", "ipv4 unicast", False),
    ]
    assert all(r["neighbor_name"] == "10.0.0.2" for r in records)
    assert all(r["neighbor_mgmt_ip"] is None for r in records)
    assert all(r["local_port"] == r["neighbor_port"] == "" for r in records)


def test_bgp_without_address_family_does_not_assume_supported_scope():
    envelope = {"parser": "genie", "data": {"vrf": {"default": {"neighbor": {
        "10.0.0.2": {"session_state": "Established"},
    }}}}}
    routing = normalize_neighbors("bgp", envelope, include_evidence=True)[0]["routing"]
    assert routing["established"] is True
    assert routing["address_family"] is None
    assert routing["scope_supported"] is False


@pytest.mark.parametrize("state,established", [
    ("FULL/DR", True), ("FULL/-", True), ("2WAY/DROTHER", False),
    ("INIT", False), ("EXSTART", False), (None, False),
])
def test_ospf_state_and_missing_address_are_retained_without_mapping(state, established):
    envelope = {"parser": "genie", "data": {"interfaces": {"Loopback0": {
        "neighbors": {"192.0.2.9": {"state": state}},
    }}}}
    record = normalize_neighbors("ospf", envelope, include_evidence=True)[0]
    assert record["neighbor_name"] == "192.0.2.9"
    assert record["local_port"] == "Loopback0"
    assert record["neighbor_port"] == ""
    assert record["neighbor_mgmt_ip"] is None
    assert record["routing"] == {
        "state": state or "unknown", "established": established,
        "peer_address": None, "vrf": "default", "address_family": None,
        "instance": None, "level": None, "scope_supported": False,
    }


def test_ospf_duplicate_peer_addresses_remain_separate_router_id_observations():
    envelope = {"parser": "genie", "data": {"interfaces": {"Gi1": {"neighbors": {
        "192.0.2.1": {"address": "10.0.0.2", "state": "FULL/DR"},
        "192.0.2.2": {"address": "10.0.0.2", "state": "FULL/BDR"},
    }}}}}
    records = normalize_neighbors("ospf", envelope, include_evidence=True)
    assert [r["neighbor_name"] for r in records] == ["192.0.2.1", "192.0.2.2"]
    assert [r["routing"]["peer_address"] for r in records] == ["10.0.0.2", "10.0.0.2"]


def test_ospf_wrapped_vrf_shape_is_not_flattened_or_completed_as_empty():
    envelope = {"parser": "genie", "data": {"vrf": {"blue": {"interfaces": {
        "Gi1": {"neighbors": {"192.0.2.9": {"address": "10.0.0.2", "state": "FULL/DR"}}},
    }}}}}
    assert normalize_neighbors("ospf", envelope, include_evidence=True) == []
    with pytest.raises(ValueError, match="did not establish records"):
        normalize_neighbor_capture("ospf", envelope, "synthetic wrapped VRF")


def test_isis_synthetic_tags_do_not_deduplicate_distinct_instances():
    def instance(address, state):
        return {"neighbors": {"R2": {"type": {"L1": {"interfaces": {
            "Gi1": {"ip_address": address, "state": state},
        }}}}}}

    envelope = {"parser": "genie", "data": {"isis": {
        "red": instance("10.0.0.2", "UP"), "blue": instance("10.0.0.3", "INIT"),
    }}}
    assert len(normalize_neighbors("isis", envelope)) == 1
    records = normalize_neighbors("isis", envelope, include_evidence=True)
    assert [(r["routing"]["instance"], r["routing"]["peer_address"],
             r["routing"]["state"]) for r in records] == [
        ("red", "10.0.0.2", "UP"), ("blue", "10.0.0.3", "INIT"),
    ]
    assert all(r["routing"]["vrf"] is None for r in records)
    assert all(r["routing"]["scope_supported"] is False for r in records)


@pytest.mark.parametrize("tag,level,address", [
    (None, "L1", "10.0.0.2"),
    ("null", "unknown", "10.0.0.2"),
    ("null", "L2", "2001:db8::2"),
    ("null", "L1", None),
])
def test_isis_missing_state_or_unverified_scope_is_not_established(tag, level, address):
    envelope = {"parser": "genie", "data": {"isis": {tag: {"neighbors": {
        "R2": {"type": {level: {"interfaces": {"Gi1": {"ip_address": address}}}}},
    }}}}}
    routing = normalize_neighbors("isis", envelope, include_evidence=True)[0]["routing"]
    assert routing["state"] == "unknown"
    assert routing["established"] is False
    assert routing["scope_supported"] is False
    assert routing["instance"] == tag
    assert routing["level"] == level
    assert routing["peer_address"] == address


@pytest.mark.parametrize("protocol", ["bgp", "ospf", "isis"])
def test_empty_routing_capture_stays_error_and_textfsm_stays_unsupported(protocol):
    with pytest.raises(ValueError, match="did not establish records"):
        normalize_neighbor_capture(protocol, {"parser": "genie", "data": {}}, "")
    assert normalize_neighbor_capture(protocol, {"parser": "textfsm", "data": []}, "") == {
        "status": "unsupported", "records": [],
    }
