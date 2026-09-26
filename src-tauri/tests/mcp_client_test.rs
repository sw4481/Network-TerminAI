//! MCP client integration tests with a mock JSON-RPC echo server.

use anyhow::Result;
use serde_json::json;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::Duration;
use tokio::time::sleep;

fn python_executable() -> &'static str {
    if cfg!(windows) {
        "python"
    } else {
        "python3"
    }
}

/// Mock MCP server that echoes back JSON-RPC responses.
/// Usage: Spawn as a child process and communicate via stdin/stdout.
fn mock_server_script() -> &'static str {
    r#"#!/usr/bin/env python3
import sys
import json

def respond(request):
    """Echo back appropriate JSON-RPC responses."""
    req_id = request.get("id")
    method = request.get("method")

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "serverInfo": {
                    "name": "mock-server",
                    "version": "1.0.0"
                },
                "capabilities": {
                    "tools": {}
                }
            }
        }
    elif method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "tools": [
                    {
                        "name": "test_tool",
                        "description": "A test tool",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "message": {"type": "string"}
                            },
                            "required": ["message"]
                        }
                    }
                ]
            }
        }
    elif method == "tools/call":
        params = request.get("params", {})
        tool_name = params.get("name")
        arguments = params.get("arguments", {})
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "content": [
                    {
                        "type": "text",
                        "text": f"Called {tool_name} with: {json.dumps(arguments)}"
                    }
                ]
            }
        }
    else:
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {
                "code": -32601,
                "message": f"Method not found: {method}"
            }
        }

# Read JSON-RPC requests line by line from stdin
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        request = json.loads(line)
        response = respond(request)
        print(json.dumps(response), flush=True)
    except Exception as e:
        print(json.dumps({
            "jsonrpc": "2.0",
            "id": None,
            "error": {"code": -32700, "message": str(e)}
        }), flush=True)
"#
}

#[tokio::test]
async fn test_mock_server_direct() -> Result<()> {
    // Test the mock server directly before using it with MCP client
    let script_path = std::env::temp_dir().join("mock_mcp_server.py");
    std::fs::write(&script_path, mock_server_script())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms)?;
    }

    let mut child = Command::new(python_executable())
        .arg(&script_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;

    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);

    // Send initialize request
    let init_req = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "test-client",
                "version": "1.0.0"
            }
        }
    });

    writeln!(stdin, "{}", init_req)?;
    stdin.flush()?;

    let mut response_line = String::new();
    reader.read_line(&mut response_line)?;

    let response: serde_json::Value = serde_json::from_str(&response_line)?;
    assert_eq!(response["jsonrpc"], "2.0");
    assert_eq!(response["id"], 1);
    assert!(response["result"]["serverInfo"]["name"].as_str().is_some());

    child.kill()?;
    Ok(())
}

#[tokio::test]
async fn test_mcp_client_initialize() -> Result<()> {
    use ccie_terminal_lib::mcp::{client::McpClient, types::McpTransport};

    let script_path = std::env::temp_dir().join("mock_mcp_server_init.py");
    std::fs::write(&script_path, mock_server_script())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms)?;
    }

    let client = McpClient::new(
        "test-server".to_string(),
        python_executable().to_string(),
        vec![script_path.to_string_lossy().to_string()],
        HashMap::new(),
        McpTransport::Stdio,
    );

    client.start().await?;

    let server_info = client.initialize().await?;
    assert_eq!(server_info["serverInfo"]["name"], "mock-server");

    client.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn test_mcp_client_list_tools() -> Result<()> {
    use ccie_terminal_lib::mcp::{client::McpClient, types::McpTransport};

    let script_path = std::env::temp_dir().join("mock_mcp_server_tools.py");
    std::fs::write(&script_path, mock_server_script())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms)?;
    }

    let client = McpClient::new(
        "test-server".to_string(),
        python_executable().to_string(),
        vec![script_path.to_string_lossy().to_string()],
        HashMap::new(),
        McpTransport::Stdio,
    );

    client.start().await?;
    client.initialize().await?;

    let tools = client.list_tools().await?;
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name, "test_tool");
    assert_eq!(tools[0].description, "A test tool");

    client.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn test_mcp_client_call_tool() -> Result<()> {
    use ccie_terminal_lib::mcp::{client::McpClient, types::McpTransport};

    let script_path = std::env::temp_dir().join("mock_mcp_server_call.py");
    std::fs::write(&script_path, mock_server_script())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms)?;
    }

    let client = McpClient::new(
        "test-server".to_string(),
        python_executable().to_string(),
        vec![script_path.to_string_lossy().to_string()],
        HashMap::new(),
        McpTransport::Stdio,
    );

    client.start().await?;
    client.initialize().await?;

    let args = json!({"message": "Hello MCP"});
    let result = client.call_tool("test_tool", args).await?;

    let content = result["content"].as_array().unwrap();
    assert!(!content.is_empty());
    let text = content[0]["text"].as_str().unwrap();
    assert!(text.contains("test_tool"));
    assert!(text.contains("Hello MCP"));

    client.shutdown().await?;
    Ok(())
}

#[tokio::test]
async fn test_mcp_client_reconnect_on_crash() -> Result<()> {
    use ccie_terminal_lib::mcp::{client::McpClient, types::McpTransport};

    let script_path = std::env::temp_dir().join("mock_mcp_server_crash.py");
    std::fs::write(&script_path, mock_server_script())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms)?;
    }

    let client = McpClient::new(
        "test-server".to_string(),
        python_executable().to_string(),
        vec![script_path.to_string_lossy().to_string()],
        HashMap::new(),
        McpTransport::Stdio,
    );

    client.start().await?;
    client.initialize().await?;

    // First call should work
    let tools = client.list_tools().await?;
    assert_eq!(tools.len(), 1);

    // Simulate crash by killing the process
    client.force_kill().await?;

    // Wait a bit for detection
    sleep(Duration::from_millis(100)).await;

    // Auto-reconnect should happen, restart and re-initialize
    client.start().await?;
    client.initialize().await?;

    // Second call should work after reconnect
    let tools = client.list_tools().await?;
    assert_eq!(tools.len(), 1);

    client.shutdown().await?;
    Ok(())
}
