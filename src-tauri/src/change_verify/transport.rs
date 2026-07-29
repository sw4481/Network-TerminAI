use anyhow::Result;
use async_trait::async_trait;

/// Read-only show-command transport. Implementations wrap the existing
/// netconf or pty session for a given tab.
#[async_trait]
pub trait ShowTransport: Send + Sync {
    /// Execute a read-only show command against whatever session is attached
    /// to `tab_id` and return the raw text output. Must be idempotent and
    /// must NOT enter config mode.
    async fn run_show(&self, tab_id: &str, command: &str) -> Result<String>;

    /// Return (vendor, platform) for the session attached to `tab_id`.
    async fn detect_platform(&self, tab_id: &str) -> Result<(String, String)>;
}
