"""Read Cisco XDR connection details from the app config DB.

Mirrors ccie_sidecar.secure_endpoint_config: the connection lives in the same
sessions.db the LLM api_key uses (NOT the encrypted vault), so it is readable by
every sandbox agent with no per-agent attachment and no lock/unlock step.
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
    client_id = os.environ.get("CISCO_XDR_CLIENT_ID")
    if not client_id:
        return None
    return {
        "region": os.environ.get("CISCO_XDR_REGION", "nam"),
        "client_id": client_id,
        "client_password": os.environ.get("CISCO_XDR_CLIENT_PASSWORD", ""),
        "verify_ssl": os.environ.get("CISCO_XDR_VERIFY_SSL", "1").lower()
        in ("1", "true", "yes"),
    }


def get_cisco_xdr_config() -> dict[str, Any] | None:
    """Return the saved Cisco XDR connection dict, or None if unset.

    Reads sessions.db.cisco_xdr_config first; falls back to CISCO_XDR_* env vars
    (how the MCP-server transport delivers them).
    """
    db = _db_path()
    try:
        if db.exists():
            conn = sqlite3.connect(str(db))
            try:
                cur = conn.cursor()
                cur.execute(
                    "SELECT region, client_id, client_password, verify_ssl "
                    "FROM cisco_xdr_config WHERE id = 1"
                )
                row = cur.fetchone()
            finally:
                conn.close()
            if row and row[1]:  # client_id present
                return {
                    "region": row[0] or "nam",
                    "client_id": row[1],
                    "client_password": row[2] or "",
                    "verify_ssl": bool(row[3]),
                }
    except Exception:
        pass
    return _from_env()
