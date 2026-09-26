"""NDJSON round-trip coverage for the `topology.neighbors` server method.

Mirrors `tests/test_parse_ndjson.py` so the new method gets the same
treatment (heartbeat skipping, end-to-end subprocess invocation).
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from ccie_sidecar.parsers import genie_adapter

FIX = Path(__file__).parent.parent / "fixtures"

# Parsing this Cisco CDP capture needs Genie, which the Windows build omits
# (no Windows wheels). Skip the round-trip there; the rejection-path tests
# below run everywhere.
requires_genie = pytest.mark.skipif(
    genie_adapter._GENIE_IMPORT_ERROR is not None,
    reason="genie/pyats not installed (e.g. Windows build)",
)


def _read_response(proc: subprocess.Popen, req_id: str, max_lines: int = 10) -> dict:
    for _ in range(max_lines):
        line = proc.stdout.readline()
        if not line:
            break
        msg = json.loads(line)
        if str(msg.get("id", "")) == req_id:
            return msg
    raise AssertionError(f"no response with id={req_id!r} observed within {max_lines} lines")


@requires_genie
def test_topology_neighbors_cdp_iosxe_ndjson():
    raw = (FIX / "show_cdp_neighbors_detail_iosxe.txt").read_text()
    proc = subprocess.Popen(
        [sys.executable, "-m", "ccie_sidecar.server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        req = {
            "id": "t1",
            "method": "topology.neighbors",
            "params": {
                "protocol": "cdp",
                "vendor": "cisco",
                "platform": "iosxe",
                "command": "show cdp neighbors detail",
                "raw": raw,
            },
        }
        proc.stdin.write(json.dumps(req) + "\n")
        proc.stdin.flush()
        resp = _read_response(proc, "t1")
    finally:
        proc.terminate()
        proc.wait(timeout=5)
    assert resp["id"] == "t1"
    assert resp["type"] == "done", resp
    records = resp["result"]["records"]
    assert isinstance(records, list) and records, records
    assert all(r["protocol"] == "cdp" for r in records)


def test_topology_neighbors_rejects_unknown_protocol():
    proc = subprocess.Popen(
        [sys.executable, "-m", "ccie_sidecar.server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        req = {
            "id": "t2",
            "method": "topology.neighbors",
            "params": {
                # Plan 13 Phase 5 expanded the accepted set to cdp/lldp/bgp
                # /ospf/isis; anything outside that union must still be
                # rejected with a clear error. ``eigrp`` is a representative
                # adjacent-but-unsupported routing protocol.
                "protocol": "eigrp",
                "vendor": "cisco",
                "platform": "iosxe",
                "command": "show ip eigrp neighbors",
                "raw": "junk",
            },
        }
        proc.stdin.write(json.dumps(req) + "\n")
        proc.stdin.flush()
        resp = _read_response(proc, "t2")
    finally:
        proc.terminate()
        proc.wait(timeout=5)
    assert resp["type"] == "error"
    assert "protocol" in resp["message"].lower()


def test_topology_neighbors_rejects_missing_params():
    proc = subprocess.Popen(
        [sys.executable, "-m", "ccie_sidecar.server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        req = {
            "id": "t3",
            "method": "topology.neighbors",
            "params": {"protocol": "cdp"},
        }
        proc.stdin.write(json.dumps(req) + "\n")
        proc.stdin.flush()
        resp = _read_response(proc, "t3")
    finally:
        proc.terminate()
        proc.wait(timeout=5)
    assert resp["type"] == "error"
    assert "vendor" in resp["message"].lower() or "raw" in resp["message"].lower()
