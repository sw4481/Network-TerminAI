"""Read NetBox connection details from the app config DB.

Mirrors ccie_sidecar.ise_config. NetBox authenticates with a base URL + API
token (Authorization: Token <token>).
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
    url = os.environ.get("NETBOX_URL")
    if not url:
        return None
    return {
        "url": url,
        "token": os.environ.get("NETBOX_TOKEN", ""),
        "verify_ssl": os.environ.get("NETBOX_VERIFY_SSL", "1").lower()
        in ("1", "true", "yes"),
    }


def get_netbox_config() -> dict[str, Any] | None:
    """Return the saved NetBox connection dict, or None if unset.

    Reads sessions.db.netbox_config first; falls back to NETBOX_* env vars.
    """
    db = _db_path()
    try:
        if db.exists():
            conn = sqlite3.connect(str(db))
            try:
                cur = conn.cursor()
                cur.execute(
                    "SELECT url, token, verify_ssl FROM netbox_config WHERE id = 1"
                )
                row = cur.fetchone()
            finally:
                conn.close()
            if row and row[0]:
                return {
                    "url": row[0],
                    "token": row[1] or "",
                    "verify_ssl": bool(row[2]),
                }
    except Exception:
        pass
    return _from_env()
