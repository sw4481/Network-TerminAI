"""NetBox DCIM/IPAM source-of-truth integration.

NetBox authenticates with `Authorization: Token <token>` against the instance
base URL; the REST API is rooted at /api/. A single `netbox_api_call(method,
path, ...)` helper dispatches any endpoint.

This is the ONLY read-WRITE integration in this batch, so `_blast_radius`
classifies mutating verbs: GET=low, POST/PUT/PATCH=medium, DELETE=destructive.
The approval-gating machinery reads this to prompt before a write.
"""

import json
import re
import sys
import types
from typing import Any, Callable, Dict, Optional

import requests



from ccie_sidecar.api_errors import build_http_error
def _blast_radius(method: str, path: str) -> str:
    """Classify a NetBox API call for approval gating.

    NetBox is a source of truth that agents may write to, so mutating verbs get
    a non-low radius to engage the approval modal.
    """
    method = (method or "GET").upper()
    if method == "GET":
        return "low"
    if method == "DELETE":
        return "destructive"
    # POST / PUT / PATCH create or modify records.
    return "medium"


class NetboxClient:
    """Token-auth NetBox REST client shared by the MCP server and sandbox.

    Reads {url, token, verify_ssl} from the config dict (sourced from
    sessions.db, same as the Settings → NetBox tab).
    """

    def __init__(self, config: Optional[Dict[str, Any]]):
        self._config = config or {}
        self._session: Optional[requests.Session] = None

    @property
    def _base(self) -> str:
        url = (self._config.get("url") or "").strip().rstrip("/")
        if not url:
            return url
        # Normalize a mis-cased scheme (e.g. "Https://") and default to https
        # when none is given, so a typo in Settings still connects.
        m = re.match(r"^(https?)://", url, re.IGNORECASE)
        if m:
            return url[: m.start(1)] + m.group(1).lower() + url[m.end(1):]
        return "https://" + url

    @property
    def _token(self) -> str:
        return (self._config.get("token") or "").strip()

    @property
    def _verify_ssl(self) -> bool:
        return bool(self._config.get("verify_ssl", True))

    def _ensure_session(self) -> Optional[requests.Session]:
        if not self._base or not self._token:
            return None
        if self._session is None:
            session = requests.Session()
            session.headers.update({
                "Authorization": f"Token {self._token}",
                "Accept": "application/json",
                "Content-Type": "application/json",
            })
            self._session = session
        return self._session

    def call(
        self,
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        """Call a NetBox API endpoint. Returns a dict the agent json.loads-es.

        Shape: {"status_code", "data", "error", "blast_radius"}.
        """
        method = (method or "GET").upper()
        br = _blast_radius(method, path)
        if not self._base:
            return {"status_code": 0, "data": None,
                    "error": "NetBox is not configured. Set the URL/token in Settings → NetBox.",
                    "blast_radius": br}

        session = self._ensure_session()
        if session is None:
            return {"status_code": 0, "data": None,
                    "error": "NetBox credentials are incomplete. Set the URL and API token in Settings → NetBox.",
                    "blast_radius": br}

        if not path.startswith("/"):
            path = "/" + path
        url = f"{self._base}{path}"

        try:
            resp = session.request(
                method=method, url=url,
                json=body, params=query_params,
                verify=self._verify_ssl, timeout=30,
            )
            try:
                data = resp.json()
            except Exception:
                data = resp.text

            error = None
            if resp.status_code in (401, 403):
                error = "Authentication failed. Check the API token in Settings → NetBox."
            elif resp.status_code >= 400:
                error = build_http_error(resp.status_code, data)

            return {"status_code": resp.status_code, "data": data,
                    "error": error, "blast_radius": br}
        except requests.exceptions.Timeout:
            return {"status_code": 0, "data": None, "error": "Request timed out after 30 seconds", "blast_radius": br}
        except requests.exceptions.SSLError:
            return {"status_code": 0, "data": None,
                    "error": "SSL certificate verification failed (uncheck Verify SSL for self-signed certs)",
                    "blast_radius": br}
        except Exception as e:
            return {"status_code": 0, "data": None, "error": str(e), "blast_radius": br}

    # ---- High-level convenience helpers ------------------------------------

    def list_devices(self, **filters: Any) -> Dict[str, Any]:
        """DCIM: list devices. GET /api/dcim/devices/ with optional filters."""
        return self.call("GET", "/api/dcim/devices/", query_params=filters or None)

    def list_ip_addresses(self, **filters: Any) -> Dict[str, Any]:
        """IPAM: list IP addresses. GET /api/ipam/ip-addresses/."""
        return self.call("GET", "/api/ipam/ip-addresses/", query_params=filters or None)

    def list_prefixes(self, **filters: Any) -> Dict[str, Any]:
        """IPAM: list prefixes. GET /api/ipam/prefixes/."""
        return self.call("GET", "/api/ipam/prefixes/", query_params=filters or None)


def install_netbox(
    globals_dict: dict[str, Any],
    emit: Optional[Callable[[dict], None]] = None,
) -> NetboxClient:
    """Bind a `netbox_api_call` function + `netbox` client into a sandbox."""
    from ccie_sidecar.netbox_config import get_netbox_config

    client = NetboxClient(get_netbox_config())

    def netbox_api_call(
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> str:
        """Call the NetBox REST API. Returns a JSON string (use json.loads)."""
        return json.dumps(client.call(method, path, body, query_params))

    globals_dict["netbox_api_call"] = netbox_api_call
    globals_dict["netbox"] = client

    mod = types.ModuleType("netbox_api")
    mod.netbox_api_call = netbox_api_call  # type: ignore[attr-defined]
    mod.client = client  # type: ignore[attr-defined]
    sys.modules["netbox_api"] = mod

    return client


def test_connection(config: Dict[str, Any]) -> Dict[str, Any]:
    """Test a NetBox connection without saving. Returns {"ok": bool, "message": str}."""
    url = (config.get("url") or "").strip()
    token = (config.get("token") or "").strip()
    if not url:
        return {"ok": False, "message": "A NetBox URL is required."}
    if not token:
        return {"ok": False, "message": "An API token is required."}

    client = NetboxClient(config)
    # /api/status/ is a cheap authed read that confirms URL + token.
    result = client.call("GET", "/api/status/")
    status = result.get("status_code") or 0
    if status in (401, 403):
        return {"ok": False, "message": "Authentication failed. Check the API token."}
    if status == 0 and result.get("error"):
        return {"ok": False, "message": result["error"]}
    if status >= 400:
        return {"ok": False, "message": f"HTTP {status} from NetBox."}

    return {"ok": True, "message": f"Connected to NetBox at {url}."}
