"""Prometheus metrics integration.

Direct PromQL against the Prometheus HTTP API (/api/v1/...). Supports optional
basic auth, a bearer token (Grafana Cloud / Thanos / Cortex), and a multi-tenant
org id (X-Scope-OrgID). A single `prometheus_api_call(method, path, ...)` helper
dispatches any endpoint; convenience wrappers (`prometheus.query`,
`prometheus.query_range`, `prometheus.targets`, `prometheus.metrics`) cover the
common reads. Read-only: everything is low blast radius.
"""

import json
import sys
import types
from typing import Any, Callable, Dict, Optional

import requests



from ccie_sidecar.api_errors import build_http_error
def _blast_radius(method: str, path: str) -> str:
    """Prometheus is queried read-only here; everything is low."""
    return "low"


class PrometheusClient:
    """Prometheus HTTP API client shared by the MCP server and sandbox.

    Reads {url, username, password, token, org_id, verify_ssl} from the config
    dict (sourced from sessions.db, same as the Settings → Prometheus tab).
    """

    def __init__(self, config: Optional[Dict[str, Any]]):
        self._config = config or {}
        self._session: Optional[requests.Session] = None

    @property
    def _base(self) -> str:
        return (self._config.get("url") or "").strip().rstrip("/")

    @property
    def _verify_ssl(self) -> bool:
        return bool(self._config.get("verify_ssl", True))

    def _ensure_session(self) -> requests.Session:
        if self._session is None:
            session = requests.Session()
            username = (self._config.get("username") or "").strip()
            password = self._config.get("password") or ""
            if username:
                session.auth = (username, password)
            self._session = session
        return self._session

    def _headers(self) -> Dict[str, str]:
        headers = {"Accept": "application/json"}
        token = (self._config.get("token") or "").strip()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        org_id = (self._config.get("org_id") or "").strip()
        if org_id:
            headers["X-Scope-OrgID"] = org_id
        return headers

    def call(
        self,
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        """Call a Prometheus API endpoint. Returns a dict the agent json.loads-es.

        Shape: {"status_code", "data", "error", "blast_radius"}.
        """
        method = (method or "GET").upper()
        br = _blast_radius(method, path)
        if not self._base:
            return {"status_code": 0, "data": None,
                    "error": "Prometheus is not configured. Set the URL in Settings → Prometheus.",
                    "blast_radius": br}

        session = self._ensure_session()
        if not path.startswith("/"):
            path = "/" + path
        url = f"{self._base}{path}"

        try:
            resp = session.request(
                method=method, url=url, headers=self._headers(),
                data=body if method != "GET" else None,
                params=query_params,
                verify=self._verify_ssl, timeout=30,
            )
            try:
                data = resp.json()
            except Exception:
                data = resp.text

            error = None
            if resp.status_code == 401:
                error = "Authentication failed. Check credentials in Settings → Prometheus."
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

    def query(self, promql: str, time: Optional[str] = None) -> Dict[str, Any]:
        """Instant PromQL query. GET /api/v1/query?query=<promql>."""
        params: Dict[str, Any] = {"query": promql}
        if time:
            params["time"] = time
        return self.call("GET", "/api/v1/query", query_params=params)

    def query_range(self, promql: str, start: str, end: str, step: str = "60s") -> Dict[str, Any]:
        """Range PromQL query. GET /api/v1/query_range."""
        return self.call("GET", "/api/v1/query_range",
                         query_params={"query": promql, "start": start, "end": end, "step": step})

    def metrics(self) -> Dict[str, Any]:
        """List all metric names. GET /api/v1/label/__name__/values."""
        return self.call("GET", "/api/v1/label/__name__/values")

    def targets(self) -> Dict[str, Any]:
        """Scrape-target health. GET /api/v1/targets."""
        return self.call("GET", "/api/v1/targets")

    def metadata(self, metric: Optional[str] = None) -> Dict[str, Any]:
        """Metric metadata (type/help). GET /api/v1/metadata."""
        params = {"metric": metric} if metric else None
        return self.call("GET", "/api/v1/metadata", query_params=params)


def install_prometheus(
    globals_dict: dict[str, Any],
    emit: Optional[Callable[[dict], None]] = None,
) -> PrometheusClient:
    """Bind a `prometheus_api_call` function + `prometheus` client into a sandbox."""
    from ccie_sidecar.prometheus_config import get_prometheus_config

    client = PrometheusClient(get_prometheus_config())

    def prometheus_api_call(
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> str:
        """Call the Prometheus HTTP API. Returns a JSON string (use json.loads)."""
        return json.dumps(client.call(method, path, body, query_params))

    globals_dict["prometheus_api_call"] = prometheus_api_call
    globals_dict["prometheus"] = client

    mod = types.ModuleType("prometheus_api")
    mod.prometheus_api_call = prometheus_api_call  # type: ignore[attr-defined]
    mod.client = client  # type: ignore[attr-defined]
    sys.modules["prometheus_api"] = mod

    return client


def test_connection(config: Dict[str, Any]) -> Dict[str, Any]:
    """Test a Prometheus connection without saving. Returns {"ok": bool, "message": str}."""
    url = (config.get("url") or "").strip()
    if not url:
        return {"ok": False, "message": "A Prometheus URL is required."}

    client = PrometheusClient(config)
    # A trivial instant query confirms URL + auth reach a live Prometheus.
    result = client.query("up")
    status = result.get("status_code") or 0
    if status == 401:
        return {"ok": False, "message": "Authentication failed. Check credentials."}
    if status == 0 and result.get("error"):
        return {"ok": False, "message": result["error"]}
    if status >= 400:
        return {"ok": False, "message": f"HTTP {status} from Prometheus."}

    return {"ok": True, "message": f"Connected to Prometheus at {url}."}
