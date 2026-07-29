//! Plan 15 (SSH-direct) — TroubleshootSshExec implements the troubleshoot
//! engine's SshExec trait via a one-shot SSH session, replacing the
//! UnimplementedSsh stub so diagnostic playbooks can actually run their
//! show-commands against a device.
//!
//! The SSH dispatch is injected so the adapter is unit-testable without a
//! live device.

use ccie_terminal_lib::ssh_exec::TroubleshootSshExec;
use ccie_terminal_lib::troubleshoot::live_executor::SshExec;
use std::sync::Arc;

#[tokio::test]
async fn troubleshoot_ssh_exec_returns_command_output() {
    let adapter = TroubleshootSshExec::new(Arc::new(|cmd: String| {
        Box::pin(async move { Ok(format!("ran:{cmd}")) })
    }));

    let out = adapter.exec("tab-ignored", "show ip ospf neighbor").await.unwrap();
    assert_eq!(out, "ran:show ip ospf neighbor");
}

#[tokio::test]
async fn troubleshoot_ssh_exec_propagates_errors() {
    let adapter = TroubleshootSshExec::new(Arc::new(|_cmd: String| {
        Box::pin(async move { Err(anyhow::anyhow!("ssh command failed: timeout")) })
    }));

    let err = adapter.exec("tab", "show run").await.unwrap_err();
    assert!(err.to_string().contains("timeout"), "got: {err}");
}
