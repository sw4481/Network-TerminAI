"""Sketchfab 3D model integration.

Sketchfab's Data API v3 is rooted at https://api.sketchfab.com/v3. Search works
anonymously (rate-limited); an API token (sent as `Authorization: Token <key>`)
lifts limits and is required for download links. A single `sketchfab_api_call(
method, path, ...)` helper dispatches any endpoint; convenience wrappers cover
CC0-filtered search + model details. Read-only: everything is low.

Used by the Three.js network-visualization skill's optional real-stencil mode
to pull CC0-licensed models. Downloads should be filtered to permissive licenses.
"""

import json
import sys
import types
from typing import Any, Callable, Dict, Optional

import requests


from ccie_sidecar.api_errors import build_http_error
_API_BASE = "https://api.sketchfab.com/v3"


def _blast_radius(method: str, path: str) -> str:
    """Sketchfab is used read-only here; everything is low."""
    return "low"


class SketchfabClient:
    """Sketchfab Data API v3 client shared by the MCP server and sandbox.

    Reads {api_key} from the config dict (sourced from sessions.db, same as the
    Settings → Sketchfab tab). The key is OPTIONAL — without it, search still
    works anonymously with lower rate limits.
    """

    def __init__(self, config: Optional[Dict[str, Any]]):
        self._config = config or {}
        self._session: Optional[requests.Session] = None

    @property
    def _api_key(self) -> str:
        return (self._config.get("api_key") or "").strip()

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
        """Call a Sketchfab API endpoint. Returns a dict the agent json.loads-es.

        Shape: {"status_code", "data", "error", "blast_radius"}.
        """
        method = (method or "GET").upper()
        br = _blast_radius(method, path)

        session = self._ensure_session()
        if not path.startswith("/"):
            path = "/" + path
        url = f"{_API_BASE}{path}"

        headers = {"Accept": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Token {self._api_key}"

        try:
            resp = session.request(
                method=method, url=url, headers=headers,
                json=body, params=query_params, timeout=30,
            )
            try:
                data = resp.json()
            except Exception:
                data = resp.text

            error = None
            if resp.status_code == 401:
                error = "Authentication failed. Check the API key in Settings → Sketchfab."
            elif resp.status_code >= 400:
                error = build_http_error(resp.status_code, data)

            return {"status_code": resp.status_code, "data": data,
                    "error": error, "blast_radius": br}
        except requests.exceptions.Timeout:
            return {"status_code": 0, "data": None, "error": "Request timed out after 30 seconds", "blast_radius": br}
        except Exception as e:
            return {"status_code": 0, "data": None, "error": str(e), "blast_radius": br}

    # ---- High-level convenience helpers ------------------------------------

    def search(self, query: str, downloadable: bool = True, cc0: bool = False) -> Dict[str, Any]:
        """Search models. GET /v3/search?type=models.

        Defaults to downloadable-only. `cc0` is OPT-IN (default False): the
        Sketchfab `license=cc0` filter is extremely sparse and returns ZERO for
        most specific queries (e.g. "network router"), so forcing it silently
        hides everything. Search results also do NOT carry a license slug — call
        model(uid) to read the actual license before downloading. Prefer leaving
        cc0 off, then filter/verify licenses per-model.
        """
        params: Dict[str, Any] = {"type": "models", "q": query}
        if downloadable:
            params["downloadable"] = "true"
        if cc0:
            # CC0 Public Domain filter — very few models match; use sparingly.
            params["license"] = "cc0"
        return self.call("GET", "/search", query_params=params)

    def model(self, uid: str) -> Dict[str, Any]:
        """Model details incl. license. GET /v3/models/<uid>."""
        return self.call("GET", f"/models/{uid}")

    def download(self, uid: str) -> Dict[str, Any]:
        """Get time-limited download URLs. GET /v3/models/<uid>/download (needs a key)."""
        return self.call("GET", f"/models/{uid}/download")


def install_sketchfab(
    globals_dict: dict[str, Any],
    emit: Optional[Callable[[dict], None]] = None,
) -> SketchfabClient:
    """Bind a `sketchfab_api_call` function + `sketchfab` client into a sandbox."""
    from ccie_sidecar.sketchfab_config import get_sketchfab_config

    client = SketchfabClient(get_sketchfab_config())

    def sketchfab_api_call(
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> str:
        """Call the Sketchfab Data API v3. Returns a JSON string (use json.loads)."""
        return json.dumps(client.call(method, path, body, query_params))

    globals_dict["sketchfab_api_call"] = sketchfab_api_call
    globals_dict["sketchfab"] = client

    mod = types.ModuleType("sketchfab_api")
    mod.sketchfab_api_call = sketchfab_api_call  # type: ignore[attr-defined]
    mod.client = client  # type: ignore[attr-defined]
    sys.modules["sketchfab_api"] = mod

    return client


def test_connection(config: Dict[str, Any]) -> Dict[str, Any]:
    """Test Sketchfab reachability without saving. Returns {"ok": bool, "message": str}.

    The key is optional; a keyed test validates the token via /v3/me, an
    unkeyed test just confirms the public API is reachable via a search.
    """
    client = SketchfabClient(config)
    if (config.get("api_key") or "").strip():
        result = client.call("GET", "/me")
        status = result.get("status_code") or 0
        if status == 401:
            return {"ok": False, "message": "Authentication failed. Check the API key."}
        if status == 0 and result.get("error"):
            return {"ok": False, "message": result["error"]}
        if status >= 400:
            return {"ok": False, "message": f"HTTP {status} from Sketchfab."}
        return {"ok": True, "message": "Connected to Sketchfab (API key valid)."}

    # No key — confirm the public API answers a search.
    result = client.search("router", cc0=False)
    status = result.get("status_code") or 0
    if status == 0 and result.get("error"):
        return {"ok": False, "message": result["error"]}
    if status >= 400:
        return {"ok": False, "message": f"HTTP {status} from Sketchfab."}
    return {"ok": True, "message": "Sketchfab public API reachable (no key — anonymous, rate-limited)."}
