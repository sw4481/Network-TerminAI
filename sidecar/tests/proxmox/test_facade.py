"""Facade: lazy api, help/search passthrough, confirm gating."""
from unittest.mock import MagicMock

import pytest

from ccie_sidecar.proxmox_api.facade import ProxmoxFacade


def _facade_with_mock_api(monkeypatch):
    fake_api = MagicMock()
    f = ProxmoxFacade(config_loader=lambda: {"host": "h", "user": "root@pam", "password": "p", "verify_ssl": False},
                      api_builder=lambda conf: fake_api)
    return f, fake_api


def test_help_and_search_delegate_to_catalog():
    f = ProxmoxFacade(config_loader=lambda: None, api_builder=lambda c: None)
    assert "get_nodes" in f.help()
    assert "rollback_snapshot" in f.search("revert")


def test_read_op_executes(monkeypatch):
    f, api = _facade_with_mock_api(monkeypatch)
    api.nodes.get.return_value = []
    out = f.get_nodes()
    assert out["ok"] is True


def test_high_risk_without_confirm_is_blocked(monkeypatch):
    f, api = _facade_with_mock_api(monkeypatch)
    out = f.delete_vm("pve1", "950")
    assert out["ok"] is False
    assert out["needs_confirm"] is True
    api.nodes.return_value.qemu.return_value.delete.assert_not_called()


def test_high_risk_with_confirm_executes(monkeypatch):
    f, api = _facade_with_mock_api(monkeypatch)
    api.nodes.return_value.qemu.return_value.delete.return_value = "UPID:del"
    out = f.delete_vm("pve1", "950", confirm=True)
    assert out["ok"] is True
    api.nodes.return_value.qemu.return_value.delete.assert_called_once()


def test_rollback_requires_confirm(monkeypatch):
    f, api = _facade_with_mock_api(monkeypatch)
    blocked = f.rollback_snapshot("pve1", "950", "s1")
    assert blocked["needs_confirm"] is True
    api.nodes.return_value.qemu.return_value.snapshot.return_value.rollback.post.return_value = "UPID"
    ok = f.rollback_snapshot("pve1", "950", "s1", confirm=True)
    assert ok["ok"] is True


def test_not_configured_returns_clear_error():
    f = ProxmoxFacade(config_loader=lambda: None, api_builder=lambda c: None)
    out = f.get_nodes()
    assert out["ok"] is False
    assert "not configured" in out["error"].lower()


def test_api_build_error_is_not_reported_as_not_configured():
    f = ProxmoxFacade(
        config_loader=lambda: {"host": "h", "user": "root@pam", "password": "p", "verify_ssl": False},
        api_builder=lambda c: (_ for _ in ()).throw(RuntimeError("bad token format")),
    )
    out = f.get_nodes()
    assert out["ok"] is False
    assert "bad token format" in out["error"]
    assert "not configured" not in out["error"].lower()
