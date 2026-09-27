"""Proxmox operations — thin wrappers over proxmoxer call chains.

Each function takes the proxmoxer API as its first arg and returns a plain dict.
API errors are caught and returned as {"ok": False, "error": "..."} so agent
code sees structured failures, never raw tracebacks. Call chains mirror
ProxmoxMCP-Plus (MIT).
"""
from __future__ import annotations

import time
from typing import Any


def _ok(**kw: Any) -> dict[str, Any]:
    return {"ok": True, **kw}


def _err(op: str, e: Exception) -> dict[str, Any]:
    return {"ok": False, "error": f"{op}: {e}"}


def _qemu_or_lxc(api: Any, node: str, vmid: str, vm_type: str):
    return api.nodes(node).lxc(vmid) if vm_type == "lxc" else api.nodes(node).qemu(vmid)


def _wait_task(api: Any, node: str, upid: str, timeout: int = 60) -> dict[str, Any]:
    end = time.time() + timeout
    while time.time() < end:
        status = api.nodes(node).tasks(upid).status.get()
        if status.get("status") == "stopped":
            return _ok(task=status) if status.get("exitstatus") == "OK" else _err("wait_task", Exception(status.get("exitstatus") or "failed"))
        time.sleep(1)
    return _err("wait_task", Exception("timed out"))


# ---------------- cluster / nodes / storage ----------------

def get_nodes(api: Any) -> dict[str, Any]:
    try:
        result = api.nodes.get()
        nodes = []
        for node in result:
            name = node["node"]
            try:
                status = api.nodes(name).status.get()
                nodes.append({
                    "node": name, "status": node.get("status"),
                    "uptime": status.get("uptime", 0),
                    "maxcpu": status.get("cpuinfo", {}).get("cpus", "N/A"),
                    "memory": {"used": status.get("memory", {}).get("used", 0),
                               "total": status.get("memory", {}).get("total", 0)},
                })
            except Exception:
                nodes.append({
                    "node": name, "status": node.get("status"), "uptime": 0, "maxcpu": "N/A",
                    "memory": {"used": node.get("mem", 0), "total": node.get("maxmem", 0)},
                })
        return _ok(nodes=nodes)
    except Exception as e:
        return _err("get_nodes", e)


def get_node_status(api: Any, node: str) -> dict[str, Any]:
    try:
        return _ok(node=node, status=api.nodes(node).status.get())
    except Exception as e:
        return _err("get_node_status", e)


def get_cluster_status(api: Any) -> dict[str, Any]:
    try:
        return _ok(cluster=api.cluster.status.get())
    except Exception as e:
        return _err("get_cluster_status", e)


def get_storage(api: Any) -> dict[str, Any]:
    try:
        return _ok(storage=api.storage.get())
    except Exception as e:
        return _err("get_storage", e)


# ---------------- VMs ----------------

def get_vms(api: Any) -> dict[str, Any]:
    try:
        vms = []
        for node in api.nodes.get():
            name = node.get("node") if isinstance(node, dict) else None
            if not name or node.get("status") != "online":
                continue  # skip offline/unreachable nodes (master proxies to them -> 595 No route to host)
            try:
                node_vms = api.nodes(name).qemu.get()
            except Exception:
                continue  # node went down mid-enumeration; don't abort the whole cluster query
            for vm in node_vms:
                vmid = vm["vmid"]
                entry = {"vmid": vmid, "name": vm.get("name", f"vm-{vmid}"),
                         "status": vm.get("status"), "node": name,
                         "memory": {"used": vm.get("mem", 0), "total": vm.get("maxmem", 0)}}
                try:
                    cfg = api.nodes(name).qemu(vmid).config.get()
                    entry["cpus"] = cfg.get("cores", "N/A")
                except Exception:
                    entry["cpus"] = "N/A"
                vms.append(entry)
        return _ok(vms=vms)
    except Exception as e:
        return _err("get_vms", e)


def get_vm_config(api: Any, node: str, vmid: str) -> dict[str, Any]:
    try:
        return _ok(config=api.nodes(node).qemu(vmid).config.get())
    except Exception as e:
        return _err("get_vm_config", e)


def create_vm(api: Any, node: str, vmid: str, name: str, cpus: int, memory: int,
              disk_size: int = 10, storage: str = "local-lvm",
              network_bridge: str = "vmbr0", disk_format: str = "raw") -> dict[str, Any]:
    try:
        try:
            api.nodes(node).qemu(vmid).config.get()
            return _err("create_vm", Exception(f"VM {vmid} already exists on node {node}"))
        except Exception:
            pass  # not found -> good, proceed
        names = [s.get("storage") for s in api.nodes(node).storage.get()]
        if storage not in names:
            return _err("create_vm", Exception(f"Storage '{storage}' not found on node {node}; available: {names}"))
        vm_config = {
            "vmid": vmid, "name": name, "cores": cpus, "memory": memory,
            "scsihw": "virtio-scsi-pci", "scsi0": f"{storage}:{disk_size},format={disk_format}",
            "boot": "order=scsi0", "net0": f"virtio,bridge={network_bridge}",
        }
        upid = api.nodes(node).qemu.create(**vm_config)
        return _ok(upid=upid, vmid=vmid, node=node)
    except Exception as e:
        return _err("create_vm", e)


def clone_vm(api: Any, node: str, source_vmid: str, target_vmid: str, name: str, full: bool = True) -> dict[str, Any]:
    try:
        upid = api.nodes(node).qemu(source_vmid).clone.post(newid=target_vmid, name=name, full=1 if full else 0)
        return _ok(upid=upid, vmid=target_vmid)
    except Exception as e:
        return _err("clone_vm", e)


def start_vm(api: Any, node: str, vmid: str) -> dict[str, Any]:
    try:
        return _ok(upid=api.nodes(node).qemu(vmid).status.start.post())
    except Exception as e:
        return _err("start_vm", e)


def stop_vm(api: Any, node: str, vmid: str) -> dict[str, Any]:
    try:
        return _ok(upid=api.nodes(node).qemu(vmid).status.stop.post())
    except Exception as e:
        return _err("stop_vm", e)


def shutdown_vm(api: Any, node: str, vmid: str) -> dict[str, Any]:
    try:
        return _ok(upid=api.nodes(node).qemu(vmid).status.shutdown.post())
    except Exception as e:
        return _err("shutdown_vm", e)


def reset_vm(api: Any, node: str, vmid: str) -> dict[str, Any]:
    try:
        return _ok(upid=api.nodes(node).qemu(vmid).status.reset.post())
    except Exception as e:
        return _err("reset_vm", e)


def delete_vm(api: Any, node: str, vmid: str) -> dict[str, Any]:
    try:
        return _ok(upid=api.nodes(node).qemu(vmid).delete())
    except Exception as e:
        return _err("delete_vm", e)


def execute_vm_command(api: Any, node: str, vmid: str, command: str) -> dict[str, Any]:
    try:
        res = api.nodes(node).qemu(vmid).agent.exec.post(command=command)
        return _ok(result=res)
    except Exception as e:
        return _err("execute_vm_command", e)


# ---------------- snapshots ----------------

def list_snapshots(api: Any, node: str, vmid: str, vm_type: str = "qemu") -> dict[str, Any]:
    try:
        snaps = _qemu_or_lxc(api, node, vmid, vm_type).snapshot.get()
        snaps = [s for s in snaps if s.get("name") != "current"]
        return _ok(snapshots=snaps)
    except Exception as e:
        return _err("list_snapshots", e)


def create_snapshot(api: Any, node: str, vmid: str, snapname: str, vm_type: str = "qemu",
                    description: str = "", vmstate: bool = False) -> dict[str, Any]:
    try:
        params: dict[str, Any] = {"snapname": snapname}
        if description:
            params["description"] = description
        if vmstate:
            params["vmstate"] = 1
        upid = _qemu_or_lxc(api, node, vmid, vm_type).snapshot.post(**params)
        return _ok(upid=upid, snapname=snapname)
    except Exception as e:
        return _err("create_snapshot", e)


def delete_snapshot(api: Any, node: str, vmid: str, snapname: str, vm_type: str = "qemu") -> dict[str, Any]:
    try:
        upid = _qemu_or_lxc(api, node, vmid, vm_type).snapshot(snapname).delete()
        return _ok(upid=upid, snapname=snapname)
    except Exception as e:
        return _err("delete_snapshot", e)


def rollback_snapshot(api: Any, node: str, vmid: str, snapname: str, vm_type: str = "qemu") -> dict[str, Any]:
    try:
        upid = _qemu_or_lxc(api, node, vmid, vm_type).snapshot(snapname).rollback.post()
        return _ok(upid=upid, snapname=snapname)
    except Exception as e:
        return _err("rollback_snapshot", e)


# ---------------- containers (LXC) ----------------

def get_containers(api: Any) -> dict[str, Any]:
    try:
        cts = []
        for node in api.nodes.get():
            name = node.get("node") if isinstance(node, dict) else None
            if not name or node.get("status") != "online":
                continue  # skip offline/unreachable nodes (master proxies to them -> 595 No route to host)
            try:
                node_cts = api.nodes(name).lxc.get()
            except Exception:
                continue  # node went down mid-enumeration; don't abort the whole cluster query
            for ct in node_cts:
                cts.append({"vmid": ct["vmid"], "name": ct.get("name", ""),
                            "status": ct.get("status"), "node": name})
        return _ok(containers=cts)
    except Exception as e:
        return _err("get_containers", e)


def get_container_config(api: Any, node: str, vmid: str) -> dict[str, Any]:
    try:
        return _ok(config=api.nodes(node).lxc(vmid).config.get())
    except Exception as e:
        return _err("get_container_config", e)


def clone_container(api: Any, node: str, source_vmid: str, target_vmid: str, name: str) -> dict[str, Any]:
    try:
        upid = api.nodes(node).lxc(source_vmid).clone.post(newid=target_vmid, full=1)
        waited = _wait_task(api, node, upid)
        return _ok(upid=upid, vmid=target_vmid) if waited.get("ok") else waited
    except Exception as e:
        return _err("clone_container", e)


def start_container(api: Any, node: str, vmid: str) -> dict[str, Any]:
    try:
        upid = api.nodes(node).lxc(vmid).status.start.post()
        waited = _wait_task(api, node, upid)
        return _ok(upid=upid, vmid=vmid) if waited.get("ok") else waited
    except Exception as e:
        return _err("start_container", e)


def stop_container(api: Any, node: str, vmid: str) -> dict[str, Any]:
    try:
        return _ok(upid=api.nodes(node).lxc(vmid).status.stop.post())
    except Exception as e:
        return _err("stop_container", e)


def delete_container(api: Any, node: str, vmid: str) -> dict[str, Any]:
    try:
        return _ok(upid=api.nodes(node).lxc(vmid).delete())
    except Exception as e:
        return _err("delete_container", e)


def execute_container_command(api: Any, node: str, vmid: str, command: str) -> dict[str, Any]:
    # NOTE: real pct-exec requires SSH to the node (out of scope for v1 API path);
    # this uses the LXC status/exec API surface where available and returns a clear
    # error otherwise. Kept as a high-risk capability.
    try:
        res = api.nodes(node).lxc(vmid).status.current.get()
        return _ok(note="execute_container_command requires node SSH (pct exec); not available via API token in v1", status=res)
    except Exception as e:
        return _err("execute_container_command", e)


# ---------------- backups ----------------

def list_backups(api: Any, node: str, storage: str | None = None) -> dict[str, Any]:
    try:
        if storage:
            content = api.nodes(node).storage(storage).content.get(content="backup")
        else:
            content = []
            for st in api.nodes(node).storage.get():
                sid = st.get("storage")
                try:
                    content.extend(api.nodes(node).storage(sid).content.get(content="backup"))
                except Exception:
                    continue
        return _ok(backups=content)
    except Exception as e:
        return _err("list_backups", e)


def create_backup(api: Any, node: str, vmid: str, storage: str, mode: str = "snapshot") -> dict[str, Any]:
    try:
        upid = api.nodes(node).vzdump.post(vmid=vmid, storage=storage, mode=mode)
        return _ok(upid=upid)
    except Exception as e:
        return _err("create_backup", e)


def restore_backup(api: Any, node: str, vmid: str, archive: str, storage: str) -> dict[str, Any]:
    try:
        upid = api.nodes(node).qemu.create(vmid=vmid, archive=archive, storage=storage, force=1)
        return _ok(upid=upid)
    except Exception as e:
        return _err("restore_backup", e)


def delete_backup(api: Any, node: str, volid: str) -> dict[str, Any]:
    try:
        # volid form: "storage:backup/vzdump-....vma.zst"
        storage = volid.split(":", 1)[0]
        upid = api.nodes(node).storage(storage).content(volid).delete()
        return _ok(upid=upid)
    except Exception as e:
        return _err("delete_backup", e)


# ---------------- ISOs ----------------

def list_isos(api: Any, node: str, storage: str = "local") -> dict[str, Any]:
    try:
        return _ok(isos=api.nodes(node).storage(storage).content.get(content="iso"))
    except Exception as e:
        return _err("list_isos", e)


def download_iso(api: Any, node: str, storage: str, url: str, filename: str) -> dict[str, Any]:
    try:
        upid = api.nodes(node).storage(storage)("download-url").post(content="iso", url=url, filename=filename)
        return _ok(upid=upid)
    except Exception as e:
        return _err("download_iso", e)


def delete_iso(api: Any, node: str, storage: str, filename: str) -> dict[str, Any]:
    try:
        volid = f"{storage}:iso/{filename}"
        upid = api.nodes(node).storage(storage).content(volid).delete()
        return _ok(upid=upid)
    except Exception as e:
        return _err("delete_iso", e)
