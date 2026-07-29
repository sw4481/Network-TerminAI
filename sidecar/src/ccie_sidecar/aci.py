"""Cisco ACI (APIC) integration.

The APIC exposes a single REST API rooted at https://<host>; every path already
carries its own prefix (/api/node/class/..., /api/node/mo/...). Auth is a login
cookie: POST /api/aaaLogin.json with the username/password returns an
`APIC-cookie`, which a persistent requests.Session then rides on every call. A
single `aci_api_call(method, path, ...)` helper wraps it. Mirrors the
CML/ISE/Stealthwatch integrations so the MCP server and the in-sandbox helper
share one client and can't drift.

Blast radius: GETs are "low"; writes (POST/DELETE of a managed object) hit the
fabric immediately and classify "medium" so they surface for approval.
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
    """Classify an APIC call for approval gating.

    Reads are low. Object writes (POST creates/modifies a managed object,
    DELETE removes one) take effect on the live fabric immediately, so they
    classify "medium" and surface for approval.
    """
    m = (method or "GET").upper()
    if m in ("GET", "HEAD", "OPTIONS"):
        return "low"
    return "medium"


class AciClient:
    """Cookie-authenticated APIC REST client shared by the MCP server and the sandbox.

    Reads credentials from the config dict (sourced from sessions.db, same as
    the Settings -> ACI tab). Authenticates lazily on first call, caches the
    APIC-cookie on a persistent requests.Session, and transparently
    re-authenticates once on a 401/403 before retrying.
    """

    def __init__(self, config: Optional[Dict[str, Any]]):
        self._config = config or {}
        self._session: Optional[requests.Session] = None
        self._authed = False

    @property
    def _host(self) -> str:
        return (self._config.get("host") or "").strip()

    @property
    def _verify_ssl(self) -> bool:
        return bool(self._config.get("verify_ssl", False))

    def _base_url(self) -> str:
        host = self._host
        # Tolerate a host pasted with scheme; normalise to bare host.
        host = host.replace("https://", "").replace("http://", "").rstrip("/")
        return f"https://{host}"

    def _ensure_session(self) -> Optional[requests.Session]:
        username = (self._config.get("username") or "").strip()
        if not self._host or not username:
            return None
        if self._session is None:
            self._session = requests.Session()
        return self._session

    def _authenticate(self, session: requests.Session) -> bool:
        """POST /api/aaaLogin.json; the APIC-cookie is stored on the session."""
        username = (self._config.get("username") or "").strip()
        password = self._config.get("password") or ""
        body = {"aaaUser": {"attributes": {"name": username, "pwd": password}}}
        try:
            resp = session.request(
                method="POST",
                url=f"{self._base_url()}/api/aaaLogin.json",
                json=body,
                verify=self._verify_ssl,
                timeout=30,
            )
        except Exception:
            self._authed = False
            return False
        # Success only if the APIC handed back the auth cookie.
        if resp.status_code != 200 or not session.cookies.get("APIC-cookie"):
            self._authed = False
            return False
        self._authed = True
        return True

    def call(
        self,
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        """Call an APIC API endpoint. Returns a dict the agent json.loads-es.

        Shape: {"status_code", "data", "error", "blast_radius"}.
        """
        method = (method or "GET").upper()
        br = _blast_radius(method, path)
        if not self._host:
            return {"status_code": 0, "data": None,
                    "error": "ACI is not configured. Set host/credentials in Settings -> ACI.",
                    "blast_radius": br}

        session = self._ensure_session()
        if session is None:
            return {"status_code": 0, "data": None,
                    "error": "ACI credentials are incomplete. Set host/username/password in Settings -> ACI.",
                    "blast_radius": br}

        if not path.startswith("/"):
            path = "/" + path
        url = f"{self._base_url()}{path}"

        def _do_request() -> "requests.Response":
            headers = {"Accept": "application/json"}
            return session.request(
                method=method, url=url, headers=headers,
                json=body, params=query_params,
                verify=self._verify_ssl, timeout=30,
            )

        try:
            if not self._authed and not self._authenticate(session):
                return {"status_code": 401, "data": None,
                        "error": "Authentication failed. Check credentials in Settings -> ACI.",
                        "blast_radius": br}

            resp = _do_request()
            # Cookie expired mid-session: re-auth once and retry.
            if resp.status_code in (401, 403):
                if not self._authenticate(session):
                    return {"status_code": resp.status_code, "data": None,
                            "error": "Authentication failed. Check credentials in Settings -> ACI.",
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


def install_aci(
    globals_dict: Dict[str, Any],
    emit: Optional[Callable[[dict], None]] = None,
) -> AciClient:
    """Bind an `aci_api_call` function into a sandbox globals dict.

    Mirrors install_cml / install_ise. `emit` is accepted for parity.
    """
    from ccie_sidecar.aci_config import get_aci_config

    client = AciClient(get_aci_config())

    def aci_api_call(
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> str:
        """Call the Cisco ACI (APIC) REST API. Returns a JSON string (use json.loads)."""
        return json.dumps(client.call(method, path, body, query_params))

    globals_dict["aci_api_call"] = aci_api_call
    globals_dict["aci"] = client

    mod = types.ModuleType("aci_api")
    mod.aci_api_call = aci_api_call  # type: ignore[attr-defined]
    mod.client = client  # type: ignore[attr-defined]
    sys.modules["aci_api"] = mod

    return client


def test_connection(config: Dict[str, Any]) -> Dict[str, Any]:
    """Test an ACI connection without saving. Returns {"ok": bool, "message": str}."""
    host = (config.get("host") or "").strip()
    username = (config.get("username") or "").strip()
    password = config.get("password") or ""

    if not host or not username or not password:
        return {"ok": False, "message": "Host, username, and password are required."}

    # Authenticate, then a cheap read of the top-level class query confirms it.
    client = AciClient(config)
    result = client.call("GET", "/api/node/class/topSystem.json")

    status = result.get("status_code") or 0
    if status in (401, 403):
        return {"ok": False, "message": "Authentication failed. Check credentials."}
    if status == 0 and result.get("error"):
        return {"ok": False, "message": result["error"]}
    if status >= 400:
        return {"ok": False, "message": f"HTTP {status} from topSystem query."}

    return {"ok": True, "message": f"Connected to APIC at {host} (API reachable)."}
