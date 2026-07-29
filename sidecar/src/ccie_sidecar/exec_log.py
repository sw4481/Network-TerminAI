"""Structured execution logging for ALL sidecar agent code runs.

Every agent (Meraki, ISE, FMC, pyATS, IaC, network-architect, and any
user-created agent) executes through the one `_execute_code_with_timeout`
chokepoint in agents/code_exec.py. Logging there captures every code block, its
output/error, which vendor helper it targeted, and timing — for every agent, no
per-agent wiring.

Two sinks, both best-effort (logging must NEVER break an agent run):
  * a rotating JSONL file at <config_dir>/logs/agent_exec.jsonl (one object per
    execution) — durable, greppable, survives restarts;
  * stderr (the sidecar's parent captures this) at INFO for live tailing.

Enable/disable and verbosity via env:
  CCIE_EXEC_LOG        = "0"/"off" to disable file logging (default ON)
  CCIE_EXEC_LOG_STDERR = "0"/"off" to silence the stderr line (default ON)
  CCIE_EXEC_LOG_MAX_BYTES = rotate threshold (default 5_000_000)
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Optional

_OFF = ("0", "false", "no", "off")
_MAX_OUTPUT_CHARS = 4000  # clip huge stdout so the log stays readable


def _enabled(name: str, default: bool = True) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in _OFF


def _config_dir() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA", "")) / "ccie-terminal"
    elif os.uname().sysname == "Darwin":
        base = Path.home() / "Library" / "Application Support" / "ccie-terminal"
    else:
        base = Path.home() / ".config" / "ccie-terminal"
    return base


def _log_path() -> Path:
    return _config_dir() / "logs" / "agent_exec.jsonl"


def _max_bytes() -> int:
    try:
        return int(os.environ.get("CCIE_EXEC_LOG_MAX_BYTES", "5000000"))
    except ValueError:
        return 5_000_000


def _clip(text: Optional[Any]) -> str:
    if not text:
        return ""
    if not isinstance(text, str):
        text = str(text)  # coerce non-string output (agents can print anything)
    if len(text) <= _MAX_OUTPUT_CHARS:
        return text
    return text[:_MAX_OUTPUT_CHARS] + f"\n…[clipped {len(text) - _MAX_OUTPUT_CHARS} chars]"


def _rotate_if_needed(path: Path) -> None:
    try:
        if path.exists() and path.stat().st_size > _max_bytes():
            bak = path.with_suffix(".jsonl.1")
            if bak.exists():
                bak.unlink()
            path.rename(bak)
    except Exception:
        pass


def log_execution(
    *,
    label: Optional[str],
    code: str,
    result: dict[str, Any],
    duration_ms: int,
) -> None:
    """Record one code execution. Best-effort: any failure here is swallowed.

    `label` is the agent/cli_package context (e.g. "meraki", "ise", or an agent
    id). `result` is the {success, output, error} dict the chokepoint returns.
    """
    try:
        entry = {
            "ts": time.time(),
            "label": label or "unknown",
            "success": bool(result.get("success")),
            "duration_ms": duration_ms,
            "code": _clip(code),
            "output": _clip(result.get("output")),
            "error": _clip(result.get("error")),
        }
        line = json.dumps(entry, default=str)

        if _enabled("CCIE_EXEC_LOG"):
            path = _log_path()
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                _rotate_if_needed(path)
                with path.open("a", encoding="utf-8") as f:
                    f.write(line + "\n")
            except Exception:
                pass

        if _enabled("CCIE_EXEC_LOG_STDERR"):
            status = "ok" if entry["success"] else "ERR"
            # One compact line to the sidecar's stderr for live tailing.
            first = (entry["code"].strip().splitlines() or [""])[0][:80]
            print(
                f"[exec_log] {entry['label']} {status} {duration_ms}ms :: {first}",
                file=sys.stderr,
                flush=True,
            )
            if not entry["success"] and entry["error"]:
                print(f"[exec_log]   error: {entry['error'].splitlines()[0][:160]}",
                      file=sys.stderr, flush=True)
    except Exception:
        # Logging must never affect an agent run.
        pass
