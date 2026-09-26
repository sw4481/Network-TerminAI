"""Read WhatsApp bridge config from the app config DB.

Mirrors ccie_sidecar.mist_config: the config lives in the same sessions.db the
LLM api_key uses (NOT the encrypted vault), so it is readable by the bridge
thread and every sandbox agent with no lock/unlock step. There are no
credentials here — the linked-device *session* (persisted by neonize to
`session_dir`) is what authenticates.
"""
from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Any


def config_dir() -> Path:
    if os.name == "nt":
        return Path(os.environ.get("APPDATA", "")) / "ccie-terminal"
    if os.uname().sysname == "Darwin":
        return Path.home() / "Library" / "Application Support" / "ccie-terminal"
    return Path.home() / ".config" / "ccie-terminal"


def _db_path() -> Path:
    return config_dir() / "sessions.db"


def _default_session_dir() -> str:
    return str(config_dir() / "whatsapp-session")


def _parse_json_list(raw: Any, fallback: list[str]) -> list[str]:
    if not raw:
        return list(fallback)
    try:
        val = json.loads(raw)
        if isinstance(val, list):
            return [str(x) for x in val]
    except (ValueError, TypeError):
        pass
    return list(fallback)


def get_whatsapp_config() -> dict[str, Any]:
    """Return the saved WhatsApp config, with sane defaults if the row is unset.

    Always returns a dict (never None) so callers can read fields directly.
    """
    enabled = False
    default_agent_id = "network-architect"
    allowlist: list[str] = []
    notify_severities = ["critical", "error"]
    session_dir = ""
    bound_chat = ""

    db = _db_path()
    try:
        if db.exists():
            conn = sqlite3.connect(str(db))
            try:
                cur = conn.cursor()
                # bound_chat_jid was added in a later migration; select it
                # defensively so an older schema still reads the rest.
                try:
                    cur.execute(
                        "SELECT enabled, default_agent_id, allowlist_json, "
                        "notify_severities_json, session_dir, bound_chat_jid "
                        "FROM whatsapp_config WHERE id = 1"
                    )
                    row = cur.fetchone()
                    has_bound = True
                except sqlite3.OperationalError:
                    cur.execute(
                        "SELECT enabled, default_agent_id, allowlist_json, "
                        "notify_severities_json, session_dir "
                        "FROM whatsapp_config WHERE id = 1"
                    )
                    row = cur.fetchone()
                    has_bound = False
            finally:
                conn.close()
            if row:
                enabled = bool(row[0])
                default_agent_id = row[1] or default_agent_id
                allowlist = _parse_json_list(row[2], [])
                notify_severities = _parse_json_list(row[3], notify_severities)
                session_dir = row[4] or ""
                if has_bound and len(row) > 5:
                    bound_chat = row[5] or ""
    except Exception:
        pass

    if not session_dir:
        session_dir = _default_session_dir()

    return {
        "enabled": enabled,
        "default_agent_id": default_agent_id,
        "allowlist": allowlist,
        "notify_severities": notify_severities,
        "session_dir": session_dir,
        "bound_chat": bound_chat,
    }


def normalize_number(num: str) -> str:
    """Reduce a phone number / JID user part to bare digits for comparison."""
    return "".join(ch for ch in str(num) if ch.isdigit())


def is_allowed(sender: str, allowlist: list[str]) -> bool:
    """True if `sender` (a JID user part or number) matches any allowlist entry.

    Empty allowlist => deny all (fail-closed): under full-trust the allowlist is
    the only guardrail, so an unconfigured allowlist must not open the door.
    """
    if not allowlist:
        return False
    s = normalize_number(sender)
    return any(normalize_number(entry) == s for entry in allowlist)
