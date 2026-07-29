"""NDJSON round-trip for the parse.request handler."""
import json
import subprocess
import sys

import pytest

from ccie_sidecar.parsers import genie_adapter

# `show version` on iosxe parses via Genie; the Windows build omits genie/pyats
# (no Windows wheels) and there's no TextFSM template for it either, so the
# round-trip would come back as an error. Skip on Windows; the unsupported-vendor
# error path below runs everywhere.
requires_genie = pytest.mark.skipif(
    genie_adapter._GENIE_IMPORT_ERROR is not None,
    reason="genie/pyats not installed (e.g. Windows build)",
)


def _read_response(proc: subprocess.Popen, req_id: str, max_lines: int = 10) -> dict:
    """Read stdout lines until one matches `req_id`.

    Since Task 3.3 (Plan 00 / Phase 3), the server emits a
    `sidecar.heartbeat` NDJSON line on startup and periodically after.
    Those lines have id="" and must be skipped so the test reads the real
    method response.
    """
    for _ in range(max_lines):
        line = proc.stdout.readline()
        if not line:
            break
        msg = json.loads(line)
        if str(msg.get("id", "")) == req_id:
            return msg
    raise AssertionError(f"no response with id={req_id!r} observed within {max_lines} lines")


@requires_genie
def test_parse_request_ndjson_roundtrip():
    proc = subprocess.Popen(
        [sys.executable, "-m", "ccie_sidecar.server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        req = {
            "id": "1",
            "method": "parse.request",
            "params": {
                "vendor": "cisco",
                "platform": "iosxe",
                "command": "show version",
                "raw": "Cisco IOS XE Software, Version 17.09.04",
            },
        }
        proc.stdin.write(json.dumps(req) + "\n")
        proc.stdin.flush()
        resp = _read_response(proc, "1")
    finally:
        proc.terminate()
        proc.wait(timeout=5)
    assert resp["id"] == "1"
    assert resp["type"] == "done"
    result = resp["result"]
    assert result["parser"] in ("genie", "textfsm")
    assert result["command"] == "show version"
    assert "data" in result


def test_parse_request_unsupported_returns_error():
    proc = subprocess.Popen(
        [sys.executable, "-m", "ccie_sidecar.server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        req = {
            "id": "2",
            "method": "parse.request",
            "params": {
                "vendor": "vendor_unknown",
                "platform": "os_unknown",
                "command": "show foo",
                "raw": "...",
            },
        }
        proc.stdin.write(json.dumps(req) + "\n")
        proc.stdin.flush()
        resp = _read_response(proc, "2")
    finally:
        proc.terminate()
        proc.wait(timeout=5)
    assert resp["id"] == "2"
    assert resp["type"] == "error"
    assert "no parser" in resp["message"].lower()
