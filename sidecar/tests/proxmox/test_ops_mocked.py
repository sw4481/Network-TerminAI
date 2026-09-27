"""Ops tested against a mocked proxmoxer API (no network)."""
from unittest.mock import MagicMock

from ccie_sidecar.proxmox_api import ops


def _api():
    """A MagicMock whose attribute/call chains return MagicMocks; leaf .get/.post/.create/.delete configured per-test."""
    return MagicMock()


def test_get_nodes_shapes_data():
    api = _api()
    api.nodes.get.return_value = [{"node": "pve1", "status": "online", "mem": 8, "maxmem": 32}]
    api.nodes.return_value.status.get.return_value = {"uptime": 100, "cpuinfo": {"cpus": 4}, "memory": {"used": 8, "total": 32}}
    out = ops.get_nodes(api)
    assert out["ok"] is True
    assert out["nodes"][0]["node"] == "pve1"
    assert out["nodes"][0]["status"] == "online"


def test_get_vms_lists_qemu():
    api = _api()
    # get_vms skips nodes whose status != "online" (avoids 595 on unreachable nodes).
    api.nodes.get.return_value = [{"node": "pve1", "status": "online"}]
    api.nodes.return_value.qemu.get.return_value = [{"vmid": 100, "name": "ubuntu", "status": "running", "mem": 1, "maxmem": 2}]
    api.nodes.return_value.qemu.return_value.config.get.return_value = {"cores": 2}
    out = ops.get_vms(api)
    assert out["ok"] is True
    assert out["vms"][0]["vmid"] == 100
    assert out["vms"][0]["cpus"] == 2


def test_create_vm_calls_create_and_returns_upid():
    api = _api()
    # storage check passes
    api.nodes.return_value.storage.get.return_value = [{"storage": "local-lvm", "content": "images"}]
    api.nodes.return_value.qemu.create.return_value = "UPID:pve1:create"
    # config.get used as "already exists?" probe must raise (not found) so create proceeds
    api.nodes.return_value.qemu.return_value.config.get.side_effect = Exception("not found")
    out = ops.create_vm(api, node="pve1", vmid="950", name="t", cpus=1, memory=1024, disk_size=10, storage="local-lvm")
    assert out["ok"] is True
    assert out["upid"] == "UPID:pve1:create"
    api.nodes.return_value.qemu.create.assert_called_once()


def test_stop_vm_posts_stop():
    api = _api()
    api.nodes.return_value.qemu.return_value.status.stop.post.return_value = "UPID:stop"
    out = ops.stop_vm(api, "pve1", "950")
    assert out["ok"] is True
    api.nodes.return_value.qemu.return_value.status.stop.post.assert_called_once()


def test_start_container_waits_for_start_task():
    api = _api()
    api.nodes.return_value.lxc.return_value.status.start.post.return_value = "UPID:start"
    api.nodes.return_value.tasks.return_value.status.get.return_value = {"status": "stopped", "exitstatus": "OK"}

    out = ops.start_container(api, "pve1", "120")

    assert out["ok"] is True
    api.nodes.return_value.tasks.assert_called_with("UPID:start")


def test_clone_container_does_not_send_unsupported_hostname_param():
    api = _api()
    api.nodes.return_value.lxc.return_value.clone.post.return_value = "UPID:clone"
    api.nodes.return_value.tasks.return_value.status.get.return_value = {"status": "stopped", "exitstatus": "OK"}

    out = ops.clone_container(api, "pve1", "9000", "120", "worker-1")

    assert out["ok"] is True
    api.nodes.return_value.lxc.return_value.clone.post.assert_called_once_with(newid="120", full=1)


def test_shutdown_vm_posts_shutdown():
    api = _api()
    api.nodes.return_value.qemu.return_value.status.shutdown.post.return_value = "UPID:sd"
    out = ops.shutdown_vm(api, "pve1", "950")
    assert out["ok"] is True
    api.nodes.return_value.qemu.return_value.status.shutdown.post.assert_called_once()


def test_delete_vm_calls_delete():
    api = _api()
    api.nodes.return_value.qemu.return_value.delete.return_value = "UPID:del"
    out = ops.delete_vm(api, "pve1", "950")
    assert out["ok"] is True
    api.nodes.return_value.qemu.return_value.delete.assert_called_once()


def test_create_snapshot_qemu():
    api = _api()
    api.nodes.return_value.qemu.return_value.snapshot.post.return_value = "UPID:snap"
    out = ops.create_snapshot(api, "pve1", "950", "snap1", vm_type="qemu")
    assert out["ok"] is True
    api.nodes.return_value.qemu.return_value.snapshot.post.assert_called_once()


def test_rollback_snapshot_qemu():
    api = _api()
    api.nodes.return_value.qemu.return_value.snapshot.return_value.rollback.post.return_value = "UPID:rb"
    out = ops.rollback_snapshot(api, "pve1", "950", "snap1", vm_type="qemu")
    assert out["ok"] is True
    api.nodes.return_value.qemu.return_value.snapshot.return_value.rollback.post.assert_called_once()


def test_op_wraps_api_error():
    api = _api()
    api.nodes.get.side_effect = Exception("boom")
    out = ops.get_nodes(api)
    assert out["ok"] is False
    assert "boom" in out["error"]
