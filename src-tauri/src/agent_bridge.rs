// Plan 00 / Phase 3 / Task 3.0: AgentBridge now delegates to a persistent
// `SidecarSupervisor` with id-based multiplexing instead of spawning a fresh
// child per call. Public API (`call`, `call_stream`, `call_stream_ex`,
// `restart`, `stop`) is preserved so the rest of the codebase compiles
// unchanged.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

use crate::bridge::{SidecarSupervisor, SupervisorError};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AgentResponse {
    #[serde(rename = "token")]
    Token { data: String },
    #[serde(rename = "done")]
    Done { result: Value },
    #[serde(rename = "error")]
    Error { message: String },
}

#[derive(Clone)]
pub struct AgentBridge {
    supervisor: Arc<SidecarSupervisor>,
}

impl AgentBridge {
    pub fn new(program: String, args: Vec<String>) -> Self {
        Self {
            supervisor: Arc::new(SidecarSupervisor::new(program, args)),
        }
    }

    /// Tear the child down. Next `call` re-spawns lazily.
    pub fn restart(&self) -> Result<()> {
        self.supervisor.shutdown();
        Ok(())
    }

    pub fn stop(&self) {
        self.supervisor.shutdown();
    }

    /// Expose the underlying supervisor so other modules (parser bridge,
    /// heartbeat consumer) can share the same persistent process.
    pub fn supervisor(&self) -> Arc<SidecarSupervisor> {
        self.supervisor.clone()
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<AgentResponse> {
        self.call_with_idle_timeout(method, params, std::time::Duration::from_secs(720)).await
    }

    pub async fn call_with_idle_timeout(
        &self,
        method: &str,
        params: Value,
        idle_timeout: std::time::Duration,
    ) -> Result<AgentResponse> {
        tracing::debug!(method = %method, "Calling agent bridge");

        let supervisor = self.supervisor.clone();
        let method = method.to_string();

        tokio::task::spawn_blocking(move || {
            // Use `call_typed` so we can cleanly tell sidecar-reported errors
            // apart from infra failures without string-matching on the
            // anyhow::Error's Display output.
            match supervisor.call_typed_with_idle_timeout(&method, params, idle_timeout) {
                Ok(result) => {
                    tracing::debug!(method = %method, "Agent call completed successfully");
                    Ok(AgentResponse::Done { result })
                }
                Err(SupervisorError::Sidecar(message)) => {
                    tracing::warn!(method = %method, error = %message, "Agent returned error");
                    Ok(AgentResponse::Error { message })
                }
                Err(SupervisorError::Infra(e)) => {
                    tracing::error!(method = %method, error = %e, "Agent call failed (infra)");
                    Err(e)
                }
            }
        })
        .await?
    }

    pub async fn call_stream<F>(&self, method: &str, params: Value, on_token: F) -> Result<Value>
    where
        F: FnMut(String) -> Result<()> + Send + 'static,
    {
        let supervisor = self.supervisor.clone();
        let method = method.to_string();

        tokio::task::spawn_blocking(move || {
            let mut on_token = on_token;
            supervisor.call_stream_ex(&method, params, |ev| {
                if ev.get("type").and_then(|v| v.as_str()) == Some("token") {
                    if let Some(data) = ev.get("data").and_then(|v| v.as_str()) {
                        return on_token(data.to_string());
                    }
                }
                Ok(())
            })
        })
        .await?
    }

    /// Stream with full event surfacing (tokens + tool_calls + any custom events).
    /// The callback receives the raw JSON `Value` per event. "done"/"error" terminate.
    pub async fn call_stream_ex<F>(
        &self,
        method: &str,
        params: Value,
        on_event: F,
    ) -> Result<Value>
    where
        F: FnMut(&Value) -> Result<()> + Send + 'static,
    {
        let supervisor = self.supervisor.clone();
        let method = method.to_string();

        tokio::task::spawn_blocking(move || {
            let mut on_event = on_event;
            supervisor.call_stream_ex(&method, params, |ev| on_event(ev))
        })
        .await?
    }
}
