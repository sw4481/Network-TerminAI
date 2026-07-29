"""Cisco DevNet content search integration.

Searches Cisco developer documentation (developer.cisco.com) — Meraki and
Catalyst Center API docs, operation-id lookup, and general DevNet content. No
authentication required (public content), so this integration is ALWAYS
available and needs no Settings tab.

A single `devnet_api_call(method, path, ...)` helper dispatches against the
public API host, plus a `devnet.search(query)` convenience wrapper. Read-only.
"""

import json
import sys
import types
from typing import Any, Callable, Dict, Optional

import requests


from ccie_sidecar.api_errors import build_http_error
# Public DevNet content/search host. No auth.
_API_BASE = "https://developer.cisco.com"


def _blast_radius(method: str, path: str) -> str:
    """DevNet content search is read-only public content; always low."""
    return "low"


class DevnetClient:
    """Public Cisco DevNet content-search client (no credentials)."""

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self._config = config or {}
        self._session: Optional[requests.Session] = None

    def _ensure_session(self) -> requests.Session:
        if self._session is None:
            self._session = requests.Session()
        return self._session

    def call(
        self,
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        """Call a DevNet content endpoint. Returns a dict the agent json.loads-es.

        Shape: {"status_code", "data", "error", "blast_radius"}.
        """
        method = (method or "GET").upper()
        br = _blast_radius(method, path)

        session = self._ensure_session()
        if not path.startswith("/"):
            path = "/" + path
        url = f"{_API_BASE}{path}"

        try:
            resp = session.request(
                method=method, url=url,
                headers={"Accept": "application/json"},
                json=body, params=query_params, timeout=30,
            )
            try:
                data = resp.json()
            except Exception:
                data = resp.text

            return {
                "status_code": resp.status_code,
                "data": data,
                "error": None if resp.status_code < 400 else build_http_error(resp.status_code, data),
                "blast_radius": br,
            }
        except requests.exceptions.Timeout:
            return {"status_code": 0, "data": None, "error": "Request timed out after 30 seconds", "blast_radius": br}
        except Exception as e:
            return {"status_code": 0, "data": None, "error": str(e), "blast_radius": br}

    # ---- High-level convenience helpers ------------------------------------

    def search(self, query: str) -> Dict[str, Any]:
        """Search DevNet content. GET /search/ with a query string.

        The public search endpoint returns matching docs/pages. Callers should
        read data for result titles + links.
        """
        return self.call("GET", "/search/", query_params={"q": query})


def install_devnet(
    globals_dict: dict[str, Any],
    emit: Optional[Callable[[dict], None]] = None,
) -> DevnetClient:
    """Bind a `devnet_api_call` function + `devnet` client into a sandbox."""
    client = DevnetClient()

    def devnet_api_call(
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> str:
        """Search Cisco DevNet documentation. Returns a JSON string (use json.loads)."""
        return json.dumps(client.call(method, path, body, query_params))

    globals_dict["devnet_api_call"] = devnet_api_call
    globals_dict["devnet"] = client

    mod = types.ModuleType("devnet_api")
    mod.devnet_api_call = devnet_api_call  # type: ignore[attr-defined]
    mod.client = client  # type: ignore[attr-defined]
    sys.modules["devnet_api"] = mod

    return client
