"""Grafana observability integration.

Grafana's HTTP API authenticates with a service-account / API token sent as
`Authorization: Bearer <token>` against the instance base URL. A single
`grafana_api_call(method, path, ...)` helper dispatches any endpoint; small
convenience wrappers (`grafana.search_dashboards`, `grafana.query`) cover the
common reads so a weak LLM doesn't flail. Mirrors the ISE/ThousandEyes shape so
the MCP server and the in-sandbox helper share one client and can't drift.

This integration is read-only in practice: GET=low, everything else medium.
"""

import json
import sys
import types
from typing import Any, Callable, Dict, Optional

import requests



from ccie_sidecar.api_errors import build_http_error
def _blast_radius(method: str, path: str) -> str:
    """Classify a Grafana API call for approval gating.

    GETs are low. Some POSTs are actually reads (the datasource query proxy),
    so they stay low. Mutating writes (creating/updating dashboards, folders,
    alerts, datasources) are medium; deletes are high.
    """
    method = (method or "GET").upper()
    if method == "GET":
        return "low"
    # POST endpoints that read rather than mutate.
    if method == "POST" and (path.startswith("/api/ds/query")
                             or path.startswith("/api/tsdb/query")):
        return "low"
    if method == "DELETE":
        return "high"
    return "medium"


class GrafanaClient:
    """Bearer-token Grafana HTTP API client shared by the MCP server and sandbox.

    Reads {url, token, verify_ssl} from the config dict (sourced from
    sessions.db, same as the Settings → Grafana tab). A persistent
    requests.Session reuses the connection across calls.
    """

    def __init__(self, config: Optional[Dict[str, Any]]):
        self._config = config or {}
        self._session: Optional[requests.Session] = None

    @property
    def _base(self) -> str:
        return (self._config.get("url") or "").strip().rstrip("/")

    @property
    def _token(self) -> str:
        return (self._config.get("token") or "").strip()

    @property
    def _verify_ssl(self) -> bool:
        return bool(self._config.get("verify_ssl", True))

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
        """Call a Grafana API endpoint. Returns a dict the agent json.loads-es.

        Shape: {"status_code", "data", "error", "blast_radius"}.
        """
        method = (method or "GET").upper()
        br = _blast_radius(method, path)
        if not self._base:
            return {"status_code": 0, "data": None,
                    "error": "Grafana is not configured. Set the URL/token in Settings → Grafana.",
                    "blast_radius": br}

        session = self._ensure_session()
        if not path.startswith("/"):
            path = "/" + path
        url = f"{self._base}{path}"

        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"

        try:
            resp = session.request(
                method=method, url=url, headers=headers,
                json=body, params=query_params,
                verify=self._verify_ssl, timeout=30,
            )
            try:
                data = resp.json()
            except Exception:
                data = resp.text

            error = None
            if resp.status_code == 401:
                error = "Authentication failed. Check the API token in Settings → Grafana."
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

    def search_dashboards(self, query: str = "", tag: Optional[str] = None) -> Dict[str, Any]:
        """Search dashboards by title/tag. GET /api/search."""
        params: Dict[str, Any] = {"type": "dash-db"}
        if query:
            params["query"] = query
        if tag:
            params["tag"] = tag
        return self.call("GET", "/api/search", query_params=params)

    def list_datasources(self) -> Dict[str, Any]:
        """List configured data sources. GET /api/datasources."""
        return self.call("GET", "/api/datasources")

    def query(self, promql: str, ds_uid: str) -> Dict[str, Any]:
        """Run an instant PromQL query through Grafana's /api/ds/query proxy.

        `ds_uid` is a Prometheus datasource UID (from list_datasources()).
        """
        body = {
            "queries": [
                {"refId": "A", "expr": promql, "datasource": {"uid": ds_uid},
                 "instant": True}
            ]
        }
        return self.call("POST", "/api/ds/query", body=body)

    def health(self) -> Dict[str, Any]:
        """Instance health. GET /api/health (no auth needed)."""
        return self.call("GET", "/api/health")

    # ---- Write helpers (blast_radius medium/high — prompt for approval) -----

    def create_dashboard(
        self,
        dashboard: Dict[str, Any],
        folder_uid: Optional[str] = None,
        message: str = "",
        overwrite: bool = False,
    ) -> Dict[str, Any]:
        """Create or update a dashboard. POST /api/dashboards/db (medium).

        `dashboard` is the Grafana dashboard model (a dict with panels, etc.).
        Omit its "id"/"uid" to create new; include an existing "uid" + set
        overwrite=True to update in place. Grafana assigns the uid on create.
        """
        panel = dict(dashboard)
        # Grafana requires id=None on create so it mints a fresh one.
        panel.setdefault("id", None)
        body: Dict[str, Any] = {"dashboard": panel, "overwrite": overwrite}
        if folder_uid:
            body["folderUid"] = folder_uid
        if message:
            body["message"] = message
        return self.call("POST", "/api/dashboards/db", body=body)

    def create_folder(self, title: str, uid: Optional[str] = None) -> Dict[str, Any]:
        """Create a dashboard folder. POST /api/folders (medium)."""
        body: Dict[str, Any] = {"title": title}
        if uid:
            body["uid"] = uid
        return self.call("POST", "/api/folders", body=body)

    def delete_dashboard(self, uid: str) -> Dict[str, Any]:
        """Delete a dashboard by uid. DELETE /api/dashboards/uid/{uid} (high)."""
        return self.call("DELETE", f"/api/dashboards/uid/{uid}")


def install_grafana(
    globals_dict: dict[str, Any],
    emit: Optional[Callable[[dict], None]] = None,
) -> GrafanaClient:
    """Bind a `grafana_api_call` function + `grafana` client into a sandbox."""
    from ccie_sidecar.grafana_config import get_grafana_config

    client = GrafanaClient(get_grafana_config())

    def grafana_api_call(
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> str:
        """Call the Grafana HTTP API. Returns a JSON string (use json.loads)."""
        return json.dumps(client.call(method, path, body, query_params))

    globals_dict["grafana_api_call"] = grafana_api_call
    globals_dict["grafana"] = client

    mod = types.ModuleType("grafana_api")
    mod.grafana_api_call = grafana_api_call  # type: ignore[attr-defined]
    mod.client = client  # type: ignore[attr-defined]
    sys.modules["grafana_api"] = mod

    return client


def test_connection(config: Dict[str, Any]) -> Dict[str, Any]:
    """Test a Grafana connection without saving. Returns {"ok": bool, "message": str}."""
    url = (config.get("url") or "").strip()
    if not url:
        return {"ok": False, "message": "A Grafana URL is required."}

    client = GrafanaClient(config)
    # /api/health needs no auth and confirms the URL; then a cheap authed read.
    health = client.call("GET", "/api/health")
    status = health.get("status_code") or 0
    if status == 0 and health.get("error"):
        return {"ok": False, "message": health["error"]}

    if config.get("token"):
        who = client.call("GET", "/api/user")
        wstatus = who.get("status_code") or 0
        if wstatus == 401:
            return {"ok": False, "message": "Authentication failed. Check the API token."}
        if wstatus >= 400:
            return {"ok": False, "message": f"HTTP {wstatus} from Grafana (token may lack scope)."}

    return {"ok": True, "message": f"Connected to Grafana at {url}."}
