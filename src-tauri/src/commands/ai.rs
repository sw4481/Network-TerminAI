use crate::commands::AppState;
use crate::pane_context::build_pane_context_prompt;
use rusqlite::OptionalExtension;
use tauri::State;

/// One prior conversation turn forwarded to the sidecar for multi-turn context.
/// Mirrors the frontend `ChatTurn` (user/assistant role + content). Only
/// user/assistant turns are sent; tool lifecycle messages are excluded upstream.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct ChatTurn {
    pub role: String,
    pub content: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct CommandSuggestion {
    pub command: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct SuggestCommandResponse {
    pub suggestions: Vec<CommandSuggestion>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct NaturalToCommandResponse {
    pub command: String,
    pub explanation: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ErrorAnalysisResponse {
    pub error_type: String,
    pub explanation: String,
    pub suggestions: Vec<String>,
}

/// Extract the fields of a `diagram` sidecar event into a typed tuple.
/// Shared by the code-exec and react-code stream closures so the parsing
/// stays in one place. Returns (title, format, xml, source, url, image_url).
fn parse_diagram_event(
    ev: &serde_json::Value,
) -> (
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
) {
    let title = ev
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("diagram")
        .to_string();
    let format = ev
        .get("format")
        .and_then(|v| v.as_str())
        .unwrap_or("xml")
        .to_string();
    let xml = ev.get("xml").and_then(|v| v.as_str()).map(String::from);
    let source = ev.get("source").and_then(|v| v.as_str()).map(String::from);
    let url = ev
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // image_url carries a Kroki SVG (often a data: URI) for format "image";
    // markmap renders from `source`, so it may be absent. Forward when present.
    let image_url = ev
        .get("image_url")
        .and_then(|v| v.as_str())
        .map(String::from);
    (title, format, xml, source, url, image_url)
}

fn attach_topolograph_runtime_binding(
    params: &mut serde_json::Value,
    agent_id: &str,
    binding: Option<serde_json::Value>,
) {
    if matches!(agent_id, "network-architect" | "topolograph") {
        if let Some(binding) = binding {
            params["topolograph_runtime"] = binding;
        }
    }
}

fn resolve_topolograph_runtime_binding_with<D, A>(
    agent_id: &str,
    dedicated_binding: D,
    architect_binding: A,
) -> Result<Option<serde_json::Value>, String>
where
    D: FnOnce() -> Result<serde_json::Value, String>,
    A: FnOnce() -> Option<serde_json::Value>,
{
    match agent_id {
        "topolograph" => dedicated_binding().map(Some),
        "network-architect" => Ok(architect_binding()),
        _ => Ok(None),
    }
}

fn resolve_topolograph_runtime_binding(
    state: &AppState,
    agent_id: &str,
) -> Result<Option<serde_json::Value>, String> {
    resolve_topolograph_runtime_binding_with(
        agent_id,
        || crate::commands::topolograph::topolograph_dedicated_runtime_binding(state),
        || crate::commands::topolograph::topolograph_architect_runtime_binding(state),
    )
}

fn should_retrieve_attached_tool_vault(
    _agent_id: &str,
    tool_id: &str,
    vault_entry: &str,
) -> bool {
    !vault_entry.is_empty() && tool_id != "topolograph"
}

const SOUL_FILE_CHAR_CAP: usize = 20_000;

fn append_soul_files_from_dir(
    agent_id: &str,
    system_prompt: String,
    dir: &std::path::Path,
) -> String {
    if agent_id != "network-architect" {
        return system_prompt;
    }

    let mut paths = match std::fs::read_dir(dir) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().map(|t| t.is_file()).unwrap_or(false))
            .filter(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                name.starts_with("SOUL") && name.ends_with(".md")
            })
            .map(|entry| entry.path())
            .collect::<Vec<_>>(),
        Err(_) => return system_prompt,
    };
    paths.sort_by_key(|path| {
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default();
        (name != "SOUL.md", name.to_string())
    });

    let mut prompt = system_prompt;
    for path in paths {
        let Ok(mut content) = std::fs::read_to_string(&path) else { continue };
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else { continue };
        content = content.trim().to_string();
        if content.is_empty() {
            continue;
        }
        if content.chars().count() > SOUL_FILE_CHAR_CAP {
            content = content.chars().take(SOUL_FILE_CHAR_CAP).collect::<String>() + "\n…(truncated)";
        }
        prompt.push_str("\n\n---\n");
        prompt.push_str(name);
        prompt.push_str("\n---\n");
        prompt.push_str(&content);
    }
    prompt
}

fn append_installed_soul_files(agent_id: &str, system_prompt: String) -> String {
    let dir = match crate::agents::default_agents_dir() {
        Ok(dir) => dir.join(agent_id),
        Err(_) => return system_prompt,
    };
    append_soul_files_from_dir(agent_id, system_prompt, &dir)
}

fn build_agent_react_run_params(
    agent_id: &str,
    message: String,
    history: Vec<ChatTurn>,
    system_prompt: String,
    tools: serde_json::Value,
    vault_entry: String,
    vault_secrets: Option<std::collections::HashMap<String, String>>,
    engine: Option<String>,
    stream_output: bool,
    topolograph_runtime: Option<serde_json::Value>,
) -> serde_json::Value {
    let mut params = serde_json::json!({
        "agent_id": agent_id,
        "message": message,
        "history": history,
        "system_prompt": append_installed_soul_files(agent_id, system_prompt),
        "tools": tools,
        "vault_entry": vault_entry,
        "vault_secrets": vault_secrets,
        "engine": engine,
        "stream_output": stream_output,
    });
    attach_topolograph_runtime_binding(&mut params, agent_id, topolograph_runtime);
    params
}

fn build_agent_react_code_run_params(
    agent_id: &str,
    message: String,
    history: Vec<ChatTurn>,
    system_prompt: String,
    tool_id: String,
    vault_secrets: Option<std::collections::HashMap<String, String>>,
    engine: Option<String>,
    stream_output: bool,
    run_id: String,
    topolograph_runtime: Option<serde_json::Value>,
) -> serde_json::Value {
    let mut params = serde_json::json!({
        "agent_id": agent_id,
        "message": message,
        "history": history,
        "system_prompt": append_installed_soul_files(agent_id, system_prompt),
        "tool_id": tool_id,
        "vault_secrets": vault_secrets,
        "engine": engine,
        "stream_output": stream_output,
        "run_id": run_id,
    });
    attach_topolograph_runtime_binding(&mut params, agent_id, topolograph_runtime);
    params
}

/// Events emitted during code execution agent loop
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CodeExecEvent {
    /// LLM generated code, about to execute
    CodeStart { code: String },
    /// Code is executing
    CodeExecuting,
    /// Code execution completed (success or error)
    CodeResult { success: bool, output: String },
    /// Code execution failed, retrying
    CodeError { error: String, attempt: u32 },
    /// LLM generated final response
    Final { response: String },
    /// Agent produced a diagram (draw.io / Kroki image / markmap) — rendered
    /// inline + open-in-browser.
    Diagram {
        title: String,
        format: String,
        xml: Option<String>,
        source: Option<String>,
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        image_url: Option<String>,
    },
    /// Fatal error, giving up
    Error { message: String },
}

/// Get command suggestions from history based on partial input.
/// Uses frequency + recency scoring to rank suggestions.
#[tauri::command]
pub fn get_history_suggestions(
    state: State<'_, AppState>,
    partial: String,
    limit: usize,
) -> Result<Vec<CommandSuggestion>, String> {
    use rusqlite::params;

    let conn = state.db.lock();

    // Fuzzy match against command history with frequency + recency scoring
    let mut stmt = conn
        .prepare(
            "SELECT
            cmd,
            COUNT(*) as frequency,
            MAX(started_at) as last_used,
            AVG(CASE WHEN exit_code = 0 THEN 1.0 ELSE 0.0 END) as success_rate
         FROM command_blocks
         WHERE cmd LIKE ? || '%'
         GROUP BY cmd
         ORDER BY frequency DESC, last_used DESC
         LIMIT ?",
        )
        .map_err(|e| e.to_string())?;

    let pattern = partial.trim();
    let suggestions: Vec<CommandSuggestion> = stmt
        .query_map(params![pattern, limit], |row| {
            let cmd: String = row.get(0)?;
            let frequency: i64 = row.get(1)?;
            let success_rate: f64 = row.get(3)?;

            let description = if success_rate >= 0.8 {
                format!(
                    "Used {} times ({}% success)",
                    frequency,
                    (success_rate * 100.0) as i32
                )
            } else {
                format!("Used {} times", frequency)
            };

            Ok(CommandSuggestion {
                command: cmd,
                description,
                category: Some("history".to_string()),
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(suggestions)
}

#[tauri::command]
pub async fn ai_suggest_command(
    state: State<'_, AppState>,
    partial_command: String,
    cwd: String,
) -> Result<SuggestCommandResponse, String> {
    let params = serde_json::json!({
        "partial_command": partial_command,
        "cwd": cwd,
    });

    let resp = state
        .agent
        .call("suggest_command", params)
        .await
        .map_err(|e| e.to_string())?;

    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => {
            serde_json::from_value(result).map_err(|e| format!("Failed to parse response: {}", e))
        }
        crate::agent_bridge::AgentResponse::Error { message } => Err(message),
        _ => Err("unexpected response type".to_string()),
    }
}

#[tauri::command]
pub async fn ai_natural_to_command(
    state: State<'_, AppState>,
    natural_language: String,
    cwd: String,
    tab_id: String,
    pane_id: Option<String>,
) -> Result<NaturalToCommandResponse, String> {
    // Build pane context
    let pane_context = build_pane_context_prompt(&state.pane_manager, &tab_id, pane_id.as_deref());

    let mut params = serde_json::json!({
        "natural_language": natural_language,
        "cwd": cwd,
    });
    if !pane_context.is_empty() {
        params["pane_context"] = serde_json::json!(pane_context);
    }

    let resp = state
        .agent
        .call("natural_to_command", params)
        .await
        .map_err(|e| e.to_string())?;

    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => {
            serde_json::from_value(result).map_err(|e| format!("Failed to parse response: {}", e))
        }
        crate::agent_bridge::AgentResponse::Error { message } => Err(message),
        _ => Err("unexpected response type".to_string()),
    }
}

#[tauri::command]
pub async fn ai_analyze_error(
    state: State<'_, AppState>,
    command: String,
    output: String,
    exit_code: i32,
    cwd: String,
    tab_id: String,
    pane_id: Option<String>,
) -> Result<ErrorAnalysisResponse, String> {
    // Build pane context
    let pane_context = build_pane_context_prompt(&state.pane_manager, &tab_id, pane_id.as_deref());

    let mut params = serde_json::json!({
        "command": command,
        "output": output,
        "exit_code": exit_code,
        "cwd": cwd,
    });

    if !pane_context.is_empty() {
        params["pane_context"] = serde_json::json!(pane_context);
    }

    let resp = state
        .agent
        .call("analyze_error", params)
        .await
        .map_err(|e| e.to_string())?;

    match resp {
        crate::agent_bridge::AgentResponse::Done { result } => {
            serde_json::from_value(result).map_err(|e| format!("Failed to parse response: {}", e))
        }
        crate::agent_bridge::AgentResponse::Error { message } => Err(message),
        _ => Err("unexpected response type".to_string()),
    }
}

/// ReACT loop event types that can be emitted by the sidecar
#[derive(Debug, serde::Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReactEvent {
    ThoughtStart {
        thought: String,
        step: i32,
    },
    ToolCall {
        name: String,
        args: serde_json::Value,
        blast_radius: String,
    },
    ToolResult {
        success: bool,
        result: String,
    },
    Token {
        text: String,
    },
    Final {
        response: String,
    },
    Diagram {
        title: String,
        format: String,
        xml: Option<String>,
        source: Option<String>,
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        image_url: Option<String>,
    },
    Error {
        message: String,
    },
    /// The DeepAgents run reached one bounded execution segment while still
    /// progressing. The opaque thread id resumes the exact saved checkpoint.
    ContinuationAvailable {
        thread_id: String,
        reason: String,
    },
    /// IaC Phase 2 — the agent paused on a gated iac_apply. The frontend shows
    /// an approval modal with the blast-radius classification, then calls
    /// `agent_react_resume` with the decision to continue or abort.
    IacApprovalRequest {
        thread_id: String,
        command: String,
        working_dir: String,
        tool: String,
        classification: serde_json::Value,
    },
    TerminalControlStarted {
        lease_id: String,
        target: crate::terminal_agent::TerminalAttachment,
    },
    TerminalInvestigationPlan {
        plan: serde_json::Value,
        updated: bool,
    },
    TerminalCommandStart {
        plan_step_id: String,
        command: String,
        purpose: String,
    },
    TerminalCommandResult {
        plan_step_id: String,
        command: String,
        success: bool,
        result: serde_json::Value,
    },
    TerminalFixApprovalRequest {
        thread_id: String,
        preview: serde_json::Value,
    },
    TerminalLeaseEnded {
        reason: String,
    },
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

fn validate_terminal_attachment(
    state: &AppState,
    mut attachment: crate::terminal_agent::TerminalAttachment,
) -> Result<crate::terminal_agent::TerminalAttachment, String> {
    if state.pane_manager.get_focused_pane_id().as_deref()
        != Some(attachment.backend_pty_id.as_str())
    {
        return Err("terminal attachment no longer matches the focused PTY".into());
    }
    let foreground_identity = {
        let ptys = state.ptys.lock();
        let handle = ptys
            .get(&attachment.backend_pty_id)
            .ok_or_else(|| "attached terminal PTY is no longer active".to_string())?;
        handle
            .foreground_process_group_id()
            .zip(handle.foreground_process_name())
    };

    match attachment.source.as_str() {
        "saved_ssh" => {
            let requested_connection_id = attachment
                .connection_id
                .as_deref()
                .ok_or_else(|| "saved SSH attachment requires a connection identity".to_string())?;
            let (live_process_group_id, foreground) =
                foreground_identity.as_ref().ok_or_else(|| {
                    "could not verify the saved terminal foreground process".to_string()
                })?;
            let executable = foreground
                .split_whitespace()
                .next()
                .and_then(|value| value.rsplit('/').next())
                .unwrap_or("");
            if executable != "ssh" {
                return Err(
                    "saved terminal attachment requires a verified foreground ssh process".into(),
                );
            }
            let connection_id = state
                .terminal_agent
                .saved_ssh_binding(&attachment.backend_pty_id, *live_process_group_id)
                .ok_or_else(|| {
                    "saved SSH attachment is not bound to this PTY process generation".to_string()
                })?;
            if requested_connection_id != connection_id {
                return Err("saved SSH attachment does not match the backend PTY binding".into());
            }
            let metadata: Option<(String, String, String)> = state
                .db
                .lock()
                .query_row(
                    "SELECT name, vendor, platform FROM ssh_connections WHERE id = ?1",
                    rusqlite::params![&connection_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            let (name, vendor, platform) =
                metadata.ok_or_else(|| "saved SSH connection no longer exists".to_string())?;
            attachment.display_name = Some(name);
            attachment.vendor = Some(vendor);
            attachment.platform = Some(platform);
            attachment.connection_id = Some(connection_id);
        }
        "manual_ssh" => {
            #[cfg(target_os = "macos")]
            {
                let (live_process_group_id, foreground) = foreground_identity.ok_or_else(|| {
                    "could not verify the manual terminal foreground process".to_string()
                })?;
                if state
                    .terminal_agent
                    .saved_ssh_binding(&attachment.backend_pty_id, live_process_group_id)
                    .is_some()
                {
                    return Err("this PTY is backend-bound to a saved SSH connection".into());
                }
                let executable = foreground
                    .split_whitespace()
                    .next()
                    .and_then(|value| value.rsplit('/').next())
                    .unwrap_or("");
                if executable != "ssh" {
                    return Err(
                        "manual terminal attachment requires a verified foreground ssh process"
                            .into(),
                    );
                }
                attachment
                    .vendor
                    .get_or_insert_with(|| "generic".to_string());
                attachment
                    .platform
                    .get_or_insert_with(|| "generic".to_string());
            }
            #[cfg(not(target_os = "macos"))]
            {
                return Err("manual SSH terminal verification is not supported on this OS".into());
            }
        }
        _ => return Err("unsupported terminal attachment source".into()),
    }
    Ok(attachment)
}

/// Run a ReACT agent loop with attached tools (Meraki CLI, etc.)
#[tauri::command]
pub async fn agent_react_run(
    agent_id: String,
    message: String,
    history: Option<Vec<ChatTurn>>,
    tab_id: Option<String>,
    pane_id: Option<String>,
    stream_output: Option<bool>,
    state: State<'_, AppState>,
    on_event: tauri::ipc::Channel<ReactEvent>,
) -> Result<(), String> {
    use crate::agents::Agent;

    let history = history.unwrap_or_default();
    tracing::info!(agent_id = %agent_id, message_len = message.len(), history_len = history.len(), "agent_react_run starting");

    // 1. Load agent definition with attached_tools
    let agent: Agent = state
        .agents_loader
        .get(&agent_id)
        .ok_or_else(|| format!("Agent '{}' not found", agent_id))?;

    if agent.attached_tools.is_empty() && agent.id != "network-architect" {
        return Err("Agent has no attached tools configured".to_string());
    }

    // 2. Load tool catalog from first attached tool
    let (catalog, vault_entry, vault_secrets) = if let Some(tool_def) = agent.attached_tools.first() {
        let catalog_json = std::fs::read_to_string(&tool_def.catalog)
            .map_err(|e| format!("Failed to read tool catalog {}: {}", tool_def.catalog, e))?;
        let catalog: serde_json::Value = serde_json::from_str(&catalog_json)
            .map_err(|e| format!("Failed to parse tool catalog: {}", e))?;
        let vault_secrets = if should_retrieve_attached_tool_vault(
            &agent.id,
            &tool_def.id,
            &tool_def.vault_entry,
        ) {
            match _retrieve_vault_secrets(&state, &tool_def.vault_entry).await {
                Ok(secrets) => Some(secrets),
                Err(e) => return Err(format!("Vault error: {}", e)),
            }
        } else {
            None
        };
        (catalog, tool_def.vault_entry.clone(), vault_secrets)
    } else {
        (serde_json::json!([]), String::new(), None)
    };

    // 4. Build pane context if tab_id provided
    let pane_context = if let Some(ref tid) = tab_id {
        build_pane_context_prompt(&state.pane_manager, tid, pane_id.as_deref())
    } else {
        String::new()
    };

    // 5. Call Python sidecar method "agent.react_loop"
    let topolograph_runtime = resolve_topolograph_runtime_binding(&state, &agent.id)?;
    let mut params = build_agent_react_run_params(
        &agent_id,
        message,
        history,
        agent.system_prompt.clone(),
        catalog,
        vault_entry,
        vault_secrets,
        agent.engine.clone(),
        stream_output.unwrap_or(false),
        topolograph_runtime,
    );
    if !pane_context.is_empty() {
        params["pane_context"] = serde_json::json!(pane_context);
    }

    tracing::info!("Calling sidecar agent.react_loop");

    // 6. Stream events back via emit
    let on_event_clone = on_event.clone();
    let result = state
        .agent
        .call_stream_ex("agent.react_loop", params, move |ev| {
            let ev_type = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
            tracing::debug!(event_type = %ev_type, "Received ReACT event");

            match ev_type {
                "thought_start" => {
                    if let Some(thought) = ev.get("thought").and_then(|v| v.as_str()) {
                        let step = ev.get("step").and_then(|v| v.as_u64()).unwrap_or(0) as i32;
                        let _ = on_event_clone.send(ReactEvent::ThoughtStart {
                            thought: thought.to_string(),
                            step,
                        });
                    }
                }
                "tool_call" => {
                    let name = ev
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let args = ev.get("args").cloned().unwrap_or(serde_json::Value::Null);
                    let blast_radius = ev
                        .get("blast_radius")
                        .and_then(|v| v.as_str())
                        .unwrap_or("low")
                        .to_string();

                    let _ = on_event_clone.send(ReactEvent::ToolCall {
                        name,
                        args,
                        blast_radius,
                    });
                }
                "tool_result" => {
                    let success = ev.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
                    let result = ev
                        .get("result")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();

                    let _ = on_event_clone.send(ReactEvent::ToolResult { success, result });
                }
                "token" => {
                    if let Some(text) = ev.get("text").and_then(|v| v.as_str()) {
                        let _ = on_event_clone.send(ReactEvent::Token {
                            text: text.to_string(),
                        });
                    }
                }
                "final" => {
                    if let Some(response) = ev.get("response").and_then(|v| v.as_str()) {
                        let _ = on_event_clone.send(ReactEvent::Final {
                            response: response.to_string(),
                        });
                    }
                }
                "error" => {
                    if let Some(message) = ev.get("message").and_then(|v| v.as_str()) {
                        let _ = on_event_clone.send(ReactEvent::Error {
                            message: message.to_string(),
                        });
                    }
                }
                _ => {
                    tracing::warn!(event_type = %ev_type, "Unknown ReACT event type");
                }
            }
            Ok(())
        })
        .await;

    match result {
        Ok(_) => {
            tracing::info!("agent_react_run completed successfully");
            Ok(())
        }
        Err(e) => {
            tracing::error!(error = %e, "agent_react_run failed");
            let _ = on_event.send(ReactEvent::Error {
                message: e.to_string(),
            });
            Err(e.to_string())
        }
    }
}

/// Run a code execution agent loop that writes/runs code iteratively until success
#[tauri::command]
pub async fn agent_code_exec_run(
    agent_id: String,
    message: String,
    history: Option<Vec<ChatTurn>>,
    tab_id: Option<String>,
    pane_id: Option<String>,
    state: State<'_, AppState>,
    on_event: tauri::ipc::Channel<CodeExecEvent>,
) -> Result<(), String> {
    use crate::agents::Agent;

    let history = history.unwrap_or_default();
    tracing::info!(agent_id = %agent_id, message_len = message.len(), history_len = history.len(), "agent_code_exec_run starting");

    // 1. Load agent definition with attached_tools
    let agent: Agent = state
        .agents_loader
        .get(&agent_id)
        .ok_or_else(|| format!("Agent '{}' not found", agent_id))?;

    // 2. Validate execution_mode is "code"
    if agent.execution_mode.as_deref() != Some("code") {
        return Err(format!(
            "Agent '{}' has execution_mode '{}', expected 'code'",
            agent_id,
            agent.execution_mode.as_deref().unwrap_or("react")
        ));
    }

    // 3. Attached tools are optional for code execution mode
    // Agents can use basic Python sandbox (pandas, json, datetime) without CLI tools
    let (tool_id, vault_entry, vault_secrets) = if !agent.attached_tools.is_empty() {
        let tool_def = &agent.attached_tools[0];

        // Load tool catalog (not used in code mode but kept for consistency)
        let catalog_json = std::fs::read_to_string(&tool_def.catalog)
            .map_err(|e| format!("Failed to read tool catalog {}: {}", tool_def.catalog, e))?;
        let _catalog: serde_json::Value = serde_json::from_str(&catalog_json)
            .map_err(|e| format!("Failed to parse tool catalog: {}", e))?;

        // Retrieve credentials from vault
        let secrets = if !tool_def.vault_entry.is_empty() {
            tracing::info!(
                "Attempting to retrieve vault secrets for envelope: {}",
                tool_def.vault_entry
            );
            match _retrieve_vault_secrets(&state, &tool_def.vault_entry).await {
                Ok(secrets) => {
                    tracing::info!("Successfully retrieved {} vault secrets", secrets.len());
                    for key in secrets.keys() {
                        tracing::info!("  - Secret: {}", key);
                    }
                    Some(secrets)
                }
                Err(e) => {
                    tracing::error!(
                        "Failed to retrieve vault secrets for {}: {}",
                        tool_def.vault_entry,
                        e
                    );
                    return Err(format!("Vault error: {}", e));
                }
            }
        } else {
            tracing::info!("No vault entry configured for this agent");
            None
        };

        (tool_def.id.clone(), tool_def.vault_entry.clone(), secrets)
    } else {
        tracing::info!("No attached tools - using basic Python sandbox");
        (String::new(), String::new(), None)
    };

    // 4. Build pane context if tab_id provided
    let pane_context = if let Some(ref tid) = tab_id {
        build_pane_context_prompt(&state.pane_manager, tid, pane_id.as_deref())
    } else {
        String::new()
    };

    // 5. Call Python sidecar method "agent.code_exec_loop"
    let mut params = serde_json::json!({
        "agent_id": agent_id,
        "message": message,
        "history": history,
        "system_prompt": append_installed_soul_files(&agent_id, agent.system_prompt),
        "tool_id": tool_id,
        "vault_entry": vault_entry,
        "vault_secrets": vault_secrets,
    });

    if !pane_context.is_empty() {
        params["pane_context"] = serde_json::json!(pane_context);
    }

    tracing::info!("Calling sidecar agent.code_exec_loop");

    // 6. Stream events back via emit
    let on_event_clone = on_event.clone();
    let result = state
        .agent
        .call_stream_ex("agent.code_exec_loop", params, move |ev| {
            let ev_type = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
            tracing::debug!(event_type = %ev_type, "Received CodeExec event");

            match ev_type {
                "code_start" => {
                    if let Some(code) = ev.get("code").and_then(|v| v.as_str()) {
                        let _ = on_event_clone.send(CodeExecEvent::CodeStart {
                            code: code.to_string(),
                        });
                    }
                }
                "code_executing" => {
                    let _ = on_event_clone.send(CodeExecEvent::CodeExecuting);
                }
                "code_result" => {
                    let success = ev.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
                    let output = ev
                        .get("output")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();

                    let _ = on_event_clone.send(CodeExecEvent::CodeResult { success, output });
                }
                "code_error" => {
                    let error = ev
                        .get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let attempt = ev.get("attempt").and_then(|v| v.as_u64()).unwrap_or(0) as u32;

                    let _ = on_event_clone.send(CodeExecEvent::CodeError { error, attempt });
                }
                "final" => {
                    if let Some(response) = ev.get("response").and_then(|v| v.as_str()) {
                        let _ = on_event_clone.send(CodeExecEvent::Final {
                            response: response.to_string(),
                        });
                    }
                }
                "diagram" => {
                    let (title, format, xml, source, url, image_url) = parse_diagram_event(ev);
                    let _ = on_event_clone.send(CodeExecEvent::Diagram {
                        title,
                        format,
                        xml,
                        source,
                        url,
                        image_url,
                    });
                }
                "error" => {
                    if let Some(message) = ev.get("message").and_then(|v| v.as_str()) {
                        let _ = on_event_clone.send(CodeExecEvent::Error {
                            message: message.to_string(),
                        });
                    }
                }
                _ => {
                    tracing::warn!(event_type = %ev_type, "Unknown CodeExec event type");
                }
            }
            Ok(())
        })
        .await;

    match result {
        Ok(_) => {
            tracing::info!("agent_code_exec_run completed successfully");
            Ok(())
        }
        Err(e) => {
            tracing::error!(error = %e, "agent_code_exec_run failed");
            let _ = on_event.send(CodeExecEvent::Error {
                message: e.to_string(),
            });
            Err(e.to_string())
        }
    }
}

/// Run ReACT loop with code execution as the tool (hybrid mode).
///
/// This command combines ReACT reasoning with code execution:
/// 1. Agent reasons about what to do next
/// 2. Writes Python code using execute_python_code tool
/// 3. Observes results
/// 4. Iterates until it has enough information to answer
///
/// Unlike pure code-exec mode, this mode allows the agent to reason between
/// code executions and decide when it has enough information to answer.
#[tauri::command]
pub async fn agent_react_code_run(
    agent_id: String,
    message: String,
    history: Option<Vec<ChatTurn>>,
    tab_id: Option<String>,
    pane_id: Option<String>,
    stream_output: Option<bool>,
    terminal_attachment: Option<crate::terminal_agent::TerminalAttachment>,
    state: State<'_, AppState>,
    on_event: tauri::ipc::Channel<ReactEvent>,
) -> Result<(), String> {
    use crate::agents::Agent;

    let history = history.unwrap_or_default();
    tracing::info!(agent_id = %agent_id, message_len = message.len(), history_len = history.len(), "agent_react_code_run starting");

    // 1. Load agent definition
    let agent: Agent = state
        .agents_loader
        .get(&agent_id)
        .ok_or_else(|| format!("Agent '{}' not found", agent_id))?;

    // 2. Get vault secrets (for code execution sandbox)
    let vault_secrets = if !agent.attached_tools.is_empty() {
        let tool_def = &agent.attached_tools[0];
        if should_retrieve_attached_tool_vault(
            &agent.id,
            &tool_def.id,
            &tool_def.vault_entry,
        ) {
            tracing::info!("Retrieving vault secrets for: {}", tool_def.vault_entry);
            match _retrieve_vault_secrets(&state, &tool_def.vault_entry).await {
                Ok(secrets) => {
                    tracing::info!("Retrieved {} vault secrets", secrets.len());
                    Some(secrets)
                }
                Err(e) => {
                    tracing::error!("Failed to retrieve vault secrets: {}", e);
                    return Err(format!("Vault error: {}", e));
                }
            }
        } else {
            None
        }
    } else {
        None
    };

    // 3. Build pane context if tab_id provided
    let pane_context = if let Some(ref tid) = tab_id {
        build_pane_context_prompt(&state.pane_manager, tid, pane_id.as_deref())
    } else {
        String::new()
    };

    // 4. Call Python sidecar method "agent.react_code_loop"
    // This is a NEW sidecar method that runs ReACT loop but with
    // execute_python_code as the only tool instead of Meraki API tools.
    // Pass the attached tool's id so the sandbox binds the RIGHT client
    // (e.g. "pyats" vs "meraki"); without it the sidecar defaulted to Meraki.
    let tool_id = agent
        .attached_tools
        .first()
        .map(|t| t.id.clone())
        .unwrap_or_default();
    let topolograph_runtime = resolve_topolograph_runtime_binding(&state, &agent.id)?;
    let mut params = build_agent_react_code_run_params(
        &agent_id,
        message,
        history,
        agent.system_prompt.clone(),
        tool_id,
        vault_secrets,
        agent.engine.clone(),
        stream_output.unwrap_or(false),
        uuid::Uuid::new_v4().to_string(),
        topolograph_runtime,
    );
    let mut issued_terminal_lease_id: Option<String> = None;

    if !pane_context.is_empty() {
        params["pane_context"] = serde_json::json!(pane_context);
    }

    if let Some(attachment) = terminal_attachment {
        if agent_id != "network-architect" {
            return Err("terminal attachment is restricted to Network Architect".into());
        }
        let attachment = validate_terminal_attachment(&state, attachment)?;
        let turn_id = uuid::Uuid::new_v4().to_string();
        let grant =
            state
                .terminal_agent
                .issue(&agent_id, &turn_id, attachment, now_seconds(), 30 * 60)?;
        let base_url = state
            .terminal_agent
            .gateway_base_url()
            .ok_or_else(|| "terminal-agent gateway is unavailable".to_string())?;
        let _ = on_event.send(ReactEvent::TerminalControlStarted {
            lease_id: grant.lease_id.clone(),
            target: grant.target.clone(),
        });
        issued_terminal_lease_id = Some(grant.lease_id.clone());
        params["terminal_context"] = serde_json::json!({
            "base_url": base_url,
            "capability": grant.capability,
            "lease_id": grant.lease_id,
            "agent_id": agent_id,
            "turn_id": turn_id,
            "target": grant.target,
        });
    }

    tracing::info!("Calling sidecar agent.react_code_loop");

    // 5. Stream events back
    let on_event_clone = on_event.clone();
    let terminal_fix_pending = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let terminal_fix_pending_for_stream = terminal_fix_pending.clone();
    let result = state
        .agent
        .call_stream_ex("agent.react_code_loop", params, move |ev| {
            let ev_type = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
            tracing::debug!(event_type = %ev_type, "Received ReACT-Code event");

            match ev_type {
                "thought_start" => {
                    let step = ev.get("step").and_then(|v| v.as_u64()).unwrap_or(0) as i32;
                    let thought = ev
                        .get("thought")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&format!("Step {}", step))
                        .to_string();
                    let _ = on_event_clone.send(ReactEvent::ThoughtStart { thought, step });
                }
                "tool_call" => {
                    let name = ev
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let args = ev.get("args").cloned().unwrap_or(serde_json::Value::Null);
                    let _ = on_event_clone.send(ReactEvent::ToolCall {
                        name,
                        args,
                        blast_radius: "low".to_string(),
                    });
                }
                "tool_result" => {
                    let success = ev.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
                    let result = ev
                        .get("result")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let _ = on_event_clone.send(ReactEvent::ToolResult { success, result });
                }
                "token" => {
                    if let Some(text) = ev.get("text").and_then(|v| v.as_str()) {
                        let _ = on_event_clone.send(ReactEvent::Token {
                            text: text.to_string(),
                        });
                    }
                }
                "final" => {
                    if let Some(response) = ev.get("response").and_then(|v| v.as_str()) {
                        let _ = on_event_clone.send(ReactEvent::Final {
                            response: response.to_string(),
                        });
                    }
                }
                "diagram" => {
                    let (title, format, xml, source, url, image_url) = parse_diagram_event(ev);
                    let _ = on_event_clone.send(ReactEvent::Diagram {
                        title,
                        format,
                        xml,
                        source,
                        url,
                        image_url,
                    });
                }
                "error" => {
                    if let Some(message) = ev.get("message").and_then(|v| v.as_str()) {
                        let _ = on_event_clone.send(ReactEvent::Error {
                            message: message.to_string(),
                        });
                    }
                }
                "continuation_available" => {
                    let _ = on_event_clone.send(ReactEvent::ContinuationAvailable {
                        thread_id: ev
                            .get("thread_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        reason: ev
                            .get("reason")
                            .and_then(|v| v.as_str())
                            .unwrap_or("step_limit")
                            .to_string(),
                    });
                }
                "iac_approval_request" => {
                    let _ = on_event_clone.send(ReactEvent::IacApprovalRequest {
                        thread_id: ev
                            .get("thread_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        command: ev
                            .get("command")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        working_dir: ev
                            .get("working_dir")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        tool: ev
                            .get("tool")
                            .and_then(|v| v.as_str())
                            .unwrap_or("terraform")
                            .to_string(),
                        classification: ev
                            .get("classification")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                    });
                }
                "terminal_investigation_plan" => {
                    let _ = on_event_clone.send(ReactEvent::TerminalInvestigationPlan {
                        plan: ev.get("plan").cloned().unwrap_or(serde_json::Value::Null),
                        updated: ev.get("updated").and_then(|v| v.as_bool()).unwrap_or(false),
                    });
                }
                "terminal_command_start" => {
                    let _ = on_event_clone.send(ReactEvent::TerminalCommandStart {
                        plan_step_id: ev
                            .get("plan_step_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        command: ev
                            .get("command")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        purpose: ev
                            .get("purpose")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    });
                }
                "terminal_command_result" => {
                    let _ = on_event_clone.send(ReactEvent::TerminalCommandResult {
                        plan_step_id: ev
                            .get("plan_step_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        command: ev
                            .get("command")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        success: ev.get("success").and_then(|v| v.as_bool()).unwrap_or(false),
                        result: ev.get("result").cloned().unwrap_or(serde_json::Value::Null),
                    });
                }
                "terminal_fix_approval_request" => {
                    terminal_fix_pending_for_stream
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    let _ = on_event_clone.send(ReactEvent::TerminalFixApprovalRequest {
                        thread_id: ev
                            .get("thread_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        preview: ev
                            .get("preview")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                    });
                }
                "terminal_lease_ended" => {
                    let _ = on_event_clone.send(ReactEvent::TerminalLeaseEnded {
                        reason: ev
                            .get("reason")
                            .and_then(|v| v.as_str())
                            .unwrap_or("terminal lease ended")
                            .to_string(),
                    });
                }
                _ => {
                    tracing::warn!(event_type = %ev_type, "Unknown ReACT-Code event type");
                }
            }
            Ok(())
        })
        .await;

    if let Some(lease_id) = issued_terminal_lease_id {
        if !terminal_fix_pending.load(std::sync::atomic::Ordering::SeqCst) {
            let _ = state
                .terminal_agent
                .revoke_by_lease_id(&lease_id, "agent turn completed");
            let _ = on_event.send(ReactEvent::TerminalLeaseEnded {
                reason: "agent turn completed".to_string(),
            });
        }
    }

    match result {
        Ok(_) => {
            tracing::info!("agent_react_code_run completed successfully");
            Ok(())
        }
        Err(e) => {
            tracing::error!(error = %e, "agent_react_code_run failed");
            let _ = on_event.send(ReactEvent::Error {
                message: e.to_string(),
            });
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub fn agent_terminal_preview_fix_edit(
    lease_id: String,
    batch: crate::terminal_agent::FixBatch,
    state: State<'_, AppState>,
) -> Result<crate::terminal_agent::FixPreview, String> {
    let rules = state.guardrails_ruleset.read();
    state
        .terminal_agent
        .preview_fix_by_lease_id(&lease_id, batch, now_seconds(), &rules)
}

#[tauri::command]
pub fn agent_terminal_approve_fix(
    lease_id: String,
    digest: String,
    batch: crate::terminal_agent::FixBatch,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let preview = {
        let rules = state.guardrails_ruleset.read();
        state.terminal_agent.preview_fix_by_lease_id(
            &lease_id,
            batch.clone(),
            now_seconds(),
            &rules,
        )?
    };
    if preview.digest != digest {
        return Err("fix approval does not match the latest reviewed batch".into());
    }
    {
        use crate::guardrails::decisions::{record_decision, DecisionRecord};
        let db = state.db.lock();
        for classified in &preview.per_command_tiers {
            let tier = match classified.tier.as_str() {
                "T0" => 0,
                "T1" | "Ambiguous" => 1,
                "T2" => 2,
                "T3" => 3,
                _ => 1,
            };
            record_decision(
                &db,
                &DecisionRecord {
                    id: String::new(),
                    session_id: preview.target.backend_pty_id.clone(),
                    command: classified.command.clone(),
                    tier,
                    rule_id: None,
                    decision: "terminal fix approved for exact reviewed batch".into(),
                    user_action: Some("approved".into()),
                    reasoning: format!(
                        "operator approved digest {} for locked terminal target",
                        preview.digest
                    ),
                },
            )
            .map_err(|error| error.to_string())?;
        }
    }
    state
        .terminal_agent
        .approve_fix_by_lease_id(&lease_id, &digest, &batch, now_seconds())
}

#[tauri::command]
pub fn agent_terminal_cancel(lease_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state
        .terminal_agent
        .revoke_by_lease_id(&lease_id, "stopped by operator")
}

/// IaC Phase 2 — resume an agent paused on a gated iac_apply.
///
/// Called by the frontend after the user approves/denies in the IaCApprovalModal.
/// Forwards the decision to the sidecar's `agent.react_resume`, which continues
/// the interrupted graph; resumed events are relayed back over the same channel.
#[tauri::command]
pub async fn agent_react_resume(
    thread_id: String,
    decision: String, // "approve" | "deny" | "edit"
    edited_action: Option<serde_json::Value>,
    stream_output: Option<bool>,
    state: State<'_, AppState>,
    on_event: tauri::ipc::Channel<ReactEvent>,
) -> Result<(), String> {
    tracing::info!(thread_id = %thread_id, decision = %decision, "agent_react_resume starting");

    let mut params = serde_json::json!({
        "thread_id": thread_id,
        "decision": decision,
        "stream_output": stream_output.unwrap_or(false),
    });
    if let Some(edited_action) = edited_action {
        params["edited_action"] = edited_action;
    }

    let on_event_clone = on_event.clone();
    let terminal_fix_pending = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let terminal_fix_pending_for_stream = terminal_fix_pending.clone();
    let result = state
        .agent
        .call_stream_ex("agent.react_resume", params, move |ev| {
            let ev_type = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match ev_type {
                "thought_start" => {
                    let step = ev.get("step").and_then(|v| v.as_u64()).unwrap_or(0) as i32;
                    let thought = ev
                        .get("thought")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&format!("Step {}", step))
                        .to_string();
                    let _ = on_event_clone.send(ReactEvent::ThoughtStart { thought, step });
                }
                "tool_call" => {
                    let name = ev
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let args = ev.get("args").cloned().unwrap_or(serde_json::Value::Null);
                    let _ = on_event_clone.send(ReactEvent::ToolCall {
                        name,
                        args,
                        blast_radius: "low".to_string(),
                    });
                }
                "tool_result" => {
                    let success = ev.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
                    let result = ev
                        .get("result")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let _ = on_event_clone.send(ReactEvent::ToolResult { success, result });
                }
                "token" => {
                    if let Some(text) = ev.get("text").and_then(|v| v.as_str()) {
                        let _ = on_event_clone.send(ReactEvent::Token {
                            text: text.to_string(),
                        });
                    }
                }
                "final" => {
                    if let Some(response) = ev.get("response").and_then(|v| v.as_str()) {
                        let _ = on_event_clone.send(ReactEvent::Final {
                            response: response.to_string(),
                        });
                    }
                }
                "diagram" => {
                    let (title, format, xml, source, url, image_url) = parse_diagram_event(ev);
                    let _ = on_event_clone.send(ReactEvent::Diagram {
                        title,
                        format,
                        xml,
                        source,
                        url,
                        image_url,
                    });
                }
                "error" => {
                    if let Some(message) = ev.get("message").and_then(|v| v.as_str()) {
                        let _ = on_event_clone.send(ReactEvent::Error {
                            message: message.to_string(),
                        });
                    }
                }
                "continuation_available" => {
                    let _ = on_event_clone.send(ReactEvent::ContinuationAvailable {
                        thread_id: ev
                            .get("thread_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        reason: ev
                            .get("reason")
                            .and_then(|v| v.as_str())
                            .unwrap_or("step_limit")
                            .to_string(),
                    });
                }
                "iac_approval_request" => {
                    // A resumed graph could pause again (e.g. a second apply).
                    let _ = on_event_clone.send(ReactEvent::IacApprovalRequest {
                        thread_id: ev
                            .get("thread_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        command: ev
                            .get("command")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        working_dir: ev
                            .get("working_dir")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        tool: ev
                            .get("tool")
                            .and_then(|v| v.as_str())
                            .unwrap_or("terraform")
                            .to_string(),
                        classification: ev
                            .get("classification")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                    });
                }
                "terminal_investigation_plan" => {
                    let _ = on_event_clone.send(ReactEvent::TerminalInvestigationPlan {
                        plan: ev.get("plan").cloned().unwrap_or(serde_json::Value::Null),
                        updated: ev.get("updated").and_then(|v| v.as_bool()).unwrap_or(false),
                    });
                }
                "terminal_command_start" => {
                    let _ = on_event_clone.send(ReactEvent::TerminalCommandStart {
                        plan_step_id: ev
                            .get("plan_step_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        command: ev
                            .get("command")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        purpose: ev
                            .get("purpose")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    });
                }
                "terminal_command_result" => {
                    let _ = on_event_clone.send(ReactEvent::TerminalCommandResult {
                        plan_step_id: ev
                            .get("plan_step_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        command: ev
                            .get("command")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        success: ev.get("success").and_then(|v| v.as_bool()).unwrap_or(false),
                        result: ev.get("result").cloned().unwrap_or(serde_json::Value::Null),
                    });
                }
                "terminal_fix_approval_request" => {
                    terminal_fix_pending_for_stream
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    let _ = on_event_clone.send(ReactEvent::TerminalFixApprovalRequest {
                        thread_id: ev
                            .get("thread_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        preview: ev
                            .get("preview")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                    });
                }
                "terminal_lease_ended" => {
                    let _ = on_event_clone.send(ReactEvent::TerminalLeaseEnded {
                        reason: ev
                            .get("reason")
                            .and_then(|v| v.as_str())
                            .unwrap_or("terminal lease ended")
                            .to_string(),
                    });
                }
                _ => {}
            }
            Ok(())
        })
        .await;

    if !terminal_fix_pending.load(std::sync::atomic::Ordering::SeqCst) {
        state
            .terminal_agent
            .revoke_for_turn(&thread_id, "agent turn completed");
        let _ = on_event.send(ReactEvent::TerminalLeaseEnded {
            reason: "agent turn completed".to_string(),
        });
    }

    match result {
        Ok(_) => {
            tracing::info!("agent_react_resume completed successfully");
            Ok(())
        }
        Err(e) => {
            tracing::error!(error = %e, "agent_react_resume failed");
            let _ = on_event.send(ReactEvent::Error {
                message: e.to_string(),
            });
            Err(e.to_string())
        }
    }
}

/// Retrieve secrets from vault envelope and return as key-value map.
pub(crate) async fn _retrieve_vault_secrets(
    state: &AppState,
    envelope_name: &str,
) -> Result<std::collections::HashMap<String, String>, String> {
    use zeroize::Zeroizing;

    // Get envelope by name
    let db = state.db.lock();
    let envelope_id: Option<String> = db
        .query_row(
            "SELECT id FROM vault_envelopes WHERE name = ?1",
            rusqlite::params![envelope_name],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to query envelope: {}", e))?;

    let envelope_id = envelope_id.ok_or_else(|| {
        format!(
            "Vault envelope '{}' not found. Create it in Settings → Vault.",
            envelope_name
        )
    })?;

    // Get all secrets in the envelope
    // Note: We don't check is_unlocked() here because read_secret() will
    // handle locked state AND refresh the activity timestamp automatically.
    // An explicit is_unlocked() check would prevent timestamp refresh.
    let secrets = state
        .vault
        .store
        .list_secrets(&db, &envelope_id)
        .map_err(|e| format!("Failed to list secrets: {}", e))?;

    drop(db); // Release DB lock before reading secrets

    let mut result = std::collections::HashMap::new();

    for secret in secrets {
        // Skip canary
        if secret.label == "__canary__" {
            continue;
        }

        // Read secret plaintext
        let db = state.db.lock();
        let plaintext: Zeroizing<Vec<u8>> = state
            .vault
            .store
            .read_secret(&db, &state.vault.lock, &secret.id)
            .map_err(|e| {
                if e.to_string().contains("locked") {
                    format!(
                        "Vault envelope '{}' is locked or timed out. Unlock it in Settings → Vault before using this agent.",
                        envelope_name
                    )
                } else {
                    format!("Failed to read secret '{}': {}", secret.label, e)
                }
            })?;
        drop(db);

        // Convert to string
        let value = String::from_utf8(plaintext.to_vec())
            .map_err(|e| format!("Secret '{}' is not valid UTF-8: {}", secret.label, e))?;

        result.insert(secret.label.clone(), value);
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn test_code_exec_event_serialization() {
        let event = CodeExecEvent::CodeStart {
            code: "print('hello')".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""type":"code_start"#));
        assert!(json.contains("print('hello')"));
    }

    #[test]
    fn test_code_exec_event_result() {
        let event = CodeExecEvent::CodeResult {
            success: true,
            output: "hello\n".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""success":true"#));
    }

    #[test]
    fn test_react_token_serialization() {
        let event = ReactEvent::Token {
            text: "live chunk".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert_eq!(json, r#"{"type":"token","text":"live chunk"}"#);
    }

    #[test]
    fn test_react_continuation_serialization() {
        let event = ReactEvent::ContinuationAvailable {
            thread_id: "architect-run-1".to_string(),
            reason: "step_limit".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert_eq!(
            json,
            r#"{"type":"continuation_available","thread_id":"architect-run-1","reason":"step_limit"}"#
        );
    }

    #[test]
    fn test_code_exec_diagram_serialization() {
        let event = CodeExecEvent::Diagram {
            title: "Topology".to_string(),
            format: "xml".to_string(),
            xml: Some("<mxGraphModel/>".to_string()),
            source: None,
            url: "https://app.diagrams.net/#create=abc".to_string(),
            image_url: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""type":"diagram""#));
        assert!(json.contains(r#""title":"Topology""#));
        assert!(json.contains(r#""format":"xml""#));
        assert!(json.contains(r#""xml":"<mxGraphModel/>""#));
        // None fields serialize as explicit null (the TS contract expects this,
        // not an omitted key).
        assert!(json.contains(r#""source":null"#));
        assert!(json.contains(r#""url":"https://app.diagrams.net/#create=abc""#));
    }

    #[test]
    fn test_react_diagram_serialization() {
        let event = ReactEvent::Diagram {
            title: "Flow".to_string(),
            format: "mermaid".to_string(),
            xml: None,
            source: Some("graph TD; A-->B".to_string()),
            url: "https://app.diagrams.net/#create=xyz".to_string(),
            image_url: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""type":"diagram""#));
        assert!(json.contains(r#""format":"mermaid""#));
        assert!(json.contains(r#""xml":null"#));
        assert!(json.contains(r#""source":"graph TD; A-->B""#));
        // image_url is omitted when None (TS field is optional).
        assert!(!json.contains("image_url"));

        // When present (Kroki image), image_url is serialized.
        let img = ReactEvent::Diagram {
            title: "UML".to_string(),
            format: "image".to_string(),
            xml: None,
            source: Some("@startuml\nA->B\n@enduml".to_string()),
            url: "".to_string(),
            image_url: Some("data:image/svg+xml;base64,PHN2Zy8+".to_string()),
        };
        let jimg = serde_json::to_string(&img).unwrap();
        assert!(jimg.contains(r#""format":"image""#));
        assert!(jimg.contains(r#""image_url":"data:image/svg+xml;base64,PHN2Zy8+""#));
    }

    #[test]
    fn test_parse_diagram_event_full() {
        let ev = serde_json::json!({
            "type": "diagram",
            "title": "T",
            "format": "csv",
            "xml": null,
            "source": "a,b",
            "url": "https://app.diagrams.net/#create=q",
            "image_url": "https://kroki.io/x/svg/abc"
        });
        let (title, format, xml, source, url, image_url) = parse_diagram_event(&ev);
        assert_eq!(title, "T");
        assert_eq!(format, "csv");
        assert_eq!(xml, None);
        assert_eq!(source, Some("a,b".to_string()));
        assert_eq!(url, "https://app.diagrams.net/#create=q");
        assert_eq!(image_url, Some("https://kroki.io/x/svg/abc".to_string()));
    }

    #[test]
    fn test_parse_diagram_event_defaults_on_missing_fields() {
        // A malformed event must not panic; missing fields take safe defaults.
        let ev = serde_json::json!({ "type": "diagram" });
        let (title, format, xml, source, url, image_url) = parse_diagram_event(&ev);
        assert_eq!(title, "diagram");
        assert_eq!(format, "xml");
        assert_eq!(xml, None);
        assert_eq!(source, None);
        assert_eq!(url, "");
        assert_eq!(image_url, None);
    }

    #[test]
    fn production_react_param_builders_attach_private_topolograph_runtime_for_both_entry_points() {
        let binding = serde_json::json!({
            "base_url": "https://topolograph.example",
            "verify_tls": true,
            "token": "synthetic direct token",
        });
        let mut cases = Vec::new();
        for agent_id in ["topolograph", "network-architect"] {
            cases.push((
                "agent.react_loop",
                agent_id,
                build_agent_react_run_params(
                    agent_id,
                    "inspect topology".to_string(),
                    Vec::new(),
                    "agent prompt".to_string(),
                    serde_json::json!([]),
                    String::new(),
                    None,
                    Some("deepagents".to_string()),
                    false,
                    Some(binding.clone()),
                ),
            ));
            cases.push((
                "agent.react_code_loop",
                agent_id,
                build_agent_react_code_run_params(
                    agent_id,
                    "inspect topology".to_string(),
                    Vec::new(),
                    "agent prompt".to_string(),
                    "topolograph".to_string(),
                    None,
                    Some("deepagents".to_string()),
                    false,
                    "test-run".to_string(),
                    Some(binding.clone()),
                ),
            ));
        }

        assert_eq!(binding["token"], "synthetic direct token");
        for (entry_point, agent_id, params) in cases {
            assert_eq!(params["topolograph_runtime"], binding, "{entry_point}");
            assert!(
                params.get("vault_secrets").is_none_or(Value::is_null),
                "{entry_point} unexpectedly included Vault secrets for {agent_id}"
            );
        }
    }

    #[test]
    fn command_runtime_selection_is_strict_for_topolograph_and_optional_for_architect() {
        let binding = serde_json::json!({
            "base_url": "https://topolograph.example",
            "verify_tls": true,
            "token": "synthetic direct token",
        });

        let dedicated = resolve_topolograph_runtime_binding_with(
            "topolograph",
            || Err("dedicated binding unavailable".to_string()),
            || Some(binding.clone()),
        );
        assert_eq!(dedicated.unwrap_err(), "dedicated binding unavailable");

        let architect = resolve_topolograph_runtime_binding_with(
            "network-architect",
            || Err("dedicated binding must not be used".to_string()),
            || Some(binding.clone()),
        )
        .unwrap();
        assert_eq!(architect, Some(binding));

        let unrelated = resolve_topolograph_runtime_binding_with(
            "meraki",
            || panic!("unrelated agents must not load the dedicated binding"),
            || panic!("unrelated agents must not load the Architect binding"),
        )
        .unwrap();
        assert_eq!(unrelated, None);
    }

    #[test]
    fn architect_prompt_appends_soul_md_first_then_other_soul_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("SOUL-SKILLS.md"), "skills").unwrap();
        std::fs::write(dir.path().join("SOUL.md"), "identity").unwrap();
        std::fs::write(dir.path().join("AGENT.md"), "ignored").unwrap();

        let prompt = append_soul_files_from_dir("network-architect", "base".to_string(), dir.path());

        assert!(prompt.contains("base\n\n---\nSOUL.md\n---\nidentity\n\n---\nSOUL-SKILLS.md\n---\nskills"));
        assert!(!prompt.contains("ignored"));
    }

    #[test]
    fn topolograph_tool_vault_policy_skips_connector_entry_but_keeps_unrelated_tool_entry() {
        assert!(!should_retrieve_attached_tool_vault(
            "topolograph",
            "topolograph",
            "legacy-topolograph-envelope",
        ));
        assert!(!should_retrieve_attached_tool_vault(
            "network-architect",
            "topolograph",
            "legacy-topolograph-envelope",
        ));
        assert!(should_retrieve_attached_tool_vault(
            "topolograph",
            "meraki",
            "meraki_default",
        ));
        assert!(should_retrieve_attached_tool_vault(
            "network-architect",
            "meraki",
            "meraki_default",
        ));
        assert!(!should_retrieve_attached_tool_vault(
            "meraki", "meraki", "",
        ));
    }

    #[test]
    fn production_react_param_builders_omit_unusable_or_non_architect_topolograph_runtime() {
        let react_params = build_agent_react_run_params(
            "network-architect",
            "inspect topology".to_string(),
            Vec::new(),
            "architect prompt".to_string(),
            serde_json::json!([]),
            String::new(),
            None,
            Some("deepagents".to_string()),
            false,
            None,
        );
        let react_code_params = build_agent_react_code_run_params(
            "network-architect",
            "inspect topology".to_string(),
            Vec::new(),
            "architect prompt".to_string(),
            String::new(),
            None,
            Some("deepagents".to_string()),
            false,
            "test-run".to_string(),
            None,
        );
        let non_architect_params = build_agent_react_run_params(
            "meraki",
            "inspect topology".to_string(),
            Vec::new(),
            "meraki prompt".to_string(),
            serde_json::json!([]),
            String::new(),
            None,
            Some("deepagents".to_string()),
            false,
            Some(serde_json::json!({"token": "synthetic direct token"})),
        );
        let non_architect_code_params = build_agent_react_code_run_params(
            "meraki",
            "inspect topology".to_string(),
            Vec::new(),
            "meraki prompt".to_string(),
            String::new(),
            None,
            Some("deepagents".to_string()),
            false,
            "test-run".to_string(),
            Some(serde_json::json!({"token": "synthetic direct token"})),
        );

        assert!(react_params.get("topolograph_runtime").is_none());
        assert!(react_code_params.get("topolograph_runtime").is_none());
        assert!(non_architect_params.get("topolograph_runtime").is_none());
        assert!(non_architect_code_params
            .get("topolograph_runtime")
            .is_none());
    }
}
