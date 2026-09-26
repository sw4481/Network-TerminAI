"""The `proxmox` object agents call inside execute_python_code.

Lazily builds the proxmoxer API on first use (so importing proxmox never fails
even when unconfigured). High-risk operations require confirm=True; without it
they return a structured needs_confirm result instead of executing.
"""
from __future__ import annotations

from typing import Any, Callable

from ccie_sidecar.proxmox_api import catalog, ops
from ccie_sidecar.proxmox_api.client import build_proxmox_api
from ccie_sidecar.proxmox_api.config import get_proxmox_config

_HIGH_RISK = {c.name for c in catalog.CAPABILITIES if c.risk == "high_risk"}


class ProxmoxFacade:
    def __init__(self,
                 config_loader: Callable[[], dict[str, Any] | None] = get_proxmox_config,
                 api_builder: Callable[[dict[str, Any]], Any] = build_proxmox_api) -> None:
        self._config_loader = config_loader
        self._api_builder = api_builder
        self._api: Any = None
        self._api_error: str | None = None
        self._tried = False

    # ---- discovery ----
    def help(self, topic: str | None = None) -> str:
        return catalog.help(topic)

    def search(self, query: str) -> list[str]:
        return catalog.search(query)

    # ---- internal ----
    def _get_api(self) -> tuple[Any, dict[str, Any] | None]:
        if not self._tried:
            self._tried = True
            conf = self._config_loader()
            if conf and conf.get("host"):
                try:
                    self._api = self._api_builder(conf)
                except Exception as exc:
                    self._api = None
                    self._api_error = str(exc)
        return self._api, None

    def _call(self, name: str, fn: Callable[[Any], dict[str, Any]], confirm: bool) -> dict[str, Any]:
        if name in _HIGH_RISK and not confirm:
            cap = catalog.get(name)
            return {
                "ok": False, "needs_confirm": True,
                "reason": f"'{name}' is destructive ({cap.doc if cap else ''}). "
                          f"Show the user exactly what will happen, get explicit approval, "
                          f"then call again with confirm=True.",
            }
        api, _ = self._get_api()
        if api is None:
            return {"ok": False, "error": self._api_error or "Proxmox is not configured. Set host/credentials in Settings → Proxmox."}
        return fn(api)

    # ---- read ----
    def get_nodes(self): return self._call("get_nodes", lambda a: ops.get_nodes(a), True)
    def get_node_status(self, node): return self._call("get_node_status", lambda a: ops.get_node_status(a, node), True)
    def get_cluster_status(self): return self._call("get_cluster_status", lambda a: ops.get_cluster_status(a), True)
    def get_storage(self): return self._call("get_storage", lambda a: ops.get_storage(a), True)
    def get_vms(self): return self._call("get_vms", lambda a: ops.get_vms(a), True)
    def get_vm_config(self, node, vmid): return self._call("get_vm_config", lambda a: ops.get_vm_config(a, node, vmid), True)
    def get_containers(self): return self._call("get_containers", lambda a: ops.get_containers(a), True)
    def get_container_config(self, node, vmid): return self._call("get_container_config", lambda a: ops.get_container_config(a, node, vmid), True)
    def list_snapshots(self, node, vmid, vm_type="qemu"): return self._call("list_snapshots", lambda a: ops.list_snapshots(a, node, vmid, vm_type), True)
    def list_backups(self, node, storage=None): return self._call("list_backups", lambda a: ops.list_backups(a, node, storage), True)
    def list_isos(self, node, storage="local"): return self._call("list_isos", lambda a: ops.list_isos(a, node, storage), True)

    # ---- mutate (non-destructive) ----
    def create_vm(self, node, vmid, name, cpus, memory, disk_size=10, storage="local-lvm", network_bridge="vmbr0"):
        return self._call("create_vm", lambda a: ops.create_vm(a, node, vmid, name, cpus, memory, disk_size, storage, network_bridge), True)
    def clone_vm(self, node, source_vmid, target_vmid, name, full=True):
        return self._call("clone_vm", lambda a: ops.clone_vm(a, node, source_vmid, target_vmid, name, full), True)
    def start_vm(self, node, vmid): return self._call("start_vm", lambda a: ops.start_vm(a, node, vmid), True)
    def stop_vm(self, node, vmid): return self._call("stop_vm", lambda a: ops.stop_vm(a, node, vmid), True)
    def shutdown_vm(self, node, vmid): return self._call("shutdown_vm", lambda a: ops.shutdown_vm(a, node, vmid), True)
    def reset_vm(self, node, vmid): return self._call("reset_vm", lambda a: ops.reset_vm(a, node, vmid), True)
    def clone_container(self, node, source_vmid, target_vmid, name): return self._call("clone_container", lambda a: ops.clone_container(a, node, source_vmid, target_vmid, name), True)
    def start_container(self, node, vmid): return self._call("start_container", lambda a: ops.start_container(a, node, vmid), True)
    def stop_container(self, node, vmid): return self._call("stop_container", lambda a: ops.stop_container(a, node, vmid), True)
    def create_snapshot(self, node, vmid, snapname, vm_type="qemu", description="", vmstate=False):
        return self._call("create_snapshot", lambda a: ops.create_snapshot(a, node, vmid, snapname, vm_type, description, vmstate), True)
    def create_backup(self, node, vmid, storage, mode="snapshot"):
        return self._call("create_backup", lambda a: ops.create_backup(a, node, vmid, storage, mode), True)
    def download_iso(self, node, storage, url, filename):
        return self._call("download_iso", lambda a: ops.download_iso(a, node, storage, url, filename), True)

    # ---- high risk (confirm=True) ----
    def delete_vm(self, node, vmid, confirm=False): return self._call("delete_vm", lambda a: ops.delete_vm(a, node, vmid), confirm)
    def delete_container(self, node, vmid, confirm=False): return self._call("delete_container", lambda a: ops.delete_container(a, node, vmid), confirm)
    def delete_snapshot(self, node, vmid, snapname, vm_type="qemu", confirm=False):
        return self._call("delete_snapshot", lambda a: ops.delete_snapshot(a, node, vmid, snapname, vm_type), confirm)
    def rollback_snapshot(self, node, vmid, snapname, vm_type="qemu", confirm=False):
        return self._call("rollback_snapshot", lambda a: ops.rollback_snapshot(a, node, vmid, snapname, vm_type), confirm)
    def restore_backup(self, node, vmid, archive, storage, confirm=False):
        return self._call("restore_backup", lambda a: ops.restore_backup(a, node, vmid, archive, storage), confirm)
    def delete_backup(self, node, volid, confirm=False): return self._call("delete_backup", lambda a: ops.delete_backup(a, node, volid), confirm)
    def delete_iso(self, node, storage, filename, confirm=False): return self._call("delete_iso", lambda a: ops.delete_iso(a, node, storage, filename), confirm)
    def execute_vm_command(self, node, vmid, command, confirm=False):
        return self._call("execute_vm_command", lambda a: ops.execute_vm_command(a, node, vmid, command), confirm)
    def execute_container_command(self, node, vmid, command, confirm=False):
        return self._call("execute_container_command", lambda a: ops.execute_container_command(a, node, vmid, command), confirm)
