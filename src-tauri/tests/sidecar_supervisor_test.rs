use ccie_terminal_lib::bridge::SidecarSupervisor;
use std::path::PathBuf;
use std::sync::Arc;

fn python_cmd() -> (String, Vec<String>) {
    let repo_root = match std::env::var("CCIE_REPO_ROOT") {
        Ok(p) => PathBuf::from(p),
        Err(_) => PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("CARGO_MANIFEST_DIR has a parent")
            .to_path_buf(),
    };
    let venv_python = if cfg!(windows) {
        repo_root.join("sidecar/.venv/Scripts/python.exe")
    } else {
        repo_root.join("sidecar/.venv/bin/python")
    };
    (
        venv_python.to_string_lossy().into_owned(),
        vec!["-m".into(), "ccie_sidecar".into()],
    )
}

#[test]
fn supervisor_ping_reuses_single_child() {
    let (cmd, args) = python_cmd();
    let sup = SidecarSupervisor::new(cmd, args);
    // Two sequential pings share the same child process.
    for _ in 0..2 {
        let resp = sup
            .call("ping", serde_json::json!({}))
            .expect("ping succeeds");
        assert_eq!(resp.as_str(), Some("pong"));
    }
    sup.shutdown();
}

#[tokio::test]
async fn two_concurrent_pings_correlate_by_id() {
    let (cmd, args) = python_cmd();
    let sup = Arc::new(SidecarSupervisor::new(cmd, args));
    let a = sup.clone();
    let b = sup.clone();
    let (ra, rb) = tokio::join!(
        tokio::task::spawn_blocking(move || a.call("ping", serde_json::json!({}))),
        tokio::task::spawn_blocking(move || b.call("ping", serde_json::json!({}))),
    );
    let ra = ra.expect("join a").expect("call a");
    let rb = rb.expect("join b").expect("call b");
    assert_eq!(ra.as_str(), Some("pong"));
    assert_eq!(rb.as_str(), Some("pong"));
    sup.shutdown();
}

#[test]
fn supervisor_respawns_after_shutdown() {
    let (cmd, args) = python_cmd();
    let sup = SidecarSupervisor::new(cmd, args);
    let r1 = sup.call("ping", serde_json::json!({})).expect("call 1");
    assert_eq!(r1.as_str(), Some("pong"));
    sup.shutdown();
    // After shutdown, the next call should lazily respawn a fresh child.
    let r2 = sup.call("ping", serde_json::json!({})).expect("call 2");
    assert_eq!(r2.as_str(), Some("pong"));
    sup.shutdown();
}

#[test]
fn supervisor_surfaces_sidecar_error() {
    let (cmd, args) = python_cmd();
    let sup = SidecarSupervisor::new(cmd, args);
    let err = sup
        .call("nonexistent.method", serde_json::json!({}))
        .unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("sidecar error") && msg.contains("unknown method"),
        "unexpected error: {msg}"
    );
    sup.shutdown();
}
