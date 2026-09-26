"""Locate and execute the `nmap` binary across privilege tiers.

nmap is a native CLI tool that must live on PATH (like terraform/tshark/sshpass);
we never bundle it. Privileged scans (-O/-sS/-A) need root: run directly if already
root, else prompt once via osascript on macOS, else return an elevation error.
"""
from __future__ import annotations

import os
import platform
import shlex
import shutil
import subprocess
from typing import Any


def find_nmap() -> str | None:
    """Return the path to the nmap binary, or None if not on PATH."""
    return shutil.which("nmap")


_NOT_INSTALLED = (
    "nmap is not installed. Install it with `brew install nmap` (macOS) or "
    "`apt install nmap` (Linux), then retry."
)


def run_nmap(argv: list[str], timeout: int = 300, privileged: bool = False) -> dict[str, Any]:
    """Run nmap with `argv`, always emitting XML to stdout (`-oX -`).

    Returns {"ok": True, "raw_xml": <stdout>} on success, else {"ok": False, "error": ...}.
    A non-zero exit that still produced usable XML on stdout is treated as success.
    """
    if find_nmap() is None:
        return {"ok": False, "error": _NOT_INSTALLED}

    full_argv = [*argv, "-oX", "-"]

    try:
        if not privileged or os.geteuid() == 0:
            proc = subprocess.run(
                ["nmap", *full_argv],
                capture_output=True, text=True, timeout=timeout,
            )
        elif platform.system() == "Darwin":
            # One-shot admin prompt (NOT a daemon). Shell-quote every arg.
            inner = "nmap " + " ".join(shlex.quote(a) for a in full_argv)
            script = f'do shell script {shlex.quote(inner)} with administrator privileges'
            proc = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True, text=True, timeout=timeout,
            )
        else:
            return {"ok": False, "error": (
                "OS/SYN scan needs root. Re-launch the app elevated, or give nmap "
                "cap_net_raw."
            )}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"nmap timed out after {timeout}s."}
    except Exception as e:  # noqa: BLE001 — surface any spawn failure as structured error
        return {"ok": False, "error": f"nmap failed to run: {e}"}

    xml = proc.stdout or ""
    if "<nmaprun" not in xml:
        err = (proc.stderr or "").strip() or "nmap produced no XML output."
        return {"ok": False, "error": err}
    return {"ok": True, "raw_xml": xml}
