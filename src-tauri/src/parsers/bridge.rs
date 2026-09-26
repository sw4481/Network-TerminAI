use std::sync::Arc;

use anyhow::{anyhow, Result};
use serde_json::json;

use crate::agent_bridge::{AgentBridge, AgentResponse};

/// Parsed response from the sidecar's `parse.request` NDJSON method.
#[derive(Debug, Clone)]
pub struct ParsedOutput {
    pub parser: String,
    pub data: serde_json::Value,
}

/// Thin wrapper that calls the sidecar `parse.request` method through the
/// existing `AgentBridge`. Bridge is shared via `Arc` so cloning is cheap.
#[derive(Clone)]
pub struct ParserBridge {
    agent: Arc<AgentBridge>,
}

impl ParserBridge {
    pub fn new(agent: Arc<AgentBridge>) -> Self {
        Self { agent }
    }

    pub async fn parse(
        &self,
        vendor: &str,
        platform: &str,
        command: &str,
        raw: &str,
    ) -> Result<ParsedOutput> {
        let params = json!({
            "vendor": vendor,
            "platform": platform,
            "command": command,
            "raw": raw,
        });
        match self.agent.call("parse.request", params).await? {
            AgentResponse::Done { result } => {
                let parser = result
                    .get("parser")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow!("parse.request response missing 'parser'"))?
                    .to_string();
                let data = result
                    .get("data")
                    .cloned()
                    .ok_or_else(|| anyhow!("parse.request response missing 'data'"))?;
                Ok(ParsedOutput { parser, data })
            }
            AgentResponse::Error { message } => Err(anyhow!("sidecar parse.request error: {message}")),
            AgentResponse::Token { .. } => Err(anyhow!("parse.request unexpectedly streamed")),
        }
    }

    /// Plan 13 Phase 1.3 — call the sidecar's `topology.neighbors` method
    /// to parse + normalize CDP/LLDP output into a flat list of
    /// `NeighborRecord`s. The sidecar response shape is
    /// `{"records": [...]}`.
    pub async fn neighbors(
        &self,
        protocol: &str,
        vendor: &str,
        platform: &str,
        command: &str,
        raw: &str,
    ) -> Result<Vec<crate::topology::NeighborRecord>> {
        let params = json!({
            "protocol": protocol,
            "vendor": vendor,
            "platform": platform,
            "command": command,
            "raw": raw,
        });
        match self.agent.call("topology.neighbors", params).await? {
            AgentResponse::Done { result } => {
                let records = result
                    .get("records")
                    .cloned()
                    .ok_or_else(|| anyhow!("topology.neighbors response missing 'records'"))?;
                let parsed: Vec<crate::topology::NeighborRecord> =
                    serde_json::from_value(records)?;
                Ok(parsed)
            }
            AgentResponse::Error { message } => {
                Err(anyhow!("sidecar topology.neighbors error: {message}"))
            }
            AgentResponse::Token { .. } => {
                Err(anyhow!("topology.neighbors unexpectedly streamed"))
            }
        }
    }
}
