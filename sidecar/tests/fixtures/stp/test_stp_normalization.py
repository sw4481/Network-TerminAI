"""Recorded IOS-XE/NX-OS STP normalization and findings contract tests."""
from __future__ import annotations

import copy
import json
from pathlib import Path

from ccie_sidecar.stp.normalization import (
    StpObservation,
    build_stp_snapshot,
    compare_stp_snapshots,
    normalize_stp_observation,
    normalized_stp_evidence,
)


FIX = Path(__file__).parent


def recorded(name: str) -> dict:
    return json.loads((FIX / name).read_text())


def observation(payload: dict, *, complete: bool = True, gaps: tuple[str, ...] = ()) -> StpObservation:
    return StpObservation(
        device_id=payload["device_id"],
        platform=payload["platform"],
        parsed=payload["parsed"],
        adjacency_evidence=tuple(payload.get("adjacency_evidence", ())),
        complete=complete,
        collection_gaps=gaps,
    )


def test_normalizes_iosxe_rapid_pvst_bridge_root_timers_ports_and_counter():
    device = normalize_stp_observation(observation(recorded("iosxe_rapid_pvst.json")))

    assert device.normalized_device_id == "xe-a"
    scope = device.scopes[0]
    assert (scope.scope_type, scope.scope_id, scope.vlan_ids) == ("vlan", "10", (10,))
    assert scope.bridge_id == "32768.0011.2233.4455"
    assert scope.normalized_bridge_id == "32768001122334455"
    assert scope.root_id == "24576.00aa.bbcc.ddee"
    assert scope.normalized_root_id == "2457600aabbccddee"
    assert (scope.bridge_priority, scope.root_priority, scope.root_cost) == (32778, 24586, 4)
    assert scope.timers.hello_time == 2
    assert scope.topology_change_count == 3
    assert scope.ports[0].normalized_interface == "gi1/0/1"
    assert (scope.ports[0].role, scope.ports[0].state, scope.ports[0].cost) == ("root", "forwarding", 4)


def test_normalizes_nxos_mst_instance_vlan_mapping_region_and_identifiers():
    device = normalize_stp_observation(observation(recorded("nxos_mst.json")))

    scope = device.scopes[0]
    assert (scope.scope_type, scope.scope_id) == ("instance", "0")
    assert scope.vlan_ids == tuple(range(1, 10)) + tuple(range(11, 4095))
    assert scope.mst_region == ("LAB", 7, "aabbccdd")
    assert scope.ports[0].normalized_interface == "eth1/1"
    assert scope.ports[0].bundle_id == "po10"


def test_normalized_mst_region_survives_the_collector_to_worker_round_trip():
    first = normalize_stp_observation(observation(recorded("nxos_mst.json")))

    second = normalize_stp_observation(
        StpObservation("NX-B", "nxos", normalized_stp_evidence(first))
    )

    assert second.scopes[0].mst_region == ("LAB", 7, "aabbccdd")


def test_normalizes_standard_genie_mst_instance_and_combined_port_status():
    payload = {
        "device_id": "NX-STANDARD",
        "platform": "nxos",
        "parsed": {
            "mstp": {
                "mst_instances": {
                    0: {
                        "bridge_address": "0011.2233.4455",
                        "bridge_priority": 32768,
                        "interfaces": {
                            "Ethernet1/1": {
                                "status": "designated forwarding",
                                "cost": 4,
                            }
                        },
                    }
                }
            }
        },
    }

    device = normalize_stp_observation(observation(payload))

    scope = device.scopes[0]
    assert (device.mode, scope.scope_type, scope.scope_id) == ("mstp", "instance", "0")
    assert scope.bridge_id == "0011.2233.4455"
    assert (scope.ports[0].role, scope.ports[0].state) == ("designated", "forwarding")


def test_normalizes_iosxe_genie_mst_vlans_mapped():
    payload = {
        "device_id": "XE-MST",
        "platform": "iosxe",
        "parsed": {
            "mstp": {
                "mst_instances": {
                    1: {
                        "vlans_mapped": "2-5,10",
                        "bridge": {"address": "0011.2233.4455", "priority": 32769},
                        "interfaces": {},
                    }
                }
            }
        },
    }

    scope = normalize_stp_observation(observation(payload)).scopes[0]

    assert scope.vlan_ids == (2, 3, 4, 5, 10)


def test_mapped_pvst_instances_keep_their_vlan_scope():
    payload = {
        "device_id": "XE-PVST",
        "platform": "iosxe",
        "parsed": {
            "mode": "rapid-pvst",
            "instances": {
                "VLAN0001": {
                    "bridge_id": "0011.2233.4455",
                    "interfaces": {"GigabitEthernet1/0/1": {"status": "forwarding"}},
                }
            },
        },
    }

    scope = normalize_stp_observation(observation(payload)).scopes[0]

    assert (scope.scope_type, scope.scope_id, scope.vlan_ids) == ("vlan", "1", (1,))


def test_collected_numeric_scope_without_mode_remains_unclassified():
    payload = {
        "device_id": "AMBIGUOUS",
        "platform": "iosxe",
        "parsed": {
            "instances": [{"id": "1", "bridge_id": "0011.2233.4455"}],
            "ports": [],
        },
    }

    device = normalize_stp_observation(observation(payload))

    assert device.scopes == ()


def test_port_only_stp_evidence_is_retained_in_normalized_payload():
    payload = {
        "device_id": "XE-PORTS",
        "platform": "iosxe",
        "parsed": {"ports": [{"interface": "GigabitEthernet1/0/1", "state": "forwarding", "cost": 4}]},
    }

    evidence = normalized_stp_evidence(normalize_stp_observation(observation(payload)))

    assert evidence["ports"] == [{"interface": "GigabitEthernet1/0/1", "state": "forwarding", "cost": 4}]


def test_top_level_interfaces_are_used_when_ports_is_empty():
    payload = {
        "device_id": "XE-INTERFACES",
        "platform": "iosxe",
        "parsed": {
            "ports": [],
            "interfaces": [{"interface": "GigabitEthernet1/0/2", "state": "blocking"}],
        },
    }

    evidence = normalized_stp_evidence(normalize_stp_observation(observation(payload)))

    assert evidence["ports"] == [{"interface": "GigabitEthernet1/0/2", "state": "blocking"}]


def test_normalizes_iosxe_genie_root_interface_instead_of_numeric_port():
    payload = {
        "device_id": "XE-MST",
        "platform": "iosxe",
        "parsed": {
            "mstp": {
                "mst_instances": {
                    1: {
                        "root": {
                            "address": "00aa.bbcc.ddee",
                            "priority": 4097,
                            "cost": 20000,
                            "port": 23,
                            "interface": "TenGigabitEthernet1/0/23",
                        },
                        "interfaces": {},
                    }
                }
            }
        },
    }

    scope = normalize_stp_observation(observation(payload)).scopes[0]

    assert (scope.root_port, scope.normalized_root_port) == (
        "TenGigabitEthernet1/0/23",
        "te1/0/23",
    )


def test_normalizes_nxos_genie_detail_root_only_when_designated_evidence_agrees():
    payload = {
        "device_id": "NX-DETAIL",
        "platform": "nxos",
        "parsed": {
            "mstp": {
                "name": "LAB",
                "revision": 7,
                "hello_time": 2,
                "max_age": 20,
                "forwarding_delay": 15,
                "mst_instances": {
                    0: {
                        "bridge_address": "0011.2233.4455",
                        "bridge_priority": 32768,
                        "root_of_the_spanning_tree": False,
                        "topology_changes": 3,
                        "interfaces": {
                            "Ethernet1/1": {
                                "name": "Ethernet1/1",
                                "status": "forwarding",
                                "cost": 4,
                                "designated_root_address": "00aa.bbcc.ddee",
                                "designated_root_priority": 24576,
                            },
                            "Ethernet1/2": {
                                "name": "Ethernet1/2",
                                "status": "blocking",
                                "cost": 4,
                                "designated_root_address": "00aa.bbcc.ddee",
                                "designated_root_priority": 24576,
                            },
                        },
                    }
                },
            }
        },
    }

    scope = normalize_stp_observation(observation(payload)).scopes[0]

    assert (scope.root_id, scope.root_priority) == ("00aa.bbcc.ddee", 24576)
    conflicting = copy.deepcopy(payload)
    conflicting["parsed"]["mstp"]["mst_instances"][0]["interfaces"]["Ethernet1/2"][
        "designated_root_address"
    ] = "00ff.eedd.ccbb"
    conflicting_scope = normalize_stp_observation(observation(conflicting)).scopes[0]
    assert conflicting_scope.root_id is None


def test_normalizes_nxos_genie_detail_local_root_from_bridge_identity():
    payload = {
        "device_id": "NX-ROOT",
        "platform": "nxos",
        "parsed": {
            "mstp": {
                "mst_instances": {
                    0: {
                        "bridge_address": "0011.2233.4455",
                        "bridge_priority": 32768,
                        "root_of_the_spanning_tree": True,
                        "interfaces": {},
                    }
                }
            }
        },
    }

    scope = normalize_stp_observation(observation(payload)).scopes[0]

    assert (scope.root_id, scope.root_priority) == ("0011.2233.4455", 32768)


def test_pvst_fixture_keeps_one_sided_adjacency_provisional_and_collection_gaps_separate():
    payload = recorded("iosxe_pvst.json")
    snapshot = build_stp_snapshot((observation(payload, complete=False, gaps=("show spanning-tree detail timed out",)),))

    assert snapshot.complete is False
    assert snapshot.collection_gaps == ("show spanning-tree detail timed out",)
    assert len(snapshot.adjacencies) == 1
    assert snapshot.adjacencies[0].confidence == "provisional"
    assert snapshot.findings == ()


def test_confirmed_bundle_collapses_only_when_all_member_mappings_agree():
    xe = recorded("iosxe_rapid_pvst.json")
    nx = recorded("nxos_mst.json")
    snapshot = build_stp_snapshot((observation(xe), observation(nx)))

    assert len(snapshot.adjacencies) == 1
    assert snapshot.adjacencies[0].confidence == "confirmed"
    assert snapshot.adjacencies[0].local_interface == "po1"
    assert snapshot.adjacencies[0].remote_interface == "po10"
    assert snapshot.adjacencies[0].member_interfaces == (("gi1/0/1", "eth1/1"), ("gi1/0/2", "eth1/2"))

    nx_bad = copy.deepcopy(nx)
    nx_bad["adjacency_evidence"][1]["remote_bundle"] = "Port-channel99"
    expanded = build_stp_snapshot((observation(xe), observation(nx_bad)))
    assert len(expanded.adjacencies) == 2
    assert all(edge.member_interfaces == () for edge in expanded.adjacencies)


def test_bundle_does_not_collapse_when_any_member_mapping_is_incomplete():
    xe = recorded("iosxe_rapid_pvst.json")
    nx_incomplete = recorded("nxos_mst.json")
    del xe["adjacency_evidence"][1]["remote_bundle"]
    del nx_incomplete["adjacency_evidence"][1]["remote_bundle"]

    snapshot = build_stp_snapshot((observation(xe), observation(nx_incomplete)))

    assert len(snapshot.adjacencies) == 2
    assert all(edge.member_interfaces == () for edge in snapshot.adjacencies)


def test_root_disagreement_is_limited_to_confirmed_component_and_scope():
    xe = recorded("iosxe_rapid_pvst.json")
    other_xe = copy.deepcopy(xe)
    other_xe["device_id"] = "XE-B"
    other_xe["parsed"]["pvst"]["Vlan0010"]["root_id"] = "11111.9999.8888.7777"
    for item in xe["adjacency_evidence"]:
        item["remote_device"] = "XE-B"
        item["remote_interface"] = item["local_interface"]
    for item in other_xe["adjacency_evidence"]:
        item["remote_device"] = "XE-A"
        item["remote_interface"] = item["local_interface"]
    snapshot = build_stp_snapshot((observation(xe), observation(other_xe)))

    findings = compare_stp_snapshots(snapshot, snapshot)
    assert any(f.code == "ROOT_DISAGREEMENT" and f.severity == "warning" for f in findings)

    disconnected_payload = recorded("iosxe_pvst.json")
    disconnected_payload["parsed"]["pvst"]["Vlan0010"] = disconnected_payload["parsed"]["pvst"].pop("Vlan0020")
    disconnected = build_stp_snapshot((observation(xe), observation(disconnected_payload)))
    assert not any(f.code == "ROOT_DISAGREEMENT" for f in compare_stp_snapshots(disconnected, disconnected))


def test_baseline_comparison_reports_exact_counter_and_port_changes_only():
    previous_payload = recorded("nxos_mst.json")
    current_payload = copy.deepcopy(previous_payload)
    current_scope = current_payload["parsed"]["mst"]["instance"]["0"]
    current_scope["topology_changes"] = 4
    current_scope["interfaces"]["Ethernet1/1"]["state"] = "blocking"
    previous = build_stp_snapshot((observation(previous_payload),))
    current = build_stp_snapshot((observation(current_payload),))

    findings = compare_stp_snapshots(current, previous)
    assert {f.code for f in findings} == {"TOPOLOGY_CHANGE_INCREMENT", "PORT_STATE_CHANGED"}
    assert all(f.severity == "informational" for f in findings)


def test_counter_decrease_is_reset_and_inconsistent_warning_requires_explicit_evidence():
    previous_payload = recorded("iosxe_rapid_pvst.json")
    current_payload = copy.deepcopy(previous_payload)
    scope = current_payload["parsed"]["pvst"]["Vlan0010"]
    scope["topology_changes"] = 1
    scope["interfaces"]["GigabitEthernet1/0/2"]["state"] = "down"
    scope["interfaces"]["GigabitEthernet1/0/2"]["inconsistent"] = True
    scope["interfaces"]["GigabitEthernet1/0/2"]["explicit_evidence"] = "PVID mismatch"
    previous = build_stp_snapshot((observation(previous_payload),))
    current = build_stp_snapshot((observation(current_payload),))

    findings = compare_stp_snapshots(current, previous)
    assert {f.code for f in findings} == {"COUNTER_RESET", "PORT_STATE_CHANGED", "PORT_INCONSISTENT_OR_BROKEN"}
    assert next(f for f in findings if f.code == "COUNTER_RESET").severity == "informational"
    assert next(f for f in findings if f.code == "PORT_INCONSISTENT_OR_BROKEN").severity == "warning"


def test_mst_region_mismatch_and_root_changed_are_baseline_findings():
    previous_payload = recorded("nxos_mst.json")
    current_payload = copy.deepcopy(previous_payload)
    current_scope = current_payload["parsed"]["mst"]["instance"]["0"]
    current_payload["parsed"]["mst_region"]["revision"] = 8
    current_scope["root_id"] = "24576.00aa.bbcc.ddee"
    previous = build_stp_snapshot((observation(previous_payload),))
    current = build_stp_snapshot((observation(current_payload),))

    findings = compare_stp_snapshots(current, previous)
    assert {f.code for f in findings} == {"MST_REGION_MISMATCH", "ROOT_CHANGED"}
    assert all(f.severity == "warning" for f in findings)


def test_blocked_or_alternate_port_without_explicit_evidence_is_not_anomaly():
    payload = recorded("iosxe_rapid_pvst.json")
    previous = build_stp_snapshot((observation(payload),))
    current_payload = copy.deepcopy(payload)
    current_payload["parsed"]["pvst"]["Vlan0010"]["interfaces"]["GigabitEthernet1/0/2"]["state"] = "BLK"
    current = build_stp_snapshot((observation(current_payload),))

    assert not any(f.code == "PORT_INCONSISTENT_OR_BROKEN" for f in compare_stp_snapshots(current, previous))
