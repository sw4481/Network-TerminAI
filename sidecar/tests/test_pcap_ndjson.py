"""Round-trip tests for the Plan 11 sidecar pcap.* NDJSON methods.

We invoke `handle_request` directly (no stdio loop) so the assertions stay
deterministic without depending on tshark spawn timing.
"""
import shutil
from pathlib import Path

import pytest

from ccie_sidecar.server import handle_request

FIXTURE = Path(__file__).parent / "fixtures" / "tiny.pcap"

# tshark (via pyshark) is required for the round-trip tests below. Skip them
# when it's absent (e.g. CI without Wireshark); param-validation tests that
# never spawn tshark still run everywhere.
requires_tshark = pytest.mark.skipif(
    shutil.which("tshark") is None, reason="tshark (Wireshark) not installed"
)


def _req(method: str, params: dict, req_id: str = "x") -> dict:
    return handle_request({"id": req_id, "method": method, "params": params})


@requires_tshark
def test_summarize_round_trip():
    resp = _req("pcap.summarize", {"path": str(FIXTURE), "max_packets": 5})
    assert resp["type"] == "done", resp
    assert resp["result"]["packet_count"] == 3
    assert len(resp["result"]["packets"]) == 3


@requires_tshark
def test_summarize_with_display_filter():
    resp = _req(
        "pcap.summarize",
        {"path": str(FIXTURE), "max_packets": 5, "display_filter": "icmp"},
    )
    assert resp["type"] == "done"
    assert resp["result"]["packet_count"] == 3


def test_summarize_invalid_filter_returns_error_with_invalid_filter_code():
    resp = _req(
        "pcap.summarize",
        {"path": str(FIXTURE), "display_filter": "garbage filter expression"},
    )
    assert resp["type"] == "error"
    assert "invalid_filter" in resp["message"]


def test_summarize_missing_file_returns_error():
    resp = _req("pcap.summarize", {"path": "/no/such/path.pcap"})
    assert resp["type"] == "error"


def test_summarize_requires_path():
    resp = _req("pcap.summarize", {})
    assert resp["type"] == "error"
    assert "path" in resp["message"]


@requires_tshark
def test_packet_bytes_round_trip():
    resp = _req("pcap.packet_bytes", {"path": str(FIXTURE), "index": 1})
    assert resp["type"] == "done"
    assert resp["result"]["length"] > 0
    assert "hex" in resp["result"] and "ascii" in resp["result"]


@requires_tshark
def test_packet_bytes_out_of_range_returns_error():
    resp = _req("pcap.packet_bytes", {"path": str(FIXTURE), "index": 999})
    assert resp["type"] == "error"
    assert "out_of_range" in resp["message"]


def test_finding_rules_round_trip_is_stable():
    resp = _req("pcap.finding_rules", {})
    assert resp["type"] == "done"
    assert len(resp["result"]) == 17
    assert all(rule["enabled_by_default"] for rule in resp["result"])


@requires_tshark
def test_findings_round_trip_uses_default_rules():
    resp = _req("pcap.findings", {"path": str(FIXTURE)})
    assert resp["type"] == "done", resp
    assert resp["result"]["scanned_packets"] == 3
    assert resp["result"]["scan_truncated"] is False


def test_findings_reject_non_array_rule_ids():
    resp = _req(
        "pcap.findings",
        {"path": str(FIXTURE), "enabled_rule_ids": "dns.response_error"},
    )
    assert resp["type"] == "error"
    assert "string array" in resp["message"]


def test_findings_reject_unknown_rule_ids():
    resp = _req(
        "pcap.findings",
        {"path": str(FIXTURE), "enabled_rule_ids": ["custom.rule"]},
    )
    assert resp["type"] == "error"
    assert "invalid_rules" in resp["message"]
