# CML (Cisco Modeling Labs) Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Cisco Modeling Labs (CML) integration — single-tool MCP server + bundled agent + Settings credential pane — mirroring the existing ISE and Stealthwatch integrations exactly.

**Architecture:** A shared `CmlClient` (Python) handles Bearer-JWT auth against `https://<host>/api/v0` and is used by both the stdio MCP server (`cml_mcp.py`, creds via env vars) and the in-sandbox `cml_api_call` helper (creds via sessions.db). Rust persists credentials in a singleton `cml_config` table and auto-registers the MCP server on save. A React `CmlSettingsTab` collects host/username/password/verifySsl.

**Tech Stack:** Python (`requests`), Rust (Tauri + rusqlite), TypeScript/React, SQLite migrations, JSON-RPC 2.0 over stdio.

## Global Constraints

- **Auth:** CML uses Bearer JWT. `POST /api/v0/authenticate {username, password}` returns a bare JWT string. Send `Authorization: Bearer <jwt>` on every subsequent call. Re-authenticate ONCE transparently on a 401, then retry; if re-auth fails, return the error.
- **Single base URL:** `https://<host>/api/v0`. No port/surface inference (unlike ISE).
- **Blast radius:** Per the approved design, **no gating** — `_blast_radius()` always returns `"low"` so mutations auto-approve. Agent frontmatter `default-blast-radius-allowed: low`.
- **Verify SSL default OFF** (`verify_ssl` default `0` in DB, `verifySsl: false` in UI) — CML ships a self-signed cert.
- **Return shape (every call):** `{"status_code": int, "data": <payload|text>, "error": str|None, "blast_radius": str}`.
- **MCP server id:** `cml-mcp`. **Agent tool id / cli_package:** `cml`. **Env var prefix:** `CML_`.
- **Migration number:** `V0057` (ISE used V0056). Next free after this becomes V0058.
- **Naming parity:** Rust struct `CmlConfig` with `#[serde(rename_all = "camelCase")]`; commands `cml_get_config` / `cml_save_config` / `cml_test_connection`; TS wrappers `cmlGetConfig` / `cmlSaveConfig` / `cmlTestConnection`.
- **Verify before claiming done:** A live `cml_test_connection` against `192.168.2.200` (admin / Iwiwaf77) MUST succeed before the work is called complete.

---

### Task 1: Python `CmlClient` + sandbox helper + tests

**Files:**
- Create: `sidecar/src/ccie_sidecar/cml.py`
- Test: `sidecar/src/ccie_sidecar/test_cml.py`

**Interfaces:**
- Consumes: nothing (foundation).
- Produces:
  - `CmlClient(config: dict|None)` with `.call(method, path, body=None, query_params=None) -> dict`
  - `_blast_radius(method, path) -> str` (always `"low"`)
  - `install_cml(globals_dict, emit=None) -> CmlClient` — binds `cml_api_call(method, path, body=None, query_params=None) -> str` (JSON string), `cml` client object, and `import cml_api` module.
  - `test_connection(config: dict) -> {"ok": bool, "message": str}`

- [ ] **Step 1: Write the failing tests**

Create `sidecar/src/ccie_sidecar/test_cml.py`:

```python
"""Tests for the Cisco Modeling Labs (CML) client + sandbox helper."""
import json
from unittest.mock import Mock, MagicMock, patch


def test_blast_radius_always_low():
    from ccie_sidecar.cml import _blast_radius
    # No gating: every method/path is low so mutations auto-approve.
    assert _blast_radius("GET", "/labs") == "low"
    assert _blast_radius("POST", "/labs") == "low"
    assert _blast_radius("PUT", "/labs/abc/wipe") == "low"
    assert _blast_radius("DELETE", "/labs/abc") == "low"


def test_unconfigured_call_returns_error():
    from ccie_sidecar.cml import CmlClient
    client = CmlClient({})
    out = client.call("GET", "/labs")
    assert out["status_code"] == 0
    assert "not configured" in out["error"]
    assert out["blast_radius"] == "low"


def test_call_authenticates_then_uses_bearer():
    from ccie_sidecar.cml import CmlClient

    with patch("ccie_sidecar.cml.requests.Session") as mock_session_cls:
        mock_session = MagicMock()

        # First request = POST /authenticate -> JWT string; second = GET /labs.
        auth_resp = Mock()
        auth_resp.status_code = 200
        auth_resp.json.return_value = "JWT.TOKEN.HERE"
        labs_resp = Mock()
        labs_resp.status_code = 200
        labs_resp.json.return_value = ["lab-1", "lab-2"]
        mock_session.request.side_effect = [auth_resp, labs_resp]
        mock_session.headers = {}
        mock_session_cls.return_value = mock_session

        client = CmlClient({
            "host": "cml.local", "username": "admin",
            "password": "pw", "verify_ssl": False,
        })
        out = client.call("GET", "/labs")

        assert out["status_code"] == 200
        assert out["data"] == ["lab-1", "lab-2"]
        assert out["blast_radius"] == "low"

        calls = mock_session.request.call_args_list
        # First call authenticates.
        assert calls[0].kwargs["url"] == "https://cml.local/api/v0/authenticate"
        assert calls[0].kwargs["json"] == {"username": "admin", "password": "pw"}
        # Second call carries the bearer token and hits the data path.
        assert calls[1].kwargs["url"] == "https://cml.local/api/v0/labs"
        assert calls[1].kwargs["headers"]["Authorization"] == "Bearer JWT.TOKEN.HERE"
        assert calls[1].kwargs["verify"] is False


def test_reauth_once_on_401():
    from ccie_sidecar.cml import CmlClient

    with patch("ccie_sidecar.cml.requests.Session") as mock_session_cls:
        mock_session = MagicMock()
        auth1 = Mock(status_code=200); auth1.json.return_value = "TOK1"
        # First data call 401s (expired token); we re-auth then retry OK.
        unauth = Mock(status_code=401); unauth.json.return_value = {"description": "expired"}
        auth2 = Mock(status_code=200); auth2.json.return_value = "TOK2"
        ok = Mock(status_code=200); ok.json.return_value = {"state": "STARTED"}
        mock_session.request.side_effect = [auth1, unauth, auth2, ok]
        mock_session.headers = {}
        mock_session_cls.return_value = mock_session

        client = CmlClient({"host": "c", "username": "u", "password": "p", "verify_ssl": False})
        out = client.call("GET", "/labs/x/state")

        assert out["status_code"] == 200
        assert out["data"] == {"state": "STARTED"}
        # 4 requests total: auth, data(401), re-auth, data(retry).
        assert mock_session.request.call_count == 4


def test_install_cml_binds_helper():
    from ccie_sidecar.cml import install_cml

    g = {}
    with patch("ccie_sidecar.cml_config.get_cml_config", return_value=None):
        install_cml(g)

    assert "cml_api_call" in g
    assert "cml" in g
    out = json.loads(g["cml_api_call"]("GET", "/labs"))
    assert out["status_code"] == 0  # unconfigured -> JSON string error


def test_test_connection_requires_fields():
    from ccie_sidecar.cml import test_connection
    res = test_connection({"host": "cml.local"})
    assert res["ok"] is False
    assert "required" in res["message"].lower()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd sidecar && python -m pytest src/ccie_sidecar/test_cml.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'ccie_sidecar.cml'`

- [ ] **Step 3: Write `cml.py`**

Create `sidecar/src/ccie_sidecar/cml.py`:

```python
"""Cisco Modeling Labs (CML) integration.

CML exposes a single REST API base (https://<host>/api/v0) secured with a
Bearer JWT: POST /authenticate {username, password} returns a bare JWT string,
which is then sent as `Authorization: Bearer <jwt>` on every call. A single
`cml_api_call(method, path, ...)` helper wraps it. Mirrors the ISE/Stealthwatch
integrations so the MCP server and the in-sandbox helper share one client and
can't drift.

Per design, CML runs with NO approval gating: every call classifies as "low"
blast radius so lab mutations (start/stop/wipe/delete) auto-approve.
"""

import json
import sys
import types
from typing import Any, Callable, Dict, Optional

import requests

try:  # Quiet the self-signed-cert warning when verify_ssl is off.
    from urllib3.exceptions import InsecureRequestWarning
    requests.packages.urllib3.disable_warnings(InsecureRequestWarning)  # type: ignore[attr-defined]
except Exception:
    pass

_API_BASE = "/api/v0"


def _blast_radius(method: str, path: str) -> str:
    """Classify an API call for approval gating.

    Per the approved design, CML runs without gating: everything is "low" so
    mutations auto-approve. The hook stays here for parity with ISE/Stealthwatch
    and to make re-enabling gating a one-function change.
    """
    return "low"


class CmlClient:
    """Bearer-JWT CML REST client shared by the MCP server and the sandbox.

    Reads credentials from the config dict (sourced from sessions.db, same as
    the Settings -> CML tab). Authenticates lazily on first call, caches the JWT
    on a persistent requests.Session, and transparently re-authenticates once on
    a 401 before retrying.
    """

    def __init__(self, config: Optional[Dict[str, Any]]):
        self._config = config or {}
        self._session: Optional[requests.Session] = None
        self._token: Optional[str] = None

    @property
    def _host(self) -> str:
        return (self._config.get("host") or "").strip()

    @property
    def _verify_ssl(self) -> bool:
        return bool(self._config.get("verify_ssl", False))

    def _base_url(self) -> str:
        return f"https://{self._host}{_API_BASE}"

    def _ensure_session(self) -> Optional[requests.Session]:
        username = (self._config.get("username") or "").strip()
        if not self._host or not username:
            return None
        if self._session is None:
            self._session = requests.Session()
        return self._session

    def _authenticate(self, session: requests.Session) -> Optional[str]:
        """POST /authenticate and cache the returned JWT. Returns the token or None."""
        username = (self._config.get("username") or "").strip()
        password = self._config.get("password") or ""
        resp = session.request(
            method="POST",
            url=f"{self._base_url()}/authenticate",
            json={"username": username, "password": password},
            verify=self._verify_ssl,
            timeout=30,
        )
        if resp.status_code >= 400:
            self._token = None
            return None
        try:
            token = resp.json()
        except Exception:
            token = resp.text.strip().strip('"')
        if isinstance(token, str) and token:
            self._token = token
            return token
        self._token = None
        return None

    def call(
        self,
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        """Call a CML API endpoint. Returns a dict the agent json.loads-es.

        Shape: {"status_code", "data", "error", "blast_radius"}.
        """
        method = (method or "GET").upper()
        br = _blast_radius(method, path)
        if not self._host:
            return {"status_code": 0, "data": None,
                    "error": "CML is not configured. Set host/credentials in Settings -> CML.",
                    "blast_radius": br}

        session = self._ensure_session()
        if session is None:
            return {"status_code": 0, "data": None,
                    "error": "CML credentials are incomplete. Set host/username/password in Settings -> CML.",
                    "blast_radius": br}

        url = f"{self._base_url()}{path}"

        def _do_request() -> "requests.Response":
            headers = {"Accept": "application/json", "Content-Type": "application/json"}
            if self._token:
                headers["Authorization"] = f"Bearer {self._token}"
            return session.request(
                method=method, url=url, headers=headers,
                json=body, params=query_params,
                verify=self._verify_ssl, timeout=30,
            )

        try:
            if self._token is None and self._authenticate(session) is None:
                return {"status_code": 401, "data": None,
                        "error": "Authentication failed. Check credentials in Settings -> CML.",
                        "blast_radius": br}

            resp = _do_request()
            # Token expired mid-session: re-auth once and retry.
            if resp.status_code == 401:
                if self._authenticate(session) is None:
                    return {"status_code": 401, "data": None,
                            "error": "Authentication failed. Check credentials in Settings -> CML.",
                            "blast_radius": br}
                resp = _do_request()

            try:
                data = resp.json()
            except Exception:
                data = resp.text

            return {
                "status_code": resp.status_code,
                "data": data,
                "error": None if resp.status_code < 400 else f"HTTP {resp.status_code}",
                "blast_radius": br,
            }
        except requests.exceptions.Timeout:
            return {"status_code": 0, "data": None, "error": "Request timed out after 30 seconds", "blast_radius": br}
        except requests.exceptions.SSLError:
            return {"status_code": 0, "data": None,
                    "error": "SSL certificate verification failed (uncheck Verify SSL for self-signed certs)",
                    "blast_radius": br}
        except Exception as e:
            return {"status_code": 0, "data": None, "error": str(e), "blast_radius": br}


def install_cml(
    globals_dict: dict[str, Any],
    emit: Optional[Callable[[dict], None]] = None,
) -> CmlClient:
    """Bind a `cml_api_call` function into a sandbox globals dict.

    Mirrors install_ise / install_stealthwatch. `emit` is accepted for parity.
    """
    from ccie_sidecar.cml_config import get_cml_config

    client = CmlClient(get_cml_config())

    def cml_api_call(
        method: str,
        path: str,
        body: Optional[Dict] = None,
        query_params: Optional[Dict] = None,
    ) -> str:
        """Call the Cisco Modeling Labs REST API. Returns a JSON string (use json.loads)."""
        return json.dumps(client.call(method, path, body, query_params))

    globals_dict["cml_api_call"] = cml_api_call
    globals_dict["cml"] = client

    mod = types.ModuleType("cml_api")
    mod.cml_api_call = cml_api_call  # type: ignore[attr-defined]
    mod.client = client  # type: ignore[attr-defined]
    sys.modules["cml_api"] = mod

    return client


def test_connection(config: Dict[str, Any]) -> Dict[str, Any]:
    """Test a CML connection without saving. Returns {"ok": bool, "message": str}."""
    host = (config.get("host") or "").strip()
    username = (config.get("username") or "").strip()
    password = config.get("password") or ""

    if not host or not username or not password:
        return {"ok": False, "message": "Host, username, and password are required."}

    # Authenticate, then a cheap read of /labs confirms the token works.
    client = CmlClient(config)
    result = client.call("GET", "/labs")

    status = result.get("status_code") or 0
    if status == 401:
        return {"ok": False, "message": "Authentication failed. Check credentials."}
    if status == 0 and result.get("error"):
        return {"ok": False, "message": result["error"]}
    if status >= 400:
        return {"ok": False, "message": f"HTTP {status} from /labs."}

    return {"ok": True, "message": f"Connected to CML at {host} (API reachable)."}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd sidecar && python -m pytest src/ccie_sidecar/test_cml.py -v`
Expected: PASS (6 passed)

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/ccie_sidecar/cml.py sidecar/src/ccie_sidecar/test_cml.py
git commit -m "feat(cml): CmlClient with Bearer-JWT auth + sandbox helper"
```

---

### Task 2: CML config reader (`cml_config.py`)

**Files:**
- Create: `sidecar/src/ccie_sidecar/cml_config.py`
- Test: add to `sidecar/src/ccie_sidecar/test_cml.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `get_cml_config() -> dict | None` reading sessions.db `cml_config` (id=1), falling back to `CML_*` env vars. Dict keys: `host`, `username`, `password`, `verify_ssl`.

- [ ] **Step 1: Write the failing test**

Append to `sidecar/src/ccie_sidecar/test_cml.py`:

```python
def test_get_cml_config_from_env(monkeypatch):
    monkeypatch.setenv("CML_HOST", "cml.local")
    monkeypatch.setenv("CML_USERNAME", "admin")
    monkeypatch.setenv("CML_PASSWORD", "pw")
    monkeypatch.setenv("CML_VERIFY_SSL", "0")
    # Force the DB path to a nonexistent file so we hit the env fallback.
    import ccie_sidecar.cml_config as cc
    monkeypatch.setattr(cc, "_db_path", lambda: __import__("pathlib").Path("/nonexistent/x.db"))
    cfg = cc.get_cml_config()
    assert cfg == {"host": "cml.local", "username": "admin", "password": "pw", "verify_ssl": False}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd sidecar && python -m pytest src/ccie_sidecar/test_cml.py::test_get_cml_config_from_env -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'ccie_sidecar.cml_config'`

- [ ] **Step 3: Write `cml_config.py`**

Create `sidecar/src/ccie_sidecar/cml_config.py`:

```python
"""Read Cisco Modeling Labs (CML) connection details from the app config DB.

Mirrors ccie_sidecar.ise_config: the connection lives in the same sessions.db
the LLM api_key uses (NOT the encrypted vault), so it is readable by every
sandbox agent with no per-agent attachment and no lock/unlock step.
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
    host = os.environ.get("CML_HOST")
    if not host:
        return None
    return {
        "host": host,
        "username": os.environ.get("CML_USERNAME", ""),
        "password": os.environ.get("CML_PASSWORD", ""),
        "verify_ssl": os.environ.get("CML_VERIFY_SSL", "0").lower()
        in ("1", "true", "yes"),
    }


def get_cml_config() -> dict[str, Any] | None:
    """Return the saved CML connection dict, or None if unset.

    Reads sessions.db.cml_config first; falls back to CML_* env vars (which is
    how the MCP-server transport delivers them).
    """
    db = _db_path()
    try:
        if db.exists():
            conn = sqlite3.connect(str(db))
            try:
                cur = conn.cursor()
                cur.execute(
                    "SELECT host, username, password, verify_ssl "
                    "FROM cml_config WHERE id = 1"
                )
                row = cur.fetchone()
            finally:
                conn.close()
            if row and row[0]:
                return {
                    "host": row[0],
                    "username": row[1] or "",
                    "password": row[2] or "",
                    "verify_ssl": bool(row[3]),
                }
    except Exception:
        pass
    return _from_env()
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd sidecar && python -m pytest src/ccie_sidecar/test_cml.py -v`
Expected: PASS (7 passed)

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/ccie_sidecar/cml_config.py sidecar/src/ccie_sidecar/test_cml.py
git commit -m "feat(cml): config reader (sessions.db + CML_* env fallback)"
```

---

### Task 3: CML MCP server (`cml_mcp.py`)

**Files:**
- Create: `sidecar/src/ccie_sidecar/mcp_servers/cml_mcp.py`

**Interfaces:**
- Consumes: `CmlClient`, `_blast_radius` from `ccie_sidecar.cml`.
- Produces: a stdio JSON-RPC server exposing one tool `cml_api_call(method, path, body?, query_params?)`. Reads creds from `CML_*` env vars.

- [ ] **Step 1: Write the MCP server**

Create `sidecar/src/ccie_sidecar/mcp_servers/cml_mcp.py`:

```python
#!/usr/bin/env python3
"""
Cisco Modeling Labs (CML) MCP Server

Implements Model Context Protocol (JSON-RPC 2.0) to expose the CML REST API as a
single unified tool. CML uses a single base URL (https://<host>/api/v0) secured
with a Bearer JWT; the shared CmlClient handles authentication.
"""

import json
import os
import sys
from typing import Dict, Any, Optional

from ccie_sidecar.cml import CmlClient, _blast_radius

_client: Optional[CmlClient] = None


def get_blast_radius(method: str, path: str) -> str:
    return _blast_radius(method, path)


def _get_client() -> CmlClient:
    global _client
    if _client is None:
        _client = CmlClient({
            "host": os.environ.get("CML_HOST", ""),
            "username": os.environ.get("CML_USERNAME", ""),
            "password": os.environ.get("CML_PASSWORD", ""),
            "verify_ssl": os.environ.get("CML_VERIFY_SSL", "0") == "1",
        })
    return _client


def call_api(method: str, path: str, body: Optional[Dict] = None,
             query_params: Optional[Dict] = None) -> Dict[str, Any]:
    """Call a CML API endpoint. Returns {status_code, data, error, blast_radius}."""
    return _get_client().call(method, path, body, query_params)


def get_tool_description() -> str:
    return """Call the Cisco Modeling Labs (CML) REST API.

CML exposes ONE base URL: https://<host>/api/v0. Authentication (Bearer JWT) is
handled for you — do NOT call /authenticate yourself. All paths below are
relative to /api/v0.

RESPONSE SHAPE: {"status_code", "data", "error", "blast_radius"}. Check
status_code < 400 before trusting data. Most list endpoints return JSON arrays
of IDs or objects.

COMMON ENDPOINTS:

LABS:
  GET    /labs                       List lab IDs
  POST   /labs                       Create a lab (body: {"title": "...", "description": "..."})
  GET    /labs/{lab_id}              Lab detail
  PATCH  /labs/{lab_id}              Update lab (body fields: title/description/notes)
  DELETE /labs/{lab_id}              Delete a lab
  GET    /labs/{lab_id}/state        Lab state (DEFINED_ON_CORE/STARTED/STOPPED)
  GET    /labs/{lab_id}/topology     Full topology (nodes + links + interfaces)
  PUT    /labs/{lab_id}/start        Start the lab
  PUT    /labs/{lab_id}/stop         Stop the lab
  PUT    /labs/{lab_id}/wipe         Wipe the lab (clears node state)

NODES:
  GET    /labs/{lab_id}/nodes        Nodes in a lab
  POST   /labs/{lab_id}/nodes        Add a node
  GET    /labs/{lab_id}/nodes/{id}   Node detail
  GET    /nodes                      All running nodes across all labs

DEFINITIONS & IMAGES:
  GET    /node_definitions           Available node types
  GET    /image_definitions          Available images
  GET    /simplified_node_definitions  Compact node type list

SYSTEM:
  GET    /system_information         Version + readiness
  GET    /system_health              Health status
  GET    /system_stats               Compute/cluster stats
  GET    /users                      List users
  GET    /groups                     List groups

NOTES:
- Self-signed certs are common; the Verify SSL toggle in Settings -> CML controls
  verification.
- Lab lifecycle (start/stop/wipe) and deletes take effect immediately on the
  live CML server.
"""


def handle_request(request: Dict[str, Any]) -> Dict[str, Any]:
    method = request.get("method")
    req_id = request.get("id")
    params = request.get("params", {})

    if method == "initialize":
        return {
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "serverInfo": {"name": "cml-mcp", "version": "1.0.0"},
                "capabilities": {"tools": {}},
            },
        }

    elif method == "tools/list":
        return {
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "tools": [
                    {
                        "name": "cml_api_call",
                        "description": get_tool_description(),
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "method": {
                                    "type": "string",
                                    "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"],
                                    "description": "HTTP method",
                                },
                                "path": {
                                    "type": "string",
                                    "description": "API path under /api/v0 (e.g., '/labs')",
                                },
                                "body": {
                                    "type": "object",
                                    "description": "Request body for POST/PUT/PATCH (optional)",
                                },
                                "query_params": {
                                    "type": "object",
                                    "description": "URL query parameters as key-value pairs (optional)",
                                },
                            },
                            "required": ["method", "path"],
                        },
                    }
                ]
            },
        }

    elif method == "tools/call":
        tool_name = params.get("name")
        arguments = params.get("arguments", {})

        if tool_name != "cml_api_call":
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
            return {
                "jsonrpc": "2.0", "id": req_id,
                "result": {
                    "content": [{"type": "text",
                                 "text": f"Error: {result['error']}\nStatus: {result['status_code']}"}],
                    "blast_radius": get_blast_radius(api_method, api_path),
                },
            }

        return {
            "jsonrpc": "2.0", "id": req_id,
            "result": {
                "content": [{"type": "text", "text": json.dumps(result["data"], indent=2)}],
                "blast_radius": get_blast_radius(api_method, api_path),
            },
        }

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

- [ ] **Step 2: Smoke-test the JSON-RPC loop manually**

Run:
```bash
cd sidecar && printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | python -m ccie_sidecar.mcp_servers.cml_mcp
```
Expected: two JSON lines; the second contains `"name": "cml_api_call"` and the `inputSchema` with `method`/`path`.

- [ ] **Step 3: Commit**

```bash
git add sidecar/src/ccie_sidecar/mcp_servers/cml_mcp.py
git commit -m "feat(cml): single-tool MCP server (cml_api_call)"
```

---

### Task 4: Sidecar RPC dispatch for `cml.test_connection`

**Files:**
- Modify: `sidecar/src/ccie_sidecar/server.py` (after the `ise.test_connection` branch, ~line 593)

**Interfaces:**
- Consumes: `ccie_sidecar.cml.test_connection`.
- Produces: RPC method `cml.test_connection` returning `{"id", "type": "done", "result": {ok, message}}`.

- [ ] **Step 1: Add the dispatch branch**

In `sidecar/src/ccie_sidecar/server.py`, immediately after the `elif method == "ise.test_connection":` block (the one that ends with `return {"id": req_id, "type": "done", "result": _ise_test(conf)}`), insert:

```python
    elif method == "cml.test_connection":
        # Settings → CML "Test connection" button. Tests the passed-in config
        # (not the saved one) with a single read-only /labs call after auth.
        # Never saves, never mutates the server. Always returns done with {ok, message}.
        conf = params.get("config") or {}
        from ccie_sidecar.cml import test_connection as _cml_test
        return {"id": req_id, "type": "done", "result": _cml_test(conf)}
```

- [ ] **Step 2: Verify the module imports and the branch is present**

Run:
```bash
cd sidecar && python -c "import ccie_sidecar.server" && grep -n "cml.test_connection" src/ccie_sidecar/server.py
```
Expected: no import error; grep prints the matching line.

- [ ] **Step 3: Commit**

```bash
git add sidecar/src/ccie_sidecar/server.py
git commit -m "feat(cml): wire cml.test_connection RPC dispatch"
```

---

### Task 5: Sandbox wiring (code_exec, sandbox_index, react_code)

**Files:**
- Modify: `sidecar/src/ccie_sidecar/agents/code_exec.py` (after the `ise` injection block, ~line 164)
- Modify: `sidecar/src/ccie_sidecar/agents/sandbox_index.py` (in `build_discovery_hint`, after the `ise` branch, ~line 170)
- Modify: `sidecar/src/ccie_sidecar/agents/react_code.py` (in `_build_client_section`, after the `ise` branch, ~line 152)
- Test: add to `sidecar/src/ccie_sidecar/test_cml.py`

**Interfaces:**
- Consumes: `install_cml`, `_build_sandbox_globals`, `_build_client_section`.
- Produces: a `cml` cli_package that binds `cml_api_call` into the sandbox and steers the model at it (not the proxmox fallback).

- [ ] **Step 1: Write the failing test**

Append to `sidecar/src/ccie_sidecar/test_cml.py`:

```python
def test_react_code_client_section_points_at_cml_not_proxmox():
    """The cml agent's client section must steer the model to cml_api_call, NOT
    fall through to the proxmox fallback (proxmox is injected into every sandbox)."""
    from ccie_sidecar.agents.code_exec import _build_sandbox_globals
    from ccie_sidecar.agents.react_code import _build_client_section

    g = _build_sandbox_globals("cml", {}, emit=lambda e: None)
    assert "proxmox" in g  # proxmox is always injected — the trap we must avoid
    assert "cml_api_call" in g  # the cml branch bound the helper
    section = _build_client_section("cml", g, False)
    assert "cml_api_call" in section
    assert "/labs" in section
    assert "ONLY way to reach Proxmox" not in section
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd sidecar && python -m pytest src/ccie_sidecar/test_cml.py::test_react_code_client_section_points_at_cml_not_proxmox -v`
Expected: FAIL (`cml_api_call` not in globals; section falls through to proxmox).

- [ ] **Step 3a: Add the code_exec injection**

In `sidecar/src/ccie_sidecar/agents/code_exec.py`, after the `if cli_package == "ise":` block (ends with the `except Exception: pass` around line 164), insert:

```python
    # Bind the CML client when this is the cml agent. Reads creds from
    # sessions.db (same as Settings → CML) and injects the `cml_api_call(...)`
    # helper the agent's prompt expects.
    if cli_package == "cml":
        try:
            from ccie_sidecar.cml import install_cml
            install_cml(globals_dict, emit=emit)
        except Exception:
            pass
```

- [ ] **Step 3b: Add the discovery hint**

In `sidecar/src/ccie_sidecar/agents/sandbox_index.py`, in `build_discovery_hint`, after the `if cli_package == "ise":` return block (before the final `return ""`), insert:

```python
    if cli_package == "cml":
        return (
            "Endpoint discovery: the embedded API catalog in the cml_api_call tool "
            "description lists every supported path and its request shape — READ IT, "
            "do not guess. Key facts: ONE base URL (https://<host>/api/v0); auth (Bearer "
            "JWT) is handled for you, do NOT call /authenticate. Labs are the core "
            "resource: GET /labs lists lab IDs, GET /labs/{id}/topology returns the full "
            "node+link graph, GET /labs/{id}/state returns run state, and PUT "
            "/labs/{id}/start|stop|wipe drive lifecycle. GET /nodes lists running nodes "
            "across all labs. Responses are JSON; check status_code < 400 before trusting "
            "data."
        )
```

- [ ] **Step 3c: Add the react_code client section**

In `sidecar/src/ccie_sidecar/agents/react_code.py`, in `_build_client_section`, after the `if cli_package == "ise":` return block (before the `# No vendor client bound` comment / `if "proxmox" in sandbox_globals:`), insert:

```python
    if cli_package == "cml":
        return (
            "- cml_api_call(method, path, body=None, query_params=None):\n"
            "  pre-bound function — your ONLY way to reach Cisco Modeling Labs. Do NOT\n"
            "  use requests, do NOT touch proxmox, do NOT look for env vars or config\n"
            "  files, and do NOT walk the filesystem. CML is already configured and\n"
            "  authenticated (do NOT call /authenticate yourself).\n"
            "  It returns a JSON string; json.loads it. Shape:\n"
            "    {\"status_code\": int, \"data\": <payload>, \"error\": str|None, \"blast_radius\": str}\n"
            "  ONE base URL: https://<host>/api/v0 — all paths are relative to it.\n"
            "  To list labs and inspect one's topology:\n"
            "    import json\n"
            "    labs = json.loads(cml_api_call('GET', '/labs'))\n"
            "    for lab_id in labs['data']:\n"
            "        topo = json.loads(cml_api_call('GET', f'/labs/{lab_id}/topology'))\n"
            "        print(lab_id, topo['status_code'])\n"
            "  Check status_code < 400 / error is None before trusting data. If error\n"
            "  says 'not configured', tell the user to set Settings → CML."
        )
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd sidecar && python -m pytest src/ccie_sidecar/test_cml.py -v`
Expected: PASS (all CML tests).

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/ccie_sidecar/agents/code_exec.py sidecar/src/ccie_sidecar/agents/sandbox_index.py sidecar/src/ccie_sidecar/agents/react_code.py sidecar/src/ccie_sidecar/test_cml.py
git commit -m "feat(cml): sandbox wiring (inject helper + discovery hint + client section)"
```

---

### Task 6: Bundled agent (`AGENT.md` + `tools.json`)

**Files:**
- Create: `bundled-agents/cml/AGENT.md`
- Create: `bundled-agents/cml/tools.json`

**Interfaces:**
- Consumes: the `cml` cli_package wiring from Task 5.
- Produces: a discoverable `cml` agent with one attached tool `cml_api_call`.

- [ ] **Step 1: Write `AGENT.md`**

Create `bundled-agents/cml/AGENT.md`:

```markdown
---
name: cml
description: Cisco Modeling Labs (CML) expert - inspect and operate network simulation labs, nodes, topologies, and system state
system-prompt: |
  You are a Cisco Modeling Labs (CML) expert. You inspect and operate network
  simulation labs: listing labs, reading topologies and node state, and driving
  lab lifecycle (start/stop/wipe), plus creating labs and nodes.

  TOOL USAGE:
  `cml_api_call(method, path, body=None, query_params=None)` is a Python function
  already available in your sandbox (do NOT import it, do NOT use requests
  directly). CML authentication (Bearer JWT) is handled for you — do NOT call
  /authenticate. Parameters:
  - method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  - path: API path under /api/v0 (e.g., "/labs")
  - body: Optional JSON body for POST/PUT/PATCH (as dict)
  - query_params: Optional URL query parameters (as dict)

  ONE BASE URL: every path is relative to https://<host>/api/v0.

  RETURN VALUE:
  It returns a JSON *string*. Always `json.loads(result)` it. The parsed object is:
    {"status_code": int, "data": <API payload or text>, "error": str|None, "blast_radius": str}
  Check `status_code < 400` / `error is None` before trusting `data`.

  CORE RESOURCES:
  - GET /labs                      -> list of lab IDs
  - GET /labs/{id}                 -> lab detail
  - GET /labs/{id}/state           -> DEFINED_ON_CORE | STARTED | STOPPED
  - GET /labs/{id}/topology        -> full node+link+interface graph
  - GET /labs/{id}/nodes           -> nodes in a lab
  - GET /nodes                     -> all running nodes across labs
  - PUT /labs/{id}/start|stop|wipe -> lab lifecycle (takes effect immediately)
  - GET /node_definitions, /image_definitions -> available types/images
  - GET /system_information, /system_health, /system_stats

  COMMON WORKFLOWS:

  List labs and their state:
  ```python
  import json
  labs = json.loads(cml_api_call("GET", "/labs"))
  for lab_id in labs["data"]:
      st = json.loads(cml_api_call("GET", f"/labs/{lab_id}/state"))
      print(lab_id, st["data"])
  ```

  Inspect a lab's topology:
  ```python
  import json
  topo = json.loads(cml_api_call("GET", f"/labs/{lab_id}/topology"))
  print(topo["data"])  # nodes + links + interfaces
  ```

  Start a lab:
  ```python
  import json
  r = json.loads(cml_api_call("PUT", f"/labs/{lab_id}/start"))
  print(r["status_code"])
  ```

  ANTI-FLAILING RULE:
  If a path 404s it is the wrong SHAPE — consult the catalog in the tool
  description, do not brute-force endpoint names. A 401 means credentials are
  wrong; tell the user to check Settings → CML.

  IMPORTANT NOTES:
  - Lab start/stop/wipe and deletes act on the LIVE CML server immediately.
  - Self-signed certs are common; SSL verification is controlled by the Verify SSL
    toggle in Settings → CML.
  - Before EVERY cml_api_call, write 1-2 sentences explaining what you're about to
    query and why.

  If cml_api_call returns an authentication or "not configured" error, tell the
  user to configure credentials in Settings → CML.

execution-mode: react-code

attached-tools:
  - id: cml
    catalog: tools.json
    default-blast-radius-allowed: low

allowed-commands: []
---

# Cisco Modeling Labs Agent

Operates Cisco Modeling Labs through a single `cml_api_call` helper against the
/api/v0 REST API. Inspects labs, nodes, and topologies and drives lab lifecycle.
```

- [ ] **Step 2: Write `tools.json`**

Create `bundled-agents/cml/tools.json`:

```json
[
  {
    "name": "cml_api_call",
    "description": "Call the Cisco Modeling Labs (CML) REST API. ONE base URL: https://<host>/api/v0 (all paths relative). Auth (Bearer JWT) is handled for you; do NOT call /authenticate. Returns {status_code, data, error, blast_radius}. Key endpoints: GET /labs (list lab IDs), GET /labs/{id} (detail), GET /labs/{id}/state, GET /labs/{id}/topology, GET /labs/{id}/nodes, POST /labs (create), PUT /labs/{id}/start|stop|wipe (lifecycle), DELETE /labs/{id}, GET /nodes (all running nodes), GET /node_definitions, GET /image_definitions, GET /system_information, GET /system_health, GET /users, GET /groups. Check status_code < 400 before trusting data.",
    "type": "function",
    "function": {
      "name": "cml_api_call",
      "description": "Call the Cisco Modeling Labs (CML) REST API under /api/v0. Auth is handled internally.",
      "parameters": {
        "type": "object",
        "properties": {
          "method": { "type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"], "description": "HTTP method" },
          "path": { "type": "string", "description": "API path under /api/v0 (e.g., '/labs')" },
          "body": { "type": "object", "description": "Request body for POST/PUT/PATCH (optional)" },
          "query_params": { "type": "object", "description": "URL query parameters (optional)" }
        },
        "required": ["method", "path"]
      }
    }
  }
]
```

- [ ] **Step 3: Validate the JSON and frontmatter parse**

Run:
```bash
cd "/Users/shaunwhi/CCIE Terminal" && python3 -c "import json; json.load(open('bundled-agents/cml/tools.json')); print('tools.json OK')" && head -3 bundled-agents/cml/AGENT.md
```
Expected: `tools.json OK` and the first frontmatter lines (`---`, `name: cml`, ...).

- [ ] **Step 4: Commit**

```bash
git add bundled-agents/cml/AGENT.md bundled-agents/cml/tools.json
git commit -m "feat(cml): bundled agent + single-tool catalog"
```

---

### Task 7: Migration + Rust config struct, commands, registration

**Files:**
- Create: `src-tauri/migrations/V0057__cml_config.sql`
- Modify: `src-tauri/src/commands/mod.rs` (after the ISE block, ~line 5071, before `pub mod blocks;`)
- Modify: `src-tauri/src/lib.rs` (after the three `ise_*` command registrations, ~line 369)

**Interfaces:**
- Consumes: `sidecar_spawn_target()`, `AppState`, `enable_*_mcp_server` pattern.
- Produces: Tauri commands `cml_get_config`, `cml_save_config`, `cml_test_connection`; `CmlConfig` struct.

- [ ] **Step 1: Write the migration**

Create `src-tauri/migrations/V0057__cml_config.sql`:

```sql
-- Cisco Modeling Labs (CML) connection settings (singleton row).
CREATE TABLE IF NOT EXISTS cml_config (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    host         TEXT NOT NULL DEFAULT '',
    username     TEXT NOT NULL DEFAULT '',
    password     TEXT NOT NULL DEFAULT '',
    verify_ssl   INTEGER NOT NULL DEFAULT 0   -- default OFF: CML ships a self-signed cert
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cml_config_singleton
ON cml_config(id);
```

- [ ] **Step 2: Add the Rust struct + commands**

In `src-tauri/src/commands/mod.rs`, immediately before the `pub mod blocks;` line (~5073), insert:

```rust
// ---- Cisco Modeling Labs (CML) Configuration -------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CmlConfig {
    pub host: String,
    pub username: String,
    pub password: String,
    pub verify_ssl: bool,
}

#[tauri::command]
pub async fn cml_get_config(
    state: State<'_, AppState>,
) -> Result<Option<CmlConfig>, String> {
    let conn = state.db.lock();

    let result: Option<CmlConfig> = conn
        .query_row(
            "SELECT host, username, password, verify_ssl FROM cml_config WHERE id = 1",
            [],
            |row| Ok(CmlConfig {
                host: row.get(0)?,
                username: row.get(1)?,
                password: row.get(2)?,
                verify_ssl: row.get::<_, i64>(3)? == 1,
            })
        )
        .optional()
        .map_err(|e| e.to_string())?;

    Ok(result)
}

/// Register the CML MCP server in the `mcp_servers` table.
/// Credentials are passed via environment variables so the Python script
/// can access them without storing them in the command JSON.
fn enable_cml_mcp_server(
    db: &Arc<Mutex<rusqlite::Connection>>,
    config: &CmlConfig,
) -> Result<(), String> {
    let (python, _) = sidecar_spawn_target();

    let repo_root = std::env::var("CCIE_REPO_ROOT").unwrap_or_else(|_| {
        std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string()
    });
    let mcp_script_path = format!("{}/sidecar/src/ccie_sidecar/mcp_servers/cml_mcp.py", repo_root);

    let command_json = serde_json::json!({
        "cmd": python,
        "args": [mcp_script_path]
    });

    let env_json = serde_json::json!({
        "CML_HOST": config.host,
        "CML_USERNAME": config.username,
        "CML_PASSWORD": config.password,
        "CML_VERIFY_SSL": if config.verify_ssl { "1" } else { "0" },
    });

    let conn = db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO mcp_servers (id, name, transport, command_json, url, env_json, enabled)
         VALUES ('cml-mcp', 'Cisco Modeling Labs', 'stdio', ?1, NULL, ?2, 1)",
        rusqlite::params![
            serde_json::to_string(&command_json).unwrap(),
            serde_json::to_string(&env_json).unwrap(),
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn cml_save_config(
    state: State<'_, AppState>,
    config: CmlConfig,
) -> Result<(), String> {
    {
        let conn = state.db.lock();
        conn.execute(
            "INSERT OR REPLACE INTO cml_config (id, host, username, password, verify_ssl)
             VALUES (1, ?1, ?2, ?3, ?4)",
            rusqlite::params![
                config.host,
                config.username,
                config.password,
                if config.verify_ssl { 1 } else { 0 },
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    enable_cml_mcp_server(&state.db, &config)?;

    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CmlTestResult {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub async fn cml_test_connection(
    state: State<'_, AppState>,
    config: CmlConfig,
) -> Result<CmlTestResult, String> {
    let params = serde_json::json!({
        "config": {
            "host": config.host,
            "username": config.username,
            "password": config.password,
            "verify_ssl": config.verify_ssl,
        }
    });

    let resp = state
        .agent
        .call("cml.test_connection", params)
        .await
        .map_err(|e| e.to_string())?;

    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => {
            Ok(CmlTestResult {
                ok: result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
                message: result
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown error")
                    .to_string(),
            })
        }
        _ => Err("Unexpected response from sidecar".to_string()),
    }
}
```

- [ ] **Step 3: Register the commands in `lib.rs`**

In `src-tauri/src/lib.rs`, find the three lines:

```rust
            commands::ise_get_config,
            commands::ise_save_config,
            commands::ise_test_connection,
```

Insert immediately after them:

```rust
            commands::cml_get_config,
            commands::cml_save_config,
            commands::cml_test_connection,
```

- [ ] **Step 4: Build the Rust backend to verify it compiles**

Run: `cd "/Users/shaunwhi/CCIE Terminal/src-tauri" && cargo build 2>&1 | tail -20`
Expected: `Finished` (no errors). Warnings are acceptable.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/migrations/V0057__cml_config.sql src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(cml): V0057 config table + Tauri commands + MCP auto-register"
```

---

### Task 8: Frontend — TS bridge, settings tab, Settings wiring

**Files:**
- Modify: `src/lib/tauri.ts` (after the ISE block, ~line 1622)
- Create: `src/components/settings/CmlSettingsTab.tsx`
- Create: `src/components/settings/CmlSettingsTab.css` (copied from `IseSettingsTab.css`, classes renamed `ise-`→`cml-`)
- Modify: `src/windows/Settings.tsx` (import ~line 15; TabType ~line 78; tab button ~line 520; render ~line 974)

**Interfaces:**
- Consumes: Tauri commands from Task 7.
- Produces: `CmlConfig`, `CmlTestResult` types; `cmlGetConfig` / `cmlSaveConfig` / `cmlTestConnection`; a `"cml"` Settings tab.

- [ ] **Step 1: Add the TS bridge**

In `src/lib/tauri.ts`, after the ISE block (the `iseTestConnection` export, ~line 1622), insert:

```typescript
export type CmlConfig = {
  host: string;
  username: string;
  password: string;
  verifySsl: boolean;
};

export type CmlTestResult = {
  ok: boolean;
  message: string;
};

export const cmlGetConfig = () =>
  invoke<CmlConfig | null>("cml_get_config");

export const cmlSaveConfig = (config: CmlConfig) =>
  invoke<void>("cml_save_config", { config });

export const cmlTestConnection = (config: CmlConfig) =>
  invoke<CmlTestResult>("cml_test_connection", { config });
```

- [ ] **Step 2: Create the CSS (copy + rename)**

Run:
```bash
cd "/Users/shaunwhi/CCIE Terminal" && sed 's/ise-/cml-/g; s/\.ise\b/.cml/g' src/components/settings/IseSettingsTab.css > src/components/settings/CmlSettingsTab.css && echo "CSS created" && head -3 src/components/settings/CmlSettingsTab.css
```
Expected: `CSS created` and the first rule using `cml-` classes.

- [ ] **Step 3: Create `CmlSettingsTab.tsx`**

Create `src/components/settings/CmlSettingsTab.tsx`:

```tsx
import { useState, useEffect } from 'react';
import {
  cmlGetConfig,
  cmlSaveConfig,
  cmlTestConnection,
  type CmlConfig,
} from '../../lib/tauri';
import './CmlSettingsTab.css';

type StatusKind = 'ok' | 'err' | 'info';

export default function CmlSettingsTab() {
  const [cfg, setCfg] = useState<CmlConfig>({
    host: '',
    username: '',
    password: '',
    verifySsl: false,
  });

  const [status, setStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    cmlGetConfig().then((config) => {
      if (config) setCfg(config);
    });
  }, []);

  const test = async () => {
    if (!cfg.host.trim()) {
      setStatus({ kind: 'err', text: 'Enter a host before testing.' });
      return;
    }
    setTesting(true);
    setStatus({ kind: 'info', text: 'Testing connection…' });
    try {
      const res = await cmlTestConnection(cfg);
      setStatus({ kind: res.ok ? 'ok' : 'err', text: res.message });
    } catch (e) {
      setStatus({ kind: 'err', text: `Test failed: ${String(e)}` });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await cmlSaveConfig(cfg);
      setStatus({ kind: 'ok', text: 'Configuration saved successfully.' });
    } catch (e) {
      setStatus({ kind: 'err', text: `Save failed: ${String(e)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cml-tab">
      <div className="cml-header">
        <h2>Cisco Modeling Labs</h2>
        <p className="cml-subtitle">
          Configure connection to Cisco Modeling Labs (CML) for inspecting and
          operating simulation labs, nodes, and topologies. The CML agent reaches
          the /api/v0 REST API with these credentials.
        </p>
      </div>

      <div className="cml-section">
        <h3>Connection</h3>
        <div className="cml-grid">
          <label htmlFor="cml-host">Host</label>
          <input
            id="cml-host"
            type="text"
            value={cfg.host}
            onChange={(e) => setCfg({ ...cfg, host: e.target.value })}
            placeholder="192.168.2.200"
          />
          <div className="cml-field-desc cml-field--full">
            CML server hostname or IP (without https://).
          </div>
        </div>
      </div>

      <div className="cml-section">
        <h3>Authentication</h3>
        <div className="cml-grid">
          <label htmlFor="cml-username">Username</label>
          <input
            id="cml-username"
            type="text"
            value={cfg.username}
            onChange={(e) => setCfg({ ...cfg, username: e.target.value })}
            placeholder="admin"
          />

          <label htmlFor="cml-password">Password</label>
          <input
            id="cml-password"
            type="password"
            value={cfg.password}
            onChange={(e) => setCfg({ ...cfg, password: e.target.value })}
          />

          <div className="cml-field-desc cml-field--full">
            A CML user account with API access.
          </div>
        </div>
      </div>

      <div className="cml-section">
        <h3>TLS</h3>
        <div className="cml-grid">
          <label htmlFor="cml-verify-ssl" className="cml-checkbox-label">
            <input
              id="cml-verify-ssl"
              type="checkbox"
              checked={cfg.verifySsl}
              onChange={(e) => setCfg({ ...cfg, verifySsl: e.target.checked })}
            />
            Verify SSL certificates
          </label>
          <div className="cml-field-desc cml-field--full">
            Leave unchecked for the self-signed certificate CML ships with by
            default (not recommended for production).
          </div>
        </div>
      </div>

      <div className="cml-actions">
        <button onClick={save} disabled={saving} className="cml-btn-primary">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={test} disabled={testing} className="cml-btn-secondary">
          {testing ? 'Testing…' : 'Test Connection'}
        </button>
      </div>

      {status && (
        <div className={`cml-status cml-status--${status.kind}`}>{status.text}</div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire it into `Settings.tsx`**

Edit `src/windows/Settings.tsx`:

(a) After the ISE import (line 15, `import IseSettingsTab from "../components/settings/IseSettingsTab";`), add:
```tsx
import CmlSettingsTab from "../components/settings/CmlSettingsTab";
```

(b) In the `TabType` union (line 78), add `"cml"`. Change:
```tsx
    "general" | "mcp" | "skills" | "agents" | "rag" | "ftp" | "pyats" | "proxmox" | "stealthwatch" | "ise" | "terminal" | "browser"
```
to:
```tsx
    "general" | "mcp" | "skills" | "agents" | "rag" | "ftp" | "pyats" | "proxmox" | "stealthwatch" | "ise" | "cml" | "terminal" | "browser"
```

(c) After the ISE tab button (lines 519-525, the `<button ... onClick={() => setActiveTab("ise")}>ISE</button>` block), add an identical button for CML:
```tsx
            <button
              className={activeTab === "cml" ? "active" : ""}
              onClick={() => setActiveTab("cml")}
            >
              CML
            </button>
```

(d) After the ISE render line (974, `{activeTab === "ise" && <IseSettingsTab />}`), add:
```tsx
        {activeTab === "cml" && <CmlSettingsTab />}
```

- [ ] **Step 5: Typecheck / build the frontend**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npx tsc --noEmit 2>&1 | tail -20`
Expected: no errors referencing CML files. (Pre-existing unrelated errors, if any, are out of scope — confirm none mention `Cml`/`cml`.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/tauri.ts src/components/settings/CmlSettingsTab.tsx src/components/settings/CmlSettingsTab.css src/windows/Settings.tsx
git commit -m "feat(cml): Settings → CML credential pane + TS bridge"
```

---

### Task 9: Live verification against 192.168.2.200

**Files:** none (verification only).

**Interfaces:** Consumes the full stack.

- [ ] **Step 1: Verify the Python client against the live server**

Run:
```bash
cd "/Users/shaunwhi/CCIE Terminal/sidecar" && python3 -c "
from ccie_sidecar.cml import test_connection, CmlClient
cfg = {'host': '192.168.2.200', 'username': 'admin', 'password': 'Iwiwaf77', 'verify_ssl': False}
print('test_connection:', test_connection(cfg))
import json
c = CmlClient(cfg)
labs = c.call('GET', '/labs')
print('GET /labs status:', labs['status_code'], '->', json.dumps(labs['data'])[:200])
"
```
Expected: `test_connection: {'ok': True, 'message': 'Connected to CML at 192.168.2.200 (API reachable).'}` and a `GET /labs status: 200` line with a JSON array of lab IDs (or `[]` if no labs exist).

- [ ] **Step 2: Verify the MCP server end-to-end with live creds**

Run:
```bash
cd "/Users/shaunwhi/CCIE Terminal/sidecar" && CML_HOST=192.168.2.200 CML_USERNAME=admin CML_PASSWORD=Iwiwaf77 CML_VERIFY_SSL=0 \
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"cml_api_call","arguments":{"method":"GET","path":"/labs"}}}' \
| CML_HOST=192.168.2.200 CML_USERNAME=admin CML_PASSWORD=Iwiwaf77 CML_VERIFY_SSL=0 python -m ccie_sidecar.mcp_servers.cml_mcp
```
Expected: a JSON-RPC response whose `result.content[0].text` is a JSON array (the lab IDs) and `result.blast_radius` is `"low"`.

- [ ] **Step 3: Verify the full app path (manual, via `/run` or the running app)**

Launch the app, open **Settings → CML**, enter `192.168.2.200` / `admin` / `Iwiwaf77`, leave Verify SSL unchecked, click **Test Connection** (expect a green "Connected to CML…"), then **Save**. Then ask the `cml` agent: "List the labs on CML and show each lab's state." Confirm it calls `cml_api_call` and returns real data.

Document the observed result (pass/fail with the actual messages) — do NOT claim done without this.

- [ ] **Step 4: Run the full sidecar test suite once more**

Run: `cd sidecar && python -m pytest src/ccie_sidecar/test_cml.py -v`
Expected: all CML tests PASS.

- [ ] **Step 5: Final commit (if verification required any fixes)**

```bash
git add -A && git commit -m "test(cml): live-verify integration against CML 2.10"
```

---

## Self-Review

**Spec coverage:** Every spec section maps to a task — client+auth (T1), config reader (T2), MCP server (T3), test RPC (T4), sandbox wiring incl. the proxmox-fallthrough fix (T5), agent (T6), migration+Rust+registration (T7), settings UI+bridge (T8), live verification (T9). The auth deviation (Bearer JWT, re-auth-on-401) is in T1; no-gating (`_blast_radius` always `"low"`) is in T1 and tested. Verify-SSL-default-OFF appears in the migration (T7), the UI default (T8), and `_from_env` (T2).

**Placeholder scan:** No TBD/TODO; every code step contains complete code; commands have expected output.

**Type consistency:** `CmlConfig` fields (`host`/`username`/`password`/`verifySsl`) match across Rust (camelCase serde), TS type, and the tab. The single tool `cml_api_call(method, path, body, query_params)` signature is identical in `cml.py`, `cml_mcp.py`, `tools.json`, the agent prompt, and the react_code client section. RPC method `cml.test_connection` matches between `server.py` (T4) and the Rust `cml_test_connection` (T7). MCP id `cml-mcp` and cli_package/tool id `cml` are consistent throughout.
