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

#[test]
fn managed_sidecar_children_preserve_module_tree() {
    use ccie_terminal_lib::bridge::SidecarSupervisor;

    let root = tempfile::tempdir().unwrap();
    let module = root.path().join("integrity_fixture.py");
    std::fs::write(&module, "VALUE = 42\n").unwrap();
    let script = r#"
import json, os, sys
sys.path.insert(0, sys.argv[1])
import integrity_fixture
for line in sys.stdin:
    request = json.loads(line)
    result = {"disabled": sys.dont_write_bytecode, "env": os.environ.get("PYTHONDONTWRITEBYTECODE"), "value": integrity_fixture.VALUE}
    print(json.dumps({"id": request["id"], "type": "done", "result": result}), flush=True)
"#;
    let (python, _) = python_cmd();
    let args = vec![
        "-c".to_string(),
        script.to_string(),
        root.path().to_string_lossy().into_owned(),
    ];
    let parent_env = std::env::var_os("PYTHONDONTWRITEBYTECODE");
    let expected = serde_json::json!({"disabled": true, "env": "1", "value": 42});
    let mut handle = SidecarHandle::spawn(&python, &args).expect("spawn fixture");
    let response = handle.call("probe", serde_json::json!({})).unwrap();
    handle.shutdown();
    assert_eq!(response["result"], expected);

    let supervisor = SidecarSupervisor::new(python, args);
    let response = supervisor.call("probe", serde_json::json!({})).unwrap();
    supervisor.shutdown();
    assert_eq!(response, expected);
    assert_eq!(std::fs::read_to_string(module).unwrap(), "VALUE = 42\n");
    assert!(!root.path().join("__pycache__").exists());
    assert_eq!(std::env::var_os("PYTHONDONTWRITEBYTECODE"), parent_env);
}
