use ccie_terminal_lib::bridge::SidecarHandle;
use std::path::PathBuf;

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
fn spawn_sidecar_and_ping() {
    let (cmd, args) = python_cmd();
    let mut handle = SidecarHandle::spawn(&cmd, &args).expect("spawn");
    let resp = handle.call("ping", serde_json::json!({})).expect("call");
    assert_eq!(resp["type"], "done");
    assert_eq!(resp["result"], "pong");
    handle.shutdown();
}
