//! Concrete `Executor` that drives a live device for packet capture.
//!
//! Command execution (setup/start/poll/stop/cleanup) goes through the shared,
//! device-friendly `crate::ssh_exec` helper, which shells out to the system
//! `ssh` client via `sshpass`. We do NOT use a pure-Rust russh `exec` channel
//! here: Cisco IOS/IOS-XE (and others) reject russh `exec` requests with an
//! immediate "Disconnected" — the exact failure observed in the Captures
//! panel — whereas `ssh host "cmd"` works (it's the same path topology
//! discovery uses successfully against these devices).
//!
//! The `.pcap` file pull still uses russh-sftp (`pcap::sftp`): SFTP is a
//! subsystem request (like NETCONF), which these devices accept once the SSH
//! session has authenticated.
//!
//! Keep this thin — anything testable belongs in `crate::ssh_exec`, `sftp`, or
//! `orchestrator` directly.

use std::path::Path;
use std::time::Duration;

use anyhow::{anyhow, Result};

use super::orchestrator::Executor;
use super::scp;
use super::ssh_exec::DeviceConn;
use crate::ssh_exec::{run_command, SshTarget};

/// Per-command timeout for capture setup/start/stop lines. Generous because
/// `monitor capture ... export` can take a few seconds on a busy device.
const PER_CMD_TIMEOUT: Duration = Duration::from_secs(60);

/// How often to re-issue the poll command while waiting for the capture to
/// report Inactive.
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Each capture line opens its own one-shot SSH session. Firing many in quick
/// succession occasionally trips the device's SSH stack ("Connection closed by
/// <host>" mid-handshake) — observed intermittently on a live Catalyst 9000.
/// Retry a transient connection failure a few times with a short backoff so a
/// single dropped session doesn't fail the whole capture.
const MAX_SSH_ATTEMPTS: usize = 4;
const SSH_RETRY_DELAY: Duration = Duration::from_millis(800);

/// True if an ssh error looks transient (session dropped during connect), as
/// opposed to a real command/auth error we should surface immediately.
fn is_transient_ssh_error(msg: &str) -> bool {
    let m = msg.to_lowercase();
    m.contains("connection closed")
        || m.contains("closed by")
        || m.contains("connection reset")
        || m.contains("connection refused")
        || m.contains("timed out")
        || m.contains("timeout")
        || m.contains("broken pipe")
        || m.contains("kex_exchange_identification")
}

pub struct LiveExecutor {
    pub conn: DeviceConn,
}

impl LiveExecutor {
    /// Build the shared-executor target from this capture's connection.
    fn target(&self) -> SshTarget {
        SshTarget {
            host: self.conn.host.clone(),
            port: self.conn.port,
            username: self.conn.username.clone(),
            password: self.conn.password.clone(),
        }
    }

    /// Run one command, retrying transient SSH connection drops with backoff.
    async fn run_one(target: &SshTarget, line: &str) -> Result<String> {
        let mut last_err = String::new();
        for attempt in 1..=MAX_SSH_ATTEMPTS {
            match run_command(target, line, PER_CMD_TIMEOUT).await {
                Ok(out) => return Ok(out),
                Err(e) => {
                    let msg = e.to_string();
                    if attempt < MAX_SSH_ATTEMPTS && is_transient_ssh_error(&msg) {
                        tokio::time::sleep(SSH_RETRY_DELAY).await;
                        last_err = msg;
                        continue;
                    }
                    return Err(anyhow!("'{line}': {msg}"));
                }
            }
        }
        Err(anyhow!("'{line}': {last_err}"))
    }
}

#[async_trait::async_trait]
impl Executor for LiveExecutor {
    async fn exec_lines(&self, lines: &[String]) -> Result<String> {
        // Each line runs over its own one-shot `ssh host "<line>"` session.
        // `monitor capture` definitions are global device state (not session
        // state), so running them in separate sessions is equivalent to
        // pasting them one at a time at the EXEC prompt.
        let target = self.target();
        let mut combined = String::new();
        for line in lines {
            let out = Self::run_one(&target, line).await?;
            combined.push_str(&out);
        }
        Ok(combined)
    }

    async fn poll_until(
        &self,
        poll_cmd: &str,
        done: Box<dyn for<'a> Fn(&'a str) -> bool + Send>,
        timeout: Duration,
    ) -> Result<()> {
        let target = self.target();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let out = Self::run_one(&target, poll_cmd).await?;
            if done(&out) {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(anyhow!("poll timed out after {timeout:?}"));
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }

    async fn sftp_pull(&self, remote: &str, local: &Path) -> Result<u64> {
        // Pull via SCP, not SFTP: Cisco IOS-XE switches enable an SCP server
        // (`ip scp server enable`) but expose no SFTP subsystem, so a russh-sftp
        // handshake just times out (verified against a live Catalyst 9000). SCP
        // over the system client is the device-friendly path — same rationale
        // as command execution going through `crate::ssh_exec`.
        scp::pull_file(&self.conn, remote, local).await
    }
}

#[cfg(test)]
mod tests {
    use super::is_transient_ssh_error;

    #[test]
    fn classifies_dropped_session_as_transient() {
        assert!(is_transient_ssh_error(
            "ssh command failed: Connection closed by device.example.test port 22"
        ));
        assert!(is_transient_ssh_error("ssh command timed out"));
        assert!(is_transient_ssh_error("kex_exchange_identification: read"));
        assert!(is_transient_ssh_error("Connection reset by peer"));
    }

    #[test]
    fn does_not_retry_real_command_errors() {
        // A device CLI rejection is NOT transient — surface it immediately.
        assert!(!is_transient_ssh_error(
            "% Invalid input detected at '^' marker."
        ));
        assert!(!is_transient_ssh_error("Permission denied"));
    }
}
