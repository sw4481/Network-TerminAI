//! LiveTransport unit test using a fake PtyExecutor — the live PTY path
//! itself is exercised by Plan 03's notebooks_runner_integration_test, so we
//! only need to confirm LiveTransport correctly threads its arguments
//! through and surfaces vendor/platform.

use anyhow::Result;
use async_trait::async_trait;
use ccie_terminal_lib::change_verify::transport::ShowTransport;
use ccie_terminal_lib::change_verify::transport_live::LiveTransport;
use ccie_terminal_lib::notebooks::runner::{PtyExecutor, PtyRunResult};
use parking_lot::Mutex;
use std::sync::Arc;

struct FakeExecutor {
    captured: Mutex<Vec<(String, String)>>, // (tab_id, command)
    response: String,
}

#[async_trait]
impl PtyExecutor for FakeExecutor {
    async fn run_command(
        &self,
        tab_id: &str,
        command: &str,
        _block_id: &str,
    ) -> Result<PtyRunResult> {
        self.captured.lock().push((tab_id.into(), command.into()));
        Ok(PtyRunResult {
            output: self.response.clone(),
            exit_code: Some(0),
            duration_ms: 1,
        })
    }
}

#[tokio::test]
async fn live_transport_threads_command_to_executor() {
    let exec = Arc::new(FakeExecutor {
        captured: Mutex::new(Vec::new()),
        response: "Interface           IP-Address     OK?".into(),
    });
    let transport = LiveTransport::new(exec.clone(), "cisco".into(), "iosxe".into());
    let out = transport.run_show("tab42", "show ip interface brief").await.unwrap();
    assert!(out.contains("Interface"));
    let captured = exec.captured.lock();
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].0, "tab42");
    assert_eq!(captured[0].1, "show ip interface brief");
}

#[tokio::test]
async fn live_transport_returns_constructor_vendor_platform() {
    let exec = Arc::new(FakeExecutor {
        captured: Mutex::new(Vec::new()),
        response: String::new(),
    });
    let transport = LiveTransport::new(exec, "juniper".into(), "junos".into());
    let (vendor, platform) = transport.detect_platform("tab42").await.unwrap();
    assert_eq!(vendor, "juniper");
    assert_eq!(platform, "junos");
}
