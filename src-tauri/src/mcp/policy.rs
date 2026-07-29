//! MCP tool approval policy engine
//!
//! Controls which MCP tools can execute automatically vs requiring user approval.
//! Supports four policy levels:
//! - AutoAllow: Always allow (e.g., read-only tools)
//! - Confirm: Prompt user each time
//! - ConfirmOnce: Prompt first time, then remember
//! - Deny: Never allow

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalPolicy {
    AutoAllow,
    Confirm,
    ConfirmOnce,
    Deny,
}

impl ApprovalPolicy {
    fn to_db_string(&self) -> &'static str {
        match self {
            ApprovalPolicy::AutoAllow => "auto_allow",
            ApprovalPolicy::Confirm => "confirm",
            ApprovalPolicy::ConfirmOnce => "confirm_once",
            ApprovalPolicy::Deny => "deny",
        }
    }

    fn from_db_string(s: &str) -> Result<Self> {
        match s {
            "auto_allow" => Ok(ApprovalPolicy::AutoAllow),
            "confirm" => Ok(ApprovalPolicy::Confirm),
            "confirm_once" => Ok(ApprovalPolicy::ConfirmOnce),
            "deny" => Ok(ApprovalPolicy::Deny),
            _ => Err(anyhow::anyhow!("Invalid policy string: {}", s)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalDecision {
    pub policy: ApprovalPolicy,
    pub allowed: bool,
    pub needs_prompt: bool,
}

impl ApprovalDecision {
    pub fn allow() -> Self {
        Self {
            policy: ApprovalPolicy::AutoAllow,
            allowed: true,
            needs_prompt: false,
        }
    }

    pub fn deny() -> Self {
        Self {
            policy: ApprovalPolicy::Deny,
            allowed: false,
            needs_prompt: false,
        }
    }

    pub fn prompt(policy: ApprovalPolicy) -> Self {
        Self {
            policy,
            allowed: false,
            needs_prompt: true,
        }
    }
}

pub struct PolicyEngine<'conn> {
    conn: &'conn Connection,
}

impl<'conn> PolicyEngine<'conn> {
    pub fn new(conn: &'conn Connection) -> Result<Self> {
        Ok(Self { conn })
    }

    /// Check if a tool call needs approval
    pub fn check_tool(&self, server: &str, tool: &str, _args: &Value) -> Result<ApprovalDecision> {
        // First check if there's a remembered decision (for ConfirmOnce)
        if let Some(decision) = self.get_remembered_decision(server, tool)? {
            if decision == "allow" {
                return Ok(ApprovalDecision::allow());
            } else {
                return Ok(ApprovalDecision::deny());
            }
        }

        // Get the policy for this tool
        let policy = self.get_policy_internal(server, tool)?;

        // Apply policy
        match policy {
            ApprovalPolicy::AutoAllow => Ok(ApprovalDecision::allow()),
            ApprovalPolicy::Deny => Ok(ApprovalDecision::deny()),
            ApprovalPolicy::Confirm | ApprovalPolicy::ConfirmOnce => {
                Ok(ApprovalDecision::prompt(policy))
            }
        }
    }

    /// Record a user approval or denial decision
    pub fn record_decision(
        &mut self,
        server: &str,
        tool: &str,
        decision: ApprovalDecision,
        remember: bool,
    ) -> Result<()> {
        if !remember {
            return Ok(());
        }

        let decision_str = if decision.allowed { "allow" } else { "deny" };

        self.conn.execute(
            "INSERT OR REPLACE INTO approval_memory (server_name, tool_name, decision) VALUES (?, ?, ?)",
            params![server, tool, decision_str],
        )?;

        Ok(())
    }

    /// Get the policy for a specific tool
    pub fn get_policy_internal(&self, server: &str, tool: &str) -> Result<ApprovalPolicy> {
        // Check for explicit policy
        let policy: Option<String> = self
            .conn
            .query_row(
                "SELECT policy FROM approval_policies WHERE server_name = ? AND tool_name = ?",
                params![server, tool],
                |row| row.get(0),
            )
            .optional()?;

        if let Some(policy_str) = policy {
            return ApprovalPolicy::from_db_string(&policy_str);
        }

        // Fall back to default policies based on tool name patterns
        Ok(Self::default_policy_for_tool(tool))
    }

    /// Set an explicit policy for a tool
    pub fn set_policy(&mut self, server: &str, tool: &str, policy: ApprovalPolicy) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO approval_policies (server_name, tool_name, policy) VALUES (?, ?, ?)",
            params![server, tool, policy.to_db_string()],
        )?;
        Ok(())
    }

    /// Get a remembered decision for ConfirmOnce tools
    fn get_remembered_decision(&self, server: &str, tool: &str) -> Result<Option<String>> {
        let decision: Option<String> = self
            .conn
            .query_row(
                "SELECT decision FROM approval_memory WHERE server_name = ? AND tool_name = ?",
                params![server, tool],
                |row| row.get(0),
            )
            .optional()?;

        Ok(decision)
    }

    /// Determine default policy based on tool name patterns
    fn default_policy_for_tool(tool: &str) -> ApprovalPolicy {
        let tool_lower = tool.to_lowercase();

        // Read-only operations - AutoAllow
        if tool_lower.contains("read")
            || tool_lower.contains("get")
            || tool_lower.contains("list")
            || tool_lower.contains("search")
            || tool_lower.contains("find")
            || tool_lower.contains("query")
        {
            return ApprovalPolicy::AutoAllow;
        }

        // Dangerous operations - ConfirmOnce (with typed confirmation)
        if tool_lower.contains("delete")
            || tool_lower.contains("remove")
            || tool_lower.contains("destroy")
            || tool_lower.contains("execute")
            || tool_lower.contains("exec")
            || tool_lower.contains("run")
            || tool_lower.contains("shell")
        {
            return ApprovalPolicy::ConfirmOnce;
        }

        // Write operations - Confirm each time
        if tool_lower.contains("write")
            || tool_lower.contains("create")
            || tool_lower.contains("update")
            || tool_lower.contains("modify")
            || tool_lower.contains("set")
        {
            return ApprovalPolicy::Confirm;
        }

        // Default to Confirm for unknown tools
        ApprovalPolicy::Confirm
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_policies() {
        assert_eq!(
            PolicyEngine::default_policy_for_tool("read_file"),
            ApprovalPolicy::AutoAllow
        );
        assert_eq!(
            PolicyEngine::default_policy_for_tool("write_file"),
            ApprovalPolicy::Confirm
        );
        assert_eq!(
            PolicyEngine::default_policy_for_tool("execute"),
            ApprovalPolicy::ConfirmOnce
        );
        assert_eq!(
            PolicyEngine::default_policy_for_tool("delete_all"),
            ApprovalPolicy::ConfirmOnce
        );
    }

    #[test]
    fn test_approval_decision_constructors() {
        let allow = ApprovalDecision::allow();
        assert!(allow.allowed);
        assert!(!allow.needs_prompt);

        let deny = ApprovalDecision::deny();
        assert!(!deny.allowed);
        assert!(!deny.needs_prompt);

        let prompt = ApprovalDecision::prompt(ApprovalPolicy::Confirm);
        assert!(!prompt.allowed);
        assert!(prompt.needs_prompt);
    }
}
