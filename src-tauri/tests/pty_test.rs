use ccie_terminal_lib::pty::{spawn_pty, PtyEvent, PtyOptions};
use std::time::Duration;
use tokio::sync::mpsc;

fn default_shell() -> String {
    if cfg!(windows) {
        "cmd.exe".to_string()
    } else {
        "/bin/sh".to_string()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn spawn_shell_echo_and_exit() {
    let (tx, mut rx) = mpsc::channel::<PtyEvent>(32);
    let opts = PtyOptions {
        shell: default_shell(),
        args: if cfg!(windows) {
            vec!["/c".into(), "echo hello".into()]
        } else {
            vec!["-c".into(), "echo hello".into()]
        },
        cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        cols: 80,
        rows: 24,
        pane_id: None,
        claude_config_dir: None,
    };

    let handle = spawn_pty(opts, tx).await.expect("spawn_pty");

    let wait = if cfg!(windows) {
        Duration::from_secs(10)
    } else {
        Duration::from_secs(5)
    };
    let mut output = Vec::new();
    let mut answered_cursor_query = false;
    let mut saw_hello = false;
    let mut saw_exit = false;
    while let Ok(Some(ev)) = tokio::time::timeout(wait, rx.recv()).await {
        match ev {
            PtyEvent::Output { bytes } => {
                output.extend_from_slice(&bytes);
                // Windows ConPTY asks its terminal emulator for the cursor
                // position before it releases command output. The production
                // xterm frontend answers this query through `onData`; emulate
                // that response in this headless integration test.
                if cfg!(windows)
                    && !answered_cursor_query
                    && output.windows(4).any(|window| window == b"\x1b[6n")
                {
                    handle.write(b"\x1b[1;1R").unwrap();
                    answered_cursor_query = true;
                }
                if output.windows(5).any(|window| window == b"hello") {
                    saw_hello = true;
                }
            }
            PtyEvent::Exit { .. } => {
                saw_exit = true;
            }
            _ => {}
        }
        // The PTY reader and child waiter run on independent threads, so
        // either event may reach the shared channel first. Keep draining until
        // both parts of the contract are observed.
        if saw_hello && saw_exit {
            break;
        }
    }
    assert!(saw_hello, "never saw 'hello' in output");
    assert!(saw_exit, "never saw Exit event");

    drop(handle);
}

#[tokio::test(flavor = "multi_thread")]
async fn resize_does_not_crash() {
    let (tx, _rx) = mpsc::channel::<PtyEvent>(32);
    let opts = PtyOptions {
        shell: default_shell(),
        args: vec![],
        cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        cols: 80,
        rows: 24,
        pane_id: None,
        claude_config_dir: None,
    };
    let handle = spawn_pty(opts, tx).await.expect("spawn_pty");
    handle.resize(120, 40).expect("resize");
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(handle);
}

#[tokio::test(flavor = "multi_thread")]
async fn kill_then_exit_fires_promptly() {
    let (tx, mut rx) = mpsc::channel::<PtyEvent>(32);
    // Spawn a shell that waits indefinitely (without -c so it just sits at prompt reading stdin).
    let opts = PtyOptions {
        shell: default_shell(),
        args: vec![],
        cwd: std::env::temp_dir().to_string_lossy().into_owned(),
        cols: 80,
        rows: 24,
        pane_id: None,
        claude_config_dir: None,
    };
    let handle = spawn_pty(opts, tx).await.expect("spawn_pty");

    // Give it a moment to start.
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Killing must not deadlock.
    let kill_result = handle.kill();
    if !cfg!(windows) {
        kill_result.expect("kill");
    }
    // portable-pty 0.9.0's cloned Windows killer reports an error when
    // TerminateProcess succeeds. The Exit event below is the cross-platform
    // behavioral contract and still fails the test if the process survives.

    // We should see an Exit event within a reasonable time.
    let mut saw_exit = false;
    while let Ok(Some(ev)) = tokio::time::timeout(Duration::from_secs(3), rx.recv()).await {
        if matches!(ev, PtyEvent::Exit { .. }) {
            saw_exit = true;
            break;
        }
    }
    assert!(saw_exit, "kill did not produce Exit event");
}
