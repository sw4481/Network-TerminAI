"""Read gNMI target list from the app config DB.

gNMI is multi-target: the connection set lives in sessions.db.gnmi_config as a
singleton row whose `targets_json` column holds a JSON array of target dicts.
Falls back to the GNMI_TARGETS env var (a JSON array) the MCP transport injects.
"""
from __future__ import annotations

import json
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


def _parse_targets(raw: str | None) -> list[dict[str, Any]]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return [t for t in parsed if isinstance(t, dict)]
    except Exception:
        pass
    return []


def _from_env() -> dict[str, Any] | None:
    raw = os.environ.get("GNMI_TARGETS")
    targets = _parse_targets(raw)
    if not targets:
        return None
    return {"targets": targets}


def get_gnmi_config() -> dict[str, Any] | None:
    """Return {"targets": [...]} or None if unset.

    Reads sessions.db.gnmi_config.targets_json first; falls back to the
    GNMI_TARGETS env var (how the MCP-server transport delivers them).
    """
    db = _db_path()
    try:
        if db.exists():
            conn = sqlite3.connect(str(db))
            try:
                cur = conn.cursor()
                cur.execute("SELECT targets_json FROM gnmi_config WHERE id = 1")
                row = cur.fetchone()
            finally:
                conn.close()
            if row and row[0]:
                targets = _parse_targets(row[0])
                if targets:
                    return {"targets": targets}
    except Exception:
        # Fall through to env on any DB/schema error (e.g. table not yet migrated).
        pass
    return _from_env()
