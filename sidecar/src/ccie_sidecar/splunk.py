"""Cisco Splunk Enterprise integration.

Splunk exposes a management REST API over HTTPS (default port 8089). A single
`splunk_api_call(method, path, body=None, query_params=None)` helper wraps it.
Mirrors the ISE/CML/Catalyst Center integrations so the MCP server and the
in-sandbox helper share one client and can't drift.

Auth precedence: if a Splunk authentication token is configured it is sent as
`Authorization: Bearer <token>`; otherwise the client falls back to HTTP Basic
(username/password). Splunk accepts both per-request, so there is no separate
login/session-key dance.

Two Splunk-isms the helper handles:
- Splunk returns Atom XML by default; pass output_mode=json to get JSON. The
  helper auto-injects {"output_mode": "json"} into GET query params when absent.
- Splunk REST POST bodies are form-encoded (application/x-www-form-urlencoded),
  NOT JSON, so `body` is sent as form data.

Per design, Splunk runs with NO approval gating: every call classifies as "low"
blast radius so any operation auto-approves.
"""

import json
import sys
import types
from typing import Any, Callable, Dict, Optional

import requests

from ccie_sidecar.api_errors import build_http_error

try:  # Quiet the self-signed-cert warning when verify_ssl is off.
    from urllib3.exceptions import InsecureRequestWarning
    requests.packages.urllib3.disable_warnings(InsecureRequestWarning)  # type: ignore[attr-defined]
except Exception:
    pass


def _blast_radius(method: str, path: str) -> str:
    """Classify an API call for approval gating.

    Per the approved design, Splunk runs without gating: everything is "low" so
    operations auto-approve. The hook stays here for parity with
    ISE/CML/Catalyst Center and to make re-enabling gating a one-function change.
    """
    return "low"


class SplunkClient:
    """Token-or-Basic Splunk REST client shared by the MCP server and the sandbox.

    Reads credentials from the config dict (sourced from sessions.db, same as
    the Settings -> Splunk tab). A persistent requests.Session reuses the
    connection across calls. When a token is present it is used as a Bearer
    credential; otherwise HTTP Basic (username/password) is used.
    """

    def __init__(self, config: Optional[Dict[str, Any]]):
        self._config = config or {}
        self._session: Optional[requests.Session] = None

    @property
    def _host(self) -> str:
        return (self._config.get("host") or "").strip()

    @property
    def _port(self) -> int:
        try:
            return int(self._config.get("port") or 8089)
        except (TypeError, ValueError):
            return 8089

    @property
    def _token(self) -> str:
        return (self._config.get("token") or "").strip()

    @property
    def _verify_ssl(self) -> bool:
        return bool(self._config.get("verify_ssl", False))

    def _base_url(self) -> str:
        return f"https://{self._host}:{self._port}"

    def _has_creds(self) -> bool:
        # Either a token, or a username (Basic auth) is enough to try a call.
        return bool(self._token or (self._config.get("username") or "").strip())

    def _ensure_session(self) -> Optional[requests.Session]:
        if not self._host or not self._has_creds():
            return None
        if self._session is None:
            session = requests.Session()
            # Basic auth fallback when no token is configured.
            if not self._token:
                username = (self._config.get("username") or "").strip()
                password = self._config.get("password") or ""
                session.auth = (username, password)
            if not self._verify_ssl:
                from ccie_sidecar.tls import mount_unverified_tls
                mount_unverified_tls(session)
            self._session = session
        return self._session

    def call(
        self,
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        """Call a Splunk REST API endpoint. Returns a dict the agent json.loads-es.

        Shape: {"status_code", "data", "error", "blast_radius"}.
        """
        method = (method or "GET").upper()
        br = _blast_radius(method, path)
        if not self._host:
            return {"status_code": 0, "data": None,
                    "error": "Splunk is not configured. Set host/credentials in Settings -> Splunk.",
                    "blast_radius": br}

        session = self._ensure_session()
        if session is None:
            return {"status_code": 0, "data": None,
                    "error": "Splunk credentials are incomplete. Set a token or username/password in Settings -> Splunk.",
                    "blast_radius": br}

        url = f"{self._base_url()}{path}"

        # Splunk speaks Atom XML unless output_mode=json is requested. Default it
        # in so callers get JSON without having to remember every time.
        params = dict(query_params or {})
        params.setdefault("output_mode", "json")

        headers = {"Accept": "application/json"}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"

        try:
            resp = session.request(
                method=method,
                url=url,
                headers=headers,
                # Splunk REST expects form-encoded bodies, not JSON.
                data=body if body else None,
                params=params,
                verify=self._verify_ssl,
                timeout=(5, 15),
            )
            try:
                data = resp.json()
            except Exception:
                # /export and a few endpoints stream newline-delimited JSON or
                # plain text; hand back the raw text so the caller can parse it.
                data = resp.text

            # Surface Splunk's own reason (e.g. "Unknown search command 'index'."
            # when SPL isn't prefixed with `search`) instead of a bare "HTTP 400"
            # so the agent can self-correct.
            error = None if resp.status_code < 400 else build_http_error(resp.status_code, data)

            return {
                "status_code": resp.status_code,
                "data": data,
                "error": error,
                "blast_radius": br,
            }
        except requests.exceptions.Timeout:
            return {"status_code": 0, "data": None, "error": "Request timed out", "blast_radius": br}
        except requests.exceptions.SSLError:
            return {"status_code": 0, "data": None,
                    "error": "SSL certificate verification failed (uncheck Verify SSL for self-signed certs)",
                    "blast_radius": br}
        except Exception as e:
            return {"status_code": 0, "data": None, "error": str(e), "blast_radius": br}


def install_splunk(
    globals_dict: Dict[str, Any],
    emit: Optional[Callable[[dict], None]] = None,
) -> SplunkClient:
    """Bind a `splunk_api_call` function into a sandbox globals dict.

    Mirrors install_ise / install_catalyst_center. `emit` is accepted for parity.
    """
    from ccie_sidecar.splunk_config import get_splunk_config

    client = SplunkClient(get_splunk_config())

    def splunk_api_call(
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> str:
        """Call the Cisco Splunk REST API. Returns a JSON string (use json.loads)."""
        return json.dumps(client.call(method, path, body, query_params))

    globals_dict["splunk_api_call"] = splunk_api_call
    globals_dict["splunk"] = client

    mod = types.ModuleType("splunk_api")
    mod.splunk_api_call = splunk_api_call  # type: ignore[attr-defined]
    mod.client = client  # type: ignore[attr-defined]
    sys.modules["splunk_api"] = mod

    return client


def test_connection(config: Dict[str, Any]) -> Dict[str, Any]:
    """Test a Splunk connection without saving. Returns {"ok": bool, "message": str}."""
    host = (config.get("host") or "").strip()
    token = (config.get("token") or "").strip()
    username = (config.get("username") or "").strip()

    if not host:
        return {"ok": False, "message": "Host is required."}
    if not token and not username:
        return {"ok": False, "message": "Provide a token or a username/password."}

    # A cheap read confirms auth + reachability.
    client = SplunkClient(config)
    result = client.call("GET", "/services/server/info")

    status = result.get("status_code") or 0
    if status in (401, 403):
        return {"ok": False, "message": "Authentication failed. Check token or username/password."}
    if status == 0 and result.get("error"):
        return {"ok": False, "message": result["error"]}
    if status >= 400:
        return {"ok": False, "message": f"HTTP {status} from Splunk."}

    # Try to surface the version for a friendlier message.
    version = ""
    data = result.get("data")
    if isinstance(data, dict):
        try:
            version = data["entry"][0]["content"].get("version", "")
        except (KeyError, IndexError, TypeError, AttributeError):
            version = ""

    suffix = f" (version {version})" if version else " (API reachable)"
    return {"ok": True, "message": f"Connected to Splunk at {host}{suffix}."}
