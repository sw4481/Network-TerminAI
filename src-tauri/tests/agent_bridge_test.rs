use ccie_terminal_lib::agent_bridge::AgentBridge;
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

fn temp_cwd() -> String {
    std::env::temp_dir().to_string_lossy().into_owned()
}

#[tokio::test]
async fn spawn_agent_and_ping() {
    let (cmd, args) = python_cmd();
    let bridge = AgentBridge::new(cmd, args);

    let resp = bridge
        .call("ping", serde_json::json!({}))
        .await
        .expect("call");

    match resp {
        ccie_terminal_lib::agent_bridge::AgentResponse::Done { result } => {
            assert_eq!(result, "pong");
        }
        ccie_terminal_lib::agent_bridge::AgentResponse::Error { message } => {
            panic!("got error: {message}");
        }
        _ => panic!("expected Done response"),
    }

    // Explicitly stop to avoid hanging
    bridge.stop();
}

#[tokio::test]
async fn agent_nl_to_command() {
    let (cmd, args) = python_cmd();
    let bridge = AgentBridge::new(cmd, args);

    let params = serde_json::json!({
        "nl_query": "list files",
        "shell": "bash",
        "cwd": temp_cwd(),
    });

    let resp = bridge.call("nl_to_command", params).await.expect("call");

    match resp {
        ccie_terminal_lib::agent_bridge::AgentResponse::Done { result } => {
            assert!(result.get("command").is_some());
            let cmd_str = result.get("command").unwrap().as_str().unwrap();
            assert!(
                cmd_str.contains("list files") || cmd_str.contains("Mock") || !cmd_str.is_empty()
            );
        }
        ccie_terminal_lib::agent_bridge::AgentResponse::Error { message } => {
            // Expected if no API key - skip test
            eprintln!("nl_to_command skipped (no API key): {message}");
            assert!(
                message.contains("API_KEY")
                    || message.contains("api_key")
                    || message.contains("No profile configured")
            );
        }
        _ => panic!("expected Done response"),
    }

    bridge.stop();
}

#[tokio::test]
async fn agent_explain_error() {
    let (cmd, args) = python_cmd();
    let bridge = AgentBridge::new(cmd, args);

    let params = serde_json::json!({
        "cmd": "nonexistent-command",
        "output": "bash: nonexistent-command: command not found",
        "exit_code": 127,
        "cwd": temp_cwd()
    });

    let resp = bridge.call("explain_error", params).await.expect("call");

    match resp {
        ccie_terminal_lib::agent_bridge::AgentResponse::Done { result } => {
            assert!(
                result.get("explanation").is_some() || result.get("suggested_command").is_some()
            );
        }
        ccie_terminal_lib::agent_bridge::AgentResponse::Error { message } => {
            // Expected when no provider is reachable — accept any of:
            // missing API key, vLLM server unreachable, generic connection
            // failure. The exact wording depends on which provider the dev
            // env defaults to.
            eprintln!("explain_error returned error: {message}");
            let m = message.to_lowercase();
            assert!(
                m.contains("api_key")
                    || m.contains("api key")
                    || m.contains("connection")
                    || m.contains("not reachable")
                    || m.contains("vllm"),
                "unexpected error: {message}"
            );
        }
        _ => panic!("expected Done response"),
    }

    bridge.stop();
}

#[tokio::test]
async fn agent_restart_after_stop() {
    let (cmd, args) = python_cmd();
    let bridge = AgentBridge::new(cmd, args);

    // First call should work
    let resp1 = bridge
        .call("ping", serde_json::json!({}))
        .await
        .expect("call 1");
    assert!(matches!(
        resp1,
        ccie_terminal_lib::agent_bridge::AgentResponse::Done { .. }
    ));

    // Stop the bridge
    bridge.stop();

    // Call again - should auto-restart
    let resp2 = bridge
        .call("ping", serde_json::json!({}))
        .await
        .expect("call 2");
    assert!(matches!(
        resp2,
        ccie_terminal_lib::agent_bridge::AgentResponse::Done { .. }
    ));

    bridge.stop();
}
