"""Cisco Modeling Labs (CML) integration.

CML exposes a single REST API base (https://<host>/api/v0) secured with a
Bearer JWT: POST /authenticate {username, password} returns a bare JWT string,
which is then sent as `Authorization: Bearer <jwt>` on every call. A single
`cml_api_call(method, path, ...)` helper wraps it. Mirrors the ISE/Stealthwatch
integrations so the MCP server and the in-sandbox helper share one client and
can't drift.

Per design, CML runs with NO approval gating: every call classifies as "low"
blast radius so lab mutations (start/stop/wipe/delete) auto-approve.
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

_API_BASE = "/api/v0"


def _blast_radius(method: str, path: str) -> str:
    """Classify an API call for approval gating.

    Per the approved design, CML runs without gating: everything is "low" so
    mutations auto-approve. The hook stays here for parity with ISE/Stealthwatch
    and to make re-enabling gating a one-function change.
    """
    return "low"


class CmlClient:
    """Bearer-JWT CML REST client shared by the MCP server and the sandbox.

    Reads credentials from the config dict (sourced from sessions.db, same as
    the Settings -> CML tab). Authenticates lazily on first call, caches the JWT
    on a persistent requests.Session, and transparently re-authenticates once on
    a 401 before retrying.
    """

    def __init__(self, config: Optional[Dict[str, Any]]):
        self._config = config or {}
        self._session: Optional[requests.Session] = None
        self._token: Optional[str] = None

    @property
    def _host(self) -> str:
        return (self._config.get("host") or "").strip()

    @property
    def _verify_ssl(self) -> bool:
        return bool(self._config.get("verify_ssl", False))

    def _base_url(self) -> str:
        return f"https://{self._host}{_API_BASE}"

    def _ensure_session(self) -> Optional[requests.Session]:
        username = (self._config.get("username") or "").strip()
        if not self._host or not username:
            return None
        if self._session is None:
            self._session = requests.Session()
        return self._session

    def _authenticate(self, session: requests.Session) -> Optional[str]:
        """POST /authenticate and cache the returned JWT. Returns the token or None."""
        username = (self._config.get("username") or "").strip()
        password = self._config.get("password") or ""
        resp = session.request(
            method="POST",
            url=f"{self._base_url()}/authenticate",
            json={"username": username, "password": password},
            verify=self._verify_ssl,
            timeout=30,
        )
        if resp.status_code >= 400:
            self._token = None
            return None
        try:
            token = resp.json()
        except Exception:
            token = resp.text.strip().strip('"')
        if isinstance(token, str) and token:
            self._token = token
            return token
        self._token = None
        return None

    def call(
        self,
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        """Call a CML API endpoint. Returns a dict the agent json.loads-es.

        Shape: {"status_code", "data", "error", "blast_radius"}.
        """
        method = (method or "GET").upper()
        br = _blast_radius(method, path)
        if not self._host:
            return {"status_code": 0, "data": None,
                    "error": "CML is not configured. Set host/credentials in Settings -> CML.",
                    "blast_radius": br}

        session = self._ensure_session()
        if session is None:
            return {"status_code": 0, "data": None,
                    "error": "CML credentials are incomplete. Set host/username/password in Settings -> CML.",
                    "blast_radius": br}

        url = f"{self._base_url()}{path}"

        def _do_request() -> "requests.Response":
            headers = {"Accept": "application/json", "Content-Type": "application/json"}
            if self._token:
                headers["Authorization"] = f"Bearer {self._token}"
            return session.request(
                method=method, url=url, headers=headers,
                json=body, params=query_params,
                verify=self._verify_ssl, timeout=30,
            )

        try:
            if self._token is None and self._authenticate(session) is None:
                return {"status_code": 401, "data": None,
                        "error": "Authentication failed. Check credentials in Settings -> CML.",
                        "blast_radius": br}

            resp = _do_request()
            # Token expired mid-session: re-auth once and retry.
            if resp.status_code == 401:
                if self._authenticate(session) is None:
                    return {"status_code": 401, "data": None,
                            "error": "Authentication failed. Check credentials in Settings -> CML.",
                            "blast_radius": br}
                resp = _do_request()

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
        except requests.exceptions.SSLError:
            return {"status_code": 0, "data": None,
                    "error": "SSL certificate verification failed (uncheck Verify SSL for self-signed certs)",
                    "blast_radius": br}
        except Exception as e:
            return {"status_code": 0, "data": None, "error": str(e), "blast_radius": br}


def install_cml(
    globals_dict: Dict[str, Any],
    emit: Optional[Callable[[dict], None]] = None,
) -> CmlClient:
    """Bind a `cml_api_call` function into a sandbox globals dict.

    Mirrors install_ise / install_stealthwatch. `emit` is accepted for parity.
    """
    from ccie_sidecar.cml_config import get_cml_config

    client = CmlClient(get_cml_config())

    def cml_api_call(
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> str:
        """Call the Cisco Modeling Labs REST API. Returns a JSON string (use json.loads)."""
        return json.dumps(client.call(method, path, body, query_params))

    globals_dict["cml_api_call"] = cml_api_call
    globals_dict["cml"] = client

    mod = types.ModuleType("cml_api")
    mod.cml_api_call = cml_api_call  # type: ignore[attr-defined]
    mod.client = client  # type: ignore[attr-defined]
    sys.modules["cml_api"] = mod

    return client


def test_connection(config: Dict[str, Any]) -> Dict[str, Any]:
    """Test a CML connection without saving. Returns {"ok": bool, "message": str}."""
    host = (config.get("host") or "").strip()
    username = (config.get("username") or "").strip()
    password = config.get("password") or ""

    if not host or not username or not password:
        return {"ok": False, "message": "Host, username, and password are required."}

    # Authenticate, then a cheap read of /labs confirms the token works.
    client = CmlClient(config)
    result = client.call("GET", "/labs")

    status = result.get("status_code") or 0
    if status == 401:
        return {"ok": False, "message": "Authentication failed. Check credentials."}
    if status == 0 and result.get("error"):
        return {"ok": False, "message": result["error"]}
    if status >= 400:
        return {"ok": False, "message": f"HTTP {status} from /labs."}

    return {"ok": True, "message": f"Connected to CML at {host} (API reachable)."}
