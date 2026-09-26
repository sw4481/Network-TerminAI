"""Read Cisco Secure Endpoint connection details from the app config DB.

Mirrors ccie_sidecar.ise_config: the connection lives in the same sessions.db the
LLM api_key uses (NOT the encrypted vault), so it is readable by every sandbox
agent with no per-agent attachment and no lock/unlock step.
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
    client_id = os.environ.get("SECURE_ENDPOINT_CLIENT_ID")
    if not client_id:
        return None
    return {
        "region": os.environ.get("SECURE_ENDPOINT_REGION", "nam"),
        "auth_mode": os.environ.get("SECURE_ENDPOINT_AUTH_MODE", "v1_basic"),
        "client_id": client_id,
        "api_key": os.environ.get("SECURE_ENDPOINT_API_KEY", ""),
        "verify_ssl": os.environ.get("SECURE_ENDPOINT_VERIFY_SSL", "1").lower()
        in ("1", "true", "yes"),
    }


def get_secure_endpoint_config() -> dict[str, Any] | None:
    """Return the saved Secure Endpoint connection dict, or None if unset.

    Reads sessions.db.secure_endpoint_config first; falls back to
    SECURE_ENDPOINT_* env vars (how the MCP-server transport delivers them).
    """
    db = _db_path()
    try:
        if db.exists():
            conn = sqlite3.connect(str(db))
            try:
                cur = conn.cursor()
                cur.execute(
                    "SELECT region, auth_mode, client_id, api_key, verify_ssl "
                    "FROM secure_endpoint_config WHERE id = 1"
                )
                row = cur.fetchone()
            finally:
                conn.close()
            if row and row[2]:  # client_id present
                return {
                    "region": row[0] or "nam",
                    "auth_mode": row[1] or "v1_basic",
                    "client_id": row[2],
                    "api_key": row[3] or "",
                    "verify_ssl": bool(row[4]),
                }
    except Exception:
        pass
    return _from_env()
