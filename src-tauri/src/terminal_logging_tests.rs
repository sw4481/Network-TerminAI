use super::*;
use std::sync::mpsc;

fn start(
    manager: &TerminalLogManager,
    tab: &str,
    path: &Path,
    mode: TerminalLogMode,
) -> TerminalLogStatus {
    manager
        .start(tab, "generation", path, mode, Arc::new(|_| {}))
        .unwrap()
}

#[test]
fn records_only_fed_output_and_flushes_plain_unicode_on_stop() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pane.txt");
    let manager = TerminalLogManager::default();
    start(&manager, "pane", &path, TerminalLogMode::Create);
    manager.output("other", "generation", b"excluded\n");
    manager.output("pane", "stale", b"excluded\n");
    for chunk in [
        b"\x1b[3".as_slice(),
        b"2mshow version\x1b[0m\r",
        b"\n\xe2",
        b"\x82\xac\r",
        b"\nlast\xff\xe2",
        b"\x82\xac",
    ] {
        manager.output("pane", "generation", chunk);
    }
    let stopped = manager.stop("pane", None).unwrap();
    assert!(!stopped.active);
    assert!(stopped.error.is_none());
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        "show version\n€\nlast�€"
    );
}

#[test]
fn create_is_atomic_append_preserves_and_overwrite_requires_explicit_mode() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pane.txt");
    std::fs::write(&path, "original\n").unwrap();
    let manager = TerminalLogManager::default();
    assert!(manager
        .start(
            "pane",
            "generation",
            &path,
            TerminalLogMode::Create,
            Arc::new(|_| {})
        )
        .is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "original\n");
    start(&manager, "pane", &path, TerminalLogMode::Append);
    manager.output("pane", "generation", b"new\n");
    manager.stop("pane", None).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "original\nnew\n");
    start(&manager, "pane", &path, TerminalLogMode::Overwrite);
    manager.output("pane", "generation", b"replacement");
    manager.stop("pane", None).unwrap();
    assert_eq!(std::fs::read_to_string(path).unwrap(), "replacement");
}

#[test]
fn active_file_and_duplicate_pane_are_not_truncated() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pane.txt");
    let manager = TerminalLogManager::default();
    start(&manager, "pane", &path, TerminalLogMode::Create);
    for tab in ["pane", "other"] {
        assert!(manager
            .start(
                tab,
                "generation",
                &path,
                TerminalLogMode::Overwrite,
                Arc::new(|_| {})
            )
            .is_err());
    }
    manager.output("pane", "generation", b"preserved\n");
    manager.stop("pane", None).unwrap();
    assert_eq!(std::fs::read_to_string(path).unwrap(), "preserved\n");
}

#[cfg(unix)]
#[test]
fn hard_link_cannot_truncate_an_active_log_and_new_files_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pane.txt");
    let alias = dir.path().join("alias.txt");
    let manager = TerminalLogManager::default();
    start(&manager, "pane", &path, TerminalLogMode::Create);
    std::fs::hard_link(&path, &alias).unwrap();
    assert!(manager
        .start(
            "other",
            "generation",
            &alias,
            TerminalLogMode::Overwrite,
            Arc::new(|_| {})
        )
        .is_err());
    assert_eq!(
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    manager.shutdown();
}

#[test]
fn stale_eof_cannot_stop_replacement_and_finished_event_matches_instance() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pane.txt");
    let manager = TerminalLogManager::default();
    let (tx, rx) = mpsc::channel();
    let initial = manager
        .start(
            "pane",
            "new-generation",
            &path,
            TerminalLogMode::Create,
            Arc::new(move |status| {
                tx.send(status).unwrap();
            }),
        )
        .unwrap();
    assert!(manager.stop("pane", Some("old-generation")).is_none());
    assert!(manager.status("pane").unwrap().active);
    manager.output("pane", "new-generation", b"last output\n");
    let stopped = manager.stop("pane", Some("new-generation")).unwrap();
    assert_eq!(initial.id, stopped.id);
    assert_eq!(rx.recv().unwrap().id, initial.id);
    assert_eq!(std::fs::read_to_string(path).unwrap(), "last output\n");
}

#[test]
fn start_serialization_does_not_block_unrelated_output() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pane.txt");
    let manager = Arc::new(TerminalLogManager::default());
    start(&manager, "pane", &path, TerminalLogMode::Create);
    let opening_another_file = manager.starts.lock();
    let logging = manager.clone();
    let (sent, received) = mpsc::channel();
    let output = std::thread::spawn(move || {
        logging.output("pane", "generation", b"unrelated output\n");
        sent.send(()).unwrap();
    });
    let delivered = received.recv_timeout(std::time::Duration::from_secs(1));
    drop(opening_another_file);
    output.join().unwrap();
    delivered.unwrap();
    manager.stop("pane", None).unwrap();
    assert_eq!(std::fs::read_to_string(path).unwrap(), "unrelated output\n");
}

#[test]
fn delayed_stop_for_old_instance_cannot_stop_restarted_log_in_same_pty() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pane.txt");
    let manager = TerminalLogManager::default();
    let first = start(&manager, "pane", &path, TerminalLogMode::Create);
    manager.stop("pane", None).unwrap();
    let second = start(&manager, "pane", &path, TerminalLogMode::Append);
    assert_ne!(first.id, second.id);
    assert!(manager.stop_instance("pane", &first.id).is_none());
    assert!(manager.status("pane").unwrap().active);
    manager.output("pane", "generation", b"new instance\n");
    manager.stop_instance("pane", &second.id).unwrap();
    assert_eq!(std::fs::read_to_string(path).unwrap(), "new instance\n");
}

#[test]
fn ansi_split_secrets_and_incomplete_utf8_are_safely_finalized() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pane.txt");
    let manager = TerminalLogManager::default();
    start(&manager, "pane", &path, TerminalLogMode::Create);
    for chunk in [
        b"snmp-server comm".as_slice(),
        b"unity \x1b[31mprivate",
        b"-value\x1b[0m RO\r\n\x1b]0;hidden",
        b"\x07tail\xe2",
    ] {
        manager.output("pane", "generation", chunk);
    }
    manager.stop("pane", None).unwrap();
    let text = std::fs::read_to_string(path).unwrap();
    assert!(!text.contains("private"));
    assert!(!text.contains("hidden"));
    assert!(!text.contains('\x1b'));
    assert!(text.contains("tail�"));
}

#[test]
fn shutdown_drains_all_panes_and_repeated_stop_is_safe() {
    let dir = tempfile::tempdir().unwrap();
    let manager = TerminalLogManager::default();
    for tab in ["one", "two"] {
        start(
            &manager,
            tab,
            &dir.path().join(tab),
            TerminalLogMode::Create,
        );
        manager.output(tab, "generation", tab.as_bytes());
    }
    manager.shutdown();
    assert!(manager
        .start(
            "three",
            "generation",
            &dir.path().join("three"),
            TerminalLogMode::Create,
            Arc::new(|_| {})
        )
        .is_err());
    assert!(!dir.path().join("three").exists());
    for tab in ["one", "two"] {
        assert!(!manager.stop(tab, None).unwrap().active);
        assert_eq!(std::fs::read_to_string(dir.path().join(tab)).unwrap(), tab);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn real_pty_logs_echoed_commands_and_final_output_but_not_hidden_stdin() {
    use crate::pty::{spawn_pty, PtyEvent, PtyOptions};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("live.txt");
    let (tx, mut rx) = tokio::sync::mpsc::channel(256);
    let handle = spawn_pty(PtyOptions {
        shell: "/bin/sh".into(),
        args: vec!["-c".into(), "IFS= read -r command; printf 'response:%s\\n' \"$command\"; stty -echo; printf 'NOECHO_READY\\n'; IFS= read -r hidden; printf 'finished\\n'".into()],
        cwd: dir.path().to_string_lossy().into_owned(),
        cols: 80, rows: 24, pane_id: None, claude_config_dir: None,
    }, tx).await.unwrap();
    let manager = TerminalLogManager::default();
    manager
        .start(
            "pane",
            handle.generation(),
            &path,
            TerminalLogMode::Create,
            Arc::new(|_| {}),
        )
        .unwrap();
    handle.write(b"show version\n").unwrap();
    let mut observed = Vec::new();
    let mut sent_hidden = false;
    let drained = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while let Some(event) = rx.recv().await {
            if let PtyEvent::Output { bytes } = event {
                manager.output("pane", handle.generation(), &bytes);
                observed.extend_from_slice(&bytes);
                if !sent_hidden && String::from_utf8_lossy(&observed).contains("NOECHO_READY") {
                    handle.write(b"do-not-log-hidden-input\n").unwrap();
                    sent_hidden = true;
                }
            }
        }
    })
    .await;
    let _ = handle.kill();
    manager.stop("pane", Some(handle.generation())).unwrap();
    drained.unwrap();
    let text = std::fs::read_to_string(path).unwrap();
    assert!(text.contains("show version\n"));
    assert!(text.contains("response:show version\n"));
    assert!(text.ends_with("finished\n"));
    assert!(!text.contains("do-not-log-hidden-input"));
}

#[test]
fn writer_failure_publishes_inactive_status_with_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("read-only-handle");
    std::fs::write(&path, "").unwrap();
    let file = File::open(path).unwrap();
    let (tx, rx) = mpsc::sync_channel(2);
    tx.send(b"output\n".to_vec()).unwrap();
    drop(tx);
    let status = Arc::new(Mutex::new(TerminalLogStatus {
        id: "instance".into(),
        tab_id: "pane".into(),
        path: "/test".into(),
        active: true,
        error: None,
    }));
    let (events, received) = mpsc::channel();
    write_log(
        file,
        rx,
        Redactor::new(&[]).unwrap(),
        status,
        Arc::new(move |event| {
            events.send(event).unwrap();
        }),
    );
    let event = received.recv().unwrap();
    assert!(!event.active);
    assert!(event.error.as_ref().unwrap().contains("failed"));
}

#[test]
fn full_queue_stops_producer_with_visible_error_without_blocking() {
    let manager = TerminalLogManager::default();
    let (tx, rx) = mpsc::sync_channel(1);
    tx.try_send(b"accepted".to_vec()).unwrap();
    let status = Arc::new(Mutex::new(TerminalLogStatus {
        id: "instance".into(),
        tab_id: "pane".into(),
        path: "/test".into(),
        active: true,
        error: None,
    }));
    manager.sessions.lock().insert(
        "pane".into(),
        LogEntry {
            generation: "generation".into(),
            path: PathBuf::from("/test"),
            sender: Some(tx),
            worker: Arc::new(Mutex::new(None)),
            status: status.clone(),
        },
    );
    manager.output("pane", "generation", b"overflow");
    assert!(status.lock().error.as_ref().unwrap().contains("queue full"));
    assert!(manager
        .sessions
        .lock()
        .get("pane")
        .unwrap()
        .sender
        .is_none());
    assert_eq!(rx.recv().unwrap(), b"accepted");
    assert!(rx.recv().is_err());
}
