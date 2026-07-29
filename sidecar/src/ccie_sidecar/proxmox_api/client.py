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
