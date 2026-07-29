"""Live packet-capture lifecycle driver (pyATS / unicon).

Why pyATS and not one-shot `ssh host "cmd"`: Cisco IOS-XE EPC ties the capture
to the session that started it — when a one-shot SSH session closes after
`monitor capture CAP start`, the capture is torn down ("Capture CAP is not
active"), so the buffer is empty at export time. The whole lifecycle
(setup -> start -> wait -> stop -> export) must run inside ONE persistent
session at the device prompt, which unicon handles natively (prompt detection,
paging, enable mode). Verified against a live Catalyst 9000 (IOS-XE 17.19).

The on-box `.pcap` is exported to flash and then pulled off-box by the caller
(Rust) over SCP — these switches run an SCP server but no SFTP subsystem.

This module is intentionally self-contained and returns plain dicts so the
RPC layer (`pcap.run_capture`) can serialize results directly.
"""
from __future__ import annotations

import re
import time
from typing import Any, Optional

# Vendor → on-box export filesystem default (basename is fixed to CAP.pcap).
_EXPORT_PATH = {
    "iosxe": "flash:CAP.pcap",
    "nxos": "bootflash:CAP.pcap",
}


def _build_iosxe_lines(name: str, interface: str, acl: Optional[str], duration_s: int,
                       buffer_mb: int, export_path: str) -> dict:
    match_line = (
        f"monitor capture {name} match access-list {acl}"
        if acl else f"monitor capture {name} match any"
    )
    return {
        "setup": [
            f"monitor capture {name} interface {interface} both",
            match_line,
            f"monitor capture {name} buffer circular size {buffer_mb}",
            f"monitor capture {name} limit duration {duration_s}",
        ],
        "start": f"monitor capture {name} start",
        "stop": f"monitor capture {name} stop",
        "export": f"monitor capture {name} export location {export_path}",
        "cleanup": f"no monitor capture {name}",
    }


def run_capture(
    host: str,
    username: str,
    password: str,
    interface: str,
    duration_s: int,
    *,
    device_kind: str = "iosxe",
    acl: Optional[str] = None,
    buffer_mb: int = 10,
    capture_name: str = "CAP",
    port: int = 22,
    connect_fn=None,
) -> dict[str, Any]:
    """Run a packet capture to completion in one persistent session.

    Returns {"ok": True, "export_path": "flash:CAP.pcap", "export_basename":
    "CAP.pcap", "status": "<final status text>"} on success, or
    {"ok": False, "error": "..."} on failure. Never raises.

    `connect_fn` is injectable for tests; production builds a real unicon
    Connection. The pcap is left on the device's flash for the caller to pull
    over SCP (the export filesystem is returned in `export_path`).
    """
    if device_kind != "iosxe":
        return {"ok": False, "error": f"pcap.run_capture supports iosxe only (got {device_kind})"}

    name = re.sub(r"[^A-Za-z0-9_]", "", capture_name).upper()[:15] or "CAP"
    export_path = _EXPORT_PATH.get(device_kind, "flash:CAP.pcap")
    script = _build_iosxe_lines(name, interface, acl, duration_s, buffer_mb, export_path)

    conn = None
    try:
        conn = (connect_fn or _default_connect)(host, username, password, port)

        def ex(cmd: str, timeout: int = 60) -> str:
            # error_pattern=[] so a device "% Invalid" doesn't raise here; we
            # surface failures via explicit checks on the returned text.
            return conn.execute(cmd, timeout=timeout, error_pattern=[])

        # Clean any stale capture point from a prior run.
        ex(f"monitor capture {name} stop")
        ex(f"no monitor capture {name}")

        for line in script["setup"]:
            out = ex(line)
            if "% Invalid" in out or "Invalid input" in out:
                return {"ok": False, "error": f"setup rejected: {line!r} -> {out.strip()[:200]}"}

        start_out = ex(script["start"])
        if "Unable to" in start_out or "% Invalid" in start_out:
            return {"ok": False, "error": f"start failed: {start_out.strip()[:200]}"}

        # `limit duration` auto-stops the capture; wait it out (+ slack) in the
        # SAME session so the capture isn't torn down by a session close.
        time.sleep(duration_s + 4)
        ex(script["stop"])

        export_out = ex(script["export"], timeout=120)
        if "Export Started Successfully" not in export_out and "Exported Successfully" not in export_out:
            return {"ok": False, "error": f"export failed: {export_out.strip()[:200]}"}

        # Give the box a moment to finish writing the file before SCP pull.
        time.sleep(2)
        status = ex(f"show monitor capture {name} | include Status")
        ex(script["cleanup"])

        return {
            "ok": True,
            "export_path": export_path,
            "export_basename": export_path.split(":")[-1].split("/")[-1],
            "status": status.strip()[:200],
        }
    except Exception as e:  # never raise across the RPC boundary
        return {"ok": False, "error": f"{type(e).__name__}: {str(e)[:300]}"}
    finally:
        if conn is not None:
            try:
                conn.disconnect()
            except Exception:
                pass


def _default_connect(host: str, username: str, password: str, port: int):
    """Build a real unicon Connection to an IOS-XE device. Imported lazily so
    tests that inject `connect_fn` never need pyATS installed."""
    from unicon import Connection

    start = [
        f"ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "
        f"-o PubkeyAuthentication=no -p {port} {username}@{host}"
    ]
    conn = Connection(
        hostname="device",
        start=start,
        os="iosxe",
        credentials={"default": {"username": username, "password": password}},
        learn_hostname=True,
        log_stdout=False,
        connection_timeout=40,
    )
    conn.connect(connection_timeout=40)
    return conn
