//! Plan 03 (SSH-direct) — SshPtyExecutor implements the notebook PtyExecutor
//! trait by running each command over a one-shot SSH session instead of the
//! OSC-133 PTY runner, so runnable MOPs / notebooks work against real network
//! devices (which never emit OSC-133 and would otherwise time out per cell).
//!
//! The SSH dispatch is injected so the executor's logic is unit-testable
//! without a live device.

use ccie_terminal_lib::notebooks::runner::PtyExecutor;
use ccie_terminal_lib::ssh_exec::SshPtyExecutor;
use std::sync::Arc;

#[tokio::test]
async fn ssh_pty_executor_returns_command_output() {
    let exec = SshPtyExecutor::new(Arc::new(|cmd: String| {
        Box::pin(async move { Ok(format!("ran:{cmd}")) })
    }));

    let result = exec
        .run_command("tab-ignored", "show version", "block-ignored")
        .await
        .unwrap();

    assert_eq!(result.output, "ran:show version");
    // Direct SSH exec succeeded, so report success.
    assert_eq!(result.exit_code, Some(0));
}

#[tokio::test]
async fn ssh_pty_executor_reports_nonzero_on_error() {
    let exec = SshPtyExecutor::new(Arc::new(|_cmd: String| {
        Box::pin(async move { Err(anyhow::anyhow!("ssh command failed")) })
    }));

    let result = exec
        .run_command("tab", "show run", "block")
        .await
        .unwrap();

    // The notebook runner inspects exit_code to mark a cell failed; a failed
    // SSH exec must surface as a non-zero code rather than an Err that aborts
    // the whole run.
    assert_ne!(result.exit_code, Some(0));
    assert!(result.output.contains("ssh command failed"));
}
