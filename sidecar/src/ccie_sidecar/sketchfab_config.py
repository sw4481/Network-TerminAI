"""Read Sketchfab connection details from the app config DB.

Mirrors ccie_sidecar.ise_config. Sketchfab search works key-less (rate-limited);
an API token lifts limits and is required for downloads. So the key is OPTIONAL.
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
    api_key = os.environ.get("SKETCHFAB_API_KEY")
    if api_key is None:
        return None
    return {"api_key": api_key}


def get_sketchfab_config() -> dict[str, Any] | None:
    """Return the saved Sketchfab config dict, or None if unset.

    Reads sessions.db.sketchfab_config first; falls back to SKETCHFAB_API_KEY.
    A missing/empty key is fine — the client degrades to anonymous search.
    """
    db = _db_path()
    try:
        if db.exists():
            conn = sqlite3.connect(str(db))
            try:
                cur = conn.cursor()
                cur.execute("SELECT api_key FROM sketchfab_config WHERE id = 1")
                row = cur.fetchone()
            finally:
                conn.close()
            if row is not None:
                return {"api_key": row[0] or ""}
    except Exception:
        pass
    return _from_env()
