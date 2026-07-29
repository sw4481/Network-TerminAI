import shutil
from pathlib import Path

import pytest

from ccie_sidecar.parsers.pcap import (
    PcapInvalidFilterError,
    packet_bytes,
    summarize_pcap,
)

# These tests spawn tshark (via pyshark). Skip when it isn't installed (e.g. CI
# runners without Wireshark); they still run locally where tshark is present.
pytestmark = pytest.mark.skipif(
    shutil.which("tshark") is None, reason="tshark (Wireshark) not installed"
)

FIXTURE = Path(__file__).parent.parent / "fixtures" / "tiny.pcap"


def test_summarize_pcap_returns_packet_count():
    result = summarize_pcap(str(FIXTURE), max_packets=10)
    assert result["packet_count"] == 3
    assert "packets" in result
    assert result["packets"][0]["protocol"] in ("ICMP", "IP")


def test_summarize_pcap_caps_at_max_packets():
    result = summarize_pcap(str(FIXTURE), max_packets=2)
    assert result["packet_count"] == 3
    assert len(result["packets"]) == 2


def test_summarize_pcap_display_filter_narrows_results():
    # tiny.pcap holds 3 ICMP packets; an "icmp" filter keeps all 3,
    # a contradictory "tcp" filter keeps zero.
    icmp = summarize_pcap(str(FIXTURE), max_packets=10, display_filter="icmp")
    assert icmp["packet_count"] == 3
    tcp = summarize_pcap(str(FIXTURE), max_packets=10, display_filter="tcp")
    assert tcp["packet_count"] == 0


def test_summarize_pcap_invalid_display_filter_raises():
    with pytest.raises(PcapInvalidFilterError):
        summarize_pcap(
            str(FIXTURE), max_packets=10, display_filter="this is not a filter"
        )


def test_packet_bytes_returns_hex_and_ascii():
    bytes_ = packet_bytes(str(FIXTURE), 1)
    assert "hex" in bytes_ and "ascii" in bytes_ and "length" in bytes_
    assert bytes_["length"] > 0
    # Hex view should have one byte per pair (space-separated).
    pairs = bytes_["hex"].split()
    assert all(len(p) == 2 for p in pairs)
    assert len(pairs) == bytes_["length"]


def test_packet_bytes_out_of_range_raises():
    with pytest.raises(IndexError):
        packet_bytes(str(FIXTURE), 999)


def test_summarize_missing_file_raises():
    with pytest.raises(Exception):
        summarize_pcap("/no/such/path.pcap", max_packets=10)
