"""Live MUTATION lifecycle test against the lab Proxmox box.

Creates a throwaway VM at a high unused VMID, exercises the mutation + confirm
path, then deletes it. Touches NOTHING that already exists. Cleanup runs in
finally even on failure.

Run with: PROXMOX_LIVE_MUTATE=1 .venv/bin/python -m pytest tests/proxmox/test_live_lifecycle.py -v -s
"""
import os
import time

import pytest

from ccie_sidecar.proxmox_api.client import build_proxmox_api
from ccie_sidecar.proxmox_api import ops
from ccie_sidecar.proxmox_api.facade import ProxmoxFacade

pytestmark = pytest.mark.skipif(
    os.environ.get("PROXMOX_LIVE_MUTATE") != "1",
    reason="set PROXMOX_LIVE_MUTATE=1 to run live mutation lifecycle",
)

LAB = {
    "host": os.environ.get("PROXMOX_HOST", "proxmox.example.test"),
    "port": 8006,
    "user": os.environ.get("PROXMOX_USER", "root@pam"),
    "token_name": "",
    "token_value": "",
    "password": os.environ.get("PROXMOX_PASSWORD", "Iwiwaf77"),
    "verify_ssl": False,
}

TEST_VMID = os.environ.get("PROXMOX_TEST_VMID", "9920")
TEST_NAME = "ccie-throwaway-donotuse"


def _wait_task(api, node, upid, timeout=60):
    """Best-effort: poll the task UPID until it stops or timeout. Tolerant of API shape."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            status = api.nodes(node).tasks(upid).status.get()
            if status.get("status") == "stopped":
                return status
        except Exception:
            return None
        time.sleep(2)
    return None


def test_live_vm_lifecycle():
    api = build_proxmox_api(LAB)

    # Choose a node (first online).
    nodes = ops.get_nodes(api)
    assert nodes["ok"], nodes
    node = next((n["node"] for n in nodes["nodes"] if n["status"] == "online"), None)
    assert node, "no online node"

    # GUARD: refuse if the test VMID already exists anywhere — never touch existing.
    existing = {str(v["vmid"]) for v in ops.get_vms(api).get("vms", [])}
    assert TEST_VMID not in existing, (
        f"VMID {TEST_VMID} already exists — refusing to run to avoid touching existing resources. "
        f"Set PROXMOX_TEST_VMID to an unused id."
    )

    facade = ProxmoxFacade(config_loader=lambda: LAB, api_builder=build_proxmox_api)
    created = False
    try:
        # Pick a storage that exists.
        storages = ops.get_storage(api)["storage"]
        store_names = [s.get("storage") for s in storages]
        storage = "local-lvm" if "local-lvm" in store_names else store_names[0]

        # CREATE
        r = facade.create_vm(node, TEST_VMID, TEST_NAME, cpus=1, memory=512, disk_size=1, storage=storage)
        assert r["ok"] is True, r
        created = True
        _wait_task(api, node, r.get("upid"))

        # It now exists
        now = {str(v["vmid"]) for v in ops.get_vms(api).get("vms", [])}
        assert TEST_VMID in now

        # SNAPSHOT (non-destructive mutate)
        s = facade.create_snapshot(node, TEST_VMID, "t1", vm_type="qemu")
        assert s["ok"] is True, s
        _wait_task(api, node, s.get("upid"))

        snaps = facade.list_snapshots(node, TEST_VMID, vm_type="qemu")
        assert snaps["ok"] is True
        assert any(sn.get("name") == "t1" for sn in snaps["snapshots"])

        # DELETE SNAPSHOT — high risk: blocked without confirm, works with confirm
        blocked = facade.delete_snapshot(node, TEST_VMID, "t1", vm_type="qemu")
        assert blocked.get("needs_confirm") is True
        d = facade.delete_snapshot(node, TEST_VMID, "t1", vm_type="qemu", confirm=True)
        assert d["ok"] is True, d
        _wait_task(api, node, d.get("upid"))

    finally:
        # CLEANUP: delete the throwaway VM no matter what.
        if created:
            try:
                # ensure stopped
                facade.stop_vm(node, TEST_VMID)
                time.sleep(3)
            except Exception:
                pass
            dele = facade.delete_vm(node, TEST_VMID, confirm=True)
            # best-effort assertion; log if cleanup failed
            assert dele.get("ok") is True, f"CLEANUP FAILED, manually remove VM {TEST_VMID}: {dele}"
            _wait_task(api, node, dele.get("upid"))
            gone = {str(v["vmid"]) for v in ops.get_vms(api).get("vms", [])}
            assert TEST_VMID not in gone, f"VM {TEST_VMID} still present after delete"
