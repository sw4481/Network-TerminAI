"""Cisco ThousandEyes integration.

ThousandEyes' API v7 authenticates with a single OAuth Bearer token (no
login round-trip): every call sends `Authorization: Bearer <token>` to
https://api.thousandeyes.com. A single `thousandeyes_api_call(method, path, ...)`
helper wraps it. Unlike the other integrations the config is token-only (plus an
optional account group id), so there is no host/username/password.

This integration is read-only: every call classifies "low" blast radius.
"""

import json
import sys
import types
from typing import Any, Callable, Dict, Optional

import requests


from ccie_sidecar.api_errors import build_http_error
_API_BASE = "https://api.thousandeyes.com"


def _blast_radius(method: str, path: str) -> str:
    """ThousandEyes is used read-only here; everything is low."""
    return "low"


class ThousandEyesClient:
    """Bearer-token ThousandEyes API v7 client shared by the MCP server and sandbox.

    Reads the token (and optional account group id) from the config dict
    (sourced from sessions.db, same as the Settings -> ThousandEyes tab). No
    login step — the token is sent directly on every call.
    """

    def __init__(self, config: Optional[Dict[str, Any]]):
        self._config = config or {}
        self._session: Optional[requests.Session] = None

    @property
    def _token(self) -> str:
        return (self._config.get("token") or "").strip()

    @property
    def _account_group_id(self) -> str:
        return (self._config.get("account_group_id") or "").strip()

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
        """Call a ThousandEyes API endpoint. Returns a dict the agent json.loads-es.

        Shape: {"status_code", "data", "error", "blast_radius"}.
        """
        method = (method or "GET").upper()
        br = _blast_radius(method, path)
        if not self._token:
            return {"status_code": 0, "data": None,
                    "error": "ThousandEyes is not configured. Set the API token in Settings -> ThousandEyes.",
                    "blast_radius": br}

        session = self._ensure_session()
        if not path.startswith("/"):
            path = "/" + path
        url = f"{_API_BASE}{path}"

        # Default the account group filter if configured and not already set.
        params = dict(query_params or {})
        if self._account_group_id and "aid" not in params:
            params["aid"] = self._account_group_id

        try:
            resp = session.request(
                method=method, url=url,
                headers={
                    "Authorization": f"Bearer {self._token}",
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                },
                json=body, params=params or None,
                timeout=30,
            )
            try:
                data = resp.json()
            except Exception:
                data = resp.text

            error = None
            if resp.status_code == 401:
                error = "Authentication failed. Check the API token in Settings -> ThousandEyes."
            elif resp.status_code >= 400:
                error = build_http_error(resp.status_code, data)

            return {
                "status_code": resp.status_code,
                "data": data,
                "error": error,
                "blast_radius": br,
            }
        except requests.exceptions.Timeout:
            return {"status_code": 0, "data": None, "error": "Request timed out after 30 seconds", "blast_radius": br}
        except Exception as e:
            return {"status_code": 0, "data": None, "error": str(e), "blast_radius": br}


def install_thousandeyes(
    globals_dict: Dict[str, Any],
    emit: Optional[Callable[[dict], None]] = None,
) -> ThousandEyesClient:
    """Bind a `thousandeyes_api_call` function into a sandbox globals dict.

    Mirrors install_cml / install_aci. `emit` is accepted for parity.
    """
    from ccie_sidecar.thousandeyes_config import get_thousandeyes_config

    client = ThousandEyesClient(get_thousandeyes_config())

    def thousandeyes_api_call(
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> str:
        """Call the Cisco ThousandEyes API v7. Returns a JSON string (use json.loads)."""
        return json.dumps(client.call(method, path, body, query_params))

    globals_dict["thousandeyes_api_call"] = thousandeyes_api_call
    globals_dict["thousandeyes"] = client

    mod = types.ModuleType("thousandeyes_api")
    mod.thousandeyes_api_call = thousandeyes_api_call  # type: ignore[attr-defined]
    mod.client = client  # type: ignore[attr-defined]
    sys.modules["thousandeyes_api"] = mod

    return client


def test_connection(config: Dict[str, Any]) -> Dict[str, Any]:
    """Test a ThousandEyes connection without saving. Returns {"ok": bool, "message": str}."""
    token = (config.get("token") or "").strip()
    if not token:
        return {"ok": False, "message": "An API token is required."}

    # A cheap read of /v7/account-groups confirms the token works.
    client = ThousandEyesClient(config)
    result = client.call("GET", "/v7/account-groups")

    status = result.get("status_code") or 0
    if status == 401:
        return {"ok": False, "message": "Authentication failed. Check the API token."}
    if status == 0 and result.get("error"):
        return {"ok": False, "message": result["error"]}
    if status >= 400:
        return {"ok": False, "message": f"HTTP {status} from ThousandEyes."}

    return {"ok": True, "message": "Connected to ThousandEyes (API token valid)."}
