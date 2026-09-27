//! Thin bridge to the sidecar `pcap.summarize` / `pcap.packet_bytes` /
//! `pcap.follow_stream` NDJSON methods.
//!
//! Mirrors `parsers/bridge.rs` — calls the existing `AgentBridge` so
//! lifecycle (process start, heartbeats, restart) is shared with parsing.

use std::sync::Arc;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::agent_bridge::{AgentBridge, AgentResponse};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PcapPacket {
    pub no: u32,
    pub time: f64,
    pub src: Option<String>,
    pub dst: Option<String>,
    pub protocol: String,
    pub length: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PcapSummary {
    pub packet_count: u32,
    pub packets: Vec<PcapPacket>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PcapPacketBytes {
    pub hex: String,
    pub ascii: String,
    pub length: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FollowStreamResult {
    pub client_ascii: String,
    pub server_ascii: String,
    pub client_bytes: u32,
    pub server_bytes: u32,
    pub packets: Vec<PcapPacket>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FindingRuleMetadata {
    pub rule_id: String,
    pub category: String,
    pub severity: String,
    pub title: String,
    pub display_filter: String,
    pub enabled_by_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PcapFinding {
    pub rule_id: String,
    pub category: String,
    pub severity: String,
    pub title: String,
    pub count: u32,
    pub display_filter: String,
    pub evidence: Vec<PcapPacket>,
    pub evidence_truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PcapFindingsResult {
    pub findings: Vec<PcapFinding>,
    pub scanned_packets: u32,
    pub scan_limit: u32,
    pub scan_truncated: bool,
}

/// Result of the sidecar's `pcap.run_capture` (pyATS-driven live capture).
/// The `.pcap` is left on the device; `export_basename` is what to pull via SCP.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunCaptureResult {
    pub ok: bool,
    #[serde(default)]
    pub export_path: String,
    #[serde(default)]
    pub export_basename: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub error: String,
}

#[derive(Clone)]
pub struct PcapBridge {
    agent: Arc<AgentBridge>,
}

impl PcapBridge {
    pub fn new(agent: Arc<AgentBridge>) -> Self {
        Self { agent }
    }

    pub async fn summarize(
        &self,
        path: &str,
        max_packets: u32,
        display_filter: Option<&str>,
    ) -> Result<PcapSummary> {
        let mut params = json!({
            "path": path,
            "max_packets": max_packets,
        });
        if let Some(df) = display_filter {
            params["display_filter"] = json!(df);
        }
        match self.agent.call("pcap.summarize", params).await? {
            AgentResponse::Done { result } => Ok(serde_json::from_value(result)?),
            AgentResponse::Error { message } => Err(anyhow!(message)),
            AgentResponse::Token { .. } => Err(anyhow!("pcap.summarize unexpectedly streamed")),
        }
    }

    pub async fn packet_bytes(&self, path: &str, index: u32) -> Result<PcapPacketBytes> {
        let params = json!({ "path": path, "index": index });
        match self.agent.call("pcap.packet_bytes", params).await? {
            AgentResponse::Done { result } => Ok(serde_json::from_value(result)?),
            AgentResponse::Error { message } => Err(anyhow!(message)),
            AgentResponse::Token { .. } => Err(anyhow!("pcap.packet_bytes unexpectedly streamed")),
        }
    }

    pub async fn finding_rules(&self) -> Result<Vec<FindingRuleMetadata>> {
        match self.agent.call("pcap.finding_rules", json!({})).await? {
            AgentResponse::Done { result } => Ok(serde_json::from_value(result)?),
            AgentResponse::Error { message } => Err(anyhow!(message)),
            AgentResponse::Token { .. } => Err(anyhow!("pcap.finding_rules unexpectedly streamed")),
        }
    }

    pub async fn findings(
        &self,
        path: &str,
        enabled_rule_ids: &[String],
    ) -> Result<PcapFindingsResult> {
        let params = json!({
            "path": path,
            "enabled_rule_ids": enabled_rule_ids,
        });
        match self.agent.call("pcap.findings", params).await? {
            AgentResponse::Done { result } => Ok(serde_json::from_value(result)?),
            AgentResponse::Error { message } => Err(anyhow!(message)),
            AgentResponse::Token { .. } => Err(anyhow!("pcap.findings unexpectedly streamed")),
        }
    }

    /// Run a live capture lifecycle on the device via the sidecar's pyATS
    /// driver (one persistent session). Returns where the `.pcap` was exported
    /// on the device; the caller pulls it off-box over SCP.
    #[allow(clippy::too_many_arguments)]
    pub async fn run_capture(
        &self,
        host: &str,
        port: u16,
        username: &str,
        password: &str,
        device_kind: &str,
        interface: &str,
        acl: Option<&str>,
        buffer_mb: u32,
        duration_s: u32,
        capture_name: &str,
    ) -> Result<RunCaptureResult> {
        let mut params = json!({
            "host": host,
            "port": port,
            "username": username,
            "password": password,
            "device_kind": device_kind,
            "interface": interface,
            "buffer_mb": buffer_mb,
            "duration_s": duration_s,
            "capture_name": capture_name,
        });
        if let Some(a) = acl {
            params["acl"] = json!(a);
        }
        match self.agent.call("pcap.run_capture", params).await? {
            AgentResponse::Done { result } => Ok(serde_json::from_value(result)?),
            AgentResponse::Error { message } => Err(anyhow!(message)),
            AgentResponse::Token { .. } => Err(anyhow!("pcap.run_capture unexpectedly streamed")),
        }
    }

    pub async fn follow_stream(&self, path: &str, stream_index: u32) -> Result<FollowStreamResult> {
        let params = json!({ "path": path, "stream_index": stream_index });
        match self.agent.call("pcap.follow_stream", params).await? {
            AgentResponse::Done { result } => Ok(serde_json::from_value(result)?),
            AgentResponse::Error { message } => Err(anyhow!(message)),
            AgentResponse::Token { .. } => Err(anyhow!("pcap.follow_stream unexpectedly streamed")),
        }
    }
}
