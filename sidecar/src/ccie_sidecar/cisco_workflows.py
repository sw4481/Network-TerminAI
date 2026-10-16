"""Cisco Workflows API transport with separate read and approval-gated write doors."""
from __future__ import annotations

import json
import re
from typing import Any, Callable
from urllib.parse import unquote, urlsplit

import requests

from ccie_sidecar.api_errors import build_http_error

_ROOT = "https://api.meraki.com/api/automate/organizations/"
_POST_READS = frozenset({
    "/v1.1/workflows", "/v1.2/workflows", "/v1.1/instances", "/v1/workflows/batch_get",
    "/v1/rules/batch_get", "/v1/variable_types/batch_get",
})
_METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE"})


def _risk(method: str, path: str) -> str:
    if method == "GET" or (method == "POST" and isinstance(path, str) and path in _POST_READS):
        return "low"
    return "destructive" if method == "DELETE" else "high"


def _credential_field(key: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]", "", unquote(key).lower())
    return "%" in key or any(term in normalized for term in (
        "auth", "token", "apikey", "secret", "password", "credential", "headers", "host", "baseurl",
        "orgid", "organizationid", "verify", "timeout", "url",
    ))


def _redact(value: Any, key: str) -> Any:
    if isinstance(value, str):
        return value.replace(key, "[REDACTED]") if key else value
    if isinstance(value, list):
        return [_redact(item, key) for item in value]
    if isinstance(value, dict):
        return {_redact(name, key): _redact(item, key) for name, item in value.items()}
    return value


class CiscoWorkflowsClient:
    """Fixed-origin JSON transport. Only the approved StructuredTool may call apply."""

    def __init__(self, config: dict[str, Any] | None):
        self._config = config or {}
        self._session: requests.Session | None = None

    def call(self, method: str, path: str, body: Any = None, query_params: dict | None = None) -> dict:
        """Return an envelope for reads; never send mutations from the sandbox."""
        verb = method.upper() if isinstance(method, str) else ""
        risk = _risk(verb, path)
        if risk != "low":
            return self._result(0, None, "Cisco Workflows mutations require the cisco_workflows_apply approval tool.", risk)
        return self._request(verb, path, body, query_params, risk)

    def apply(self, method: str, path: str, body: Any = None, query_params: dict | None = None) -> dict:
        """Send mutations only; caller must be the approval-gated StructuredTool."""
        verb = method.upper() if isinstance(method, str) else ""
        risk = _risk(verb, path)
        if risk == "low":
            return self._result(0, None, "cisco_workflows_apply only permits mutations.", risk)
        return self._request(verb, path, body, query_params, risk)

    @staticmethod
    def _result(status: int, data: Any, error: str | None, risk: str) -> dict:
        return {"status_code": status, "data": data, "error": error, "blast_radius": risk}

    def _request(self, method: str, path: str, body: Any, query_params: Any, risk: str) -> dict:
        key = self._config.get("api_key")
        org = self._config.get("org_id")
        key = key.strip() if isinstance(key, str) else ""
        org = org.strip() if isinstance(org, str) else ""
        if not key:
            return self._result(0, None, "Cisco Workflows requires an API key in Settings → Meraki.", risk)
        if any(ord(char) < 32 or ord(char) == 127 for char in key):
            return self._result(0, None, "Invalid Meraki API key in Settings → Meraki.", risk)
        if not org:
            return self._result(0, None, "Cisco Workflows requires an organization ID in Settings → Meraki.", risk)
        if not re.fullmatch(r"[A-Za-z0-9_-]+", org):
            return self._result(0, None, "Invalid configured Meraki organization ID.", risk)
        if method not in _METHODS:
            return self._result(0, None, "Unsupported Cisco Workflows HTTP method.", risk)
        if not isinstance(path, str) or not path.startswith("/") or path.startswith("//"):
            return self._result(0, None, "Invalid Cisco Workflows API path.", risk)
        parsed = urlsplit(path)
        if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment or "?" in path or "#" in path:
            return self._result(0, None, "Invalid Cisco Workflows API path.", risk)
        decoded = unquote(path)
        if ("%25" in path.lower() or "%" in decoded or
                decoded.count("/") != path.count("/") or
                any(ord(char) < 32 or ord(char) == 127 for char in decoded) or
                any(char in decoded for char in ("\\", "?", "#")) or
                "//" in decoded or any(part in (".", "..") for part in decoded.split("/")) or
                not re.match(r"^/(?:v[0-9]+(?:\.[0-9]+)?|exchange/v1)/", decoded)):
            return self._result(0, None, "Invalid Cisco Workflows API path.", risk)
        if query_params is not None:
            if not isinstance(query_params, dict) or any(
                not isinstance(name, str) or _credential_field(name) or
                not isinstance(value, (str, int, float, bool, list, tuple, type(None))) or
                isinstance(value, (list, tuple)) and any(not isinstance(item, (str, int, float, bool, type(None))) for item in value)
                for name, value in query_params.items()
            ):
                return self._result(0, None, "Invalid Cisco Workflows query parameters or credential override.", risk)
        try:
            json.dumps(body, allow_nan=False)
        except (TypeError, ValueError, OverflowError):
            return self._result(0, None, "Cisco Workflows body must be valid JSON.", risk)
        try:
            if self._session is None:
                self._session = requests.Session()
            resp = self._session.request(
                method, f"{_ROOT}{org}{path}",
                headers={"Authorization": f"Bearer {key}", "Accept": "application/json", "Content-Type": "application/json"},
                auth=lambda prepared: prepared,  # Explicit auth prevents netrc fallback without disabling proxy/CA settings.
                json=body, params=query_params, verify=True, allow_redirects=False, timeout=(5, 30),
            )
            if resp.status_code == 204:
                return self._result(204, None, None, risk)
            redirect_error = f"HTTP {resp.status_code}: Cisco Workflows redirect not followed."
            try:
                data = _redact(resp.json(), key)
            except ValueError:
                if 300 <= resp.status_code < 400:
                    return self._result(resp.status_code, None, redirect_error, risk)
                if resp.status_code >= 400:
                    error = build_http_error(resp.status_code, _redact(resp.text, key))
                    return self._result(resp.status_code, None, error, risk)
                return self._result(0, None, "Cisco Workflows response was not JSON.", risk)
            if 300 <= resp.status_code < 400:
                return self._result(resp.status_code, data, redirect_error, risk)
            error = build_http_error(resp.status_code, data) if resp.status_code >= 400 else None
            return self._result(resp.status_code, data, error, risk)
        except requests.exceptions.Timeout:
            return self._result(0, None, "Cisco Workflows request timed out.", risk)
        except requests.exceptions.SSLError:
            return self._result(0, None, "SSL certificate verification failed.", risk)
        except Exception as exc:
            return self._result(0, None, _redact(str(exc), key), risk)


def install_cisco_workflows(globals_dict: dict[str, Any], emit: Callable | None = None) -> None:
    """Bind only the read door, loading the saved Meraki credentials at installation."""
    from ccie_sidecar.meraki_config import get_meraki_config

    client = CiscoWorkflowsClient(get_meraki_config())

    def cisco_workflows_api_call(method: str, path: str, body: Any = None, query_params: dict | None = None) -> str:
        return json.dumps(client.call(method, path, body, query_params))

    globals_dict["cisco_workflows_api_call"] = cisco_workflows_api_call
