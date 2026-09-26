"""Proxmox capability catalog — drives on-demand discovery.

Discovery surface for the single execute_python_code tool: agents call
proxmox.help() / proxmox.search() instead of receiving 30 tool schemas in the
prompt. Each Capability carries a disambiguating docstring so the model does
not confuse similar operations (stop vs shutdown, delete vs rollback snapshot).
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Capability:
    name: str
    group: str
    signature: str
    doc: str
    risk: str  # "read" | "mutate" | "high_risk"


CAPABILITIES: list[Capability] = [
    # --- nodes / cluster / storage (read) ---
    Capability("get_nodes", "cluster", "get_nodes()",
               "List all nodes in the Proxmox cluster with status, uptime, CPU and memory. Read-only.", "read"),
    Capability("get_node_status", "cluster", "get_node_status(node)",
               "Detailed status for one node (CPU, memory, load, uptime). Read-only. `node` is the node name e.g. 'pve1'.", "read"),
    Capability("get_cluster_status", "cluster", "get_cluster_status()",
               "Cluster-wide health: quorum, node count, HA status. Read-only.", "read"),
    Capability("get_storage", "storage", "get_storage()",
               "List storage pools across the cluster with type and usage. Read-only.", "read"),
    # --- VMs (read) ---
    Capability("get_vms", "vm", "get_vms()",
               "List all QEMU virtual machines across the cluster with status, node, CPU and memory. Read-only.", "read"),
    Capability("get_vm_config", "vm", "get_vm_config(node, vmid)",
               "Full configuration of one VM (disks, network, cores, memory). Read-only.", "read"),
    # --- VMs (mutate) ---
    Capability("create_vm", "vm", "create_vm(node, vmid, name, cpus, memory, disk_size=10, storage='local-lvm', network_bridge='vmbr0')",
               "Create a new QEMU VM. `memory` is MB, `disk_size` is GB. Fails if vmid already exists. Mutating.", "mutate"),
    Capability("clone_vm", "vm", "clone_vm(node, source_vmid, target_vmid, name, full=True)",
               "Clone an existing VM/template into a new vmid. Mutating; creates a new VM, does not touch the source.", "mutate"),
    Capability("start_vm", "vm", "start_vm(node, vmid)",
               "Power ON a VM. Mutating but non-destructive.", "mutate"),
    Capability("stop_vm", "vm", "stop_vm(node, vmid)",
               "HARD power-off a VM (like pulling the plug) — does NOT shut the guest OS down cleanly and may lose unsaved data. For a clean shutdown use shutdown_vm instead. Mutating.", "mutate"),
    Capability("shutdown_vm", "vm", "shutdown_vm(node, vmid)",
               "GRACEFUL ACPI shutdown: asks the guest OS to power off cleanly. Slower than stop_vm but safe. Use stop_vm only when the guest is unresponsive. Mutating.", "mutate"),
    Capability("reset_vm", "vm", "reset_vm(node, vmid)",
               "Hard reset (reboot) a running VM. Mutating; equivalent to the reset button.", "mutate"),
    # --- VMs (high risk) ---
    Capability("delete_vm", "vm", "delete_vm(node, vmid, confirm=False)",
               "PERMANENTLY delete a VM and its disks. Destructive and irreversible. Requires confirm=True. Deletes the whole VM — to remove only a snapshot use delete_snapshot.", "high_risk"),
    Capability("execute_vm_command", "vm", "execute_vm_command(node, vmid, command, confirm=False)",
               "Run a shell command INSIDE a running VM via the QEMU guest agent. Arbitrary code execution on the guest; requires confirm=True.", "high_risk"),
    # --- snapshots ---
    Capability("list_snapshots", "snapshot", "list_snapshots(node, vmid, vm_type='qemu')",
               "List snapshots for a VM (vm_type='qemu') or container (vm_type='lxc'). Read-only.", "read"),
    Capability("create_snapshot", "snapshot", "create_snapshot(node, vmid, snapname, vm_type='qemu', description='', vmstate=False)",
               "Create a snapshot. Mutating but non-destructive; the VM keeps running. vmstate=True also saves RAM.", "mutate"),
    Capability("delete_snapshot", "snapshot", "delete_snapshot(node, vmid, snapname, vm_type='qemu', confirm=False)",
               "Removes a snapshot. The VM itself and its current state are UNCHANGED — only the saved snapshot is discarded. Requires confirm=True. Do NOT confuse with rollback_snapshot.", "high_risk"),
    Capability("rollback_snapshot", "snapshot", "rollback_snapshot(node, vmid, snapname, vm_type='qemu', confirm=False)",
               "REVERTS the VM's disk and state back to a snapshot. DESTRUCTIVE: every change made since that snapshot is permanently lost (data loss). Requires confirm=True. This is NOT the same as delete_snapshot.", "high_risk"),
    # --- containers (LXC) ---
    Capability("get_containers", "container", "get_containers()",
               "List all LXC containers across the cluster with status. Read-only.", "read"),
    Capability("get_container_config", "container", "get_container_config(node, vmid)",
               "Full configuration of one LXC container. Read-only.", "read"),
    Capability("start_container", "container", "start_container(node, vmid)",
               "Start an LXC container. Mutating, non-destructive.", "mutate"),
    Capability("stop_container", "container", "stop_container(node, vmid)",
               "Stop an LXC container. Mutating; stops the container (not destructive to its disk).", "mutate"),
    Capability("delete_container", "container", "delete_container(node, vmid, confirm=False)",
               "PERMANENTLY delete an LXC container and its rootfs. Destructive and irreversible. Requires confirm=True.", "high_risk"),
    Capability("execute_container_command", "container", "execute_container_command(node, vmid, command, confirm=False)",
               "Run a shell command INSIDE an LXC container via pct exec (SSH to the node). Arbitrary code execution; requires confirm=True.", "high_risk"),
    # --- backups ---
    Capability("list_backups", "backup", "list_backups(node, storage=None)",
               "List backup archives on a node's storage. Read-only.", "read"),
    Capability("create_backup", "backup", "create_backup(node, vmid, storage, mode='snapshot')",
               "Create a backup (vzdump) of a VM/container. Mutating; reads the VM and writes a new archive.", "mutate"),
    Capability("restore_backup", "backup", "restore_backup(node, vmid, archive, storage, confirm=False)",
               "Restore a VM/container FROM a backup archive, OVERWRITING the target vmid. Destructive to the current target. Requires confirm=True.", "high_risk"),
    Capability("delete_backup", "backup", "delete_backup(node, volid, confirm=False)",
               "Delete a backup archive (by volid). Irreversible for that archive. Requires confirm=True.", "high_risk"),
    # --- ISOs ---
    Capability("list_isos", "iso", "list_isos(node, storage='local')",
               "List ISO images on a storage. Read-only.", "read"),
    Capability("download_iso", "iso", "download_iso(node, storage, url, filename)",
               "Download an ISO from a URL onto storage. Mutating; adds a new file.", "mutate"),
    Capability("delete_iso", "iso", "delete_iso(node, storage, filename, confirm=False)",
               "Delete an ISO file from storage. Irreversible for that file. Requires confirm=True.", "high_risk"),
]

_BY_NAME = {c.name: c for c in CAPABILITIES}


def help(topic: str | None = None) -> str:
    """Return a compact, grouped capability listing.

    With no topic: one line per capability (name — summary), grouped.
    With a topic: full signatures + docs for capabilities whose name, group, or
    doc contains the topic substring (case-insensitive).
    """
    if topic:
        t = topic.lower()
        matches = [c for c in CAPABILITIES if t in c.name.lower() or t in c.group.lower() or t in c.doc.lower()]
        if not matches:
            return f"No Proxmox capabilities match '{topic}'. Call proxmox.help() to list all."
        lines = [f"Proxmox capabilities matching '{topic}':", ""]
        for c in matches:
            lines.append(f"proxmox.{c.signature}")
            lines.append(f"    [{c.risk}] {c.doc}")
            lines.append("")
        return "\n".join(lines).rstrip()
    # No topic: grouped one-liners.
    lines = ["Proxmox capabilities (call proxmox.help('<topic>') for signatures):", ""]
    groups: dict[str, list[Capability]] = {}
    for c in CAPABILITIES:
        groups.setdefault(c.group, []).append(c)
    for group in sorted(groups):
        lines.append(f"# {group}")
        for c in groups[group]:
            summary = c.doc.split(".")[0]
            tag = " (needs confirm=True)" if c.risk == "high_risk" else ""
            lines.append(f"  {c.name} — {summary}{tag}")
        lines.append("")
    return "\n".join(lines).rstrip()


def search(query: str) -> list[str]:
    """Return capability names whose name or doc contains `query` (case-insensitive)."""
    q = query.lower()
    return [c.name for c in CAPABILITIES if q in c.name.lower() or q in c.doc.lower()]


def get(name: str) -> Capability | None:
    return _BY_NAME.get(name)
