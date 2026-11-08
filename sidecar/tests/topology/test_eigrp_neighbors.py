"""Synthetic EIGRP CLI evidence, not real-device or physical-link acceptance."""
from copy import deepcopy
import json
import os
import subprocess
import sys

import pytest

from ccie_sidecar import server
from ccie_sidecar.parsers import genie_adapter
from ccie_sidecar.parsers.dispatcher import parse_show
from ccie_sidecar.topology.neighbors import normalize_neighbor_capture, normalize_neighbors

requires_genie = pytest.mark.skipif(
    genie_adapter._GENIE_IMPORT_ERROR is not None,
    reason="genie/pyats not installed (e.g. Windows build)",
)

COMMAND = "show ip eigrp neighbors"
TABLE = """H   Address       Interface   Hold Uptime    SRTT   RTO  Q  Seq
                              (sec)         (ms)        Cnt Num
"""
RAW = (
    "EIGRP-IPv4 Neighbors for AS(100)\n" + TABLE
    + "0   192.0.2.2     Gi0/0       13   00:02:24  20     100  0  5\n"
    + "1   192.0.2.3     Gi0/0       12   00:01:02  25     150  2  7\n"
    + "EIGRP-IPv4 VR(CAMPUS) Address-Family Neighbors for AS(200)\n" + TABLE
    + "0   192.0.2.2     Gi0/0       14   00:03:00  30     200  0  9\n"
)


@pytest.mark.parametrize("platform", ["ios", "iosxe"])
@requires_genie
def test_raw_neighbor_table_retains_as_and_named_mode_without_inventing_ports(platform):
    envelope = parse_show("cisco", platform, COMMAND, RAW)
    assert envelope["parser"] == "genie"
    named = envelope["data"]["eigrp_instance"]["200"]["vrf"]["default"]["address_family"]["ipv4"]
    assert named["named_mode"] is True and named["name"] == "CAMPUS"
    records = normalize_neighbors("eigrp", envelope, include_evidence=True)
    assert [(r["routing"]["instance"], r["neighbor_name"]) for r in records] == [
        ("100", "192.0.2.2"), ("100", "192.0.2.3"), ("200", "192.0.2.2"),
    ]
    assert records[0]["routing"] == {
        "state": "up", "established": True, "peer_address": "192.0.2.2",
        "vrf": "default", "address_family": "ipv4 unicast", "instance": "100",
        "level": None, "scope_supported": True,
    }
    assert all(r["local_port"] == "GigabitEthernet0/0" for r in records)
    assert all(r["neighbor_port"] == "" and r["neighbor_mgmt_ip"] is None for r in records)
    # A nonzero send queue is still a neighbor-table observation, not a prefix count/state.
    assert records[1]["routing"]["established"] is True
    assert normalize_neighbor_capture("eigrp", envelope, RAW) == {
        "status": "completed", "records": records,
    }
    legacy = normalize_neighbors("eigrp", envelope)
    assert len(legacy) == 3 and "routing" not in legacy[0]
    assert all(row["neighbor_mgmt_ip"] is None for row in legacy)


def request(raw=RAW, **extra):
    return {
        "id": "synthetic-eigrp", "method": "topology.neighbors",
        "params": {"protocol": "eigrp", "vendor": "cisco", "platform": "iosxe",
                   "command": COMMAND, "raw": raw, "include_status": True, **extra},
    }


@requires_genie
def test_rpc_and_ndjson_collect_eigrp_with_isolated_startup(tmp_path):
    req = request()
    direct = server.handle_request(req)
    assert direct["type"] == "done", direct
    assert direct["result"]["status"] == "completed"
    assert len(direct["result"]["records"]) == 3
    home = tmp_path / "home"
    home.mkdir()
    proc = subprocess.run(
        [sys.executable, "-m", "ccie_sidecar.server"],
        input=json.dumps(req) + "\n", text=True, capture_output=True, timeout=30,
        env={**os.environ, "HOME": str(home)},
    )
    assert proc.returncode == 0, proc.stderr
    replies = [json.loads(line) for line in proc.stdout.splitlines()]
    assert next(reply for reply in replies if reply.get("id") == req["id"]) == direct
    legacy = server.handle_request(request(include_status=False))
    assert legacy["type"] == "done" and "routing" not in legacy["result"]["records"][0]
    assert all(row["neighbor_mgmt_ip"] is None for row in legacy["result"]["records"])


@requires_genie
def test_rpc_interface_association_is_optional_and_not_a_physical_link():
    raw_interfaces = """GigabitEthernet0/0 is up, line protocol is up
  Internet address is 192.0.2.1/29
"""
    base = server.handle_request(request())
    enriched = server.handle_request(request(interfaces_raw=raw_interfaces))
    assert enriched["type"] == "done", enriched
    assert len(enriched["result"]["records"]) == 3
    for row in enriched["result"]["records"]:
        assert row["routing"]["interface_association"] == {
            "interface": "GigabitEthernet0/0", "local_address": "192.0.2.1",
            "prefix_length": 29, "source_command": "show ip interface",
            "relationship": "same_subnet_unverified",
        }
        assert row["local_port"] == "GigabitEthernet0/0"
        assert row["neighbor_port"] == "" and row["neighbor_mgmt_ip"] is None
    assert server.handle_request(request(interfaces_raw="unparseable")) == base
    assert server.handle_request(request(interfaces_raw=True))["type"] == "error"
    conflicting = raw_interfaces.replace("GigabitEthernet0/0", "GigabitEthernet9")
    assert server.handle_request(request(interfaces_raw=conflicting)) == base


@pytest.mark.parametrize("command", ["show ip route eigrp", "show ip eigrp topology", "show ipv6 eigrp neighbors"])
def test_rpc_requires_fixed_neighbor_command(command):
    result = server.handle_request(request(command=command))
    assert result["type"] == "error"
    assert COMMAND in result["message"]


@pytest.mark.parametrize("header,peer,af,vrf", [
    ("EIGRP-IPv4 Neighbors for AS(100) VRF(blue)", "192.0.2.2", "ipv4 unicast", "blue"),
    ("EIGRP-IPv6 VR(CAMPUS) Address-Family Neighbors for AS(100)", "fe80::1", "ipv6 unicast", "default"),
])
@requires_genie
def test_raw_other_scopes_are_retained_but_unsupported(header, peer, af, vrf):
    raw = header + "\n" + TABLE + f"0   {peer}   Gi0/0   13   00:02:24   20   100   0   5\n"
    envelope = parse_show("cisco", "iosxe", COMMAND, raw)
    row = normalize_neighbor_capture("eigrp", envelope, raw)["records"][0]
    assert row["routing"]["vrf"] == vrf
    assert row["routing"]["address_family"] == af
    assert row["routing"]["scope_supported"] is False
    assert row["routing"]["peer_address"] == peer
    assert row["neighbor_mgmt_ip"] is None


@pytest.mark.parametrize("change", [
    {"hold": True}, {"peer_handle": -1}, {"uptime": ""}, {"q_cnt": "0"},
    {"srtt": None}, {"last_seq_number": None},
])
@requires_genie
def test_malformed_parsed_neighbor_fields_stay_unknown(change):
    envelope = deepcopy(parse_show("cisco", "iosxe", COMMAND, RAW))
    peers = envelope["data"]["eigrp_instance"]["100"]["vrf"]["default"]["address_family"]["ipv4"]["eigrp_interface"]["GigabitEthernet0/0"]["eigrp_nbr"]
    peers["192.0.2.2"].update(change)
    routing = normalize_neighbors("eigrp", envelope, include_evidence=True)[0]["routing"]
    assert routing["state"] == "unknown" and routing["established"] is False


@pytest.mark.parametrize("peer", ["not-an-IP", "0.0.0.0", "224.0.0.1"])
@requires_genie
def test_raw_invalid_neighbor_address_cannot_establish_scope(peer):
    raw = RAW.replace("192.0.2.2", peer)
    row = normalize_neighbors("eigrp", parse_show("cisco", "iosxe", COMMAND, raw), include_evidence=True)[0]
    assert row["routing"]["established"] is False
    assert row["routing"]["scope_supported"] is False


EMPTY = "EIGRP-IPv4 Neighbors for AS(100)\n" + TABLE


@pytest.mark.parametrize("prefix", ["", "Device#show ip eigrp neighbors\n"])
@requires_genie
def test_exact_empty_neighbor_table_is_completed(prefix):
    response = server.handle_request(request(prefix + EMPTY))
    assert response["type"] == "done", response
    assert response["result"] == {"status": "completed", "records": []}


@pytest.mark.parametrize("raw", [
    "", "arbitrary junk", "% Invalid input detected at '^' marker.",
    "EIGRP-IPv4 Neighbors for AS(100)\n", TABLE,
    "junk\n" + EMPTY, EMPTY + "junk\n", EMPTY + "0 malformed neighbor row\n",
    "Device#show ip route eigrp\n" + EMPTY,
    "% Invalid input detected\n" + EMPTY, RAW + "% Invalid input detected\n",
    "% Incomplete command.\n" + RAW, "% Ambiguous command\n" + RAW,
])
@requires_genie
def test_invalid_capture_is_never_completed_as_empty(raw):
    assert server.handle_request(request(raw))["type"] == "error"


@pytest.mark.parametrize("data", [{}, {"eigrp_instance": []}, {"eigrp_instance": {"100": None}}])
def test_parser_empty_or_malformed_schema_without_exact_framing_is_not_success(data):
    with pytest.raises(ValueError, match="did not establish records"):
        normalize_neighbor_capture("eigrp", {"parser": "genie", "data": data}, "arbitrary junk")
    assert normalize_neighbor_capture("eigrp", {"parser": "textfsm", "data": []}, EMPTY) == {
        "status": "unsupported", "records": [],
    }


@pytest.mark.parametrize("field", ["hold", "uptime", "peer_handle", "q_cnt", "rto", "srtt", "last_seq_number"])
@requires_genie
def test_missing_neighbor_fields_are_retained_without_claiming_up(field):
    envelope = parse_show("cisco", "iosxe", COMMAND, RAW)
    peers = envelope["data"]["eigrp_instance"]["100"]["vrf"]["default"]["address_family"]["ipv4"]["eigrp_interface"]["GigabitEthernet0/0"]["eigrp_nbr"]
    del peers["192.0.2.2"][field]
    row = normalize_neighbors("eigrp", envelope, include_evidence=True)[0]
    assert row["routing"]["state"] == "unknown"
    assert row["routing"]["established"] is False
    assert row["routing"]["peer_address"] == "192.0.2.2"


@requires_genie
def test_raw_ipv6_two_line_neighbor_table_stays_unsupported():
    raw = ("EIGRP-IPv6 VR(CAMPUS) Address-Family Neighbors for AS(100)\n" + TABLE
           + "0   Link-local address:   Gi0/0   13   00:02:24   20   100   0   5\n"
           + "fe80::5c00:ff:fe02:7\n")
    row = normalize_neighbor_capture("eigrp", parse_show("cisco", "iosxe", COMMAND, raw), raw)["records"][0]
    assert row["routing"]["peer_address"] == "fe80::5c00:ff:fe02:7"
    assert row["routing"]["vrf"] == "default"
    assert row["routing"]["address_family"] == "ipv6 unicast"
    assert row["routing"]["scope_supported"] is False


@requires_genie
def test_named_mode_empty_table_and_nondefault_empty_scope():
    named = EMPTY.replace("EIGRP-IPv4 Neighbors", "EIGRP-IPv4 VR(CAMPUS) Address-Family Neighbors")
    response = server.handle_request(request(named))
    assert response["type"] == "done" and response["result"] == {"status": "completed", "records": []}
    for raw in (named.replace("AS(100)", "AS(100) VRF(blue)"), named.replace("IPv4", "IPv6")):
        assert server.handle_request(request(raw))["type"] == "error"


@pytest.mark.parametrize("named", [False, True])
@pytest.mark.parametrize("prefix", ["", "Device#show ip eigrp neighbors\n"])
@requires_genie
def test_explicit_default_vrf_empty_table_is_completed(named, prefix):
    raw = EMPTY.replace("AS(100)", "AS(100) VRF(default)")
    if named:
        raw = raw.replace("EIGRP-IPv4 Neighbors", "EIGRP-IPv4 VR(CAMPUS) Address-Family Neighbors")
    response = server.handle_request(request(prefix + raw))
    assert response["type"] == "done", response
    assert response["result"] == {"status": "completed", "records": []}
    for invalid in (raw.replace("VRF(default)", "VRF(blue)"), raw.replace("IPv4", "IPv6"), raw + "junk\n"):
        assert server.handle_request(request(prefix + invalid))["type"] == "error"


@requires_genie
def test_unknown_address_family_is_preserved_not_assumed_ipv4():
    envelope = parse_show("cisco", "iosxe", COMMAND, RAW)
    families = envelope["data"]["eigrp_instance"]["100"]["vrf"]["default"]["address_family"]
    families["unknown-af"] = families.pop("ipv4")
    row = normalize_neighbors("eigrp", envelope, include_evidence=True)[0]
    assert row["routing"]["address_family"] == "unknown-af"
    assert row["routing"]["scope_supported"] is False


@pytest.mark.parametrize("data", [
    {"eigrp_instance": {"100": {"vrf": []}}},
    {"eigrp_instance": {"100": {"vrf": {"default": {"address_family": []}}}}},
    {"eigrp_instance": {"100": {"vrf": {"default": {"address_family": {"ipv4": None}}}}}},
])
def test_malformed_nested_schema_cannot_be_empty_success(data):
    with pytest.raises(ValueError, match="did not establish records"):
        normalize_neighbor_capture("eigrp", {"parser": "genie", "data": data}, "junk")
