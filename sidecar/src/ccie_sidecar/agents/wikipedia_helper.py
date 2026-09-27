"""Wikipedia lookup helper for the code-execution sandbox.

Available to EVERY agent (installed unconditionally alongside drawio/proxmox).
Reads the public Wikipedia REST + Action APIs (no auth) so agents can ground
answers in encyclopedic context. Returns plain dicts; emits no event.

Exposed to agent code as a pre-imported `wikipedia` object:

    wikipedia.search("Border Gateway Protocol")   -> list of {title, snippet}
    wikipedia.summary("Border Gateway Protocol")  -> {title, extract, url}
    wikipedia.page("OSPF")                         -> {title, content, url}
"""
from __future__ import annotations

import sys
import types
from typing import Any, Callable, Dict, List, Optional

import requests

_REST_BASE = "https://en.wikipedia.org/api/rest_v1"
_ACTION_API = "https://en.wikipedia.org/w/api.php"
_UA = "CCIE-Terminal/1.0 (network engineering assistant)"


class WikipediaHelper:
    """Sandbox-facing Wikipedia helper over the public APIs."""

    def __init__(self) -> None:
        self._session = requests.Session()
        self._session.headers.update({"User-Agent": _UA, "Accept": "application/json"})

    def search(self, query: str, limit: int = 5) -> Dict[str, Any]:
        """Full-text search. Returns {ok, results: [{title, snippet, pageid}], error}."""
        try:
            resp = self._session.get(_ACTION_API, params={
                "action": "query", "list": "search", "srsearch": query,
                "srlimit": limit, "format": "json",
            }, timeout=20)
            data = resp.json()
            results: List[Dict[str, Any]] = [
                {
                    "title": r.get("title"),
                    "snippet": _strip_html(r.get("snippet", "")),
                    "pageid": r.get("pageid"),
                }
                for r in data.get("query", {}).get("search", [])
            ]
            return {"ok": True, "results": results, "error": None}
        except Exception as e:
            return {"ok": False, "results": [], "error": str(e)}

    def summary(self, title: str) -> Dict[str, Any]:
        """Lead summary of a page. Returns {ok, title, extract, url, error}."""
        try:
            resp = self._session.get(f"{_REST_BASE}/page/summary/{_enc(title)}", timeout=20)
            if resp.status_code == 404:
                return {"ok": False, "title": title, "extract": None, "url": None,
                        "error": "Page not found"}
            data = resp.json()
            return {
                "ok": True,
                "title": data.get("title"),
                "extract": data.get("extract"),
                "url": (data.get("content_urls", {}).get("desktop", {}) or {}).get("page"),
                "error": None,
            }
        except Exception as e:
            return {"ok": False, "title": title, "extract": None, "url": None, "error": str(e)}

    def page(self, title: str) -> Dict[str, Any]:
        """Full plain-text extract of a page. Returns {ok, title, content, url, error}."""
        try:
            resp = self._session.get(_ACTION_API, params={
                "action": "query", "prop": "extracts", "explaintext": 1,
                "titles": title, "redirects": 1, "format": "json",
            }, timeout=30)
            pages = resp.json().get("query", {}).get("pages", {})
            page = next(iter(pages.values()), {}) if pages else {}
            if "missing" in page:
                return {"ok": False, "title": title, "content": None, "url": None,
                        "error": "Page not found"}
            return {
                "ok": True,
                "title": page.get("title"),
                "content": page.get("extract"),
                "url": f"https://en.wikipedia.org/wiki/{_enc(page.get('title') or title)}",
                "error": None,
            }
        except Exception as e:
            return {"ok": False, "title": title, "content": None, "url": None, "error": str(e)}

    def help(self) -> str:
        return (
            "wikipedia.search(query, limit=5) -> {ok, results:[{title,snippet,pageid}]}; "
            "wikipedia.summary(title) -> {ok, title, extract, url}; "
            "wikipedia.page(title) -> {ok, title, content, url} (full plain text)."
        )


def _enc(title: str) -> str:
    import urllib.parse
    return urllib.parse.quote((title or "").replace(" ", "_"), safe="")


def _strip_html(text: str) -> str:
    import re
    return re.sub(r"<[^>]+>", "", text or "")


def install_wikipedia(
    globals_dict: Dict[str, Any],
    emit: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> "WikipediaHelper":
    """Register a `wikipedia` helper as a sandbox global AND an importable module."""
    helper = WikipediaHelper()
    globals_dict["wikipedia"] = helper

    module = types.ModuleType("wikipedia")
    module.search = helper.search
    module.summary = helper.summary
    module.page = helper.page
    module.wikipedia = helper
    sys.modules["wikipedia"] = module

    return helper
