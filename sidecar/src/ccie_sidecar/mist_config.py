"""Read Juniper Mist connection details from the app config DB.

Mirrors ccie_sidecar.cisco_xdr_config: the connection lives in the same
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
    api_token = os.environ.get("MIST_API_TOKEN")
    if not api_token:
        return None
    return {
        "region": os.environ.get("MIST_REGION", "global01"),
        "api_token": api_token,
        "verify_ssl": os.environ.get("MIST_VERIFY_SSL", "1").lower()
        in ("1", "true", "yes"),
    }


def get_mist_config() -> dict[str, Any] | None:
    """Return the saved Juniper Mist connection dict, or None if unset.

    Reads sessions.db.mist_config first; falls back to MIST_* env vars (how the
    MCP-server transport delivers them).
    """
    db = _db_path()
    try:
        if db.exists():
            conn = sqlite3.connect(str(db))
            try:
                cur = conn.cursor()
                cur.execute(
                    "SELECT region, api_token, verify_ssl "
                    "FROM mist_config WHERE id = 1"
                )
                row = cur.fetchone()
            finally:
                conn.close()
            if row and row[1]:  # api_token present
                return {
                    "region": row[0] or "global01",
                    "api_token": row[1],
                    "verify_ssl": bool(row[2]),
                }
    except Exception:
        pass
    return _from_env()
