"""Best-effort repair of tool-call ``arguments`` emitted by LLMs.

Some OpenAI-compatible models (notably hosted gpt-oss-120b and other OSS
models) emit tool-call ``arguments`` that are not strict JSON. The dominant
failure mode for THIS app is the ``execute_python_code`` tool, whose only
argument is ``{"code": "<a python program>"}``: the model writes the program
with literal newlines and unescaped double-quotes INSIDE the JSON string, so
``json.loads`` dies with e.g. ``Expecting ',' delimiter: line 3 column 58``.

The stdlib parser can't recover from that, and the balanced-brace extractor in
``agents/deepagents_middleware._repair_to_obj`` only handles garbage OUTSIDE the
object (``155503{...}``) — it re-parses the same broken span and still fails.

This module adds a targeted, DEPENDENCY-FREE repair for the broken-string case,
so a single malformed tool call degrades to "run the code the model meant" or a
clean skip, instead of killing the whole turn. If the optional ``json_repair``
package is present it is tried first (it is strictly better); we never require
it, because the sidecar ships as a pre-built bundle.
"""
from __future__ import annotations

import json
import re
from typing import Any


def _try_json_repair(raw: str) -> dict[str, Any] | None:
    """Use the optional ``json_repair`` lib if installed. None if unavailable/failed."""
    try:
        from json_repair import repair_json  # type: ignore
    except Exception:
        return None
    try:
        obj = repair_json(raw, return_objects=True)
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


def _extract_code_value(raw: str) -> dict[str, Any] | None:
    """Recover ``{"code": "..."}`` when the code value has unescaped quotes/newlines.

    We can't rely on JSON structure inside the value, so we slice from the first
    ``"code"`` key's opening quote to the LAST double-quote before the final
    closing brace, and treat everything between as the literal program. This is
    exactly the ``execute_python_code`` shape every code-exec agent uses.
    """
    m = re.search(r'"code"\s*:\s*"', raw)
    if not m:
        return None
    start = m.end()  # first char of the code value
    end_brace = raw.rfind("}")
    if end_brace == -1:
        end_brace = len(raw)
    # Last double-quote before the closing brace is the value's closing quote.
    end = raw.rfind('"', start, end_brace)
    if end <= start:
        return None
    code = raw[start:end]
    # Un-escape the sequences a well-formed payload WOULD have escaped, but only
    # the safe, common ones — leave the rest of the program byte-for-byte.
    code = (
        code.replace("\\n", "\n")
        .replace("\\t", "\t")
        .replace('\\"', '"')
        .replace("\\\\", "\\")
    )
    return {"code": code}


def repair_tool_arguments(raw: Any) -> dict[str, Any] | None:
    """Turn a possibly-malformed tool ``arguments`` value into a dict.

    Order: already-dict → strict json → json_repair (if installed) →
    balanced-brace slice → execute_python_code code-string recovery. Returns
    None only when nothing plausible could be recovered (caller decides how to
    surface that).
    """
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        return None

    s = raw.strip()
    if not s:
        return {}

    # 1. Strict parse — the overwhelming common case.
    try:
        obj = json.loads(s)
        return obj if isinstance(obj, dict) else None
    except Exception:
        pass

    # 2. Optional purpose-built library.
    obj = _try_json_repair(s)
    if obj is not None:
        return obj

    # 3. Garbage OUTSIDE a balanced object (e.g. "155503{...}\n").
    start = s.find("{")
    if start != -1:
        depth = 0
        for i in range(start, len(s)):
            ch = s[i]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        obj = json.loads(s[start : i + 1])
                        if isinstance(obj, dict):
                            return obj
                    except Exception:
                        break

    # 4. Broken string INSIDE {"code": "..."} — the gpt-oss failure mode.
    return _extract_code_value(s)
