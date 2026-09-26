use super::{
    CaptureSignal, FixBatch, InvestigationPlan, TerminalAgentManager,
    DEFAULT_COMMAND_TIMEOUT_SECONDS, MAX_CAPTURE_BYTES, MAX_COMMAND_TIMEOUT_SECONDS,
};
use crate::commands::AppState;
use crate::guardrails::{
    classifier::classify,
    decisions::{record_decision, DecisionRecord},
};
use crate::transcript_export::render_redacted_scrollback;
use axum::{
    extract::State as AxumState,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{net::TcpListener, sync::Arc, time::Duration};
use tauri::{AppHandle, Manager};

#[derive(Clone)]
struct GatewayState {
    app: AppHandle,
}

#[derive(Debug)]
struct GatewayError(String);

impl IntoResponse for GatewayError {
    fn into_response(self) -> Response {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": self.0 })),
        )
            .into_response()
    }
}

impl From<String> for GatewayError {
    fn from(value: String) -> Self {
        Self(value)
    }
}

#[derive(Debug, Deserialize)]
struct DiagnosticRequest {
    plan_step_id: String,
    command: String,
    purpose: String,
    timeout_seconds: Option<u64>,
}

#[derive(Debug, Serialize)]
struct CommandResult {
    command: String,
    purpose: String,
    output: String,
    exit_code: Option<i32>,
    timed_out: bool,
    truncated: bool,
}

#[derive(Debug, Deserialize)]
struct FixApprovalRequest {
    digest: String,
    batch: FixBatch,
}

#[derive(Debug, Serialize)]
struct FixExecutionResult {
    target: super::TerminalAttachment,
    commands: Vec<CommandResult>,
    verification: Vec<CommandResult>,
    rollback_commands: Vec<String>,
}

pub fn start(app: AppHandle, manager: Arc<TerminalAgentManager>) -> Result<String, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let address = listener.local_addr().map_err(|error| error.to_string())?;
    let base_url = format!("http://{address}/v1");
    manager.set_gateway_base_url(base_url.clone());

    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                tracing::error!(error = %error, "terminal-agent gateway listener failed");
                return;
            }
        };
        let router = Router::new()
            .route("/v1/context", post(read_context))
            .route("/v1/plan/begin", post(begin_plan))
            .route("/v1/plan/update", post(update_plan))
            .route("/v1/diagnostic", post(run_diagnostic))
            .route("/v1/fix/preview", post(preview_fix))
            .route("/v1/fix/approve", post(approve_fix))
            .route("/v1/fix/execute", post(execute_fix))
            .route("/v1/cancel", post(cancel))
            .with_state(GatewayState { app });
        if let Err(error) = axum::serve(listener, router).await {
            tracing::error!(error = %error, "terminal-agent gateway stopped");
        }
    });
    Ok(base_url)
}

async fn read_context(
    AxumState(gateway): AxumState<GatewayState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let capability = capability(&headers)?;
    let state = gateway.app.state::<AppState>();
    let target = state.terminal_agent.target(&capability, now())?;
    let raw = {
        let db = state.db.lock();
        crate::session::read_scrollback(&db, &target.backend_pty_id)
            .map_err(|error| GatewayError(error.to_string()))?
    };
    // Redact the complete stream before taking the bounded tail. Truncating
    // first could split a credential marker from its value at the boundary.
    let redacted =
        render_redacted_scrollback(&raw).map_err(|error| GatewayError(error.to_string()))?;
    let output = tail_utf8(&redacted, MAX_CAPTURE_BYTES).to_string();
    Ok(Json(
        serde_json::json!({ "target": target, "output": output }),
    ))
}

async fn begin_plan(
    AxumState(gateway): AxumState<GatewayState>,
    headers: HeaderMap,
    Json(plan): Json<InvestigationPlan>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let capability = capability(&headers)?;
    let state = gateway.app.state::<AppState>();
    state
        .terminal_agent
        .begin_investigation(&capability, plan.clone(), now())?;
    Ok(Json(serde_json::json!({ "plan": plan })))
}

async fn update_plan(
    AxumState(gateway): AxumState<GatewayState>,
    headers: HeaderMap,
    Json(plan): Json<InvestigationPlan>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let capability = capability(&headers)?;
    let state = gateway.app.state::<AppState>();
    state
        .terminal_agent
        .update_investigation(&capability, plan.clone(), now())?;
    Ok(Json(serde_json::json!({ "plan": plan })))
}

async fn run_diagnostic(
    AxumState(gateway): AxumState<GatewayState>,
    headers: HeaderMap,
    Json(request): Json<DiagnosticRequest>,
) -> Result<Json<CommandResult>, GatewayError> {
    let capability = capability(&headers)?;
    if request.plan_step_id.trim().is_empty() || request.purpose.trim().is_empty() {
        return Err(GatewayError(
            "diagnostic requires a plan step and purpose".into(),
        ));
    }
    let state = gateway.app.state::<AppState>();
    let target = state.terminal_agent.target(&capability, now())?;
    let evidence_hash = current_context_hash(&state, &target.backend_pty_id)?;
    {
        let rules = state.guardrails_ruleset.read();
        state.terminal_agent.authorize_diagnostic(
            &capability,
            &request.command,
            &evidence_hash,
            now(),
            &rules,
        )?;
        let decision = classify(
            &rules,
            target.vendor.as_deref().unwrap_or("generic"),
            target.platform.as_deref().unwrap_or("generic"),
            &request.command,
        );
        let db = state.db.lock();
        record_decision(
            &db,
            &DecisionRecord {
                id: String::new(),
                session_id: target.backend_pty_id.clone(),
                command: request.command.clone(),
                tier: decision.tier.as_u8(),
                rule_id: decision.rule_id,
                decision: "auto-run terminal diagnostic".into(),
                user_action: None,
                reasoning: decision.reasoning,
            },
        )
        .map_err(|error| GatewayError(error.to_string()))?;
    }
    let result = execute_command(
        &state,
        &capability,
        &target.backend_pty_id,
        &request.command,
        &request.purpose,
        target.vendor.as_deref().unwrap_or("generic"),
        request.timeout_seconds,
    )
    .await?;
    let evidence_hash = current_context_hash(&state, &target.backend_pty_id)?;
    state.terminal_agent.record_diagnostic_evidence(
        &capability,
        &request.command,
        &evidence_hash,
        now(),
    )?;
    Ok(Json(result))
}

async fn preview_fix(
    AxumState(gateway): AxumState<GatewayState>,
    headers: HeaderMap,
    Json(batch): Json<FixBatch>,
) -> Result<Json<super::FixPreview>, GatewayError> {
    let capability = capability(&headers)?;
    let state = gateway.app.state::<AppState>();
    let rules = state.guardrails_ruleset.read();
    Ok(Json(state.terminal_agent.preview_fix(
        &capability,
        batch,
        now(),
        &rules,
    )?))
}

async fn approve_fix(
    AxumState(gateway): AxumState<GatewayState>,
    headers: HeaderMap,
    Json(request): Json<FixApprovalRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let capability = capability(&headers)?;
    let state = gateway.app.state::<AppState>();
    state
        .terminal_agent
        .approve_fix(&capability, &request.digest, &request.batch, now())?;
    Ok(Json(serde_json::json!({ "approved": true })))
}

async fn execute_fix(
    AxumState(gateway): AxumState<GatewayState>,
    headers: HeaderMap,
    Json(batch): Json<FixBatch>,
) -> Result<Json<FixExecutionResult>, GatewayError> {
    let capability = capability(&headers)?;
    let state = gateway.app.state::<AppState>();
    let target = state.terminal_agent.target(&capability, now())?;
    let approved = state
        .terminal_agent
        .take_approved_fix(&capability, &batch, now())?;
    let mut commands = Vec::with_capacity(approved.commands.len());
    for command in &approved.commands {
        commands.push(
            execute_command(
                &state,
                &capability,
                &target.backend_pty_id,
                command,
                &approved.summary,
                target.vendor.as_deref().unwrap_or("generic"),
                None,
            )
            .await?,
        );
    }
    let mut verification = Vec::with_capacity(approved.verification_commands.len());
    for command in &approved.verification_commands {
        verification.push(
            execute_command(
                &state,
                &capability,
                &target.backend_pty_id,
                command,
                "automatic post-fix verification",
                target.vendor.as_deref().unwrap_or("generic"),
                None,
            )
            .await?,
        );
    }
    Ok(Json(FixExecutionResult {
        target,
        commands,
        verification,
        rollback_commands: approved.rollback_commands,
    }))
}

async fn cancel(
    AxumState(gateway): AxumState<GatewayState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let capability = capability(&headers)?;
    gateway
        .app
        .state::<AppState>()
        .terminal_agent
        .revoke(&capability, "stopped by operator");
    Ok(Json(serde_json::json!({ "cancelled": true })))
}

async fn execute_command(
    state: &AppState,
    capability: &str,
    backend_pty_id: &str,
    command: &str,
    purpose: &str,
    vendor: &str,
    timeout_seconds: Option<u64>,
) -> Result<CommandResult, GatewayError> {
    let mut receiver =
        state
            .terminal_agent
            .begin_capture_and_write(capability, backend_pty_id, now(), || {
                let ptys = state.ptys.lock();
                let handle = ptys
                    .get(backend_pty_id)
                    .ok_or_else(|| "attached PTY is no longer connected".to_string())?;
                handle
                    .write(format!("{command}\r").as_bytes())
                    .map_err(|error| error.to_string())
            })?;

    let timeout_seconds = timeout_seconds
        .unwrap_or(DEFAULT_COMMAND_TIMEOUT_SECONDS)
        .clamp(1, MAX_COMMAND_TIMEOUT_SECONDS);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_seconds);
    let mut prompt_seen: Option<tokio::time::Instant> = None;
    let mut prompt_buffer = Vec::new();
    let mut output = Vec::new();
    let mut exit_code = None;
    let mut truncated = false;
    let mut timed_out = false;

    loop {
        let instant_now = tokio::time::Instant::now();
        if instant_now >= deadline {
            timed_out = true;
            break;
        }
        let until = prompt_seen
            .map(|seen| (seen + Duration::from_secs(1)).min(deadline))
            .unwrap_or(deadline);
        match tokio::time::timeout_at(until, receiver.recv()).await {
            Ok(Some(CaptureSignal::Output(bytes))) => {
                let lower = String::from_utf8_lossy(&bytes).to_lowercase();
                if lower.contains("password:")
                    || lower.contains("passphrase")
                    || lower.contains("[confirm]")
                    || lower.contains("are you sure")
                {
                    state
                        .terminal_agent
                        .revoke(capability, "interactive credential or confirmation prompt");
                    state.terminal_agent.end_capture(backend_pty_id);
                    return Err(GatewayError(
                        "terminal command stopped at an interactive credential or confirmation prompt"
                            .into(),
                    ));
                }
                if lower.contains("--more--") {
                    let pager_write = state.terminal_agent.write_if_active(
                        capability,
                        backend_pty_id,
                        now(),
                        || {
                            let ptys = state.ptys.lock();
                            let handle = ptys
                                .get(backend_pty_id)
                                .ok_or_else(|| "attached PTY is no longer connected".to_string())?;
                            handle.write(b" ").map_err(|error| error.to_string())
                        },
                    );
                    if let Err(error) = pager_write {
                        state.terminal_agent.end_capture(backend_pty_id);
                        return Err(GatewayError(format!(
                            "terminal pager continuation stopped: {error}"
                        )));
                    }
                }
                prompt_buffer.extend_from_slice(&bytes);
                if prompt_buffer.len() > 8192 {
                    prompt_buffer.drain(..prompt_buffer.len() - 8192);
                }
                prompt_seen = render_redacted_scrollback(&prompt_buffer)
                    .ok()
                    .filter(|plain| looks_like_device_prompt(plain))
                    .map(|_| tokio::time::Instant::now());
                let remaining = MAX_CAPTURE_BYTES.saturating_sub(output.len());
                if bytes.len() > remaining {
                    output.extend_from_slice(&bytes[..remaining]);
                    truncated = true;
                } else {
                    output.extend_from_slice(&bytes);
                }
            }
            Ok(Some(CaptureSignal::CommandEnd(code))) => {
                exit_code = code;
                break;
            }
            Ok(None) => {
                state.terminal_agent.revoke(capability, "PTY disconnected");
                state.terminal_agent.end_capture(backend_pty_id);
                return Err(GatewayError("attached PTY disconnected".into()));
            }
            Err(_) if prompt_seen.is_some() => break,
            Err(_) => {
                timed_out = true;
                break;
            }
        }
    }
    state.terminal_agent.end_capture(backend_pty_id);
    if timed_out {
        state
            .terminal_agent
            .revoke(capability, "terminal command timeout");
        return Err(GatewayError(format!(
            "terminal command timed out after {timeout_seconds} seconds; lease revoked"
        )));
    }
    let output =
        render_redacted_scrollback(&output).map_err(|error| GatewayError(error.to_string()))?;
    if exit_code.is_some_and(|code| code != 0) {
        return Err(GatewayError(format!(
            "terminal command failed with exit code {}: {}",
            exit_code.unwrap_or_default(),
            output
        )));
    }
    if device_cli_error(vendor, &output) {
        return Err(GatewayError(format!(
            "terminal command was rejected by the device: {output}"
        )));
    }
    Ok(CommandResult {
        command: command.to_string(),
        purpose: purpose.to_string(),
        output,
        exit_code,
        timed_out,
        truncated,
    })
}

fn capability(headers: &HeaderMap) -> Result<String, GatewayError> {
    let value = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| GatewayError("missing terminal capability".into()))?;
    Ok(value.to_string())
}

fn current_context_hash(state: &AppState, backend_pty_id: &str) -> Result<String, GatewayError> {
    let raw = {
        let db = state.db.lock();
        crate::session::read_scrollback(&db, backend_pty_id)
            .map_err(|error| GatewayError(error.to_string()))?
    };
    let redacted =
        render_redacted_scrollback(&raw).map_err(|error| GatewayError(error.to_string()))?;
    Ok(hex::encode(Sha256::digest(
        tail_utf8(&redacted, MAX_CAPTURE_BYTES).as_bytes(),
    )))
}

fn tail_utf8(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut start = value.len() - max_bytes;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}

fn device_cli_error(vendor: &str, output: &str) -> bool {
    let vendor = vendor.to_ascii_lowercase();
    output.lines().any(|line| {
        let line = line
            .trim_start_matches(|character: char| character.is_ascii_whitespace())
            .trim_start_matches(['\u{1b}', '['])
            .trim();
        let lower = line.to_ascii_lowercase();
        if vendor.contains("junos") || vendor.contains("juniper") {
            return lower.starts_with("error:")
                || lower.starts_with("syntax error")
                || lower.starts_with("unknown command");
        }
        let percent_error = lower.starts_with("% invalid input")
            || lower.starts_with("% incomplete command")
            || lower.starts_with("% ambiguous command")
            || lower.starts_with("% authorization failed")
            || lower.starts_with("% error")
            || lower.starts_with("command rejected");
        if vendor.contains("arista") || vendor == "eos" {
            return percent_error
                || lower.starts_with("error:")
                || lower.starts_with("invalid input");
        }
        percent_error
    })
}

fn looks_like_device_prompt(output: &str) -> bool {
    let Some(line) = output.lines().rev().find(|line| !line.trim().is_empty()) else {
        return false;
    };
    let line = line.trim();
    line.len() < 128
        && !line.chars().any(char::is_whitespace)
        && matches!(line.chars().last(), Some('#' | '>' | '$' | '%'))
        && !line.starts_with('%')
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{device_cli_error, looks_like_device_prompt, tail_utf8};

    #[test]
    fn recognizes_vendor_cli_failures_without_matching_normal_status_text() {
        assert!(device_cli_error(
            "cisco",
            "% Invalid input detected at '^' marker."
        ));
        assert!(device_cli_error("cisco", "% Authorization failed."));
        assert!(device_cli_error(
            "junos",
            "error: syntax error, expecting <command>."
        ));
        assert!(!device_cli_error(
            "cisco",
            "RADIUS server error counters: 0\r\nCurrent state: UP"
        ));
    }

    #[test]
    fn utf8_tail_never_splits_a_character() {
        assert_eq!(tail_utf8("abc🔑def", 6), "def");
        assert_eq!(tail_utf8("abc🔑def", 7), "🔑def");
    }

    #[test]
    fn completion_requires_a_prompt_shaped_final_line() {
        assert!(looks_like_device_prompt("show aaa servers\r\nAccess-1#"));
        assert!(looks_like_device_prompt("output\r\nadmin@edge>"));
        assert!(!looks_like_device_prompt("Current state: DOWN"));
        assert!(!looks_like_device_prompt("Packet loss: 100%"));
        assert!(!looks_like_device_prompt("% Invalid input detected"));
    }
}
