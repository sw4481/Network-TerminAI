//! Plan 06 (SSH-direct) — SshTransport runs change-verify show commands over
//! a direct SSH session instead of the OSC-133 PTY runner, so pre/post
//! snapshots work against real network devices (which never emit OSC-133 and
//! would otherwise time out per command).
//!
//! The SSH call itself is injected so the transport's command-dispatch logic
//! is unit-testable without a real device.

use ccie_terminal_lib::change_verify::transport::ShowTransport;
use ccie_terminal_lib::change_verify::transport_ssh::SshTransport;
use std::sync::Arc;

#[tokio::test]
async fn ssh_transport_runs_command_via_injected_exec() {
    let calls = Arc::new(parking_lot::Mutex::new(Vec::<String>::new()));
    let calls2 = calls.clone();
    let transport = SshTransport::new(
        "cisco".to_string(),
        "iosxe".to_string(),
        Arc::new(move |cmd: String| {
            let calls = calls2.clone();
            Box::pin(async move {
                calls.lock().push(cmd.clone());
                Ok(format!("output-of: {cmd}"))
            })
        }),
    );

    let out = transport.run_show("tab-ignored", "show version").await.unwrap();
    assert_eq!(out, "output-of: show version");
    assert_eq!(calls.lock().as_slice(), &["show version".to_string()]);
}

#[tokio::test]
async fn ssh_transport_detect_platform_returns_constructed_vendor() {
    let transport = SshTransport::new(
        "arista".to_string(),
        "eos".to_string(),
        Arc::new(|_cmd: String| Box::pin(async move { Ok(String::new()) })),
    );
    let (vendor, platform) = transport.detect_platform("tab").await.unwrap();
    assert_eq!(vendor, "arista");
    assert_eq!(platform, "eos");
}

#[tokio::test]
async fn ssh_transport_propagates_exec_errors() {
    let transport = SshTransport::new(
        "cisco".to_string(),
        "iosxe".to_string(),
        Arc::new(|_cmd: String| {
            Box::pin(async move { Err(anyhow::anyhow!("ssh command failed: auth")) })
        }),
    );
    let err = transport.run_show("tab", "show run").await.unwrap_err();
    assert!(err.to_string().contains("auth"), "got: {err}");
}
