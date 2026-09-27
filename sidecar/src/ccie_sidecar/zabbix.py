"""Zabbix JSON-RPC client used only through the specialist sandbox."""
from __future__ import annotations
import json, sys, types, warnings
from typing import Any, Callable, Optional
import requests
from requests.adapters import HTTPAdapter
from urllib3.exceptions import InsecureRequestWarning
from urllib3.util.retry import Retry
from ccie_sidecar.tls import mount_unverified_tls

_BLOCKED = ("user.", "role.", "token.", "usermedia.", "media.", "script.", "action.", "authentication.")
_WRITES = (".create", ".update", ".delete", ".mass", ".acknowledge")

def _normalise_url(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    return url if url.endswith("/api_jsonrpc.php") else f"{url}/api_jsonrpc.php"

def _verify_ssl(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)

def _risk_for_method(method: str) -> str | None:
    method = (method or "").lower()
    if method.startswith(_BLOCKED): return None
    if method.endswith(".delete") or ".mass" in method: return "high"
    if method.endswith((".create", ".update", ".acknowledge")): return "medium"
    return "low"

def _redact(value: Any, secrets: tuple[str, ...]) -> Any:
    text = str(value)
    for secret in secrets:
        if secret: text = text.replace(secret, "[REDACTED]")
    return text

def redact_params(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: ("[REDACTED]" if any(s in k.lower() for s in ("password", "token", "secret")) else redact_params(v)) for k, v in value.items()}
    if isinstance(value, list): return [redact_params(v) for v in value]
    return value

class ZabbixClient:
    def __init__(self, config: Optional[dict[str, Any]]): self._config, self._session = config or {}, None
    def _ensure_session(self):
        if self._session is None:
            self._session = requests.Session()
            # Retry only failures that occur while establishing the connection.
            # Never replay a POST after it was sent or after a response started.
            retry = Retry(
                total=None,
                connect=1,
                read=0,
                redirect=0,
                status=0,
                allowed_methods=frozenset({"POST"}),
                backoff_factor=0.2,
            )
            self._session.mount("http://", HTTPAdapter(max_retries=retry))
            if not _verify_ssl(self._config.get("verify_ssl", True)):
                mount_unverified_tls(self._session)
            adapter = self._session.get_adapter("https://")
            adapter.max_retries = retry
        return self._session
    def _headers(self):
        h = {"Content-Type": "application/json", "Accept": "application/json"}
        if self._config.get("auth_mode", "token") == "token" and self._config.get("token"):
            h["Authorization"] = f"Bearer {self._config['token']}"
        return h
    def _request(self, method: str, params: dict, auth: Any = None) -> dict:
        body = {"jsonrpc": "2.0", "method": method, "params": params, "id": 1}
        if auth is not None: body["auth"] = auth
        try:
            verify_ssl = _verify_ssl(self._config.get("verify_ssl", True))
            with warnings.catch_warnings():
                if not verify_ssl:
                    warnings.simplefilter("ignore", InsecureRequestWarning)
                response = self._ensure_session().post(_normalise_url(self._config.get("url", "")), headers=self._headers(), json=body, verify=verify_ssl, timeout=(5, 15))
            data = response.json()
            if "error" in data:
                return {"status_code": response.status_code, "data": None, "error": _redact(data["error"].get("data") or data["error"].get("message"), self._secrets())}
            return {"status_code": response.status_code, "data": data.get("result"), "error": None}
        except requests.exceptions.Timeout: return {"status_code": 0, "data": None, "error": "Zabbix request timed out"}
        except requests.exceptions.SSLError: return {"status_code": 0, "data": None, "error": "SSL certificate verification failed"}
        except Exception as e: return {"status_code": 0, "data": None, "error": _redact(e, self._secrets())}
    def _secrets(self): return tuple(str(self._config.get(k, "")) for k in ("token", "password"))
    def _login(self) -> dict:
        return self._request("user.login", {"username": self._config.get("username", ""), "password": self._config.get("password", "")})
    def call(self, method: str, params: Optional[dict] = None) -> dict:
        risk = _risk_for_method(method)
        if not self._config.get("url"): return {"status_code": 0, "data": None, "error": "Zabbix is not configured. Set the URL in Settings → Zabbix.", "blast_radius": risk or "high"}
        if risk is None: return {"status_code": 0, "data": None, "error": "This Zabbix administration API is not permitted.", "blast_radius": "high"}
        if risk != "low": return {"status_code": 0, "data": None, "error": "Zabbix mutations require the zabbix_apply approval tool.", "blast_radius": risk}
        auth = None
        if self._config.get("auth_mode") == "password":
            login = self._login()
            if login["error"]: return {**login, "blast_radius": risk}
            auth = login["data"]
        out = self._request(method, params or {}, auth)
        if auth: self._request("user.logout", {}, auth)
        out["blast_radius"] = risk
        return out

    def apply(self, method: str, params: dict) -> dict:
        """Internal, approval-gated mutation path. Never bind this to Python code."""
        risk = _risk_for_method(method)
        if risk not in ("medium", "high"):
            return {"status_code": 0, "data": None, "error": "zabbix_apply only permits mutations.", "blast_radius": risk or "high"}
        auth = None
        if self._config.get("auth_mode") == "password":
            login = self._login()
            if login["error"]: return {**login, "blast_radius": risk}
            auth = login["data"]
        out = self._request(method, params, auth)
        if auth: self._request("user.logout", {}, auth)
        out["blast_radius"] = risk
        return out

def install_zabbix(globals_dict: dict[str, Any], emit: Optional[Callable[[dict], None]] = None) -> ZabbixClient:
    from ccie_sidecar.zabbix_config import get_zabbix_config
    client = ZabbixClient(get_zabbix_config())
    globals_dict["zabbix"] = client
    globals_dict["zabbix_api_call"] = lambda method, params=None: json.dumps(client.call(method, params))
    module = types.ModuleType("zabbix_api"); module.zabbix_api_call = globals_dict["zabbix_api_call"]; module.client = client; sys.modules["zabbix_api"] = module
    return client

def test_connection(config: dict[str, Any]) -> dict[str, Any]:
    if not config.get("url"): return {"ok": False, "message": "A Zabbix URL is required."}
    client = ZabbixClient(config)
    version = client._request("apiinfo.version", {})
    if version["error"]: return {"ok": False, "message": version["error"]}
    hosts = client.call("host.get", {"output": ["hostid"], "limit": 1})
    return {"ok": not bool(hosts["error"]), "message": "Connected to Zabbix." if not hosts["error"] else hosts["error"]}
