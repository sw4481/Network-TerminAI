import pytest
from pathlib import Path

FIXTURES_DIR = Path(__file__).parent.parent / "fixtures"
PCAP_PATH = FIXTURES_DIR / "tiny.pcap"


@pytest.fixture(scope="session", autouse=True)
def _ensure_tiny_pcap():
    """Build a 3-packet ICMP echo fixture at tests/fixtures/tiny.pcap.

    Deterministic synthesized pcap via scapy. Avoids committing a binary
    fixture to git and avoids needing sudo to capture live traffic.
    """
    if PCAP_PATH.exists():
        return PCAP_PATH
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    from scapy.all import IP, ICMP, Ether, wrpcap
    pkts = [
        Ether() / IP(src="10.0.0.1", dst="10.0.0.2") / ICMP(type=8, seq=i)
        for i in range(3)
    ]
    wrpcap(str(PCAP_PATH), pkts)
    return PCAP_PATH
