"""Read Cisco Splunk connection details from the app config DB.

Mirrors ccie_sidecar.catalyst_center_config: the connection lives in the same
sessions.db the LLM api_key uses (NOT the encrypted vault), so it is readable
by every sandbox agent with no per-agent attachment and no lock/unlock step.

Splunk's management REST API listens on HTTPS port 8089 by default. Auth is
either a Bearer token (Splunk authentication token / Splunk Cloud) or HTTP
Basic (username/password); the client prefers the token when present.
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
    host = os.environ.get("SPLUNK_HOST")
    if not host:
        return None
    try:
        port = int(os.environ.get("SPLUNK_PORT", "8089"))
    except ValueError:
        port = 8089
    return {
        "host": host,
        "port": port,
        "token": os.environ.get("SPLUNK_TOKEN", ""),
        "username": os.environ.get("SPLUNK_USERNAME", ""),
        "password": os.environ.get("SPLUNK_PASSWORD", ""),
        "verify_ssl": os.environ.get("SPLUNK_VERIFY_SSL", "0").lower()
        in ("1", "true", "yes"),
    }


def get_splunk_config() -> dict[str, Any] | None:
    """Return the saved Cisco Splunk connection dict, or None if unset.

    Reads sessions.db.splunk_config first; falls back to SPLUNK_* env vars
    (which is how the MCP-server transport delivers them).
    """
    db = _db_path()
    try:
        if db.exists():
            conn = sqlite3.connect(str(db))
            try:
                cur = conn.cursor()
                cur.execute(
                    "SELECT host, port, token, username, password, verify_ssl "
                    "FROM splunk_config WHERE id = 1"
                )
                row = cur.fetchone()
            finally:
                conn.close()
            if row and row[0]:
                return {
                    "host": row[0],
                    "port": int(row[1]) if row[1] else 8089,
                    "token": row[2] or "",
                    "username": row[3] or "",
                    "password": row[4] or "",
                    "verify_ssl": bool(row[5]),
                }
    except Exception:
        # Fall through to env on any DB/schema error (e.g. table not yet migrated).
        pass
    return _from_env()
