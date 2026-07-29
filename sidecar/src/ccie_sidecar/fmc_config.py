"""Read Cisco FMC connection details from the app config DB.

Mirrors ccie_sidecar.aci_config. The connection lives in the same sessions.db
the LLM api_key uses (NOT the encrypted vault), so it is readable by every
sandbox agent with no per-agent attachment. An optional domain_uuid overrides
the FMC-reported default domain.
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
    host = os.environ.get("FMC_HOST")
    if not host:
        return None
    return {
        "host": host,
        "username": os.environ.get("FMC_USERNAME", ""),
        "password": os.environ.get("FMC_PASSWORD", ""),
        "domain_uuid": os.environ.get("FMC_DOMAIN_UUID", ""),
        "verify_ssl": os.environ.get("FMC_VERIFY_SSL", "0").lower()
        in ("1", "true", "yes"),
    }


def get_fmc_config() -> dict[str, Any] | None:
    """Return the saved Cisco FMC connection dict, or None if unset.

    Reads sessions.db.fmc_config first; falls back to FMC_* env vars (which is
    how the MCP-server transport delivers them).
    """
    db = _db_path()
    try:
        if db.exists():
            conn = sqlite3.connect(str(db))
            try:
                cur = conn.cursor()
                cur.execute(
                    "SELECT host, username, password, domain_uuid, verify_ssl "
                    "FROM fmc_config WHERE id = 1"
                )
                row = cur.fetchone()
            finally:
                conn.close()
            if row and row[0]:
                return {
                    "host": row[0],
                    "username": row[1] or "",
                    "password": row[2] or "",
                    "domain_uuid": row[3] or "",
                    "verify_ssl": bool(row[4]),
                }
    except Exception:
        # Fall through to env on any DB/schema error (e.g. table not yet migrated).
        pass
    return _from_env()
