"""Unit tests for the nmap code-API."""
from __future__ import annotations

import subprocess

import pytest

from ccie_sidecar.nmap_api import catalog, client, ops, parse
from ccie_sidecar.nmap_api.facade import NmapFacade

# Trimmed real nmap -oX - output (scanme.nmap.org, -sV -sC) plus a synthetic os block.
SAMPLE_XML = """<?xml version="1.0"?>
<nmaprun scanner="nmap" version="7.99">
<host><status state="up" reason="syn-ack"/>
<address addr="45.33.32.156" addrtype="ipv4"/>
<hostnames><hostname name="scanme.nmap.org" type="PTR"/></hostnames>
<ports>
<port protocol="tcp" portid="22"><state state="open"/>
<service name="ssh" product="OpenSSH" version="6.6.1p1 Ubuntu 2ubuntu2.13" extrainfo="Ubuntu Linux; protocol 2.0" ostype="Linux">
<cpe>cpe:/a:openbsd:openssh:6.6.1p1</cpe><cpe>cpe:/o:linux:linux_kernel</cpe></service></port>
<port protocol="tcp" portid="80"><state state="open"/>
<service name="http" product="Apache httpd" version="2.4.7" extrainfo="(Ubuntu)">
<cpe>cpe:/a:apache:http_server:2.4.7</cpe></service></port>
</ports>
<os><osmatch name="Linux 3.2 - 4.9" accuracy="95">
<osclass type="general purpose" vendor="Linux" osfamily="Linux" accuracy="95"/></osmatch></os>
</host>
</nmaprun>"""


def test_parse_extracts_host_ports_services_os():
    result = parse.parse_nmap_xml(SAMPLE_XML)
    assert len(result["hosts"]) == 1
    host = result["hosts"][0]
    assert host["state"] == "up"
    assert {"addr": "45.33.32.156", "addrtype": "ipv4"} in host["addresses"]
    assert host["hostnames"] == ["scanme.nmap.org"]

    ports = {p["portid"]: p for p in host["ports"]}
    assert ports["22"]["state"] == "open"
    assert ports["22"]["service"]["product"] == "OpenSSH"
    assert ports["22"]["service"]["version"].startswith("6.6.1p1")
    assert "cpe:/a:openbsd:openssh:6.6.1p1" in ports["22"]["service"]["cpe"]
    assert ports["80"]["service"]["name"] == "http"

    assert host["os"]["osmatch"][0]["name"] == "Linux 3.2 - 4.9"
    assert host["os"]["osclass"][0]["vendor"] == "Linux"


def test_run_nmap_not_installed(monkeypatch):
    monkeypatch.setattr(client.shutil, "which", lambda _: None)
    res = client.run_nmap(["-sn", "127.0.0.1"])
    assert res["ok"] is False
    assert "brew install nmap" in res["error"]


def test_run_nmap_appends_oX(monkeypatch):
    captured = {}

    def fake_run(argv, **kwargs):
        captured["argv"] = argv
        return subprocess.CompletedProcess(argv, 0, stdout=SAMPLE_XML, stderr="")

    monkeypatch.setattr(client.shutil, "which", lambda _: "/usr/bin/nmap")
    monkeypatch.setattr(client.subprocess, "run", fake_run)
    res = client.run_nmap(["-sT", "127.0.0.1"])
    assert res["ok"] is True
    assert captured["argv"][-2:] == ["-oX", "-"]


def test_run_nmap_privileged_non_root_non_macos(monkeypatch):
    monkeypatch.setattr(client.shutil, "which", lambda _: "/usr/bin/nmap")
    monkeypatch.setattr(client.os, "geteuid", lambda: 501)
    monkeypatch.setattr(client.platform, "system", lambda: "Linux")
    res = client.run_nmap(["-O", "127.0.0.1"], privileged=True)
    assert res["ok"] is False
    assert "needs root" in res["error"]


def test_ops_scan_ports(monkeypatch):
    monkeypatch.setattr(client, "run_nmap", lambda *a, **k: {"ok": True, "raw_xml": SAMPLE_XML})
    res = ops.scan_ports("45.33.32.156", ports="22,80")
    assert res["ok"] is True
    assert len(res["hosts"]) == 1


def test_ops_custom_rejects_metacharacters():
    res = ops.custom("127.0.0.1; rm -rf /", "-sT")
    assert res["ok"] is False
    assert "Illegal characters" in res["error"]


def test_ops_custom_strips_output_flags(monkeypatch):
    captured = {}

    def fake(argv, **k):
        captured["argv"] = argv
        return {"ok": True, "raw_xml": SAMPLE_XML}

    monkeypatch.setattr(client, "run_nmap", fake)
    ops.custom("127.0.0.1", "-sT -oN /tmp/leak")
    assert "-oN" not in captured["argv"]


def test_catalog_help_lists_all():
    listing = catalog.help()
    for cap in catalog.CAPABILITIES:
        assert cap.name in listing


def test_facade_methods_return_dicts(monkeypatch):
    monkeypatch.setattr(client, "run_nmap", lambda *a, **k: {"ok": True, "raw_xml": SAMPLE_XML})
    f = NmapFacade()
    assert isinstance(f.help(), str)
    assert f.service_scan("127.0.0.1")["ok"] is True
    assert f.discover_hosts("127.0.0.1")["ok"] is True
