"""Runtime feature flags shared across the sidecar.

The master ``CCIE_CONTEXT_GRAPH`` flag gates the context-graph work (agent
graph helper, temporal memory, graph-compact serialization). It is resolved
from two sources so it can be toggled either at app-launch (env) or from the
Settings UI (a row in the ``app_flags`` table of sessions.db) without a
relaunch:

1. Environment variable ``CCIE_CONTEXT_GRAPH`` — presence-or-truthy wins.
2. ``app_flags`` table key ``ccie_context_graph`` in sessions.db.

Default is OFF: when neither source enables it, every context-graph code path
is bypassed and behavior is identical to the pre-feature build. This is the
instant, no-rebuild rollback lever (see the plan's rollback contract).
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

_TRUTHY = ("1", "true", "yes", "on")


def _db_path() -> Path:
    if os.name == "nt":
        config_dir = Path(os.environ.get("APPDATA", "")) / "ccie-terminal"
    elif os.uname().sysname == "Darwin":
        config_dir = Path.home() / "Library" / "Application Support" / "ccie-terminal"
    else:
        config_dir = Path.home() / ".config" / "ccie-terminal"
    return config_dir / "sessions.db"


def _env_enabled(name: str) -> bool | None:
    """Return True/False if the env var is set, else None (unset)."""
    raw = os.environ.get(name)
    if raw is None:
        return None
    return raw.strip().lower() in _TRUTHY


def _app_flag_enabled(key: str) -> bool:
    """Read a boolean from the app_flags key/value table; False on any error."""
    db = _db_path()
    try:
        if not db.exists():
            return False
        conn = sqlite3.connect(str(db))
        try:
            cur = conn.cursor()
            cur.execute("SELECT value FROM app_flags WHERE key = ?", (key,))
            row = cur.fetchone()
        finally:
            conn.close()
        if row and row[0] is not None:
            return str(row[0]).strip().lower() in _TRUTHY
    except Exception:
        # Missing table / locked DB / schema drift -> treat as disabled.
        pass
    return False


def context_graph_enabled() -> bool:
    """True when the master context-graph feature is enabled.

    Env var takes precedence (explicit True or False both win); otherwise the
    persisted Settings toggle in app_flags decides. Default OFF.
    """
    env = _env_enabled("CCIE_CONTEXT_GRAPH")
    if env is not None:
        return env
    return _app_flag_enabled("ccie_context_graph")


# Default staleness window for remembered facts: 2 hours. A cached fact older
# than this is flagged stale so the agent re-pulls it live instead of trusting
# memory. Configurable from Settings (app_flags) or the
# CCIE_CONTEXT_GRAPH_STALENESS_SECS env var.
_DEFAULT_STALENESS_SECS = 7200


def _app_flag_int(key: str) -> int | None:
    db = _db_path()
    try:
        if not db.exists():
            return None
        conn = sqlite3.connect(str(db))
        try:
            cur = conn.cursor()
            cur.execute("SELECT value FROM app_flags WHERE key = ?", (key,))
            row = cur.fetchone()
        finally:
            conn.close()
        if row and row[0] is not None:
            v = int(str(row[0]).strip())
            return v if v > 0 else None
    except Exception:
        pass
    return None


def staleness_secs() -> int:
    """Fact staleness window in seconds. Env wins, then Settings, then 2h."""
    raw = os.environ.get("CCIE_CONTEXT_GRAPH_STALENESS_SECS")
    if raw is not None:
        try:
            v = int(raw.strip())
            if v > 0:
                return v
        except ValueError:
            pass
    return _app_flag_int("ccie_context_graph_staleness_secs") or _DEFAULT_STALENESS_SECS


def agent_lessons_enabled() -> bool:
    """True when the agent-lessons feature is enabled.

    A self-learning layer independent of the context-graph flag: agents get
    scope-relevant behavioral lessons injected at loop start, and error->recovery
    turns auto-distill a one-line lesson. Resolved exactly like
    context_graph_enabled — env ``CCIE_AGENT_LESSONS`` wins (explicit True or
    False both), else the persisted ``ccie_agent_lessons`` row in app_flags.
    Default OFF: when neither source enables it, every lessons code path is a
    no-op and behavior is byte-identical to the pre-feature build.
    """
    env = _env_enabled("CCIE_AGENT_LESSONS")
    if env is not None:
        return env
    return _app_flag_enabled("ccie_agent_lessons")
