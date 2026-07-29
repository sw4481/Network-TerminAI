"""Parse nmap `-oX -` XML into a compact structured dict.

Returns the "what device / what apps" payload — hosts with addresses, ports,
services (product/version) and OS guesses. Raw XML is never returned to the agent.
"""
from __future__ import annotations

from typing import Any

from lxml import etree


def _service(port_el: Any) -> dict[str, Any] | None:
    svc = port_el.find("service")
    if svc is None:
        return None
    out = {
        "name": svc.get("name"),
        "product": svc.get("product"),
        "version": svc.get("version"),
        "extrainfo": svc.get("extrainfo"),
        "ostype": svc.get("ostype"),
    }
    cpes = [c.text for c in svc.findall("cpe") if c.text]
    if cpes:
        out["cpe"] = cpes
    return {k: v for k, v in out.items() if v is not None}


def parse_nmap_xml(xml: str) -> dict[str, Any]:
    """nmap XML → {"hosts": [{addresses, hostnames, state, ports, os}]}."""
    root = etree.fromstring(xml.encode() if isinstance(xml, str) else xml)
    hosts: list[dict[str, Any]] = []

    for host in root.findall("host"):
        status = host.find("status")
        addresses = [
            {"addr": a.get("addr"), "addrtype": a.get("addrtype")}
            for a in host.findall("address")
        ]
        hostnames = [
            h.get("name") for h in host.findall("hostnames/hostname") if h.get("name")
        ]

        ports: list[dict[str, Any]] = []
        for p in host.findall("ports/port"):
            state = p.find("state")
            entry = {
                "protocol": p.get("protocol"),
                "portid": p.get("portid"),
                "state": state.get("state") if state is not None else None,
            }
            svc = _service(p)
            if svc:
                entry["service"] = svc
            ports.append(entry)

        os_info: dict[str, Any] = {}
        matches = [
            {"name": m.get("name"), "accuracy": m.get("accuracy")}
            for m in host.findall("os/osmatch")
        ]
        if matches:
            os_info["osmatch"] = matches
        classes = [
            {
                "type": c.get("type"), "vendor": c.get("vendor"),
                "osfamily": c.get("osfamily"), "accuracy": c.get("accuracy"),
            }
            for c in host.findall("os/osmatch/osclass") or host.findall("os/osclass")
        ]
        if classes:
            os_info["osclass"] = classes

        entry = {
            "addresses": addresses,
            "hostnames": hostnames,
            "state": status.get("state") if status is not None else None,
            "ports": ports,
        }
        if os_info:
            entry["os"] = os_info
        hosts.append(entry)

    return {"hosts": hosts}
