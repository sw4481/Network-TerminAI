"""Cisco Identity Services Engine (ISE) integration.

ISE exposes three REST surfaces, all reachable with the same admin Basic-Auth
credentials:

  * ERS     - classic config API on port 9060   (/ers/config/...)
  * OpenAPI - newer config API on port 443       (/api/v1/...)
  * MnT     - read-only monitoring on port 443   (/admin/API/mnt/...)

A single `ise_api_call(method, path, ...)` helper dispatches across all three:
the surface (and therefore the port) is inferred from the path prefix, so the
agent only needs to know the path. Mirrors the Stealthwatch integration so the
MCP server and the in-sandbox helper share one client and can't drift.
"""

import json
import sys
import types
from typing import Any, Callable, Dict, Optional

import requests



from ccie_sidecar.api_errors import build_http_error
def _xml_to_dict(text: str) -> Optional[Any]:
    """Best-effort convert an MnT XML response to a JSON-friendly dict.

    MnT only serves XML. We flatten each element to {tag: text-or-childdict};
    repeated sibling tags become a list. Returns None if `text` isn't parseable
    XML so the caller can fall back to the raw string.
    """
    import xml.etree.ElementTree as ET

    def _node(el: "ET.Element") -> Any:
        children = list(el)
        if not children:
            txt = (el.text or "").strip()
            return txt if not el.attrib else {**el.attrib, "_text": txt}
        out: Dict[str, Any] = dict(el.attrib)
        for child in children:
            tag = child.tag
            val = _node(child)
            if tag in out:
                if not isinstance(out[tag], list):
                    out[tag] = [out[tag]]
                out[tag].append(val)
            else:
                out[tag] = val
        return out

    try:
        root = ET.fromstring(text)
    except Exception:
        return None
    return {root.tag: _node(root)}


def _surface_for_path(path: str) -> str:
    """Infer which ISE API surface a path belongs to (ers | openapi | mnt)."""
    if path.startswith("/admin/API/mnt"):
        return "mnt"
    if path.startswith("/api/"):
        return "openapi"
    # /ers/... and anything else defaults to the ERS surface.
    return "ers"


def _blast_radius(method: str, path: str) -> str:
    """Classify an API call for approval gating. Mirrors the MCP server.

    MnT is a read-only monitoring surface, so anything there is low. Otherwise
    GET=low, DELETE=destructive, mutating writes to policy/identity/trustsec/
    device config=high, other writes=medium.
    """
    method = (method or "GET").upper()
    if _surface_for_path(path) == "mnt":
        return "low"
    if method == "GET":
        return "low"
    if method == "DELETE":
        return "destructive"
    if any(
        seg in path
        for seg in (
            "/networkdevice",
            "/identitygroup",
            "/internaluser",
            "/endpointgroup",
            "/sgt",
            "/trustsec",
            "/policy",
            "/admin",
        )
    ):
        return "high"
    return "medium"


class IseClient:
    """Basic-Auth ISE REST client for the code sandbox.

    Reads credentials from the config dict (sourced from sessions.db, same as
    the Settings -> ISE tab). A persistent requests.Session reuses the
    connection across calls; Basic Auth means there is no login/token dance.
    """

    # Default ports per surface. ERS lives on its own admin port; OpenAPI and
    # MnT ride the standard admin HTTPS port.
    _PORTS = {"ers": 9060, "openapi": 443, "mnt": 443}

    def __init__(self, config: Optional[Dict[str, Any]]):
        self._config = config or {}
        self._session: Optional[requests.Session] = None

    @property
    def _host(self) -> str:
        return (self._config.get("host") or "").strip()

    @property
    def _verify_ssl(self) -> bool:
        return bool(self._config.get("verify_ssl", True))

    def _ensure_session(self) -> Optional[requests.Session]:
        username = (self._config.get("username") or "").strip()
        password = self._config.get("password") or ""
        if not self._host or not username:
            return None
        if self._session is None:
            session = requests.Session()
            session.auth = (username, password)
            if not self._verify_ssl:
                from ccie_sidecar.tls import mount_unverified_tls
                mount_unverified_tls(session)
            self._session = session
        return self._session

    def _url(self, path: str, base: Optional[str]) -> str:
        surface = base or _surface_for_path(path)
        port = self._PORTS.get(surface, 443)
        return f"https://{self._host}:{port}{path}"

    def call(
        self,
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
        base: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Call an ISE API endpoint. Returns a dict the agent json.loads-es.

        Shape: {"status_code", "data", "error", "blast_radius"}. `base` forces a
        surface (ers|openapi|mnt); when None it is inferred from the path.
        """
        method = (method or "GET").upper()
        if not self._host:
            return {
                "status_code": 0,
                "data": None,
                "error": "ISE is not configured. Set host/credentials in Settings -> ISE.",
                "blast_radius": _blast_radius(method, path),
            }

        session = self._ensure_session()
        if session is None:
            return {
                "status_code": 0,
                "data": None,
                "error": "ISE credentials are incomplete. Set host/username/password in Settings -> ISE.",
                "blast_radius": _blast_radius(method, path),
            }

        url = self._url(path, base)
        # Content negotiation is surface-specific. ERS/OpenAPI speak JSON. The MnT
        # API ONLY serves XML and returns 406 Not Acceptable if asked for JSON
        # (verified live against ISE 3.3), so request XML there and let the JSON
        # parse fall back to returning the raw XML text.
        surface = base or _surface_for_path(path)
        if surface == "mnt":
            headers = {"Accept": "application/xml"}
        else:
            headers = {"Accept": "application/json", "Content-Type": "application/json"}

        try:
            resp = session.request(
                method=method,
                url=url,
                headers=headers,
                json=body,
                params=query_params,
                verify=self._verify_ssl,
                timeout=30,
            )
            try:
                data = resp.json()
            except Exception:
                # MnT returns XML; parse it to a dict so the agent gets structured
                # data instead of a raw XML blob. Falls back to text if parsing fails.
                text = resp.text
                data = _xml_to_dict(text) if surface == "mnt" else text
                if data is None:
                    data = text

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
            return {"status_code": 0, "data": None,
                    "error": "SSL certificate verification failed (uncheck Verify SSL for self-signed certs)",
                    "blast_radius": _blast_radius(method, path)}
        except Exception as e:
            return {"status_code": 0, "data": None, "error": str(e),
                    "blast_radius": _blast_radius(method, path)}

    # ---- High-level convenience helpers ------------------------------------
    # Small wrappers over the most common reads so a weak LLM doesn't flail on
    # paging or the right surface.

    def list_network_devices(self) -> Dict[str, Any]:
        """ERS: list configured network devices (NADs)."""
        return self.call("GET", "/ers/config/networkdevice")

    def list_endpoints(self) -> Dict[str, Any]:
        """ERS: list known endpoints."""
        return self.call("GET", "/ers/config/endpoint")

    def get_active_sessions(self) -> Dict[str, Any]:
        """MnT: list currently active authentication sessions."""
        return self.call("GET", "/admin/API/mnt/Session/ActiveList", base="mnt")


def install_ise(
    globals_dict: dict[str, Any],
    emit: Optional[Callable[[dict], None]] = None,
) -> IseClient:
    """Bind an `ise_api_call` function into a sandbox globals dict.

    Registers the helper the agent's system prompt expects so the ise agent can
    actually reach the API in react / react-code / deepagents code-exec. `emit`
    is accepted for parity with other helpers.
    """
    from ccie_sidecar.ise_config import get_ise_config

    client = IseClient(get_ise_config())

    def ise_api_call(
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
        base: Optional[str] = None,
    ) -> str:
        """Call the Cisco ISE REST API. Returns a JSON string (use json.loads)."""
        return json.dumps(client.call(method, path, body, query_params, base))

    globals_dict["ise_api_call"] = ise_api_call

    # Also expose the client object for advanced use.
    globals_dict["ise"] = client

    # Make `import ise_api` work too, mirroring install_stealthwatch.
    mod = types.ModuleType("ise_api")
    mod.ise_api_call = ise_api_call  # type: ignore[attr-defined]
    mod.client = client  # type: ignore[attr-defined]
    sys.modules["ise_api"] = mod

    return client


def test_connection(config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Test ISE connection without saving to database.

    Args:
        config: Dict with keys: host, username, password, verify_ssl

    Returns:
        Dict with keys: ok (bool), message (str)
    """
    host = (config.get("host") or "").strip()
    username = (config.get("username") or "").strip()
    password = config.get("password") or ""

    if not host or not username or not password:
        return {
            "ok": False,
            "message": "Host, username, and password are required."
        }

    # Cheap authed read against the ERS surface (port 9060). A single-page
    # network-device list confirms creds + ERS-enabled without side effects.
    client = IseClient(config)
    result = client.call(
        "GET", "/ers/config/networkdevice", query_params={"size": 1}
    )

    status = result.get("status_code") or 0
    if status == 401:
        return {"ok": False, "message": "Authentication failed. Check credentials."}
    if status == 0 and result.get("error"):
        return {"ok": False, "message": result["error"]}
    if status >= 400:
        return {
            "ok": False,
            "message": f"HTTP {status}. Is ERS enabled (Admin -> System -> Settings -> API Settings)?",
        }

    return {"ok": True, "message": f"Connected to ISE at {host} (ERS reachable)."}
