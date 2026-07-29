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
        "verify_ssl": os.environ.get("PROXMOX_VERIFY_SSL", "0").lower() in ("1", "true", "yes"),
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
