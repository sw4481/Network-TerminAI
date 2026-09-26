"""Live READ-ONLY tests against the lab Proxmox box.

Run with: PROXMOX_LIVE=1 .venv/bin/python -m pytest tests/proxmox/test_live_readonly.py -v
Skipped unless PROXMOX_LIVE=1. NEVER mutates anything.
"""
import os

import pytest

from ccie_sidecar.proxmox_api.client import build_proxmox_api
from ccie_sidecar.proxmox_api import ops

pytestmark = pytest.mark.skipif(os.environ.get("PROXMOX_LIVE") != "1", reason="set PROXMOX_LIVE=1 to run live")

LAB = {
    "host": os.environ.get("PROXMOX_HOST", "proxmox.example.test"),
    "port": 8006,
    "user": os.environ.get("PROXMOX_USER", "root@pam"),
    "token_name": "",
    "token_value": "",
    "password": os.environ.get("PROXMOX_PASSWORD", "Iwiwaf77"),
    "verify_ssl": False,
}


@pytest.fixture(scope="module")
def api():
    return build_proxmox_api(LAB)


def test_live_get_nodes(api):
    out = ops.get_nodes(api)
    assert out["ok"] is True
    names = {n["node"] for n in out["nodes"]}
    assert names  # at least one node
    # Known lab nodes (don't hard-fail if renamed, just assert we got real data)
    assert any(n["status"] == "online" for n in out["nodes"])


def test_live_get_cluster_status(api):
    out = ops.get_cluster_status(api)
    assert out["ok"] is True


def test_live_get_vms(api):
    out = ops.get_vms(api)
    assert out["ok"] is True
    assert isinstance(out["vms"], list)


def test_live_get_storage(api):
    out = ops.get_storage(api)
    assert out["ok"] is True
    assert isinstance(out["storage"], list)


def test_live_list_snapshots_first_vm(api):
    vms = ops.get_vms(api)["vms"]
    if not vms:
        pytest.skip("no VMs on lab box")
    vm = vms[0]
    out = ops.list_snapshots(api, vm["node"], str(vm["vmid"]), vm_type="qemu")
    assert out["ok"] is True
