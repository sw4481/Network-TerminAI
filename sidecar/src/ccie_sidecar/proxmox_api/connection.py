"""Test a Proxmox connection config without persisting it.

Used by the Settings → Proxmox "Test connection" button: the frontend passes the
currently-entered host/credentials, this builds a throwaway API and runs a single
read-only call (get_nodes), and returns a friendly {ok, message} result. Nothing
is saved and nothing on the server is modified.
"""
from __future__ import annotations

from typing import Any

import requests

from ccie_sidecar.proxmox_api.client import _as_bool


class ProxmoxConnectionTester:
    def __init__(self, request_session: requests.Session | None = None) -> None:
        self._session = request_session or requests.Session()

    def test(self, conf: dict[str, Any]) -> dict[str, Any]:
        if not conf or not conf.get("host"):
            return {"ok": False, "message": "No host set. Enter a Proxmox host first."}
        try:
            nodes = self._nodes(conf)
        except Exception as e:  # auth, TLS, DNS, timeout
            return {"ok": False, "message": f"Connection failed: {e}"}

        names = [n.get("node") for n in nodes if isinstance(n, dict) and n.get("node")]
        online = [n.get("node") for n in nodes if isinstance(n, dict) and n.get("status") == "online"]
        summary = f"Connected. {len(names)} node(s): {', '.join(names) or 'none'}."
        if online:
            summary += f" {len(online)} online."
        return {"ok": True, "message": summary, "nodes": names}

    def _nodes(self, conf: dict[str, Any]) -> list[dict[str, Any]]:
        base_url = f"https://{conf['host']}:{int(conf.get('port') or 8006)}/api2/json"
        verify_ssl = _as_bool(conf.get("verify_ssl", conf.get("verifySsl", False)))
        headers = self._headers(conf, base_url, verify_ssl)
        response = self._session.get(f"{base_url}/nodes", headers=headers, verify=verify_ssl, timeout=10)
        response.raise_for_status()
        data = response.json().get("data", [])
        return data if isinstance(data, list) else []

    def _headers(self, conf: dict[str, Any], base_url: str, verify_ssl: bool) -> dict[str, str]:
        user = str(conf.get("user") or "root@pam")
        token_name = str(conf.get("token_name") or conf.get("tokenName") or "")
        token_value = str(conf.get("token_value") or conf.get("tokenValue") or "")
        if token_name and token_value:
            token_id = token_name if "!" in token_name else f"{user}!{token_name}"
            return {"Authorization": f"PVEAPIToken={token_id}={token_value}"}

        password = str(conf.get("password") or "")
        ticket = self._session.post(
            f"{base_url}/access/ticket",
            data={"username": user, "password": password},
            verify=verify_ssl,
            timeout=10,
        )
        ticket.raise_for_status()
        ticket_data = ticket.json().get("data", {})
        return {"Cookie": f"PVEAuthCookie={ticket_data.get('ticket', '')}"}


def test_connection(conf: dict[str, Any]) -> dict[str, Any]:
    """Return {"ok": bool, "message": str} for the given connection dict."""
    return ProxmoxConnectionTester().test(conf)
