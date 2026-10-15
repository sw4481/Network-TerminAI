//! Issue #5: live change verification must disable the IOS `--More--` pager
//! before sending show commands, otherwise only the first screen is captured.

use anyhow::Result;
use async_trait::async_trait;
use ccie_terminal_lib::change_verify::transport::ShowTransport;
use ccie_terminal_lib::change_verify::transport_live::LiveTransport;
use ccie_terminal_lib::notebooks::runner::{PtyExecutor, PtyRunResult};
use parking_lot::Mutex;
use std::sync::Arc;

struct FakeExecutor {
    captured: Mutex<Vec<String>>,
}

#[async_trait]
impl PtyExecutor for FakeExecutor {
    async fn run_command(&self, _tab: &str, command: &str, _block: &str) -> Result<PtyRunResult> {
        self.captured.lock().push(command.into());
        Ok(PtyRunResult {
            output: String::new(),
            exit_code: Some(0),
            duration_ms: 1,
        })
    }
}

#[tokio::test]
async fn ios_pager_is_disabled_once_before_first_show() {
    let exec = Arc::new(FakeExecutor {
        captured: Mutex::new(Vec::new()),
    });
    let transport =
        LiveTransport::new(exec.clone(), "cisco".into(), "iosxe".into()).with_pager_disabled();
    transport.run_show("tab1", "show version").await.unwrap();
    transport.run_show("tab1", "show vlan").await.unwrap();
    let cmds = exec.captured.lock().clone();
    assert_eq!(cmds, vec!["terminal length 0", "show version", "show vlan"]);
}

#[tokio::test]
async fn non_cisco_does_not_send_pager_command() {
    let exec = Arc::new(FakeExecutor {
        captured: Mutex::new(Vec::new()),
    });
    let transport =
        LiveTransport::new(exec.clone(), "juniper".into(), "junos".into()).with_pager_disabled();
    transport.run_show("tab1", "show version").await.unwrap();
    assert_eq!(exec.captured.lock().clone(), vec!["show version"]);
}
