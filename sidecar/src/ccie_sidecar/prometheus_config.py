"""Read Prometheus connection details from the app config DB.

Mirrors ccie_sidecar.ise_config. Prometheus needs a base URL and optionally an
auth method (basic user/pass, a bearer token for Grafana Cloud/Thanos/Cortex)
plus a multi-tenant org id header. All optional except the URL.
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
    url = os.environ.get("PROMETHEUS_URL")
    if not url:
        return None
    return {
        "url": url,
        "username": os.environ.get("PROMETHEUS_USERNAME", ""),
        "password": os.environ.get("PROMETHEUS_PASSWORD", ""),
        "token": os.environ.get("PROMETHEUS_TOKEN", ""),
        "org_id": os.environ.get("PROMETHEUS_ORG_ID", ""),
        "verify_ssl": os.environ.get("PROMETHEUS_VERIFY_SSL", "1").lower()
        in ("1", "true", "yes"),
    }


def get_prometheus_config() -> dict[str, Any] | None:
    """Return the saved Prometheus connection dict, or None if unset.

    Reads sessions.db.prometheus_config first; falls back to PROMETHEUS_* env
    vars (the MCP-server transport delivery path).
    """
    db = _db_path()
    try:
        if db.exists():
            conn = sqlite3.connect(str(db))
            try:
                cur = conn.cursor()
                cur.execute(
                    "SELECT url, username, password, token, org_id, verify_ssl "
                    "FROM prometheus_config WHERE id = 1"
                )
                row = cur.fetchone()
            finally:
                conn.close()
            if row and row[0]:
                return {
                    "url": row[0],
                    "username": row[1] or "",
                    "password": row[2] or "",
                    "token": row[3] or "",
                    "org_id": row[4] or "",
                    "verify_ssl": bool(row[5]),
                }
    except Exception:
        pass
    return _from_env()
