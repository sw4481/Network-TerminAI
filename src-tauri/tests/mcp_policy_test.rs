use anyhow::Result;
use ccie_terminal_lib::mcp::policy::{ApprovalDecision, ApprovalPolicy, PolicyEngine};
use serde_json::json;
use tempfile::TempDir;

#[test]
fn test_policy_engine_read_only_auto_allow() -> Result<()> {
    let temp_dir = TempDir::new()?;
    let db_path = temp_dir.path().join("test.db");
    let conn = ccie_terminal_lib::db::open_and_migrate(&db_path)?;
    let engine = PolicyEngine::new(&conn)?;

    let decision = engine.check_tool("filesystem", "read_file", &json!({"path": "/etc/hosts"}))?;

    assert_eq!(decision.policy, ApprovalPolicy::AutoAllow);
    assert!(decision.allowed);
    assert!(!decision.needs_prompt);

    Ok(())
}

#[test]
fn test_policy_engine_write_requires_confirm() -> Result<()> {
    let temp_dir = TempDir::new()?;
    let db_path = temp_dir.path().join("test.db");
    let conn = ccie_terminal_lib::db::open_and_migrate(&db_path)?;
    let engine = PolicyEngine::new(&conn)?;

    let decision = engine.check_tool(
        "filesystem",
        "write_file",
        &json!({"path": "/tmp/test.txt", "content": "hello"}),
    )?;

    assert_eq!(decision.policy, ApprovalPolicy::Confirm);
    assert!(!decision.allowed);
    assert!(decision.needs_prompt);

    Ok(())
}

#[test]
fn test_policy_engine_dangerous_confirm_once() -> Result<()> {
    let temp_dir = TempDir::new()?;
    let db_path = temp_dir.path().join("test.db");
    let conn = ccie_terminal_lib::db::open_and_migrate(&db_path)?;
    let engine = PolicyEngine::new(&conn)?;

    let decision =
        engine.check_tool("shell", "execute", &json!({"command": "rm -rf /tmp/test"}))?;

    assert_eq!(decision.policy, ApprovalPolicy::ConfirmOnce);
    assert!(!decision.allowed);
    assert!(decision.needs_prompt);

    Ok(())
}

#[test]
fn test_policy_persistence() -> Result<()> {
    let temp_dir = TempDir::new()?;
    let db_path = temp_dir.path().join("test.db");
    let conn = ccie_terminal_lib::db::open_and_migrate(&db_path)?;
    let mut engine = PolicyEngine::new(&conn)?;

    // First check - needs approval
    let decision1 = engine.check_tool("shell", "execute", &json!({"command": "ls"}))?;
    assert!(!decision1.allowed);
    assert!(decision1.needs_prompt);

    // Record approval with remember=true
    engine.record_decision("shell", "execute", ApprovalDecision::allow(), true)?;

    // Second check - should be auto-allowed
    let decision2 = engine.check_tool("shell", "execute", &json!({"command": "ls"}))?;
    assert!(decision2.allowed);
    assert!(!decision2.needs_prompt);

    Ok(())
}

#[test]
fn test_policy_confirm_once_behavior() -> Result<()> {
    let temp_dir = TempDir::new()?;
    let db_path = temp_dir.path().join("test.db");
    let conn = ccie_terminal_lib::db::open_and_migrate(&db_path)?;
    let mut engine = PolicyEngine::new(&conn)?;

    // First call - requires confirmation
    let decision1 = engine.check_tool("shell", "execute", &json!({"command": "echo test"}))?;
    assert_eq!(decision1.policy, ApprovalPolicy::ConfirmOnce);
    assert!(!decision1.allowed);

    // User approves and remembers
    engine.record_decision("shell", "execute", ApprovalDecision::allow(), true)?;

    // Second call - should be auto-allowed
    let decision2 = engine.check_tool("shell", "execute", &json!({"command": "echo test2"}))?;
    assert!(decision2.allowed);
    assert!(!decision2.needs_prompt);

    Ok(())
}

#[test]
fn test_policy_deny() -> Result<()> {
    let temp_dir = TempDir::new()?;
    let db_path = temp_dir.path().join("test.db");
    let conn = ccie_terminal_lib::db::open_and_migrate(&db_path)?;
    let mut engine = PolicyEngine::new(&conn)?;

    // Set explicit deny policy
    engine.set_policy("dangerous", "delete_all", ApprovalPolicy::Deny)?;

    let decision = engine.check_tool("dangerous", "delete_all", &json!({}))?;
    assert_eq!(decision.policy, ApprovalPolicy::Deny);
    assert!(!decision.allowed);
    assert!(!decision.needs_prompt); // Deny doesn't prompt, just blocks

    Ok(())
}

#[test]
fn test_policy_custom_override() -> Result<()> {
    let temp_dir = TempDir::new()?;
    let db_path = temp_dir.path().join("test.db");
    let conn = ccie_terminal_lib::db::open_and_migrate(&db_path)?;
    let mut engine = PolicyEngine::new(&conn)?;

    // Default is AutoAllow for read operations
    let decision1 = engine.check_tool("filesystem", "read_file", &json!({"path": "test.txt"}))?;
    assert_eq!(decision1.policy, ApprovalPolicy::AutoAllow);

    // Override to require confirmation
    engine.set_policy("filesystem", "read_file", ApprovalPolicy::Confirm)?;

    // Now should require confirmation
    let decision2 = engine.check_tool("filesystem", "read_file", &json!({"path": "test.txt"}))?;
    assert_eq!(decision2.policy, ApprovalPolicy::Confirm);
    assert!(!decision2.allowed);

    Ok(())
}

#[test]
fn test_mcp_server_management() -> Result<()> {
    let temp_dir = TempDir::new()?;
    let db_path = temp_dir.path().join("test.db");
    let conn = ccie_terminal_lib::db::open_and_migrate(&db_path)?;

    ccie_terminal_lib::mcp::session::add_mcp_server(
        &conn,
        "filesystem",
        "File System",
        "stdio",
        Some(json!({"cmd": "mcp-server-fs", "args": []})),
        None,
        None,
    )?;

    let servers = ccie_terminal_lib::mcp::session::list_mcp_servers(&conn)?;
    assert_eq!(servers.len(), 1);
    assert_eq!(servers[0].id, "filesystem");
    assert_eq!(servers[0].name, "File System");
    assert!(servers[0].enabled);

    ccie_terminal_lib::mcp::session::remove_mcp_server(&conn, "filesystem")?;

    let servers = ccie_terminal_lib::mcp::session::list_mcp_servers(&conn)?;
    assert_eq!(servers.len(), 0);

    Ok(())
}

#[test]
fn test_mcp_server_sse_transport() -> Result<()> {
    let temp_dir = TempDir::new()?;
    let db_path = temp_dir.path().join("test.db");
    let conn = ccie_terminal_lib::db::open_and_migrate(&db_path)?;

    ccie_terminal_lib::mcp::session::add_mcp_server(
        &conn,
        "remote-api",
        "Remote API",
        "sse",
        None,
        Some("https://api.example.com/mcp".to_string()),
        Some(json!({"API_KEY": "secret"})),
    )?;

    let servers = ccie_terminal_lib::mcp::session::list_mcp_servers(&conn)?;
    assert_eq!(servers.len(), 1);
    assert_eq!(servers[0].transport, "sse");
    assert_eq!(
        servers[0].url,
        Some("https://api.example.com/mcp".to_string())
    );

    Ok(())
}
