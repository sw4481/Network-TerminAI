"""Juniper Mist integration.

Mist is a cloud-managed platform (Wireless / Wired / WAN Assurance, Marvis).
Its REST API lives on ONE regional host per organization's cloud — selected by
the user in Settings — and every resource is under the `/api/v1` prefix. Auth is
a STATIC API token sent as `Authorization: Token <api_token>` (no login
exchange, no refresh, no re-auth-on-401) — the simplest of our vendor patterns.

A single `mist_api_call(method, path, ...)` helper drives the whole surface. The
region -> host map + the token header live in the shared MistClient so the MCP
server and the in-sandbox helper share one client and can't drift. Mirrors the
Cisco XDR / Secure Endpoint integrations.
"""
from __future__ import annotations

import json
import sys
import types
from typing import Any, Callable, Dict, Optional

import requests


from ccie_sidecar.api_errors import build_http_error
# region -> API host. One host per Mist cloud/global-region; the user picks
# theirs in Settings. GLOBAL 01 (api.mist.com) is the default for unknown/empty.
_HOSTS = {
    "global01": "api.mist.com",
    "global02": "api.gc1.mist.com",
    "global03": "api.ac2.mist.com",
    "emea01": "api.eu.mist.com",
    "emea02": "api.gc3.mist.com",
    "apac01": "api.ac5.mist.com",
}


# ---------------------------------------------------------------------------
# Single source of truth for the Mist API surface. Consumed by BOTH the MCP
# tool description (mist_mcp.get_tool_description) and the in-sandbox
# client-section (react_code._build_client_section) so they can never drift.
# ---------------------------------------------------------------------------
MIST_CAPABILITIES_DOC = """Juniper Mist is a CLOUD-MANAGED network platform (Wireless / Wired / WAN
Assurance + Marvis). Everything is scoped under an ORG (organization) and its
SITES. All endpoints share ONE regional host and the `/api/v1` prefix (omit the
host; pass paths starting at `/api/v1`).

URL SHAPE: /api/v1/<scope>/<scope_id>/<object>[/<object_id>]
  <scope> ∈ self | orgs | sites | msp | const  (self = the calling token's identity)

START HERE (always resolve real ids first — never guess org_id/site_id):
  GET  /api/v1/self                         Who am I: privileges + the org_ids this token can see
  GET  /api/v1/orgs/{org_id}                Org detail
  GET  /api/v1/orgs/{org_id}/sites          List sites in an org  (site_id lives here)
  GET  /api/v1/sites/{site_id}              Site detail

INVENTORY & DEVICES (device TYPE enum is EXACTLY ap|gateway|switch — there is
NO "all" value; OMIT type to get every type):
  GET  /api/v1/orgs/{org_id}/inventory      Org device inventory (claimed serials + MACs).
       *** To see switches you MUST pass query_params {"type":"switch"} (or omit
       "type" entirely to get ALL types). type accepts comma-separated values,
       e.g. {"type":"switch,gateway"}. Do NOT pass "all" — it is not a valid enum. ***
       Inventory lists CLAIMED/assigned devices REGARDLESS of connection state —
       a DISCONNECTED switch STILL appears here. To filter by up/down use the
       search/count variants below (status=connected|disconnected).
  GET  /api/v1/orgs/{org_id}/inventory/search  query_params {"type":"switch","status":"disconnected"}
       status enum connected|disconnected (comma-sep OK) — the way to answer
       "which switches are down".
  GET  /api/v1/orgs/{org_id}/inventory/count   query_params {"distinct":"status"} for a rollup.
  GET  /api/v1/sites/{site_id}/devices      Config of devices assigned to a site
       (type-filterable: {"type":"switch"}; NO "all").
  GET  /api/v1/sites/{site_id}/stats/devices   LIVE device status/uptime/version.
       *** This endpoint DEFAULTS to type=ap. For switches pass {"type":"switch"}. ***
       status enum here is all|connected|disconnected (default all). Each row's
       "status" / "uptime" / "last_seen" fields give live up/down. Per device:
       GET /api/v1/sites/{site_id}/stats/devices/{device_id}
  GET  /api/v1/sites/{site_id}/stats/devices            Live device stats for a site
  GET  /api/v1/sites/{site_id}/stats/devices/{device_id} One device's live stats

CLIENTS & INSIGHTS:
  GET  /api/v1/sites/{site_id}/stats/clients            Connected wireless clients
  GET  /api/v1/sites/{site_id}/insights/...             Assurance insights / SLE metrics

CONFIG (WLANs, policies, templates — writes hit the live cloud):
  GET  /api/v1/sites/{site_id}/wlans                    List WLANs
  GET  /api/v1/sites/{site_id}/wlans/{wlan_id}          One WLAN
  POST /api/v1/sites/{site_id}/wlans                    Create a WLAN (medium blast radius)
  GET  /api/v1/orgs/{org_id}/wlans                      Org-level WLAN templates

TOKENS: GET /api/v1/self/apitokens lists API tokens; do NOT create/delete tokens
unless explicitly asked (POST/DELETE /api/v1/self/apitokens).

PAGINATION (SILENT — this is the #1 cause of "missing" devices/clients):
- List/search endpoints DEFAULT to limit=100, page=1 and DO NOT tell you there is
  more unless you look. If a result has exactly 100 (or your limit) rows, ASSUME
  there may be more. Either raise the limit (e.g. {"limit":1000}) or page through
  ({"page":2}, ...) until a page returns fewer than the limit.
- Mist returns paging in RESPONSE HEADERS (X-Page-Total, X-Page-Limit,
  X-Page-Page). The helper surfaces only the body, so rely on the "row count ==
  limit -> fetch more" heuristic. Never conclude "there are only N devices" off a
  single default-limit page.

RULES:
- ALWAYS GET /api/v1/self first to discover the org_id(s) this token can access,
  then GET /api/v1/orgs/{org_id}/sites for site_ids. Never invent ids.
- To answer "show me the switches / are any down", query INVENTORY with
  {"type":"switch"} (claimed devices, incl. disconnected) — do NOT rely on the
  site stats/devices endpoint alone, which defaults to APs only.
- Rate limit is 5,000 requests/hour per token — batch sensibly.
- A 401 = wrong/expired API token (Settings -> Juniper Mist). A 404 = wrong path
  shape or a bad org_id/site_id — re-resolve ids; do NOT brute-force names.
- An empty list ([]) with status 200 is a valid EMPTY answer, not a failure.
- Responses are {"status_code","data","error","blast_radius"}; check status_code < 400."""


def _norm_region(region: Optional[str]) -> str:
    r = (region or "").strip().lower()
    return r if r in _HOSTS else "global01"


def _host(region: Optional[str]) -> str:
    return _HOSTS[_norm_region(region)]


def _blast_radius(method: str, path: str) -> str:
    """Classify a call for approval metadata. Method-only; never blocks.

    GET=low, DELETE=destructive, all other writes=medium.
    """
    m = (method or "GET").upper()
    if m == "GET":
        return "low"
    if m == "DELETE":
        return "destructive"
    return "medium"


class MistClient:
    """Juniper Mist REST client for the MCP server and code sandbox.

    Reads credentials from the config dict (sourced from sessions.db, same as the
    Settings -> Juniper Mist tab). Auth is a static API token sent on every
    request as `Authorization: Token <api_token>`; there is no token exchange.
    """

    def __init__(self, config: Optional[Dict[str, Any]]):
        self._config = config or {}

    @property
    def _region(self) -> str:
        return _norm_region(self._config.get("region"))

    @property
    def _verify_ssl(self) -> bool:
        return bool(self._config.get("verify_ssl", True))

    def _headers(self) -> Dict[str, str]:
        token = (self._config.get("api_token") or "").strip()
        return {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f"Token {token}",
        }

    def call(
        self,
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        """Call a Mist API endpoint. Returns the standard envelope.

        The host is selected from the saved region; auth is a static API token.
        """
        method = (method or "GET").upper()
        token = (self._config.get("api_token") or "").strip()
        if not token:
            return {"status_code": 0, "data": None,
                    "error": "Juniper Mist is not configured. Set an API Token in Settings -> Juniper Mist.",
                    "blast_radius": _blast_radius(method, path)}

        if not path.startswith("/"):
            path = "/" + path
        url = f"https://{_host(self._region)}{path}"
        try:
            resp = requests.request(
                method=method, url=url, headers=self._headers(), json=body,
                params=query_params, verify=self._verify_ssl, timeout=30,
            )
            try:
                data = resp.json()
            except Exception:
                data = resp.text
            return {"status_code": resp.status_code, "data": data,
                    "error": None if resp.status_code < 400 else build_http_error(resp.status_code, data),
                    "blast_radius": _blast_radius(method, path)}
        except requests.exceptions.Timeout:
            return {"status_code": 0, "data": None, "error": "Request timed out after 30 seconds",
                    "blast_radius": _blast_radius(method, path)}
        except requests.exceptions.SSLError:
            return {"status_code": 0, "data": None,
                    "error": "SSL certificate verification failed (uncheck Verify SSL if needed)",
                    "blast_radius": _blast_radius(method, path)}
        except Exception as e:
            return {"status_code": 0, "data": None, "error": str(e),
                    "blast_radius": _blast_radius(method, path)}


def install_mist(
    globals_dict: dict[str, Any],
    emit: Optional[Callable[[dict], None]] = None,
) -> MistClient:
    """Bind a `mist_api_call` function into a sandbox globals dict.

    Mirrors install_cisco_xdr. `emit` is accepted for parity.
    """
    from ccie_sidecar.mist_config import get_mist_config

    client = MistClient(get_mist_config())

    def mist_api_call(
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> str:
        """Call the Juniper Mist REST API. Returns a JSON string (json.loads it)."""
        return json.dumps(client.call(method, path, body, query_params))

    globals_dict["mist_api_call"] = mist_api_call
    globals_dict["mist"] = client

    mod = types.ModuleType("mist_api")
    mod.mist_api_call = mist_api_call  # type: ignore[attr-defined]
    mod.client = client  # type: ignore[attr-defined]
    sys.modules["mist_api"] = mod

    return client


def test_connection(config: Dict[str, Any]) -> Dict[str, Any]:
    """Test a Juniper Mist connection without saving. Returns {ok, message}.

    A read-only GET /api/v1/self is the cleanest health check — it proves the
    API token and region are valid and returns the token's identity/privileges.
    """
    token = (config.get("api_token") or "").strip()
    if not token:
        return {"ok": False, "message": "An API Token is required."}

    client = MistClient(config)
    result = client.call("GET", "/api/v1/self")
    if result["status_code"] == 200:
        host = _host(config.get("region"))
        data = result.get("data") or {}
        who = data.get("email") or data.get("name") or "token"
        return {"ok": True, "message": f"Authenticated to Juniper Mist at {host} as {who}."}
    if result["status_code"] == 401:
        return {"ok": False, "message": "Authentication failed (401). Check the API Token and region."}
    return {"ok": False,
            "message": result.get("error") or "Connection failed. Check the API Token and region."}
