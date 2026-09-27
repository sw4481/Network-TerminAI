"""Cisco XDR (Extended Detection & Response) integration.

Cisco XDR is NOT a single host. Its API spans four regional host families that
all share ONE OAuth2 bearer token (client_credentials grant, short-lived, no
refresh):

  - /iroh/*    -> Platform / IROH   (enrich, inspect, respond; also the token endpoint)
  - /ctia/*    -> Private Intel / CTIA (incident summaries, judgements, sightings)
  - /v2/*      -> Conure            (incidents & investigations search/list/get)
  - /api/v1/*  -> Automate          (automation workflows)

A single `cisco_xdr_api_call(method, path, ...)` helper drives all four — the
host is auto-selected from the path PREFIX so the caller only supplies method +
path. The bearer is minted on demand against the IROH host and reused across all
families; it is re-minted once on a 401. Mirrors the Secure Endpoint / ISE
integrations so the MCP server and the in-sandbox helper share one client and
can't drift.
"""
from __future__ import annotations

import json
import sys
import types
from typing import Any, Callable, Dict, Optional

import requests


from ccie_sidecar.api_errors import build_http_error
# region -> per-family host. NAM is the default for unknown/empty values.
# NOTE the region infixes differ per family: NAM "visibility" has NO infix,
# EU/APJC do; Conure/Automate use explicit .us./.eu./.apjc.
_IROH_HOSTS = {
    "nam": "visibility.amp.cisco.com",
    "eu": "visibility.eu.amp.cisco.com",
    "apjc": "visibility.apjc.amp.cisco.com",
}
_INTEL_HOSTS = {
    "nam": "private.intel.amp.cisco.com",
    "eu": "private.intel.eu.amp.cisco.com",
    "apjc": "private.intel.apjc.amp.cisco.com",
}
_CONURE_HOSTS = {
    "nam": "conure.us.security.cisco.com",
    "eu": "conure.eu.security.cisco.com",
    "apjc": "conure.apjc.security.cisco.com",
}
_AUTOMATE_HOSTS = {
    "nam": "automate.us.security.cisco.com",
    "eu": "automate.eu.security.cisco.com",
    "apjc": "automate.apjc.security.cisco.com",
}


# ---------------------------------------------------------------------------
# Single source of truth for the XDR API surface. Consumed by BOTH the MCP
# tool description (cisco_xdr_mcp.get_tool_description) and the in-sandbox
# client-section (react_code._build_client_section) so they can never drift.
# Endpoints below were enumerated from the live tenant's swagger specs
# (iroh-enrich / iroh-inspect / iroh-response) + verified CTIA/CTIM resources
# + Conure v2 + Automate, on 2026-06-27.
# ---------------------------------------------------------------------------
XDR_CAPABILITIES_DOC = """Cisco XDR is a THREAT-INTELLIGENCE & response platform — it enriches
observables/IOCs, stores threat-intel (incidents, indicators, sightings,
judgements, verdicts, and ASSETS/devices), and triggers response actions.
It does NOT use Secure-Endpoint-style paths: there is NO /v1/computers,
/v1/hosts or /iroh/hosts. To list the devices/assets XDR knows about, use the
CTIA asset store: GET /ctia/asset/search (query_params {"query":"*"}). For deep
per-host health (OS, IPs, isolation) pivot to the Secure Endpoint tool.

The path PREFIX selects the host automatically (all share one OAuth2 token):
  /iroh/*    -> Platform / IROH      (enrich, inspect, respond)
  /ctia/*    -> Private Intel / CTIA (threat-intel store: incidents, IOCs, ...)
  /v2/*      -> Conure               (incident search/count)
  /api/v1/*  -> Automate             (automation workflows)

OBSERVABLES are an ARRAY of {"type":"...","value":"..."} (type ∈ domain, ip,
ipv6, url, sha256, sha1, md5, email, file_name, ...).

ENRICH / INSPECT / RESPOND (POST; Platform/IROH):
  POST /iroh/iroh-inspect/inspect                 Extract observables from free text; body {"content":"..."}
  POST /iroh/iroh-enrich/observe/observables      Deep enrichment -> verdicts/judgements/sightings; body [observables]
  POST /iroh/iroh-enrich/deliberate/observables   Quick verdicts only; body [observables]
  POST /iroh/iroh-enrich/refer/observables        Pivot/reference links; body [observables]
  GET  /iroh/iroh-enrich/reputation/observable    Reputation of one observable; query_params {"type":"..","value":".."}
  POST /iroh/iroh-response/respond/observables     Available response actions for observables; body [observables]
  POST /iroh/iroh-response/respond/trigger/{module-instance-id}/{action-id}   Trigger an action

THREAT-INTEL STORE (CTIA; uniform CTIM model). Every resource supports:
  GET  /ctia/{type}/search        query_params {"query":"*","limit":50}   (query is REQUIRED; "*" = all)
  GET  /ctia/{type}/search/count  query_params {"query":"*"}
  GET  /ctia/{type}/{id}          fetch one by id
  {type} ∈ incident, indicator, judgement, sighting, verdict, relationship,
  actor, campaign, malware, tool, vulnerability, attack-pattern, coa, weakness,
  target-record, asset, asset-mapping, casebook, investigation, event, feedback.
  Extra: GET /ctia/incident/{id}/summary  (linked incidents, observables, severity)

INCIDENTS (Conure mirror; same data as /ctia/incident):
  GET  /v2/incident/search        query_params {"query":"*","limit":50}
  GET  /v2/incident/search/count  query_params {"query":"*"}

AUTOMATION (Automate):
  GET  /api/v1/workflows          List automation workflows (id, name, type)

RULES:
- Searching ALWAYS uses the /search sub-path with a REQUIRED query param
  ({"query":"*"} = all). A bare GET /v2/incident or /ctia/incident is a 405.
- An empty result ([] or 0) with status 200 is a valid EMPTY answer, not a failure.
- A 401 = wrong credentials (Settings -> Cisco XDR). A 404/405 = wrong path/method
  shape — consult this catalog; do NOT brute-force singular/plural or invent
  host-inventory paths.
- Responses are {"status_code","data","error","blast_radius"}; check status_code < 400."""


def _norm_region(region: Optional[str]) -> str:
    r = (region or "").strip().lower()
    return r if r in _IROH_HOSTS else "nam"


def _iroh_host(region: Optional[str]) -> str:
    return _IROH_HOSTS[_norm_region(region)]


def _host_for_path(path: str, region: Optional[str]) -> str:
    """Select the regional host for a request from its path prefix.

    /iroh -> IROH, /ctia -> Private Intel, /v2 -> Conure, /api/v1 -> Automate.
    Anything else defaults to the IROH platform host (the most common family).
    """
    r = _norm_region(region)
    p = path if path.startswith("/") else "/" + path
    if p.startswith("/ctia"):
        return _INTEL_HOSTS[r]
    if p.startswith("/v2"):
        return _CONURE_HOSTS[r]
    if p.startswith("/api/v1"):
        return _AUTOMATE_HOSTS[r]
    # /iroh and everything else -> Platform.
    return _IROH_HOSTS[r]


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


class CiscoXdrClient:
    """Cisco XDR REST client for the MCP server and code sandbox.

    Reads credentials from the config dict (sourced from sessions.db, same as the
    Settings -> Cisco XDR tab). A single OAuth2 client_credentials bearer is
    minted against the IROH host and shared across all four host families.
    """

    def __init__(self, config: Optional[Dict[str, Any]]):
        self._config = config or {}
        self._bearer: Optional[str] = None

    @property
    def _region(self) -> str:
        return _norm_region(self._config.get("region"))

    @property
    def _verify_ssl(self) -> bool:
        return bool(self._config.get("verify_ssl", True))

    def _ensure_bearer(self, force: bool = False) -> Optional[str]:
        """OAuth2 client_credentials token exchange against the IROH host."""
        if self._bearer and not force:
            return self._bearer
        client_id = (self._config.get("client_id") or "").strip()
        secret = self._config.get("client_password") or ""
        if not client_id or not secret:
            return None
        token_url = f"https://{_iroh_host(self._region)}/iroh/oauth2/token"
        try:
            resp = requests.post(
                token_url,
                auth=(client_id, secret),
                data={"grant_type": "client_credentials"},
                headers={"Content-Type": "application/x-www-form-urlencoded",
                         "Accept": "application/json"},
                verify=self._verify_ssl,
                timeout=30,
            )
            if resp.status_code < 400:
                self._bearer = resp.json().get("access_token")
            else:
                self._bearer = None
        except Exception:
            self._bearer = None
        return self._bearer

    def call(
        self,
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        """Call a Cisco XDR API endpoint. Returns the standard envelope.

        The host is auto-selected from the path prefix; auth is a shared bearer.
        """
        method = (method or "GET").upper()
        client_id = (self._config.get("client_id") or "").strip()
        secret = self._config.get("client_password") or ""
        if not client_id or not secret:
            return {"status_code": 0, "data": None,
                    "error": "Cisco XDR is not configured. Set Client ID + Client Password in Settings -> Cisco XDR.",
                    "blast_radius": _blast_radius(method, path)}

        token = self._ensure_bearer()
        if not token:
            return {"status_code": 0, "data": None,
                    "error": "OAuth2 token exchange failed. Check Client ID / Client Password in Settings -> Cisco XDR.",
                    "blast_radius": _blast_radius(method, path)}

        if not path.startswith("/"):
            path = "/" + path
        url = f"https://{_host_for_path(path, self._region)}{path}"
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        }
        try:
            resp = requests.request(
                method=method, url=url, headers=headers, json=body,
                params=query_params, verify=self._verify_ssl, timeout=30,
            )
            # Bearer is short-lived (~10 min) -> re-mint once on 401.
            if resp.status_code == 401:
                token = self._ensure_bearer(force=True)
                if token:
                    headers["Authorization"] = f"Bearer {token}"
                    resp = requests.request(
                        method=method, url=url, headers=headers, json=body,
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


def install_cisco_xdr(
    globals_dict: dict[str, Any],
    emit: Optional[Callable[[dict], None]] = None,
) -> CiscoXdrClient:
    """Bind a `cisco_xdr_api_call` function into a sandbox globals dict.

    Mirrors install_secure_endpoint. `emit` is accepted for parity.
    """
    from ccie_sidecar.cisco_xdr_config import get_cisco_xdr_config

    client = CiscoXdrClient(get_cisco_xdr_config())

    def cisco_xdr_api_call(
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> str:
        """Call the Cisco XDR REST API. Returns a JSON string (json.loads it)."""
        return json.dumps(client.call(method, path, body, query_params))

    globals_dict["cisco_xdr_api_call"] = cisco_xdr_api_call
    globals_dict["cisco_xdr"] = client

    mod = types.ModuleType("cisco_xdr_api")
    mod.cisco_xdr_api_call = cisco_xdr_api_call  # type: ignore[attr-defined]
    mod.client = client  # type: ignore[attr-defined]
    sys.modules["cisco_xdr_api"] = mod

    return client


def test_connection(config: Dict[str, Any]) -> Dict[str, Any]:
    """Test a Cisco XDR connection without saving. Returns {ok, message}.

    A successful client_credentials token mint is the cleanest health check —
    it proves the Client ID / Client Password and region are valid.
    """
    client_id = (config.get("client_id") or "").strip()
    secret = config.get("client_password") or ""
    if not client_id or not secret:
        return {"ok": False, "message": "Client ID and Client Password are required."}

    client = CiscoXdrClient(config)
    token = client._ensure_bearer()
    if token:
        host = _iroh_host(config.get("region"))
        return {"ok": True, "message": f"Authenticated to Cisco XDR at {host}."}
    return {"ok": False,
            "message": "Authentication failed. Check Client ID / Client Password and region."}
