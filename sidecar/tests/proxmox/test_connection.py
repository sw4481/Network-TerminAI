"""test_connection: validate a passed-in Proxmox config without saving it."""
from unittest.mock import MagicMock

from ccie_sidecar.proxmox_api import connection


def test_success_summarizes_nodes(monkeypatch):
    api = MagicMock()
    api.nodes.get.return_value = [
        {"node": "pve1", "status": "online"},
        {"node": "pve2", "status": "online"},
    ]
    api.nodes.return_value.status.get.return_value = {"uptime": 1, "cpuinfo": {"cpus": 4}, "memory": {}}
    monkeypatch.setattr(connection, "build_proxmox_api", lambda conf: api)
    out = connection.test_connection({"host": "h", "user": "root@pam", "password": "p", "verify_ssl": False})
    assert out["ok"] is True
    assert "2" in out["message"]  # node count surfaced
    assert "pve1" in out["message"]


def test_missing_host_is_friendly_error():
    out = connection.test_connection({"host": "", "user": "root@pam"})
    assert out["ok"] is False
    assert "host" in out["message"].lower()


def test_api_error_is_caught(monkeypatch):
    api = MagicMock()
    api.nodes.get.side_effect = Exception("401 authentication failure")
    monkeypatch.setattr(connection, "build_proxmox_api", lambda conf: api)
    out = connection.test_connection({"host": "h", "user": "root@pam", "password": "bad", "verify_ssl": False})
    assert out["ok"] is False
    assert "401" in out["message"] or "auth" in out["message"].lower()


def test_build_failure_is_caught(monkeypatch):
    def boom(conf):
        raise Exception("cannot resolve host")
    monkeypatch.setattr(connection, "build_proxmox_api", boom)
    out = connection.test_connection({"host": "nope", "user": "root@pam", "password": "p"})
    assert out["ok"] is False
    assert "cannot resolve host" in out["message"]
