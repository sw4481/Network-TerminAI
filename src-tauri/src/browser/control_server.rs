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

/// Report agent (claude/codex) lifecycle state for a pane. Called by the
/// agents' lifecycle hooks (a `curl` from the Stop / UserPromptSubmit / etc.
/// hook). Body: `{"paneId": "...", "agentType": "claude-code", "state": "working"|"waiting"|"idle"}`.
async fn h_agent_status(State(ctx): State<Ctx>, headers: HeaderMap, Json(body): Json<Value>) -> impl IntoResponse {
    use tauri::{Emitter, Manager};
    guard!(headers, ctx);
    let pane_id = match arg_str(&body, "paneId") { Ok(v) => v, Err((c, m)) => return (c, Json(json!({"error": m}))).into_response() };
    let state_str = match arg_str(&body, "state") { Ok(v) => v, Err((c, m)) => return (c, Json(json!({"error": m}))).into_response() };
    let agent_type = body.get("agentType").and_then(|v| v.as_str()).unwrap_or("agent");

    let status = match state_str.as_str() {
        "working" => crate::pane_context::AgentStatus::Working,
        "waiting" => crate::pane_context::AgentStatus::Waiting,
        "idle" => crate::pane_context::AgentStatus::Idle,
        other => return (StatusCode::BAD_REQUEST, Json(json!({"error": format!("invalid state: {}", other)}))).into_response(),
    };

    let app_state = ctx.app.state::<crate::commands::AppState>();
    app_state.pane_manager.set_agent_status(&pane_id, agent_type, status);

    // Push the updated activity so the indicator reacts in real time.
    if let Some(activity) = app_state.pane_manager.get_activity(&pane_id) {
        let _ = ctx.app.emit("pane_activity_updated", &activity);
    }
    let _ = ctx.app.emit("agent_session_updated", ());

    (StatusCode::OK, Json(json!({"ok": true}))).into_response()
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
        .route("/agent_status", post(h_agent_status))
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
