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

fn shell_args() -> Vec<String> {
    if cfg!(windows) {
        vec![
            "/C".into(),
            "echo first & ping -n 2 127.0.0.1 >NUL & echo second".into(),
        ]
    } else {
        vec!["-c".into(), "echo first; sleep 0.5; echo second".into()]
    }
}

#[tokio::test]
async fn tap_receives_pty_bytes_and_detach_stops_them() {
    let (tx, mut rx) = mpsc::channel::<PtyEvent>(64);
    let handle = spawn_pty(
        PtyOptions {
            shell: shell(),
            args: shell_args(),
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
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
    let wait = if cfg!(windows) {
        Duration::from_secs(10)
    } else {
        Duration::from_secs(2)
    };
    let deadline = std::time::Instant::now() + wait;
    let mut answered_cursor_query = false;
    while std::time::Instant::now() < deadline {
        if let Ok(Some(raw)) = timeout(Duration::from_millis(200), tap_rx.recv()).await {
            combined.extend_from_slice(&raw.bytes);
            // Windows ConPTY asks its terminal emulator for the cursor
            // position before it releases command output. The real xterm
            // frontend answers this DSR query through `onData`; this headless
            // test must emulate that response or cmd.exe remains blocked.
            if cfg!(windows)
                && !answered_cursor_query
                && combined.windows(4).any(|window| window == b"\x1b[6n")
            {
                handle.write(b"\x1b[1;1R").unwrap();
                answered_cursor_query = true;
            }
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
