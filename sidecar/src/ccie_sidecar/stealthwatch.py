"""Cisco Stealthwatch Enterprise integration."""

import json
import sys
import types
from typing import Any, Callable, Dict, Optional

import requests



from ccie_sidecar.api_errors import build_http_error
def _blast_radius(method: str, path: str) -> str:
    """Classify an API call for approval gating. Mirrors the MCP server."""
    if method == "GET":
        return "low"
    if method == "DELETE":
        return "destructive"
    if any(cfg in path for cfg in ("/tags", "/custom-security-events", "/policies", "/users")):
        return "high"
    return "medium"


class StealthwatchClient:
    """Session-authenticated Stealthwatch REST client for the code sandbox.

    Reads credentials from the config dict (sourced from sessions.db, same as
    the Settings → Stealthwatch tab). Holds the JSESSIONID + XSRF token across
    calls and re-authenticates once on a 401, matching the MCP server's logic.
    """

    def __init__(self, config: Optional[Dict[str, Any]]):
        self._config = config or {}
        # A persistent session auto-carries the auth cookies Stealthwatch sets
        # on login (XSRF-TOKEN + stealthwatch.jwt). The XSRF token must also be
        # echoed back as the X-XSRF-TOKEN header on mutating requests.
        self._session: Optional[requests.Session] = None
        self._auth_error: Optional[Exception] = None

    @property
    def _host(self) -> str:
        return (self._config.get("host") or "").strip()

    @property
    def _verify_ssl(self) -> bool:
        return bool(self._config.get("verify_ssl", True))

    def _xsrf(self) -> Optional[str]:
        """The current XSRF token, read from the session's XSRF-TOKEN cookie."""
        if self._session is None:
            return None
        return self._session.cookies.get("XSRF-TOKEN")

    def _authenticate(self) -> bool:
        host = self._host
        username = (self._config.get("username") or "").strip()
        password = self._config.get("password") or ""
        if not host or not username or not password:
            return False
        session = requests.Session()
        if not self._verify_ssl:
            from ccie_sidecar.tls import mount_unverified_tls
            mount_unverified_tls(session)
        self._auth_error = None
        try:
            resp = session.post(
                f"https://{host}/token/v2/authenticate",
                data={"username": username, "password": password},
                verify=self._verify_ssl,
                timeout=10,
            )
        except Exception as e:
            self._auth_error = e
            return False
        # Auth succeeds only if the SMC handed back its session cookies. A 200
        # with no XSRF-TOKEN cookie means the login didn't actually establish a
        # session (the failure mode that made every prior API call 400).
        if resp.status_code != 200 or not session.cookies.get("XSRF-TOKEN"):
            return False
        self._session = session
        return True

    def call(
        self,
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        """Call a Stealthwatch API endpoint. Returns a dict the agent json.loads-es.

        Shape: {"status_code", "data", "error", "blast_radius"}.
        """
        method = (method or "GET").upper()
        if not self._host:
            return {
                "status_code": 0,
                "data": None,
                "error": "Stealthwatch is not configured. Set host/credentials in Settings → Stealthwatch.",
                "blast_radius": _blast_radius(method, path),
            }

        if self._session is None:
            if not self._authenticate():
                return {
                    "status_code": 401,
                    "data": None,
                    "error": "Authentication failed. Check credentials in Settings → Stealthwatch.",
                    "blast_radius": _blast_radius(method, path),
                }

        url = f"https://{self._host}{path}"

        def _do() -> requests.Response:
            headers = {"Content-Type": "application/json"}
            # Echo the XSRF token back on every request (required for mutating
            # calls; harmless on GETs).
            xsrf = self._xsrf()
            if xsrf:
                headers["X-XSRF-TOKEN"] = xsrf
            return self._session.request(
                method=method,
                url=url,
                headers=headers,
                json=body,
                params=query_params,
                verify=self._verify_ssl,
                timeout=30,
            )

        try:
            resp = _do()
            if resp.status_code == 401:
                # Stale session — re-auth once and retry.
                self._session = None
                if not self._authenticate():
                    return {
                        "status_code": 401,
                        "data": None,
                        "error": "Re-authentication failed.",
                        "blast_radius": _blast_radius(method, path),
                    }
                resp = _do()

            try:
                data = resp.json()
            except Exception:
                data = resp.text

            return {
                "status_code": resp.status_code,
                "data": data,
                "error": None if resp.status_code < 400 else build_http_error(resp.status_code, data),
                "blast_radius": _blast_radius(method, path),
            }
        except requests.exceptions.Timeout:
            return {"status_code": 0, "data": None, "error": "Request timed out after 30 seconds",
                    "blast_radius": _blast_radius(method, path)}
        except requests.exceptions.SSLError:
            return {"status_code": 0, "data": None, "error": "SSL certificate verification failed",
                    "blast_radius": _blast_radius(method, path)}
        except Exception as e:
            return {"status_code": 0, "data": None, "error": str(e),
                    "blast_radius": _blast_radius(method, path)}


    # ---- High-level convenience helpers ------------------------------------
    # These wrap the multi-step async query→poll→results dance so even a weak
    # LLM (or a one-liner) can pull data without orchestrating it by hand.

    def get_tenant_id(self) -> Optional[Any]:
        """Return the first tenant id, or None on failure."""
        r = self.call("GET", "/sw-reporting/v1/tenants")
        try:
            return r["data"]["data"][0]["id"]
        except Exception:
            return None

    def security_events(
        self,
        hours: float = 3,
        tenant_id: Optional[Any] = None,
        max_polls: int = 20,
        poll_secs: float = 2.0,
    ) -> Dict[str, Any]:
        """Run the full security-events async query for the last `hours`.

        Returns {"ok", "count", "events", "error"}. Handles submit → poll →
        results internally so callers don't reinvent it (and don't flail
        guessing endpoint names).
        """
        import datetime
        import time

        if tenant_id is None:
            tenant_id = self.get_tenant_id()
        if tenant_id is None:
            return {"ok": False, "count": 0, "events": [],
                    "error": "Could not resolve tenant id (is Stealthwatch configured?)."}

        end = datetime.datetime.now(datetime.timezone.utc)
        start = end - datetime.timedelta(hours=hours)
        fmt = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")

        sub = self.call(
            "POST",
            f"/sw-reporting/v1/tenants/{tenant_id}/security-events/queries",
            body={"timeRange": {"from": fmt(start), "to": fmt(end)}},
        )
        if sub.get("error"):
            return {"ok": False, "count": 0, "events": [],
                    "error": f"query submit failed: {sub['error']}"}
        try:
            query_id = sub["data"]["data"]["searchJob"]["id"]
        except Exception:
            return {"ok": False, "count": 0, "events": [],
                    "error": f"unexpected submit response: {str(sub.get('data'))[:200]}"}

        for _ in range(max_polls):
            res = self.call(
                "GET",
                f"/sw-reporting/v1/tenants/{tenant_id}/security-events/results/{query_id}",
            )
            data = res.get("data") or {}
            events = (data.get("data") or {}).get("results") if isinstance(data, dict) else None
            if events:
                return {"ok": True, "count": len(events), "events": events, "error": None}
            time.sleep(poll_secs)

        # Completed with no events (or still empty after polling).
        return {"ok": True, "count": 0, "events": [], "error": None}


def install_stealthwatch(
    globals_dict: dict[str, Any],
    emit: Optional[Callable[[dict], None]] = None,
) -> StealthwatchClient:
    """Bind a `stealthwatch_api_call` function into a sandbox globals dict.

    Registers the helper the agent's system prompt expects so the
    stealthwatch agent can actually reach the API in react / react-code /
    deepagents code-exec. `emit` is accepted for parity with other helpers.
    """
    from ccie_sidecar.stealthwatch_config import get_stealthwatch_config

    client = StealthwatchClient(get_stealthwatch_config())

    def stealthwatch_api_call(
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> str:
        """Call the Stealthwatch REST API. Returns a JSON string (use json.loads)."""
        return json.dumps(client.call(method, path, body, query_params))

    def stealthwatch_security_events(hours: float = 3) -> str:
        """Get security events from the last `hours`. Returns a JSON string of
        {"ok", "count", "events", "error"} — handles the async query/poll/
        results flow internally so you don't have to."""
        return json.dumps(client.security_events(hours=hours))

    globals_dict["stealthwatch_api_call"] = stealthwatch_api_call
    globals_dict["stealthwatch_security_events"] = stealthwatch_security_events

    # Also expose the client object for advanced use.
    globals_dict["stealthwatch"] = client

    # Make `import stealthwatch_api` work too, mirroring install_proxmox.
    mod = types.ModuleType("stealthwatch_api")
    mod.stealthwatch_api_call = stealthwatch_api_call  # type: ignore[attr-defined]
    mod.stealthwatch_security_events = stealthwatch_security_events  # type: ignore[attr-defined]
    mod.client = client  # type: ignore[attr-defined]
    sys.modules["stealthwatch_api"] = mod

    return client


def test_connection(config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Test Stealthwatch connection without saving to database.

    Args:
        config: Dict with keys: host, username, password, verify_ssl

    Returns:
        Dict with keys: ok (bool), message (str)
    """
    host = config.get("host", "").strip()
    username = config.get("username", "").strip()
    password = config.get("password", "")
    verify_ssl = config.get("verify_ssl", True)

    if not host or not username or not password:
        return {
            "ok": False,
            "message": "Host, username, and password are required."
        }

    try:
        client = StealthwatchClient(config)
        if not client._authenticate():
            if client._auth_error is not None:
                raise client._auth_error
            return {
                "ok": False,
                "message": "Authentication failed. Check credentials."
            }

        tenant_id = client.get_tenant_id()
        if tenant_id is None:
            return {
                "ok": False,
                "message": "Connected, but could not resolve tenant ID."
            }

        return {
            "ok": True,
            "message": f"Connected. Tenant ID: {tenant_id}"
        }

    except requests.exceptions.SSLError:
        return {
            "ok": False,
            "message": "SSL certificate verification failed. Try disabling 'Verify SSL' for self-signed certificates."
        }
    except requests.exceptions.ConnectionError as e:
        return {
            "ok": False,
            "message": f"Connection failed: {str(e)}"
        }
    except requests.exceptions.Timeout:
        return {
            "ok": False,
            "message": f"Connection timed out after 10 seconds."
        }
    except Exception as e:
        return {
            "ok": False,
            "message": f"Unexpected error: {str(e)}"
        }
