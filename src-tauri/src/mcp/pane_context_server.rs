//! MCP server for exposing pane context state to external agents.
//!
//! This server provides tools and resources for querying pane layout, activity,
//! and command state. Designed to be consumed by agents like Claude Code running
//! in a terminal pane.

use crate::pane_context::PaneContextManager;
use crate::mcp::types::Tool;
use anyhow::Result;
use serde_json::{json, Value};
use std::sync::Arc;

pub struct PaneContextMcpServer {
    manager: Arc<PaneContextManager>,
    browser_manager: std::sync::Arc<crate::browser::BrowserManager>,
}

impl PaneContextMcpServer {
    pub fn new(manager: Arc<PaneContextManager>, browser_manager: Arc<crate::browser::BrowserManager>) -> Self {
        Self { manager, browser_manager }
    }

    /// Get the list of MCP resources exposed by this server
    pub fn get_resources(&self) -> Vec<String> {
        vec![
            "pane://layout".to_string(),
        ]
    }

    /// Get the list of MCP tools exposed by this server
    pub fn get_tools(&self) -> Vec<Tool> {
        vec![
            Tool {
                name: "get_pane_layout".to_string(),
                description: "Get the current pane tree layout with all pane IDs and types".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {}
                }),
            },
            Tool {
                name: "get_pane_activity".to_string(),
                description: "Get activity details for a specific pane".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "pane_id": {
                            "type": "string",
                            "description": "The pane ID to query"
                        }
                    },
                    "required": ["pane_id"]
                }),
            },
            Tool {
                name: "get_focused_pane".to_string(),
                description: "Get the currently focused pane".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {}
                }),
            },
            Tool {
                name: "get_all_active_commands".to_string(),
                description: "List all currently running commands across all panes".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {}
                }),
            },
            Tool {
                name: "browser_list".to_string(),
                description: "List all open browser windows with their browser_id and url".to_string(),
                input_schema: serde_json::json!({ "type": "object", "properties": {} }),
            },
            Tool {
                name: "browser_get_content".to_string(),
                description: "Get the current URL of an open browser window by browser_id".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": { "browser_id": { "type": "string" } },
                    "required": ["browser_id"]
                }),
            },
        ]
    }

    /// Handle a tool invocation
    pub fn handle_tool_call(&self, tool_name: &str, arguments: Value) -> Result<Value> {
        match tool_name {
            "get_pane_layout" => self.handle_get_pane_layout(),
            "get_pane_activity" => self.handle_get_pane_activity(arguments),
            "get_focused_pane" => self.handle_get_focused_pane(),
            "get_all_active_commands" => self.handle_get_all_active_commands(),
            "browser_list" => {
                let windows = self.browser_manager.list();
                Ok(serde_json::json!({ "windows": windows, "count": windows.len() }))
            }
            "browser_get_content" => {
                let browser_id = arguments.get("browser_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow::anyhow!("Missing browser_id"))?;
                match self.browser_manager.get_url(browser_id) {
                    Some(url) => Ok(serde_json::json!({ "browserId": browser_id, "url": url })),
                    None => Err(anyhow::anyhow!("Browser window not found: {}", browser_id)),
                }
            }
            _ => Err(anyhow::anyhow!("Unknown tool: {}", tool_name)),
        }
    }

    /// Handle resource request for pane:// URIs
    pub fn handle_resource_request(&self, uri: &str) -> Result<Value> {
        if uri == "pane://layout" {
            // Same as get_pane_layout tool
            return self.handle_get_pane_layout();
        }

        // Pattern: pane://{pane_id}/activity
        if let Some(pane_id) = uri.strip_prefix("pane://").and_then(|s| s.strip_suffix("/activity")) {
            return self.handle_get_pane_activity(json!({"pane_id": pane_id}));
        }

        Err(anyhow::anyhow!("Unknown resource: {}", uri))
    }

    // Internal handlers

    fn handle_get_pane_layout(&self) -> Result<Value> {
        let activities = self.manager.get_all_activities_global();
        let mut panes_by_tab: std::collections::HashMap<String, Vec<_>> =
            std::collections::HashMap::new();

        for activity in &activities {
            panes_by_tab.entry(activity.tab_id.clone())
                .or_default()
                .push(json!({
                    "paneId": activity.pane_id,
                    "cwd": activity.cwd,
                    "notificationState": match activity.notification_state {
                        crate::pane_context::NotificationState::Idle => "idle",
                        crate::pane_context::NotificationState::Running => "running",
                        crate::pane_context::NotificationState::NeedsAttention => "needs_attention",
                    },
                }));
        }

        Ok(json!({
            "tabs": panes_by_tab,
            "totalPanes": activities.len()
        }))
    }

    fn handle_get_pane_activity(&self, arguments: Value) -> Result<Value> {
        let pane_id = arguments.get("pane_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("Missing pane_id"))?;

        if let Some(activity) = self.manager.get_activity(pane_id) {
            Ok(serde_json::to_value(activity)?)
        } else {
            Err(anyhow::anyhow!("Pane not found: {}", pane_id))
        }
    }

    fn handle_get_focused_pane(&self) -> Result<Value> {
        let focused_id = self.manager.get_focused_pane_id();
        if let Some(pane_id) = focused_id {
            if let Some(activity) = self.manager.get_activity(&pane_id) {
                return Ok(serde_json::to_value(activity)?);
            }
        }
        Err(anyhow::anyhow!("No focused pane"))
    }

    fn handle_get_all_active_commands(&self) -> Result<Value> {
        let activities = self.manager.get_all_activities_global();
        let running: Vec<_> = activities
            .into_iter()
            .filter_map(|activity| {
                activity.active_command.as_ref().and_then(|cmd| {
                    if cmd.exit_code.is_none() {
                        Some(json!({
                            "paneId": activity.pane_id,
                            "command": cmd.cmd,
                            "startTime": cmd.start_time,
                            "cwd": activity.cwd,
                        }))
                    } else {
                        None
                    }
                })
            })
            .collect();

        Ok(json!({
            "runningCommands": running,
            "count": running.len()
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pane_context::PaneContextManager;

    #[test]
    fn test_get_tools() {
        let manager = Arc::new(PaneContextManager::new());
        let server = PaneContextMcpServer::new(manager, std::sync::Arc::new(crate::browser::BrowserManager::new()));

        let tools = server.get_tools();
        assert_eq!(tools.len(), 6);
        assert_eq!(tools[0].name, "get_pane_layout");
        assert_eq!(tools[1].name, "get_pane_activity");
        assert_eq!(tools[2].name, "get_focused_pane");
        assert_eq!(tools[3].name, "get_all_active_commands");
        assert_eq!(tools[4].name, "browser_list");
        assert_eq!(tools[5].name, "browser_get_content");
    }

    #[test]
    fn test_get_resources() {
        let manager = Arc::new(PaneContextManager::new());
        let server = PaneContextMcpServer::new(manager, std::sync::Arc::new(crate::browser::BrowserManager::new()));

        let resources = server.get_resources();
        assert_eq!(resources.len(), 1);
        assert_eq!(resources[0], "pane://layout");
    }

    #[test]
    fn test_handle_tool_call_unknown() {
        let manager = Arc::new(PaneContextManager::new());
        let server = PaneContextMcpServer::new(manager, std::sync::Arc::new(crate::browser::BrowserManager::new()));

        let result = server.handle_tool_call("unknown_tool", json!({}));
        assert!(result.is_err());
    }

    #[test]
    fn test_handle_resource_request_layout() {
        let manager = Arc::new(PaneContextManager::new());
        let server = PaneContextMcpServer::new(manager, std::sync::Arc::new(crate::browser::BrowserManager::new()));

        let result = server.handle_resource_request("pane://layout");
        assert!(result.is_ok());
    }

    #[test]
    fn test_handle_resource_request_unknown() {
        let manager = Arc::new(PaneContextManager::new());
        let server = PaneContextMcpServer::new(manager, std::sync::Arc::new(crate::browser::BrowserManager::new()));

        let result = server.handle_resource_request("pane://unknown");
        assert!(result.is_err());
    }
}
