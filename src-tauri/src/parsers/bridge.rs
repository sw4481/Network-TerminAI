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

/// Opt-in status from topology.neighbors; legacy neighbors() still returns Vec.
#[derive(Debug, serde::Deserialize)]
pub struct NeighborCapture {
    pub status: crate::topology::CaptureStatus,
    pub records: Vec<crate::topology::NeighborRecord>,
}

impl NeighborCapture {
    pub fn from_response(value: serde_json::Value) -> Result<Self> {
        let capture: Self = serde_json::from_value(value)?;
        anyhow::ensure!(
            capture.status == crate::topology::CaptureStatus::Completed
                || (capture.status == crate::topology::CaptureStatus::Unsupported
                    && capture.records.is_empty()),
            "invalid topology capture status"
        );
        Ok(capture)
    }
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
            AgentResponse::Error { message } => {
                Err(anyhow!("sidecar parse.request error: {message}"))
            }
            AgentResponse::Token { .. } => Err(anyhow!("parse.request unexpectedly streamed")),
        }
    }

    /// Manual collection needs support information even when records is empty.
    pub async fn neighbor_capture(
        &self,
        protocol: &str,
        vendor: &str,
        platform: &str,
        command: &str,
        raw: &str,
    ) -> Result<NeighborCapture> {
        self.neighbor_capture_with_interfaces(protocol, vendor, platform, command, raw, None)
            .await
    }

    pub async fn neighbor_capture_with_interfaces(
        &self,
        protocol: &str,
        vendor: &str,
        platform: &str,
        command: &str,
        raw: &str,
        interfaces_raw: Option<&str>,
    ) -> Result<NeighborCapture> {
        let params = json!({
            "protocol": protocol, "vendor": vendor, "platform": platform,
            "command": command, "raw": raw, "include_status": true,
            "interfaces_raw": interfaces_raw,
        });
        match self.agent.call("topology.neighbors", params).await? {
            AgentResponse::Done { result } => NeighborCapture::from_response(result),
            AgentResponse::Error { message } => {
                Err(anyhow!("sidecar topology.neighbors error: {message}"))
            }
            AgentResponse::Token { .. } => Err(anyhow!("topology.neighbors unexpectedly streamed")),
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
                let parsed: Vec<crate::topology::NeighborRecord> = serde_json::from_value(records)?;
                Ok(parsed)
            }
            AgentResponse::Error { message } => {
                Err(anyhow!("sidecar topology.neighbors error: {message}"))
            }
            AgentResponse::Token { .. } => Err(anyhow!("topology.neighbors unexpectedly streamed")),
        }
    }
}
