"""Stateless nmap scan operations.

Each builds an argv, calls client.run_nmap, parses the XML, and returns a plain
dict. Errors surface as {"ok": False, "error": ...} — never raw tracebacks.
"""
from __future__ import annotations

import re
from typing import Any

from ccie_sidecar.nmap_api import client, parse

# Output flags the agent must not smuggle in via custom() — we own -oX -.
_OUTPUT_FLAGS = {"-oN", "-oX", "-oG", "-oA", "-oS"}
# Shell metacharacters that have no place in a target spec.
_META = re.compile(r"[;&|`$><\\\n]")


def _ok(**kw: Any) -> dict[str, Any]:
    return {"ok": True, **kw}


def _err(op: str, e: Exception) -> dict[str, Any]:
    return {"ok": False, "error": f"{op}: {e}"}


def _targets(targets: str | list[str]) -> list[str]:
    return targets.split() if isinstance(targets, str) else list(targets)


def _scan(op: str, flags: list[str], targets: str | list[str], *, privileged: bool = False) -> dict[str, Any]:
    res = client.run_nmap([*flags, *_targets(targets)], privileged=privileged)
    if not res.get("ok"):
        return res
    try:
        return _ok(**parse.parse_nmap_xml(res["raw_xml"]))
    except Exception as e:  # noqa: BLE001
        return _err(op, e)


def discover_hosts(targets: str | list[str]) -> dict[str, Any]:
    """Host sweep (ping scan, -sn) — which hosts are up. Unprivileged."""
    return _scan("discover_hosts", ["-sn"], targets)


def scan_ports(targets: str | list[str], ports: str | None = None) -> dict[str, Any]:
    """TCP connect port scan (-sT). Optional `ports` e.g. '22,80,443' or '1-1024'. Unprivileged."""
    flags = ["-sT"] + (["-p", ports] if ports else [])
    return _scan("scan_ports", flags, targets)


def service_scan(targets: str | list[str], ports: str | None = None) -> dict[str, Any]:
    """Version + default-NSE scan (-sV -sC) — the primary 'what app is running' scan. Unprivileged."""
    flags = ["-sV", "-sC"] + (["-p", ports] if ports else [])
    return _scan("service_scan", flags, targets)


def os_detect(targets: str | list[str]) -> dict[str, Any]:
    """OS fingerprint (-O). PRIVILEGED — may trigger an admin prompt on macOS."""
    return _scan("os_detect", ["-O"], targets, privileged=True)


def deep_scan(targets: str | list[str]) -> dict[str, Any]:
    """Aggressive scan (-A): OS + version + scripts + traceroute — deepest classify. PRIVILEGED."""
    return _scan("deep_scan", ["-A"], targets, privileged=True)


def custom(targets: str | list[str], flags: str | list[str]) -> dict[str, Any]:
    """Escape hatch: run nmap with arbitrary `flags`. Output flags are stripped and
    shell metacharacters in `targets` are rejected. Unprivileged."""
    tgts = _targets(targets)
    for t in tgts:
        if _META.search(t):
            return {"ok": False, "error": f"Illegal characters in target '{t}'."}
    flag_list = flags.split() if isinstance(flags, str) else list(flags)
    flag_list = [f for f in flag_list if f not in _OUTPUT_FLAGS]
    return _scan("custom", flag_list, tgts)
