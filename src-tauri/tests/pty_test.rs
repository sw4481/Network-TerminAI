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

    let mut saw_hello = false;
    let mut saw_exit = false;
    while let Ok(Some(ev)) = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
        match ev {
            PtyEvent::Output { bytes } if String::from_utf8_lossy(&bytes).contains("hello") => {
                saw_hello = true;
            }
            PtyEvent::Exit { .. } => {
                saw_exit = true;
                break;
            }
            _ => {}
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
    handle.kill().expect("kill");

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
