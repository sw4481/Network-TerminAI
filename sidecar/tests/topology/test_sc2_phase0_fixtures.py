"""Freeze synthetic interchange examples; this is not an importer test."""
import json
from pathlib import Path

import pytest


FIXTURE = Path(__file__).parent.parent / "fixtures" / "sc2_native_topology_phase0_cases.json"


def test_sc2_phase0_examples_retain_their_intended_edge_cases():
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert fixture["created_on"] == "2026-11-05"
    cases = {case["name"]: case for case in fixture["cases"]}
    assert len(cases) == len(fixture["cases"]) == 8

    rich = cases["parallel_ports_aligned_protocols_unicode_and_reverse_claim"]["map"]
    observations = set()
    pairs = set()
    for source, node in rich.items():
        for peer, record in node["peers"].items():
            assert len(record["connections"]) == len(record["protocols"])
            for ports, protocol in zip(record["connections"], record["protocols"]):
                endpoints = tuple(sorted(((source, ports[0]), (peer, ports[1]))))
                pairs.add(endpoints)
                observations.add((endpoints, protocol))
    assert len(pairs) == 2
    assert len(observations) == 3

    legacy = cases["legacy_missing_protocols_and_missing_peer"]["map"]
    peer, record = next(iter(legacy["seed.example"]["peers"].items()))
    assert "protocols" not in record and peer not in legacy
    routing = cases["routing_eigrp_is_not_a_physical_cable"]["map"]
    assert routing["router-a.example"]["peers"]["router-b.example"]["protocols"] == ["eigrp"]
    assert len(cases["ambiguous_short_names_are_distinct_map_keys"]["map"]) == 2

    misaligned = cases["misaligned_supplied_protocols"]["map"]["seed.example"]["peers"]["peer.example"]
    assert len(misaligned["connections"]) != len(misaligned["protocols"])
    malformed = cases["malformed_connection_pair"]["map"]["seed.example"]["peers"]["peer.example"]
    assert len(malformed["connections"][0]) == 1
    with pytest.raises(json.JSONDecodeError):
        json.loads(cases["malformed_json"]["raw_json"])
    assert '<switch & "quoted">' in cases["labels_are_data_not_markup"]["map"]
