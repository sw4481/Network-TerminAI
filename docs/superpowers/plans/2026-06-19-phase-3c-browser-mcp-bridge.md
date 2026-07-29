# Phase 3C (revised): Browser Control MCP Bridge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let ALL agents — built-in CCIE/sidecar agents AND external CLIs (Claude Code, Codex) — open and control browser windows, via an MCP server that proxies into the Tauri process.

**Architecture:** Browser windows live inside the Tauri process (`BrowserManager` + `AppHandle`). MCP servers are separate subprocesses that can't reach in. Bridge them: an **axum HTTP control server runs inside Tauri** (has `AppHandle`), and a **thin Python MCP stdio shim** (`browser_mcp.py`, mirroring the proven `stealthwatch_mcp.py`) proxies JSON-RPC → localhost HTTP. The shim is registered in `mcp_servers` for built-in agents, and the same command is given to external CLIs. One in-process server owns all window ops; the shim is dumb.

**Tech Stack:** Rust (axum 0.7 — already a dep, tokio, Tauri 2.10.3), Python 3.12 (bundled, stdlib only), MCP stdio JSON-RPC.

## Global Constraints

- `axum` 0.7, `tokio`, `reqwest` 0.11 are already dependencies — do NOT add new Rust deps.
- The Python shim uses **stdlib only** (`json`, `sys`, `os`, `urllib.request`) — no new Python deps.
- The HTTP control server binds **`127.0.0.1:0`** (ephemeral port) and requires a **bearer token** on every request. Localhost-only + token is the security boundary.
- Discovery file: `~/Library/Application Support/ccie-terminal/browser-control.json` containing `{"port": <u16>, "token": "<uuid>"}`, written at app startup with `0600` perms. Both the shim and the Settings "copy config" read it.
- The shim mirrors `sidecar/src/ccie_sidecar/mcp_servers/stealthwatch_mcp.py`: JSON-RPC 2.0, methods `initialize`, `tools/list`, `tools/call`; main loop reads stdin lines, writes stdout.
- Auto-registration mirrors `enable_stealthwatch_mcp_server` (src-tauri/src/commands/mod.rs:4754): upsert into `mcp_servers` with `transport='stdio'`, `command_json={cmd: python, args: [shim_path]}`.
- Reuse the existing `BrowserManager` and the Task 1-4 browser commands' logic; do NOT duplicate window-creation code — the axum handlers call the same `BrowserManager` + `AppHandle` operations.
- Tool names exposed via MCP: `browser_open`, `browser_navigate`, `browser_back`, `browser_forward`, `browser_reload`, `browser_list`, `browser_get_url`, `browser_eval`, `browser_close`. (No `browser_eval_result` — external pages can't call back, established in 3B.)
- No new SQLite migration.

---

## File Structure

- `src-tauri/src/browser/control_server.rs` — NEW: axum router + handlers (in-process, holds `AppHandle` + `Arc<BrowserManager>`), token auth, ephemeral bind, discovery-file writer.
- `src-tauri/src/browser/mod.rs` — MODIFY: export control server.
- `src-tauri/src/lib.rs` — MODIFY: in `.setup()`, spawn the control server; after it binds, write discovery file + auto-register the MCP shim.
- `src-tauri/src/commands/browser.rs` — MODIFY: refactor window ops into reusable functions the axum handlers and Tauri commands both call (avoid duplication).
- `sidecar/src/ccie_sidecar/mcp_servers/browser_mcp.py` — NEW: stdio MCP shim → HTTP proxy.
- `src-tauri/src/commands/mod.rs` — MODIFY: add `enable_browser_mcp_server` (mirrors stealthwatch); add a `get_browser_mcp_config()` command for the Settings "copy config" UI.
- `src/components/SettingsBrowserTab.tsx` — MODIFY (created in 3D Task 8, but if 3D not yet done, create minimal here): show the external-agent MCP config snippet + copy button.

---

## Task 1: Refactor browser window ops into reusable functions

**Files:**
- Modify: `src-tauri/src/commands/browser.rs`

**Interfaces:**
- Consumes: existing `BrowserManager`, `AppHandle`.
- Produces: free functions usable by BOTH Tauri commands and axum handlers:
  - `pub fn do_create_browser_window(app: &AppHandle, mgr: &BrowserManager, url: &str) -> Result<String, String>`
  - `pub fn do_navigate(app: &AppHandle, mgr: &BrowserManager, browser_id: &str, url: &str) -> Result<(), String>`
  - `pub fn do_eval(app: &AppHandle, browser_id: &str, script: &str) -> Result<(), String>`
  - `pub fn do_simple_js(app: &AppHandle, browser_id: &str, js: &str) -> Result<(), String>` (for back/forward/reload)
  - `pub fn do_get_url(app: &AppHandle, browser_id: &str) -> Result<String, String>`
  - `pub fn do_close(app: &AppHandle, mgr: &BrowserManager, browser_id: &str) -> Result<(), String>`
  - Keep the existing `#[tauri::command]` fns but have them delegate to these.

- [ ] **Step 1: Extract the create logic into a free function**

In `src-tauri/src/commands/browser.rs`, add (above the `create_browser_window` command):
```rust
use crate::browser::BrowserManager;

/// Core window-creation logic shared by the Tauri command and the HTTP
/// control server. Returns the new browser_id.
pub fn do_create_browser_window(
    app: &AppHandle,
    mgr: &BrowserManager,
    url: &str,
) -> Result<String, String> {
    tracing::info!(url = %url, "do_create_browser_window");
    let parsed = url
        .parse()
        .map_err(|e| format!("Invalid URL '{}': {}", url, e))?;
    let browser_id = format!("browser-{}", uuid::Uuid::new_v4());
    WebviewWindowBuilder::new(app, &browser_id, WebviewUrl::External(parsed))
        .title("Browser")
        .inner_size(1024.0, 768.0)
        .build()
        .map_err(|e| format!("Failed to create browser window: {}", e))?;
    mgr.register(browser_id.clone(), url.to_string());
    Ok(browser_id)
}
```

- [ ] **Step 2: Add the other shared free functions**

Append to `src-tauri/src/commands/browser.rs`:
```rust
pub fn do_navigate(app: &AppHandle, mgr: &BrowserManager, browser_id: &str, url: &str) -> Result<(), String> {
    let parsed = url.parse().map_err(|e| format!("Invalid URL: {}", e))?;
    let win = get_browser(app, browser_id)?;
    win.navigate(parsed).map_err(|e| format!("Navigate failed: {}", e))?;
    mgr.set_url(browser_id, url.to_string());
    Ok(())
}

pub fn do_simple_js(app: &AppHandle, browser_id: &str, js: &str) -> Result<(), String> {
    let win = get_browser(app, browser_id)?;
    win.eval(js).map_err(|e| format!("eval failed: {}", e))
}

pub fn do_eval(app: &AppHandle, browser_id: &str, script: &str) -> Result<(), String> {
    let win = get_browser(app, browser_id)?;
    win.eval(script).map_err(|e| format!("eval failed: {}", e))
}

pub fn do_get_url(app: &AppHandle, browser_id: &str) -> Result<String, String> {
    let win = get_browser(app, browser_id)?;
    win.url().map(|u| u.to_string()).map_err(|e| format!("get_url failed: {}", e))
}

pub fn do_close(app: &AppHandle, mgr: &BrowserManager, browser_id: &str) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(browser_id) {
        win.close().map_err(|e| format!("Failed to close: {}", e))?;
    }
    mgr.unregister(browser_id);
    Ok(())
}
```

- [ ] **Step 3: Make `get_browser` pub(crate) so the control server can use it**

In `src-tauri/src/commands/browser.rs`, change `fn get_browser(` to `pub(crate) fn get_browser(`.

- [ ] **Step 4: Delegate the existing commands to the free functions**

Update the existing `#[tauri::command]` bodies to call the new functions. Example for `create_browser_window`:
```rust
#[tauri::command]
pub async fn create_browser_window(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<String, String> {
    do_create_browser_window(&app, &state.browser_manager, &url)
}
```
Do the same delegation for `browser_navigate` (→ `do_navigate`), `browser_back`/`forward`/`reload` (→ `do_simple_js` with `"history.back()"` etc.), `browser_get_url` (→ `do_get_url`), `close_browser_window` (→ `do_close`), `browser_eval` (→ `do_eval`).

- [ ] **Step 5: Verify build**

Run: `cd src-tauri && cargo build`
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/browser.rs
git commit -m "refactor(browser): extract window ops into reusable free functions

do_create_browser_window/do_navigate/do_eval/do_simple_js/do_get_url/do_close
shared by Tauri commands and (next) the HTTP control server. No behavior change.

Part of Phase 3C MCP bridge (Task 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: In-process axum HTTP control server

**Files:**
- Create: `src-tauri/src/browser/control_server.rs`
- Modify: `src-tauri/src/browser/mod.rs` (export)

**Interfaces:**
- Consumes: Task 1's `do_*` functions; `AppHandle`; `Arc<BrowserManager>`.
- Produces:
  - `pub struct BrowserControlInfo { pub port: u16, pub token: String }`
  - `pub async fn start_control_server(app: tauri::AppHandle, mgr: std::sync::Arc<BrowserManager>) -> anyhow::Result<BrowserControlInfo>` — binds `127.0.0.1:0`, returns the bound port + a freshly generated token, spawns the serve loop on the tokio runtime.
  - HTTP endpoints (all POST, JSON body, require `Authorization: Bearer <token>`):
    - `POST /open {url}` → `{browserId}`
    - `POST /navigate {browserId, url}` → `{ok:true}`
    - `POST /back|/forward|/reload {browserId}` → `{ok:true}`
    - `POST /eval {browserId, script}` → `{ok:true}`
    - `POST /close {browserId}` → `{ok:true}`
    - `POST /list {}` → `{windows:[{browserId,url}], count}`
    - `POST /get_url {browserId}` → `{url}`

- [ ] **Step 1: Write the control server with auth middleware**

Create `src-tauri/src/browser/control_server.rs`:
```rust
//! In-process HTTP control server for browser windows. Runs inside the Tauri
//! process (has AppHandle), bound to 127.0.0.1 on an ephemeral port with a
//! bearer-token guard. The browser_mcp.py stdio shim proxies MCP calls here,
//! letting ANY agent (built-in sidecar, Claude Code, Codex) drive browsers.

use crate::browser::BrowserManager;
use crate::commands::browser as ops;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Clone)]
struct Ctx {
    app: tauri::AppHandle,
    mgr: Arc<BrowserManager>,
    token: String,
}

pub struct BrowserControlInfo {
    pub port: u16,
    pub token: String,
}

fn check_auth(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|v| v == format!("Bearer {}", token))
        .unwrap_or(false)
}

fn arg_str(body: &Value, key: &str) -> Result<String, (StatusCode, String)> {
    body.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or((StatusCode::BAD_REQUEST, format!("missing '{}'", key)))
}

macro_rules! guard {
    ($headers:expr, $ctx:expr) => {
        if !check_auth(&$headers, &$ctx.token) {
            return (StatusCode::UNAUTHORIZED, Json(json!({"error": "unauthorized"}))).into_response();
        }
    };
}

async fn h_open(State(ctx): State<Ctx>, headers: HeaderMap, Json(body): Json<Value>) -> impl IntoResponse {
    guard!(headers, ctx);
    let url = match arg_str(&body, "url") { Ok(u) => u, Err((c, m)) => return (c, Json(json!({"error": m}))).into_response() };
    match ops::do_create_browser_window(&ctx.app, &ctx.mgr, &url) {
        Ok(id) => (StatusCode::OK, Json(json!({"browserId": id}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))).into_response(),
    }
}

async fn h_navigate(State(ctx): State<Ctx>, headers: HeaderMap, Json(body): Json<Value>) -> impl IntoResponse {
    guard!(headers, ctx);
    let id = match arg_str(&body, "browserId") { Ok(v) => v, Err((c, m)) => return (c, Json(json!({"error": m}))).into_response() };
    let url = match arg_str(&body, "url") { Ok(v) => v, Err((c, m)) => return (c, Json(json!({"error": m}))).into_response() };
    match ops::do_navigate(&ctx.app, &ctx.mgr, &id, &url) {
        Ok(()) => (StatusCode::OK, Json(json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))).into_response(),
    }
}

async fn h_simple(ctx: &Ctx, body: &Value, js: &str) -> axum::response::Response {
    let id = match arg_str(body, "browserId") { Ok(v) => v, Err((c, m)) => return (c, Json(json!({"error": m}))).into_response() };
    match ops::do_simple_js(&ctx.app, &id, js) {
        Ok(()) => (StatusCode::OK, Json(json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))).into_response(),
    }
}

async fn h_back(State(ctx): State<Ctx>, headers: HeaderMap, Json(body): Json<Value>) -> impl IntoResponse {
    guard!(headers, ctx);
    h_simple(&ctx, &body, "history.back()").await
}
async fn h_forward(State(ctx): State<Ctx>, headers: HeaderMap, Json(body): Json<Value>) -> impl IntoResponse {
    guard!(headers, ctx);
    h_simple(&ctx, &body, "history.forward()").await
}
async fn h_reload(State(ctx): State<Ctx>, headers: HeaderMap, Json(body): Json<Value>) -> impl IntoResponse {
    guard!(headers, ctx);
    h_simple(&ctx, &body, "location.reload()").await
}

async fn h_eval(State(ctx): State<Ctx>, headers: HeaderMap, Json(body): Json<Value>) -> impl IntoResponse {
    guard!(headers, ctx);
    let id = match arg_str(&body, "browserId") { Ok(v) => v, Err((c, m)) => return (c, Json(json!({"error": m}))).into_response() };
    let script = match arg_str(&body, "script") { Ok(v) => v, Err((c, m)) => return (c, Json(json!({"error": m}))).into_response() };
    match ops::do_eval(&ctx.app, &id, &script) {
        Ok(()) => (StatusCode::OK, Json(json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))).into_response(),
    }
}

async fn h_close(State(ctx): State<Ctx>, headers: HeaderMap, Json(body): Json<Value>) -> impl IntoResponse {
    guard!(headers, ctx);
    let id = match arg_str(&body, "browserId") { Ok(v) => v, Err((c, m)) => return (c, Json(json!({"error": m}))).into_response() };
    match ops::do_close(&ctx.app, &ctx.mgr, &id) {
        Ok(()) => (StatusCode::OK, Json(json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))).into_response(),
    }
}

async fn h_list(State(ctx): State<Ctx>, headers: HeaderMap, Json(_body): Json<Value>) -> impl IntoResponse {
    guard!(headers, ctx);
    let windows = ctx.mgr.list();
    (StatusCode::OK, Json(json!({"windows": windows, "count": windows.len()}))).into_response()
}

async fn h_get_url(State(ctx): State<Ctx>, headers: HeaderMap, Json(body): Json<Value>) -> impl IntoResponse {
    guard!(headers, ctx);
    let id = match arg_str(&body, "browserId") { Ok(v) => v, Err((c, m)) => return (c, Json(json!({"error": m}))).into_response() };
    match ops::do_get_url(&ctx.app, &id) {
        Ok(url) => (StatusCode::OK, Json(json!({"url": url}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))).into_response(),
    }
}

pub async fn start_control_server(
    app: tauri::AppHandle,
    mgr: Arc<BrowserManager>,
) -> anyhow::Result<BrowserControlInfo> {
    let token = uuid::Uuid::new_v4().to_string();
    let ctx = Ctx { app, mgr, token: token.clone() };

    let router = Router::new()
        .route("/open", post(h_open))
        .route("/navigate", post(h_navigate))
        .route("/back", post(h_back))
        .route("/forward", post(h_forward))
        .route("/reload", post(h_reload))
        .route("/eval", post(h_eval))
        .route("/close", post(h_close))
        .route("/list", post(h_list))
        .route("/get_url", post(h_get_url))
        .with_state(ctx);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            tracing::error!(error = %e, "browser control server stopped");
        }
    });

    tracing::info!(port = port, "browser control server listening on 127.0.0.1");
    Ok(BrowserControlInfo { port, token })
}
```

- [ ] **Step 2: Export from the browser module**

In `src-tauri/src/browser/mod.rs`, add:
```rust
pub mod control_server;
pub use control_server::{start_control_server, BrowserControlInfo};
```

- [ ] **Step 3: Verify build**

Run: `cd src-tauri && cargo build`
Expected: Build succeeds. (If axum's `Router` API differs, adjust handler signatures per axum 0.7 — handlers take extractors by value, `State` first.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/browser/control_server.rs src-tauri/src/browser/mod.rs
git commit -m "feat(browser): in-process axum control server (ephemeral port + token)

127.0.0.1:0 bind, bearer-token guard, endpoints open/navigate/back/forward/
reload/eval/close/list/get_url delegating to the shared do_* ops. This is the
in-Tauri target the MCP shim proxies to.

Part of Phase 3C MCP bridge (Task 2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Wire server startup + discovery file in lib.rs

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Task 2's `start_control_server`; `AppState.browser_manager`.
- Produces: at app startup, the control server runs; `~/Library/Application Support/ccie-terminal/browser-control.json` is written `{port, token}` (0600); the env for the MCP shim is available.

- [ ] **Step 1: Spawn the server inside `.setup()`**

In `src-tauri/src/lib.rs`, inside the `.setup(|app| { ... })` closure (after the menu wiring, near other `app.handle()` uses ~line 1005), add:
```rust
            // Phase 3C — start the in-process browser control server so the
            // browser_mcp.py shim (and thus all agents) can drive windows.
            {
                use tauri::Manager;
                let app_handle = app.handle().clone();
                let state = app_handle.state::<commands::AppState>();
                let mgr = state.browser_manager.clone();
                let db = state.db.clone();
                tauri::async_runtime::spawn(async move {
                    match crate::browser::start_control_server(app_handle.clone(), mgr).await {
                        Ok(info) => {
                            if let Err(e) = crate::browser::write_control_discovery(&info) {
                                tracing::error!(error = %e, "failed to write browser-control.json");
                            }
                            // Register the MCP shim using the shared DB handle.
                            if let Err(e) = commands::enable_browser_mcp_server(&db) {
                                tracing::error!(error = %e, "failed to register browser MCP server");
                            }
                        }
                        Err(e) => tracing::error!(error = %e, "failed to start browser control server"),
                    }
                });
            }
```

- [ ] **Step 2: Add the discovery-file writer to control_server.rs**

In `src-tauri/src/browser/control_server.rs`, add:
```rust
/// Path to the discovery file the MCP shim + external agents read.
pub fn discovery_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    std::path::PathBuf::from(home)
        .join("Library/Application Support/ccie-terminal/browser-control.json")
}

/// Write {port, token} to the discovery file with 0600 perms.
pub fn write_control_discovery(info: &BrowserControlInfo) -> anyhow::Result<()> {
    let path = discovery_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::json!({ "port": info.port, "token": info.token });
    std::fs::write(&path, serde_json::to_vec_pretty(&body)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    tracing::info!(path = %path.display(), "wrote browser-control discovery file");
    Ok(())
}
```
And export it in `src-tauri/src/browser/mod.rs`:
```rust
pub use control_server::{start_control_server, write_control_discovery, BrowserControlInfo, discovery_path};
```

- [ ] **Step 3: Build (will fail until Task 4 adds `enable_browser_mcp_server`)**

Run: `cd src-tauri && cargo build 2>&1 | grep -E "enable_browser_mcp_server|error" | head`
Expected: the ONLY error is `enable_browser_mcp_server` not found — that is added in Task 4. (If other errors appear, fix them.)

- [ ] **Step 4: Commit (compiles after Task 4 — commit the lib.rs + writer together with Task 4, OR stub the fn now)**

To keep this task independently committable, add a temporary stub in `src-tauri/src/commands/mod.rs`:
```rust
/// Registers the browser-control MCP shim. Real body added in Task 4.
/// Takes the shared DB handle (NOT a fresh connection) to avoid SQLite lock
/// contention with the app's primary connection.
pub fn enable_browser_mcp_server(
    _db: &std::sync::Arc<parking_lot::Mutex<rusqlite::Connection>>,
) -> Result<(), String> {
    Ok(())
}
```
Then:
```bash
cd src-tauri && cargo build   # must succeed
git add src-tauri/src/lib.rs src-tauri/src/browser/control_server.rs src-tauri/src/browser/mod.rs src-tauri/src/commands/mod.rs
git commit -m "feat(browser): start control server at boot + write discovery file

Spawn the control server in setup(); write {port,token} to
browser-control.json (0600). enable_browser_mcp_server stubbed (Task 4).

Part of Phase 3C MCP bridge (Task 3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Python MCP shim + auto-registration

**Files:**
- Create: `sidecar/src/ccie_sidecar/mcp_servers/browser_mcp.py`
- Modify: `src-tauri/src/commands/mod.rs` (replace the stub `enable_browser_mcp_server` with the real body)

**Interfaces:**
- Consumes: Task 3's discovery file; the proven `stealthwatch_mcp.py` structure; `sidecar_spawn_target()` (already in mod.rs, used by stealthwatch).
- Produces:
  - `browser_mcp.py` — stdio MCP server exposing the 9 browser tools, proxying to the HTTP control server (reads `browser-control.json` for port+token).
  - `enable_browser_mcp_server(info)` — upserts `mcp_servers` row id `browser-mcp` with `transport='stdio'`, `command_json={cmd: python, args:[browser_mcp.py path]}`.

- [ ] **Step 1: Write the Python shim**

Create `sidecar/src/ccie_sidecar/mcp_servers/browser_mcp.py`:
```python
#!/usr/bin/env python3
"""
Browser Control MCP Server (thin stdio shim).

Proxies MCP JSON-RPC tool calls to the CCIE Terminal in-process HTTP control
server (axum, 127.0.0.1, ephemeral port + bearer token). This lets ANY agent —
built-in CCIE agents, Claude Code, Codex — open and drive browser windows that
live inside the Tauri process. Mirrors stealthwatch_mcp.py's structure.

Discovery: reads {port, token} from
~/Library/Application Support/ccie-terminal/browser-control.json
(or the path in env BROWSER_CONTROL_CONFIG).
"""

import json
import os
import sys
import urllib.request
import urllib.error

def _discovery_path():
    env = os.environ.get("BROWSER_CONTROL_CONFIG")
    if env:
        return env
    home = os.environ.get("HOME", "/tmp")
    return os.path.join(home, "Library/Application Support/ccie-terminal/browser-control.json")

def _load_conn():
    with open(_discovery_path(), "r") as f:
        cfg = json.load(f)
    return cfg["port"], cfg["token"]

def _http_post(endpoint, payload):
    port, token = _load_conn()
    url = f"http://127.0.0.1:{port}{endpoint}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))

# tool name -> (endpoint, [required arg keys])
TOOLS = {
    "browser_open":     ("/open",     ["url"]),
    "browser_navigate": ("/navigate", ["browserId", "url"]),
    "browser_back":     ("/back",     ["browserId"]),
    "browser_forward":  ("/forward",  ["browserId"]),
    "browser_reload":   ("/reload",   ["browserId"]),
    "browser_eval":     ("/eval",     ["browserId", "script"]),
    "browser_close":    ("/close",    ["browserId"]),
    "browser_list":     ("/list",     []),
    "browser_get_url":  ("/get_url",  ["browserId"]),
}

TOOL_SCHEMAS = [
    {"name": "browser_open", "description": "Open a new browser window at a URL. Returns its browserId.",
     "inputSchema": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}},
    {"name": "browser_navigate", "description": "Navigate an open browser window to a URL.",
     "inputSchema": {"type": "object", "properties": {"browserId": {"type": "string"}, "url": {"type": "string"}}, "required": ["browserId", "url"]}},
    {"name": "browser_back", "description": "Go back in an open browser window's history.",
     "inputSchema": {"type": "object", "properties": {"browserId": {"type": "string"}}, "required": ["browserId"]}},
    {"name": "browser_forward", "description": "Go forward in an open browser window's history.",
     "inputSchema": {"type": "object", "properties": {"browserId": {"type": "string"}}, "required": ["browserId"]}},
    {"name": "browser_reload", "description": "Reload an open browser window.",
     "inputSchema": {"type": "object", "properties": {"browserId": {"type": "string"}}, "required": ["browserId"]}},
    {"name": "browser_eval", "description": "Run JavaScript in a browser window (fire-and-forget: click, type, scroll). No return value — external pages cannot return data.",
     "inputSchema": {"type": "object", "properties": {"browserId": {"type": "string"}, "script": {"type": "string"}}, "required": ["browserId", "script"]}},
    {"name": "browser_close", "description": "Close an open browser window.",
     "inputSchema": {"type": "object", "properties": {"browserId": {"type": "string"}}, "required": ["browserId"]}},
    {"name": "browser_list", "description": "List all open browser windows with their browserId and url.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "browser_get_url", "description": "Get the current URL of an open browser window.",
     "inputSchema": {"type": "object", "properties": {"browserId": {"type": "string"}}, "required": ["browserId"]}},
]

def handle_request(request):
    method = request.get("method")
    req_id = request.get("id")
    params = request.get("params", {})

    if method == "initialize":
        return {"jsonrpc": "2.0", "id": req_id, "result": {
            "protocolVersion": "2024-11-05",
            "serverInfo": {"name": "browser-mcp", "version": "1.0.0"},
            "capabilities": {"tools": {}},
        }}

    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOL_SCHEMAS}}

    if method == "tools/call":
        tool_name = params.get("name")
        arguments = params.get("arguments", {})
        if tool_name not in TOOLS:
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32602, "message": f"Unknown tool: {tool_name}"}}
        endpoint, required = TOOLS[tool_name]
        for k in required:
            if k not in arguments:
                return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32602, "message": f"Missing argument: {k}"}}
        try:
            result = _http_post(endpoint, arguments)
            return {"jsonrpc": "2.0", "id": req_id, "result": {
                "content": [{"type": "text", "text": json.dumps(result)}]
            }}
        except urllib.error.URLError as e:
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32000, "message": f"Browser control server unreachable: {e}. Is CCIE Terminal running?"}}
        except Exception as e:
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32000, "message": str(e)}}

    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": f"Method not found: {method}"}}

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            response = handle_request(request)
        except Exception as e:
            response = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": f"Parse error: {e}"}}
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()

if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Replace the stub `enable_browser_mcp_server`**

In `src-tauri/src/commands/mod.rs`, replace the Task 3 stub with:
```rust
/// Register the browser-control MCP shim in `mcp_servers` so built-in agents
/// can drive browser windows. Mirrors `enable_stealthwatch_mcp_server`. The
/// shim reads the discovery file for the live port+token, so no creds in env.
pub fn enable_browser_mcp_server(
    db: &std::sync::Arc<parking_lot::Mutex<rusqlite::Connection>>,
) -> Result<(), String> {
    let (python, _) = sidecar_spawn_target();
    let repo_root = std::env::var("CCIE_REPO_ROOT").unwrap_or_else(|_| {
        std::env::current_dir().unwrap().to_string_lossy().to_string()
    });
    let shim_path = format!("{}/sidecar/src/ccie_sidecar/mcp_servers/browser_mcp.py", repo_root);
    let command_json = serde_json::json!({ "cmd": python, "args": [shim_path] });

    // Use the shared DB handle (same as enable_stealthwatch_mcp_server) — do
    // NOT open a second connection (lock contention with the primary).
    let conn = db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO mcp_servers (id, name, transport, command_json, url, env_json, enabled)
         VALUES ('browser-mcp', 'Browser Control', 'stdio', ?1, NULL, NULL, 1)",
        rusqlite::params![serde_json::to_string(&command_json).unwrap()],
    ).map_err(|e| e.to_string())?;
    Ok(())
}
```

NOTE: This mirrors `enable_stealthwatch_mcp_server` exactly (it also takes `&Arc<Mutex<Connection>>`). Confirm `AppState.db` is `Arc<parking_lot::Mutex<rusqlite::Connection>>` (it is, per commands/mod.rs:165) — the `db.lock()` call is `parking_lot`, not async.

- [ ] **Step 3: Build**

Run: `cd src-tauri && cargo build`
Expected: succeeds (stub replaced).

- [ ] **Step 4: Smoke-test the shim offline**

Run (simulates an MCP client doing initialize + tools/list):
```bash
cd "/Users/shaunwhi/CCIE Terminal"
printf '%s\n%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | python3 sidecar/src/ccie_sidecar/mcp_servers/browser_mcp.py
```
Expected: two JSON-RPC responses; the second lists 9 browser tools. (tools/call would fail without the app running — that's the live test in Task 5.)

- [ ] **Step 5: Commit**

```bash
git add sidecar/src/ccie_sidecar/mcp_servers/browser_mcp.py src-tauri/src/commands/mod.rs
git commit -m "feat(browser): browser_mcp.py stdio shim + auto-register in mcp_servers

Thin MCP server proxying 9 browser tools to the in-process HTTP control
server. Auto-registered as 'browser-mcp' so built-in agents see it. Mirrors
stealthwatch_mcp.py. tools/list verified offline.

Part of Phase 3C MCP bridge (Task 4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: External-agent config UI + end-to-end verification

**Files:**
- Modify: `src-tauri/src/commands/mod.rs` (add `get_browser_mcp_config` command)
- Modify: `src-tauri/src/lib.rs` (register command)
- Create/Modify: `src/components/SettingsBrowserTab.tsx` (show + copy the external-agent config)

**Interfaces:**
- Consumes: discovery file path; shim path.
- Produces: `get_browser_mcp_config() -> { command: String, args: Vec<String> }` and a Settings panel showing the `claude mcp add` / Codex config snippet with a copy button.

- [ ] **Step 1: Add the config command**

In `src-tauri/src/commands/mod.rs`:
```rust
#[derive(serde::Serialize)]
pub struct BrowserMcpConfig {
    pub command: String,
    pub args: Vec<String>,
}

#[tauri::command]
pub async fn get_browser_mcp_config() -> Result<BrowserMcpConfig, String> {
    let (python, _) = sidecar_spawn_target();
    let repo_root = std::env::var("CCIE_REPO_ROOT").unwrap_or_else(|_| {
        std::env::current_dir().unwrap().to_string_lossy().to_string()
    });
    let shim_path = format!("{}/sidecar/src/ccie_sidecar/mcp_servers/browser_mcp.py", repo_root);
    Ok(BrowserMcpConfig { command: python, args: vec![shim_path] })
}
```

- [ ] **Step 2: Register the command**

In `src-tauri/src/lib.rs`, after `commands::browser::browser_eval,` add:
```rust
            commands::get_browser_mcp_config,
```

- [ ] **Step 3: Build**

Run: `cd src-tauri && cargo build`
Expected: succeeds.

- [ ] **Step 4: Add the config snippet to SettingsBrowserTab**

If `src/components/SettingsBrowserTab.tsx` exists (3D), add a section; else create a minimal component. Add a section that loads `get_browser_mcp_config` and shows:
```
claude mcp add browser-control -- <command> <args...>
```
with a "Copy" button (use `navigator.clipboard.writeText`). Also show the raw `{command, args}` for Codex/other clients.

```tsx
// inside the component
const [mcpCmd, setMcpCmd] = useState<string>('');
useEffect(() => {
  (async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const cfg = await invoke<{ command: string; args: string[] }>('get_browser_mcp_config');
    setMcpCmd(`claude mcp add browser-control -- ${cfg.command} ${cfg.args.join(' ')}`);
  })();
}, []);
// render mcpCmd in a <code> block with a Copy button:
//   <button onClick={() => navigator.clipboard.writeText(mcpCmd)}>Copy</button>
```

- [ ] **Step 5: Frontend tests + tsc**

Run: `npm test && npx tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: tests pass; TS error count not above the 42 baseline.

- [ ] **Step 6: LIVE end-to-end (built-in agent path)**

1. Restart `bun run tauri dev`.
2. Confirm the discovery file exists:
```bash
cat ~/Library/Application\ Support/ccie-terminal/browser-control.json
```
   Expected: `{"port": <n>, "token": "<uuid>"}`.
3. Confirm the app log shows `browser control server listening` and `wrote browser-control discovery file`.
4. Curl the control server directly (replace PORT/TOKEN):
```bash
curl -s -X POST http://127.0.0.1:PORT/open -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" -d '{"url":"https://example.com"}'
```
   Expected: `{"browserId":"browser-..."}` AND a browser window opens.
5. Pipe a tools/call through the shim to prove the full chain:
```bash
PORT=...; TOKEN=...;  # from the file
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"browser_open","arguments":{"url":"https://example.org"}}}' | python3 sidecar/src/ccie_sidecar/mcp_servers/browser_mcp.py
```
   Expected: JSON-RPC result with a `browserId`, AND a window opens at example.org.

- [ ] **Step 7: LIVE end-to-end (external agent path — Claude Code)**

1. In Settings → Browser, copy the `claude mcp add ...` snippet.
2. In a terminal, run it (registers the shim with Claude Code).
3. In Claude Code, ask it to "open https://example.com in a browser window" — it should call `browser_open` and a window opens.
4. Document the result (this is the whole point of the feature).

- [ ] **Step 8: Write the verification report**

Create `.git/sdd/phase-3c-mcp-bridge-verification.md` recording each step's result, the curl output, the shim output, and the Claude Code result. Note any gaps.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src/components/SettingsBrowserTab.tsx .git/sdd/phase-3c-mcp-bridge-verification.md
git commit -m "feat(browser): external-agent MCP config UI + e2e verification

get_browser_mcp_config command + Settings snippet to register browser-control
with Claude Code/Codex. Verified: curl -> window, shim -> window, and an
external agent driving a browser end-to-end.

Part of Phase 3C MCP bridge (Task 5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- All agents (built-in + external) control browsers → axum control server (Task 2) + shim (Task 4) + auto-register (Task 4) + external config (Task 5) ✅
- Reuse not duplicate window ops → shared `do_*` functions (Task 1) ✅
- Security (localhost + token) → Task 2 bind + guard, Task 3 0600 discovery file ✅
- 9 tools incl. fire-and-forget eval, no eval_result → Task 4 schemas ✅

**Placeholder scan:** Task 4 Step 2 flags an unknown (DB path resolution) with an explicit grep + fallback instruction — intentional, the implementer resolves the exact helper. No other TBDs.

**Type consistency:** `BrowserControlInfo {port, token}` consistent across Tasks 2-4. Tool names consistent between axum routes (Task 2), shim TOOLS map + schemas (Task 4). `browserId` camelCase used uniformly in HTTP payloads and shim args.

**Risk note:** axum 0.7 handler signatures and `axum::serve` are the main API-surface risk; Task 2 Step 3 calls for adjusting to the installed version if needed. The discovery-file approach avoids needing the ephemeral port at registration time (registration stores only the static shim command; the live port is read from the file at call time).
