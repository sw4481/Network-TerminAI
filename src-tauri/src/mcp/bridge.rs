// MCP bridge for handling tool invocations with approval gating

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

/// Request from Python to invoke an MCP tool
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpInvokeRequest {
    pub server: String,
    pub tool: String,
    pub args: Value,
}

/// Response to Python after tool execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpInvokeResponse {
    pub approved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Tool approval request sent to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolApprovalRequest {
    pub request_id: String,
    pub server: String,
    pub tool: String,
    pub description: String,
    pub args: Value,
}

/// Policy decision for tool approval
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PolicyDecision {
    /// Automatically approved by policy
    AutoApproved,
    /// Requires user approval
    RequiresApproval,
    /// Automatically denied by policy
    Denied { reason: String },
}

/// Policy engine for tool approvals
pub struct PolicyEngine {
    /// Map of (server, tool) -> always_allow
    allowed_tools: Arc<Mutex<HashMap<(String, String), bool>>>,
}

impl PolicyEngine {
    pub fn new() -> Self {
        Self {
            allowed_tools: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Check if a tool needs approval
    pub fn check_policy(&self, server: &str, tool: &str) -> PolicyDecision {
        let allowed = self.allowed_tools.lock();
        let key = (server.to_string(), tool.to_string());

        let decision = if allowed.get(&key) == Some(&true) {
            PolicyDecision::AutoApproved
        } else {
            PolicyDecision::RequiresApproval
        };

        tracing::debug!(
            server = %server,
            tool = %tool,
            decision = ?decision,
            "Policy check completed"
        );

        decision
    }

    /// Remember approval decision for a tool
    pub fn remember_approval(&self, server: &str, tool: &str, allow: bool) {
        tracing::info!(
            server = %server,
            tool = %tool,
            allow = allow,
            "Remembering tool approval decision"
        );

        let mut allowed = self.allowed_tools.lock();
        let key = (server.to_string(), tool.to_string());
        allowed.insert(key, allow);
    }
}

impl Default for PolicyEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// MCP bridge state
pub struct McpBridge {
    policy: Arc<PolicyEngine>,
    /// Pending approval requests
    pending: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>>,
}

impl McpBridge {
    pub fn new() -> Self {
        Self {
            policy: Arc::new(PolicyEngine::new()),
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Handle an MCP invoke request from Python
    pub async fn handle_invoke(&self, request: McpInvokeRequest) -> Result<McpInvokeResponse> {
        // Check policy
        match self.policy.check_policy(&request.server, &request.tool) {
            PolicyDecision::AutoApproved => {
                // Execute tool directly
                self.execute_tool(&request).await
            }
            PolicyDecision::RequiresApproval => {
                // Request user approval
                let approved = self.request_approval(&request).await?;

                if approved {
                    self.execute_tool(&request).await
                } else {
                    Ok(McpInvokeResponse {
                        approved: false,
                        result: None,
                        error: None,
                        reason: Some("User denied approval".to_string()),
                    })
                }
            }
            PolicyDecision::Denied { reason } => Ok(McpInvokeResponse {
                approved: false,
                result: None,
                error: None,
                reason: Some(reason),
            }),
        }
    }

    /// Request approval from user (sends event to frontend)
    async fn request_approval(&self, request: &McpInvokeRequest) -> Result<bool> {
        // Generate unique request ID
        let request_id = format!("approval-{}", uuid::Uuid::new_v4());

        // Create channel for response
        let (tx, rx) = tokio::sync::oneshot::channel();

        // Register pending request
        {
            let mut pending = self.pending.lock();
            pending.insert(request_id.clone(), tx);
        }

        // Emit event to frontend
        // Note: In real implementation, this would use Tauri's event system
        // For now, we'll simulate with a log
        let approval_request = ToolApprovalRequest {
            request_id: request_id.clone(),
            server: request.server.clone(),
            tool: request.tool.clone(),
            description: format!("Execute {} on {}", request.tool, request.server),
            args: request.args.clone(),
        };

        // TODO: Emit to frontend
        // tauri::emit("tool_approval_needed", approval_request)?;
        log::info!("Tool approval needed: {:?}", approval_request);

        // Wait for response (with timeout)
        let approved = tokio::time::timeout(std::time::Duration::from_secs(30), rx)
            .await
            .map_err(|_| anyhow!("Approval request timed out"))?
            .map_err(|_| anyhow!("Approval channel closed"))?;

        // Clean up pending request
        {
            let mut pending = self.pending.lock();
            pending.remove(&request_id);
        }

        Ok(approved)
    }

    /// Handle approval response from frontend
    pub fn handle_approval(&self, request_id: &str, approved: bool, _remember: bool) -> Result<()> {
        // Find and notify pending request
        let tx = {
            let mut pending = self.pending.lock();
            pending
                .remove(request_id)
                .ok_or_else(|| anyhow!("No pending approval request with ID: {}", request_id))?
        };

        // Send approval decision
        tx.send(approved)
            .map_err(|_| anyhow!("Failed to send approval response"))?;

        Ok(())
    }

    /// Execute MCP tool (stub for now)
    async fn execute_tool(&self, request: &McpInvokeRequest) -> Result<McpInvokeResponse> {
        // TODO: Implement actual MCP server communication
        // For now, return a mock response
        log::info!("Executing MCP tool: {} on {}", request.tool, request.server);

        // Simulate tool execution
        let result = serde_json::json!({
            "status": "success",
            "message": format!("Tool {} executed", request.tool),
            "args": request.args
        });

        Ok(McpInvokeResponse {
            approved: true,
            result: Some(result),
            error: None,
            reason: None,
        })
    }

    /// Remember approval policy for a tool
    pub fn remember_tool_approval(&self, server: &str, tool: &str, allow: bool) {
        self.policy.remember_approval(server, tool, allow);
    }
}

impl Default for McpBridge {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_policy_engine_default_requires_approval() {
        let engine = PolicyEngine::new();
        let decision = engine.check_policy("test-server", "test-tool");
        matches!(decision, PolicyDecision::RequiresApproval);
    }

    #[test]
    fn test_policy_engine_remembers_approval() {
        let engine = PolicyEngine::new();
        engine.remember_approval("test-server", "test-tool", true);
        let decision = engine.check_policy("test-server", "test-tool");
        matches!(decision, PolicyDecision::AutoApproved);
    }

    #[tokio::test]
    async fn test_mcp_bridge_execute_tool() {
        let bridge = McpBridge::new();
        let request = McpInvokeRequest {
            server: "test-server".to_string(),
            tool: "test-tool".to_string(),
            args: serde_json::json!({"key": "value"}),
        };

        let response = bridge.execute_tool(&request).await.unwrap();
        assert!(response.approved);
        assert!(response.result.is_some());
    }
}
