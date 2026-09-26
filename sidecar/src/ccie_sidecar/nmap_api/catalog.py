"""nmap capability catalog — drives on-demand discovery.

Agents call nmap.help() / nmap.search() instead of receiving tool schemas. Each
Capability doc states whether the scan needs elevation. `risk` is documentation
only — there is no confirm gate.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Capability:
    name: str
    group: str
    signature: str
    doc: str
    risk: str  # "read" | "privileged"


CAPABILITIES: list[Capability] = [
    Capability("discover_hosts", "discovery", "discover_hosts(targets)",
               "Ping sweep (-sn) to find which hosts are up on a target/subnet e.g. '192.168.2.0/24'. Unprivileged.", "read"),
    Capability("scan_ports", "ports", "scan_ports(targets, ports=None)",
               "TCP connect port scan (-sT). `ports` optional e.g. '22,80,443' or '1-1024'. Unprivileged.", "read"),
    Capability("service_scan", "services", "service_scan(targets, ports=None)",
               "Version + default-NSE scan (-sV -sC): identifies the product and version behind each open port. The primary 'what app is running' scan. Unprivileged.", "read"),
    Capability("os_detect", "os", "os_detect(targets)",
               "OS fingerprint (-O): guesses host/OS type. PRIVILEGED — may trigger a one-shot admin prompt on macOS.", "privileged"),
    Capability("deep_scan", "os", "deep_scan(targets)",
               "Aggressive scan (-A): OS detection + version + scripts + traceroute. Deepest 'classify this device' scan. PRIVILEGED — may trigger an admin prompt on macOS.", "privileged"),
    Capability("custom", "advanced", "custom(targets, flags)",
               "Escape hatch: run nmap with arbitrary flags e.g. '-sU -p 161'. Output flags (-oX etc.) are stripped and shell metacharacters in targets are rejected. Unprivileged.", "read"),
]

_BY_NAME = {c.name: c for c in CAPABILITIES}


def help(topic: str | None = None) -> str:
    """Compact grouped listing; with a topic, full signatures + docs for matches."""
    if topic:
        t = topic.lower()
        matches = [c for c in CAPABILITIES if t in c.name.lower() or t in c.group.lower() or t in c.doc.lower()]
        if not matches:
            return f"No nmap capabilities match '{topic}'. Call nmap.help() to list all."
        lines = [f"nmap capabilities matching '{topic}':", ""]
        for c in matches:
            lines.append(f"nmap.{c.signature}")
            lines.append(f"    [{c.risk}] {c.doc}")
            lines.append("")
        return "\n".join(lines).rstrip()
    lines = ["nmap capabilities (call nmap.help('<topic>') for signatures):", ""]
    groups: dict[str, list[Capability]] = {}
    for c in CAPABILITIES:
        groups.setdefault(c.group, []).append(c)
    for group in sorted(groups):
        lines.append(f"# {group}")
        for c in groups[group]:
            summary = c.doc.split(".")[0]
            tag = " (privileged)" if c.risk == "privileged" else ""
            lines.append(f"  {c.name} — {summary}{tag}")
        lines.append("")
    return "\n".join(lines).rstrip()


def search(query: str) -> list[str]:
    """Capability names whose name or doc contains `query` (case-insensitive)."""
    q = query.lower()
    return [c.name for c in CAPABILITIES if q in c.name.lower() or q in c.doc.lower()]


def get(name: str) -> Capability | None:
    return _BY_NAME.get(name)
