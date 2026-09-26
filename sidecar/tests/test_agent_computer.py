from __future__ import annotations

import importlib
from unittest.mock import Mock, patch

from ccie_sidecar.agent_computer import ComputerFacade, PctTransport
from ccie_sidecar.agent_computer_helper import install_computer


class _Response:
    def __init__(self, data: dict[str, object], status_code: int = 200) -> None:
        self._data = data
        self.status_code = status_code

    def json(self) -> dict[str, object]:
        return self._data

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


def test_computer_facade_lists_configured_computers_without_tokens():
    facade = ComputerFacade(config_loader=lambda: [{
        "name": "worker-1",
        "base_url": "http://10.0.0.10:8765",
        "token": "secret-token",
        "node": "pve1",
        "vmid": "120",
    }])

    assert facade.list() == [{
        "name": "worker-1",
        "base_url": "http://10.0.0.10:8765",
        "node": "pve1",
        "vmid": "120",
    }]


def test_computer_facade_health_calls_daemon_with_bearer_token():
    calls = []

    def request(method: str, url: str, **kwargs):
        calls.append((method, url, kwargs))
        return _Response({"ok": True, "hostname": "agent-lxc"})

    facade = ComputerFacade(
        config_loader=lambda: [{"name": "worker-1", "base_url": "http://127.0.0.1:8765", "token": "secret"}],
        request=request,
    )

    out = facade.health("worker-1")

    assert out["ok"] is True
    assert calls == [("GET", "http://127.0.0.1:8765/health", {"headers": {"Authorization": "Bearer secret"}, "timeout": 10})]


def test_command_execution_requires_confirm():
    request = Mock()
    facade = ComputerFacade(
        config_loader=lambda: [{"name": "worker-1", "base_url": "http://127.0.0.1:8765", "token": "secret"}],
        request=request,
    )

    out = facade.exec("worker-1", "whoami")

    assert out["ok"] is False
    assert out["needs_confirm"] is True
    request.assert_not_called()


def test_install_computer_registers_safe_global_and_importable_module():
    globals_dict: dict[str, object] = {}

    facade = install_computer(globals_dict)
    mod = importlib.import_module("computer")

    assert globals_dict["computer"] is facade
    assert mod.help() == facade.help()
    assert "health" in facade.help()
    assert "_call" not in dir(facade)
    assert "_config_loader" not in dir(facade)
    assert "ComputerFacade" not in facade.health.__globals__


def test_lan_http_base_url_is_rejected():
    request = Mock()
    facade = ComputerFacade(
        config_loader=lambda: [{"name": "worker-1", "base_url": "http://10.0.0.10:8765", "token": "secret"}],
        request=request,
    )

    out = facade.health("worker-1")

    assert out["ok"] is False
    assert "HTTPS" in out["error"]
    request.assert_not_called()


def test_pct_transport_handles_agent_computer_without_http_daemon():
    pct = Mock()
    pct.health.return_value = {"ok": True, "transport": "pct"}
    facade = ComputerFacade(
        config_loader=lambda: [{"name": "worker-1", "base_url": "pct://pve1/120", "token": "secret", "node": "pve1", "vmid": "120"}],
        request=Mock(),
        pct_transport=pct,
    )

    out = facade.health("worker-1")

    assert out == {"ok": True, "transport": "pct"}
    pct.health.assert_called_once()


def test_pct_transport_rejects_file_path_escape_before_pct_exec():
    pct = PctTransport(config_loader=lambda: {"host": "pve1"})
    pct._pct = Mock()

    out = pct.read_file({"base_url": "pct://pve1/120", "vmid": "120"}, "../secret")

    assert out["ok"] is False
    assert "outside root" in out["error"]
    pct._pct.assert_not_called()


def test_pct_transport_ssh_uses_configured_proxmox_host():
    pct = PctTransport(config_loader=lambda: {"host": "192.0.2.10", "user": "root@pam"})

    with patch("ccie_sidecar.agent_computer.subprocess.run") as run:
        run.return_value.returncode = 0
        run.return_value.stdout = "agent-lxc\n"
        run.return_value.stderr = ""
        pct.health({"base_url": "pct://pve1/120", "node": "pve1", "vmid": "120"})

    assert run.call_args.args[0][:2] == ["ssh", "root@192.0.2.10"]


def test_pct_transport_rejects_non_numeric_vmid_before_ssh():
    pct = PctTransport(config_loader=lambda: {"host": "192.0.2.10", "user": "root@pam"})

    with patch("ccie_sidecar.agent_computer.subprocess.run") as run:
        out = pct.health({"base_url": "pct://pve1/120;touch /tmp/host", "node": "pve1"})

    assert out["ok"] is False
    assert "Invalid VMID" in out["error"]
    run.assert_not_called()


def test_pct_transport_quotes_remote_shell_command():
    pct = PctTransport(config_loader=lambda: {"host": "192.0.2.10", "user": "root@pam"})

    with patch("ccie_sidecar.agent_computer.subprocess.run") as run:
        run.return_value.returncode = 0
        run.return_value.stdout = ""
        run.return_value.stderr = ""
        pct.exec({"base_url": "pct://pve1/120", "node": "pve1", "vmid": "120"}, "touch /tmp/container; touch /tmp/host")

    assert run.call_args.args[0][2] == "pct exec 120 -- /bin/sh -lc 'touch /tmp/container; touch /tmp/host'"


def test_sidecar_provisions_lxc_from_template():
    from ccie_sidecar.server import handle_request

    facade = Mock()
    facade.clone_container.return_value = {"ok": True, "upid": "UPID:clone"}
    facade.start_container.return_value = {"ok": True, "upid": "UPID:start"}

    with patch("ccie_sidecar.proxmox_api.facade.ProxmoxFacade", return_value=facade):
        resp = handle_request({
            "id": "1",
            "method": "agent_computer.provision",
            "params": {"computer": {"name": "worker-1", "node": "pve1", "vmid": "120", "templateVmid": "9000", "baseUrl": "", "token": ""}},
        })

    result = resp["result"]
    assert result["ok"] is True
    assert result["computer"]["baseUrl"] == "pct://pve1/120"
    assert result["computer"]["templateVmid"] == "9000"
    facade.clone_container.assert_called_once_with("pve1", "9000", "120", "worker-1")
    facade.start_container.assert_called_once_with("pve1", "120")


def test_sidecar_provision_uses_proxmox_config_from_request():
    from ccie_sidecar.server import handle_request

    facade = Mock()
    facade.clone_container.return_value = {"ok": True, "upid": "UPID:clone"}
    facade.start_container.return_value = {"ok": True, "upid": "UPID:start"}
    proxmox_config = {"host": "192.0.2.10", "user": "root@pam", "verify_ssl": False}

    with patch("ccie_sidecar.proxmox_api.facade.ProxmoxFacade", return_value=facade) as facade_cls:
        handle_request({
            "id": "1",
            "method": "agent_computer.provision",
            "params": {
                "computer": {"name": "worker-1", "node": "pve1", "vmid": "120", "templateVmid": "9000"},
                "proxmoxConfig": proxmox_config,
            },
        })

    assert facade_cls.call_args.kwargs["config_loader"]() == proxmox_config


def test_sidecar_provision_does_not_fallback_when_request_config_is_null():
    from ccie_sidecar.server import handle_request

    with patch("ccie_sidecar.proxmox_api.facade.ProxmoxFacade") as facade_cls:
        handle_request({
            "id": "1",
            "method": "agent_computer.provision",
            "params": {
                "computer": {"name": "worker-1", "node": "pve1", "vmid": "120", "templateVmid": "9000"},
                "proxmoxConfig": None,
            },
        })

    assert facade_cls.call_args.kwargs["config_loader"]() is None


def test_sidecar_health_threads_request_proxmox_config_to_pct_transport():
    from ccie_sidecar.server import handle_request

    proxmox_config = {"host": "192.0.2.10", "user": "root@pam", "verify_ssl": False}
    with patch("ccie_sidecar.agent_computer.PctTransport") as pct_cls:
        pct_cls.return_value.health.return_value = {"ok": True, "transport": "pct"}
        handle_request({
            "id": "1",
            "method": "agent_computer.health",
            "params": {
                "computer": {"name": "worker-1", "baseUrl": "pct://pve1/120", "token": "secret", "node": "pve1", "vmid": "120"},
                "proxmoxConfig": proxmox_config,
            },
        })

    assert pct_cls.call_args.kwargs["config_loader"]() == proxmox_config


def test_code_exec_sandbox_injects_computer():
    from ccie_sidecar.agents.code_exec import _build_sandbox_globals

    globals_dict = _build_sandbox_globals(None, {})

    assert "computer" in globals_dict
    assert "list" in globals_dict["computer"].help()
