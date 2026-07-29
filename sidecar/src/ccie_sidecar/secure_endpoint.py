"""Cisco Secure Endpoint (AMP for Endpoints) integration.

Secure Endpoint exposes a single regional REST host. The classic v1 API uses
HTTP Basic auth (API client_id as username, api_key as password); the newer v3
API uses an OAuth2 bearer token. A single `secure_endpoint_api_call(method,
path, ...)` helper drives both — the host comes from the region, the auth from
auth_mode. Mirrors the ISE integration so the MCP server and the in-sandbox
helper share one client and can't drift.
"""
from __future__ import annotations

import json
import sys
import types
from typing import Any, Callable, Dict, Optional

import requests


from ccie_sidecar.api_errors import build_http_error
# region -> regional API host. NAM is the default for unknown/empty values.
_REGION_HOSTS = {
    "nam": "api.amp.cisco.com",
    "eu": "api.eu.amp.cisco.com",
    "apjc": "api.apjc.amp.cisco.com",
}
# v3 OAuth2 token hosts (visibility.*). Wired but UNVERIFIED against hardware.
_REGION_TOKEN_HOSTS = {
    "nam": "visibility.amp.cisco.com",
    "eu": "visibility.eu.amp.cisco.com",
    "apjc": "visibility.apjc.amp.cisco.com",
}


def _region_host(region: Optional[str]) -> str:
    return _REGION_HOSTS.get((region or "").strip().lower(), _REGION_HOSTS["nam"])


def _region_token_host(region: Optional[str]) -> str:
    return _REGION_TOKEN_HOSTS.get((region or "").strip().lower(), _REGION_TOKEN_HOSTS["nam"])


def _blast_radius(method: str, path: str) -> str:
    """Classify a call for approval metadata. Method-only; never blocks.

    GET=low, DELETE=destructive, all other writes=medium.
    """
    m = (method or "GET").upper()
    if m == "GET":
        return "low"
    if m == "DELETE":
        return "destructive"
    return "medium"


class SecureEndpointClient:
    """Secure Endpoint REST client for the MCP server and code sandbox.

    Reads credentials from the config dict (sourced from sessions.db, same as the
    Settings -> Secure Endpoint tab). v1_basic uses a persistent requests.Session
    with HTTP Basic auth (no token dance). v3_oauth exchanges client_id/secret for
    a bearer token (UNVERIFIED against hardware).
    """

    def __init__(self, config: Optional[Dict[str, Any]]):
        self._config = config or {}
        self._session: Optional[requests.Session] = None
        self._bearer: Optional[str] = None

    @property
    def _region(self) -> str:
        return (self._config.get("region") or "nam").strip().lower()

    @property
    def _auth_mode(self) -> str:
        return (self._config.get("auth_mode") or "v1_basic").strip().lower()

    @property
    def _verify_ssl(self) -> bool:
        return bool(self._config.get("verify_ssl", True))

    def _ensure_session(self) -> Optional[requests.Session]:
        client_id = (self._config.get("client_id") or "").strip()
        api_key = self._config.get("api_key") or ""
        if not client_id or not api_key:
            return None
        if self._session is None:
            session = requests.Session()
            if self._auth_mode == "v1_basic":
                session.auth = (client_id, api_key)
            self._session = session
        return self._session

    def _ensure_bearer(self) -> Optional[str]:
        """v3 OAuth2 client-credentials token exchange. UNVERIFIED vs hardware."""
        if self._auth_mode != "v3_oauth":
            return None
        if self._bearer:
            return self._bearer
        client_id = (self._config.get("client_id") or "").strip()
        secret = self._config.get("api_key") or ""
        token_url = f"https://{_region_token_host(self._region)}/iroh/oauth2/token"
        try:
            resp = requests.post(
                token_url,
                auth=(client_id, secret),
                data={"grant_type": "client_credentials"},
                headers={"Content-Type": "application/x-www-form-urlencoded",
                         "Accept": "application/json"},
                verify=self._verify_ssl,
                timeout=30,
            )
            if resp.status_code < 400:
                self._bearer = resp.json().get("access_token")
        except Exception:
            self._bearer = None
        return self._bearer

    def _url(self, path: str) -> str:
        if not path.startswith("/"):
            path = "/" + path
        return f"https://{_region_host(self._region)}{path}"

    def call(
        self,
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        """Call a Secure Endpoint API endpoint. Returns the standard envelope."""
        method = (method or "GET").upper()
        client_id = (self._config.get("client_id") or "").strip()
        if not client_id:
            return {"status_code": 0, "data": None,
                    "error": "Secure Endpoint is not configured. Set credentials in Settings -> Secure Endpoint.",
                    "blast_radius": _blast_radius(method, path)}

        session = self._ensure_session()
        if session is None:
            return {"status_code": 0, "data": None,
                    "error": "Secure Endpoint credentials are incomplete. Set Client ID + API Key in Settings -> Secure Endpoint.",
                    "blast_radius": _blast_radius(method, path)}

        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if self._auth_mode == "v3_oauth":
            token = self._ensure_bearer()
            if not token:
                return {"status_code": 0, "data": None,
                        "error": "v3 OAuth token exchange failed (this path is unverified against hardware).",
                        "blast_radius": _blast_radius(method, path)}
            headers["Authorization"] = f"Bearer {token}"

        url = self._url(path)
        try:
            resp = session.request(
                method=method, url=url, headers=headers, json=body,
                params=query_params, verify=self._verify_ssl, timeout=30,
            )
            # v3 bearer can expire -> re-auth once on 401.
            if resp.status_code == 401 and self._auth_mode == "v3_oauth":
                self._bearer = None
                token = self._ensure_bearer()
                if token:
                    headers["Authorization"] = f"Bearer {token}"
                    resp = session.request(
                        method=method, url=url, headers=headers, json=body,
                        params=query_params, verify=self._verify_ssl, timeout=30,
                    )
            try:
                data = resp.json()
            except Exception:
                data = resp.text
            return {"status_code": resp.status_code, "data": data,
                    "error": None if resp.status_code < 400 else build_http_error(resp.status_code, data),
                    "blast_radius": _blast_radius(method, path)}
        except requests.exceptions.Timeout:
            return {"status_code": 0, "data": None, "error": "Request timed out after 30 seconds",
                    "blast_radius": _blast_radius(method, path)}
        except requests.exceptions.SSLError:
            return {"status_code": 0, "data": None,
                    "error": "SSL certificate verification failed (uncheck Verify SSL if needed)",
                    "blast_radius": _blast_radius(method, path)}
        except Exception as e:
            return {"status_code": 0, "data": None, "error": str(e),
                    "blast_radius": _blast_radius(method, path)}


def install_secure_endpoint(
    globals_dict: dict[str, Any],
    emit: Optional[Callable[[dict], None]] = None,
) -> SecureEndpointClient:
    """Bind a `secure_endpoint_api_call` function into a sandbox globals dict.

    Mirrors install_ise. `emit` is accepted for parity with other helpers.
    """
    from ccie_sidecar.secure_endpoint_config import get_secure_endpoint_config

    client = SecureEndpointClient(get_secure_endpoint_config())

    def secure_endpoint_api_call(
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> str:
        """Call the Cisco Secure Endpoint REST API. Returns a JSON string (json.loads it)."""
        return json.dumps(client.call(method, path, body, query_params))

    globals_dict["secure_endpoint_api_call"] = secure_endpoint_api_call
    globals_dict["secure_endpoint"] = client

    mod = types.ModuleType("secure_endpoint_api")
    mod.secure_endpoint_api_call = secure_endpoint_api_call  # type: ignore[attr-defined]
    mod.client = client  # type: ignore[attr-defined]
    sys.modules["secure_endpoint_api"] = mod

    return client


def test_connection(config: Dict[str, Any]) -> Dict[str, Any]:
    """Test a Secure Endpoint connection without saving. Returns {ok, message}."""
    client_id = (config.get("client_id") or "").strip()
    api_key = config.get("api_key") or ""
    if not client_id or not api_key:
        return {"ok": False, "message": "Client ID and API Key are required."}

    client = SecureEndpointClient(config)
    result = client.call("GET", "/v1/version")
    status = result.get("status_code") or 0
    if status == 401:
        return {"ok": False, "message": "Authentication failed. Check Client ID / API Key."}
    if status == 0 and result.get("error"):
        return {"ok": False, "message": result["error"]}
    if status >= 400:
        return {"ok": False, "message": f"HTTP {status} from Secure Endpoint."}
    host = _region_host(config.get("region"))
    return {"ok": True, "message": f"Connected to Secure Endpoint at {host}."}
