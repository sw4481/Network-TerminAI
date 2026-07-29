"""Test a Proxmox connection config without persisting it.

Used by the Settings → Proxmox "Test connection" button: the frontend passes the
currently-entered host/credentials, this builds a throwaway API and runs a single
read-only call (get_nodes), and returns a friendly {ok, message} result. Nothing
is saved and nothing on the server is modified.
"""
from __future__ import annotations

from typing import Any

from ccie_sidecar.proxmox_api.client import build_proxmox_api


def test_connection(conf: dict[str, Any]) -> dict[str, Any]:
    """Return {"ok": bool, "message": str} for the given connection dict."""
    if not conf or not conf.get("host"):
        return {"ok": False, "message": "No host set. Enter a Proxmox host first."}
    try:
        api = build_proxmox_api(conf)
        nodes = api.nodes.get()
    except Exception as e:  # build or first call failed (auth, TLS, DNS, timeout)
        return {"ok": False, "message": f"Connection failed: {e}"}

    names = [n.get("node") for n in nodes if isinstance(n, dict) and n.get("node")]
    online = [n.get("node") for n in nodes if isinstance(n, dict) and n.get("status") == "online"]
    summary = f"Connected. {len(names)} node(s): {', '.join(names) or 'none'}."
    if online:
        summary += f" {len(online)} online."
    return {"ok": True, "message": summary, "nodes": names}
