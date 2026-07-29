"""Read Cisco ThousandEyes API config from the app config DB.

ThousandEyes is token-only (no host/username/password), with an optional default
account group id. The config lives in the same sessions.db the LLM api_key uses
(NOT the encrypted vault), so it is readable by every sandbox agent.
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
    token = os.environ.get("THOUSANDEYES_TOKEN")
    if not token:
        return None
    return {
        "token": token,
        "account_group_id": os.environ.get("THOUSANDEYES_ACCOUNT_GROUP_ID", ""),
    }


def get_thousandeyes_config() -> dict[str, Any] | None:
    """Return the saved ThousandEyes config dict, or None if unset.

    Reads sessions.db.thousandeyes_config first; falls back to THOUSANDEYES_*
    env vars (how the MCP-server transport delivers them).
    """
    db = _db_path()
    try:
        if db.exists():
            conn = sqlite3.connect(str(db))
            try:
                cur = conn.cursor()
                cur.execute(
                    "SELECT token, account_group_id FROM thousandeyes_config WHERE id = 1"
                )
                row = cur.fetchone()
            finally:
                conn.close()
            if row and row[0]:
                return {
                    "token": row[0],
                    "account_group_id": row[1] or "",
                }
    except Exception:
        # Fall through to env on any DB/schema error (e.g. table not yet migrated).
        pass
    return _from_env()
