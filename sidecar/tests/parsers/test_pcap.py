import shutil
import io
import csv
from pathlib import Path

import pytest
from ccie_sidecar.parsers import pcap as pcap_module

from ccie_sidecar.parsers.pcap import (
    PcapInvalidFilterError,
    packet_bytes,
    summarize_pcap,
)

# These tests spawn tshark (via pyshark). Skip when it isn't installed (e.g. CI
# runners without Wireshark); they still run locally where tshark is present.
requires_tshark = pytest.mark.skipif(
    shutil.which("tshark") is None, reason="tshark (Wireshark) not installed"
)

FIXTURE = Path(__file__).parent.parent / "fixtures" / "tiny.pcap"


@requires_tshark
def test_summarize_pcap_returns_packet_count():
    result = summarize_pcap(str(FIXTURE), max_packets=10)
    assert result["packet_count"] == 3
    assert "packets" in result
    assert result["packets"][0]["protocol"] in ("ICMP", "IP")


@requires_tshark
def test_summarize_pcap_caps_at_max_packets():
    result = summarize_pcap(str(FIXTURE), max_packets=2)
    assert result["packet_count"] == 3
    assert len(result["packets"]) == 2


@requires_tshark
def test_summarize_pcap_display_filter_narrows_results():
    # tiny.pcap holds 3 ICMP packets; an "icmp" filter keeps all 3,
    # a contradictory "tcp" filter keeps zero.
    icmp = summarize_pcap(str(FIXTURE), max_packets=10, display_filter="icmp")
    assert icmp["packet_count"] == 3
    tcp = summarize_pcap(str(FIXTURE), max_packets=10, display_filter="tcp")
    assert tcp["packet_count"] == 0


@requires_tshark
def test_summarize_pcap_invalid_display_filter_raises():
    with pytest.raises(PcapInvalidFilterError):
        summarize_pcap(
            str(FIXTURE), max_packets=10, display_filter="this is not a filter"
        )


@requires_tshark
def test_packet_bytes_returns_hex_and_ascii():
    bytes_ = packet_bytes(str(FIXTURE), 1)
    assert "hex" in bytes_ and "ascii" in bytes_ and "length" in bytes_
    assert bytes_["length"] > 0
    # Hex view should have one byte per pair (space-separated).
    pairs = bytes_["hex"].split()
    assert all(len(p) == 2 for p in pairs)
    assert len(pairs) == bytes_["length"]


@requires_tshark
def test_packet_bytes_out_of_range_raises():
    with pytest.raises(IndexError):
        packet_bytes(str(FIXTURE), 999)


@requires_tshark
def test_summarize_missing_file_raises():
    with pytest.raises(Exception):
        summarize_pcap("/no/such/path.pcap", max_packets=10)


def _finding_row(number: int, **signals: str) -> list[str]:
    values = {field: "" for field in pcap_module._FINDING_FIELDS}
    values.update(
        {
            "frame.number": str(number),
            "frame.time_epoch": f"1700000000.{number:06d}",
            "ip.src": "192.0.2.1",
            "ip.dst": "198.51.100.2",
            "_ws.col.Protocol": "TEST",
            "frame.len": "128",
        }
    )
    values.update(signals)
    return [values[field] for field in pcap_module._FINDING_FIELDS]


def test_finding_rules_are_fixed_unique_and_enabled_by_default():
    rules = pcap_module.finding_rules()
    assert len(rules) == 17
    assert [rule["rule_id"] for rule in rules] == sorted(
        rule["rule_id"] for rule in rules
    )
    assert len({rule["rule_id"] for rule in rules}) == 17
    assert all(rule["enabled_by_default"] for rule in rules)


def test_findings_match_every_rule_in_one_row_and_sort_deterministically():
    enabled = [rule["rule_id"] for rule in pcap_module.finding_rules()]
    row = _finding_row(
        1,
        **{
            "dns.flags.response": "1",
            "dns.flags.rcode": "3",
            "tcp.analysis.retransmission": "1",
            "tcp.flags.reset": "1",
            "tcp.analysis.zero_window": "1",
            "icmp.type": "3",
            "tls.alert_message": "1",
            "dhcp.option.dhcp": "6",
            "dhcpv6.status_code": "2",
            "arp.duplicate-address-detected": "1",
            "bgp.type": "3",
            "http.response.code": "404,503",
            "smb2.nt_status": "0xc0000001",
            "kerberos.error_code": "6",
            "ssh.message_code": "1",
            "_ws.malformed": "1",
            "ip.checksum_bad.expert": "1",
        },
    )
    result = pcap_module._parse_findings_rows([row], enabled)
    assert len(result["findings"]) == 17
    assert all(finding["count"] == 1 for finding in result["findings"])
    order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
    sort_keys = [
        (order[finding["severity"]], finding["rule_id"])
        for finding in result["findings"]
    ]
    assert sort_keys == sorted(sort_keys)


def test_findings_evidence_and_scan_are_bounded():
    rows = [
        _finding_row(
            number,
            **{"dns.flags.response": "1", "dns.flags.rcode": "2"},
        )
        for number in range(1, 26)
    ]
    rows.append(_finding_row(pcap_module.FINDINGS_SCAN_LIMIT))
    result = pcap_module._parse_findings_rows(rows, ["dns.response_error"])
    finding = result["findings"][0]
    assert finding["count"] == 25
    assert len(finding["evidence"]) == 20
    assert finding["evidence_truncated"] is True
    assert result["scan_truncated"] is True
    assert result["scanned_packets"] == pcap_module.FINDINGS_SCAN_LIMIT


def test_findings_reject_unknown_rule_before_launch(tmp_path):
    capture = tmp_path / "capture.pcap"
    capture.write_bytes(b"pcap")
    with pytest.raises(pcap_module.PcapInvalidFindingRulesError):
        pcap_module.pcap_findings(str(capture), ["user.authored.rule"])


def test_findings_launch_one_bounded_tshark_pass(monkeypatch, tmp_path):
    capture = tmp_path / "capture.pcap"
    capture.write_bytes(b"pcap")
    row = _finding_row(
        2,
        **{"dns.flags.response": "1", "dns.flags.rcode": "3"},
    )
    output = io.StringIO()
    writer = csv.writer(output, delimiter="\t", quotechar='"', quoting=csv.QUOTE_ALL)
    writer.writerow(row)
    output.write(
        "| 0.000 <> 1.000 |      3 |   384 |\n"
    )
    calls = []

    class FakeProcess:
        stdout = io.StringIO(output.getvalue())
        stderr = io.StringIO("")

        @staticmethod
        def wait():
            return 0

    monkeypatch.setattr(pcap_module.shutil, "which", lambda _name: "/mock/tshark")
    monkeypatch.setattr(
        pcap_module.subprocess,
        "Popen",
        lambda command, **_kwargs: calls.append(command) or FakeProcess(),
    )
    result = pcap_module.pcap_findings(str(capture), ["dns.response_error"])
    assert len(calls) == 1
    assert calls[0][calls[0].index("-c") + 1] == "250000"
    assert "dns.flags.rcode" in calls[0][calls[0].index("-Y") + 1]
    assert result["scanned_packets"] == 3
    assert result["findings"][0]["count"] == 1


def test_findings_maps_unsupported_tshark_field_error(monkeypatch, tmp_path):
    capture = tmp_path / "capture.pcap"
    capture.write_bytes(b"pcap")

    class FakeProcess:
        stdout = io.StringIO("")
        stderr = io.StringIO("foo isn't a valid protocol or protocol field")

        @staticmethod
        def wait():
            return 2

    monkeypatch.setattr(pcap_module.shutil, "which", lambda _name: "/mock/tshark")
    monkeypatch.setattr(pcap_module.subprocess, "Popen", lambda *_args, **_kwargs: FakeProcess())
    with pytest.raises(pcap_module.PcapUnsupportedFindingFilterError):
        pcap_module.pcap_findings(str(capture), ["dns.response_error"])
