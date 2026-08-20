"""Cisco Meraki Dashboard integration.

Meraki exposes one REST API (https://api.meraki.com/api/v1) authenticated with a
single API key. Rather than binding the large official `meraki` SDK (~800
methods) into the sandbox — which forces the model to guess method names and
often fumbles (e.g. `meraki.Devices.getDevice` vs the instance's
`meraki.devices.getDevice`) — this module provides ONE dispatch helper,
`meraki_api_call(method, path, ...)`, mirroring ise_api_call / fmc_api_call.

The agent then uses the exact same pattern that already works reliably for
ISE/FMC: `meraki_api_call('GET', '/organizations/{orgId}/networks')`. The helper
handles auth, the base URL, cursor pagination (Link headers), and 429 rate-limit
backoff, so the model never has to.
"""
from __future__ import annotations

import json
import sys
import time
import types
from typing import Any, Callable, Dict, List, Optional

import requests


from ccie_sidecar.api_errors import build_http_error
_BASE_URL = "https://api.meraki.com/api/v1"


def _blast_radius(method: str) -> str:
    """Classify a Meraki call for approval gating. Mirrors ise/fmc style.

    Meraki paths are uniform REST, so classification is by method: GET is a
    read; DELETE is destructive; other writes (POST/PUT) are high because they
    change live network/device/policy config.
    """
    m = (method or "GET").upper()
    if m == "GET":
        return "low"
    if m == "DELETE":
        return "destructive"
    return "high"


class MerakiClient:
    """Bearer-auth Meraki Dashboard REST client for the code sandbox.

    Reads the API key from the config dict (sourced from sessions.db, same as
    Settings -> Meraki). A persistent requests.Session reuses the connection;
    the key is a static Bearer token so there is no login/token dance.
    """

    def __init__(self, config: Optional[Dict[str, Any]]):
        self._config = config or {}
        self._session: Optional[requests.Session] = None

    @property
    def _api_key(self) -> str:
        return (self._config.get("api_key") or "").strip()

    def _ensure_session(self) -> Optional[requests.Session]:
        if not self._api_key:
            return None
        if self._session is None:
            session = requests.Session()
            session.headers.update({
                "Authorization": f"Bearer {self._api_key}",
                "Accept": "application/json",
                "Content-Type": "application/json",
            })
            self._session = session
        return self._session

    @staticmethod
    def _url(path: str) -> str:
        # Accept both '/organizations' and a full URL (e.g. a Link header 'next').
        if path.startswith("http://") or path.startswith("https://"):
            return path
        if not path.startswith("/"):
            path = "/" + path
        return f"{_BASE_URL}{path}"

    @staticmethod
    def _normalize_query_params(
        query_params: Optional[Dict],
    ) -> Optional[List[tuple[str, Any]]]:
        """Encode list values using Meraki Dashboard's ``name[]`` convention.

        ``requests`` normally serializes ``{"networkIds": ["L_1"]}`` as
        ``networkIds=L_1``. Meraki's array parameters require the bracketed key
        instead (``networkIds[]=L_1``), even for one value. Scalar parameters
        retain their documented names and empty arrays are omitted.
        """
        if not query_params:
            return None
        normalized: List[tuple[str, Any]] = []
        for raw_key, value in query_params.items():
            key = str(raw_key)
            if isinstance(value, (list, tuple)):
                array_key = key if key.endswith("[]") else f"{key}[]"
                normalized.extend((array_key, item) for item in value)
            else:
                normalized.append((key, value))
        return normalized

    def call(
        self,
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
        paginate: bool = True,
    ) -> Dict[str, Any]:
        """Call a Meraki Dashboard endpoint. Returns a dict the agent json.loads-es.

        Shape: {"status_code", "data", "error", "blast_radius"}.

        For GET responses that return a JSON array, `paginate=True` (default)
        transparently follows Meraki's cursor pagination (the `next` link in the
        HTTP Link header), concatenating pages — so the agent gets the full list
        without knowing about `startingAfter`/perPage. 429 rate limits are
        retried with backoff honoring the Retry-After header.
        """
        method = (method or "GET").upper()
        br = _blast_radius(method)
        if not self._api_key:
            return {
                "status_code": 0, "data": None,
                "error": "Meraki is not configured. Set the API key in Settings -> Meraki.",
                "blast_radius": br,
            }
        session = self._ensure_session()
        if session is None:
            return {"status_code": 0, "data": None,
                    "error": "Meraki API key is missing. Set it in Settings -> Meraki.",
                    "blast_radius": br}

        try:
            aggregated: Optional[List[Any]] = None
            url: Optional[str] = self._url(path)
            params = self._normalize_query_params(query_params)
            last_status = 0
            page_guard = 0

            while url:
                page_guard += 1
                if page_guard > 100:  # hard stop against a pathological loop
                    break
                resp = self._request_with_backoff(session, method, url, body, params)
                last_status = resp.status_code
                params = None  # subsequent 'next' URLs already encode their params

                try:
                    data = resp.json()
                except Exception:
                    data = resp.text

                if resp.status_code >= 400:
                    return {"status_code": resp.status_code, "data": data,
                            "error": build_http_error(resp.status_code, data), "blast_radius": br}

                # Only GET list responses paginate; a dict/object is a single record.
                if not (paginate and method == "GET" and isinstance(data, list)):
                    return {"status_code": resp.status_code, "data": data,
                            "error": None, "blast_radius": br}

                if aggregated is None:
                    aggregated = []
                aggregated.extend(data)

                # Follow the 'next' cursor from the Link header, if present.
                url = self._next_link(resp)

            return {"status_code": last_status,
                    "data": aggregated if aggregated is not None else [],
                    "error": None, "blast_radius": br}

        except requests.exceptions.Timeout:
            return {"status_code": 0, "data": None,
                    "error": "Request timed out after 30 seconds", "blast_radius": br}
        except requests.exceptions.SSLError:
            return {"status_code": 0, "data": None,
                    "error": "SSL certificate verification failed", "blast_radius": br}
        except Exception as e:
            return {"status_code": 0, "data": None, "error": str(e), "blast_radius": br}

    def _request_with_backoff(
        self, session: requests.Session, method: str, url: str,
        body: Optional[Dict], params: Optional[Dict], max_retries: int = 3,
    ) -> requests.Response:
        """Issue one request, retrying on HTTP 429 honoring Retry-After."""
        attempt = 0
        while True:
            resp = session.request(method=method, url=url, json=body,
                                   params=params, timeout=30)
            if resp.status_code != 429 or attempt >= max_retries:
                return resp
            # Meraki sends Retry-After (seconds). Default to a short backoff.
            try:
                wait = float(resp.headers.get("Retry-After", "1"))
            except (TypeError, ValueError):
                wait = 1.0
            time.sleep(min(wait, 5.0))
            attempt += 1

    @staticmethod
    def _next_link(resp: requests.Response) -> Optional[str]:
        """Extract the 'next' page URL from Meraki's RFC5988 Link header."""
        link = resp.headers.get("Link") or ""
        for part in link.split(","):
            seg = part.strip()
            if "rel=next" in seg.replace('"', "").replace(" ", ""):
                lo, hi = seg.find("<"), seg.find(">")
                if 0 <= lo < hi:
                    return seg[lo + 1:hi]
        return None

    def help(self) -> str:
        """Usage help for the meraki_api_call door (mirrors other helpers' .help())."""
        return (
            "meraki_api_call(method, path, body=None, query_params=None) -> JSON "
            "string; json.loads it -> {status_code, data, error, blast_radius}. "
            "Paths are under https://api.meraki.com/api/v1 (omit that prefix); GET "
            "lists auto-paginate. Look up by name, then by id. Common reads: "
            "GET /organizations; GET /organizations/{org_id}/networks; "
            "GET /networks/{net_id}/devices; GET /devices/{serial} (single device "
            "detail — ALWAYS use this for device specifics, never recite from "
            "memory); GET /networks/{net_id}/clients?timespan=86400; "
            "for alerts use GET /organizations/{org_id}/assurance/alerts (org-wide; "
            "filter items by deviceSerial/network) or GET /networks/{net_id}/health/alerts; "
            "GET /networks/{net_id}/topology/linkLayer for physical links."
        )


def install_meraki(
    globals_dict: dict[str, Any],
    emit: Optional[Callable[[dict], None]] = None,
) -> MerakiClient:
    """Bind a `meraki_api_call` function into a sandbox globals dict.

    Mirrors install_ise: the agent reaches Meraki through the single
    `meraki_api_call(method, path, ...)` door instead of the raw SDK, so it uses
    the same reliable pattern as ISE/FMC. `emit` is accepted for parity.
    """
    from ccie_sidecar.meraki_config import get_meraki_config

    client = MerakiClient(get_meraki_config())

    def meraki_api_call(
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
        paginate: bool = True,
    ) -> str:
        """Call the Cisco Meraki Dashboard API. Returns a JSON string (json.loads it)."""
        # The deterministic memory WRITE hook is applied generically to every
        # vendor's `*_api_call` at the sandbox seam (graph_autocapture.
        # install_autocapture), so no per-vendor capture is wired here.
        return json.dumps(client.call(method, path, body, query_params, paginate))

    globals_dict["meraki_api_call"] = meraki_api_call
    globals_dict["meraki"] = client  # advanced use; .call(...) available

    # Make `import meraki_api` work too, mirroring install_ise.
    mod = types.ModuleType("meraki_api")
    mod.meraki_api_call = meraki_api_call  # type: ignore[attr-defined]
    mod.client = client  # type: ignore[attr-defined]
    mod.help = client.help  # type: ignore[attr-defined]
    sys.modules["meraki_api"] = mod

    return client


def test_connection(config: Dict[str, Any]) -> Dict[str, Any]:
    """Test a Meraki API key without saving. Returns {"ok": bool, "message": str}."""
    api_key = (config.get("api_key") or "").strip()
    if not api_key:
        return {"ok": False, "message": "An API key is required."}

    # Cheap authed read: list the orgs this key can see (no SDK needed).
    client = MerakiClient({"api_key": api_key})
    result = client.call("GET", "/organizations", paginate=False)
    status = result.get("status_code") or 0
    if status == 401:
        return {"ok": False, "message": "Authentication failed. Check the API key."}
    if status == 0 and result.get("error"):
        return {"ok": False, "message": result["error"]}
    if status >= 400:
        return {"ok": False, "message": f"HTTP {status} from Meraki Dashboard."}
    orgs = result.get("data") or []
    n = len(orgs) if isinstance(orgs, list) else "?"
    return {"ok": True, "message": f"Connected to Meraki Dashboard ({n} organization(s) visible)."}
