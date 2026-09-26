"""Load the singleton Zabbix connection without exposing credentials."""
from __future__ import annotations

import os
import sqlite3
from typing import Any
from ccie_sidecar.grafana_config import _db_path


def _from_env() -> dict[str, Any] | None:
    url = os.environ.get("ZABBIX_URL")
    if not url:
        return None
    mode = os.environ.get("ZABBIX_AUTH_MODE", "token")
    return {"url": url, "auth_mode": mode, "token": os.environ.get("ZABBIX_TOKEN", ""),
            "username": os.environ.get("ZABBIX_USERNAME", ""), "password": os.environ.get("ZABBIX_PASSWORD", ""),
            "verify_ssl": os.environ.get("ZABBIX_VERIFY_SSL", "1").lower() in ("1", "true", "yes")}


def get_zabbix_config() -> dict[str, Any] | None:
    try:
        conn = sqlite3.connect(str(_db_path()))
        try:
            row = conn.execute("SELECT url, auth_mode, token, username, password, verify_ssl FROM zabbix_config WHERE id=1").fetchone()
        finally:
            conn.close()
        if row and row[0]:
            return dict(zip(("url", "auth_mode", "token", "username", "password", "verify_ssl"), row))
    except Exception:
        pass
    return _from_env()
