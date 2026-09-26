"""Read Grafana connection details from the app config DB.

Mirrors ccie_sidecar.ise_config: the connection lives in the same sessions.db
the LLM api_key uses (NOT the encrypted vault), so it is readable by every
sandbox agent with no per-agent attachment and no lock/unlock step.
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
    url = os.environ.get("GRAFANA_URL")
    if not url:
        return None
    return {
        "url": url,
        "token": os.environ.get("GRAFANA_TOKEN", ""),
        "verify_ssl": os.environ.get("GRAFANA_VERIFY_SSL", "1").lower()
        in ("1", "true", "yes"),
    }


def get_grafana_config() -> dict[str, Any] | None:
    """Return the saved Grafana connection dict, or None if unset.

    Reads sessions.db.grafana_config first; falls back to GRAFANA_* env vars
    (which is how the MCP-server transport would deliver them).
    """
    db = _db_path()
    try:
        if db.exists():
            conn = sqlite3.connect(str(db))
            try:
                cur = conn.cursor()
                cur.execute(
                    "SELECT url, token, verify_ssl FROM grafana_config WHERE id = 1"
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
        # Fall through to env on any DB/schema error (e.g. table not yet migrated).
        pass
    return _from_env()
