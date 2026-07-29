//! SSH-direct `ShowTransport` for change verification (Plan 06).
//!
//! The original `transport_live::LiveTransport` drives the tab's interactive
//! PTY and waits for an OSC-133 CommandEnd marker. Network devices never emit
//! OSC-133, so each command waits the full PTY timeout before returning a
//! best-effort scrollback diff — change-verify is effectively broken in an
//! interactive SSH session.
//!
//! `SshTransport` instead runs each command over its own one-shot SSH session
//! (via [`crate::ssh_exec`]), exactly like topology discovery. Vendor/platform
//! are bound at construction from the frontend's tab state, mirroring the
//! existing `LiveTransport` contract.
//!
//! The actual SSH dispatch is injected as a closure so the transport's logic
//! is unit-testable without a live device; production code wires the closure
//! to `ssh_exec::run_command` against a resolved [`crate::ssh_exec::SshTarget`].

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;

use super::transport::ShowTransport;

/// Async command-runner: given a command string, return its raw output.
pub type ExecFn = Arc<
    dyn Fn(String) -> Pin<Box<dyn Future<Output = Result<String>> + Send>> + Send + Sync,
>;

pub struct SshTransport {
    vendor: String,
    platform: String,
    exec: ExecFn,
}

impl SshTransport {
    pub fn new(vendor: String, platform: String, exec: ExecFn) -> Self {
        Self { vendor, platform, exec }
    }

    /// Build a transport that runs commands against `target` via
    /// `ssh_exec::run_command`. This is the production constructor.
    pub fn from_target(
        vendor: String,
        platform: String,
        target: crate::ssh_exec::SshTarget,
    ) -> Self {
        let target = Arc::new(target);
        let exec: ExecFn = Arc::new(move |cmd: String| {
            let target = target.clone();
            Box::pin(async move {
                crate::ssh_exec::run_command(
                    &target,
                    &cmd,
                    crate::ssh_exec::DEFAULT_CMD_TIMEOUT,
                )
                .await
                .map_err(|e| anyhow::anyhow!(e.to_string()))
            })
        });
        Self::new(vendor, platform, exec)
    }
}

#[async_trait]
impl ShowTransport for SshTransport {
    async fn run_show(&self, _tab_id: &str, command: &str) -> Result<String> {
        (self.exec)(command.to_string()).await
    }

    async fn detect_platform(&self, _tab_id: &str) -> Result<(String, String)> {
        Ok((self.vendor.clone(), self.platform.clone()))
    }
}
