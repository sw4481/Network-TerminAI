"""IETF RFC lookup helper for the code-execution sandbox.

Available to EVERY agent (installed unconditionally alongside drawio/proxmox).
Fetches RFC full text from rfc-editor.org and searches via the IETF datatracker
API (no auth). Returns plain dicts; emits no event.

Exposed to agent code as a pre-imported `rfc` object:

    rfc.get(4271)               -> {ok, number, title, text, url}
    rfc.search("BGP")           -> list of {number, title}
    rfc.metadata(2328)          -> {ok, number, title, authors, status, ...}
"""
from __future__ import annotations

import sys
import types
from typing import Any, Callable, Dict, List, Optional

import requests

_RFC_EDITOR = "https://www.rfc-editor.org/rfc"
_DATATRACKER = "https://datatracker.ietf.org/api/v1"
_UA = "CCIE-Terminal/1.0 (network engineering assistant)"


def _norm_number(number: Any) -> Optional[str]:
    """Normalise an RFC reference (int, '4271', 'RFC4271', 'rfc 4271') to digits."""
    if number is None:
        return None
    s = str(number).strip().lower().replace("rfc", "").strip()
    return s if s.isdigit() else None


class RfcHelper:
    """Sandbox-facing IETF RFC helper."""

    def __init__(self) -> None:
        self._session = requests.Session()
        self._session.headers.update({"User-Agent": _UA})

    def get(self, number: Any) -> Dict[str, Any]:
        """Fetch the full plain text of an RFC. Returns {ok, number, text, url, error}."""
        num = _norm_number(number)
        if not num:
            return {"ok": False, "number": number, "text": None, "url": None,
                    "error": "Invalid RFC number"}
        url = f"{_RFC_EDITOR}/rfc{num}.txt"
        try:
            resp = self._session.get(url, timeout=30)
            if resp.status_code == 404:
                return {"ok": False, "number": num, "text": None, "url": url,
                        "error": f"RFC {num} not found"}
            resp.raise_for_status()
            return {"ok": True, "number": num, "text": resp.text, "url": url, "error": None}
        except Exception as e:
            return {"ok": False, "number": num, "text": None, "url": url, "error": str(e)}

    def metadata(self, number: Any) -> Dict[str, Any]:
        """Fetch RFC metadata (title, authors, status) from the datatracker."""
        num = _norm_number(number)
        if not num:
            return {"ok": False, "number": number, "error": "Invalid RFC number"}
        try:
            resp = self._session.get(
                f"{_DATATRACKER}/doc/document/",
                params={"name": f"rfc{num}", "format": "json"},
                timeout=20,
            )
            objs = resp.json().get("objects", [])
            if not objs:
                return {"ok": False, "number": num, "error": f"RFC {num} not found"}
            doc = objs[0]
            return {
                "ok": True,
                "number": num,
                "title": doc.get("title"),
                "status": doc.get("std_level") or doc.get("intended_std_level"),
                "abstract": doc.get("abstract"),
                "url": f"{_RFC_EDITOR}/rfc{num}.html",
                "error": None,
            }
        except Exception as e:
            return {"ok": False, "number": num, "error": str(e)}

    def search(self, query: str, limit: int = 10) -> Dict[str, Any]:
        """Search RFCs by title via the datatracker. Returns {ok, results, error}."""
        try:
            resp = self._session.get(
                f"{_DATATRACKER}/doc/document/",
                params={"title__icontains": query, "type": "rfc",
                        "limit": limit, "format": "json"},
                timeout=20,
            )
            objs = resp.json().get("objects", [])
            results: List[Dict[str, Any]] = [
                {
                    "number": (o.get("name") or "").replace("rfc", ""),
                    "title": o.get("title"),
                }
                for o in objs
            ]
            return {"ok": True, "results": results, "error": None}
        except Exception as e:
            return {"ok": False, "results": [], "error": str(e)}

    def help(self) -> str:
        return (
            "rfc.get(number) -> {ok, number, text, url} (full plain text); "
            "rfc.metadata(number) -> {ok, title, status, abstract, url}; "
            "rfc.search(query, limit=10) -> {ok, results:[{number, title}]}. "
            "Accepts 4271, '4271', or 'RFC 4271'."
        )


def install_rfc(
    globals_dict: Dict[str, Any],
    emit: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> "RfcHelper":
    """Register an `rfc` helper as a sandbox global AND an importable module."""
    helper = RfcHelper()
    globals_dict["rfc"] = helper

    module = types.ModuleType("rfc")
    module.get = helper.get
    module.metadata = helper.metadata
    module.search = helper.search
    module.rfc = helper
    sys.modules["rfc"] = module

    return helper
