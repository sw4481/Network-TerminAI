//! Phase 3 — PTY tap channel.

use ccie_terminal_lib::pty::{spawn_pty, PtyEvent, PtyOptions, RawOutput};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::timeout;

fn shell() -> String {
    if cfg!(windows) {
        "cmd.exe".into()
    } else {
        "/bin/sh".into()
    }
}

#[tokio::test]
async fn tap_receives_pty_bytes_and_detach_stops_them() {
    let (tx, mut rx) = mpsc::channel::<PtyEvent>(64);
    let handle = spawn_pty(
        PtyOptions {
            shell: shell(),
            args: vec!["-c".into(), "echo first; sleep 0.5; echo second".into()],
            cwd: "/tmp".into(),
            cols: 80,
            rows: 24,
            pane_id: None,
            claude_config_dir: None,
        },
        tx,
    )
    .await
    .unwrap();

    let (tap_tx, mut tap_rx) = mpsc::channel::<RawOutput>(64);
    handle.attach_tap(tap_tx);

    // Drain PtyEvents in a background task so the writer side never
    // back-pressures the reader thread.
    tokio::spawn(async move { while rx.recv().await.is_some() {} });

    // Wait for any tap byte to arrive; combine until we see "first".
    let mut combined: Vec<u8> = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_millis(2000);
    while std::time::Instant::now() < deadline {
        if let Ok(Some(raw)) = timeout(Duration::from_millis(200), tap_rx.recv()).await {
            combined.extend_from_slice(&raw.bytes);
            if combined.windows(5).any(|w| w == b"first") {
                break;
            }
        }
    }
    assert!(
        combined.windows(5).any(|w| w == b"first"),
        "tap never saw 'first': {:?}",
        String::from_utf8_lossy(&combined)
    );

    // Detach and confirm no further bytes flow on the tap channel even
    // though the PTY keeps emitting.
    handle.detach_tap();
    assert!(!handle.has_tap());
}
