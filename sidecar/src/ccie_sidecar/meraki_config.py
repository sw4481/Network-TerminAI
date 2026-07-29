"""Read Cisco Meraki Dashboard API config from the app config DB.

Meraki auth is a single API key. Historically it lived only in the encrypted
vault (envelope "meraki_api_key"), which the sidecar cannot decrypt — so the
Network Architect's meraki specialist had no way to authenticate. This reader
lets the key live in sessions.db like every other vendor, readable directly by
any sandbox agent. Falls back to the vault-injected secret / env var so existing
setups keep working.
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
    key = os.environ.get("MERAKI_API_KEY") or os.environ.get("MERAKI_DASHBOARD_API_KEY")
    if not key:
        return None
    return {"api_key": key, "org_id": os.environ.get("MERAKI_ORG_ID", "")}


def get_meraki_config() -> dict[str, Any] | None:
    """Return {"api_key": ..., "org_id": ...} or None if unset.

    Reads sessions.db.meraki_config first; falls back to MERAKI_* env vars.
    """
    db = _db_path()
    try:
        if db.exists():
            conn = sqlite3.connect(str(db))
            try:
                cur = conn.cursor()
                cur.execute("SELECT api_key, org_id FROM meraki_config WHERE id = 1")
                row = cur.fetchone()
            finally:
                conn.close()
            if row and row[0]:
                return {"api_key": row[0], "org_id": row[1] or ""}
    except Exception:
        # Fall through to env on any DB/schema error (e.g. table not yet migrated).
        pass
    return _from_env()
