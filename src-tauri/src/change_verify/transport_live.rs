//! Live `ShowTransport` impl. Thin adapter over `pty_runner::AppStatePtyExecutor`
//! so change-verification reuses the exact PTY write + OSC-133 capture path
//! that runnable notebooks (Plan 03) already proves against real network
//! devices.
//!
//! Vendor/platform are not auto-detected — the frontend tracks them in the
//! `tabsStore` and passes them through to the Tauri command, identical to the
//! `structured_auto_parse(blockId, vendor, platform)` pattern.

use std::collections::HashSet;
use std::sync::Arc;

use anyhow::{Context, Result};
use async_trait::async_trait;
use parking_lot::Mutex;

use super::transport::ShowTransport;
use crate::notebooks::runner::PtyExecutor;

/// One instance is bound to one tab's vendor/platform. Construct a fresh
/// instance per `run_snapshot` call — do not reuse across tabs that may be
/// talking to different vendors.
pub struct LiveTransport {
    executor: Arc<dyn PtyExecutor>,
    vendor: String,
    platform: String,
    disable_pager: bool,
    pager_done: Mutex<HashSet<String>>,
}

impl LiveTransport {
    pub fn new(executor: Arc<dyn PtyExecutor>, vendor: String, platform: String) -> Self {
        Self {
            executor,
            vendor,
            platform,
            disable_pager: false,
            pager_done: Mutex::new(HashSet::new()),
        }
    }

    /// Send `terminal length 0` once per tab before the first show command on
    /// Cisco devices so the `--More--` pager does not stall output capture.
    pub fn with_pager_disabled(mut self) -> Self {
        self.disable_pager = true;
        self
    }

    fn needs_pager_disable(&self) -> bool {
        self.disable_pager && self.vendor.eq_ignore_ascii_case("cisco")
    }
}

#[async_trait]
impl ShowTransport for LiveTransport {
    async fn run_show(&self, tab_id: &str, command: &str) -> Result<String> {
        let block_id = format!("change-verify-{tab_id}");
        if self.needs_pager_disable() && self.pager_done.lock().insert(tab_id.to_string()) {
            self.executor
                .run_command(tab_id, "terminal length 0", &block_id)
                .await
                .with_context(|| format!("disable pager tab={tab_id}"))?;
        }
        let result = self
            .executor
            .run_command(tab_id, command, &block_id)
            .await
            .with_context(|| format!("run_command tab={tab_id} cmd={command}"))?;
        Ok(result.output)
    }

    async fn detect_platform(&self, _tab_id: &str) -> Result<(String, String)> {
        Ok((self.vendor.clone(), self.platform.clone()))
    }
}
