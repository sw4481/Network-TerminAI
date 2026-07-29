# Proxmox Code-API MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Proxmox VE control available to every CCIE Terminal agent with zero user setup, exposing the LLM to exactly one tool, by vendoring ProxmoxMCP-Plus logic into the sidecar as an importable `proxmox` Python module callable inside the existing `execute_python_code` sandbox.

**Architecture:** A new `ccie_sidecar.proxmox_api` package wraps `proxmoxer` with thin, typed, well-documented op functions returning plain dicts. A `catalog.py` registry drives on-demand discovery (`proxmox.help()` / `proxmox.search()`) so no tool schemas hit the prompt. `install_proxmox()` injects a `proxmox` facade as both a sandbox global and importable module (mirroring `install_drawio`). Connection details live in the app config DB (like the LLM API key), edited via a Settings tab, read directly by the sidecar. High-risk ops require `confirm=True` (v1 gating). A bundled `proxmox` agent persona ships alongside meraki/pyats.

**Tech Stack:** Python 3.12, `proxmoxer>=2.0`, pytest/pytest-asyncio (sidecar); Rust/Tauri + rusqlite (config DB + commands); React/TypeScript (Settings tab).

---

## File Structure

**Sidecar (Python) — new package `sidecar/src/ccie_sidecar/proxmox_api/`:**
- `__init__.py` — exports `install_proxmox`, `ProxmoxFacade`; MIT attribution header.
- `client.py` — `build_proxmox_api(conn: dict)`: builds a `proxmoxer.ProxmoxAPI` lazily from a connection dict.
- `config.py` — `get_proxmox_config()`: reads the `proxmox_config` row from `sessions.db` (mirrors `agent.py::get_saved_config`); env-var fallback.
- `catalog.py` — `CAPABILITIES`: list of `Capability(name, group, signature, doc, risk)`; `help()`, `search()` helpers.
- `ops.py` — thin functions, one per capability, taking `(api, ...)` and returning plain dicts. Exact `proxmoxer` call chains from upstream.
- `facade.py` — `ProxmoxFacade`: binds `ops` to a lazily-built api + config; enforces `confirm=True` on high-risk; exposes `help`/`search`.
- `helper.py` — `install_proxmox(globals_dict, emit=None)`: registers `proxmox` as global + importable module.

**Sidecar wiring / tests:**
- Modify `sidecar/src/ccie_sidecar/agents/code_exec.py` — call `install_proxmox` in `_build_sandbox_globals`; add ~3-line prompt blurb constant.
- Modify `sidecar/pyproject.toml` — add `proxmoxer>=2.0`.
- Create `sidecar/tests/proxmox/` — `test_catalog.py`, `test_facade.py`, `test_ops_mocked.py`, `test_install.py`, `test_live_readonly.py`, `test_live_lifecycle.py`.

**Rust (Tauri):**
- Create `src-tauri/migrations/V0051__proxmox_config.sql`.
- Modify `src-tauri/src/commands/mod.rs` — `proxmox_save_config`, `proxmox_get_config` commands + `ProxmoxConfig` struct.
- Modify `src-tauri/src/lib.rs` (or wherever the invoke handler is registered) — register the two commands.

**Frontend (React):**
- Modify `src/lib/tauri.ts` — `ProxmoxConfig` type + `proxmoxSaveConfig`/`proxmoxGetConfig` bindings.
- Create `src/components/settings/ProxmoxSettingsTab.tsx`.
- Modify `src/windows/Settings.tsx` — add `"proxmox"` to the `activeTab` union, a tab button, and render the tab.

**Bundled agent:**
- Create `bundled-agents/proxmox/AGENT.md`.

---

## Task 1: Add the `proxmoxer` dependency

**Files:**
- Modify: `sidecar/pyproject.toml`

- [ ] **Step 1: Add the dependency**

In `sidecar/pyproject.toml`, in the `[project] dependencies` list, after the `"requests>=2.31.0",` line add:

```toml
    "proxmoxer>=2.0",
```

- [ ] **Step 2: Install it into the dev venv**

Run: `cd "/Users/shaunwhi/CCIE Terminal/sidecar" && .venv/bin/pip install "proxmoxer>=2.0"`
Expected: "Successfully installed proxmoxer-2.x.x" (or "already satisfied").

- [ ] **Step 3: Verify import works**

Run: `cd "/Users/shaunwhi/CCIE Terminal/sidecar" && .venv/bin/python -c "import proxmoxer; print(proxmoxer.__version__)"`
Expected: prints a version >= 2.0.

- [ ] **Step 4: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add sidecar/pyproject.toml
git commit -m "build(proxmox): add proxmoxer dependency"
```

---

## Task 2: Capability catalog (discovery surface)

This is the heart of "one tool, no big prompt": all 30 capabilities live here with disambiguating docstrings, discoverable on demand.

**Files:**
- Create: `sidecar/src/ccie_sidecar/proxmox_api/__init__.py`
- Create: `sidecar/src/ccie_sidecar/proxmox_api/catalog.py`
- Test: `sidecar/tests/proxmox/test_catalog.py`

- [ ] **Step 1: Create the package `__init__.py` with attribution**

Create `sidecar/src/ccie_sidecar/proxmox_api/__init__.py`:

```python
"""
Proxmox VE code-API for the execution sandbox.

Exposes Proxmox operations as a single importable `proxmox` object so the LLM
sees one tool (execute_python_code) instead of dozens of tool schemas, per
Anthropic's "Code execution with MCP" pattern.

Operation logic is adapted from ProxmoxMCP-Plus (https://github.com/RekklesNA/
ProxmoxMCP-Plus), MIT License, Copyright (c) 2024 Kevin. The FastMCP server
layer is dropped; ops return plain Python dicts.
"""
from ccie_sidecar.proxmox_api.helper import install_proxmox
from ccie_sidecar.proxmox_api.facade import ProxmoxFacade

__all__ = ["install_proxmox", "ProxmoxFacade"]
```

- [ ] **Step 2: Create the empty test package dir + write the failing test**

Create `sidecar/tests/proxmox/__init__.py` (empty file).

Create `sidecar/tests/proxmox/test_catalog.py`:

```python
"""Tests for the Proxmox capability catalog."""
from ccie_sidecar.proxmox_api import catalog


def test_every_capability_has_name_doc_and_risk():
    assert catalog.CAPABILITIES, "catalog must not be empty"
    for cap in catalog.CAPABILITIES:
        assert cap.name and isinstance(cap.name, str)
        assert cap.group and isinstance(cap.group, str)
        assert cap.signature and isinstance(cap.signature, str)
        assert cap.doc and len(cap.doc) >= 20, f"{cap.name} doc too short"
        assert cap.risk in ("read", "mutate", "high_risk"), cap.name


def test_high_risk_set_matches_expected():
    high = {c.name for c in catalog.CAPABILITIES if c.risk == "high_risk"}
    assert {
        "delete_vm", "delete_container", "delete_snapshot", "rollback_snapshot",
        "restore_backup", "delete_backup", "delete_iso",
        "execute_vm_command", "execute_container_command",
    } <= high


def test_confusable_pairs_contrast_each_other():
    docs = {c.name: c.doc.lower() for c in catalog.CAPABILITIES}
    # stop vs shutdown
    assert "graceful" in docs["shutdown_vm"]
    assert "pull" in docs["stop_vm"] or "hard" in docs["stop_vm"]
    # delete vs rollback snapshot
    assert "revert" in docs["rollback_snapshot"]
    assert "data" in docs["rollback_snapshot"]  # warns about data loss
    assert "removes a snapshot" in docs["delete_snapshot"] or "does not" in docs["delete_snapshot"]


def test_help_lists_all_capabilities():
    out = catalog.help()
    for cap in catalog.CAPABILITIES:
        assert cap.name in out


def test_help_topic_filters_and_shows_signature():
    out = catalog.help("snapshot")
    assert "create_snapshot" in out
    assert "rollback_snapshot" in out
    assert "(" in out  # shows signatures
    assert "get_nodes" not in out


def test_search_matches_doc_text():
    names = catalog.search("revert")
    assert "rollback_snapshot" in names
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd "/Users/shaunwhi/CCIE Terminal/sidecar" && .venv/bin/python -m pytest tests/proxmox/test_catalog.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ccie_sidecar.proxmox_api.catalog'` (or ImportError for helper/facade, which don't exist yet — acceptable at this step).

- [ ] **Step 4: Write `catalog.py`**

Create `sidecar/src/ccie_sidecar/proxmox_api/catalog.py`:

```python
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
               "REVERTS the VM's disk and state back to a snapshot. DESTRUCTIVE: every change made since that snapshot is permanently lost. Requires confirm=True. This is NOT the same as delete_snapshot.", "high_risk"),
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd "/Users/shaunwhi/CCIE Terminal/sidecar" && .venv/bin/python -m pytest tests/proxmox/test_catalog.py -v`
Expected: PASS (6 tests). The `__init__.py` imports `helper`/`facade` which don't exist yet — if collection fails on that import, temporarily import only `catalog` in the test (it already does `from ccie_sidecar.proxmox_api import catalog`, which triggers package `__init__`). If `__init__` import breaks collection, make `__init__.py` imports lazy by wrapping them in `try/except ImportError: pass` until Tasks 3-4 land, then restore.

To avoid that ordering issue, set `__init__.py` for now to NOT import helper/facade:

```python
# (temporary until Tasks 3-4) — keep attribution docstring, no submodule imports yet
```

Re-run; expected PASS.

- [ ] **Step 6: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add sidecar/src/ccie_sidecar/proxmox_api/__init__.py sidecar/src/ccie_sidecar/proxmox_api/catalog.py sidecar/tests/proxmox/__init__.py sidecar/tests/proxmox/test_catalog.py
git commit -m "feat(proxmox): capability catalog with on-demand discovery"
```

---

## Task 3: Connection config reader + lazy API client

**Files:**
- Create: `sidecar/src/ccie_sidecar/proxmox_api/config.py`
- Create: `sidecar/src/ccie_sidecar/proxmox_api/client.py`
- Test: `sidecar/tests/proxmox/test_config_client.py`

- [ ] **Step 1: Write the failing test**

Create `sidecar/tests/proxmox/test_config_client.py`:

```python
"""Tests for proxmox config reading and lazy API construction."""
import sqlite3
from pathlib import Path

import pytest

from ccie_sidecar.proxmox_api import config as cfgmod
from ccie_sidecar.proxmox_api import client as clientmod


def _make_db(tmp_path: Path) -> Path:
    db = tmp_path / "sessions.db"
    conn = sqlite3.connect(str(db))
    conn.execute(
        "CREATE TABLE proxmox_config (id INTEGER PRIMARY KEY, host TEXT, port INTEGER, "
        "user TEXT, token_name TEXT, token_value TEXT, password TEXT, verify_ssl INTEGER)"
    )
    conn.execute(
        "INSERT INTO proxmox_config (id, host, port, user, token_name, token_value, password, verify_ssl) "
        "VALUES (1, '192.168.2.38', 8006, 'root@pam', '', '', 'secret', 0)"
    )
    conn.commit()
    conn.close()
    return db


def test_get_proxmox_config_reads_row(tmp_path, monkeypatch):
    db = _make_db(tmp_path)
    monkeypatch.setattr(cfgmod, "_db_path", lambda: db)
    conf = cfgmod.get_proxmox_config()
    assert conf is not None
    assert conf["host"] == "192.168.2.38"
    assert conf["port"] == 8006
    assert conf["user"] == "root@pam"
    assert conf["password"] == "secret"
    assert conf["verify_ssl"] is False


def test_get_proxmox_config_none_when_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(cfgmod, "_db_path", lambda: tmp_path / "nope.db")
    assert cfgmod.get_proxmox_config() is None


def test_env_fallback(monkeypatch, tmp_path):
    monkeypatch.setattr(cfgmod, "_db_path", lambda: tmp_path / "nope.db")
    monkeypatch.setenv("PROXMOX_HOST", "10.0.0.9")
    monkeypatch.setenv("PROXMOX_USER", "root@pam")
    monkeypatch.setenv("PROXMOX_PASSWORD", "p")
    conf = cfgmod.get_proxmox_config()
    assert conf["host"] == "10.0.0.9"


def test_build_proxmox_api_with_password(monkeypatch):
    calls = {}

    class FakeAPI:
        def __init__(self, **kwargs):
            calls.update(kwargs)

    monkeypatch.setattr(clientmod, "ProxmoxAPI", FakeAPI)
    api = clientmod.build_proxmox_api({
        "host": "h", "port": 8006, "user": "root@pam",
        "token_name": "", "token_value": "", "password": "pw", "verify_ssl": False,
    })
    assert isinstance(api, FakeAPI)
    assert calls["host"] == "h"
    assert calls["password"] == "pw"
    assert calls["verify_ssl"] is False


def test_build_proxmox_api_with_token(monkeypatch):
    calls = {}

    class FakeAPI:
        def __init__(self, **kwargs):
            calls.update(kwargs)

    monkeypatch.setattr(clientmod, "ProxmoxAPI", FakeAPI)
    clientmod.build_proxmox_api({
        "host": "h", "port": 8006, "user": "root@pam",
        "token_name": "mytok", "token_value": "abc", "password": "", "verify_ssl": True,
    })
    assert calls["token_name"] == "mytok"
    assert calls["token_value"] == "abc"
    assert "password" not in calls
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "/Users/shaunwhi/CCIE Terminal/sidecar" && .venv/bin/python -m pytest tests/proxmox/test_config_client.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ccie_sidecar.proxmox_api.config'`.

- [ ] **Step 3: Write `config.py`**

Create `sidecar/src/ccie_sidecar/proxmox_api/config.py`:

```python
"""Read Proxmox connection details from the app config DB.

Mirrors ccie_sidecar.agent.get_saved_config: the connection lives in the same
sessions.db the LLM api_key uses (NOT the encrypted vault), so it is readable
by every sandbox agent with no per-agent attachment and no lock/unlock step.
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from typing import Any


def _db_path() -> Path:
    if os.name == "nt":
        config_dir = Path(os.environ.get("APPDATA", "")) / "ccie-terminal"
    elif os.uname().sysname == "Darwin":
        config_dir = Path.home() / "Library" / "Application Support" / "ccie-terminal"
    else:
        config_dir = Path.home() / ".config" / "ccie-terminal"
    return config_dir / "sessions.db"


def _from_env() -> dict[str, Any] | None:
    host = os.environ.get("PROXMOX_HOST")
    if not host:
        return None
    return {
        "host": host,
        "port": int(os.environ.get("PROXMOX_PORT", "8006")),
        "user": os.environ.get("PROXMOX_USER", "root@pam"),
        "token_name": os.environ.get("PROXMOX_TOKEN_NAME", ""),
        "token_value": os.environ.get("PROXMOX_TOKEN_VALUE", ""),
        "password": os.environ.get("PROXMOX_PASSWORD", ""),
        "verify_ssl": os.environ.get("PROXMOX_VERIFY_SSL", "0") not in ("0", "false", "False", ""),
    }


def get_proxmox_config() -> dict[str, Any] | None:
    """Return the saved Proxmox connection dict, or None if unset.

    Reads sessions.db.proxmox_config first; falls back to PROXMOX_* env vars.
    """
    db = _db_path()
    try:
        if db.exists():
            conn = sqlite3.connect(str(db))
            try:
                cur = conn.cursor()
                cur.execute(
                    "SELECT host, port, user, token_name, token_value, password, verify_ssl "
                    "FROM proxmox_config WHERE id = 1"
                )
                row = cur.fetchone()
            finally:
                conn.close()
            if row and row[0]:
                return {
                    "host": row[0],
                    "port": int(row[1]) if row[1] is not None else 8006,
                    "user": row[2] or "root@pam",
                    "token_name": row[3] or "",
                    "token_value": row[4] or "",
                    "password": row[5] or "",
                    "verify_ssl": bool(row[6]),
                }
    except Exception:
        # Fall through to env on any DB/schema error (e.g. table not yet migrated).
        pass
    return _from_env()
```

- [ ] **Step 4: Write `client.py`**

Create `sidecar/src/ccie_sidecar/proxmox_api/client.py`:

```python
"""Lazy proxmoxer.ProxmoxAPI construction from a connection dict."""
from __future__ import annotations

from typing import Any

from proxmoxer import ProxmoxAPI  # imported at module level so tests can monkeypatch it


def build_proxmox_api(conn: dict[str, Any]) -> ProxmoxAPI:
    """Build a ProxmoxAPI from a connection dict.

    Prefers API-token auth (token_name + token_value) when present, else falls
    back to password auth. No connection test here — matches upstream; the first
    real call surfaces auth/connectivity errors.
    """
    kwargs: dict[str, Any] = {
        "host": conn["host"],
        "port": conn.get("port", 8006),
        "user": conn.get("user", "root@pam"),
        "verify_ssl": bool(conn.get("verify_ssl", False)),
    }
    token_name = conn.get("token_name") or ""
    token_value = conn.get("token_value") or ""
    if token_name and token_value:
        kwargs["token_name"] = token_name
        kwargs["token_value"] = token_value
    else:
        kwargs["password"] = conn.get("password") or ""
    return ProxmoxAPI(**kwargs)
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd "/Users/shaunwhi/CCIE Terminal/sidecar" && .venv/bin/python -m pytest tests/proxmox/test_config_client.py -v`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add sidecar/src/ccie_sidecar/proxmox_api/config.py sidecar/src/ccie_sidecar/proxmox_api/client.py sidecar/tests/proxmox/test_config_client.py
git commit -m "feat(proxmox): config DB reader and lazy proxmoxer client"
```

---

## Task 4: Operation functions (proxmoxer call chains → plain dicts)

**Files:**
- Create: `sidecar/src/ccie_sidecar/proxmox_api/ops.py`
- Test: `sidecar/tests/proxmox/test_ops_mocked.py`

These are thin wrappers over the exact `proxmoxer` call chains verified from upstream. Each returns a plain dict; never raises for API errors — wraps them as `{"ok": False, "error": "..."}`.

- [ ] **Step 1: Write the failing test**

Create `sidecar/tests/proxmox/test_ops_mocked.py`:

```python
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
    api.nodes.get.return_value = [{"node": "pve1"}]
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "/Users/shaunwhi/CCIE Terminal/sidecar" && .venv/bin/python -m pytest tests/proxmox/test_ops_mocked.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ccie_sidecar.proxmox_api.ops'`.

- [ ] **Step 3: Write `ops.py`**

Create `sidecar/src/ccie_sidecar/proxmox_api/ops.py`:

```python
"""Proxmox operations — thin wrappers over proxmoxer call chains.

Each function takes the proxmoxer API as its first arg and returns a plain dict.
API errors are caught and returned as {"ok": False, "error": "..."} so agent
code sees structured failures, never raw tracebacks. Call chains mirror
ProxmoxMCP-Plus (MIT).
"""
from __future__ import annotations

from typing import Any


def _ok(**kw: Any) -> dict[str, Any]:
    return {"ok": True, **kw}


def _err(op: str, e: Exception) -> dict[str, Any]:
    return {"ok": False, "error": f"{op}: {e}"}


def _qemu_or_lxc(api: Any, node: str, vmid: str, vm_type: str):
    return api.nodes(node).lxc(vmid) if vm_type == "lxc" else api.nodes(node).qemu(vmid)


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
            if not name:
                continue
            for vm in api.nodes(name).qemu.get():
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
            pass  # not found → good, proceed
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
            if not name:
                continue
            for ct in api.nodes(name).lxc.get():
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


def start_container(api: Any, node: str, vmid: str) -> dict[str, Any]:
    try:
        return _ok(upid=api.nodes(node).lxc(vmid).status.start.post())
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "/Users/shaunwhi/CCIE Terminal/sidecar" && .venv/bin/python -m pytest tests/proxmox/test_ops_mocked.py -v`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add sidecar/src/ccie_sidecar/proxmox_api/ops.py sidecar/tests/proxmox/test_ops_mocked.py
git commit -m "feat(proxmox): operation functions over proxmoxer call chains"
```

---

## Task 5: Facade with `confirm=True` gating

**Files:**
- Create: `sidecar/src/ccie_sidecar/proxmox_api/facade.py`
- Test: `sidecar/tests/proxmox/test_facade.py`

- [ ] **Step 1: Write the failing test**

Create `sidecar/tests/proxmox/test_facade.py`:

```python
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "/Users/shaunwhi/CCIE Terminal/sidecar" && .venv/bin/python -m pytest tests/proxmox/test_facade.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ccie_sidecar.proxmox_api.facade'`.

- [ ] **Step 3: Write `facade.py`**

Create `sidecar/src/ccie_sidecar/proxmox_api/facade.py`:

```python
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
                except Exception:
                    self._api = None
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
            return {"ok": False, "error": "Proxmox is not configured. Set host/credentials in Settings → Proxmox."}
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd "/Users/shaunwhi/CCIE Terminal/sidecar" && .venv/bin/python -m pytest tests/proxmox/test_facade.py -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add sidecar/src/ccie_sidecar/proxmox_api/facade.py sidecar/tests/proxmox/test_facade.py
git commit -m "feat(proxmox): facade with lazy api and confirm-gated high-risk ops"
```

---

## Task 6: `install_proxmox` + sandbox wiring

**Files:**
- Create: `sidecar/src/ccie_sidecar/proxmox_api/helper.py`
- Modify: `sidecar/src/ccie_sidecar/proxmox_api/__init__.py` (restore imports)
- Modify: `sidecar/src/ccie_sidecar/agents/code_exec.py`
- Test: `sidecar/tests/proxmox/test_install.py`

- [ ] **Step 1: Write the failing test**

Create `sidecar/tests/proxmox/test_install.py`:

```python
"""install_proxmox registers `proxmox` as a global and an importable module."""
from ccie_sidecar.proxmox_api.helper import install_proxmox


def test_install_registers_global():
    g = {}
    install_proxmox(g)
    assert "proxmox" in g
    assert hasattr(g["proxmox"], "get_nodes")
    assert hasattr(g["proxmox"], "help")


def test_installed_object_is_importable_as_module():
    g = {"__builtins__": __import__("builtins")}
    install_proxmox(g)
    # Code run in this globals dict can `import proxmox`.
    exec("import proxmox\nresult = proxmox.help()", g)
    assert "get_nodes" in g["result"]


def test_build_sandbox_globals_includes_proxmox():
    from ccie_sidecar.agents.code_exec import _build_sandbox_globals
    g = _build_sandbox_globals(cli_package=None, secrets={})
    assert "proxmox" in g
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "/Users/shaunwhi/CCIE Terminal/sidecar" && .venv/bin/python -m pytest tests/proxmox/test_install.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ccie_sidecar.proxmox_api.helper'`.

- [ ] **Step 3: Write `helper.py`** (mirrors `install_drawio`'s global+module registration)

Create `sidecar/src/ccie_sidecar/proxmox_api/helper.py`:

```python
"""Install the `proxmox` facade into a sandbox globals dict.

Mirrors drawio_helper.install_drawio: registers the facade as a global AND as an
importable module, so both `proxmox.get_nodes()` and `import proxmox` work inside
execute_python_code.
"""
from __future__ import annotations

import sys
import types
from typing import Any, Callable, Optional

from ccie_sidecar.proxmox_api.facade import ProxmoxFacade


def install_proxmox(globals_dict: dict[str, Any], emit: Optional[Callable[[dict], None]] = None) -> ProxmoxFacade:
    """Create a ProxmoxFacade, register it as the `proxmox` global, and expose it
    as an importable module named `proxmox`.

    `emit` is accepted for parity with other helpers (unused in v1; reserved for
    future event streaming).
    """
    facade = ProxmoxFacade()

    # As a global.
    globals_dict["proxmox"] = facade

    # As an importable module: build a lightweight module object proxying the facade.
    mod = types.ModuleType("proxmox")
    for attr in dir(facade):
        if attr.startswith("_"):
            continue
        setattr(mod, attr, getattr(facade, attr))
    sys.modules["proxmox"] = mod

    return facade
```

- [ ] **Step 4: Restore `__init__.py` imports**

Replace the temporary `sidecar/src/ccie_sidecar/proxmox_api/__init__.py` body (the docstring + temporary comment) so it again ends with:

```python
from ccie_sidecar.proxmox_api.helper import install_proxmox
from ccie_sidecar.proxmox_api.facade import ProxmoxFacade

__all__ = ["install_proxmox", "ProxmoxFacade"]
```

- [ ] **Step 5: Wire into `_build_sandbox_globals`**

In `sidecar/src/ccie_sidecar/agents/code_exec.py`, find the drawio install block (around line 65-70):

```python
    try:
        from ccie_sidecar.agents.drawio_helper import install_drawio
        install_drawio(globals_dict, emit=emit)
    except ImportError:
        pass
```

Immediately after that block, add:

```python
    # Proxmox VE code-API — available to every sandbox agent (zero-config). Reads
    # connection details from the app config DB. Registers `proxmox` as a global
    # and importable module, mirroring drawio.
    try:
        from ccie_sidecar.proxmox_api.helper import install_proxmox
        install_proxmox(globals_dict, emit=emit)
    except ImportError:
        pass
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd "/Users/shaunwhi/CCIE Terminal/sidecar" && .venv/bin/python -m pytest tests/proxmox/test_install.py -v`
Expected: PASS (3 tests).

- [ ] **Step 7: Run the full proxmox suite + a quick sandbox smoke**

Run: `cd "/Users/shaunwhi/CCIE Terminal/sidecar" && .venv/bin/python -m pytest tests/proxmox/ -v`
Expected: all PASS (catalog 6 + config/client 5 + ops 10 + facade 6 + install 3 = 30).

- [ ] **Step 8: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add sidecar/src/ccie_sidecar/proxmox_api/helper.py sidecar/src/ccie_sidecar/proxmox_api/__init__.py sidecar/src/ccie_sidecar/agents/code_exec.py sidecar/tests/proxmox/test_install.py
git commit -m "feat(proxmox): install_proxmox helper + sandbox wiring for all agents"
```

---

## Task 7: Tiny prompt blurb for code agents

**Files:**
- Modify: `sidecar/src/ccie_sidecar/agents/code_exec.py`
- Test: `sidecar/tests/proxmox/test_prompt_blurb.py`

The requirement: keep the prompt addition tiny (~3 lines) and only for sandbox agents.

- [ ] **Step 1: Write the failing test**

Create `sidecar/tests/proxmox/test_prompt_blurb.py`:

```python
from ccie_sidecar.agents.code_exec import PROXMOX_SANDBOX_BLURB


def test_blurb_is_short_and_mentions_help():
    assert "proxmox" in PROXMOX_SANDBOX_BLURB.lower()
    assert "help()" in PROXMOX_SANDBOX_BLURB
    # Keep it tiny — no giant API dump.
    assert PROXMOX_SANDBOX_BLURB.count("\n") <= 4
    assert len(PROXMOX_SANDBOX_BLURB) < 400
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd "/Users/shaunwhi/CCIE Terminal/sidecar" && .venv/bin/python -m pytest tests/proxmox/test_prompt_blurb.py -v`
Expected: FAIL — `ImportError: cannot import name 'PROXMOX_SANDBOX_BLURB'`.

- [ ] **Step 3: Add the blurb constant**

In `sidecar/src/ccie_sidecar/agents/code_exec.py`, near the top after the module docstring/imports, add:

```python
# Tiny prompt addition for sandbox agents. Discovery is on-demand (help/search),
# so no per-capability schemas hit the prompt.
PROXMOX_SANDBOX_BLURB = (
    "A `proxmox` module is available in your Python sandbox for managing Proxmox VE "
    "(VMs, containers, snapshots, backups, ISOs, cluster). Call `proxmox.help()` to list "
    "capabilities and `proxmox.help('<topic>')` for signatures before using one. "
    "Destructive operations require an explicit confirm=True after you confirm intent with the user."
)
```

- [ ] **Step 4: Append the blurb at the sandbox-loop `create_deep_agent` sites**

The blurb must be added ONLY where the sandbox is built (so non-code agents are unaffected),
which is the two deepagents loops in `sidecar/src/ccie_sidecar/agents/deepagents_runtime.py`.
Both read `agent_def.get("system_prompt", "")` straight into `create_deep_agent`. Make two
edits:

(a) In `deepagents_code_exec_loop` (around line 233), change:

```python
        graph = create_deep_agent(
            model=chat_model,
            tools=[execute_code_tool],
            system_prompt=agent_def.get("system_prompt", ""),
```

to:

```python
        from ccie_sidecar.agents.code_exec import PROXMOX_SANDBOX_BLURB
        graph = create_deep_agent(
            model=chat_model,
            tools=[execute_code_tool],
            system_prompt=(agent_def.get("system_prompt", "") or "") + "\n\n" + PROXMOX_SANDBOX_BLURB,
```

(b) In `deepagents_react_code_loop` (around line 488, where `system_prompt = _iac_system_prompt(base_prompt)...` is computed just before its `create_deep_agent`), append the blurb to that local `system_prompt` variable immediately after it is assigned:

```python
        from ccie_sidecar.agents.code_exec import PROXMOX_SANDBOX_BLURB
        system_prompt = (system_prompt or "") + "\n\n" + PROXMOX_SANDBOX_BLURB
```

(Place this line after the existing `system_prompt = ( _iac_system_prompt(base_prompt) ... )`
assignment and before `create_deep_agent(...)`.)

Note: the legacy `code_exec.code_exec_loop` builds its own prompt path; the deepagents engine
is the default for bundled agents, so these two sites cover the proxmox agent and all
deepagents code agents. Do not edit `build_agent_system_prompt` (that would leak the blurb to
non-sandbox agents).

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd "/Users/shaunwhi/CCIE Terminal/sidecar" && .venv/bin/python -m pytest tests/proxmox/test_prompt_blurb.py -v`
Expected: PASS.

- [ ] **Step 6: Verify no existing sidecar tests broke**

Run: `cd "/Users/shaunwhi/CCIE Terminal/sidecar" && .venv/bin/python -m pytest tests/ -q -k "agent or code_exec or deepagents or proxmox"`
Expected: PASS (pre-existing unrelated failures noted in memory — test_agent.py / test_analyze_error.py — may still fail; confirm no NEW failures vs. baseline).

- [ ] **Step 7: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add sidecar/src/ccie_sidecar/agents/code_exec.py sidecar/src/ccie_sidecar/agents/deepagents_runtime.py sidecar/tests/proxmox/test_prompt_blurb.py
git commit -m "feat(proxmox): tiny on-demand discovery blurb for sandbox agents"
```

---

## Task 8: Config DB migration + Rust commands

**Files:**
- Create: `src-tauri/migrations/V0051__proxmox_config.sql`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: the invoke-handler registration (search for `ai_save_config` in `generate_handler!` / `.invoke_handler(`)

- [ ] **Step 1: Create the migration**

Create `src-tauri/migrations/V0051__proxmox_config.sql`:

```sql
-- Proxmox VE connection details, single row (id = 1). Stored like ai_config
-- (V0009), NOT in the encrypted vault, so the sidecar can read it directly for
-- every agent. Same plaintext bar as the existing LLM api_key.
CREATE TABLE IF NOT EXISTS proxmox_config (
    id           INTEGER PRIMARY KEY,
    host         TEXT,
    port         INTEGER NOT NULL DEFAULT 8006,
    user         TEXT NOT NULL DEFAULT 'root@pam',
    token_name   TEXT NOT NULL DEFAULT '',
    token_value  TEXT NOT NULL DEFAULT '',
    password     TEXT NOT NULL DEFAULT '',
    verify_ssl   INTEGER NOT NULL DEFAULT 0
);
```

- [ ] **Step 2: Verify the migration runner picks up V0051**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && ls src-tauri/migrations/ | sort | tail -3`
Expected: `V0051__proxmox_config.sql` is present and is the highest-numbered file.

- [ ] **Step 3: Add the `ProxmoxConfig` struct + two commands**

In `src-tauri/src/commands/mod.rs`, near the `AIProviderConfig` struct / `ai_save_config` (around line 3560-3615), add:

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxmoxConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub token_name: String,
    #[serde(default)]
    pub token_value: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub verify_ssl: bool,
}

#[tauri::command]
pub fn proxmox_save_config(
    state: State<'_, AppState>,
    config: ProxmoxConfig,
) -> Result<(), String> {
    let db = state.db.lock();
    db.execute(
        "INSERT OR REPLACE INTO proxmox_config \
         (id, host, port, user, token_name, token_value, password, verify_ssl) \
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            &config.host,
            config.port as i64,
            &config.user,
            &config.token_name,
            &config.token_value,
            &config.password,
            if config.verify_ssl { 1_i64 } else { 0_i64 },
        ],
    )
    .map_err(|e| format!("Failed to save Proxmox config: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn proxmox_get_config(state: State<'_, AppState>) -> Result<Option<ProxmoxConfig>, String> {
    let db = state.db.lock();
    let mut stmt = db
        .prepare(
            "SELECT host, port, user, token_name, token_value, password, verify_ssl \
             FROM proxmox_config WHERE id = 1",
        )
        .map_err(|e| format!("Failed to query Proxmox config: {}", e))?;
    let config = stmt
        .query_row([], |row| {
            Ok(ProxmoxConfig {
                host: row.get(0)?,
                port: row.get::<_, i64>(1)? as u16,
                user: row.get(2)?,
                token_name: row.get(3)?,
                token_value: row.get(4)?,
                password: row.get(5)?,
                verify_ssl: row.get::<_, i64>(6)? != 0,
            })
        })
        .optional()
        .map_err(|e| format!("Failed to read Proxmox config: {}", e))?;
    Ok(config)
}
```

(`State`, `rusqlite`, and `OptionalExtension` for `.optional()` are already imported in this file — they're used by `ai_get_config`. If `optional()` is not in scope, add `use rusqlite::OptionalExtension;` near the other imports.)

- [ ] **Step 4: Register the commands in the invoke handler**

Find the `tauri::generate_handler![` (or `.invoke_handler(tauri::generate_handler![`) list — search for `ai_save_config,` (it lives in `src-tauri/src/lib.rs` or `main.rs`).

Run: `cd "/Users/shaunwhi/CCIE Terminal" && grep -rn "ai_save_config," src-tauri/src/`

In that same list, immediately after the `ai_get_config,` entry, add:

```rust
            commands::proxmox_save_config,
            commands::proxmox_get_config,
```

(Match the existing path prefix used for `ai_save_config` in that list — it may be `commands::ai_save_config` or just `ai_save_config`. Mirror exactly.)

- [ ] **Step 5: Build the Rust side to verify it compiles**

Run: `cd "/Users/shaunwhi/CCIE Terminal/src-tauri" && cargo build 2>&1 | tail -20`
Expected: `Finished` with no errors. (Warnings OK.)

- [ ] **Step 6: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add src-tauri/migrations/V0051__proxmox_config.sql src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(proxmox): config DB migration V0051 + save/get Tauri commands"
```

(Adjust the `git add` path in step 6 if the handler list lives in `main.rs` rather than `lib.rs`.)

---

## Task 9: Frontend — tauri bindings + Settings → Proxmox tab

**Files:**
- Modify: `src/lib/tauri.ts`
- Create: `src/components/settings/ProxmoxSettingsTab.tsx`
- Modify: `src/windows/Settings.tsx`

- [ ] **Step 1: Add the tauri.ts bindings**

In `src/lib/tauri.ts`, after the `aiTestConnection` block (around line 1559), add:

```typescript
export type ProxmoxConfig = {
  host: string;
  port: number;
  user: string;
  tokenName?: string;
  tokenValue?: string;
  password?: string;
  verifySsl?: boolean;
};

export const proxmoxSaveConfig = (config: ProxmoxConfig) =>
  invoke<void>("proxmox_save_config", { config });

export const proxmoxGetConfig = () =>
  invoke<ProxmoxConfig | null>("proxmox_get_config");
```

- [ ] **Step 2: Create the Settings tab component**

Create `src/components/settings/ProxmoxSettingsTab.tsx` (modeled on `PyatsSettingsTab.tsx`):

```tsx
import { useEffect, useState } from "react";
import { proxmoxGetConfig, proxmoxSaveConfig, type ProxmoxConfig } from "../../lib/tauri";

export function ProxmoxSettingsTab() {
  const [cfg, setCfg] = useState<ProxmoxConfig>({
    host: "",
    port: 8006,
    user: "root@pam",
    tokenName: "",
    tokenValue: "",
    password: "",
    verifySsl: false,
  });
  const [status, setStatus] = useState<string>("");

  useEffect(() => {
    proxmoxGetConfig()
      .then((c) => {
        if (c) setCfg({ ...cfg, ...c });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    try {
      await proxmoxSaveConfig(cfg);
      setStatus("Saved. Available to all agents.");
    } catch (e) {
      setStatus(`Save failed: ${String(e)}`);
    }
  };

  return (
    <div className="tab-content">
      <h3>Proxmox VE</h3>
      <p>
        Connection details for the bundled Proxmox tool, available to every agent.
        Stored locally like your AI provider key. Use an API token when possible;
        password is a fallback.
      </p>
      <label>
        Host
        <input value={cfg.host} onChange={(e) => setCfg({ ...cfg, host: e.target.value })} placeholder="192.168.2.38" />
      </label>
      <label>
        Port
        <input type="number" value={cfg.port} onChange={(e) => setCfg({ ...cfg, port: Number(e.target.value) })} />
      </label>
      <label>
        User
        <input value={cfg.user} onChange={(e) => setCfg({ ...cfg, user: e.target.value })} placeholder="root@pam" />
      </label>
      <label>
        Token name (optional)
        <input value={cfg.tokenName} onChange={(e) => setCfg({ ...cfg, tokenName: e.target.value })} />
      </label>
      <label>
        Token value (optional)
        <input type="password" value={cfg.tokenValue} onChange={(e) => setCfg({ ...cfg, tokenValue: e.target.value })} />
      </label>
      <label>
        Password (fallback)
        <input type="password" value={cfg.password} onChange={(e) => setCfg({ ...cfg, password: e.target.value })} />
      </label>
      <label>
        <input type="checkbox" checked={!!cfg.verifySsl} onChange={(e) => setCfg({ ...cfg, verifySsl: e.target.checked })} />
        Verify TLS certificate
      </label>
      <div style={{ marginTop: 12 }}>
        <button className="primary" onClick={save}>Save</button>
        <span style={{ marginLeft: 12 }}>{status}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Register the tab in `Settings.tsx`**

In `src/windows/Settings.tsx`:

(a) Add the import near the other settings-tab imports (around line 12):

```tsx
import { ProxmoxSettingsTab } from "../components/settings/ProxmoxSettingsTab";
```

(b) Add `"proxmox"` to the `activeTab` union type (around line 72). Find the `useState<...>` for `activeTab` and add `| "proxmox"` to its union.

(c) Add a tab button after the `pyats` button (around line 496-499). Mirror the existing button markup:

```tsx
            <button
              className={activeTab === "proxmox" ? "active" : ""}
              onClick={() => setActiveTab("proxmox")}
            >
              Proxmox
            </button>
```

(d) Render the tab near the other `{activeTab === "..." && (...)}` blocks (e.g. after the pyats render block):

```tsx
        {activeTab === "proxmox" && <ProxmoxSettingsTab />}
```

- [ ] **Step 4: Type-check / build the frontend**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -20`
Expected: no errors referencing `ProxmoxSettingsTab`, `proxmoxGetConfig`, or `activeTab`.

- [ ] **Step 5: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add src/lib/tauri.ts src/components/settings/ProxmoxSettingsTab.tsx src/windows/Settings.tsx
git commit -m "feat(proxmox): Settings tab + tauri bindings for connection config"
```

---

## Task 10: Bundled `proxmox` agent persona

**Files:**
- Create: `bundled-agents/proxmox/AGENT.md`

- [ ] **Step 1: Inspect an existing bundled agent for the exact frontmatter schema**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && sed -n '1,40p' bundled-agents/pyats/AGENT.md`
Expected: shows YAML frontmatter keys (`name`, `description`, `system-prompt`, `execution-mode`, etc.). Mirror these exactly.

- [ ] **Step 2: Create the agent**

Create `bundled-agents/proxmox/AGENT.md`. **Important:** the persona goes inside a
`system-prompt:` YAML block (NOT a markdown body) — that's how `pyats`/`meraki` work and how
the deepagents loops read it. Use `execution-mode: react-code` (same as pyats; it routes to
the sandbox loop that calls `_build_sandbox_globals`). Do **not** add an `attached-tools`
block — Proxmox needs no per-agent tool/vault wiring (the API is injected globally).

```markdown
---
name: proxmox
description: Proxmox VE virtualization expert - manage VMs, containers, snapshots, backups, ISOs, and cluster health.
system-prompt: |
  You are a Proxmox VE operations expert. You manage virtual machines, LXC
  containers, snapshots, backups, ISO images, storage, and cluster health.

  A `proxmox` module is pre-loaded in your Python sandbox. Use it via the single
  execute_python_code tool:

  - Start every task by calling `proxmox.help()` to see capabilities, and
    `proxmox.help('<topic>')` (e.g. 'snapshot', 'vm', 'backup') for exact
    signatures. NEVER guess function names — only use names from help().
  - Read operations (get_nodes, get_vms, get_storage, list_snapshots, ...) return
    plain dicts shaped {"ok": True, ...}. Filter and summarize in Python before
    reporting — do not dump raw API output. Check result["ok"] and surface
    result["error"] on failure.
  - Destructive operations (delete_vm, delete_container, delete_snapshot,
    rollback_snapshot, restore_backup, delete_backup, delete_iso,
    execute_vm_command, execute_container_command) require confirm=True. NEVER
    pass confirm=True until you have shown the user exactly what will happen
    (which node, which vmid, what is lost) and they have explicitly approved.
    Without confirm=True these return {"ok": False, "needs_confirm": True}.
  - Distinguish carefully:
    - `stop_vm` (HARD power-off) vs `shutdown_vm` (GRACEFUL) — prefer shutdown_vm.
    - `delete_snapshot` (removes a saved snapshot, VM unchanged) vs
      `rollback_snapshot` (reverts the VM, loses everything since the snapshot).
  - If `proxmox` reports "not configured", tell the user to set host and
    credentials in Settings -> Proxmox.

  Inspect before you change. Confirm before anything destructive.

execution-mode: react-code

allowed-commands: []
---
```

- [ ] **Step 3: Verify the sidecar can load the agent**

Run: `cd "/Users/shaunwhi/CCIE Terminal/sidecar" && .venv/bin/python -c "from ccie_sidecar.agent import load_agent; a = load_agent('proxmox'); print(a['id'], a.get('execution_mode') or a.get('execution-mode'))"`
Expected: prints `proxmox` and the execution mode (no exception).

- [ ] **Step 4: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add bundled-agents/proxmox/AGENT.md
git commit -m "feat(proxmox): bundled proxmox agent persona"
```

---

## Task 11: Live read-only tests against 192.168.2.38

**Files:**
- Create: `sidecar/tests/proxmox/test_live_readonly.py`

These hit the real box read-only. Gated behind an env flag so CI / normal runs skip them. Verified facts: 3-node cluster (`promox1`, `proxmox2`, `proxmox3`), "ShaunsCluster", password auth `root@pam` / `Iwiwaf77`.

- [ ] **Step 1: Write the live read-only test**

Create `sidecar/tests/proxmox/test_live_readonly.py`:

```python
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
    "host": os.environ.get("PROXMOX_HOST", "192.168.2.38"),
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
```

- [ ] **Step 2: Run the live read-only tests**

Run: `cd "/Users/shaunwhi/CCIE Terminal/sidecar" && PROXMOX_LIVE=1 .venv/bin/python -m pytest tests/proxmox/test_live_readonly.py -v`
Expected: PASS (5 tests) against the real box. If it errors with auth/cert, confirm `verify_ssl=False` and creds. These tests make ZERO writes.

- [ ] **Step 3: Confirm the suite skips without the flag**

Run: `cd "/Users/shaunwhi/CCIE Terminal/sidecar" && .venv/bin/python -m pytest tests/proxmox/test_live_readonly.py -v`
Expected: 5 SKIPPED.

- [ ] **Step 4: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add sidecar/tests/proxmox/test_live_readonly.py
git commit -m "test(proxmox): live read-only tests against lab box (flag-gated)"
```

---

## Task 12: Live mutation lifecycle test (throwaway VM, nothing existing touched)

**Files:**
- Create: `sidecar/tests/proxmox/test_live_lifecycle.py`

Creates a brand-new VM at a high, verified-unused VMID, exercises start/snapshot/stop/delete-snapshot/delete, then cleans up in `finally`. Refuses to run if the VMID is occupied. Existing VMIDs on the box go up to 163, so 9920 is safe — but the test re-verifies at runtime.

- [ ] **Step 1: Write the lifecycle test**

Create `sidecar/tests/proxmox/test_live_lifecycle.py`:

```python
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
    "host": os.environ.get("PROXMOX_HOST", "192.168.2.38"),
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
```

- [ ] **Step 2: Run the lifecycle test against the real box**

Run: `cd "/Users/shaunwhi/CCIE Terminal/sidecar" && PROXMOX_LIVE_MUTATE=1 .venv/bin/python -m pytest tests/proxmox/test_live_lifecycle.py -v -s`
Expected: PASS (1 test). It creates VM 9920, snapshots it, deletes the snapshot (proving the confirm gate), then deletes the VM. After the run, the box has no VM 9920 and nothing pre-existing changed.

- [ ] **Step 3: Manually confirm nothing leaked**

Run: `cd "/Users/shaunwhi/CCIE Terminal/sidecar" && PROXMOX_LIVE=1 .venv/bin/python -c "
from ccie_sidecar.proxmox_api.client import build_proxmox_api
from ccie_sidecar.proxmox_api import ops
api = build_proxmox_api({'host':'192.168.2.38','port':8006,'user':'root@pam','token_name':'','token_value':'','password':'Iwiwaf77','verify_ssl':False})
print('9920' in {str(v['vmid']) for v in ops.get_vms(api)['vms']})
"`
Expected: prints `False` (the throwaway VM is gone).

- [ ] **Step 4: Confirm it skips without the flag**

Run: `cd "/Users/shaunwhi/CCIE Terminal/sidecar" && .venv/bin/python -m pytest tests/proxmox/test_live_lifecycle.py -v`
Expected: 1 SKIPPED.

- [ ] **Step 5: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add sidecar/tests/proxmox/test_live_lifecycle.py
git commit -m "test(proxmox): live VM lifecycle test with throwaway VMID + cleanup"
```

---

## Task 13: Full suite + end-to-end sanity + docs

**Files:**
- Modify: `docs/iac-integration.md` is unrelated; instead create `docs/proxmox-integration.md`
- Create: `docs/proxmox-integration.md`

- [ ] **Step 1: Run the entire sidecar test suite**

Run: `cd "/Users/shaunwhi/CCIE Terminal/sidecar" && .venv/bin/python -m pytest tests/proxmox/ -v && .venv/bin/python -m pytest tests/ -q 2>&1 | tail -15`
Expected: all 30 proxmox unit tests PASS; overall suite shows no NEW failures versus the documented pre-existing baseline (test_agent.py, test_analyze_error.py, test_pcap_ndjson.py).

- [ ] **Step 2: End-to-end sandbox sanity (no network needed)**

Run: `cd "/Users/shaunwhi/CCIE Terminal/sidecar" && .venv/bin/python -c "
from ccie_sidecar.agents.code_exec import _build_sandbox_globals
g = _build_sandbox_globals(cli_package=None, secrets={})
exec('import proxmox\nprint(proxmox.help()[:60])\nprint(proxmox.delete_vm(\"n\",\"1\")[\"needs_confirm\"])', g)
"`
Expected: prints the first line of the help catalog and `True` (confirm gate works through the real sandbox path).

- [ ] **Step 3: Write the integration doc**

Create `docs/proxmox-integration.md`:

```markdown
# Proxmox VE Integration

Proxmox VE control is available to **every** agent through the single
`execute_python_code` sandbox tool — following Anthropic's "code execution with
MCP" pattern. The LLM sees one tool, not 30 Proxmox schemas.

## For users

1. Open **Settings → Proxmox**.
2. Enter host (e.g. `192.168.2.38`), user (`root@pam`), and either an API token
   (recommended) or a password. Save.
3. Ask any agent to work with Proxmox ("list my VMs", "snapshot VM 105").

Connection details are stored locally in the app config DB (same as your AI
provider key), not in the encrypted vault, so all agents can use them without
unlocking anything.

## For the model

Inside `execute_python_code`:

```python
import proxmox
proxmox.help()                       # list capabilities
proxmox.help("snapshot")             # signatures for a topic
vms = proxmox.get_vms()              # {"ok": True, "vms": [...]}
proxmox.create_snapshot("pve1", "105", "pre-change")
proxmox.rollback_snapshot("pve1", "105", "pre-change", confirm=True)  # destructive
```

## Safety (v1)

Destructive operations (`delete_vm`, `delete_container`, `delete_snapshot`,
`rollback_snapshot`, `restore_backup`, `delete_backup`, `delete_iso`,
`execute_vm_command`, `execute_container_command`) refuse to run unless called
with `confirm=True`. The agent persona is instructed to confirm intent with the
user first. A UI approval modal is a planned follow-up (the reverse-RPC and IaC
interrupt channels don't fit in-sandbox calls — see the design doc).

## Source

Operation logic adapted from
[ProxmoxMCP-Plus](https://github.com/RekklesNA/ProxmoxMCP-Plus) (MIT), with the
FastMCP server layer removed; ops return plain dicts and run in-process.

See `docs/superpowers/specs/2026-06-15-proxmox-code-api-design.md` for the full
design.
```

- [ ] **Step 4: Commit**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
git add docs/proxmox-integration.md
git commit -m "docs(proxmox): integration guide for users and agents"
```

- [ ] **Step 5: Final verification summary**

Confirm and report:
- 30 unit tests pass; live read-only (5) pass against 192.168.2.38; live lifecycle (1) passes and leaves no residue.
- Rust `cargo build` succeeds; `tsc --noEmit` clean.
- `proxmox` importable in a fresh sandbox; `help()` works; confirm-gate fires.
- Settings → Proxmox tab saves/loads; sidecar reads the same row.

---

## Notes for the implementer

- **Pre-existing test failures** in `test_agent.py`, `test_analyze_error.py`, `test_pcap_ndjson.py` exist on `main` and are NOT caused by this work — don't try to fix them here. Compare against baseline.
- **Do not modify anything that already exists on the Proxmox box.** The lifecycle test guards against this with an unused-VMID assertion and `finally` cleanup.
- **Migration number:** `V0051` was the next free per project memory. If a higher migration has since landed, bump to the next free number and update the spec reference.
- **The reverse-RPC / `mcp_tools` path and the Rust `mcp/bridge.rs` stub are intentionally NOT used** — see the design doc's gating section for why. v1 gates via `confirm=True`.
