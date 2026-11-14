import pytest
import struct
from pathlib import Path

FIXTURES_DIR = Path(__file__).parent.parent / "fixtures"
PCAP_PATH = FIXTURES_DIR / "tiny.pcap"


@pytest.fixture(scope="session", autouse=True)
def _ensure_tiny_pcap():
    """Build a 3-packet ICMP echo fixture at tests/fixtures/tiny.pcap.

    Encode the offline fixture directly; Scapy imports inspect host routes.
    """
    if PCAP_PATH.exists():
        return PCAP_PATH
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    def checksum(data):
        total = sum(struct.unpack(f"!{len(data) // 2}H", data))
        total = (total & 0xFFFF) + (total >> 16)
        total = (total & 0xFFFF) + (total >> 16)
        return (~total) & 0xFFFF

    with PCAP_PATH.open("wb") as capture:
        capture.write(struct.pack("<IHHIIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, 1))
        for sequence in range(3):
            icmp = struct.pack("!BBHHH", 8, 0, 0, 1, sequence)
            icmp = icmp[:2] + struct.pack("!H", checksum(icmp)) + icmp[4:]
            ip = struct.pack(
                "!BBHHHBBH4s4s", 0x45, 0, 28, sequence, 0, 64, 1, 0,
                bytes([10, 0, 0, 1]), bytes([10, 0, 0, 2]),
            )
            ip = ip[:10] + struct.pack("!H", checksum(ip)) + ip[12:]
            packet = bytes.fromhex("0200000000020200000000010800") + ip + icmp
            capture.write(struct.pack("<IIII", 1700000000 + sequence, 0, len(packet), len(packet)))
            capture.write(packet)
    return PCAP_PATH
