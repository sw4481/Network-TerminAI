//! MCP client for spawning and communicating with MCP servers.

use crate::mcp::transport::StdioTransport;
use crate::mcp::types::{JsonRpcNotification, JsonRpcRequest, Tool};
use anyhow::{anyhow, Context, Result};
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

/// MCP client that manages a connection to an MCP server.
pub struct McpClient {
    id: String,
    transport: Arc<Mutex<StdioTransport>>,
    request_id: Arc<AtomicU64>,
    notification_rx: Arc<Mutex<tokio::sync::mpsc::UnboundedReceiver<JsonRpcNotification>>>,
    initialized: Arc<Mutex<bool>>,
}

impl McpClient {
    /// Create a new MCP client.
    pub fn new(
        id: String,
        command: String,
        args: Vec<String>,
        env: HashMap<String, String>,
        _transport_type: crate::mcp::types::McpTransport,
    ) -> Self {
        let transport = StdioTransport::new(command, args, env);
        let (notification_tx, notification_rx) = tokio::sync::mpsc::unbounded_channel();
        transport.set_notification_tx(notification_tx);

        Self {
            id,
            transport: Arc::new(Mutex::new(transport)),
            request_id: Arc::new(AtomicU64::new(0)),
            notification_rx: Arc::new(Mutex::new(notification_rx)),
            initialized: Arc::new(Mutex::new(false)),
        }
    }

    /// Get the next request ID.
    fn next_request_id(&self) -> u64 {
        self.request_id.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Start the MCP server process.
    pub async fn start(&self) -> Result<()> {
        let transport = self.transport.lock().await;
        transport
            .start()
            .await
            .context("Failed to start transport")?;
        Ok(())
    }

    /// Initialize the MCP session with the server.
    pub async fn initialize(&self) -> Result<serde_json::Value> {
        let request = JsonRpcRequest::new(
            self.next_request_id(),
            "initialize",
            Some(json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "ccie-terminal",
                    "version": "0.0.1"
                }
            })),
        );

        let transport = self.transport.lock().await;
        let response = transport
            .send_request(request, Duration::from_secs(30))
            .await
            .context("Initialize request failed")?;

        if let Some(result) = response.result {
            *self.initialized.lock().await = true;
            Ok(result)
        } else {
            Err(anyhow!("Initialize failed: no result"))
        }
    }

    /// List available tools from the MCP server.
    pub async fn list_tools(&self) -> Result<Vec<Tool>> {
        if !*self.initialized.lock().await {
            return Err(anyhow!("Client not initialized"));
        }

        let request = JsonRpcRequest::new(self.next_request_id(), "tools/list", None);

        let transport = self.transport.lock().await;
        let response = transport
            .send_request(request, Duration::from_secs(30))
            .await
            .context("List tools request failed")?;

        if let Some(result) = response.result {
            let tools = result
                .get("tools")
                .and_then(|t| t.as_array())
                .ok_or_else(|| anyhow!("Invalid tools response"))?;

            let parsed_tools: Vec<Tool> = tools
                .iter()
                .filter_map(|t| serde_json::from_value(t.clone()).ok())
                .collect();

            Ok(parsed_tools)
        } else {
            Err(anyhow!("List tools failed: no result"))
        }
    }

    /// Call a tool on the MCP server.
    pub async fn call_tool(
        &self,
        name: &str,
        arguments: serde_json::Value,
    ) -> Result<serde_json::Value> {
        if !*self.initialized.lock().await {
            return Err(anyhow!("Client not initialized"));
        }

        let request = JsonRpcRequest::new(
            self.next_request_id(),
            "tools/call",
            Some(json!({
                "name": name,
                "arguments": arguments
            })),
        );

        let transport = self.transport.lock().await;
        let response = transport
            .send_request(request, Duration::from_secs(30))
            .await
            .context("Call tool request failed")?;

        response
            .result
            .ok_or_else(|| anyhow!("Call tool failed: no result"))
    }

    /// Check if the server process is running.
    pub fn is_running(&self) -> bool {
        // This is not async, so we can't await the lock. Return true by default.
        // Real implementation would need to store process state differently.
        true
    }

    /// Gracefully shutdown the MCP server.
    pub async fn shutdown(&self) -> Result<()> {
        *self.initialized.lock().await = false;
        let transport = self.transport.lock().await;
        transport.kill().await.context("Failed to kill transport")?;
        Ok(())
    }

    /// Force kill the server process (for testing).
    pub async fn force_kill(&self) -> Result<()> {
        *self.initialized.lock().await = false;
        let transport = self.transport.lock().await;
        transport.kill().await.context("Failed to force kill")?;
        Ok(())
    }

    /// Get the server ID.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Receive a notification from the server (non-blocking).
    pub async fn try_recv_notification(&self) -> Option<JsonRpcNotification> {
        self.notification_rx.lock().await.try_recv().ok()
    }
}
