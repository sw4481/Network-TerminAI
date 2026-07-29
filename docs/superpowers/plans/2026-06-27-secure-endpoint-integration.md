# Cisco Secure Endpoint MCP Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Cisco Secure Endpoint (AMP for Endpoints) integration as a single-tool MCP server (`secure_endpoint_api_call`), with a Settings tab, a dedicated `secure-endpoint` agent, and network-architect access — mirroring the ISE/FMC/Stealthwatch pattern exactly.

**Architecture:** A shared `SecureEndpointClient` (Python) is the single source of truth for auth + HTTP. It is consumed by (a) the MCP server `secure_endpoint_mcp.py` for the `mcp_servers`-registered stdio tool, and (b) `install_secure_endpoint()` which binds an in-sandbox `secure_endpoint_api_call(...)` helper for agents. The Rust layer stores a singleton config row and auto-registers the MCP server on save. v1 (HTTP Basic auth) is implemented and testable; a `v3_oauth` mode is wired but flagged unverified.

**Tech Stack:** Python (requests), Rust (Tauri + rusqlite), React/TypeScript, SQLite (refinery migrations), DeepAgents.

## Global Constraints

- Next free migration number is **V0066** — use `V0066__secure_endpoint_config.sql`. Do NOT reuse V0064/V0065.
- Module/tool naming follows the established convention exactly: shared client `secure_endpoint.py`; config reader `secure_endpoint_config.py`; MCP server `secure_endpoint_mcp.py`; single tool name `secure_endpoint_api_call`; MCP server id `secure-endpoint-mcp`; display name `Cisco Secure Endpoint`; agent dir/id `secure-endpoint`; tool catalog `tools.json`.
- Env vars injected by the Rust transport: `SECURE_ENDPOINT_REGION`, `SECURE_ENDPOINT_AUTH_MODE`, `SECURE_ENDPOINT_CLIENT_ID`, `SECURE_ENDPOINT_API_KEY`, `SECURE_ENDPOINT_VERIFY_SSL`.
- Config DB is `sessions.db` (NOT the encrypted vault) — credentials stored plaintext, matching ISE/FMC.
- `verify_ssl` defaults to **true** (1) — Cisco-signed public hosts, unlike ISE/FMC which default false.
- Region→host: `nam`→`api.amp.cisco.com`, `eu`→`api.eu.amp.cisco.com`, `apjc`→`api.apjc.amp.cisco.com`.
- Blast radius is metadata only and NEVER blocks: GET=`low`, POST/PUT/PATCH=`medium`, DELETE=`destructive`. Agent `default-blast-radius-allowed: destructive`.
- Every response shape: `{"status_code": int, "data": <payload>, "error": str|None, "blast_radius": str}`.
- Run Python tests with the sidecar venv: `cd sidecar && .venv/bin/python -m pytest <path> -v`.
- Run the app/build check with `CCIE_REPO_ROOT` set to the repo root (Rust resolves the MCP script path from it).

---

### Task 1: Shared `SecureEndpointClient` + blast radius (Python)

**Files:**
- Create: `sidecar/src/ccie_sidecar/secure_endpoint.py`
- Test: `sidecar/src/ccie_sidecar/test_secure_endpoint.py`

**Interfaces:**
- Consumes: nothing (leaf module). Uses `requests`.
- Produces:
  - `_region_host(region: str) -> str` — maps `nam|eu|apjc` to the api host; defaults to `api.amp.cisco.com`.
  - `_blast_radius(method: str, path: str) -> str` — `"low"|"medium"|"destructive"`.
  - `class SecureEndpointClient` with `__init__(self, config: Optional[Dict[str, Any]])` and `call(self, method, path, body=None, query_params=None) -> Dict[str, Any]` returning `{"status_code","data","error","blast_radius"}`.
  - `install_secure_endpoint(globals_dict: dict, emit=None) -> SecureEndpointClient` — binds `secure_endpoint_api_call` (returns JSON string) + `secure_endpoint` object + `import secure_endpoint_api` module.
  - `test_connection(config: Dict[str, Any]) -> Dict[str, Any]` returning `{"ok": bool, "message": str}`.

- [ ] **Step 1: Write the failing test**

Create `sidecar/src/ccie_sidecar/test_secure_endpoint.py`:

```python
import json
from unittest.mock import MagicMock, patch

from ccie_sidecar.secure_endpoint import (
    SecureEndpointClient,
    _blast_radius,
    _region_host,
    install_secure_endpoint,
)


def test_region_host_mapping():
    assert _region_host("nam") == "api.amp.cisco.com"
    assert _region_host("eu") == "api.eu.amp.cisco.com"
    assert _region_host("apjc") == "api.apjc.amp.cisco.com"
    # Unknown / empty falls back to NAM.
    assert _region_host("") == "api.amp.cisco.com"
    assert _region_host("zzz") == "api.amp.cisco.com"


def test_blast_radius_by_method():
    assert _blast_radius("GET", "/v1/computers") == "low"
    assert _blast_radius("POST", "/v1/file_lists/x/files/y") == "medium"
    assert _blast_radius("PUT", "/v1/computers/g/isolation") == "medium"
    assert _blast_radius("PATCH", "/v1/computers/g") == "medium"
    assert _blast_radius("DELETE", "/v1/computers/g/isolation") == "destructive"


def test_call_unconfigured_returns_error_envelope():
    client = SecureEndpointClient({})
    out = client.call("GET", "/v1/version")
    assert out["status_code"] == 0
    assert out["error"]
    assert out["blast_radius"] == "low"
    assert out["data"] is None


def test_v1_basic_auth_and_url_construction():
    client = SecureEndpointClient({
        "region": "eu",
        "auth_mode": "v1_basic",
        "client_id": "cid",
        "api_key": "key",
        "verify_ssl": True,
    })
    fake = MagicMock()
    fake.status_code = 200
    fake.json.return_value = {"version": "v1.2.3"}
    with patch("requests.Session.request", return_value=fake) as req:
        out = client.call("GET", "/v1/version")
    assert out["status_code"] == 200
    assert out["data"] == {"version": "v1.2.3"}
    assert out["error"] is None
    # Built the EU host URL.
    _, kwargs = req.call_args
    assert kwargs["url"] == "https://api.eu.amp.cisco.com/v1/version"
    # Basic auth set on the session.
    assert client._session.auth == ("cid", "key")


def test_install_binds_helper():
    g = {}
    install_secure_endpoint(g)
    assert "secure_endpoint_api_call" in g
    assert callable(g["secure_endpoint_api_call"])
    # Helper returns a JSON string (unconfigured -> error envelope).
    s = g["secure_endpoint_api_call"]("GET", "/v1/version")
    parsed = json.loads(s)
    assert parsed["status_code"] == 0
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd sidecar && .venv/bin/python -m pytest src/ccie_sidecar/test_secure_endpoint.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'ccie_sidecar.secure_endpoint'`.

- [ ] **Step 3: Write the implementation**

Create `sidecar/src/ccie_sidecar/secure_endpoint.py`:

```python
"""Cisco Secure Endpoint (AMP for Endpoints) integration.

Secure Endpoint exposes a single regional REST host. The classic v1 API uses
HTTP Basic auth (API client_id as username, api_key as password); the newer v3
API uses an OAuth2 bearer token. A single `secure_endpoint_api_call(method,
path, ...)` helper drives both — the host comes from the region, the auth from
auth_mode. Mirrors the ISE integration so the MCP server and the in-sandbox
helper share one client and can't drift.
"""
from __future__ import annotations

import json
import sys
import types
from typing import Any, Callable, Dict, Optional

import requests

# region -> regional API host. NAM is the default for unknown/empty values.
_REGION_HOSTS = {
    "nam": "api.amp.cisco.com",
    "eu": "api.eu.amp.cisco.com",
    "apjc": "api.apjc.amp.cisco.com",
}
# v3 OAuth2 token hosts (visibility.*). Wired but UNVERIFIED against hardware.
_REGION_TOKEN_HOSTS = {
    "nam": "visibility.amp.cisco.com",
    "eu": "visibility.eu.amp.cisco.com",
    "apjc": "visibility.apjc.amp.cisco.com",
}


def _region_host(region: Optional[str]) -> str:
    return _REGION_HOSTS.get((region or "").strip().lower(), _REGION_HOSTS["nam"])


def _region_token_host(region: Optional[str]) -> str:
    return _REGION_TOKEN_HOSTS.get((region or "").strip().lower(), _REGION_TOKEN_HOSTS["nam"])


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


class SecureEndpointClient:
    """Secure Endpoint REST client for the MCP server and code sandbox.

    Reads credentials from the config dict (sourced from sessions.db, same as the
    Settings -> Secure Endpoint tab). v1_basic uses a persistent requests.Session
    with HTTP Basic auth (no token dance). v3_oauth exchanges client_id/secret for
    a bearer token (UNVERIFIED against hardware).
    """

    def __init__(self, config: Optional[Dict[str, Any]]):
        self._config = config or {}
        self._session: Optional[requests.Session] = None
        self._bearer: Optional[str] = None

    @property
    def _region(self) -> str:
        return (self._config.get("region") or "nam").strip().lower()

    @property
    def _auth_mode(self) -> str:
        return (self._config.get("auth_mode") or "v1_basic").strip().lower()

    @property
    def _verify_ssl(self) -> bool:
        return bool(self._config.get("verify_ssl", True))

    def _ensure_session(self) -> Optional[requests.Session]:
        client_id = (self._config.get("client_id") or "").strip()
        api_key = self._config.get("api_key") or ""
        if not client_id or not api_key:
            return None
        if self._session is None:
            session = requests.Session()
            if self._auth_mode == "v1_basic":
                session.auth = (client_id, api_key)
            self._session = session
        return self._session

    def _ensure_bearer(self) -> Optional[str]:
        """v3 OAuth2 client-credentials token exchange. UNVERIFIED vs hardware."""
        if self._auth_mode != "v3_oauth":
            return None
        if self._bearer:
            return self._bearer
        client_id = (self._config.get("client_id") or "").strip()
        secret = self._config.get("api_key") or ""
        token_url = f"https://{_region_token_host(self._region)}/iroh/oauth2/token"
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
        except Exception:
            self._bearer = None
        return self._bearer

    def _url(self, path: str) -> str:
        if not path.startswith("/"):
            path = "/" + path
        return f"https://{_region_host(self._region)}{path}"

    def call(
        self,
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        """Call a Secure Endpoint API endpoint. Returns the standard envelope."""
        method = (method or "GET").upper()
        client_id = (self._config.get("client_id") or "").strip()
        if not client_id:
            return {"status_code": 0, "data": None,
                    "error": "Secure Endpoint is not configured. Set credentials in Settings -> Secure Endpoint.",
                    "blast_radius": _blast_radius(method, path)}

        session = self._ensure_session()
        if session is None:
            return {"status_code": 0, "data": None,
                    "error": "Secure Endpoint credentials are incomplete. Set Client ID + API Key in Settings -> Secure Endpoint.",
                    "blast_radius": _blast_radius(method, path)}

        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if self._auth_mode == "v3_oauth":
            token = self._ensure_bearer()
            if not token:
                return {"status_code": 0, "data": None,
                        "error": "v3 OAuth token exchange failed (this path is unverified against hardware).",
                        "blast_radius": _blast_radius(method, path)}
            headers["Authorization"] = f"Bearer {token}"

        url = self._url(path)
        try:
            resp = session.request(
                method=method, url=url, headers=headers, json=body,
                params=query_params, verify=self._verify_ssl, timeout=30,
            )
            # v3 bearer can expire -> re-auth once on 401.
            if resp.status_code == 401 and self._auth_mode == "v3_oauth":
                self._bearer = None
                token = self._ensure_bearer()
                if token:
                    headers["Authorization"] = f"Bearer {token}"
                    resp = session.request(
                        method=method, url=url, headers=headers, json=body,
                        params=query_params, verify=self._verify_ssl, timeout=30,
                    )
            try:
                data = resp.json()
            except Exception:
                data = resp.text
            return {"status_code": resp.status_code, "data": data,
                    "error": None if resp.status_code < 400 else f"HTTP {resp.status_code}",
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


def install_secure_endpoint(
    globals_dict: dict[str, Any],
    emit: Optional[Callable[[dict], None]] = None,
) -> SecureEndpointClient:
    """Bind a `secure_endpoint_api_call` function into a sandbox globals dict.

    Mirrors install_ise. `emit` is accepted for parity with other helpers.
    """
    from ccie_sidecar.secure_endpoint_config import get_secure_endpoint_config

    client = SecureEndpointClient(get_secure_endpoint_config())

    def secure_endpoint_api_call(
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> str:
        """Call the Cisco Secure Endpoint REST API. Returns a JSON string (json.loads it)."""
        return json.dumps(client.call(method, path, body, query_params))

    globals_dict["secure_endpoint_api_call"] = secure_endpoint_api_call
    globals_dict["secure_endpoint"] = client

    mod = types.ModuleType("secure_endpoint_api")
    mod.secure_endpoint_api_call = secure_endpoint_api_call  # type: ignore[attr-defined]
    mod.client = client  # type: ignore[attr-defined]
    sys.modules["secure_endpoint_api"] = mod

    return client


def test_connection(config: Dict[str, Any]) -> Dict[str, Any]:
    """Test a Secure Endpoint connection without saving. Returns {ok, message}."""
    client_id = (config.get("client_id") or "").strip()
    api_key = config.get("api_key") or ""
    if not client_id or not api_key:
        return {"ok": False, "message": "Client ID and API Key are required."}

    client = SecureEndpointClient(config)
    result = client.call("GET", "/v1/version")
    status = result.get("status_code") or 0
    if status == 401:
        return {"ok": False, "message": "Authentication failed. Check Client ID / API Key."}
    if status == 0 and result.get("error"):
        return {"ok": False, "message": result["error"]}
    if status >= 400:
        return {"ok": False, "message": f"HTTP {status} from Secure Endpoint."}
    host = _region_host(config.get("region"))
    return {"ok": True, "message": f"Connected to Secure Endpoint at {host}."}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd sidecar && .venv/bin/python -m pytest src/ccie_sidecar/test_secure_endpoint.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/ccie_sidecar/secure_endpoint.py sidecar/src/ccie_sidecar/test_secure_endpoint.py
git commit -m "feat(secure-endpoint): add shared SecureEndpointClient + blast radius

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Config reader `secure_endpoint_config.py` (Python)

**Files:**
- Create: `sidecar/src/ccie_sidecar/secure_endpoint_config.py`
- Test: append to `sidecar/src/ccie_sidecar/test_secure_endpoint.py`

**Interfaces:**
- Consumes: nothing (mirrors `ise_config.py`).
- Produces: `get_secure_endpoint_config() -> dict | None` with keys `region, auth_mode, client_id, api_key, verify_ssl`. Reads `sessions.db.secure_endpoint_config` (id=1); falls back to `SECURE_ENDPOINT_*` env vars; returns `None` when unset.

- [ ] **Step 1: Write the failing test**

Append to `sidecar/src/ccie_sidecar/test_secure_endpoint.py`:

```python
def test_config_from_env(monkeypatch):
    from ccie_sidecar import secure_endpoint_config as cfgmod
    # Force the DB path to a nonexistent file so it falls back to env.
    monkeypatch.setattr(cfgmod, "_db_path", lambda: __import__("pathlib").Path("/nonexistent/se.db"))
    monkeypatch.setenv("SECURE_ENDPOINT_REGION", "eu")
    monkeypatch.setenv("SECURE_ENDPOINT_AUTH_MODE", "v1_basic")
    monkeypatch.setenv("SECURE_ENDPOINT_CLIENT_ID", "cid")
    monkeypatch.setenv("SECURE_ENDPOINT_API_KEY", "key")
    monkeypatch.setenv("SECURE_ENDPOINT_VERIFY_SSL", "1")
    cfg = cfgmod.get_secure_endpoint_config()
    assert cfg == {
        "region": "eu", "auth_mode": "v1_basic",
        "client_id": "cid", "api_key": "key", "verify_ssl": True,
    }


def test_config_none_when_unset(monkeypatch):
    from ccie_sidecar import secure_endpoint_config as cfgmod
    monkeypatch.setattr(cfgmod, "_db_path", lambda: __import__("pathlib").Path("/nonexistent/se.db"))
    monkeypatch.delenv("SECURE_ENDPOINT_CLIENT_ID", raising=False)
    monkeypatch.delenv("SECURE_ENDPOINT_REGION", raising=False)
    assert cfgmod.get_secure_endpoint_config() is None
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd sidecar && .venv/bin/python -m pytest src/ccie_sidecar/test_secure_endpoint.py::test_config_from_env -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'ccie_sidecar.secure_endpoint_config'`.

- [ ] **Step 3: Write the implementation**

Create `sidecar/src/ccie_sidecar/secure_endpoint_config.py`:

```python
"""Read Cisco Secure Endpoint connection details from the app config DB.

Mirrors ccie_sidecar.ise_config: the connection lives in the same sessions.db the
LLM api_key uses (NOT the encrypted vault), so it is readable by every sandbox
agent with no per-agent attachment and no lock/unlock step.
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from typing import Any


def _db_path() -> Path:
    if os.name == "nt":
        config_dir = Path(os.environ.get("APPDATA", "")) / "ccie-terminal"
    elif os.uname().sysname == "Darwin":
        config_dir = Path.home() / "Library" / "Application Support" / "ccie-terminal"
    else:
        config_dir = Path.home() / ".config" / "ccie-terminal"
    return config_dir / "sessions.db"


def _from_env() -> dict[str, Any] | None:
    client_id = os.environ.get("SECURE_ENDPOINT_CLIENT_ID")
    if not client_id:
        return None
    return {
        "region": os.environ.get("SECURE_ENDPOINT_REGION", "nam"),
        "auth_mode": os.environ.get("SECURE_ENDPOINT_AUTH_MODE", "v1_basic"),
        "client_id": client_id,
        "api_key": os.environ.get("SECURE_ENDPOINT_API_KEY", ""),
        "verify_ssl": os.environ.get("SECURE_ENDPOINT_VERIFY_SSL", "1").lower()
        in ("1", "true", "yes"),
    }


def get_secure_endpoint_config() -> dict[str, Any] | None:
    """Return the saved Secure Endpoint connection dict, or None if unset.

    Reads sessions.db.secure_endpoint_config first; falls back to
    SECURE_ENDPOINT_* env vars (how the MCP-server transport delivers them).
    """
    db = _db_path()
    try:
        if db.exists():
            conn = sqlite3.connect(str(db))
            try:
                cur = conn.cursor()
                cur.execute(
                    "SELECT region, auth_mode, client_id, api_key, verify_ssl "
                    "FROM secure_endpoint_config WHERE id = 1"
                )
                row = cur.fetchone()
            finally:
                conn.close()
            if row and row[2]:  # client_id present
                return {
                    "region": row[0] or "nam",
                    "auth_mode": row[1] or "v1_basic",
                    "client_id": row[2],
                    "api_key": row[3] or "",
                    "verify_ssl": bool(row[4]),
                }
    except Exception:
        pass
    return _from_env()
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd sidecar && .venv/bin/python -m pytest src/ccie_sidecar/test_secure_endpoint.py -v`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/ccie_sidecar/secure_endpoint_config.py sidecar/src/ccie_sidecar/test_secure_endpoint.py
git commit -m "feat(secure-endpoint): add sessions.db config reader

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: MCP server `secure_endpoint_mcp.py` (Python)

**Files:**
- Create: `sidecar/src/ccie_sidecar/mcp_servers/secure_endpoint_mcp.py`
- Test: `sidecar/src/ccie_sidecar/mcp_servers/test_secure_endpoint_mcp.py`

**Interfaces:**
- Consumes: `SecureEndpointClient`, `_blast_radius` from Task 1.
- Produces: `get_tool_description() -> str`, `handle_request(request: dict) -> dict` (JSON-RPC: `initialize`, `tools/list`, `tools/call`), `main()` stdin loop. Tool name `secure_endpoint_api_call`.

- [ ] **Step 1: Write the failing test**

Create `sidecar/src/ccie_sidecar/mcp_servers/test_secure_endpoint_mcp.py`:

```python
from ccie_sidecar.mcp_servers import secure_endpoint_mcp as srv


def test_initialize():
    resp = srv.handle_request({"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    assert resp["result"]["serverInfo"]["name"] == "secure-endpoint-mcp"


def test_tools_list_exposes_single_tool():
    resp = srv.handle_request({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    tools = resp["result"]["tools"]
    assert len(tools) == 1
    t = tools[0]
    assert t["name"] == "secure_endpoint_api_call"
    props = t["inputSchema"]["properties"]
    assert set(["method", "path", "body", "query_params"]).issubset(props.keys())
    assert t["inputSchema"]["required"] == ["method", "path"]
    # The description must teach the model the envelope + key paths.
    assert "/v1/computers" in t["description"]
    assert "isolation" in t["description"]


def test_tools_call_unknown_tool_errors():
    resp = srv.handle_request({
        "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": {"name": "nope", "arguments": {}},
    })
    assert resp["error"]["code"] == -32602


def test_tools_call_missing_args_errors():
    resp = srv.handle_request({
        "jsonrpc": "2.0", "id": 4, "method": "tools/call",
        "params": {"name": "secure_endpoint_api_call", "arguments": {"method": "GET"}},
    })
    assert resp["error"]["code"] == -32602
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd sidecar && .venv/bin/python -m pytest src/ccie_sidecar/mcp_servers/test_secure_endpoint_mcp.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Write the implementation**

Create `sidecar/src/ccie_sidecar/mcp_servers/secure_endpoint_mcp.py`:

```python
#!/usr/bin/env python3
"""Cisco Secure Endpoint (AMP for Endpoints) MCP Server.

Implements Model Context Protocol (JSON-RPC 2.0) to expose the Secure Endpoint
REST API as a single unified tool. The single `secure_endpoint_api_call` tool
hits one regional host; v1 uses Basic auth, v3 uses an OAuth bearer (set in
Settings). Auth + host live in the shared SecureEndpointClient so the MCP server
and the in-sandbox helper can't drift.
"""

import json
import os
import sys
from typing import Dict, Any, Optional

from ccie_sidecar.secure_endpoint import SecureEndpointClient, _blast_radius

_client: Optional[SecureEndpointClient] = None


def get_blast_radius(method: str, path: str) -> str:
    return _blast_radius(method, path)


def _get_client() -> SecureEndpointClient:
    global _client
    if _client is None:
        _client = SecureEndpointClient({
            "region": os.environ.get("SECURE_ENDPOINT_REGION", "nam"),
            "auth_mode": os.environ.get("SECURE_ENDPOINT_AUTH_MODE", "v1_basic"),
            "client_id": os.environ.get("SECURE_ENDPOINT_CLIENT_ID", ""),
            "api_key": os.environ.get("SECURE_ENDPOINT_API_KEY", ""),
            "verify_ssl": os.environ.get("SECURE_ENDPOINT_VERIFY_SSL", "1") == "1",
        })
    return _client


def call_api(method: str, path: str, body: Optional[Dict] = None,
             query_params: Optional[Dict] = None) -> Dict[str, Any]:
    return _get_client().call(method, path, body, query_params)


def get_tool_description() -> str:
    return """Call the Cisco Secure Endpoint (AMP for Endpoints) REST API.

ONE TOOL: secure_endpoint_api_call(method, path, body=None, query_params=None)
Host + auth are resolved from Settings; you supply only method + path (+ body/query).
Responses: {"status_code", "data", "error", "blast_radius"} - check status_code < 400.

API VERSION: v1 (Basic auth, default) or v3 (OAuth bearer) - set in Settings.
Paths below are v1. The v1 response envelope is {"version","metadata","data"};
the rows you want are under "data". Page with query_params {"limit":N,"offset":M}
(limit max 500). metadata.results.total gives the full count.

BLAST RADIUS (metadata only, never blocks): GET=low, POST/PUT/PATCH=medium, DELETE=destructive.

ENDPOINTS (v1):

COMPUTERS (endpoints):
  GET /v1/computers                          List computers (low)
    Filters: query_params {"hostname[]":"foo","group_guid[]":"...","internal_ip":"..."}
  GET /v1/computers/{guid}                   Computer detail (low)
  GET /v1/computers/{guid}/trajectory        File/network activity timeline (low)
  GET /v1/computers/{guid}/activity          Recent activity (low)
  GET /v1/computers/activity                 Find computers by activity; query_params {"q":"<ip|hostname|url>"} (low)

ISOLATION (network quarantine of a host):
  GET    /v1/computers/{guid}/isolation      Isolation status (low)
  PUT    /v1/computers/{guid}/isolation      Start isolation (medium); body {"comment":"reason"}
  DELETE /v1/computers/{guid}/isolation      Stop isolation (destructive)

EVENTS:
  GET /v1/events                             List events (low)
    Filters: query_params {"detection_id[]":"","event_type[]":"","group_guid[]":"","start_date":"ISO8601"}
  GET /v1/event_types                        Event type catalog (low)

GROUPS & POLICIES:
  GET   /v1/groups                           List groups (low)
  GET   /v1/groups/{guid}                     Group detail (low)
  PATCH /v1/groups/{guid}                     Reassign group policy (medium)
  GET   /v1/policies                          List policies (low)
  GET   /v1/policies/{guid}                   Policy detail (low)

MOVE A COMPUTER TO A GROUP:
  PATCH /v1/computers/{guid}                  body {"group_guid":"<dest-group-guid>"} (medium)

VULNERABILITIES:
  GET /v1/vulnerabilities                    Hosts with vulnerable apps (low)
  GET /v1/computers/{guid}/vulnerabilities   Per-host vulns (low)

FILE LISTS (allow/block lists):
  GET    /v1/file_lists                      List file lists (low)
  GET    /v1/file_lists/{guid}/files         Items in a list (low)
  POST   /v1/file_lists/{guid}/files/{sha256} Add SHA256 (medium)
  DELETE /v1/file_lists/{guid}/files/{sha256} Remove SHA256 (destructive)

SANITY:
  GET /v1/version                            API version (low)

NOTES:
- connector_guid identifies a computer; group_guid/policy_guid identify groups/policies.
- Dates are ISO-8601, times UTC. Find a host's guid via GET /v1/computers first.
- v3 paths differ (/v3/organizations/{org}/...); prefer v1 unless told otherwise.
- Responses are {"status_code","data","error","blast_radius"}; check status_code < 400.
"""


def handle_request(request: Dict[str, Any]) -> Dict[str, Any]:
    method = request.get("method")
    req_id = request.get("id")
    params = request.get("params", {})

    if method == "initialize":
        return {"jsonrpc": "2.0", "id": req_id, "result": {
            "protocolVersion": "2024-11-05",
            "serverInfo": {"name": "secure-endpoint-mcp", "version": "1.0.0"},
            "capabilities": {"tools": {}},
        }}

    elif method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": [{
            "name": "secure_endpoint_api_call",
            "description": get_tool_description(),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "method": {"type": "string",
                               "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"],
                               "description": "HTTP method"},
                    "path": {"type": "string",
                             "description": "API endpoint path (e.g., '/v1/computers')"},
                    "body": {"type": "object",
                             "description": "Request body for POST/PUT/PATCH (optional)"},
                    "query_params": {"type": "object",
                                     "description": "URL query parameters (optional, e.g. {\"limit\": 100})"},
                },
                "required": ["method", "path"],
            },
        }]}}

    elif method == "tools/call":
        tool_name = params.get("name")
        arguments = params.get("arguments", {})
        if tool_name != "secure_endpoint_api_call":
            return {"jsonrpc": "2.0", "id": req_id,
                    "error": {"code": -32602, "message": f"Unknown tool: {tool_name}"}}
        api_method = arguments.get("method")
        api_path = arguments.get("path")
        api_body = arguments.get("body")
        api_query = arguments.get("query_params")
        if not api_method or not api_path:
            return {"jsonrpc": "2.0", "id": req_id,
                    "error": {"code": -32602, "message": "Missing required arguments: method and path"}}
        result = call_api(api_method, api_path, api_body, api_query)
        if result["error"]:
            return {"jsonrpc": "2.0", "id": req_id, "result": {
                "content": [{"type": "text",
                             "text": f"Error: {result['error']}\nStatus: {result['status_code']}"}],
                "blast_radius": get_blast_radius(api_method, api_path),
            }}
        return {"jsonrpc": "2.0", "id": req_id, "result": {
            "content": [{"type": "text", "text": json.dumps(result["data"], indent=2)}],
            "blast_radius": get_blast_radius(api_method, api_path),
        }}

    else:
        return {"jsonrpc": "2.0", "id": req_id,
                "error": {"code": -32601, "message": f"Method not found: {method}"}}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            response = handle_request(request)
            print(json.dumps(response), flush=True)
        except json.JSONDecodeError as e:
            print(json.dumps({"jsonrpc": "2.0", "id": None,
                              "error": {"code": -32700, "message": f"Parse error: {str(e)}"}}), flush=True)
        except Exception as e:
            print(json.dumps({"jsonrpc": "2.0", "id": None,
                              "error": {"code": -32603, "message": f"Internal error: {str(e)}"}}), flush=True)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd sidecar && .venv/bin/python -m pytest src/ccie_sidecar/mcp_servers/test_secure_endpoint_mcp.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/ccie_sidecar/mcp_servers/secure_endpoint_mcp.py sidecar/src/ccie_sidecar/mcp_servers/test_secure_endpoint_mcp.py
git commit -m "feat(secure-endpoint): add single-tool MCP server

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Sidecar RPC + sandbox wiring (Python)

**Files:**
- Modify: `sidecar/src/ccie_sidecar/server.py` (add `secure_endpoint.test_connection` RPC near the `ise.test_connection` branch ~line 587)
- Modify: `sidecar/src/ccie_sidecar/agents/code_exec.py` (add `install_secure_endpoint` dispatch near the `ise` branch ~line 224)
- Modify: `sidecar/src/ccie_sidecar/agents/react_code.py` (add a `secure_endpoint` client-section near the `ise` branch ~line 130)

**Interfaces:**
- Consumes: `test_connection`, `install_secure_endpoint` (Task 1).
- Produces: RPC method `secure_endpoint.test_connection`; sandbox binding when `cli_package == "secure_endpoint"`; `_build_client_section("secure_endpoint", ...)` text.

- [ ] **Step 1: Add the RPC branch**

In `sidecar/src/ccie_sidecar/server.py`, immediately after the `ise.test_connection` branch (the block ending at the `return {"id": req_id, "type": "done", "result": _ise_test(conf)}` near line 593), insert:

```python
    elif method == "secure_endpoint.test_connection":
        # Settings → Secure Endpoint "Test connection" button. Tests the passed-in
        # config with a single read-only GET /v1/version. Never saves, never mutates.
        conf = params.get("config") or {}
        from ccie_sidecar.secure_endpoint import test_connection as _se_test
        return {"id": req_id, "type": "done", "result": _se_test(conf)}
```

- [ ] **Step 2: Add the sandbox install dispatch**

In `sidecar/src/ccie_sidecar/agents/code_exec.py`, immediately after the `ise` install block (the one ending at the `install_ise(globals_dict, emit=emit)` try/except near line 229), insert:

```python
    # Bind the Secure Endpoint client when this is the secure_endpoint agent.
    # Reads creds from sessions.db (same as Settings → Secure Endpoint) and
    # injects the `secure_endpoint_api_call(...)` helper the agent's prompt expects.
    if cli_package == "secure_endpoint":
        try:
            from ccie_sidecar.secure_endpoint import install_secure_endpoint
            install_secure_endpoint(globals_dict, emit=emit)
        except Exception:
            pass
```

- [ ] **Step 3: Add the client-section doc**

In `sidecar/src/ccie_sidecar/agents/react_code.py`, immediately before the `if cli_package == "cml":` branch (after the ISE branch's closing `)` near line 152), insert:

```python
    if cli_package == "secure_endpoint":
        return (
            "- secure_endpoint_api_call(method, path, body=None, query_params=None):\n"
            "  pre-bound function — your ONLY way to reach Cisco Secure Endpoint. Do\n"
            "  NOT use requests, do NOT look for env vars or config files. Secure\n"
            "  Endpoint is already configured and authenticated.\n"
            "  It returns a JSON string; json.loads it. Shape:\n"
            "    {\"status_code\": int, \"data\": <payload>, \"error\": str|None, \"blast_radius\": str}\n"
            "  v1 response envelope is {\"version\",\"metadata\",\"data\"}; rows are under\n"
            "  data['data']. Page with query_params={'limit':100,'offset':0} (limit max 500).\n"
            "  Key paths: /v1/computers (list endpoints), /v1/computers/{guid} (detail),\n"
            "  /v1/computers/{guid}/isolation (GET status, PUT to isolate, DELETE to stop),\n"
            "  /v1/events, /v1/groups, /v1/policies, /v1/vulnerabilities, /v1/file_lists.\n"
            "  Find a host's connector_guid via GET /v1/computers first, then act on it.\n"
            "  To list computers:\n"
            "    import json\n"
            "    r = json.loads(secure_endpoint_api_call('GET', '/v1/computers', query_params={'limit':100}))\n"
            "    for c in r['data']['data']:\n"
            "        print(c['connector_guid'], c.get('hostname'))\n"
            "  Check status_code < 400 / error is None before trusting data. If error\n"
            "  says 'not configured', tell the user to set Settings → Secure Endpoint."
        )
```

- [ ] **Step 4: Verify imports resolve (smoke test)**

Run:
```bash
cd sidecar && .venv/bin/python -c "
from ccie_sidecar.agents.react_code import _build_client_section
s = _build_client_section('secure_endpoint', {}, meraki_client_ready=False)
assert 'secure_endpoint_api_call' in s and '/v1/computers' in s
from ccie_sidecar.agents.code_exec import _build_sandbox_globals
g = _build_sandbox_globals('secure_endpoint', {}, emit=lambda e: None)
assert 'secure_endpoint_api_call' in g
print('OK')
"
```
Expected: prints `OK`.

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/ccie_sidecar/server.py sidecar/src/ccie_sidecar/agents/code_exec.py sidecar/src/ccie_sidecar/agents/react_code.py
git commit -m "feat(secure-endpoint): wire RPC test_connection + sandbox helper binding

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Database migration (SQL)

**Files:**
- Create: `src-tauri/migrations/V0066__secure_endpoint_config.sql`

**Interfaces:**
- Produces: singleton table `secure_endpoint_config(id, region, auth_mode, client_id, api_key, verify_ssl)`.

- [ ] **Step 1: Write the migration**

Create `src-tauri/migrations/V0066__secure_endpoint_config.sql`:

```sql
-- Cisco Secure Endpoint (AMP for Endpoints) connection settings (singleton).
-- region selects the regional API host (nam|eu|apjc). auth_mode is v1_basic
-- (HTTP Basic, default) or v3_oauth (OAuth bearer). api_key holds the v1 API key
-- or the v3 client secret. verify_ssl defaults ON: hosts are Cisco-signed.
CREATE TABLE IF NOT EXISTS secure_endpoint_config (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    region      TEXT    NOT NULL DEFAULT 'nam',
    auth_mode   TEXT    NOT NULL DEFAULT 'v1_basic',
    client_id   TEXT    NOT NULL DEFAULT '',
    api_key     TEXT    NOT NULL DEFAULT '',
    verify_ssl  INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_secure_endpoint_config_singleton
ON secure_endpoint_config(id);
```

- [ ] **Step 2: Verify it is the next free number**

Run: `ls src-tauri/migrations/ | sort | tail -3`
Expected: `V0065__splunk_config.sql` is the highest pre-existing; your new `V0066__secure_endpoint_config.sql` follows it. If a higher number now exists, rename to the next free number and update Task 8's script-path comment accordingly.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/migrations/V0066__secure_endpoint_config.sql
git commit -m "feat(secure-endpoint): add V0066 config migration

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Tauri commands + MCP auto-registration (Rust)

**Files:**
- Modify: `src-tauri/src/commands/mod.rs` (add struct + 3 commands + `enable_secure_endpoint_mcp_server` after the ISE block, ~line 5099)
- Modify: `src-tauri/src/lib.rs` (register 3 commands in the invoke handler, after `commands::ise_test_connection` ~line 372)

**Interfaces:**
- Consumes: `sidecar_spawn_target()`, `AppState`, `state.agent.call("secure_endpoint.test_connection", ...)` (Task 4).
- Produces: commands `secure_endpoint_get_config`, `secure_endpoint_save_config`, `secure_endpoint_test_connection`; struct `SecureEndpointConfig { region, auth_mode, client_id, api_key, verify_ssl }` (camelCase serde); `SecureEndpointTestResult { ok, message }`.

- [ ] **Step 1: Add the Rust commands**

In `src-tauri/src/commands/mod.rs`, after the `ise_test_connection` function (ends ~line 5099, before the `// ---- Cisco Modeling Labs (CML) Configuration` comment), insert:

```rust
// ---- Cisco Secure Endpoint Configuration --------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureEndpointConfig {
    pub region: String,
    pub auth_mode: String,
    pub client_id: String,
    pub api_key: String,
    pub verify_ssl: bool,
}

#[tauri::command]
pub async fn secure_endpoint_get_config(
    state: State<'_, AppState>,
) -> Result<Option<SecureEndpointConfig>, String> {
    let conn = state.db.lock();
    let result: Option<SecureEndpointConfig> = conn
        .query_row(
            "SELECT region, auth_mode, client_id, api_key, verify_ssl FROM secure_endpoint_config WHERE id = 1",
            [],
            |row| Ok(SecureEndpointConfig {
                region: row.get(0)?,
                auth_mode: row.get(1)?,
                client_id: row.get(2)?,
                api_key: row.get(3)?,
                verify_ssl: row.get::<_, i64>(4)? == 1,
            }),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(result)
}

/// Register the Secure Endpoint MCP server in the `mcp_servers` table.
/// Credentials are passed via environment variables so the Python script can
/// access them without storing them in the command JSON.
fn enable_secure_endpoint_mcp_server(
    db: &Arc<Mutex<rusqlite::Connection>>,
    config: &SecureEndpointConfig,
) -> Result<(), String> {
    let (python, _) = sidecar_spawn_target();
    let repo_root = std::env::var("CCIE_REPO_ROOT").unwrap_or_else(|_| {
        std::env::current_dir().unwrap().to_string_lossy().to_string()
    });
    let mcp_script_path = format!(
        "{}/sidecar/src/ccie_sidecar/mcp_servers/secure_endpoint_mcp.py",
        repo_root
    );

    let command_json = serde_json::json!({ "cmd": python, "args": [mcp_script_path] });
    let env_json = serde_json::json!({
        "SECURE_ENDPOINT_REGION": config.region,
        "SECURE_ENDPOINT_AUTH_MODE": config.auth_mode,
        "SECURE_ENDPOINT_CLIENT_ID": config.client_id,
        "SECURE_ENDPOINT_API_KEY": config.api_key,
        "SECURE_ENDPOINT_VERIFY_SSL": if config.verify_ssl { "1" } else { "0" },
    });

    let conn = db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO mcp_servers (id, name, transport, command_json, url, env_json, enabled)
         VALUES ('secure-endpoint-mcp', 'Cisco Secure Endpoint', 'stdio', ?1, NULL, ?2, 1)",
        rusqlite::params![
            serde_json::to_string(&command_json).unwrap(),
            serde_json::to_string(&env_json).unwrap(),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn secure_endpoint_save_config(
    state: State<'_, AppState>,
    config: SecureEndpointConfig,
) -> Result<(), String> {
    {
        let conn = state.db.lock();
        conn.execute(
            "INSERT OR REPLACE INTO secure_endpoint_config (id, region, auth_mode, client_id, api_key, verify_ssl)
             VALUES (1, ?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                config.region,
                config.auth_mode,
                config.client_id,
                config.api_key,
                if config.verify_ssl { 1 } else { 0 },
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    enable_secure_endpoint_mcp_server(&state.db, &config)?;
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SecureEndpointTestResult {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub async fn secure_endpoint_test_connection(
    state: State<'_, AppState>,
    config: SecureEndpointConfig,
) -> Result<SecureEndpointTestResult, String> {
    let params = serde_json::json!({
        "config": {
            "region": config.region,
            "auth_mode": config.auth_mode,
            "client_id": config.client_id,
            "api_key": config.api_key,
            "verify_ssl": config.verify_ssl,
        }
    });
    let resp = state
        .agent
        .call("secure_endpoint.test_connection", params)
        .await
        .map_err(|e| e.to_string())?;
    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => Ok(SecureEndpointTestResult {
            ok: result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
            message: result
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
                .to_string(),
        }),
        _ => Err("Unexpected response from sidecar".to_string()),
    }
}
```

- [ ] **Step 2: Register the commands in the invoke handler**

In `src-tauri/src/lib.rs`, after the line `commands::ise_test_connection,` (~line 372), add:

```rust
            commands::secure_endpoint_get_config,
            commands::secure_endpoint_save_config,
            commands::secure_endpoint_test_connection,
```

- [ ] **Step 3: Build to verify it compiles**

Run: `cd src-tauri && cargo build 2>&1 | tail -20`
Expected: build succeeds (warnings OK, no errors). If `Arc`/`Mutex`/`optional` are unresolved, confirm the ISE block above uses the same imports (it does — they are already in scope in this file).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(secure-endpoint): add Tauri config commands + MCP auto-registration

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Frontend bindings + Settings tab (TypeScript/React)

**Files:**
- Modify: the Tauri-invoke bindings module that exports `iseGetConfig`/`iseSaveConfig`/`iseTestConnection` (find with grep in Step 1)
- Create: `src/components/settings/SecureEndpointSettingsTab.tsx`
- Modify: `src/windows/Settings.tsx` (activeTab union, menu item, render branch)

**Interfaces:**
- Consumes: Tauri commands from Task 6.
- Produces: `secureEndpointGetConfig()`, `secureEndpointSaveConfig(cfg)`, `secureEndpointTestConnection(cfg)`; `<SecureEndpointSettingsTab />`; `"secure_endpoint"` tab.

- [ ] **Step 1: Find the bindings module and the ISE settings tab for reference**

Run:
```bash
cd "/Users/shaunwhi/CCIE Terminal"
grep -rln "export async function iseGetConfig\|export const iseGetConfig\|iseGetConfig" src/ --include=*.ts --include=*.tsx | grep -iv settingstab
cat src/components/settings/IseSettingsTab.tsx
```
Note the exact file that defines `iseGetConfig` (the invoke wrapper) and the import path the ISE tab uses. Mirror both exactly.

- [ ] **Step 2: Add the invoke bindings**

In the same module that defines `iseGetConfig` etc., add (matching its existing style — `invoke` import and camelCase command names map to the Rust snake_case commands automatically via Tauri):

```typescript
export type SecureEndpointConfig = {
  region: string;        // "nam" | "eu" | "apjc"
  authMode: string;      // "v1_basic" | "v3_oauth"
  clientId: string;
  apiKey: string;
  verifySsl: boolean;
};

export type SecureEndpointTestResult = { ok: boolean; message: string };

export async function secureEndpointGetConfig(): Promise<SecureEndpointConfig | null> {
  return await invoke("secure_endpoint_get_config");
}

export async function secureEndpointSaveConfig(config: SecureEndpointConfig): Promise<void> {
  await invoke("secure_endpoint_save_config", { config });
}

export async function secureEndpointTestConnection(
  config: SecureEndpointConfig,
): Promise<SecureEndpointTestResult> {
  return await invoke("secure_endpoint_test_connection", { config });
}
```

> NOTE: Tauri maps the camelCase `SecureEndpointConfig` fields to the Rust struct's `#[serde(rename_all = "camelCase")]` fields, so `region/authMode/clientId/apiKey/verifySsl` line up. If the existing ISE binding wraps args differently (e.g. positional), match that exact convention instead.

- [ ] **Step 3: Create the Settings tab**

Create `src/components/settings/SecureEndpointSettingsTab.tsx` (mirror the structure/classNames of `IseSettingsTab.tsx` — reuse its CSS classes so styling is consistent):

```tsx
import { useEffect, useState } from "react";
import {
  secureEndpointGetConfig,
  secureEndpointSaveConfig,
  secureEndpointTestConnection,
  type SecureEndpointConfig,
} from "../../lib/tauri"; // <-- replace with the exact path found in Step 1

type Status = { kind: "ok" | "err" | "idle"; text: string };

export default function SecureEndpointSettingsTab() {
  const [cfg, setCfg] = useState<SecureEndpointConfig>({
    region: "nam",
    authMode: "v1_basic",
    clientId: "",
    apiKey: "",
    verifySsl: true,
  });
  const [status, setStatus] = useState<Status>({ kind: "idle", text: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    secureEndpointGetConfig().then((c) => {
      if (c) setCfg(c);
    });
  }, []);

  const test = async () => {
    setBusy(true);
    setStatus({ kind: "idle", text: "Testing…" });
    try {
      const res = await secureEndpointTestConnection(cfg);
      setStatus({ kind: res.ok ? "ok" : "err", text: res.message });
    } catch (e) {
      setStatus({ kind: "err", text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      await secureEndpointSaveConfig(cfg);
      setStatus({ kind: "ok", text: "Configuration saved." });
    } catch (e) {
      setStatus({ kind: "err", text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const keyLabel = cfg.authMode === "v3_oauth" ? "Client Secret" : "API Key";

  return (
    <div className="ise-tab">
      <div className="ise-header">
        <h2>Cisco Secure Endpoint</h2>
        <p>
          Configure connection to Cisco Secure Endpoint (AMP for Endpoints) for
          endpoint detection, host isolation, groups, policies, events,
          vulnerabilities, and file lists.
        </p>
      </div>

      <div className="ise-section">
        <h3>Region & API</h3>
        <label>Region</label>
        <select
          value={cfg.region}
          onChange={(e) => setCfg({ ...cfg, region: e.target.value })}
        >
          <option value="nam">North America (api.amp.cisco.com)</option>
          <option value="eu">Europe (api.eu.amp.cisco.com)</option>
          <option value="apjc">APJC (api.apjc.amp.cisco.com)</option>
        </select>

        <label>Auth Mode</label>
        <select
          value={cfg.authMode}
          onChange={(e) => setCfg({ ...cfg, authMode: e.target.value })}
        >
          <option value="v1_basic">v1 — Basic auth (recommended)</option>
          <option value="v3_oauth">v3 — OAuth bearer (unverified)</option>
        </select>
      </div>

      <div className="ise-section">
        <h3>Credentials</h3>
        <label>Client ID</label>
        <input
          type="text"
          value={cfg.clientId}
          placeholder="API client ID"
          onChange={(e) => setCfg({ ...cfg, clientId: e.target.value })}
        />
        <label>{keyLabel}</label>
        <input
          type="password"
          value={cfg.apiKey}
          onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })}
        />
      </div>

      <div className="ise-section">
        <h3>TLS</h3>
        <label>
          <input
            type="checkbox"
            checked={cfg.verifySsl}
            onChange={(e) => setCfg({ ...cfg, verifySsl: e.target.checked })}
          />
          Verify SSL certificates
        </label>
      </div>

      <div className="ise-actions">
        <button onClick={save} disabled={busy}>Save</button>
        <button onClick={test} disabled={busy}>Test Connection</button>
      </div>

      {status.kind !== "idle" && (
        <p className={status.kind === "ok" ? "ise-ok" : "ise-err"}>{status.text}</p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire the tab into Settings.tsx**

In `src/windows/Settings.tsx`:
1. Add the import near the other settings-tab imports:
   ```tsx
   import SecureEndpointSettingsTab from "../components/settings/SecureEndpointSettingsTab";
   ```
2. Add `"secure_endpoint"` to the `activeTab` union type (alongside `"ise"`, `"fmc"`, etc.).
3. Add a nav/menu entry next to the ISE one (match the existing menu item markup; label `"Secure Endpoint"`).
4. Add the render branch next to the others:
   ```tsx
   {activeTab === "secure_endpoint" && <SecureEndpointSettingsTab />}
   ```

- [ ] **Step 5: Typecheck / build the frontend**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npm run build 2>&1 | tail -20` (or the project's typecheck script, e.g. `npx tsc --noEmit`).
Expected: no type errors referencing the new file or bindings.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/SecureEndpointSettingsTab.tsx src/windows/Settings.tsx src/lib/tauri.ts
git commit -m "feat(secure-endpoint): add Settings tab + Tauri invoke bindings

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
(Adjust the bindings file path in `git add` to the actual module found in Step 1.)

---

### Task 8: `secure-endpoint` agent (bundled agent)

**Files:**
- Create: `bundled-agents/secure-endpoint/AGENT.md`
- Create: `bundled-agents/secure-endpoint/tools.json`

**Interfaces:**
- Consumes: the `secure_endpoint_api_call` sandbox helper (Task 4) + MCP tool (Task 3).
- Produces: a loadable agent with id `secure-endpoint`.

- [ ] **Step 1: Create the agent definition**

Create `bundled-agents/secure-endpoint/AGENT.md`:

```markdown
---
name: secure-endpoint
description: Cisco Secure Endpoint (AMP) expert - inspect endpoints, isolate hosts, review security events, manage groups/policies, vulnerabilities, and file lists
system-prompt: |
  You are a Cisco Secure Endpoint (AMP for Endpoints) expert. You inspect
  protected endpoints, isolate/un-isolate hosts from the network, review security
  events and detections, manage groups and policies, audit vulnerabilities, and
  maintain allow/block file lists.

  TOOL USAGE:
  `secure_endpoint_api_call(method, path, body=None, query_params=None)` is a
  Python function already available in your sandbox (do NOT import it, do NOT use
  requests directly). Parameters:
  - method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  - path: API endpoint path (e.g., "/v1/computers")
  - body: Optional JSON body for POST/PUT/PATCH (as dict)
  - query_params: Optional URL query parameters (as dict)

  RETURN VALUE:
  It returns a JSON *string*. Always `json.loads(result)` it. The parsed object is:
    {"status_code": int, "data": <API payload or text>, "error": str|None, "blast_radius": str}
  Check `status_code < 400` / `error is None` before trusting `data`.

  V1 ENVELOPE & PAGING (READ THIS — do not guess):
  v1 responses wrap rows under data["data"], with totals under
  data["metadata"]["results"]["total"]. Page with
  query_params={"limit": 100, "offset": 0} (limit max 500). Times are UTC,
  dates ISO-8601.

  IDENTIFIERS:
  - connector_guid identifies a computer/endpoint.
  - group_guid / policy_guid identify groups / policies.
  Always find a host's connector_guid via GET /v1/computers (optionally filtered)
  BEFORE acting on it.

  COMMON WORKFLOWS:

  List computers and find a host's guid:
  ```python
  import json
  r = json.loads(secure_endpoint_api_call("GET", "/v1/computers", query_params={"limit": 100}))
  for c in r["data"]["data"]:
      print(c["connector_guid"], c.get("hostname"))
  ```

  Find a computer by hostname:
  ```python
  import json
  r = json.loads(secure_endpoint_api_call(
      "GET", "/v1/computers", query_params={"hostname[]": "WIN-HOST-01"}))
  print(r["data"]["data"])
  ```

  Check and start network isolation of a host:
  ```python
  import json
  guid = "<connector_guid>"
  status = json.loads(secure_endpoint_api_call("GET", f"/v1/computers/{guid}/isolation"))
  print(status["data"])  # {"available": ..., "status": "not_isolated" | "isolated", ...}
  # Isolate it (network-quarantines the host):
  r = json.loads(secure_endpoint_api_call(
      "PUT", f"/v1/computers/{guid}/isolation", body={"comment": "IR: suspected compromise"}))
  print(r["status_code"], r["data"])
  ```

  Stop isolation:
  ```python
  import json
  guid = "<connector_guid>"
  r = json.loads(secure_endpoint_api_call("DELETE", f"/v1/computers/{guid}/isolation"))
  print(r["status_code"], r["data"])
  ```

  Recent security events:
  ```python
  import json
  r = json.loads(secure_endpoint_api_call("GET", "/v1/events", query_params={"limit": 50}))
  for e in r["data"]["data"]:
      print(e.get("date"), e.get("event_type"), e.get("computer", {}).get("hostname"))
  ```

  Move a computer to a different group:
  ```python
  import json
  guid = "<connector_guid>"
  r = json.loads(secure_endpoint_api_call(
      "PATCH", f"/v1/computers/{guid}", body={"group_guid": "<dest-group-guid>"}))
  print(r["status_code"])
  ```

  BLAST RADIUS AWARENESS (metadata only — calls are NOT gated here):
  - GET = low, POST/PUT/PATCH = medium (includes isolation), DELETE = destructive.
  Isolation network-quarantines a live host — state plainly what you are about to
  do before doing it, but you do not need approval to proceed.

  ANTI-FLAILING RULE:
  If a path 404s it is the wrong shape — consult the catalog in the tool
  description; do not brute-force singular/plural names. A 401 means the
  credentials are wrong; tell the user to set Settings → Secure Endpoint.

  Before EVERY secure_endpoint_api_call, write 1-2 sentences explaining what you
  are about to query and why.

execution-mode: react-code

attached-tools:
  - id: secure-endpoint
    catalog: tools.json
    default-blast-radius-allowed: destructive

allowed-commands: []
---

# Cisco Secure Endpoint Agent

Operates Cisco Secure Endpoint (AMP for Endpoints) through a single
`secure_endpoint_api_call` helper covering endpoints, isolation, events, groups,
policies, vulnerabilities, and file lists. All operations run unattended —
isolation is reported but never gated.
```

- [ ] **Step 2: Create the tool catalog**

Create `bundled-agents/secure-endpoint/tools.json`:

```json
[
  {
    "name": "secure_endpoint_api_call",
    "description": "Call the Cisco Secure Endpoint (AMP for Endpoints) REST API. Blast radius: GET=low, POST/PUT/PATCH=medium, DELETE=destructive (metadata only, never blocks). v1 response rows are under data['data']; page with query_params {limit,offset} (limit max 500).",
    "type": "function",
    "function": {
      "name": "secure_endpoint_api_call",
      "description": "Call the Cisco Secure Endpoint (AMP for Endpoints) REST API.\n\nONE regional host; auth resolved from Settings (v1 Basic or v3 OAuth). Supply only method + path (+ body/query). Returns {status_code,data,error,blast_radius}; check status_code < 400.\n\nv1 ENVELOPE: rows under data['data']; totals under data['metadata']['results']['total']. Page with query_params {\"limit\":100,\"offset\":0} (limit max 500).\n\nKEY PATHS (v1):\n  GET    /v1/computers                          List endpoints; filter {\"hostname[]\":\"..\",\"group_guid[]\":\"..\"}\n  GET    /v1/computers/{guid}                   Computer detail\n  GET    /v1/computers/{guid}/trajectory        Activity timeline\n  GET    /v1/computers/{guid}/isolation         Isolation status\n  PUT    /v1/computers/{guid}/isolation         Start isolation; body {\"comment\":\"..\"}\n  DELETE /v1/computers/{guid}/isolation         Stop isolation\n  PATCH  /v1/computers/{guid}                    Move group; body {\"group_guid\":\"..\"}\n  GET    /v1/events                             Security events; filter {\"event_type[]\":\"..\",\"start_date\":\"ISO8601\"}\n  GET    /v1/event_types                        Event type catalog\n  GET    /v1/groups, /v1/groups/{guid}          Groups\n  GET    /v1/policies, /v1/policies/{guid}      Policies\n  GET    /v1/vulnerabilities                    Hosts with vulnerable apps\n  GET    /v1/computers/{guid}/vulnerabilities   Per-host vulns\n  GET    /v1/file_lists, /v1/file_lists/{guid}/files   Allow/block lists\n  POST   /v1/file_lists/{guid}/files/{sha256}   Add SHA256\n  DELETE /v1/file_lists/{guid}/files/{sha256}   Remove SHA256\n  GET    /v1/version                            Sanity check\n\nNOTES: connector_guid identifies a computer; find it via GET /v1/computers first. Dates ISO-8601 UTC.",
      "parameters": {
        "type": "object",
        "properties": {
          "method": {
            "type": "string",
            "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"],
            "description": "HTTP method"
          },
          "path": {
            "type": "string",
            "description": "API endpoint path (e.g., '/v1/computers')"
          },
          "body": {
            "type": "object",
            "description": "Request body for POST/PUT/PATCH (optional)"
          },
          "query_params": {
            "type": "object",
            "description": "URL query parameters as key-value pairs (optional, e.g. {\"limit\": 100})"
          }
        },
        "required": ["method", "path"]
      }
    }
  }
]
```

- [ ] **Step 3: Verify it loads (JSON valid + agent parses)**

Run:
```bash
cd "/Users/shaunwhi/CCIE Terminal"
python3 -c "import json; json.load(open('bundled-agents/secure-endpoint/tools.json')); print('tools.json OK')"
head -5 bundled-agents/secure-endpoint/AGENT.md
```
Expected: prints `tools.json OK` and the AGENT.md frontmatter header.

- [ ] **Step 4: Commit**

```bash
git add bundled-agents/secure-endpoint/AGENT.md bundled-agents/secure-endpoint/tools.json
git commit -m "feat(secure-endpoint): add bundled secure-endpoint agent

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Wire Secure Endpoint into network-architect (Python + agent prompt)

**Files:**
- Modify: `sidecar/src/ccie_sidecar/agents/architect_subagents.py` (add a `VENDOR_SPECS` entry)
- Modify: `bundled-agents/network-architect/AGENT.md` (routing matrix line)
- Test: `sidecar/src/ccie_sidecar/test_architect_secure_endpoint.py`

**Interfaces:**
- Consumes: `_cfg`, `VENDOR_SPECS`, `build_vendor_subagents`, `build_architect_direct_tool` (existing); `_build_client_section("secure_endpoint", ...)` (Task 4); `get_secure_endpoint_config` (Task 2).
- Produces: a `secure-endpoint-specialist` subagent + the `secure_endpoint` client bound in the architect's flattened sandbox whenever Secure Endpoint is configured.

- [ ] **Step 1: Write the failing test**

Create `sidecar/src/ccie_sidecar/test_architect_secure_endpoint.py`:

```python
from ccie_sidecar.agents.architect_subagents import (
    VENDOR_SPECS,
    build_vendor_subagents,
    build_architect_direct_tool,
)


def test_secure_endpoint_in_vendor_specs():
    ids = [s["id"] for s in VENDOR_SPECS]
    assert "secure_endpoint" in ids
    spec = next(s for s in VENDOR_SPECS if s["id"] == "secure_endpoint")
    assert "isolat" in spec["when"].lower() or "endpoint" in spec["when"].lower()


def test_secure_endpoint_specialist_built_when_included():
    # include_unconfigured=True forces every vendor's subagent to be built.
    subs = build_vendor_subagents(include_unconfigured=True)
    names = [s.name for s in subs]
    assert "secure_endpoint-specialist" in names


def test_architect_direct_tool_documents_secure_endpoint():
    tool, ids = build_architect_direct_tool(include_unconfigured=True)
    assert "secure_endpoint" in ids
    assert "secure_endpoint_api_call" in tool.description
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd sidecar && .venv/bin/python -m pytest src/ccie_sidecar/test_architect_secure_endpoint.py -v`
Expected: FAIL — `secure_endpoint` not in `VENDOR_SPECS`.

- [ ] **Step 3: Add the vendor spec**

In `sidecar/src/ccie_sidecar/agents/architect_subagents.py`, add this entry to the `VENDOR_SPECS` list (place it right after the `ise` entry, before `stealthwatch`):

```python
    {
        "id": "secure_endpoint",
        "display": "Cisco Secure Endpoint (AMP)",
        "when": "endpoint detection & response: protected endpoints/computers, "
                "isolating or un-isolating a host from the network, security events "
                "and detections, endpoint groups/policies, vulnerabilities, or "
                "allow/block file lists in Secure Endpoint (AMP).",
        "configured": lambda: _cfg("ccie_sidecar.secure_endpoint_config", "get_secure_endpoint_config"),
    },
```

> The architect's flattened sandbox (`build_architect_direct_tool`) and per-vendor specialists (`build_vendor_subagents`) both iterate `VENDOR_SPECS` and call `_build_sandbox_globals(spec["id"], ...)` / `_build_client_section(spec["id"], ...)`. Tasks 4 already taught both of those about `cli_package == "secure_endpoint"`, so this single entry lights up both paths.

- [ ] **Step 4: Run to verify it passes**

Run: `cd sidecar && .venv/bin/python -m pytest src/ccie_sidecar/test_architect_secure_endpoint.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Update the network-architect prompt**

In `bundled-agents/network-architect/AGENT.md`:
1. In the `ROUTING MATRIX` section of the `system-prompt`, add this line right after the ISE entry:
   ```
     - Endpoint detection & response / host isolation / malware detections /
       EDR telemetry / endpoint groups & policies      -> secure_endpoint-specialist
   ```
2. In the `description:` frontmatter line, add `Secure Endpoint` to the parenthesized platform list (e.g. `... ISE, Secure Endpoint, Stealthwatch, ...`).

- [ ] **Step 6: Commit**

```bash
git add sidecar/src/ccie_sidecar/agents/architect_subagents.py bundled-agents/network-architect/AGENT.md sidecar/src/ccie_sidecar/test_architect_secure_endpoint.py
git commit -m "feat(secure-endpoint): wire into network-architect routing + flattened sandbox

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Full-suite regression + manual smoke

**Files:** none (verification only).

- [ ] **Step 1: Run the Python sidecar test suite**

Run: `cd sidecar && .venv/bin/python -m pytest src/ccie_sidecar/test_secure_endpoint.py src/ccie_sidecar/mcp_servers/test_secure_endpoint_mcp.py src/ccie_sidecar/test_architect_secure_endpoint.py -v`
Expected: all PASS (14 tests total).

- [ ] **Step 2: Confirm no regressions in the broader sidecar agent tests**

Run: `cd sidecar && .venv/bin/python -m pytest src/ccie_sidecar/test_fmc.py src/ccie_sidecar/agents -q 2>&1 | tail -15`
Expected: no new failures introduced by the react_code/code_exec edits.

- [ ] **Step 3: Rust build**

Run: `cd src-tauri && cargo build 2>&1 | tail -10`
Expected: compiles.

- [ ] **Step 4: Frontend build**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npm run build 2>&1 | tail -10`
Expected: builds without type errors.

- [ ] **Step 5: Manual smoke (operator, requires real credentials)**

Document for the operator (do not block the plan on live hardware):
1. Launch the app (`CCIE_REPO_ROOT` set), open Settings → Secure Endpoint.
2. Enter region + Client ID + API Key, click **Test Connection** → expect `Connected to Secure Endpoint at api.amp.cisco.com.`
3. Click **Save** → confirm an `mcp_servers` row `secure-endpoint-mcp` exists (enabled=1) and `secure_endpoint_config` has the row.
4. Run the `secure-endpoint` agent: "List the first 5 computers" → expect real hostnames + connector_guids.
5. Ask network-architect: "Is host X isolated in Secure Endpoint?" → expect it to route to the secure_endpoint path and answer from live data.

- [ ] **Step 6: Final commit (if any doc/notes updated)**

```bash
git add -A
git commit -m "test(secure-endpoint): full-suite regression pass

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- Shared client + auth strategy (v1 + v3-ready) → Task 1 ✓
- Config schema / sessions.db reader → Tasks 2, 5 ✓
- Single-tool MCP server + tool description/catalog → Task 3 ✓
- RPC test_connection + sandbox helper binding + client-section → Task 4 ✓
- Tauri commands + MCP auto-registration → Task 6 ✓
- Settings tab + bindings (region, auth mode, client_id, api_key, verify_ssl default true) → Task 7 ✓
- `secure-endpoint` agent + tools.json → Task 8 ✓
- network-architect access + prompt (when/how) → Task 9 ✓
- Blast radius metadata, never blocks; isolation freely callable → Tasks 1, 3, 8 ✓
- Region→host mapping; test_connection via GET /v1/version → Tasks 1, 3 ✓
- Testing (mocked requests, no live calls in CI); v3 smoke only → Tasks 1, 10 ✓

**Placeholder scan:** No TBD/TODO. Two intentional "find exact path" steps (Task 7 Step 1 for the invoke-bindings module, Task 5 Step 2 for migration number) — these are verification steps with explicit grep commands, not deferred work.

**Type consistency:** Tool name `secure_endpoint_api_call`, MCP id `secure-endpoint-mcp`, agent id `secure-endpoint`, config keys `region/auth_mode/client_id/api_key/verify_ssl` (Rust camelCase `region/authMode/clientId/apiKey/verifySsl`), envelope `{status_code,data,error,blast_radius}` — all consistent across Tasks 1–9. `_region_host`, `_blast_radius`, `install_secure_endpoint`, `test_connection`, `get_secure_endpoint_config` signatures match between definition (Tasks 1–2) and use (Tasks 3, 4, 9).
```
