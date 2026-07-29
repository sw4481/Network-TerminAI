"""Shared helper for surfacing a vendor API's own error text on 4xx/5xx.

Every vendor REST helper (ise, aci, meraki, splunk, ...) used to collapse a
failed response to a bare ``"HTTP 400"``. That left the in-sandbox agent blind
to *why* the call failed, so it would thrash across endpoint guesses instead of
fixing the actual problem (e.g. Splunk's "Unknown search command 'index'." when
SPL isn't prefixed with ``search``).

``build_http_error`` turns the status code + response body into a richer string
like ``"HTTP 400: <vendor message>"``. It is deliberately defensive: it tries
the error-body shapes common across Cisco/observability APIs and, if none match,
falls back to a truncated raw body. Worst case it returns the plain
``"HTTP {status}"`` — never worse than before, so it is safe to drop into every
helper without per-vendor verification.
"""
from __future__ import annotations

import json
from typing import Any

# Cap raw-body fallbacks so a huge HTML/error page can't blow up the agent's
# context or a log line.
_MAX_DETAIL = 300


def _walk_for_text(obj: Any) -> str:
    """Extract a human message from a parsed JSON error body.

    Handles the shapes seen across the integrated vendors:
    - Splunk:            {"messages": [{"type": "FATAL", "text": "..."}]}
    - Meraki:            {"errors": ["...", "..."]}
    - ISE ERS:           {"ERSResponse": {"messages": [{"title": "..."}]}}
    - DNAC/Catalyst:     {"response": {"errorCode": ..., "message": "..."}}
    - Generic REST:      {"message": "..."} / {"detail": "..."} / {"error": "..."}
    - Prometheus:        {"error": "...", "errorType": "..."}
    Returns "" when nothing recognizable is found.
    """
    if not isinstance(obj, dict):
        return ""

    # 1. List-of-messages shapes (Splunk, ISE): [{"text"/"title"/"message": ...}]
    for key in ("messages", "errors"):
        val = obj.get(key)
        if isinstance(val, list) and val:
            parts = []
            for item in val:
                if isinstance(item, str):
                    parts.append(item.strip())
                elif isinstance(item, dict):
                    for mk in ("text", "title", "message", "detail"):
                        if item.get(mk):
                            parts.append(str(item[mk]).strip())
                            break
            joined = "; ".join(p for p in parts if p)
            if joined:
                return joined

    # 2. Scalar message shapes at the top level.
    for key in ("message", "detail", "error", "error_description", "title"):
        val = obj.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()

    # 3. One level of nesting (ISE ERSResponse, DNAC response wrapper).
    for key in ("ERSResponse", "response", "error"):
        nested = obj.get(key)
        if isinstance(nested, dict):
            inner = _walk_for_text(nested)
            if inner:
                return inner

    return ""


def build_http_error(status_code: int, data: Any) -> str:
    """Return ``"HTTP {status}"`` enriched with the vendor's own message.

    ``data`` may be the parsed JSON body (dict/list) or raw text (some endpoints
    stream ndjson or return HTML). Always returns a non-empty string.
    """
    base = f"HTTP {status_code}"

    parsed = data
    if isinstance(parsed, str):
        stripped = parsed.strip()
        if not stripped:
            return base
        try:
            parsed = json.loads(stripped)
        except Exception:
            # Not JSON (HTML error page, plain text) — surface a truncated body.
            snippet = " ".join(stripped.split())
            if len(snippet) > _MAX_DETAIL:
                snippet = snippet[:_MAX_DETAIL] + "…"
            return f"{base}: {snippet}"

    detail = _walk_for_text(parsed)
    if not detail:
        return base
    if len(detail) > _MAX_DETAIL:
        detail = detail[:_MAX_DETAIL] + "…"
    return f"{base}: {detail}"
