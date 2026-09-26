"""The `nmap` object agents call inside execute_python_code.

Thin dispatcher over ops with catalog-backed discovery. No confirm gate — scans
run immediately (privileged scans may trigger a one-shot admin prompt on macOS).
"""
from __future__ import annotations

from ccie_sidecar.nmap_api import catalog, ops


class NmapFacade:
    # ---- discovery ----
    def help(self, topic: str | None = None) -> str:
        return catalog.help(topic)

    def search(self, query: str) -> list[str]:
        return catalog.search(query)

    # ---- scans ----
    def discover_hosts(self, targets):
        return ops.discover_hosts(targets)

    def scan_ports(self, targets, ports=None):
        return ops.scan_ports(targets, ports)

    def service_scan(self, targets, ports=None):
        return ops.service_scan(targets, ports)

    def os_detect(self, targets):
        return ops.os_detect(targets)

    def deep_scan(self, targets):
        return ops.deep_scan(targets)

    def custom(self, targets, flags):
        return ops.custom(targets, flags)
