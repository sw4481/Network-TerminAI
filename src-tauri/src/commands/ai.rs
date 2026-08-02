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
}

/// Run a ReACT agent loop with attached tools (Meraki CLI, etc.)
#[tauri::command]
pub async fn agent_react_run(
    agent_id: String,
    message: String,
    history: Option<Vec<ChatTurn>>,
    tab_id: Option<String>,
    pane_id: Option<String>,
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

    if agent.attached_tools.is_empty() {
        return Err("Agent has no attached tools configured".to_string());
    }

    // 2. Load tool catalog from first attached tool
    let tool_def = &agent.attached_tools[0];
    let catalog_json = std::fs::read_to_string(&tool_def.catalog)
        .map_err(|e| format!("Failed to read tool catalog {}: {}", tool_def.catalog, e))?;

    let catalog: serde_json::Value = serde_json::from_str(&catalog_json)
        .map_err(|e| format!("Failed to parse tool catalog: {}", e))?;

    // 3. Retrieve credentials from vault
    let vault_secrets = if !tool_def.vault_entry.is_empty() {
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
                // Return the error to the user so they know what went wrong
                return Err(format!("Vault error: {}", e));
            }
        }
    } else {
        tracing::info!("No vault entry configured for this agent");
        None
    };

    // 4. Build pane context if tab_id provided
    let pane_context = if let Some(ref tid) = tab_id {
        build_pane_context_prompt(&state.pane_manager, tid, pane_id.as_deref())
    } else {
        String::new()
    };

    // 5. Call Python sidecar method "agent.react_loop"
    let mut params = serde_json::json!({
        "agent_id": agent_id,
        "message": message,
        "history": history,
        "system_prompt": agent.system_prompt,
        "tools": catalog,
        "vault_entry": tool_def.vault_entry,
        "vault_secrets": vault_secrets,
        "engine": agent.engine,
    });

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
        "system_prompt": agent.system_prompt,
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
        if !tool_def.vault_entry.is_empty() {
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
    let mut params = serde_json::json!({
        "agent_id": agent_id,
        "message": message,
        "history": history,
        "system_prompt": agent.system_prompt,
        "tool_id": tool_id,
        "vault_secrets": vault_secrets,
        "engine": agent.engine,
    });

    if !pane_context.is_empty() {
        params["pane_context"] = serde_json::json!(pane_context);
    }

    tracing::info!("Calling sidecar agent.react_code_loop");

    // 5. Stream events back
    let on_event_clone = on_event.clone();
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
                _ => {
                    tracing::warn!(event_type = %ev_type, "Unknown ReACT-Code event type");
                }
            }
            Ok(())
        })
        .await;

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

/// IaC Phase 2 — resume an agent paused on a gated iac_apply.
///
/// Called by the frontend after the user approves/denies in the IaCApprovalModal.
/// Forwards the decision to the sidecar's `agent.react_resume`, which continues
/// the interrupted graph; resumed events are relayed back over the same channel.
#[tauri::command]
pub async fn agent_react_resume(
    thread_id: String,
    decision: String, // "approve" | "deny"
    state: State<'_, AppState>,
    on_event: tauri::ipc::Channel<ReactEvent>,
) -> Result<(), String> {
    tracing::info!(thread_id = %thread_id, decision = %decision, "agent_react_resume starting");

    let params = serde_json::json!({
        "thread_id": thread_id,
        "decision": decision,
    });

    let on_event_clone = on_event.clone();
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
                _ => {}
            }
            Ok(())
        })
        .await;

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
}
