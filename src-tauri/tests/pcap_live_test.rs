//! Live, manual integration test for the packet-capture SCP pull.
//!
//! Ignored by default (never runs in CI — it needs a real device). Run with:
//!
//! ```sh
//! CCIE_PCAP_TEST_HOST=device.example.test \
//! CCIE_PCAP_TEST_USER=cisco \
//! CCIE_PCAP_TEST_PASS=password1 \
//! cargo test --test pcap_live_test -- --ignored --nocapture
//! ```
//!
//! The capture lifecycle itself (setup → start → wait → stop → export) now runs
//! in the Python sidecar via pyATS (one persistent session — see
//! `sidecar/src/ccie_sidecar/pcap_capture.py` and its pytest suite), because
//! IOS-XE EPC ties the capture to the session that starts it. This Rust test
//! covers the half that stays in Rust: pulling the exported `.pcap` off the
//! device over SCP (`pcap::scp::pull_file`). It assumes a `CAP.pcap` already
//! exists on flash (e.g. left by a prior sidecar capture run).

use std::time::Duration;

use ccie_terminal_lib::pcap::scp;
use ccie_terminal_lib::pcap::ssh_exec::DeviceConn;

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

#[tokio::test]
#[ignore = "live device required; set CCIE_PCAP_TEST_HOST/USER/PASS"]
async fn live_scp_pull_pcap_from_flash() {
    let host = env("CCIE_PCAP_TEST_HOST").expect("set CCIE_PCAP_TEST_HOST");
    let user = env("CCIE_PCAP_TEST_USER").expect("set CCIE_PCAP_TEST_USER");
    let pass = env("CCIE_PCAP_TEST_PASS").expect("set CCIE_PCAP_TEST_PASS");

    let conn = DeviceConn { host, port: 22, username: user, password: pass };

    let dir = tempfile::TempDir::new().unwrap();
    let local = dir.path().join("pulled.pcap");

    // The SCP server resolves a bare basename against flash:; pull_file strips
    // the `flash:` prefix for us.
    let bytes = tokio::time::timeout(
        Duration::from_secs(30),
        scp::pull_file(&conn, "flash:CAP.pcap", &local),
    )
    .await
    .expect("scp pull should not hang")
    .expect("scp pull should succeed (ensure flash:CAP.pcap exists on the device)");

    eprintln!("pulled {bytes} bytes to {}", local.display());
    assert!(local.exists(), "local pcap file should exist");
    assert!(bytes > 0, "pulled file should be non-empty");
}
