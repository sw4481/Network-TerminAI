"""Cisco Secure Firewall Management Center (FMC) integration.

FMC's REST API authenticates by POSTing (HTTP Basic) to
/api/fmc_platform/v1/auth/generatetoken; the response carries the access token
in the `X-auth-access-token` header and the default domain UUID in `DOMAIN_UUID`.
Subsequent calls send `X-auth-access-token` and live under
/api/fmc_config/v1/domain/{domainUUID}/...  A single `fmc_api_call(method, path,
...)` helper wraps it, auto-filling the literal "{domainUUID}" in paths so the
agent never has to paste it. Mirrors the CML/ISE/ACI integrations.

Blast radius: GETs are "low"; writes (POST/PUT/DELETE of policy/objects) change
firewall config and classify "medium" so they surface for approval.
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

_TOKEN_PATH = "/api/fmc_platform/v1/auth/generatetoken"


def _blast_radius(method: str, path: str) -> str:
    """Classify an FMC call for approval gating.

    Reads are low. Writes (POST/PUT/DELETE of a policy, rule, or object) change
    firewall configuration, so they classify "medium" and surface for approval.
    """
    m = (method or "GET").upper()
    if m in ("GET", "HEAD", "OPTIONS"):
        return "low"
    return "medium"


class FmcClient:
    """Token-authenticated FMC REST client shared by the MCP server and the sandbox.

    Reads credentials from the config dict (sourced from sessions.db, same as
    the Settings -> FMC tab). Authenticates lazily on first call, caches the
    access token + default domain UUID, and transparently re-authenticates once
    on a 401 before retrying.
    """

    def __init__(self, config: Optional[Dict[str, Any]]):
        self._config = config or {}
        self._session: Optional[requests.Session] = None
        self._token: Optional[str] = None
        self._domain_uuid: Optional[str] = None

    @property
    def _host(self) -> str:
        host = (self._config.get("host") or "").strip()
        return host.replace("https://", "").replace("http://", "").rstrip("/")

    @property
    def _verify_ssl(self) -> bool:
        return bool(self._config.get("verify_ssl", False))

    def _base_url(self) -> str:
        return f"https://{self._host}"

    def _ensure_session(self) -> Optional[requests.Session]:
        username = (self._config.get("username") or "").strip()
        if not self._host or not username:
            return None
        if self._session is None:
            self._session = requests.Session()
        return self._session

    def _authenticate(self, session: requests.Session) -> bool:
        """POST generatetoken with Basic auth; cache the token + domain UUID."""
        username = (self._config.get("username") or "").strip()
        password = self._config.get("password") or ""
        try:
            resp = session.request(
                method="POST",
                url=f"{self._base_url()}{_TOKEN_PATH}",
                auth=(username, password),
                verify=self._verify_ssl,
                timeout=30,
            )
        except Exception:
            self._token = None
            return False
        token = resp.headers.get("X-auth-access-token")
        if resp.status_code in (200, 204) and token:
            self._token = token
            # Prefer the per-config domain override, else the FMC default.
            self._domain_uuid = (
                (self._config.get("domain_uuid") or "").strip()
                or resp.headers.get("DOMAIN_UUID")
                or self._domain_uuid
            )
            return True
        self._token = None
        return False

    def call(
        self,
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        """Call an FMC API endpoint. Returns a dict the agent json.loads-es.

        Shape: {"status_code", "data", "error", "blast_radius"}. The literal
        "{domainUUID}" in `path` is replaced with the default domain UUID.
        """
        method = (method or "GET").upper()
        br = _blast_radius(method, path)
        if not self._host:
            return {"status_code": 0, "data": None,
                    "error": "FMC is not configured. Set host/credentials in Settings -> FMC.",
                    "blast_radius": br}

        session = self._ensure_session()
        if session is None:
            return {"status_code": 0, "data": None,
                    "error": "FMC credentials are incomplete. Set host/username/password in Settings -> FMC.",
                    "blast_radius": br}

        if not self._token and not self._authenticate(session):
            return {"status_code": 401, "data": None,
                    "error": "Authentication failed. Check credentials in Settings -> FMC.",
                    "blast_radius": br}

        if not path.startswith("/"):
            path = "/" + path
        # Auto-fill the default domain UUID so the agent need not paste it.
        if "{domainUUID}" in path and self._domain_uuid:
            path = path.replace("{domainUUID}", self._domain_uuid)
        url = f"{self._base_url()}{path}"

        def _do_request() -> "requests.Response":
            headers = {"Accept": "application/json", "Content-Type": "application/json"}
            if self._token:
                headers["X-auth-access-token"] = self._token
            return session.request(
                method=method, url=url, headers=headers,
                json=body, params=query_params,
                verify=self._verify_ssl, timeout=30,
            )

        try:
            resp = _do_request()
            # Token expired mid-session: re-auth once and retry.
            if resp.status_code == 401:
                if not self._authenticate(session):
                    return {"status_code": 401, "data": None,
                            "error": "Authentication failed. Check credentials in Settings -> FMC.",
                            "blast_radius": br}
                # Re-fill domain UUID if it only became known after re-auth.
                if "{domainUUID}" in path and self._domain_uuid:
                    path = path.replace("{domainUUID}", self._domain_uuid)
                    url = f"{self._base_url()}{path}"
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


def install_fmc(
    globals_dict: Dict[str, Any],
    emit: Optional[Callable[[dict], None]] = None,
) -> FmcClient:
    """Bind an `fmc_api_call` function into a sandbox globals dict.

    Mirrors install_cml / install_aci. `emit` is accepted for parity.
    """
    from ccie_sidecar.fmc_config import get_fmc_config

    client = FmcClient(get_fmc_config())

    def fmc_api_call(
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> str:
        """Call the Cisco FMC REST API. Returns a JSON string (use json.loads)."""
        return json.dumps(client.call(method, path, body, query_params))

    globals_dict["fmc_api_call"] = fmc_api_call
    globals_dict["fmc"] = client

    mod = types.ModuleType("fmc_api")
    mod.fmc_api_call = fmc_api_call  # type: ignore[attr-defined]
    mod.client = client  # type: ignore[attr-defined]
    sys.modules["fmc_api"] = mod

    return client


def test_connection(config: Dict[str, Any]) -> Dict[str, Any]:
    """Test an FMC connection without saving. Returns {"ok": bool, "message": str}."""
    host = (config.get("host") or "").strip()
    username = (config.get("username") or "").strip()
    password = config.get("password") or ""

    if not host or not username or not password:
        return {"ok": False, "message": "Host, username, and password are required."}

    # Authenticate, then a cheap read of the domain's device records confirms it.
    client = FmcClient(config)
    result = client.call("GET", "/api/fmc_config/v1/domain/{domainUUID}/devices/devicerecords",
                         query_params={"limit": 1})

    status = result.get("status_code") or 0
    if status == 401:
        return {"ok": False, "message": "Authentication failed. Check credentials."}
    if status == 0 and result.get("error"):
        return {"ok": False, "message": result["error"]}
    if status >= 400:
        return {"ok": False, "message": f"HTTP {status} from FMC."}

    return {"ok": True, "message": f"Connected to FMC at {host} (API reachable)."}
